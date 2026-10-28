import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function selectLastLine(sql, text) {
  await sql.fill(text);
  await sql.press("ControlOrMeta+End");
  for (let i = 0; i < text.split("\n").at(-1).length; i++)
    await sql.press("Shift+ArrowLeft");
}

test("shortcut executes only selected SQL; pagination retains that snapshot after edits", async ({
  page,
  request,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await f.locator("#query-pk").fill('["demo"]');
  await selectLastLine(sql, "BAD first statement\nSELECT * FROM c");
  await expect(f.locator("#run")).toHaveText("运行选中 SQL");
  await expect(f.locator("#sql .editor-status")).toContainText("执行选区");
  await sql.press("ControlOrMeta+Enter");
  await expect(f.locator("#status")).toContainText("查询完成");
  expect(await sql.innerText()).toBe("BAD first statement\nSELECT * FROM c");
  await expect(f.locator("#execution-source")).toHaveText("选中 SQL · 第 2 行");
  await expect(f.locator("#result-origin")).toHaveText("当前页");
  await sql.fill("SELECT c.id FROM c");
  await expect(f.locator("#result-origin")).toHaveText("查询条件已修改");
  await f.locator("#next").click();
  await expect(f.locator("#page-label")).toHaveText("第 2 页");
  const state = await (await request.get(base + "state")).json();
  expect(state.queryRequests.map((x) => x.query)).toEqual([
    "SELECT * FROM c",
    "SELECT * FROM c",
  ]);
  expect(state.queryRequests[1].continuation).toBe("second-page");
  expect(state.queryRequests.every((x) => x.partitionKey === '["demo"]')).toBe(
    true,
  );
  expect(state.writeCount).toBe(0);
});

test("selected syntax error maps to the document line, click focuses it, edits clear stale marks", async ({
  page,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await selectLastLine(
    sql,
    "-- 😀 中文\nSELECT c.id FROM c\nSELECT * FROM c WHERE c.BAD = true",
  );
  await f.locator("#run").click();
  await expect(f.locator("#sql-diagnostic")).toContainText("第 3 行，第 25 列");
  await expect(f.locator("#sql .cm-lintRange-error")).toHaveCount(1);
  await expect(f.locator("#status")).not.toContainText("secret-upstream-value");
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "/tmp/dbx-sql-error.png" });
  await f.locator("#sql-diagnostic").click();
  await expect(sql).toBeFocused();
  await expect(f.locator("#sql .editor-status")).toContainText(
    "第 3 行，第 25 列",
  );
  await sql.fill("SELECT * FROM c");
  await expect(f.locator("#sql-diagnostic")).toBeHidden();
  await expect(f.locator("#sql .cm-lintRange-error")).toHaveCount(0);
  await query(f);
  await expect(f.locator("#execution-source")).toBeHidden();
});

test("blank selection never runs the whole editor; collapsed run uses the selected SQL", async ({
  page,
  request,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await sql.fill("SELECT * FROM c");
  await sql.press("ControlOrMeta+End");
  await sql.press("ArrowLeft");
  await sql.press("Shift+ArrowLeft");
  await expect(f.locator("#sql .editor-status")).toContainText("已选 1 字符");
  await f.locator("#run").click();
  await expect(f.locator("#status")).toContainText("未执行全文");
  expect((await (await request.get(base + "state")).json()).queryCalls).toBe(0);
  await selectLastLine(sql, "BAD first statement\nSELECT * FROM c");
  await f.locator("#query-collapse").click();
  await expect(f.locator("#run-collapsed")).toHaveText("运行选中 SQL");
  await f.locator("#run-collapsed").click();
  await expect(f.locator("#status")).toContainText("查询完成");
  expect(
    (await (await request.get(base + "state")).json()).queryRequests[0].query,
  ).toBe("SELECT * FROM c");
});

test("syntax errors without trustworthy offsets keep text feedback without a guessed highlight", async ({
  page,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  for (const text of [
    "SELECT * FROM c WHERE BAD_NO_POSITION",
    "SELECT * FROM c WHERE BAD_INVALID_POSITION",
    "SELECT * FROM c WHERE NEEDS_PIPELINE",
  ]) {
    await sql.fill(text);
    await f.locator("#run").click();
    await expect(f.locator("#status")).toContainText("查询失败");
    await expect(f.locator("#sql-diagnostic")).toBeHidden();
    await expect(f.locator("#sql .cm-lintRange-error")).toHaveCount(0);
  }
});

test("canceled late syntax errors cannot mark a subsequent successful query", async ({
  page,
  request,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await sql.fill("SELECT * FROM c WHERE BAD");
  await request.get(base + "slow-query");
  await f.locator("#run").click();
  await expect(f.locator("#cancel-query")).toBeVisible();
  await f.locator("#cancel-query").click();
  await sql.fill("SELECT * FROM c");
  await query(f);
  await page.waitForTimeout(1600);
  await expect(f.locator("#sql-diagnostic")).toBeHidden();
  await expect(f.locator("#sql .cm-lintRange-error")).toHaveCount(0);
  await expect(f.locator("#row-count")).toHaveText("1 条");
});

test("post-write refresh retains the previously selected SQL and source", async ({
  page,
  request,
}) => {
  const f = await connect(page),
    sql = f.locator("#sql .cm-content");
  await selectLastLine(sql, "BAD first statement\nSELECT * FROM c");
  await f.locator("#run").click();
  await expect(f.locator("#status")).toContainText("查询完成");
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await expect(f.locator("#document-state")).toHaveText("完整文档");
  await sql.fill("BAD unrelated query");
  await f.getByLabel("字段 /status", { exact: true }).fill("paid");
  await f.locator("#save").focus();
  await f.locator("#save").press("Enter");
  await expect(f.locator("#confirm-title")).toHaveText("局部更新文档？");
  await f.locator("#confirm-accept").click();
  await expect(f.locator("#status")).toContainText("保存成功");
  await expect(f.locator("#execution-source")).toHaveText("选中 SQL · 第 2 行");
  await expect(f.locator("#result-origin")).toHaveText("查询条件已修改");
  const state = await (await request.get(base + "state")).json();
  expect(state.queryRequests.map((x) => x.query)).toEqual([
    "SELECT * FROM c",
    "SELECT * FROM c",
  ]);
  expect(state.patchCount).toBe(1);
});
