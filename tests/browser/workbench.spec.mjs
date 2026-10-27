import { test, expect } from "@playwright/test";

async function connect(page, readOnly = false) {
  page.on("pageerror", (error) =>
    console.error("Workbench page error:", error.message),
  );
  await page.goto("http://127.0.0.1:5191");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  const name = `E2E-${Date.now()}`;
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "Account Endpoint", exact: true })
    .fill("http://127.0.0.1:18081");
  await page
    .getByRole("textbox", { name: "Account Key", exact: true })
    .fill("dGVzdC1hY2NvdW50LWtleQ==");
  await page
    .getByRole("checkbox", {
      name: "只读（关闭后允许文档增删改）",
      exact: true,
    })
    .setChecked(readOnly);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).press("Enter");
  await page.getByRole("button", { name, exact: true }).click();
  const frame = page.frameLocator("iframe").last();
  await frame.getByLabel("数据库", { exact: true }).selectOption("Shop");
  await frame.getByLabel("容器", { exact: true }).selectOption("Orders");
  return frame;
}
async function activate(frame, name) {
  const button = frame.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  await button.press("Space");
}
async function query(frame) {
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("2.81 RU");
}
async function openDocument(frame) {
  await frame.getByRole("cell", { name: "order-001", exact: true }).click();
  await frame
    .getByRole("button", { name: "读取完整文档", exact: true })
    .click();
  await expect(frame.locator("#document-state")).toHaveText("完整文档");
}
test.beforeEach(async ({ request }) => {
  await request.get("http://127.0.0.1:18081/test/reset");
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
  const editor = frame.getByRole("textbox", { name: "JSON 文档", exact: true });
  const original = await editor.inputValue();
  expect(original).toContain("9223372036854775807");
  await editor.fill(original.replace("pending", "paid"));
  // Dirty drafts must survive a cancelled query navigation.
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#confirm-dialog")).toBeVisible();
  await frame.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveValue(/paid/);
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("保存成功");
  await page.screenshot({ path: "docs/workbench.png", fullPage: true });
  const saved = await (
    await request.get("http://127.0.0.1:18081/test/state")
  ).json();
  expect(saved.document).toContain("9223372036854775807");
  expect(saved.writeCount).toBe(1);
  await request.get("http://127.0.0.1:18081/test/conflict");
  await editor.fill((await editor.inputValue()).replace("paid", "shipped"));
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("HTTP 412");
  expect(
    (await (await request.get("http://127.0.0.1:18081/test/state")).json())
      .writeCount,
  ).toBe(1);
});
test("read-only connection allows querying and reading but disables writes", async ({
  page,
}) => {
  const frame = await connect(page, true);
  await query(frame);
  await openDocument(frame);
  await expect(frame.locator("#mode")).toHaveText("只读连接");
  await expect(frame.locator("#editor")).toHaveAttribute("readonly", "");
  for (const name of ["新建", "保存", "删除"])
    await expect(
      frame.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
});
test("create and conditional delete require explicit confirmation", async ({
  page,
  request,
}) => {
  const frame = await connect(page);
  await frame.getByRole("button", { name: "新建", exact: true }).click();
  await frame.locator("#document-pk").fill('["demo"]');
  await frame
    .locator("#editor")
    .fill('{"id":"new-document","tenant":"demo","value":1}');
  await activate(frame, "保存");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("保存成功");
  await activate(frame, "删除");
  await frame.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    (await (await request.get("http://127.0.0.1:18081/test/state")).json())
      .deleted,
  ).toBe(false);
  await activate(frame, "删除");
  await frame.getByRole("button", { name: "确认", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("删除成功");
  expect(
    (await (await request.get("http://127.0.0.1:18081/test/state")).json())
      .deleted,
  ).toBe(true);
});
