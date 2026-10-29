import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
const savedViews = async () =>
  JSON.parse(
    await readFile(".dbx-dev/plugin-data/view-preferences-v1.json", "utf8"),
  );
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});

test("result and document formats persist independently across reload, preview, new documents and connections", async ({
  page,
}) => {
  const name = `Saved views ${Date.now()}`;
  let f = await connect(page, false, true, name);
  await expect(f.locator("#result-tools")).toBeHidden();
  await query(f);
  await expect(f.locator("#status")).toBeHidden();
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await f.locator("#document-json-view").click();
  await f.locator("#json-view").click();
  await expect
    .poll(savedViews)
    .toEqual({ version: 1, results: "json", document: "json" });
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  f = page.frameLocator("iframe").last();
  await expect(f.locator("#run")).toBeEnabled();
  await expect(f.locator("#json-view")).toHaveAttribute("aria-pressed", "true");
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(0);
  await query(f);
  await expect(f.locator("#raw-results")).toBeVisible();
  await f.locator("#document-toggle").click();
  await f.locator("#document-id").fill("order-001");
  await f.locator("#document-pk").fill('["demo"]');
  await f.locator("#read").click();
  await expect(f.locator("#editor")).toBeVisible();
  await expect(f.locator("#field-editor")).toBeHidden();
  await f.locator("#new").click();
  await expect(f.locator("#document-state")).toHaveText("新文档");
  await expect(f.locator("#editor")).toBeVisible();
  await f.locator("#fields-view").click();
  await expect
    .poll(savedViews)
    .toEqual({ version: 1, results: "json", document: "fields" });
  await f.locator("#new").click();
  await expect(f.locator("#field-editor")).toBeVisible();
  const firstId = await f.locator("#document-id").inputValue();
  await f.locator("#document-actions").press("ArrowDown");
  await f.locator("#generate-id").press("Enter");
  await expect(f.locator("#document-id")).not.toHaveValue(firstId);
  await expect(f.getByLabel("字段 /id", { exact: true })).toHaveValue(
    await f.locator("#document-id").inputValue(),
  );
  await f.locator("#table-view").click();
  await expect
    .poll(savedViews)
    .toEqual({ version: 1, results: "table", document: "fields" });
  await f.locator("#document-json-view").click();
  await expect
    .poll(savedViews)
    .toEqual({ version: 1, results: "table", document: "json" });
  f = await connect(page, true, true, `Other connection ${Date.now()}`, {
    keepViews: true,
  });
  await query(f);
  await f.locator("#table tbody tr").first().dblclick();
  await expect(f.locator("#document-state")).toHaveText("查询投影（只读）");
  await expect(f.locator("#editor")).toBeVisible();
  await expect(f.locator("#table-view")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("failed preference persistence does not prevent the chosen view or queries", async ({
  page,
}) => {
  const f = await connect(page);
  await page.route("**/api/bridge", (route) => {
    const body = route.request().postDataJSON();
    if (
      body.params?.method === "cosmos/viewPreferences" &&
      body.params?.params?.views
    )
      return route.fulfill({
        status: 500,
        json: { error: { message: "storage unavailable" } },
      });
    return route.continue();
  });
  await f.locator("#json-view").click();
  await expect(f.locator("#status")).toContainText("显示格式保存失败");
  await query(f);
  await expect(f.locator("#raw-results")).toBeVisible();
  await expect(f.locator("#json-view")).toHaveAttribute("aria-pressed", "true");
});

test("copy menus support context and keyboard access while auxiliary controls stay quiet", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await connect(page);
  await expect(f.locator("#result-tools")).toBeHidden();
  await query(f);
  const cell = f.getByRole("cell", {
    name: "9223372036854775807",
    exact: true,
  });
  await cell.click({ button: "right" });
  await expect(f.locator("#copy-menu")).toBeVisible();
  await f.locator("#copy-cell").press("Escape");
  await expect(cell).toBeFocused();
  await cell.press("Shift+F10");
  await expect(f.locator("#copy-cell")).toBeFocused();
  await f.locator("#copy-cell").press("ArrowDown");
  await f.locator("#copy-row").press("Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"total": 9223372036854775807');
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await expect(f.locator("#document-toggle")).toBeHidden();
  await f.locator("#document-close").click();
  await expect(f.locator("#document-toggle")).toBeVisible();
  await query(f);
  await expect(f.locator("#copy-selection")).toBeDisabled();
  await expect(f.locator("#status")).toBeHidden();
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "docs/query-workspace.png" });
});

test("scalar previews use JSON without replacing the saved document preference", async ({
  page,
  request,
}) => {
  const f = await connect(page, true);
  await request.get(base + "scalar-results");
  await f.locator("#sql .cm-content").fill("SELECT VALUE c.total FROM c");
  await query(f);
  await f
    .getByRole("button", { name: "预览第 1 行查询投影", exact: true })
    .click();
  await expect(f.locator("#editor")).toBeVisible();
  await expect(f.locator("#editor .cm-content")).toContainText(
    "9223372036854775807",
  );
  await expect
    .poll(savedViews)
    .toEqual({ version: 1, results: "table", document: "fields" });
});
