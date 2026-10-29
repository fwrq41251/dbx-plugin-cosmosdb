import { capturePath, mockURL, connect, query } from "./support.mjs";
import { test, expect } from "@playwright/test";
const base = mockURL + "/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function open(f) {
  await query(f);
  await f.getByRole("cell", { name: "order-001", exact: true }).dblclick();
  await f.locator("#read").click();
  await expect(f.locator("#field-editor")).toBeVisible();
}
async function save(f) {
  await expect(f.locator("#save")).toBeEnabled();
  await f.locator("#save").press("Space");
}
async function snapshot(request) {
  return (await request.get(base + "state")).json();
}

test("fields edit strings and exact numbers; saving sends only the two changed paths", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await open(f);
  await expect(f.getByLabel("字段 /id", { exact: true })).toBeDisabled();
  await expect(f.getByLabel("字段 /tenant", { exact: true })).toBeDisabled();
  await f.getByLabel("字段 /status", { exact: true }).fill("paid");
  await f
    .getByLabel("字段 /total", { exact: true })
    .fill("9223372036854775808");
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: capturePath("field-editor.png") });
  await save(f);
  await expect(f.locator("#confirm-title")).toHaveText("局部更新文档？");
  await expect(f.locator("#confirm-message")).toContainText(
    "仅提交 2 个字段操作",
  );
  await page.screenshot({
    path: capturePath("patch-preview.png"),
    fullPage: true,
  });
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  const result = await snapshot(request);
  expect(result.patchCount).toBe(1);
  expect(result.replaceCount).toBe(0);
  expect(result.lastPatch.operations.map((x) => x.path)).toEqual([
    "/status",
    "/total",
  ]);
  expect(result.document).toContain("9223372036854775808");
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "paid",
  );
});

test("invalid field input cannot be saved or silently discarded; field adds/removes become patch operations", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await open(f);
  await f.getByLabel("字段 /total", { exact: true }).fill("1e");
  await expect(f.locator("#save")).toBeDisabled();
  await f.locator("#document-json-view").click();
  await expect(f.locator("#status")).toContainText("请先修正字段值格式");
  await expect(f.locator("#field-editor")).toBeVisible();
  await f.getByLabel("字段 /total", { exact: true }).fill("42");
  await f
    .getByRole("button", { name: "删除字段 /status", exact: true })
    .click();
  await f.locator("#add-field-section summary").click();
  await f.locator("#add-field-path").fill("/remark");
  await f.locator("#add-field-value").fill('"hello"');
  await f.locator("#add-field").click();
  await f.locator("#field-filter").fill("remark");
  await expect(f.getByLabel("字段 /remark", { exact: true })).toHaveValue(
    "hello",
  );
  await save(f);
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  const result = await snapshot(request);
  expect(result.lastPatch.operations).toContainEqual({
    op: "remove",
    path: "/status",
  });
  expect(result.lastPatch.operations).toContainEqual({
    op: "set",
    path: "/remark",
    value: "hello",
  });
  expect(result.patchCount).toBe(1);
});

test("over ten changes require explicitly selecting full replacement", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await open(f);
  await f.locator("#document-json-view").click();
  const doc = JSON.parse(await f.locator("#editor .cm-content").innerText());
  // Keep the large untouched number exact in this test's edited JSON text.
  const additions = Array.from({ length: 11 }, (_, i) => `"f${i}":${i}`).join(
    ",",
  );
  const original = await f.locator("#editor .cm-content").innerText();
  await f
    .locator("#editor .cm-content")
    .fill(original.trim().slice(0, -1) + "," + additions + "}");
  await save(f);
  await expect(f.locator("#status")).toContainText("局部更新最多 10");
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  expect((await snapshot(request)).writeCount).toBe(0);
  await f.locator("#document-actions").press("ArrowDown");
  await expect(f.locator("#document-actions-menu")).toBeVisible();
  await f.locator("#replace-document").press("Enter");
  await expect(f.locator("#confirm-title")).toHaveText("替换完整文档？");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  const result = await snapshot(request);
  expect(result.replaceCount).toBe(1);
  expect(result.patchCount).toBe(0);
  const editor = f.locator("#editor .cm-content");
  await editor.fill(
    (await editor.innerText()).replace(
      '"status": "pending"',
      '"status": "paid"',
    ),
  );
  await save(f);
  await expect(f.locator("#confirm-title")).toHaveText("局部更新文档？");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  const second = await snapshot(request);
  expect(second.replaceCount).toBe(1);
  expect(second.patchCount).toBe(1);
});

test("syntax and write permission errors are actionable without leaking upstream diagnostics", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await f.locator("#sql .cm-content").fill('SELECT * FROM c AND c.id = "one"');
  await f.locator("#run").click();
  await expect(f.locator("#sql-error-message")).toContainText("SQL 语法错误");
  await expect(f.locator("#sql-error-message")).toContainText(
    "第 1 行，第 15 列",
  );
  await expect(f.locator("#status")).toBeHidden();
  await expect(f.locator("#status")).not.toContainText("secret-upstream-value");
  await f.locator("#sql .cm-content").fill("SELECT * FROM c");
  await open(f);
  await request.get(base + "deny-writes");
  await f.getByLabel("字段 /status", { exact: true }).fill("paid");
  await save(f);
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("当前凭据没有写入权限");
  await expect(f.locator("#status")).not.toContainText("secret-upstream-value");
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "paid",
  );
  expect((await snapshot(request)).writeCount).toBe(0);
});

test("read-only connections expose field viewing without editing controls", async ({
  page,
}) => {
  const f = await connect(page, true);
  await open(f);
  await expect(f.getByLabel("字段 /status", { exact: true })).toBeDisabled();
  await expect(f.locator("#add-field")).toBeDisabled();
  await expect(f.locator("#document-actions")).toBeHidden();
  await expect(f.locator("#replace-document")).toBeDisabled();
});
