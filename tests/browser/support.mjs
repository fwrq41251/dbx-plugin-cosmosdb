import { readRun, capturePath } from "../e2e-run.mjs";
const run = readRun();
export const { mockURL, hostURL, pluginData } = run;
export { capturePath };
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
export async function connect(
  page,
  readOnly = false,
  scoped = false,
  name = `E2E-${Date.now()}`,
  { keepViews = false, hostLocale = "zh-CN" } = {},
) {
  if (!keepViews) {
    await mkdir(pluginData, { recursive: true });
    await writeFile(
      resolve(pluginData, "view-preferences-v1.json"),
      JSON.stringify({ version: 1, results: "table", document: "fields" }),
      { mode: 0o600 },
    );
  }
  page.on("pageerror", (error) =>
    console.error("Workbench page error:", error.message),
  );
  await page.goto(hostURL);
  if (hostLocale === "en")
    await page
      .getByRole("button", { name: "切换插件语言", exact: true })
      .click();
  await page
    .getByRole("button", { name: /^(新建连接|New connection)$/, exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^(连接名称|Connection name)$/, exact: true })
    .fill(name);
  await page
    .getByRole("textbox", {
      name: /^(Account Endpoint|账号地址（Account Endpoint）)$/,
      exact: true,
    })
    .fill(mockURL);
  await page
    .getByRole("textbox", {
      name: /^(Account Key|账号密钥（Account Key）)$/,
      exact: true,
    })
    .fill("dGVzdC1hY2NvdW50LWtleQ==");
  await page
    .getByRole("checkbox", {
      name: /^(只读（关闭后允许文档增删改）|Read-only \(disable to allow document writes\))$/,
      exact: true,
    })
    .setChecked(readOnly);
  await page
    .getByRole("button", { name: /^(测试连接|Test connection)$/, exact: true })
    .click();
  await expect(
    page.getByText(/^(连接测试成功|Connection test succeeded)$/, {
      exact: true,
    }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/connections/save") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: /^(保存|Save)$/, exact: true })
    .press("Enter");
  const savedId = (await (await saved).json()).value.id;
  if (scoped) {
    // Seed a plugin-owned position for tests that start with a preselected scope.
    // Legacy connection-config migration is covered by backend lifecycle tests.
    const directory = resolve(pluginData, "selected-scope-v1");
    const hash = createHash("sha256")
      .update(JSON.stringify([mockURL, savedId]))
      .digest("hex");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, hash + ".json"),
      JSON.stringify({
        version: 1,
        database: "Shop",
        container: "Orders",
        revision: "fixture",
      }),
      { mode: 0o600 },
    );
  }

  await page.getByRole("button", { name, exact: true }).click();
  const frame = page.frameLocator("iframe").last();
  if (!scoped) {
    await frame.locator("#database").selectOption("Shop");
    await frame.locator("#container").selectOption("Orders");
  }
  await expect(frame.locator("#run")).toBeEnabled();
  return frame;
}
export async function query(frame) {
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#query-metrics")).toContainText("2.81 RU");
  await expect(frame.locator("#run")).toBeEnabled();
  await expect(frame.locator("#result-origin")).toHaveText("当前页");
}
