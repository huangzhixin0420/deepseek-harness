# Windows 定制 Desktop Core rc.5 适配计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有 Windows x64 定制 Desktop 从官方 rc.3 迁移到 rc.5，重新生成统一工具准入 core，并完成真实 Windows 覆盖安装验收。

**Architecture:** 以官方 rc.5 为基线顺序挑入原 24 个定制提交，保留 rc.5 官方行为。迁移后重新打包 `@deepseek-ai/dsh-tools@0.2.2-rc.5.unified.1`，更新受控输入、基线提交和全部固定引用；原 workflow 继续负责同源 Windows 构建与隔离验收。

**Tech Stack:** TypeScript、Node.js 24、pnpm、Electron Builder、Vitest、PowerShell 7、GitHub Actions `windows-2022`。

**Spec:** `docs/superpowers/specs/2026-11-19-custom-windows-desktop-core-rc5-design.md`

## Global Constraints

- 保留原分支与 rc.3 Release；只在 `feature/unified-tool-admission-rc5` 工作。
- 新 core 必须来自迁移后的 rc.5 源码，禁止复用或改名 rc.3 tarball。
- 不打包业务插件，不修改用户数据路径，不发布更新通道，不在本轮创建 Release。
- 本机 Node 22 仅用于测试和静态检查；Windows 构建与安装验收由 Node 24 的 GitHub Actions 执行。

### Task 1: 迁移定制历史

- [x] 从 `dsh-v0.2.2-rc.5` 确认工作树干净并提交本设计与计划。
- [x] 顺序 cherry-pick `39163dd30f703a79079e2d2446545cff3c453738..4adb11d8b66447e82787edb3b31c7695ee9d91d7`。
- [x] 解决真实交叉冲突；生成文件由生成器重建，不手工拼接。
- [x] 对照原分支确认 24 个定制提交均有等价提交，rc.5 官方搜索改动保持存在。

### Task 2: 重建受控 core 与固定引用

- [x] 把定制包版本设为 `0.2.2-rc.5.unified.1`，重新构建并打包 `dsh-tools`。
- [x] 替换 `apps/desktop/resources/custom-core` 中旧 tarball 与 sidecar，记录实测字节数和 SHA256（133050 字节，`bcbcc79882b06b01fbd180a507dc613d2a50d95f3065bddf8dff6b01b487328b`）。
- [x] 将所有 rc.3 定制版本、tarball 名、摘要、官方基线 SHA 更新为 rc.5 对应值。
- [x] 将 `BASELINE_PACKAGING_SHA` 更新为迁移后的等价提交，并核对精确引用白名单。
- [x] 运行受控替换、基线准备、产物审计和 workflow 静态测试。

### Task 3: 本地验证与推送

- [ ] 运行核心工具和 Desktop 相关测试，检查 rc.5 官方搜索测试未被削弱。
- [ ] 运行 `pnpm run build:artifacts`，随后运行 `pnpm run build:check`。
- [ ] 运行文档检查、lint 与 `git diff --check`，审查完整 diff 和工作树状态。
- [ ] 推送 `feature/unified-tool-admission-rc5`，不创建 Release。

### Task 4: Windows 构建与覆盖安装验收

- [ ] 以 `publish_release=false` 对新分支运行 `desktop-custom-core-windows.yml`。
- [ ] 确认 package 与 acceptance 全绿，核对安装包审计报告和实际 SHA256。
- [ ] 核对 33 项验收、原配置/凭据/会话/插件清单保留，以及基线/定制 own-tool 差分。
- [ ] 报告分支、提交、CI run 和验收结果，明确本轮未发布。
