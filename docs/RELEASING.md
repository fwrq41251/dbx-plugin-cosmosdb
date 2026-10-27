# 发布与商店审核

正式身份：`io.github.fwrq41251.cosmosdb`，发布者 `fwrq41251`。首个商店候选版本为 `0.8.0`，发布目标仅为 `darwin-arm64`。其他系统和 CPU 尚不声明为商店支持目标。

## 源码与候选包

1. 更新 Manifest、前端包版本、后端 protocol 元信息以及变更记录，完成模型、浏览器、Go 与实际打包后端验证。
2. 提交源码并确认对应提交的 CI 通过。创建不可移动的版本 tag，例如 `v0.8.0`。
3. 发布对应 GitHub Release。`.github/workflows/plugin-release.yml` 使用固定的官方 reusable workflow，在 macOS ARM64 runner 构建当前 tag。
4. Workflow 上传未签名 `.dbxp` 和 `release-candidates.json`。候选元数据包含目标平台、下载 URL、SHA-256 与大小。已提交审核或发布的版本不覆盖文件；任何内容变化都发布新版本。
5. `.dbx-store.json` 维护商店名称、简介、本地化、图标与许可证，不包含密钥。

源码仓库 Release 中的包是审核候选包。用户若不想启用未签名开发包，应等待官方商店审核签名后的安装入口。

## DBX Store 提交

首次 PR 向 `t8y2/dbx-store:main` 提交：

- `publishers/fwrq41251.json`：作者归属，初始状态为 `unverified`。
- `candidates/io.github.fwrq41251.cosmosdb.json`：从对应 Release 提取的未签名候选元数据。
- `automation/plugin-sources.json`：注册此公开仓库并启用 `autoUpdate`，后续 Release 可由商店自动生成更新 PR。

不手动编辑生成的 `plugins/`、`catalog/` 文件，不提交二进制安装包，也不生成或保存官方签名私钥。商店维护者审核后签名，并在同一个 PR 上生成正式目录，再合并上架。`open candidate(s) awaiting DBX Store signing` 是尚待签名阶段的预期检查结果。

## 本机开发身份迁移

`0.7.1` 及更早开发版使用 `io.local.cosmosdb` / `publisher: local`。正式版是新的插件身份，不会自动接管旧身份的连接。

本次本机迁移先安装正式身份候选包，在 DBX 退出后备份连接元数据，再将目标连接的 `plugin_id` 与 `plugin_connection_provider` 改为正式身份。连接 id、数据库/容器范围、只读设置以及 Secret Store 的加密凭据记录保持不变；重开后通过读取验证。此操作仅用于本机发布准备，不是插件运行时功能，安装包不会修改 DBX 的内部配置数据库。

其他开发版用户可通过 DBX 新建正式版连接并复制连接设置；正式商店身份发布后保持稳定，避免再次迁移。

## 审核说明

详见 [运行行为与数据访问](SECURITY.md)。截图和测试使用模拟文档；不发布账号密钥、真实账号地址或业务文档。

参考：[DBX Store 贡献指南](https://github.com/t8y2/dbx-store/blob/main/CONTRIBUTING.md)。
