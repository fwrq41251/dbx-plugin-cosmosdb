import { test, expect } from "@playwright/test";
import { connect, query, hostURL, mockURL } from "./support.mjs";

// The pinned CLI dev host predates native New Query contexts. Exercise the
// production plugin + shared Go sidecar using two independent host pages,
// injecting only the documented native-tab context at the frame boundary.
async function contextFor(page, workbenchId, extra = {}) {
  await page.route("**/api/frame-document", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.value.context = { ...body.value.context, workbenchId, ...extra };
    await route.fulfill({ response, json: body });
  });
}
async function sql(page, frame, text) {
  const editor = frame.locator("#sql .cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}
async function selectContainer(frame, name) {
  await frame.locator("#scope-container").click();
  await frame.locator("#scope-options").getByRole("option", { name, exact: true }).press("Enter");
  await expect(frame.locator("#scope-container")).toHaveText(name);
  await expect(frame.locator("#run")).toBeEnabled();
}
const state = async (request) => (await request.get(mockURL + "/test/state")).json();

test("same connection workbenches keep inputs, scopes, results and drafts independent and restore without executing", async ({ page, context, request }) => {
  await request.get(mockURL + "/test/reset");
  const name = `Parallel workspaces ${Date.now()}`;
  await contextFor(page, "workspace-a");
  let a = await connect(page, false, true, name);
  await a.locator("#query-pk").fill('["demo"]');
  await query(a);
  await a.getByRole("button", { name: "读取第 1 行完整文档", exact: true }).click();
  await a.getByLabel("字段 /status", { exact: true }).fill("draft-in-first-tab");
  await sql(page, a, "SELECT c.id FROM c WHERE c.id = @id");
  await a.locator("#parameters").fill('[{"name":"@id","value":9223372036854775807}]');

  const other = await context.newPage();
  await contextFor(other, "workspace-b", { newQuery: true, sourceWorkbenchId: "workspace-a" });
  await other.goto(hostURL);
  await other.getByRole("button", { name, exact: true }).click();
  let b = other.frameLocator("iframe").last();
  await expect(b.locator("#run")).toBeEnabled();
  await expect(b.locator("#scope-container")).toHaveText("Orders");
  await expect(b.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await expect(b.locator("#query-pk")).toHaveValue("");
  await expect(b.locator("#parameters")).toHaveValue("[]");
  expect((await state(request)).queryCalls).toBe(1);
  await selectContainer(b, "Archive");
  await sql(other, b, "SELECT VALUE c.id FROM c");
  await b.locator("#query-pk").fill('["archive"]');

  // Simulate a third native New Query while another tab has changed the
  // connection default. The active source's container must win.
  const third = await context.newPage();
  await contextFor(third, "workspace-c", { newQuery: true, sourceWorkbenchId: "workspace-a" });
  await third.goto(hostURL);
  await third.getByRole("button", { name, exact: true }).click();
  const c = third.frameLocator("iframe").last();
  await expect(c.locator("#run")).toBeEnabled();
  await expect(c.locator("#scope-container")).toHaveText("Orders");
  await expect(c.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await expect(a.locator("#scope-container")).toHaveText("Orders");
  await expect(a.locator("#table")).toContainText("order-001");
  await expect(a.getByLabel("字段 /status", { exact: true })).toHaveValue("draft-in-first-tab");
  await expect(a.locator("#query-metrics")).toContainText("2.81 RU");
  await expect(a.locator("#query-pk")).toHaveValue('["demo"]');
  await expect(a.locator("#parameters")).toHaveValue('[{"name":"@id","value":9223372036854775807}]');

  // Reopening a persisted tab restores its own input/location, never those
  // of the source/default. Results and drafts intentionally stay memory-only.
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  a = page.frameLocator("iframe").last();
  await expect(a.locator("#run")).toBeEnabled();
  await expect(a.locator("#scope-container")).toHaveText("Orders");
  await expect(a.locator("#sql .cm-content")).toHaveText("SELECT c.id FROM c WHERE c.id = @id");
  await expect(a.locator("#query-pk")).toHaveValue('["demo"]');
  await other.reload();
  await other.getByRole("button", { name, exact: true }).click();
  b = other.frameLocator("iframe").last();
  await expect(b.locator("#run")).toBeEnabled();
  await expect(b.locator("#scope-container")).toHaveText("Archive");
  await expect(b.locator("#sql .cm-content")).toHaveText("SELECT VALUE c.id FROM c");
  await expect(b.locator("#query-pk")).toHaveValue('["archive"]');
  expect((await state(request)).queryCalls).toBe(1);
  expect((await state(request)).writeCount).toBe(0);
});
