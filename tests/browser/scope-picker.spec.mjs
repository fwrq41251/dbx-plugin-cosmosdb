import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
const snapshot = async (request) => (await request.get(base + "state")).json();
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
  await request.get(base + "multi-scope");
});
async function select(f, kind, id) {
  await f.locator(`#scope-${kind}`).click();
  await f.locator("#scope-filter").fill(id.toLowerCase());
  await expect(f.locator("#scope-options").getByRole("option")).toHaveCount(1);
  await f.locator("#scope-filter").press("Enter");
}

test("breadcrumb switches containers and paginated databases without changing saved defaults", async ({
  page,
  request,
}) => {
  const name = `Scope switching ${Date.now()}`;
  const f = await connect(page, true, true, name);
  expect((await snapshot(request)).accountLists).toBe(0);
  await f.locator("#query-pk").fill('["old-key"]');
  await select(f, "container", "Archive");
  await expect(f.locator("#scope-container")).toHaveText("Archive");
  await expect(f.locator("#query-pk")).toHaveValue("");
  expect((await snapshot(request)).queryCalls).toBe(0);
  await f.locator("#query-pk").fill('["archive"]');
  await query(f);
  expect((await snapshot(request)).queryRequests.at(-1).url).toBe(
    "/dbs/Shop/colls/Archive/docs",
  );
  await select(f, "database", "Reports");
  await expect(f.locator("#scope-database")).toHaveText("Reports");
  await expect(f.locator("#scope-container")).toHaveText("选择容器");
  await expect(f.locator("#scope-picker-title")).toContainText("Reports");
  await f
    .locator("#scope-options")
    .getByRole("option", { name: "Events", exact: true })
    .press("Enter");
  await expect(f.locator("#scope-container")).toHaveText("Events");
  await expect(f.locator("#query-pk")).toHaveValue("");
  await expect(f.locator("#row-count")).toHaveText("0 条");
  await expect(f.locator("#document-state")).toHaveText("未选择");
  await f.locator("#scope-info").click();
  await expect(f.locator("#metadata")).toContainText("/org");
  await f.locator("#refresh").press("Escape");
  expect((await snapshot(request)).queryCalls).toBe(1);
  expect((await snapshot(request)).accountLists).toBe(2);
  await f.locator("#query-pk").fill('["reports"]');
  await query(f);
  await expect(f.locator("#table")).toContainText("report-001");
  expect((await snapshot(request)).queryRequests.at(-1).url).toBe(
    "/dbs/Reports/colls/Events/docs",
  );
  // An explicit metadata refresh retains the temporary selection.
  await f.locator("#scope-info").click();
  await f.locator("#refresh").press("Enter");
  await expect(f.locator("#scope-container")).toHaveText("Events");
  await expect(f.locator("#run")).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const reopened = page.frameLocator("iframe").last();
  await expect(reopened.locator("#scope-database")).toHaveText("Shop");
  await expect(reopened.locator("#scope-container")).toHaveText("Orders");
  expect((await snapshot(request)).writeCount).toBe(0);
});

test("canceling a dirty switch preserves the draft and accepted switching clears the old identity", async ({
  page,
  request,
}) => {
  const f = await connect(page, false, true);
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await f.getByLabel("字段 /status", { exact: true }).fill("unsaved");
  await select(f, "container", "Archive");
  await expect(f.locator("#confirm-title")).toHaveText("放弃未保存的修改？");
  await f.locator("#confirm-cancel").click();
  await expect(f.locator("#scope-container")).toHaveText("Orders");
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "unsaved",
  );
  await expect(f.locator("#row-count")).toHaveText("1 条");
  await select(f, "container", "Archive");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#scope-container")).toHaveText("Archive");
  await expect(f.locator("#document-state")).toHaveText("未选择");
  await expect(f.locator("#document-id")).toHaveValue("");
  await expect(f.locator("#save")).toBeDisabled();
  expect((await snapshot(request)).queryCalls).toBe(1);
  expect((await snapshot(request)).writeCount).toBe(0);
});

test("listing failures retain the working default and explicit retry loads options", async ({
  page,
  request,
}) => {
  const f = await connect(page, true, true);
  await request.get(base + "deny-scope-list");
  await f.locator("#scope-container").click();
  await expect(f.locator("#scope-picker-status")).toContainText("403");
  await expect(f.locator("#scope-container")).toHaveText("Orders");
  await f.locator("#scope-filter").press("Escape");
  await query(f);
  await request.get(base + "allow-scope-list");
  await f.locator("#scope-container").click();
  await expect(f.locator("#scope-options").getByRole("option")).toHaveCount(2);
  await f.locator("#scope-filter").fill("not-a-container");
  await expect(f.locator("#scope-options")).toContainText("没有匹配");
  await f.locator("#scope-reload").click();
  await expect(f.locator("#scope-options").getByRole("option")).toHaveCount(2);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "docs/scope-picker.png" });
  await f.locator("#scope-filter").press("Escape");
  await f.locator("#scope-database").click();
  await expect(
    f
      .locator("#scope-options")
      .getByRole("option", { name: "Reports", exact: true }),
  ).toBeVisible();
  await request.get(base + "deny-scope-list");
  await f
    .locator("#scope-options")
    .getByRole("option", { name: "Reports", exact: true })
    .press("Enter");
  await expect(f.locator("#status")).toContainText("403");
  await expect(f.locator("#scope-database")).toHaveText("Shop");
  await expect(f.locator("#scope-container")).toHaveText("Orders");
  await expect(f.locator("#row-count")).toHaveText("1 条");
  await expect(f.locator("#run")).toBeEnabled();
  expect((await snapshot(request)).queryCalls).toBe(1);
});

test("a dismissed late list cannot replace a subsequently opened selector", async ({
  page,
  request,
}) => {
  const f = await connect(page, true, true);
  await request.get(base + "slow-scope-list");
  await f.locator("#scope-container").click();
  await expect
    .poll(async () => (await snapshot(request)).scopeListPending)
    .toBe(1);
  await f.locator("#scope-filter").press("Escape");
  await f.locator("#scope-database").click();
  await expect(
    f
      .locator("#scope-options")
      .getByRole("option", { name: "Reports", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await snapshot(request)).scopeListPending)
    .toBe(0);
  await expect(f.locator("#scope-picker-title")).toHaveText("选择数据库");
  await expect(
    f
      .locator("#scope-options")
      .getByRole("option", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await f.locator("#scope-filter").press("ArrowDown");
  await expect(
    f
      .locator("#scope-options")
      .getByRole("option", { name: "Shop", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(f.locator("#scope-database")).toBeFocused();
});

test("writes after switching target the selected container and readonly scope is preserved", async ({
  page,
  request,
}) => {
  const f = await connect(page, false, true);
  await select(f, "container", "Archive");
  await f.locator("#query-pk").fill('["archive"]');
  await f.locator("#new").click();
  await f.locator("#document-json-view").click();
  await f
    .locator("#editor .cm-content")
    .fill('{"id":"new-archive","tenant":"archive","remark":"sample"}');
  await f.locator("#save").press("Enter");
  await expect(f.locator("#confirm-dialog")).toBeVisible();
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  expect((await snapshot(request)).mutationRequests.at(-1)).toMatchObject({
    method: "POST",
    url: "/dbs/Shop/colls/Archive/docs",
  });
  expect((await snapshot(request)).writeCount).toBe(1);
});

for (const width of [1100, 600])
  test(`readonly scope selector fits ${width}px and supports keyboard selection`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const f = await connect(page, true, true);
    await expect(f.locator("#scope-container")).toBeEnabled();
    await f.locator("#scope-container").press("Enter");
    await expect(f.locator("#scope-options").getByRole("option")).toHaveCount(
      2,
    );
    const menu = await f.locator("#scope-picker").boundingBox();
    const body = await f.locator("body").boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(body.x);
    expect(menu.x + menu.width).toBeLessThanOrEqual(body.x + body.width + 1);
    await f.locator("#scope-filter").fill("archive");
    await f.locator("#scope-filter").press("Enter");
    await expect(f.locator("#scope-container")).toHaveText("Archive");
    await expect(f.locator("#new")).toBeDisabled();
    await expect(f.locator("#save")).toBeDisabled();
    await expect(f.locator("#delete")).toBeDisabled();
    expect((await snapshot(request)).writeCount).toBe(0);
  });
