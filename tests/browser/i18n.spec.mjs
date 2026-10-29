import { capturePath, mockURL, connect, query } from "./support.mjs";
import { test, expect } from "@playwright/test";
const base = mockURL + "/test/";
test.beforeEach(async ({ page, request }) => {
  await request.get(base + "reset");
  // Capture the documented bridge channel from the child's readiness message.
  // Sending from its real parent exercises SDK locale propagation (no plugin setting).
  await page.addInitScript(() => {
    window.__pluginChannels = new Map();
    window.addEventListener("message", (event) => {
      if (event.data?.source === "dbx-plugin")
        window.__pluginChannels.set(event.source, event.data.channel);
    });
  });
});
async function locale(page, value) {
  await page.evaluate((value) => {
    for (const frame of document.querySelectorAll("iframe")) {
      const channel = window.__pluginChannels.get(frame.contentWindow);
      if (channel)
        frame.contentWindow.postMessage(
          {
            source: "dbx-host",
            version: 1,
            channel,
            type: "env",
            locale: value,
          },
          "*",
        );
    }
  }, value);
}
test("host language switches UI, JSON folds and search without losing SQL, results or a draft", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await query(f);
  await f.locator("#new").click();
  await f.locator("#document-json-view").click();
  const editor = f.locator("#editor .cm-content");
  const draft =
    '{\n  "id":"draft-only",\n  "tenant":"demo",\n  "查询参数":{"value":9223372036854775807},\n  "label":"保存"\n}';
  await editor.fill(draft);
  await f.locator("#document-more").click();
  await f.locator("#document-fold").click();
  await f.locator("#json-view").click();
  await locale(page, "en-US");
  await expect(f.locator("html")).toHaveAttribute("lang", "en");
  await expect(f.locator("#run")).toHaveText("Run query");
  await expect(f.locator("#query-parameters")).toBeHidden();
  await expect(f.locator("#document-fold")).toHaveText("Fold nested values");
  await expect(f.locator("#editor .cm-foldPlaceholder")).toContainText("field");
  await expect(f.locator("#row-count")).toHaveText("1 row");
  await expect(f.locator("#container option").first()).toHaveText(
    "Select container",
  );
  await expect(f.locator("#raw-results .cm-content")).toContainText(
    "order-001",
  );
  await f.locator("#document-more").click();
  await f.locator("#document-unfold").click();
  expect(await editor.innerText()).toBe(draft);
  await expect(editor).toHaveAttribute("aria-label", "JSON document");
  await editor.press("ControlOrMeta+z");
  expect(await editor.innerText()).not.toBe(draft);
  // CodeMirror follows the platform: Cmd+Shift+Z on macOS, Ctrl+Y on Windows.
  await editor.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  expect(await editor.innerText()).toBe(draft);
  await f.locator("#document-search").click();
  await expect(f.locator('#editor .cm-search button[name="next"]')).toHaveText(
    "Next",
  );
  await f.locator('#editor .cm-search input[name="search"]').press("Escape");
  await locale(page, "zh-CN");
  await expect(f.locator("#run")).toHaveText("运行查询");
  expect(await editor.innerText()).toBe(draft);
  await expect(f.locator("#sql .cm-content")).toHaveText("SELECT * FROM c");
  await locale(page, "ja");
  await expect(f.locator("#run")).toHaveText("Run query");
  await expect(f.getByRole("button", { name: /language|语言/i })).toHaveCount(
    0,
  );
  const state = await (await request.get(base + "state")).json();
  expect(state.writeCount).toBe(0);
  expect(state.queryRequests).toHaveLength(1);
});
test("English host errors and parameter controls remain actionable", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await locale(page, "en");
  await f.locator("#sql .cm-content").fill("SELECT * FROM c WHERE c.BAD = @id");
  await expect(f.locator("#query-parameters summary")).toHaveText(
    "Query parameters",
  );
  await f.locator("#parameters").fill("[]");
  await f.locator("#run").click();
  await expect(f.locator("#sql-error")).toBeVisible();
  await expect(f.locator("#sql-error-message")).toContainText(
    "SQL syntax error",
  );
  await expect(f.locator("#status")).toBeHidden();
  const elapsed = (await f.locator("#sql-error-meta").innerText()).split(
    " s",
  )[0];
  await page.waitForTimeout(250);
  await locale(page, "zh");
  await expect(f.locator("#sql-error-message")).toContainText("SQL 语法错误");
  await expect(f.locator("#sql-error-meta")).toContainText(elapsed + " s");
});

test("a workbench opened in an English host starts in English", async ({
  page,
}) => {
  const f = await connect(page, true, false, `English-${Date.now()}`, {
    hostLocale: "en",
  });
  await expect(f.locator("html")).toHaveAttribute("lang", "en");
  await expect(f.locator("#run")).toHaveText("Run query");
  await expect(f.locator("#mode")).toHaveText("Read-only connection");
  await expect(f.locator("#sql .cm-content")).toHaveAttribute(
    "aria-label",
    "SQL query",
  );
  await expect(f.locator("#query-parameters")).toBeHidden();
  await expect(f.locator("#query-pk")).toHaveAttribute(
    "placeholder",
    "Enter a JSON partition key or filter known keys; leave blank for cross-partition",
  );
  await f
    .locator("body")
    .screenshot({ path: capturePath("workspace-english.png") });
  for (const width of [900, 600]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await f
        .locator("body")
        .evaluate((node) => node.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await f.locator("#run").click();
  await expect(f.locator("#query-metrics")).toContainText("2.81 RU");
  await f.locator("#table .row-read").first().click();
  await expect(f.locator("#editor .cm-content")).toHaveAttribute(
    "aria-label",
    "JSON document",
  );
});

test("field errors and an open write confirmation change language without changing input or submitting writes", async ({
  page,
  request,
}) => {
  const f = await connect(page);
  await query(f);
  await f.getByRole("cell", { name: "order-001", exact: true }).dblclick();
  await f.locator("#read").click();
  const number = f.locator('.field-card[data-path="/total"] input');
  await number.fill('"bad"');
  await expect(
    f.locator(".field-error").filter({ hasText: "数值字段" }),
  ).toBeVisible();
  await locale(page, "en");
  await expect(number).toHaveValue('"bad"');
  await expect(
    f.locator(".field-error").filter({ hasText: "Number fields" }),
  ).toBeVisible();
  await number.fill("42");
  await f.locator("#save").press("Space");
  await expect(f.locator("#confirm-title")).toHaveText("Patch document?");
  await locale(page, "zh-CN");
  await expect(f.locator("#confirm-title")).toHaveText("局部更新文档？");
  await expect(f.locator("#confirm-dialog")).toBeVisible();
  await f.locator("#confirm-cancel").click();
  await expect(number).toHaveValue("42");
  expect((await (await request.get(base + "state")).json()).writeCount).toBe(0);
});
