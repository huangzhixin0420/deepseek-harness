# Windows 定制 Desktop Core 实施计划

> **状态：** 本计划对应已交付的 rc.3 定制构建，其中的版本、tarball、字节数与提交是该轮的事实记录。rc.5 重建以 `2026-11-19-custom-windows-desktop-core-rc5.md` 及其设计为准，不要按本计划的版本与摘要执行新构建。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitHub Actions 构建并验收一份保留用户原有数据的 Windows x64 DSH Desktop 安装包，仅把内置 `@deepseek-ai/dsh-tools` 替换为 `0.2.2-rc.3.unified.2`，验收后可发布 Prerelease。

**Architecture:** 未签名 Windows 使用独立本地打包环境，不读取发布 dotenv 或强制更新策略。受控 core tarball 在 dsh 家族打包后、package set 生成前替换官方包，后续复用现有 override、lockfile 与 runtime 清单链路。同一 workflow 从官方 tag 构建基线，从当前提交构建定制包，在一次性 Windows runner 完成安装包审计与覆盖安装验收，最后按输入决定是否发布。

**Tech Stack:** TypeScript、Node.js 24、pnpm 11.28.5、Electron Builder、Vitest、PowerShell 7、GitHub Actions `windows-2022`、GitHub Release。

**Spec:** `docs/superpowers/specs/2026-11-18-custom-windows-desktop-core-design.md`

## Global Constraints

- 仅支持 Windows x64 未签名 NSIS；Desktop、dsh、Host 保持 `0.2.2-rc.3`，只有 dsh-tools 为 `0.2.2-rc.3.unified.2`。
- appId 固定 `com.deepseek.dsh`，productName 保持 `DeepSeek Harness`；`publish` 必须为 `null`，不得触发既有发布或 rollout workflow。
- 不打包 `dsh-tool-registry`、业务插件、用户数据或受控 core tarball；不修改配置、会话、凭据和插件清单。
- core 输入唯一固定点为 `apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz`，132805 字节，SHA256 `8a03ce849d860f680fddf065b8060ddb9ebd65d2fe5ed9406abc22d7c2f095d7`；期望值只从同目录 `.sha256` sidecar 读取。
- 替换只发生在 `target.platform === 'win32' && invocation.unsigned`，位置为 `pack()` 完成后、`prepare:packages` 前；不得直接修改 asar 或最终 runtime 树。
- 本机 Node 22 不作为构建依据；本地只做测试与静态检查，真实 Windows 构建和安装验收只在 GitHub Actions 一次性 runner。
- 所有提交信息使用简体中文；每个任务独立提交，审查发现由该任务原实现者修复。

## Review Focus

- 打包机已有 `.env.windows`、更新源或签名变量：未签名 Windows 仍须选择无更新源的官方 appId 本地环境；Task 1 用继承变量与缺失 dotenv 测试固定。
- tarball 是目录、不可读、字节错、sidecar 错或摘要不符：不得产生安装包；Task 2 对每个文件边界做负向测试。
- packedDsh 同时出现官方与定制 dsh-tools：必须在替换点报重包而不是依赖后续通用重复检查；Task 2 固定计数与阶段错误。
- 基线意外包含 unified 源：差分验收会失效；Task 4 固定官方 tag 和打包补丁 SHA，Task 5 同时断言基线可见可执行、定制不可见不可执行。
- 覆盖安装静默重写配置或启用状态：发布必须被阻断；Task 5 对播种前后哈希、会话、Host 和 fixture 启用状态逐项断言。

---

### Task 1: 未签名 Windows 本地打包环境

**Files:**
- Modify: `apps/desktop/scripts/desktop-package-environment.mjs`
- Modify: `apps/desktop/scripts/electron-builder-config.mjs`
- Modify: `apps/desktop/scripts/package-target.ts:341-352`
- Modify: `apps/desktop/packaging/README.md` 与 `apps/desktop/packaging/README.zh.md` 的未签名 Windows 环境段落
- Test: `apps/desktop/tests/desktop-package-environment.spec.ts`
- Test: `apps/desktop/tests/macos-signature.spec.ts`

**Interfaces:**
- Produces: `localWindowsPackageEnvironment(environment = process.env): NodeJS.ProcessEnv`，剥掉 `AMBIENT_RELEASE_SETTING`，固定 `DSH_DESKTOP_APP_ID=com.deepseek.dsh`、`DSH_DESKTOP_UNSIGNED=1`。
- Produces: 未签名 Windows 的 `validateDesktopPackageEnvironment()` 不解析 mandatory policy；`createElectronBuilderConfig()` 在任何 unsigned 目标上省略 `dshMandatoryUpdatePolicy`。
- Consumes: 后续 Task 4 把本任务最终提交 SHA 固定为 `BASELINE_PACKAGING_SHA`，用于官方 tag 的打包适配基线；本任务不得包含 core 替换逻辑或受控 tarball。

- [ ] **Step 1: 写失败测试** 在环境测试中加入“无 `.env.windows` 且继承发布变量时仍选择 Windows 本地环境”的断言：保留 `PATH`/代理，移除签名、更新与策略变量，appId 为官方值，父对象不变；`validateDesktopPackageEnvironment(..., WINDOWS, { unsigned: true })` 不抛错。在 builder 测试的 unsigned Windows 用例补充 `extraMetadata` 不含 `dshMandatoryUpdatePolicy`。
- [ ] **Step 2: 运行 RED** Run: `pnpm exec vitest run apps/desktop/tests/desktop-package-environment.spec.ts apps/desktop/tests/macos-signature.spec.ts` Expected: 新 Windows 本地环境断言因函数缺失或旧条件失败，既有测试其余行为不变。
- [ ] **Step 3: 实现最小修改** 按既有 `localMacOSPackageEnvironment()` 增加 Windows 对应函数；`main()` 对所有 unsigned 目标选择本地环境。策略校验条件改为 `!options.unsigned`，builder 的 `policy` 条件改为 `unsigned ? undefined : resolveDesktopPolicyEnvironment(env)`；signed 路径不变。
- [ ] **Step 4: 更新拥有者文档** 将未签名 Windows 的 `.env.windows` 与 mandatory origin 要求改为本地环境规则，明确官方 appId、无更新源和无需签名凭据；中英文同步，不新增 Release 操作说明。
- [ ] **Step 5: 运行 GREEN** Run: `pnpm exec vitest run apps/desktop/tests/desktop-package-environment.spec.ts apps/desktop/tests/macos-signature.spec.ts apps/desktop/tests/package-target-stages.spec.ts` Expected: 全部通过。
- [ ] **Step 6: 提交并记录 SHA** Run: `git add apps/desktop/scripts/desktop-package-environment.mjs apps/desktop/scripts/electron-builder-config.mjs apps/desktop/scripts/package-target.ts apps/desktop/tests/desktop-package-environment.spec.ts apps/desktop/tests/macos-signature.spec.ts apps/desktop/packaging/README.md apps/desktop/packaging/README.zh.md && git commit -m "feat(desktop): 支持无发布配置的 Windows 未签名打包"` Expected: 提交只含本任务文件；记录完整 SHA 供 Task 4 使用。

### Task 2: 受控 core 替换与失败即停

**Files:**
- Create: `apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz`
- Create: `apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz.sha256`
- Create: `apps/desktop/scripts/replace-windows-custom-core.ts`
- Modify: `apps/desktop/scripts/package-target.ts` 的 `packageTarget()` 编排
- Test: `apps/desktop/tests/replace-windows-custom-core.spec.ts`
- Test: `apps/desktop/tests/package-target-stages.spec.ts`

**Interfaces:**
- Produces: `replaceWindowsCustomCore({ packedDsh: string, sourceTarball: string, checksumFile: string }): { sourceSha256: string; destinationSha256: string; destination: string }`；同步执行，任何守卫失败抛 `Error`。
- Consumes: Task 1 已选择无发布配置的 Windows unsigned 环境。
- Produces: `packageTarget()` 在 Windows unsigned 的 `pack()` 内、最后一条 pack 命令成功后调用 helper；macOS 与 signed Windows 不调用。

- [ ] **Step 1: 固定受控输入** 从 `/Users/leo/Development/dsh-tool-registry/.superpowers/sdd/2026-11-14-unified-tool-admission/artifacts/dsh-tools-0.2.2-rc.3.unified.2.tgz` 复制到设计路径，sidecar 写 `8a03ce849d860f680fddf065b8060ddb9ebd65d2fe5ed9406abc22d7c2f095d7  dsh-tools-0.2.2-rc.3.unified.2.tgz`；核对 132805 字节、SHA 与 tar 内 package manifest 的版本，仓库外路径不得进入代码。
- [ ] **Step 2: 写 helper 失败与成功测试** 用临时目录和真实小 tarball fixture 覆盖：成功替换并重算摘要；源缺失、目录、不可读、字节变化、sidecar 缺失/格式错、源 SHA 错、目标 SHA 错；官方包 0/2 份、预存定制包、替换后计数不符。错误包含 `custom core` 阶段、绝对路径、计数；SHA 错误同时含 expected/actual。
- [ ] **Step 3: 写编排失败测试** 在 `package-target-stages.spec.ts` mock helper，断言 unsigned Windows 的调用发生在 pack 完成与 `run prepare:packages` 之间；helper 抛错时不执行 `prepare:packages`/`prepare:dsh`/builder；macOS 和 signed Windows 不调用。
- [ ] **Step 4: 运行 RED** Run: `pnpm exec vitest run apps/desktop/tests/replace-windows-custom-core.spec.ts apps/desktop/tests/package-target-stages.spec.ts` Expected: helper 不存在且编排未调用，测试失败。
- [ ] **Step 5: 实现 helper 与接入** 用 `node:fs`/`node:crypto` 校验普通文件、可读性、132805 字节与两段式 sidecar；只识别 `deepseek-ai-dsh-tools-0.2.2-rc.3.tgz` 和 `deepseek-ai-dsh-tools-0.2.2-rc.3.unified.2.tgz`，替换前后各恰好一份目标且另一方为零。用临时文件加原子 rename 写入并复算，不修改其他 tarball。
- [ ] **Step 6: 运行 GREEN 与真实输入检查** Run: `pnpm exec vitest run apps/desktop/tests/replace-windows-custom-core.spec.ts apps/desktop/tests/package-target-stages.spec.ts apps/desktop/tests/prepare-package-set.spec.ts && node -e "const fs=require('node:fs'),c=require('node:crypto');const p='apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz';const b=fs.readFileSync(p);if(b.length!==132805||c.createHash('sha256').update(b).digest('hex')!=='8a03ce849d860f680fddf065b8060ddb9ebd65d2fe5ed9406abc22d7c2f095d7')process.exit(1)"` Expected: 测试通过且摘要检查退出 0。

### Task 3: 构建产物审计脚本

**Files:**
- Create: `apps/desktop/scripts/verify-custom-core-package.ts`
- Test: `apps/desktop/tests/verify-custom-core-package.spec.ts`

**Interfaces:**
- Consumes: Task 2 生成的 package set、prepared dsh runtime 和 electron-builder 的 unpacked 应用。
- Produces: CLI `node --import tsx apps/desktop/scripts/verify-custom-core-package.ts --packages <desktop-packages.json> --runtime <dsh/desktop-runtime.json> --app <win-unpacked 目录>`；成功输出 JSON 摘要，失败退出非零。
- Produces: 可测试的 `verifyCustomCorePackage(options)`，选项包含上述三个绝对路径。

- [ ] **Step 1: 写审计测试** 以临时目录构造 package manifest、runtime manifest 和 unpacked `resources/app.asar` fixture，覆盖成功及：dsh-tools 记录 0/2 条、版本错、integrity 错、Desktop/dsh/Host 版本错、asar 内 core 版本错、存在 `dsh-tool-registry`/业务插件/受控 tarball/`app-update.yml`。
- [ ] **Step 2: 运行 RED** Run: `pnpm exec vitest run apps/desktop/tests/verify-custom-core-package.spec.ts` Expected: 因审计模块不存在而失败。
- [ ] **Step 3: 实现审计** 复用现有 runtime reader/verifier 和仓库已安装的 asar 读取能力，不新增依赖；从 package set 的 sha512 重新计算受控 core 输入预期 integrity，检查 `release.version=0.2.2-rc.3` 与 `sharedPackages`。asar 审计只读，列出全部匹配项后报错，不修补产物。
- [ ] **Step 4: 运行 GREEN** Run: `pnpm exec vitest run apps/desktop/tests/verify-custom-core-package.spec.ts apps/desktop/tests/runtime-manifests.spec.ts` Expected: 全部通过。

### Task 4: Windows 同源构建 workflow

**Files:**
- Create: `.github/workflows/desktop-custom-core-windows.yml`
- Create: `apps/desktop/scripts/prepare-custom-core-baseline.mjs`
- Test: `apps/desktop/tests/prepare-custom-core-baseline.spec.ts`

**Interfaces:**
- Consumes: Task 1 的完整提交 SHA；Task 2 的替换与受控输入；Task 3 的审计 CLI。
- Produces: workflow 输入 `publish_release: boolean=false`、`release_tag: string=''`；job `package` 输出定制与基线 Artifact 名及定制安装包文件名。
- Produces: `prepare-custom-core-baseline.mjs --source <官方tag checkout> --packaging-commit <SHA>` 校验官方提交为 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`，只检出 Task 1 的四个打包文件（含类型声明）到基线，并记录官方 SHA、补丁 SHA 和改动文件清单。

- [ ] **Step 1: 写基线准备测试** 在临时 Git 仓库模拟官方提交与打包补丁，断言只更新 `package-target.ts`、`desktop-package-environment.mjs`、`desktop-package-environment.d.mts`、`electron-builder-config.mjs`，core 源保持官方；错误 SHA、额外 diff、脏工作树均失败。
- [ ] **Step 2: 运行 RED 并实现** Run: `pnpm exec vitest run apps/desktop/tests/prepare-custom-core-baseline.spec.ts` Expected: 先失败；实现后重跑通过。
- [ ] **Step 3: 编写 package job** 全部使用 `windows-2022`、原生 `pwsh`、`actions/checkout@v7.0.1`、`actions/setup-node@v7.0.0` Node 24、`pnpm/action-setup@v5.0.0`，`permissions: contents: read`，并发组 `desktop-custom-core-windows` 且不取消进行中的运行。先 checkout 官方 tag 到 `baseline` 并运行基线准备脚本，再分别 `pnpm install --frozen-lockfile` 和 `pnpm run package:desktop:win:x64:unsigned` 构建 baseline/custom。
- [ ] **Step 4: 接入审计与 Artifact** 对定制包执行 Task 3 CLI，收集两份 NSIS 与 SHA256；`actions/upload-artifact@v7.0.1` 使用 `if-no-files-found: error`、固定 7 天保留。Artifact 只含验收所需安装包、摘要和审计报告，不含打包中间目录。
- [ ] **Step 5: 静态验收并提交** Run: `pnpm exec vitest run apps/desktop/tests/prepare-custom-core-baseline.spec.ts apps/desktop/tests/verify-custom-core-package.spec.ts && git diff --check` Expected: 通过；workflow 尚无 release job，不能发布。

### Task 5: 隔离覆盖安装验收与 Prerelease

**Files:**
- Create: `apps/desktop/scripts/accept-custom-core-windows.ps1`
- Create: `apps/desktop/scripts/fixtures/unified-own-tool-plugin/` 下最小 fixture manifest、入口与调用脚本
- Modify: `.github/workflows/desktop-custom-core-windows.yml`
- Test: `apps/desktop/tests/custom-core-workflow.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 baseline/custom Artifact 与文件名输出。
- Produces: 验收脚本参数 `-BaselineInstaller <path> -CustomInstaller <path> -Report <path>`；报告记录安装包 SHA、fixture SHA、数据哈希对比、Host/会话/插件检查与 own-tool 差分结果。
- Produces: workflow `acceptance` job 依赖 `package`；`release` job 依赖两者且仅 `publish_release == true` 时运行，只有它有 `contents: write`。

- [ ] **Step 1: 写 workflow 静态回归** 解析 YAML 并断言三个 job 串行、runner/权限/输入默认值、release 条件、无 `desktop-publish`/`desktop-rollout`/COS 步骤、发布资产为已验收 custom NSIS 与 `.sha256`，且 prerelease 为 true。用仓库现有 YAML 解析依赖，不新增依赖。
- [ ] **Step 2: 运行 RED** Run: `pnpm exec vitest run apps/desktop/tests/custom-core-workflow.spec.ts` Expected: 缺 acceptance/release 或条件不符而失败。
- [ ] **Step 3: 实现 fixture 与验收脚本** fixture 只由 workflow 复制到 runner 的隔离 `%USERPROFILE%\.dsh\profiles\desktop` 插件目录，不进入产品包。插件注册 `fixture_unified_own_tool`，并调用 `ctx.tools.restrict({ allow: ['<一个现有合法继承工具名>'], includeOwn: true })`；复用 core 现有 activation/scoped 测试的合法工具名与调用方式，不断言未知工具错误。
- [ ] **Step 4: 播种并验证覆盖安装** 基线 `/S` 安装后启动并创建可识别会话、非默认 Desktop JSON 设置、credentials 占位和启用 fixture；记录设计列出的 `.dsh` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop\*.json` 哈希。断言基线目录投影包含且可执行 own 工具后关闭应用，再 `/S` 覆盖安装定制包；逐项哈希一致，Host 健康、会话可打开、fixture 仍启用，定制目录投影不含且执行被拒绝。所有进程在 finally 中只终止本脚本启动的实例。
- [ ] **Step 5: 接入 acceptance 与 release** acceptance 下载同一 run Artifact、执行脚本、上传报告，任一检查失败即失败。release 校验 `release_tag` 非空且为安全 tag，使用同一 Artifact 的 custom NSIS 与 SHA256 创建 prerelease；正文写未签名 SmartScreen「更多信息 → 仍要运行」、同身份覆盖和配置保留验收结果，不附 baseline，不附 Actions Artifact 链接。
- [ ] **Step 6: 本地验证并提交** Run: `pnpm exec vitest run apps/desktop/tests/custom-core-workflow.spec.ts apps/desktop/tests/prepare-custom-core-baseline.spec.ts apps/desktop/tests/verify-custom-core-package.spec.ts && pnpm run build:artifacts && pnpm run build:check && pnpm run test:docs && git diff --check` Expected: 全部通过；不在本机执行安装验收，不声称 Windows 验收已通过。

### Task 6: 全分支审查、CI 验收与发布

**Files:**
- Modify: 仅审查发现所涉及的既有任务文件
- No product files: CI 与 Release 只使用已提交产物

**Interfaces:**
- Consumes: Tasks 1-5 的提交、workflow 与全部本地检查。
- Produces: 可追溯的 CI run、验收报告、commit SHA、Prerelease URL 与安装包 SHA256。

- [ ] **Step 1: 独立审查** 派未参与实现的 reviewer 对照设计检查完整 diff，重点核对数据保留、仅 Windows unsigned 生效、基线确为官方 core、Release 不可绕过验收；发现由对应原实现者修复并回归。
- [ ] **Step 2: 推送并运行默认 CI** 推送 `feature/unified-tool-admission`，以 `publish_release=false` 触发 workflow；不得同时请求 Release。记录 run URL，失败则修复后重新运行，不使用生产环境验证。
- [ ] **Step 3: 核对真实验收证据** 确认 package/acceptance 全绿，下载报告与安装包，核对报告中的基线/定制 SHA、数据哈希、Host、会话、fixture 状态、own-tool 差分和安装包审计。任何未执行项都视为未通过。
- [ ] **Step 4: 创建 Prerelease** 本地检查与默认 CI 全过后，以明确 `release_tag` 和 `publish_release=true` 重跑同一 workflow；成功后核对 Release 为 prerelease、资产仅 custom NSIS 与 SHA256，下载 Release 资产并复算 SHA 与验收 Artifact 一致。
- [ ] **Step 5: 最终交付** 报告 commit、两次 CI run、Release 下载链接、SHA256、配置保留与 unified.2 行为验收结果；若发布步骤未执行或失败，明确区分「构建验收通过」与「已发布」。
