import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function activate(f, id) {
  await expect(f.locator("#" + id)).toBeEnabled();
  await f.locator("#" + id).press("Space");
}
async function state(request) {
  return (await request.get(base + "state")).json();
}

test("new documents inherit partition fields, generate UUIDs, preview changes and refresh results", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await f.locator("#query-pk").fill('["demo"]');
  await query(f);
  await activate(f, "new");
  const initial = await f.locator("#document-id").inputValue();
  expect(initial).toMatch(/^[0-9a-f-]{36}$/);
  await expect(f.locator("#document-pk")).toHaveValue('["demo"]');
  expect(
    JSON.parse(await f.locator("#editor .cm-content").innerText()).tenant,
  ).toBe("demo");
  await activate(f, "generate-id");
  expect(await f.locator("#document-id").inputValue()).not.toBe(initial);
  await f.locator("#document-id").fill("preview-document");
  await f
    .locator("#editor .cm-content")
    .fill(
      '{"id":"preview-document","tenant":"demo","amount":9223372036854775807,"status":"new"}',
    );
  await activate(f, "save");
  await expect(f.locator("#confirm-changes")).toBeVisible();
  await expect(f.locator("#change-rows")).toContainText("9223372036854775807");
  await page.screenshot({ path: "docs/cud-preview.png", fullPage: true });
  await f.locator("#confirm-cancel").click();
  expect((await state(request)).writeCount).toBe(0);
  await expect(f.locator("#editor .cm-content")).toHaveText(/preview-document/);
  await activate(f, "save");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  await expect(f.locator("#status")).toContainText("上次查询已刷新");
  await expect(f.locator("#table")).toContainText("preview-document");
  await expect(f.locator("#save")).toBeDisabled();
  expect((await state(request)).writeCount).toBe(1);
});

test("partition mismatches are rejected before confirmation and successful writes remain successful if refresh fails", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await query(f);
  await f.getByRole("cell", { name: "order-001", exact: true }).click();
  await activate(f, "read");
  await f.locator("#document-json-view").click();
  const text = await f.locator("#editor .cm-content").innerText();
  expect(text).not.toContain("_etag");
  await f.locator("#editor .cm-content").fill(text.replace("demo", "other"));
  await activate(f, "save");
  await expect(f.locator("#status")).toContainText("分区键");
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  expect((await state(request)).writeCount).toBe(0);
  await f.locator("#editor .cm-content").fill(text.replace("pending", "paid"));
  await activate(f, "save");
  await expect(f.locator("#change-rows")).toContainText("/status");
  await expect(f.locator("#change-rows")).toContainText("pending");
  await expect(f.locator("#change-rows")).toContainText("paid");
  await request.get(base + "fail-next-query");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  await expect(f.locator("#status")).toContainText("查询刷新失败");
  await expect(f.locator("#row-count")).toHaveText("0 条");
  await expect(f.locator("#editor .cm-content")).toHaveText(/paid/);
  expect((await state(request)).writeCount).toBe(1);
});

test("create adds a cached key, and deleting its last document removes it without rediscovery", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await f.locator("#query-pk-choose").click();
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  const calls = (await state(request)).discoveryCalls;
  await f.locator("#pk-close").click();
  await f.locator("#query-pk").fill('["new-partition"]');
  await activate(f, "new");
  await activate(f, "save");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  await f.locator("#query-pk-choose").click();
  await f.locator("#pk-filter").fill("new-partition");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(1);
  expect((await state(request)).discoveryCalls).toBe(calls);
  await f.locator("#pk-close").click();
  await activate(f, "delete");
  await expect(f.locator("#change-rows")).toContainText("（删除）");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("删除成功");
  await f.locator("#query-pk-choose").click();
  await f.locator("#pk-filter").fill("new-partition");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(0);
  expect((await state(request)).discoveryCalls).toBe(calls);
  expect((await state(request)).writeCount).toBe(2);
});
