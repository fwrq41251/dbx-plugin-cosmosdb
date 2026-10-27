import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function open(f) {
  await query(f);
  await f.getByRole("cell", { name: "order-001", exact: true }).click();
  await f.locator("#read").click();
  await f.locator("#document-json-view").click();
  return f.locator("#editor .cm-content");
}
async function fillCode(editor, text) {
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await editor.fill(text);
}

async function menuAction(f, id) {
  await f.locator("#document-more").click();
  await f.locator("#" + id).click();
}

test("JSON formatting preserves numeric literals, is undoable and shares the draft with fields", async ({
  page,
}) => {
  const f = await connect(page),
    editor = await open(f);
  const text =
    '{"id":"order-001","tenant":"demo","status":"中文备注","total":9223372036854775807,"decimal":1.2300e+20,"nested":{"active":true}}';
  await editor.fill(text);
  await menuAction(f, "document-format");
  await expect(editor).toContainText("1.2300e+20");
  await expect(editor).toContainText("9223372036854775807");
  expect(await editor.innerText()).toContain("\n");
  await editor.press("ControlOrMeta+z");
  expect(await editor.innerText()).toBe(text);
  await f.locator("#fields-view").click();
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "中文备注",
  );
  await f.locator("#document-json-view").click();
  expect(await editor.innerText()).toBe(text);
  await expect(f.locator("#save")).toBeEnabled();
});

test("invalid JSON is retained, located by line/column, and cannot be saved or switched away", async ({
  page,
}) => {
  const f = await connect(page),
    editor = await open(f);
  await editor.fill("");
  await expect(f.locator("#json-diagnostic")).toContainText("第 1 行");
  await expect(f.locator("#save")).toBeDisabled();
  const text = '{\n "id": "order-001",\n "tenant": "demo",\n "total": }';
  await editor.fill(text);
  await expect(f.locator("#json-diagnostic")).toContainText("第 4 行");
  await expect(f.locator("#save")).toBeDisabled();
  await f.locator("#fields-view").click();
  await expect(f.locator("#status")).toContainText("JSON 文档格式不正确");
  await f.locator("#json-diagnostic").click();
  await expect(editor).toBeFocused();
  await expect(f.locator("#editor .editor-status")).toContainText("第 4 行");
  await menuAction(f, "document-format");
  expect(await editor.innerText()).toBe(text);
  await editor.fill('{"id":"order-001","tenant":"demo","total":42}');
  await expect(f.locator("#json-diagnostic")).toBeHidden();
  await expect(f.locator("#save")).toBeEnabled();
});

test("read-only JSON supports search counts, folding and panel expansion without enabling writes", async ({
  page,
  request,
}) => {
  await request.get(base + "nested-document");
  const f = await connect(page, true),
    editor = await open(f);
  await f.locator("#document-search").click();
  const search = f.locator('#editor .cm-search input[name="search"]');
  await search.fill("demo");
  await expect(f.locator("#editor .editor-status")).toContainText("匹配 1 项");
  await f.locator("#editor .cm-search button[name=next]").click();
  await expect(f.locator("#editor .editor-status")).toContainText(
    "匹配 1 / 1 项",
  );
  await search.press("Escape");
  await menuAction(f, "document-fold");
  await expect(f.locator("#editor .cm-foldPlaceholder")).toHaveCount(2);
  await expect(f.locator("#editor .cm-content")).toContainText('"id"');
  await expect(f.locator("#editor .cm-content")).toContainText('"address"');
  await expect(f.locator("#editor .cm-content")).not.toContainText("Tokyo");
  await expect(f.locator("#editor .editor-status")).toContainText(
    "已折叠 2 处",
  );
  await menuAction(f, "document-unfold");
  await expect(f.locator("#editor .cm-foldPlaceholder")).toHaveCount(0);
  await f.locator("#document-resize").focus();
  await f.locator("#document-resize").press("ArrowLeft");
  await expect(f.locator("#document-resize")).toHaveAttribute(
    "aria-valuenow",
    "430",
  );
  await f.locator("#document-expand").click();
  await expect(f.locator("main")).toBeHidden();
  await expect(editor).toBeVisible();
  await page.screenshot({ path: "docs/json-editor.png", fullPage: true });
  await f.locator("#document-expand").click();
  await expect(f.locator("main")).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(f.locator("#document-format")).toBeDisabled();
  await expect(f.locator("#save")).toBeDisabled();
});

test("SQL offers Cosmos keywords, learned fields and parameters without remote discovery", async ({
  page,
  request,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await expect(
    f.getByRole("button", { name: "补全", exact: true }),
  ).toHaveCount(0);
  await fillCode(sql, "");
  await sql.pressSequentially("SEL");
  await f.getByRole("option", { name: "SELECT", exact: true }).click();
  await expect(sql).toHaveText("SELECT");
  await fillCode(sql, "SELECT * FROM c");
  await query(f);
  const before = await (await request.get(base + "state")).json();
  await fillCode(sql, "SELECT * FROM c WHERE c.st");
  await sql.press("Control+Space");
  await f.getByRole("option", { name: /status/ }).click();
  await expect(sql).toHaveText("SELECT * FROM c WHERE c.status");
  await f.locator(".query-panel details summary").click();
  await f.locator("#parameters").fill('[{"name":"@member","value":"example"}]');
  await fillCode(sql, "SELECT * FROM c WHERE c.id = @m");
  await sql.press("Control+Space");
  await f.getByRole("option", { name: /@member/ }).click();
  await expect(sql).toHaveText("SELECT * FROM c WHERE c.id = @member");
  const after = await (await request.get(base + "state")).json();
  expect(after.discoveryCalls).toBe(before.discoveryCalls);
  expect(after.writeCount).toBe(0);
  await page.screenshot({ path: "docs/sql-editor.png", fullPage: true });
  // A new container has no inherited field candidates.
  await f.locator("#container").selectOption("Archive");
  await fillCode(sql, "SELECT * FROM c WHERE c.st");
  await sql.press("Control+Space");
  await expect(f.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
});
