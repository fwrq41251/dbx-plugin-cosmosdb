# 多语言维护

产品目前只注册简体中文和英文，跟随 DBX 的 locale / env 通知，不提供独立设置。未支持的语言回退英文；中文区域变体通过 `zh` 别名映射到简体中文。

## 新增语言

1. 复制 `src/locales/en.json` 为新的词典，例如 `src/locales/ja.json`。保留所有消息键，只翻译值，保留 `{0}` 等占位符。复数消息使用 `one` / `other` 等 CLDR 类别，并始终提供 `other`。
2. 在 `src/locales/index.mjs` 导入词典并注册：

```js
import ja from "./ja.json" with { type: "json" };
// Add to locales:
ja: { messages: ja, aliases: [], pluralLocale: "ja" }
```

3. 运行 `npm run build`、`npm test`、`npm run test:browser`，检查目标语言的长度、折叠摘要、确认弹窗和编辑器。目标语言也需要能由 DBX 提供，插件本身不增加语言选择入口。

连接表单使用同一词典中的 `connection.*` 和 `plugin.description`。构建时自动生成 manifest 的默认显示文字及 `localizations`，无需再手工维护一套表单翻译。manifest 的 ID、字段键、权限、默认值和其他结构仍在 `manifest.json` 维护。

## 编写消息

- `t("query.run")`：立即格式化，适用于文本/属性绑定的渲染回调。
- `msg("document.save")`（`message` 的导入别名）：保留明确的消息身份，用于状态、确认框、折叠摘要及跨异步调用保存的文字。需要显示时使用 `renderMessage` 或字符串转换，不依赖已渲染文字反查，也没有消息文本缓存。
- `new LocalizedError(msg("errors.arrayRequired", () => [label]))`：保留错误的消息身份。`.message` 始终返回当前语言字符串。
- 动态参数必须保留原始数据。不要把字段名、文档值或 SQL 当作消息键；只有 UI 文字使用消息 API。
- 已完成操作的耗时等快照应先计算，再传入消息参数；不要在重新渲染时重新计时。

静态 HTML 通过 `data-i18n-text` 标注直接文本节点，通过 `data-i18n-title`、`data-i18n-aria-label`、`data-i18n-placeholder` 标注属性。这里使用稳定消息键，不扫描中文，也不扫描运行时插入的数据。

后端通过 `reasonError(reason, legacyText)` / `rpcReason(code, reason, legacyText)` 显式标注原因；已发布原因标识不随文案修改。`src/service-reasons.json` 将原因映射到词典键，UI 优先读取 RPC data 中的 `reason` / `args`。参数只放脱敏的展示信息（例如 SQL 字符偏移），不包含 SQL、密钥或文档值。缓存和范围警告分别增加 `cacheWarningDetail` / `scopeWarningDetail`，保留旧字符串字段；MCP 失败结果同样增加原因字段。新增原因时同步映射和全部词典。

`src/legacy-service-messages.json` 仅用于旧后端/丢弃 RPC data 的宿主兼容，独立于词典。修改 UI 文案不修改该表。未知原因或外部 SDK / 文件系统错误显示原文，不依靠文字猜测新原因。

测试自动检查全部注册词典的键、占位符、复数兜底、源代码与静态 HTML 引用，以及生成的 manifest。测试使用额外的内存词典证明扩展能力，不会在产品中启用第三种语言。

本机当前 DBX 修改宿主语言时会重新载入插件工作台；原地处理 env 通知可以保留草稿与撤销历史，但不代表跨宿主重建恢复。修改宿主语言前应保存草稿。
