import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function read(f) {
  await query(f);
  await f.getByRole("cell", { name: "order-001", exact: true }).dblclick();
  await f.locator("#read").click();
}

test("query controls align and document tools stay in a single compact row", async ({
  page,
  request,
}) => {
  await request.get(base + "nested-document");
  const f = await connect(page);
  const boxes = await Promise.all(
    ["page-size", "query-pk", "query-pk-choose", "run"].map((id) =>
      f.locator("#" + id).boundingBox(),
    ),
  );
  for (const box of boxes) {
    expect(Math.abs(box.height - 32)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(1);
  }
  await read(f);
  await expect(f.locator("#document-location")).not.toHaveAttribute("open");
  await expect(f.locator("#document-identity")).toHaveText("order-001");
  await f.locator("#document-json-view").click();
  const toolbar = await f.locator(".document-view-toolbar").boundingBox();
  expect(toolbar.height).toBeLessThanOrEqual(52);
  const tools = await Promise.all(
    [
      "fields-view",
      "document-json-view",
      "document-search",
      "document-more",
    ].map((id) => f.locator("#" + id).boundingBox()),
  );
  for (const box of tools)
    expect(Math.abs(box.y - tools[0].y)).toBeLessThanOrEqual(1);
  // Opening another document keeps the user's chosen representation.
  await f.locator("#table tbody tr").first().dblclick();
  await f.locator("#read").click();
  await expect(f.locator("#editor")).toBeVisible();
  await expect(f.locator("#document-json-view")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(f.locator("#document-location")).not.toHaveAttribute("open");
  await f.locator("#document-more").press("ArrowDown");
  await expect(f.locator("#document-format")).toBeFocused();
  await f.locator("#document-format").press("ArrowDown");
  await expect(f.locator("#document-fold")).toBeFocused();
  await f.locator("#document-fold").press("Escape");
  await expect(f.locator("#document-menu")).toBeHidden();
  await expect(f.locator("#document-more")).toBeFocused();
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "docs/workspace-layout.png" });
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await expect(f.locator("body")).not.toHaveClass(/light/);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "docs/workspace-layout-dark.png" });
  expect((await (await request.get(base + "state")).json()).writeCount).toBe(0);
});

test("flat documents explain why nested folding is unavailable and menus dismiss outside", async ({
  page,
}) => {
  const f = await connect(page);
  await read(f);
  await expect(f.locator("#document-more")).toBeHidden();
  await f.locator("#document-json-view").click();
  await f.locator("#document-more").click();
  await expect(f.locator("#document-fold")).toBeDisabled();
  await expect(f.locator("#document-fold")).toHaveAttribute(
    "title",
    /没有可折叠/,
  );
  await expect(f.locator("#document-unfold")).toBeDisabled();
  await f.locator("#document-json-view").click();
  await expect(f.locator("#document-menu")).toBeHidden();
});

for (const width of [1100, 900, 600]) {
  test(`query and result controls fit a ${width}px window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const f = await connect(page);
    await query(f);
    await expect(f.locator("#run")).toBeVisible();
    expect(
      await f.locator("body").evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    const boxes = await Promise.all(
      ["page-size", "query-pk", "query-pk-choose", "run"].map((id) =>
        f.locator("#" + id).boundingBox(),
      ),
    );
    const panel = await f.locator(".query-panel").boundingBox();
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(Math.abs(box.height - 32)).toBeLessThanOrEqual(1);
    }
    await expect(f.locator("#choose-columns")).toHaveCount(0);
    await expect(f.locator("#table-tools #copy-cell")).toHaveCount(1);
    if (width === 600)
      await page
        .locator("iframe")
        .last()
        .screenshot({ path: "/tmp/dbx-ux-narrow.png" });
  });
}

test("query shortcut runs from the query panel without interrupting JSON drafts", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  const sql = f.locator("#sql .cm-content");
  await sql.click();
  await sql.press("ControlOrMeta+Enter");
  await expect(f.locator("#row-count")).toHaveText("1 条");
  await f.getByRole("cell", { name: "order-001", exact: true }).dblclick();
  await f.locator("#read").click();
  await f.locator("#document-json-view").click();
  const editor = f.locator("#editor .cm-content");
  await editor.fill('{"id":"order-001","tenant":"demo","status":"unsaved"}');
  await editor.press("ControlOrMeta+Enter");
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  await expect(f.locator("#document-state")).toHaveText("未保存");
  await expect(editor).toContainText("unsaved");
  expect((await (await request.get(base + "state")).json()).writeCount).toBe(0);
});
