# 发布与商店审核

正式身份：`io.github.fwrq41251.cosmosdb`，发布者 `fwrq41251`。首个商店版本 `0.8.0` 已于 2026-10-28（日本时间）通过 [PR #384](https://github.com/t8y2/dbx-store/pull/384) 合并上架，发布目标仅为 `darwin-arm64`。0.26.0 起追加 `windows-x64` 构建目标；Windows ARM64 暂不在本轮范围。新增目标需随正式候选包提交审核，不能在上架前称为商店已支持。

## 0.24.0 准备状态

0.24.0 发布准备时，商店目录的 `latestVersion` 为 `0.16.0`（[PR #397](https://github.com/t8y2/dbx-store/pull/397) 已合并），当时源码最新已验证功能提交为 `c4e5589`。0.24.0 已在本机安装并验证，发布说明见 [0.24.0](releases/0.24.0.md)。版本兼容目标仍为 DBX 0.6.59+ / macOS ARM64，插件身份及四个只读 MCP 工具不变。

发布准备可以先创建 GitHub Release 草稿，目标固定到完成文档准备的提交。草稿尚不公开，不触发 release workflow；正式发布后才由固定的官方 workflow 构建并上传候选包和 `release-candidates.json`。不提前把本地包作为正式候选资产上传，避免与 CI 重建结果混淆。发布后核对 workflow、下载产物的哈希/大小和协议，再检查自动创建的商店更新 PR。商店审核签名及合并仍由维护者完成。

## 源码与候选包

1. 更新 Manifest、前端包版本、后端 protocol 元信息以及变更记录，完成模型、浏览器、Go 与实际打包后端验证。
2. 提交源码并确认对应提交的 CI 通过。创建不可移动的版本 tag，例如 `v0.8.0`。
3. 发布对应 GitHub Release。`.github/workflows/plugin-release.yml` 使用固定的官方 reusable workflow，在 macOS ARM64 和 Windows x64 runner 分别原生构建当前 tag，并运行 `npm run verify:package` 校验该平台的后端协议和持久化。
4. Workflow 上传未签名 `.dbxp` 和 `release-candidates.json`。候选元数据包含目标平台、下载 URL、SHA-256 与大小。已提交审核或发布的版本不覆盖文件；任何内容变化都发布新版本。
5. `.dbx-store.json` 维护商店名称、简介、本地化、图标与许可证，不包含密钥。

源码仓库 Release 中的包是审核候选包。普通用户应从 DBX 官方商店安装签名包，无需启用未签名开发包。

仓库已注册自动同步。后续发布 Release 后，商店同步任务会创建更新 PR，仍需维护者审核签名并合并，不会立即自动上架。签名会改变包的 SHA-256 和大小，验证正式包时使用商店目录的元数据，不能使用未签名候选包的哈希。

本机验证正式包时，先关闭插件连接，再安装商店签名包并重新打开原连接；验证容器范围、只读设置和小范围查询。`scripts/verify-package.py` 可检查签名包的文件校验和及本地模拟服务握手；签名的密码学验证由 DBX 安装流程执行。

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

## 0.26.0 Windows 发布准备

- 发布矩阵新增 `windows-2022 / windows-x64`，保留 `macos-15 / darwin-arm64`；继续使用已固定的官方 reusable workflow 和 plugin CLI 0.1.9。CLI 在各自原生 runner 自动生成带平台路径的 manifest，Windows 后端附加 `.exe`，不手工改写源 manifest。
- `npm run verify:package` 定位当前版本和原生目标的包，Windows 调用 `python`，macOS/Linux 调用 `python3`。校验 SHA-256、包内文件和许可证、平台/可执行入口、protocol v1、连接生命周期，以及两个工作台的精确输入保存、覆盖写入、位置隔离。仅使用临时目录和回环模拟服务。
- CI 分别在 Linux 和 Windows 执行完整模型/Go race/vet/Chromium 浏览器测试。Windows CI 的协议和浏览器验证不代表 Windows 原生 DBX/WebView2 实机验证；本轮按用户要求跳过实机测试，发布说明必须保留这一限制。
- 本轮没有发布 Release 或更新商店。当前多查询标签仍取决于 DBX 上游 [PR #13866](https://github.com/t8y2/dbx/pull/13866) 合并和发布，与 Windows 构建能力独立。

Windows 开发宿主通过仓库内启动适配器将固定 CLI 的 verbatim 路径转成普通 Win32 路径，继续调用官方 runtime。该适配仅用于 `dev`，不进入插件包，也不改变 package/release 路径。
