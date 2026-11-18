# Windows 定制 DSH Desktop（内置统一工具准入 core）设计

本文只定义目标、边界与验收，不规定实现步骤。

## 意图

Windows 用户需要一份内置定制 core 的 Desktop：工具准入走统一管线（`@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`），其余行为与官方 0.2.2-rc.3 一致。

官方安装包把 core 以 npm tarball 闭包封进 `resources/app.asar/dsh`，用户侧没有替换入口，所以定制只能发生在构建期；运行时替换会与 `desktop-runtime.json` 的完整性记录冲突，也被排除在反目标里。

身份必须沿用官方 appId 与 productName：已安装用户的数据、单实例锁、更新通道、卸载登记项全以这两个标识为键。换身份等于要求用户在两套互不相识的应用之间搬数据，与「覆盖安装并继承原配置」直接矛盾。

## 目标

产出 Windows x64 未签名 NSIS 安装包，其内置 core 为 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，Desktop、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-desktop-host` 版本保持 `0.2.2-rc.3`。

用该安装包覆盖安装已有官方同版本 Desktop 后，原配置、会话、插件清单不变，应用可正常启动。

构建可复现：core 内容只由一份固定 tarball 决定，同一 tarball 的同一字节序列产生同一份 runtime 记录。

## 非目标

不打包 `dsh-tool-registry` 或任何业务插件。

不修改 `dsh-app-boot`，不修改第三方插件的 allow-version 兼容策略。

不做代码签名与公证、不做 macOS 与 Linux 目标、不做自动更新发布、不做 GitHub 上传。

不改 appId、productName、安装目录、`DSH_HOME` 默认值、`profiles/desktop` profile 名、Electron userData 路径。

不新增配置重置、迁移或覆盖逻辑。

## 反目标

不允许直接改最终 `resources/app.asar` 内的 `node_modules` 或打包后的 runtime 树：core 必须经 tarball → package set → override → lockfile 这条既有链路形成，否则 `desktop-runtime.json` 记录的字节与磁盘不一致。

不允许在运行时替换 core，包括首次启动下载、插件市场安装、在 profile 内覆盖 `node_modules`。

不允许为「稳妥」复制一份用户配置做迁移或备份替换。

不允许把 `.env.windows` 的任何取值写进文档、脚本、日志或提交。

不允许把 `.desktop-build` 产物、安装包、打包中间目录带进提交。

## 方案

### 同身份覆盖（已选）

沿用官方 appId 与 productName，安装包覆盖到同一安装目录，数据目录因此天然继承。

覆盖安装的 uninstaller 由 electron-builder 以 `/KEEP_APP_DATA` 路径启动，不删 Electron userData 与 `.dsh`；现有初始化只补缺失文件，不重写已有文档。

代价是定制包与官方包在同一身份上互斥：装了定制包就不再是官方包，反之亦然。这一代价被用户已明确接受。

### 独立身份并存（未选）

独立身份需要新的 appId、productName、Electron userData 目录、单实例锁、卸载登记项，并且要么另起 `DSH_HOME` 与 profile 名，要么复制现有数据过去。

它换来的是两个应用并存，而本次需求恰恰是「覆盖安装并继承原配置」，两者互斥。并存还使更新通道、卸载行为和用户认知三处分叉，收益不抵成本。仅当产品需要同时保留官方版与定制版时才值得采用。

## Windows x64 未签名 NSIS 的取舍

复用现有 `package:win:x64:unsigned` 入口，不新增打包脚本族。

NSIS 配置为 `oneClick: false`、`perMachine: false`、`allowToChangeInstallationDirectory: false`：每用户安装、安装目录固定、不可自选路径。这三项保证覆盖安装落回原目录，也是数据继承成立的前提之一。

未签名意味着没有 publisherName，首次运行出现 SmartScreen 提示，且不产生发布签名记录。本产物定位为受控环境使用的构建结果，不作为对外分发包。

未签名时 `publish` 为 `null`：构建不写发布记录，应用也不会自动拉取官方更新包。强制更新策略仍按官方逻辑执行，因为策略由构建期嵌入的 origin 决定，与 publish 记录无关。

代价是无法验证签名链与发布通路；签名、公证、自动更新发布明确不在本期。

## 构建期替换

替换点固定在 `apps/desktop/scripts/package-target.ts` 的 `pack()` 完成 dsh 家族打包之后、`prepare:packages`（即 `apps/desktop/scripts/prepare-package-set.ts`）执行之前。此时 `packedDsh` 目录里是待选闭包，尚未形成 package set，也尚未安装。

输入固定为一份 tarball 与其 SHA256：

- 路径：`/Users/leo/Development/dsh-tool-registry/.superpowers/sdd/2026-11-14-unified-tool-admission/artifacts/dsh-tools-0.2.2-rc.3.unified.2.tgz`
- SHA256：`8a03ce849d860f680fddf065b8060ddb9ebd65d2fe5ed9406abc22d7c2f095d7`

该文件已实测存在（132805 字节），SHA256 与上值一致；包内 `package.json` 声明 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，共 65 个条目，仅含 `lib/`、`locale/`、`src/` 与 `package.json`。

替换动作是：校验 SHA256，移除 `packedDsh` 内官方 `deepseek-ai-dsh-tools-0.2.2-rc.3.tgz`，写入 `deepseek-ai-dsh-tools-0.2.2-rc.3.unified.2.tgz`。命名沿用 release 打包的 `<unscoped>-<version>.tgz` 约定，与目录内其他 tarball 一致。

后续链路自动承接，无需额外改动：

- `prepare-package-set.ts` 解出包名与版本，生成 `desktop-packages.json` 记录 `{ name, version: "0.2.2-rc.3.unified.2", file, bytes, integrity: "sha512-…" }`。
- `desktopCorePackageOverrides` 为该记录生成 `file:` override，lockfile 因此指向本地 tarball 并校验 integrity。
- `prepare-dsh.ts` 把 package set 中每个包名传给 `writeDesktopRuntime`，`desktop-runtime.json` 的 `sharedPackages` 因此记录 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，`files` 记录每个 runtime 文件的 sha256。
- `parseDesktopCorePackageSet` 只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 做版本等于 `0.2.2-rc.3` 的强校验；`dsh-tools` 允许带 prerelease 前缀，`0.2.2-rc.3.unified.2` 是合法 semver。

版本不动的另一个理由在包自身：该 tarball 的 `peerDependencies` 要求 `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-scope`、`dsh-session`、`dsh-system-prompt`、`dsh-user-approval` 均为 `0.2.2-rc.3`，与官方 runtime 的其余部分正好对齐，因此只有 `dsh-tools` 一个包的版本发生变化。

## 失败即停

以下情况一律中止构建并报告，不产生安装包：

- tarball 缺失、不可读或不是普通文件。
- SHA256 与固定值不符；报告须同时给出期望值与实际值。
- `packedDsh` 内仍存在官方 `deepseek-ai-dsh-tools-0.2.2-rc.3.tgz`，即重包。现有 `prepare-package-set.ts` 对同名 tarball 本身会报 `duplicate packed package`，替换逻辑不应依赖这条兜底，而应先显式拒绝。
- 替换后的记录版本不是 `0.2.2-rc.3.unified.2`。
- `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-desktop-host` 版本不等于 `0.2.2-rc.3`（既有 `RELEASE_PACKAGES` 校验）。
- 选定的 mandatory policy origin 缺失（见「构建策略配置」）。

失败信息不得回显 `.env.windows` 的取值，只报字段名与文件路径。

## 可复现性

core 内容只由该 tarball 的字节决定，SHA256 是唯一入口守卫；tarball 内每个 runtime 文件在 `desktop-runtime.json` 的 `files` 里都有 sha256 与字节数。

两次同输入构建应在 `desktop-packages.json` 的 `integrity`、`desktop-runtime.json` 的 `sharedPackages` 与 core 相关 `files` 条目上完全一致。Electron 二进制、Node/pnpm/Python 发行版与 asar 容器本身的时间戳差异不在可复现性承诺范围内。

不通过「锁死上游版本号」实现可复现，因为 tarball 是本地构建产物而非 registry 版本；固定点是文件路径加 SHA256。

## 原配置、会话、插件保留契约

appId 与 productName 不变，因此 Electron userData 仍是 `%APPDATA%\@deepseek-ai\dsh-desktop`，其中 `desktop/settings.json`、`desktop/keybindings.json`、浏览器存储与缓存原样保留。

`DSH_HOME` 默认仍为 `%USERPROFILE%\.dsh`，Desktop 独占的 profile 仍是 `profiles/desktop`；会话、settings、credentials、`dsh.profile.bundles`、已安装插件都在此处。

现有的缺失即创建初始化保持原样，本设计不新增任何重置、迁移或覆盖分支，也不引入配置版本迁移。

覆盖安装走 `/KEEP_APP_DATA` 路径，卸载器不删除 userData 与 `.dsh`；这一点由 electron-builder 的原地更新调用方式保证，实现不得改成普通卸载路径。

插件清单 `dsh.profile.bundles` 的读写不属于本期范围。core 版本变化对插件兼容性的判断仍由既有 allow-version 策略负责。

## 插件不进包

安装包只含 core 闭包：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-desktop-host` 及其必需的本地 workspace 依赖，加上替换后的 `dsh-tools`。

包内不含 `dsh-tool-registry`，不含任何业务插件 tarball，不含 `profiles/desktop/node_modules`，不含用户数据。

这条边界靠构建输入控制而非过滤规则：`packedDsh` 只来自 dsh 家族打包，替换只动一个包名。

## 构建策略配置

未签名 Windows 构建仍要求选定 mandatory policy origin，这是 `apps/desktop/README.md` 中 Mandatory update policy 一节的既有约束，与是否签名无关。

设计只复用本机已忽略的 `apps/desktop/.env.windows`（`.gitignore` 第 3 行）：不读取并回显其值、不记录到日志、不写进提交、不硬编码新服务地址。

该文件在本 worktree 当前不存在，目录里只有 `.env.windows.example`。因此构建前置检查必须以「缺失即停止并报告」处理，不得提供默认值，也不得回退到 `.example`。

强制策略的查询、阻断、登录与下载页行为保持官方实现，本设计不做任何修改。

## 不上传、不替换真实安装

构建只产出本地 unsigned NSIS，不上传 COS 或 GitHub，不触发 updater 发布，不写发布记录。

不安装到开发机的真实用户配置上，不覆盖任何生产环境 Desktop。

全部验证在隔离 Windows 测试用户或配置副本中进行。

## 验收

构建与 manifest：

- 在 Windows x64 构建机上执行 `pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned`，得到 NSIS 安装包，构建日志无 SHA 校验失败。
- `buildPaths.packageSet` 下的 `desktop-packages.json` 含且仅含一条 `@deepseek-ai/dsh-tools` 记录，版本为 `0.2.2-rc.3.unified.2`，`integrity` 对应替换后 tarball 的 sha512。
- `buildPaths.dsh` 下的 `desktop-runtime.json` 的 `release.version` 为 `0.2.2-rc.3`，`sharedPackages` 含 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`。

安装包内容：

- 解出安装包内的 `resources/app.asar`，`dsh/node_modules/@deepseek-ai/dsh-tools/package.json` 版本为 `0.2.2-rc.3.unified.2`。
- 同一路径下不存在 `dsh-tool-registry`，不存在任何业务插件包。
- 全部 `.tgz` 输入中 `@deepseek-ai/dsh-tools` 只有一份。

覆盖安装与数据保留：

- 在隔离 Windows 测试用户中，先安装官方 `0.2.2-rc.3` 并产生可识别数据：至少一个会话、非默认设置项、一个已启用插件。
- 记录哈希清单：`%USERPROFILE%\.dsh` 下 `sessions`、settings、credentials、`profiles/desktop` 的 `package.json` 与 `dsh.profile.bundles`，以及 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop\*.json`。
- 安装定制包覆盖同一目录，再次记录同一清单，逐项哈希一致。
- 启动应用：Host 健康检查通过，上述会话可打开，插件仍处于启用状态，工具调用的准入行为体现 unified.2 语义。

测试隔离：

- 全部验证使用一次性 Windows 测试用户，或把 `DSH_HOME` 与 `DSH_DESKTOP_USER_DATA_DIR` 指向配置副本；不触碰真实用户配置。
- 测试结束删除测试用户与副本，并记录使用了哪一种隔离方式。

负向验证：

- 临时移走 tarball 执行一次构建，构建在替换点失败并给出路径，未产出安装包。
- 篡改一份 tarball 副本使 SHA256 变化，构建失败并同时报出期望值与实际值。
- 同时保留官方与定制两份 `dsh-tools` tarball，构建在替换点显式失败，报重包。

## 留给实现者

实现位置：替换逻辑放在 `package-target.ts` 的 `pack()` 与 `prepare:packages` 之间，仅对 `target.platform === 'win32'` 生效。是否扩展 macOS 不在本期决定，本期实现不得默认对 macOS 开启。

常量归属：tarball 路径与 SHA256 可以是脚本内常量或经环境变量覆盖，但本期取值必须固定，禁止从 registry、`latest` 标签或网络解析版本。

失败信息格式：须包含阶段名、期望 SHA256、实际 SHA256、文件绝对路径，且不含 `.env.windows` 取值。

校验入口：`--check` 在 `packageTarget` 之前返回，不执行 `pack()`，也不产出 package set；`--prepare-only` 会执行 `pack()` 与 `prepare:packages`，因此同样经过替换点。SHA 校验必须位于 `pack()` 之后的实际构建路径内；是否额外提供独立的预检命令由实现者判断，但不得让 `--check` 的成功被误读为「tarball 已校验」。

隔离测试的可操作性：测试用户创建与清理方式、SHA 清单脚本是否入库，由实现者决定。脚本可以不进仓库，但验收时须能复现上述三类负向场景。

文档更新：本设计不要求修改 `apps/desktop/README.md`。若实现改变了安装包内容清单或用户可见行为，再按 `docs/AGENTS.md` 的分层规则补到对应拥有者文档。

范围守卫：实现不得引入配置迁移、插件 allow-version 调整、updater 行为改动或任何上传步骤；这些属于非目标，出现即视为偏离设计。
