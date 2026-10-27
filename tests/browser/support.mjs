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
  if (scoped) {
    await page
      .getByRole("textbox", { name: "数据库 ID（可选）", exact: true })
      .fill("Shop");
    await page
      .getByRole("textbox", { name: "容器 ID（可选）", exact: true })
      .fill("Orders");
  }
  await page
    .getByRole("checkbox", {
      name: "只读（关闭后允许文档增删改）",
      exact: true,
    })
    .setChecked(readOnly);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).press("Enter");
  await page.getByRole("button", { name, exact: true }).click();
  const frame = page.frameLocator("iframe").last();
  if (!scoped) {
    await frame.getByLabel("数据库", { exact: true }).selectOption("Shop");
    await frame.getByLabel("容器", { exact: true }).selectOption("Orders");
  }
  return frame;
}
export async function query(frame) {
  await frame.getByRole("button", { name: "运行查询", exact: true }).click();
  await expect(frame.locator("#status")).toContainText("2.81 RU");
}
