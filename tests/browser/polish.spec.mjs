import { test, expect } from "@playwright/test";
import { connect, query } from "./support.mjs";
const base = "http://127.0.0.1:18081/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
const snapshot = async (request) => (await request.get(base + "state")).json();

test("container context replaces the sidebar and metadata opens without extra database calls", async ({
  page,
  request,
}) => {
  const f = await connect(page, false, true, `Design preview ${Date.now()}`);
  await expect(f.locator("#scope-panel")).toBeHidden();
  await expect(f.locator("#scope-connection")).toBeHidden();
  await expect(f.locator("#scope-database")).toHaveText("Shop");
  await expect(f.locator("#scope-container")).toHaveText("Orders");
  const work = await f.locator(".workspace").boundingBox();
  const main = await f.locator("main").boundingBox();
  expect(Math.abs(main.x - work.x)).toBeLessThanOrEqual(1);
  await f.locator("#scope-info").press("Enter");
  await expect(f.locator("#scope-panel")).toBeVisible();
  await expect(f.locator("#metadata")).toContainText("/tenant");
  await expect(f.locator("#refresh")).toBeFocused();
  await f.locator("#refresh").press("Escape");
  await expect(f.locator("#scope-panel")).toBeHidden();
  await expect(f.locator("#scope-info")).toBeFocused();
  await f.locator("#scope-info").click();
  await f.locator("#sql .cm-content").click();
  await expect(f.locator("#scope-panel")).toBeHidden();
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "docs/container-workspace.png" });
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await expect(f.locator("body")).not.toHaveClass(/light/);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: "/tmp/dbx-polish-scoped-dark.png" });
  const after = await snapshot(request);
  expect(after.accountLists).toBe(0);
  expect(after.queryCalls).toBe(1);
  expect(after.writeCount).toBe(0);
});

test("compact fields keep aligned columns and track precise edits, invalid drafts and deleted fields", async ({
  page,
  request,
}) => {
  await request.get(base + "nested-document");
  const f = await connect(page);
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await expect(f.locator("#draft-summary")).toBeHidden();
  const status = f.getByLabel("字段 /status", { exact: true });
  const total = f.getByLabel("字段 /total", { exact: true });
  const before = await total.boundingBox();
  const row = await f.locator('.field-card[data-path="/total"]').boundingBox();
  expect(row.height).toBeLessThanOrEqual(64);
  await status.fill("paid");
  await total.fill("9223372036854775808");
  await expect(f.locator("#draft-summary")).toHaveText("已修改 2 个字段");
  await expect(f.locator(".field-modified")).toHaveCount(2);
  const after = await total.boundingBox();
  expect(after.x).toBe(before.x);
  expect(after.width).toBe(before.width);
  await total.fill("1e");
  await expect(f.locator("#draft-summary")).toHaveText(
    "草稿格式有误，请先修正",
  );
  await expect(f.locator("#save")).toBeDisabled();
  await total.fill("9223372036854775807");
  await expect(f.locator("#draft-summary")).toHaveText("已修改 1 个字段");
  await status.fill("pending");
  await expect(f.locator("#draft-summary")).toBeHidden();
  await expect(f.locator(".field-modified")).toHaveCount(0);
  await status.press("Tab");
  await expect(
    f.getByRole("button", { name: "删除字段 /status", exact: true }),
  ).toBeFocused();
  await f
    .getByRole("button", { name: "删除字段 /status", exact: true })
    .press("Enter");
  await expect(f.locator("#draft-summary")).toHaveText("已修改 1 个字段");
  await f.locator("#document-json-view").click();
  const json = f.locator("#editor .cm-content");
  const text = await json.innerText();
  await json.fill(
    text.replace(
      '"id": "order-001",',
      '"id": "order-001", "status": "pending",',
    ),
  );
  await expect(f.locator("#draft-summary")).toBeHidden();
  await f.locator("#fields-view").click();
  await expect(f.locator(".field-modified")).toHaveCount(0);
  expect((await snapshot(request)).writeCount).toBe(0);
});

for (const width of [1100, 900, 600]) {
  test(`scoped context and metadata fit a ${width}px workspace`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const f = await connect(
      page,
      true,
      true,
      `Scoped layout ${width} ${Date.now()}`,
    );
    await expect(f.locator("#scope-panel")).toBeHidden();
    expect(
      await f.locator("body").evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await f.locator("#scope-info").press("Enter");
    const panel = await f.locator("#scope-panel").boundingBox();
    const body = await f.locator("body").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(body.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(body.x + body.width);
    await f.locator("#refresh").press("Escape");
    await expect(f.locator("#scope-panel")).toBeHidden();
    await page
      .locator("iframe")
      .last()
      .screenshot({ path: `/tmp/dbx-polish-scoped-${width}.png` });
  });
}
