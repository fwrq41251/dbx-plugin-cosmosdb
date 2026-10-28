import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
export async function connect(
  page,
  readOnly = false,
  scoped = false,
  name = `E2E-${Date.now()}`,
) {
  page.on("pageerror", (error) =>
    console.error("Workbench page error:", error.message),
  );
  await page.goto("http://127.0.0.1:5191");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "Account Endpoint", exact: true })
    .fill("http://127.0.0.1:18081");
  await page
    .getByRole("textbox", { name: "Account Key", exact: true })
    .fill("dGVzdC1hY2NvdW50LWtleQ==");
  await page
    .getByRole("checkbox", {
      name: "只读（关闭后允许文档增删改）",
      exact: true,
    })
    .setChecked(readOnly);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功", { exact: true })).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/connections/save") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存", exact: true }).press("Enter");
  const savedId = (await (await saved).json()).value.id;
  if (scoped) {
    // Seed a plugin-owned position for tests that start with a preselected scope.
    // Legacy connection-config migration is covered by backend lifecycle tests.
    const directory = resolve(".dbx-dev/plugin-data/selected-scope-v1");
    const hash = createHash("sha256")
      .update(JSON.stringify(["http://127.0.0.1:18081", savedId]))
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
    await frame.getByLabel("数据库", { exact: true }).selectOption("Shop");
    await frame.getByLabel("容器", { exact: true }).selectOption("Orders");
  }
  await expect(frame.locator("#run")).toBeEnabled();
  return frame;
}
export async function query(frame) {
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("2.81 RU");
}
