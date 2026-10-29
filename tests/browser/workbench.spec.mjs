import { capturePath, mockURL, connect, query } from "./support.mjs";
import { test, expect } from "@playwright/test";

async function activate(frame, name) {
  const button = frame.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  await button.press("Space");
}
async function openDocument(frame) {
  await frame.getByRole("cell", { name: "order-001", exact: true }).dblclick();
  await frame
    .getByRole("button", { name: "读取完整文档", exact: true })
    .click();
  await expect(frame.locator("#document-state")).toHaveText("完整文档");
  await frame.locator("#document-json-view").click();
}
test.beforeEach(async ({ request }) => {
  await request.get(mockURL + "/test/reset");
});

test("query, paging, lossless document edit, and ETag conflict", async ({
  page,
  request,
}) => {
  const frame = await connect(page);
  await query(frame);
  await expect(
    frame.getByRole("cell", { name: "9223372036854775807", exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(frame.locator("#page-label")).toHaveText("第 2 页");
  await expect(frame.locator("#table")).toContainText("没有匹配的结果");
  await frame.getByRole("button", { name: "上一页", exact: true }).click();
  await openDocument(frame);
  const editor = frame.locator("#editor .cm-content");
  const original = await editor.innerText();
  expect(original).toContain("9223372036854775807");
  await editor.fill(original.replace("pending", "paid"));
  // Dirty drafts must survive a cancelled query navigation.
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#confirm-dialog")).toBeVisible();
  await frame.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveText(/paid/);
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("保存成功");
  await page.screenshot({ path: capturePath("workbench.png"), fullPage: true });
  const saved = await (await request.get(mockURL + "/test/state")).json();
  expect(saved.document).toContain("9223372036854775807");
  expect(saved.writeCount).toBe(1);
  await request.get(mockURL + "/test/conflict");
  await frame.locator("#document-json-view").click();
  await editor.fill((await editor.innerText()).replace("paid", "shipped"));
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("HTTP 412");
  expect(
    (await (await request.get(mockURL + "/test/state")).json()).writeCount,
  ).toBe(1);
});
test("read-only connection allows querying and reading but disables writes", async ({
  page,
}) => {
  const frame = await connect(page, true);
  await query(frame);
  await openDocument(frame);
  await expect(frame.locator("#mode")).toHaveText("只读连接");
  await expect(frame.locator("#editor .cm-content")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  for (const name of ["新建文档", "保存", "删除"])
    await expect(
      frame.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
});
test("create and conditional delete require explicit confirmation", async ({
  page,
  request,
}) => {
  const frame = await connect(page);
  await frame.getByRole("button", { name: "新建文档", exact: true }).click();
  await frame.locator("#document-pk").fill('["demo"]');
  await frame.locator("#document-json-view").click();
  await frame
    .locator("#editor .cm-content")
    .fill('{"id":"new-document","tenant":"demo","value":1}');
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("保存成功");
  await activate(frame, "删除");
  await frame.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    (await (await request.get(mockURL + "/test/state")).json()).deleted,
  ).toBe(false);
  await activate(frame, "删除");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("删除成功");
  expect(
    (await (await request.get(mockURL + "/test/state")).json()).deleted,
  ).toBe(true);
});
