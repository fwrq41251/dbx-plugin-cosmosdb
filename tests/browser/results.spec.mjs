import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";

test.beforeEach(async ({ request }) => {
  await request.get("http://127.0.0.1:18081/test/reset");
});

test("all fields, column preferences, local filter and exact copy", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get("http://127.0.0.1:18081/test/wide-document");
  const name = `table-prefs-${Date.now()}`;
  const frame = await connect(page, false, true, name);
  await query(frame);
  await frame.locator("#choose-columns").click();
  await expect(
    frame.getByLabel("显示列 extra29", { exact: true }),
  ).toBeVisible();
  await frame.getByLabel("显示列 status", { exact: true }).uncheck();
  await expect(
    frame.locator("#table th").filter({ hasText: /^status$/ }),
  ).toHaveCount(0);
  await frame.locator("#columns-close").click();
  const resize = frame.getByRole("separator", {
    name: "调整 id 列宽",
    exact: true,
  });
  await resize.focus();
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "200");
  await expect(frame.locator("#table-preferences-status")).toHaveText(
    "列设置已保存",
  );
  await frame
    .getByRole("cell", { name: "9223372036854775807", exact: true })
    .click();
  await frame.locator("#copy-cell").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("9223372036854775807");
  await frame.locator("#copy-row").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"total": 9223372036854775807');
  const before = await (
    await request.get("http://127.0.0.1:18081/test/state")
  ).json();
  await frame.locator("#result-filter").fill("not-a-match");
  await expect(frame.locator("#row-count")).toHaveText("0 / 1 条（仅当前页）");
  const after = await (
    await request.get("http://127.0.0.1:18081/test/state")
  ).json();
  expect(after.queryCalls).toBe(before.queryCalls);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const reopened = page.frameLocator("iframe").last();
  await query(reopened);
  await expect(
    reopened.locator("#table th").filter({ hasText: /^status$/ }),
  ).toHaveCount(0);
  await expect(
    reopened.getByRole("separator", { name: "调整 id 列宽", exact: true }),
  ).toHaveAttribute("aria-valuenow", "200");
  await page.screenshot({
    path: "/tmp/dbx-results-improvements.png",
    fullPage: true,
  });
});

test("cancel reaches HTTP, allows another query, and late work cannot replace results", async ({
  page,
  request,
}) => {
  const frame = await connect(page, false, true);
  await query(frame);
  await request.get("http://127.0.0.1:18081/test/slow-query");
  await frame.locator("#run").click();
  await expect(frame.locator("#status")).toContainText("查询执行中");
  await frame.locator("#cancel-query").click();
  await expect(frame.locator("#status")).toContainText("本次消耗未知");
  await expect(frame.locator("#table")).toContainText("order-001");
  await expect(frame.locator("#run")).toBeEnabled();
  await query(frame);
  await expect(frame.locator("#status")).toContainText("查询完成");
  await expect
    .poll(
      async () =>
        (await (await request.get("http://127.0.0.1:18081/test/state")).json())
          .canceledQueries,
    )
    .toBe(1);
  await page.waitForTimeout(1600);
  await expect(frame.locator("#status")).toContainText("查询完成");
  await expect(frame.locator("#page-label")).toHaveText("第 1 页");
});

test("row point read uses its own complete identity and rejects incomplete projections", async ({
  page,
}) => {
  const frame = await connect(page);
  await query(frame);
  await frame
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await expect(frame.locator("#document-state")).toHaveText("完整文档");
  await expect(frame.locator("#document-id")).toHaveValue("order-001");
  await expect(frame.locator("#document-pk")).toHaveValue('["demo"]');
  await frame.locator("#sql .cm-content").fill("SELECT TOP 1 c.id FROM c");
  await query(frame);
  await expect(
    frame.getByRole("button", { name: "读取第 1 行完整文档", exact: true }),
  ).toBeDisabled();
});
