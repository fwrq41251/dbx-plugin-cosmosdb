import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});

test("result JSON is lazy, read-only, searchable and foldable without extra queries", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get(base + "nested-document");
  const f = await connect(page, true);
  await expect(f.locator(".code-editor .cm-editor")).toHaveCount(2);
  await query(f);
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(0);
  const before = await (await request.get(base + "state")).json();
  await f.locator("#json-view").click();
  const reader = f.getByRole("textbox", { name: "JSON 查询结果", exact: true });
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(1);
  await expect(reader).toHaveAttribute("contenteditable", "false");
  await expect(f.locator("#raw-results .cm-gutters")).toBeVisible();
  await reader.focus();
  await reader.press("ControlOrMeta+f");
  const search = f.locator('#raw-results .cm-search input[name="search"]');
  await search.fill("Tokyo");
  await expect(f.locator("#raw-results .editor-status")).toContainText(
    "匹配 1 项",
  );
  await search.press("Enter");
  await expect(f.locator("#raw-results .editor-status")).toContainText(
    "匹配 1 / 1 项",
  );
  await search.press("Escape");
  await expect(f.locator("#raw-results .editor-status")).not.toContainText(
    "匹配",
  );
  const folds = f.locator('#raw-results .cm-foldGutter [title="折叠此行"]');
  await folds.nth(2).click();
  await expect(f.locator("#raw-results .cm-foldPlaceholder")).toHaveCount(1);
  await expect(reader).not.toContainText("Tokyo");
  await expect(reader).toContainText("order-001");
  const foldedText = await reader.innerText();
  await reader.focus();
  await reader.press("x");
  expect(await reader.innerText()).toBe(foldedText);
  await f.locator("#copy-results-json").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"total": 9223372036854775807');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("Tokyo");
  await f.locator("#raw-results .cm-editor").evaluate((el) => {
    window.readerElement = el;
  });
  await f.locator("#table-view").click();
  await f.locator("#json-view").click();
  expect(
    await f
      .locator("#raw-results .cm-editor")
      .evaluate((el) => el === window.readerElement),
  ).toBe(true);
  await expect(f.locator("#raw-results .cm-foldPlaceholder")).toHaveCount(1);
  const box = await f.locator("#raw-results").boundingBox(),
    panel = await f.locator(".results-panel").boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
  const after = await (await request.get(base + "state")).json();
  expect(after.queryCalls).toBe(before.queryCalls);
  expect(after.writeCount).toBe(0);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "/tmp/dbx-result-json.png" });
});

test("current-page filters, page changes and scopes replace the JSON reader without stale data", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get(base + "nested-document");
  const f = await connect(page);
  await query(f);
  await f.locator("#json-view").click();
  await f.locator("#result-filter").fill("missing-result");
  await expect(f.locator("#raw-results .cm-content")).toHaveText("[]");
  await f.locator("#copy-results-json").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("[]");
  await f.locator("#clear-filter").click();
  await expect(f.locator("#raw-results .cm-content")).toContainText("Tokyo");
  await f.locator("#next").click();
  await expect(f.locator("#raw-results .cm-content")).toHaveText("[]");
  await f.locator("#previous").click();
  await expect(f.locator("#raw-results .cm-content")).toContainText("Tokyo");
  await f.locator("#table-view").click();
  await request.get(base + "reset");
  await query(f);
  await expect(f.locator("#raw-results .cm-content")).not.toContainText(
    "Tokyo",
  );
  await f.locator("#json-view").click();
  await expect(f.locator("#raw-results .cm-content")).toContainText(
    "order-001",
  );
  await expect(f.locator("#raw-results .cm-content")).not.toContainText(
    "Tokyo",
  );
  await f.locator("#container").selectOption("Archive");
  await expect(f.locator("#copy-results-json")).toBeDisabled();
  await expect(f.locator("#result-json-search")).toBeDisabled();
  await expect(f.locator("#raw-results .cm-content")).not.toContainText(
    "order-001",
  );
});

test("large result JSON virtualizes lines but search and copy keep the complete precise page", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get(base + "large-result");
  const f = await connect(page);
  await query(f);
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(0);
  await f.locator("#json-view").click();
  await expect
    .poll(() => f.locator("#raw-results .cm-line").count())
    .toBeLessThan(1000);
  await f.locator("#copy-results-json").click();
  const copied = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(copied).toContain('"total": 9223372036854775807');
  await expect.poll(copied).toContain("entry-999");
  await expect.poll(copied).toContain("tail-marker");
  expect(JSON.parse(await copied())[0].items).toHaveLength(1000);
  await f.locator("#result-json-search").click();
  await f
    .locator('#raw-results .cm-search input[name="search"]')
    .fill("entry-999");
  await expect(f.locator("#raw-results .editor-status")).toContainText(
    "匹配 1 项",
  );
  await f
    .locator('#raw-results .cm-search input[name="search"]')
    .press("Enter");
  await expect(f.locator("#raw-results .cm-content")).toContainText(
    "entry-999",
  );
  expect((await (await request.get(base + "state")).json()).queryCalls).toBe(1);
});

test("opening result JSON before a query stays empty and copy/search remain unavailable", async ({
  page,
}) => {
  const f = await connect(page);
  await f.locator("#json-view").click();
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(0);
  await expect(f.locator("#result-tools")).toBeHidden();
  await expect(f.locator("#copy-results-json")).toBeDisabled();
  await expect(f.locator("#result-json-search")).toBeDisabled();
  await query(f);
  await expect(f.locator("#raw-results .cm-editor")).toHaveCount(1);
  await expect(f.locator("#copy-results-json")).toBeEnabled();
  await expect(f.locator("#result-json-search")).toBeEnabled();
});
