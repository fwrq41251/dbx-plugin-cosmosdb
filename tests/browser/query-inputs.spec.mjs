import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, query, mockURL, pluginData } from "./support.mjs";
async function setSQL(page, f, text) {
  const editor = f.locator("#sql .cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  expect(await editor.innerText()).toBe(text);
}
const snapshot = async (request) =>
  (await request.get(mockURL + "/test/state")).json();
const records = async () => {
  const directory = join(pluginData, "query-input-v1");
  try {
    return await Promise.all(
      (await readdir(directory))
        .filter((n) => n.endsWith(".json"))
        .map(async (n) =>
          JSON.parse(await readFile(join(directory, n), "utf8")),
        ),
    );
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
const selectContainer = async (f, name) => {
  await f.locator("#scope-container").click();
  await f
    .locator("#scope-options")
    .getByRole("option", { name, exact: true })
    .press("Enter");
  await expect(f.locator("#scope-container")).toHaveText(name);
  await expect(f.locator("#run")).toBeEnabled();
};
test.beforeEach(async ({ request }) => {
  await request.get(mockURL + "/test/reset");
});

test("saved query input survives reopening verbatim, stays idle, and reset persists defaults", async ({
  page,
  request,
}) => {
  const name = `Restore input ${Date.now()}`;
  let f = await connect(page, true, true, name);
  const sql = "  SELECT * FROM c\nWHERE c.id = @id ";
  const parameters = '[{"name":"@id","value":9223372036854775807}]';
  await setSQL(page, f, sql);
  await f.locator("#query-pk").fill('["unfinished');
  await f.locator("#parameters").fill(parameters);
  await f.locator("#page-size").selectOption("250");
  await expect
    .poll(async () =>
      (await records()).some(
        (r) =>
          r.input.sql === sql &&
          r.input.pageSize === 250 &&
          r.input.parametersText === parameters,
      ),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  f = page.frameLocator("iframe").last();
  await expect(f.locator("#run")).toBeEnabled();
  expect(await f.locator("#sql .cm-content").innerText()).toBe(sql);
  await expect(f.locator("#query-pk")).toHaveValue('["unfinished');
  await expect(f.locator("#parameters")).toHaveValue(parameters);
  await expect(f.locator("#page-size")).toHaveValue("250");
  expect((await snapshot(request)).queryCalls).toBe(0);
  await f.locator("#query-actions").press("ArrowDown");
  await f.locator("#reset-query").press("Enter");
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await expect(f.locator("#query-pk")).toHaveValue("");
  await expect(f.locator("#parameters")).toHaveValue("[]");
  await expect(f.locator("#page-size")).toHaveValue("100");
  await expect(f.locator("#query-parameters")).toBeHidden();
  await expect
    .poll(async () => (await records()).some((r) => r.input.sql === sql))
    .toBe(false);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  f = page.frameLocator("iframe").last();
  await expect(f.locator("#run")).toBeEnabled();
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  expect((await snapshot(request)).queryCalls).toBe(0);
});

test("containers and connections restore their own input including programmatic partition selection", async ({
  page,
  request,
}) => {
  let f = await connect(page, false, true, `Scope input ${Date.now()}`);
  await f.locator("#sql .cm-content").click();
  await f.locator("#sql .cm-content").press("ControlOrMeta+a");
  await f
    .locator("#sql .cm-content")
    .pressSequentially("SELECT c.id FROM c WHERE ");
  expect(await f.locator("#sql .cm-content").innerText()).toBe(
    "SELECT c.id FROM c WHERE ",
  );
  await f.locator("#query-pk-choose").click();
  await f
    .locator("#pk-options")
    .getByRole("option", { name: 'demo ["demo"]', exact: true })
    .click();
  await selectContainer(f, "Archive");
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await expect(f.locator("#query-pk")).toHaveValue("");
  await setSQL(page, f, "SELECT VALUE c.id FROM c");
  await f.locator("#query-pk").fill('["archive"]');
  await selectContainer(f, "Orders");
  expect(await f.locator("#sql .cm-content").innerText()).toBe(
    "SELECT c.id FROM c WHERE ",
  );
  await expect(f.locator("#query-pk")).toHaveValue('["demo"]');
  await f.locator("#query-pk-choose").click();
  await f.locator("#pk-clear").click();
  await selectContainer(f, "Archive");
  await selectContainer(f, "Orders");
  await expect(f.locator("#query-pk")).toHaveValue("");
  await selectContainer(f, "Archive");
  await expect(f.locator("#sql .cm-content")).toHaveText(
    "SELECT VALUE c.id FROM c",
  );
  await expect(f.locator("#query-pk")).toHaveValue('["archive"]');
  f = await connect(page, true, true, `Isolated input ${Date.now()}`);
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await expect(f.locator("#query-pk")).toHaveValue("");
  expect((await snapshot(request)).queryCalls).toBe(0);
});

test("failed input storage retains editable text and container-local memory", async ({
  page,
}) => {
  const f = await connect(page, true, true);
  await page.route("**/api/bridge", (route) => {
    const body = route.request().postDataJSON();
    if (
      body.params?.method === "cosmos/queryInput" &&
      body.params?.params?.queryInput
    )
      return route.fulfill({
        status: 500,
        json: { error: { message: "storage unavailable" } },
      });
    return route.continue();
  });
  await setSQL(page, f, "SELECT unfinished");
  await expect(f.locator("#status")).toContainText("查询输入保存失败");
  await selectContainer(f, "Archive");
  await selectContainer(f, "Orders");
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT unfinished");
  await expect(f.locator("#run")).toBeEnabled();
});

test("reset changes only query input and retains results and an unsaved document", async ({
  page,
}) => {
  const f = await connect(page, false, true);
  await f.locator("#query-pk").fill('["demo"]');
  await query(f);
  await f
    .getByRole("button", { name: "读取第 1 行完整文档", exact: true })
    .click();
  await f.getByLabel("字段 /status", { exact: true }).fill("keep-my-draft");
  await setSQL(page, f, "SELECT c.id FROM c");
  await f.locator("#query-actions").press("ArrowDown");
  await f.locator("#reset-query").press("Enter");
  await expect(f.getByLabel("字段 /status", { exact: true })).toHaveValue(
    "keep-my-draft",
  );
  await expect(f.locator("#document-state")).toHaveText("未保存");
  await expect(f.locator("#result-origin")).toHaveText("查询条件已修改");
  await expect(f.locator("#query-metrics")).toContainText("2.81 RU");
});
