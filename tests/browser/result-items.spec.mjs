import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ page, request }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get(base + "reset");
});
const snapshot = async (request) => (await request.get(base + "state")).json();
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
async function contextOn(f, text, keyboard = false) {
  await f.locator("#result-json-search").click();
  const search = f.locator('#raw-results .cm-search input[name="search"]');
  await search.fill(text);
  await expect(f.locator("#raw-results .editor-status")).toContainText("1 项");
  await search.press("Enter");
  await search.press("Escape");
  if (keyboard)
    await f
      .getByRole("textbox", { name: "JSON 查询结果", exact: true })
      .press("Shift+F10");
  else
    await f
      .locator("#raw-results .cm-content span")
      .filter({ hasText: new RegExp(`^"?${text}"?$`) })
      .last()
      .click({ button: "right" });
  await expect(f.locator("#result-item-menu")).toBeVisible();
}

test("nested item menu copies only its projection and point reads its own identity after draft confirmation", async ({
  page,
  request,
}) => {
  await request.get(base + "multi-results");
  const f = await connect(page);
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await f.getByLabel("字段 /status", { exact: true }).fill("unsaved");
  await f.locator("#query-pk").fill('["wrong"]');
  await f.locator("#json-view").click();
  await contextOn(f, "trap");
  await expect(f.locator("#result-item-summary")).toContainText("第 2 项");
  await expect(f.locator("#read-result-item")).toBeEnabled();
  const menu = await f.locator("#result-item-menu").boundingBox();
  expect(menu.x + menu.width).toBeLessThanOrEqual(1440);
  expect(menu.y + menu.height).toBeLessThanOrEqual(960);
  await f.locator("#copy-result-item").click();
  await expect.poll(() => clipboard(page)).toContain('"id": "order-002"');
  await expect
    .poll(() => clipboard(page))
    .toContain('"total": 9223372036854775807');
  expect(await clipboard(page)).not.toContain("order-001");
  await expect(f.locator("#document-state")).toHaveText("未保存");
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  expect((await snapshot(request)).readRequests).toHaveLength(1);
  await contextOn(f, "trap");
  await f.locator("#read-result-item").press("Enter");
  await expect(f.locator("#confirm-title")).toHaveText("放弃未保存的修改？");
  await f.locator("#confirm-cancel").click();
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "unsaved",
  );
  expect((await snapshot(request)).readRequests).toHaveLength(1);
  await contextOn(f, "trap");
  await f.locator("#read-result-item").press("Enter");
  await expect(f.locator("#confirm-dialog")).toBeVisible();
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#document-state")).toHaveText("完整文档");
  await expect(f.locator("#document-id")).toHaveValue("order-002");
  await expect(f.locator("#document-pk")).toHaveValue('["other"]');
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "new",
  );
  const after = await snapshot(request);
  expect(after.readRequests.at(-1)).toMatchObject({
    id: "order-002",
    partitionKey: '["other"]',
    url: "/dbs/Shop/colls/Orders/docs/order-002",
  });
  expect(after.readRequests).toHaveLength(2);
  expect(after.writeCount).toBe(0);
  expect(after.queryCalls).toBe(1);
});

test("missing partition fields and scalar projections can be copied but cannot borrow the typed key", async ({
  page,
  request,
}) => {
  await request.get(base + "id-projection");
  const f = await connect(page, true);
  await f.locator("#sql .cm-content").fill("SELECT c.id FROM c");
  await f.locator("#query-pk").fill('["demo"]');
  await query(f);
  await f.locator("#json-view").click();
  await contextOn(f, "order-001", true);
  await expect(f.locator("#read-result-item")).toBeDisabled();
  await expect(f.locator("#result-item-hint")).toContainText("/tenant");
  await f.locator("#copy-result-item").press("ArrowDown");
  await expect(f.locator("#copy-result-item")).toBeFocused();
  await f.locator("#copy-result-item").press("Escape");
  await expect(f.locator("#result-item-menu")).toBeHidden();
  await expect(
    f.getByRole("textbox", { name: "JSON 查询结果", exact: true }),
  ).toBeFocused();
  await request.get(base + "scalar-results");
  await f.locator("#sql .cm-content").fill("SELECT VALUE c.total FROM c");
  await query(f);
  await contextOn(f, "9223372036854775807");
  await expect(f.locator("#read-result-item")).toBeDisabled();
  await f.locator("#copy-result-item").click();
  await expect.poll(() => clipboard(page)).toBe("9223372036854775807");
  await contextOn(f, "null", true);
  await f.locator("#copy-result-item").press("Enter");
  await expect.poll(() => clipboard(page)).toBe("null");
  expect((await snapshot(request)).readRequests).toHaveLength(0);
});

test("folded and filtered items keep their identity; menu navigation and invalidation cannot read stale results", async ({
  page,
  request,
}) => {
  await request.get(base + "multi-results");
  const f = await connect(page, true);
  await query(f);
  await f.locator("#json-view").click();
  await f
    .locator('#raw-results .cm-foldGutter [title="折叠此行"]')
    .first()
    .click();
  await f
    .locator("#raw-results .cm-foldPlaceholder")
    .click({ button: "right" });
  await expect(f.locator("#result-item-menu")).toBeHidden();
  await f.locator("#raw-results .cm-foldPlaceholder").press("Escape");
  await f.locator("#raw-results .cm-foldPlaceholder").click();
  await f
    .locator('#raw-results .cm-foldGutter [title="折叠此行"]')
    .nth(1)
    .click();
  await f
    .locator("#raw-results .cm-foldPlaceholder")
    .click({ button: "right" });
  await expect(f.locator("#result-item-summary")).toContainText("第 1 项");
  await f.locator("#copy-result-item").click();
  await expect.poll(() => clipboard(page)).toContain("order-001");
  expect(await clipboard(page)).not.toContain("order-002");
  await f.locator("#result-filter").fill("order-002");
  await contextOn(f, "trap", true);
  await expect(f.locator("#result-item-summary")).toContainText(
    "筛选结果第 1 项",
  );
  await f.locator("#copy-result-item").press("ArrowDown");
  await expect(f.locator("#read-result-item")).toBeFocused();
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "/tmp/dbx-result-item-menu.png" });
  await f.locator("#read-result-item").press("Escape");
  await expect(
    f.getByRole("textbox", { name: "JSON 查询结果", exact: true }),
  ).toBeFocused();
  await contextOn(f, "trap", true);
  await f.locator("#copy-result-item").press("Enter");
  await expect.poll(() => clipboard(page)).toContain("order-002");
  expect(await clipboard(page)).not.toContain("order-001");
  await contextOn(f, "trap", true);
  await f.locator("#result-filter").fill("order-001");
  await expect(f.locator("#result-item-menu")).toBeHidden();
  await f.locator("#read-result-item").evaluate((el) => el.click());
  await contextOn(f, "order-001", true);
  await f.locator("#container").selectOption("Archive");
  await expect(f.locator("#result-item-menu")).toBeHidden();
  await f.locator("#read-result-item").evaluate((el) => el.click());
  expect((await snapshot(request)).readRequests).toHaveLength(0);
  await expect(f.locator("#document-state")).toHaveText("未选择");
});

test("a nested value outside the initial viewport resolves to its whole top-level result", async ({
  page,
  request,
}) => {
  await request.get(base + "large-result");
  const f = await connect(page, true);
  await query(f);
  await f.locator("#json-view").click();
  await contextOn(f, "entry-999", true);
  await expect(f.locator("#result-item-summary")).toContainText("第 1 项");
  await f.locator("#copy-result-item").click();
  await expect.poll(() => clipboard(page)).toContain('"id": "order-001"');
  await expect.poll(() => clipboard(page)).toContain("entry-999");
  await expect.poll(() => clipboard(page)).toContain("tail-marker");
  await expect.poll(() => clipboard(page)).toContain("9223372036854775807");
  expect(JSON.parse(await clipboard(page)).items).toHaveLength(1000);
  const after = await snapshot(request);
  expect(after.queryCalls).toBe(1);
  expect(after.readRequests).toHaveLength(0);
  expect(after.writeCount).toBe(0);
});
