import { capturePath, mockURL, connect, query } from "./support.mjs";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.get(mockURL + "/test/reset");
});

test("all fields, column preferences, local filter and exact copy", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.get(mockURL + "/test/wide-document");
  const name = `table-prefs-${Date.now()}`;
  let oldLayoutRead = false;
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (
      !oldLayoutRead &&
      body.params?.method === "cosmos/tablePreferences" &&
      !body.params?.params?.preferences
    ) {
      oldLayoutRead = true;
      return route.fulfill({
        json: {
          value: {
            hidden: ["status", "extra29", "id"],
            pinId: false,
            widths: { id: 180 },
          },
        },
      });
    }
    return route.continue();
  });
  const frame = await connect(page, false, true, name);
  await query(frame);
  await expect(frame.locator("#choose-columns")).toHaveCount(0);
  await expect(
    frame.locator("#table th").filter({ hasText: /^extra29$/ }),
  ).toHaveCount(1);
  await expect(
    frame.locator("#table th").filter({ hasText: /^status$/ }),
  ).toHaveCount(1);
  await expect(frame.locator("#table th.pinned-id")).toHaveText(/id/);
  const resize = frame.getByRole("separator", {
    name: "调整 id 列宽",
    exact: true,
  });
  await resize.focus();
  const savedWidth = page.waitForResponse((response) => {
    if (
      !response.url().endsWith("/api/bridge") ||
      response.request().method() !== "POST"
    )
      return false;
    const body = response.request().postDataJSON();
    return (
      body.params?.method === "cosmos/tablePreferences" &&
      body.params?.params?.preferences?.widths?.id === 200
    );
  });
  await resize.press("ArrowRight");
  await savedWidth;
  await expect(resize).toHaveAttribute("aria-valuenow", "200");
  await frame
    .getByRole("cell", { name: "9223372036854775807", exact: true })
    .click();
  await frame.locator("#copy-selection").click();
  await frame.locator("#copy-cell").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("9223372036854775807");
  await frame.locator("#copy-selection").click();
  await frame.locator("#copy-row").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"total": 9223372036854775807');
  const before = await (await request.get(mockURL + "/test/state")).json();
  await frame.locator("#result-filter").fill("not-a-match");
  await expect(frame.locator("#row-count")).toHaveText("0 / 1 条（仅当前页）");
  const after = await (await request.get(mockURL + "/test/state")).json();
  expect(after.queryCalls).toBe(before.queryCalls);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const reopened = page.frameLocator("iframe").last();
  await query(reopened);
  await expect(
    reopened.locator("#table th").filter({ hasText: /^status$/ }),
  ).toHaveCount(1);
  await expect(
    reopened.getByRole("separator", { name: "调整 id 列宽", exact: true }),
  ).toHaveAttribute("aria-valuenow", "200");
  await page.screenshot({
    path: capturePath("dbx-results-improvements.png"),
    fullPage: true,
  });
});

test("cancel reaches HTTP, allows another query, and late work cannot replace results", async ({
  page,
  request,
}) => {
  const frame = await connect(page, false, true);
  await query(frame);
  await request.get(mockURL + "/test/slow-query");
  await frame.locator("#run").click();
  await expect(frame.locator("#status")).toContainText("查询执行中");
  await frame.locator("#cancel-query").click();
  await expect(frame.locator("#status")).toContainText("本次消耗未知");
  await expect(frame.locator("#table")).toContainText("order-001");
  await expect(frame.locator("#run")).toBeEnabled();
  await query(frame);
  await expect(frame.locator("#query-metrics")).toContainText("RU");
  await expect(frame.locator("#run")).toBeEnabled();
  await expect
    .poll(
      async () =>
        (await (await request.get(mockURL + "/test/state")).json())
          .canceledQueries,
    )
    .toBe(1);
  await page.waitForTimeout(1600);
  await expect(frame.locator("#query-metrics")).toContainText("RU");
  await expect(frame.locator("#run")).toBeEnabled();
  await expect(frame.locator("#page-label")).toHaveText("第 1 页");
});

test("row open uses its own complete identity and falls back to preview for incomplete projections", async ({
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
    frame.getByRole("button", { name: "预览第 1 行查询投影", exact: true }),
  ).toBeEnabled();
});

test("cell selection and keyboard copy preserve dirty drafts; metrics stay visible", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await connect(page);
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await f.locator("#document-json-view").click();
  const editor = f.locator("#editor .cm-content");
  await editor.fill('{"id":"order-001","tenant":"demo","status":"unsaved"}');
  const before = await (await request.get(mockURL + "/test/state")).json();
  const cell = f.getByRole("cell", { name: "order-001", exact: true });
  await cell.click();
  await expect(cell).toHaveClass(/cell-selected/);
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  await expect(editor).toContainText("unsaved");
  await expect(f.locator("#document-state")).toHaveText("未保存");
  await cell.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("order-001");
  await expect(f.locator("#query-metrics")).toContainText("2.81 RU");
  await cell.press("ArrowRight");
  await expect(f.locator("td.cell-selected")).toHaveText("demo");
  await expect(f.locator("td.cell-selected")).toBeFocused();
  const after = await (await request.get(mockURL + "/test/state")).json();
  expect(after.writeCount).toBe(before.writeCount);
  expect(after.queryCalls).toBe(before.queryCalls);
});

test("local filtering agrees across table, JSON and exported documents", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await query(f);
  const before = await (await request.get(mockURL + "/test/state")).json();
  await f.locator("#result-filter").fill("missing-value");
  await expect(f.locator("#table")).toContainText("当前页没有匹配的结果");
  await expect(f.locator("#table")).not.toContainText("当前页为空");
  await f.locator("#json-view").click();
  await expect(f.locator("#raw-results .cm-content")).toHaveText("[]");
  await expect(f.locator("#table-tools")).toBeHidden();
  await expect(f.locator("#export")).toHaveAttribute(
    "aria-label",
    "导出筛选结果",
  );
  // The official dev host has no saveFile implementation. Capture the exact
  // bridge payload instead of pretending a native file dialog is available.
  let exported;
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body.method !== "host.saveFile") return route.continue();
    exported = body.params;
    await route.fulfill({ json: { value: true } });
  });
  await f.locator("#export").click();
  await expect(f.locator("#status")).toContainText("当前页已导出");
  expect(exported.fileName).toContain("filtered");
  expect(
    JSON.parse(Buffer.from(exported.dataBase64, "base64").toString("utf8")),
  ).toEqual([]);
  await f.locator("#clear-filter").click();
  await expect(f.locator("#raw-results .cm-content")).toContainText(
    "order-001",
  );
  await f.locator("#result-filter").fill("order-001");
  await f.locator("#export").click();
  await expect(f.locator("#status")).toContainText("当前页已导出");
  expect(Buffer.from(exported.dataBase64, "base64").toString("utf8")).toContain(
    '"total": 9223372036854775807',
  );
  await f.locator("#clear-filter").click();
  await expect(f.locator("#clear-filter")).toBeHidden();
  await f.locator("#result-filter").fill("missing-value");
  await f.locator("#next").click();
  await expect(f.locator("#page-label")).toHaveText("第 2 页");
  await expect(f.locator("#clear-filter")).toBeVisible();
  await query(f);
  await expect(f.locator("#result-filter")).toHaveValue("");
  const after = await (await request.get(mockURL + "/test/state")).json();
  expect(after.queryCalls).toBe(before.queryCalls + 2);
});

test("query origin survives cancellation", async ({ page, request }) => {
  const f = await connect(page);
  await query(f);
  await f.locator("#sql .cm-content").fill("SELECT * FROM c WHERE true");
  await expect(f.locator("#result-origin")).toHaveText("查询条件已修改");
  await request.get(mockURL + "/test/slow-query");
  await f.locator("#run").click();
  await f.locator("#cancel-query").click();
  await expect(f.locator("#result-origin")).toHaveText("显示上次查询结果");
  await expect(f.locator("#query-metrics")).toContainText("2.81 RU");
});

test("documents open on demand and closing retains the draft and restores result space", async ({
  page,
}) => {
  const f = await connect(page);
  await expect(f.locator(".document-panel")).toBeHidden();
  await expect(f.locator("#document-toggle")).toHaveText("");
  await expect(f.locator("#document-toggle svg")).toHaveCount(1);
  await expect(f.locator("#document-toggle")).toHaveAttribute(
    "aria-label",
    "文档面板",
  );
  await expect(
    f.locator("#query-collapse, #run-collapsed, #sql-search"),
  ).toHaveCount(0);
  await query(f);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: capturePath("query-workspace.png") });
  await expect(f.locator(".row-read").first()).toHaveText("");
  await expect(f.locator(".row-read svg").first()).toBeVisible();
  await expect(f.locator("#result-filter")).toHaveAttribute(
    "placeholder",
    "在本页结果中查找…",
  );
  await expect(f.locator("#result-filter")).toHaveAttribute(
    "title",
    /查全库请使用 SQL WHERE/,
  );
  const wide = await f.locator("#table").boundingBox();
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await expect(f.locator(".document-panel")).toBeVisible();
  const split = await f.locator("#table").boundingBox();
  expect(wide.width).toBeGreaterThan(split.width + 250);
  const status = f.getByLabel("字段 /status", { exact: true });
  await status.fill("draft-kept");
  await f.locator("#document-close").click();
  await expect(f.locator(".document-panel")).toBeHidden();
  await expect(f.locator("#document-toggle")).toBeFocused();
  await expect(f.locator("#confirm-dialog")).toBeHidden();
  await f.locator("#document-toggle").click();
  await expect(status).toHaveValue("draft-kept");
  await expect(f.locator("#document-state")).toHaveText("未保存");
  await f.locator("#document-expand").click();
  await expect(f.locator("main")).toBeHidden();
  await f.locator("#document-close").click();
  await expect(f.locator("main")).toBeVisible();
  await expect(f.locator(".document-panel")).toBeHidden();
  await f.locator("#document-toggle").click();
  await expect(f.locator("main")).toBeVisible();
  await expect(status).toHaveValue("draft-kept");
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: capturePath("dbx-ux-refinement.png") });
});

test("successful queries clear the document panel and manual lookup remains available", async ({
  page,
}) => {
  const f = await connect(page);
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await query(f);
  await expect(f.locator(".document-panel")).toBeHidden();
  await expect(f.locator("#document-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await f.locator("#document-toggle").click();
  await f.locator("#document-id").fill("order-001");
  await f.locator("#document-pk").fill('["demo"]');
  await f.locator("#read").click();
  await expect(f.locator("#document-state")).toHaveText("完整文档");
});
