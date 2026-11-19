# Windows 定制 DSH Desktop rc.5 适配设计

本文定义从官方 `dsh-v0.2.2-rc.5` 重建 Windows x64 定制 Desktop 的范围与验收方式。既有统一工具准入、受控 core 替换、未签名打包、同身份覆盖安装和数据保留契约继续沿用 `2026-11-18-custom-windows-desktop-core-design.md`。

## 目标

在 `feature/unified-tool-admission-rc5` 上保留原 `feature/unified-tool-admission` 的全部定制行为，同时获得 rc.4 与 rc.5 的官方修复。Desktop、`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 使用 `0.2.2-rc.5`，仅内置 `@deepseek-ai/dsh-tools` 使用从当前源码生成的 `0.2.2-rc.5.unified.1`。

## 迁移方式

以官方 rc.5 tag 为新基线，按原顺序挑入 rc.3 定制分支的 24 个提交。不应用 rc.3 到 rc.5 的全量补丁，因为该补丁会触及基线中不存在的包和测试路径。

冲突只处理官方变更与定制实现的实际交叉点。生成文件由拥有者生成器重建；定制行为、错误语义和测试不得为消除冲突而删改。

原分支与既有 rc.3 Release 保持不变。本轮只迁移、构建和验收，不创建新 Release。

## 受控 core 与基线

从迁移后的 `packages/core/tools` 重新打包 `dsh-tools-0.2.2-rc.5.unified.1.tgz`，不得重命名或复用 rc.3 tarball。sidecar 记录新文件的实际 SHA256；替换、审计、测试和文档中的版本、字节数、摘要与 tarball 名称全部以新产物为准。

覆盖安装基线固定为官方 rc.5 提交 `9c2670d3bce5275e0d1610272958121af87787bb`。`BASELINE_PACKAGING_SHA` 指向挑入后与 `89e1904d55e7f4b9560595addfecd48a088d88bc` 等价的新提交；仓库引用白名单只增加仍被文档使用的精确固定引用。

## 兼容性边界

不打包 `dsh-tool-registry` 或业务插件，不修改 appId、productName、`DSH_HOME`、profile 名或 Electron userData 路径，不引入配置迁移、重置或备份替换。

rc.5 的服务端搜索与 DeepSeek Search API 行为保持官方实现。统一工具准入继续只改变工具目录投影和准入，不改变搜索计费、模型能力或供应商配置。

## 验收

本地运行迁移涉及的核心工具与 Desktop 测试，并在最新 `build:artifacts` 后运行 `build:check`、文档检查、lint 和 `git diff --check`。

推送新分支后，以 `publish_release=false` 运行 Windows workflow。基线和定制安装包均从 rc.5 同源构建；验收必须证明安装包审计、33 项覆盖安装检查、配置/凭据/会话/插件清单保留、基线 own-tool 可执行及定制 own-tool 被拦截。

只有用户另行明确授权后才创建新的 Prerelease。
