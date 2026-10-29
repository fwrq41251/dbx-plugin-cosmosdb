import { capturePath, mockURL, connect, query } from "./support.mjs";
import { test, expect } from "@playwright/test";

const base = mockURL + "/test/";
test.beforeEach(async ({ request }) => {
  await request.get(base + "reset");
});
async function chooser(frame, target = "查询") {
  await frame
    .getByRole("button", { name: `选择${target}分区键`, exact: true })
    .click();
  await expect(frame.locator("#pk-picker")).toBeVisible();
}
async function calls(request) {
  return (await (await request.get(base + "state")).json()).discoveryCalls;
}

test("automatically loads every page; filtering and selection preserve types and scoped caches", async ({
  page,
  request,
}) => {
  const f = await connect(page, true);
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  await expect(f.locator("#pk-mode")).toHaveCount(0);
  await f.locator("#query-pk").fill("omega");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(1);
  const before = await calls(request);
  await f.locator("#query-pk").fill("42");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(2);
  expect(await calls(request)).toBe(before);
  await f
    .locator("#pk-options")
    .getByRole("option")
    .filter({ hasText: "[42]" })
    .click();
  await expect(f.locator("#query-pk")).toHaveValue("[42]");
  await chooser(f);
  await f.locator("#query-pk").fill("demo");
  await f.locator("#pk-options").getByRole("option").click();
  await query(f);
  await f.locator("#document-toggle").click();
  await chooser(f, "文档");
  await f.locator("#document-pk").fill("beta");
  await f.locator("#pk-options").getByRole("option").click();
  await expect(f.locator("#document-pk")).toHaveValue('["beta"]');
  await f.getByLabel("容器", { exact: true }).selectOption("Archive");
  await expect(f.locator("#query-pk")).toHaveValue("");
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(1);
  await expect(f.locator("#pk-options")).toContainText("archive-only");
  await f.locator("#query-pk").press("Escape");
  await f.getByLabel("容器", { exact: true }).selectOption("Orders");
  await expect(f.locator("#query-pk")).toHaveValue('["demo"]');
  const cached = await calls(request);
  await chooser(f);
  await f.locator("#query-pk").fill("omega");
  await f.locator("#query-pk").press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(f.locator("#pk-picker")).toBeHidden();
  await expect(f.locator("#query-pk")).toHaveValue('["omega"]');
  expect(await calls(request)).toBe(cached);
});

test("auto retries 429; closing pauses paging; reopening resumes; refresh updates the complete list", async ({
  page,
  request,
}) => {
  const f = await connect(page, true);
  await request.get(base + "slow-discovery");
  await request.get(base + "throttle-discovery");
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("服务限流");
  await expect(f.locator("#pk-options")).toContainText("demo");
  await f.locator("#query-pk").press("Escape");
  // Let the single in-flight page settle; there must be no further background requests.
  await page.waitForTimeout(700);
  const stopped = await calls(request);
  await page.waitForTimeout(600);
  expect(await calls(request)).toBe(stopped);
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  await expect(f.locator("#pk-options")).toContainText("omega");
  await expect(f.locator("#pk-options")).toContainText("未定义");
  await page.screenshot({
    path: capturePath("partition-picker.png"),
    fullPage: true,
  });
  await f.locator("#pk-reload").press("Space");
  await expect(f.locator("#pk-progress")).toContainText("自动加载中");
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  expect(await calls(request)).toBeGreaterThan(stopped);
});

test("container connections open directly and retain the saved scope after reopening", async ({
  page,
  request,
}) => {
  const name = `E2E-scoped-${Date.now()}`;
  const f = await connect(page, true, true, name);
  await expect(f.getByLabel("数据库", { exact: true })).toHaveValue("Shop");
  await expect(f.getByLabel("容器", { exact: true })).toHaveValue("Orders");
  await expect(f.locator("#mode")).toContainText("只读");
  await expect(f.locator("#run")).toBeEnabled();
  expect((await (await request.get(base + "state")).json()).accountLists).toBe(
    1,
  );
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const reopened = page.frameLocator("iframe").last();
  await expect(reopened.getByLabel("数据库", { exact: true })).toHaveValue(
    "Shop",
  );
  await expect(reopened.getByLabel("容器", { exact: true })).toHaveValue(
    "Orders",
  );
  await expect(reopened.locator("#run")).toBeEnabled();
  expect((await (await request.get(base + "state")).json()).accountLists).toBe(
    1,
  );
});

test("persistent key cache reopens without database discovery; explicit refresh reads again", async ({
  page,
  request,
}) => {
  const name = `E2E-cache-${Date.now()}`;
  let f = await connect(page, true, true, name);
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  const before = await calls(request);
  expect(before).toBeGreaterThan(1);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  f = page.frameLocator("iframe").last();
  await expect(f.locator("#run")).toBeEnabled();
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("本地缓存");
  await expect(f.locator("#pk-progress")).toContainText("本次 0.00 RU");
  await f.locator("#query-pk").fill("omega");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(1);
  expect(await calls(request)).toBe(before);
  await f.locator("#pk-reload").press("Space");
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  expect(await calls(request)).toBeGreaterThan(before);
});

test("unsupported seek does not start a document scan", async ({
  page,
  request,
}) => {
  const f = await connect(page, true);
  await request.get(base + "unsupported-seek");
  await chooser(f);
  await expect(f.locator("#pk-progress")).toContainText("HTTP 400");
  await expect(f.locator("#pk-load")).toHaveAttribute("aria-label", "继续加载");
  expect(await calls(request)).toBe(1);
});

test("typing directly filters local candidates without discovery and preserves manual JSON keys", async ({
  page,
  request,
}) => {
  const f = await connect(page, true);
  const input = f.locator("#query-pk");
  await input.fill("[9007199254740993]");
  await expect(input).toHaveAttribute("role", "combobox");
  await expect(f.locator("#pk-picker")).toBeHidden();
  await expect(input).toBeFocused();
  await expect(f.locator("#pk-filter")).toHaveCount(0);
  await input.press("Enter");
  await expect(input).toHaveValue("[9007199254740993]");
  expect(await calls(request)).toBe(0);
  await query(f);
  const state = await (await request.get(base + "state")).json();
  expect(state.queryRequests.at(-1).partitionKey).toBe("[9007199254740993]");
  await input.fill("omega");
  await input.press("ArrowDown");
  await expect(f.locator("#pk-progress")).toContainText("全部分区键已加载");
  await input.fill("omega");
  await expect(f.locator("#pk-options").getByRole("option")).toHaveCount(1);
  const loaded = await calls(request);
  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-activedescendant", /pk-option/);
  await input.press("Enter");
  await expect(input).toHaveValue('["omega"]');
  await expect(input).toHaveAttribute("aria-expanded", "false");
  expect(await calls(request)).toBe(loaded);
  await page.setViewportSize({ width: 600, height: 800 });
  await input.press("ArrowDown");
  const picker = await f.locator("#pk-picker").boundingBox();
  const body = await f.locator("body").boundingBox();
  const box = await input.boundingBox();
  expect(picker.x).toBeGreaterThanOrEqual(body.x);
  expect(picker.x + picker.width).toBeLessThanOrEqual(body.x + body.width + 1);
  expect(picker.y + picker.height).toBeLessThanOrEqual(
    body.y + body.height + 1,
  );
  expect(
    picker.y >= box.y + box.height || picker.y + picker.height <= box.y,
  ).toBe(true);
  await page
    .locator("iframe")
    .last()
    .screenshot({ path: capturePath("dbx-partition-combobox-narrow.png") });
});
