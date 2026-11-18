# Windows 定制 DSH Desktop（内置统一工具准入 core）设计

本文定义目标、边界、构建与分发方式、验收标准，不规定实现步骤。

## 意图

Windows 用户需要一份下载即可安装的 Desktop，其内置 core 的工具准入走统一管线（`@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`），其余行为与官方 0.2.2-rc.3 一致。

官方安装包把 core 以 npm tarball 闭包封进 `resources/app.asar/dsh`，用户侧没有替换入口，所以定制只能发生在构建期；运行时替换会与 `desktop-runtime.json` 的完整性记录冲突，也被排除在反目标里。

身份必须沿用官方 appId 与 productName：已安装用户的数据、单实例锁、更新通道、卸载登记项全以这两个标识为键。换身份等于要求用户在两套互不相识的应用之间搬数据，与「覆盖安装并继承原配置」直接矛盾。

构建与验收发生在 GitHub Actions 的 `windows-2022` x64 runner，验收通过后由同一 workflow 创建 GitHub Release 分发 NSIS 安装包。用户只做下载与安装，不需要本地构建，也不需要手工投递任何二进制。

## 目标

产出 Windows x64 未签名 NSIS 安装包，其内置 core 为 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，Desktop、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-desktop-host` 版本保持 `0.2.2-rc.3`。

构建、产物校验与覆盖安装验收在同一 GitHub Actions workflow 内完成：`windows-2022` x64 runner，`workflow_dispatch` 手动触发。

验收通过后由同一 workflow 创建 GitHub Release，默认 prerelease，附 SHA256，正文标注未签名与 SmartScreen 提示。

用该安装包覆盖安装已有官方同版本 Desktop 后，原配置、会话、插件清单不变，应用可正常启动。

构建可复现：core 内容只由一份固定 tarball 的字节决定，同一字节序列产生同一份 runtime 记录。

## 非目标

不打包 `dsh-tool-registry` 或任何业务插件。

不修改 `dsh-app-boot`，不修改第三方插件的 allow-version 兼容策略。

不做代码签名与公证、不做 macOS 与 Linux 目标。

不做自动更新通道发布：`publish` 为 `null`，产物不含更新源，也不写更新发布记录。

不改 appId、productName、安装目录、`DSH_HOME` 默认值、`profiles/desktop` profile 名、Electron userData 路径。

不新增配置重置、迁移或覆盖逻辑。

不在现有 ARM64 UTM VM 或本机上做发布构建。

GitHub Actions Artifact 只作本轮验收的暂存，不作公开下载入口。

## 反目标

不允许直接改最终 `resources/app.asar` 内的 `node_modules` 或打包后的 runtime 树：core 必须经 tarball → package set → override → lockfile 这条既有链路形成，否则 `desktop-runtime.json` 记录的字节与磁盘不一致。

不允许在运行时替换 core，包括首次启动下载、插件市场安装、在 profile 内覆盖 `node_modules`。

不允许为「稳妥」复制一份用户配置做迁移或备份替换。

不允许把 `.desktop-build` 产物、安装包或打包中间目录带进提交；受控 core tarball 是源输入，也是唯一入库的打包二进制输入。

不允许为未签名 Windows 引入 mandatory policy origin 或任何 dotenv 文件依赖，也不允许新增运行时覆盖用户数据目录的开关。

## 方案

### 构建与分发：GitHub Actions + Release（已选）

`workflow_dispatch` 在 `windows-2022` x64 上从仓库检出构建，环境干净可复现，Node 24 与根 `packageManager` 固定的 pnpm 由 workflow 安装。

构建与验收同源：同一个 workflow 内的 Artifact 既是验收输入，也保证 Release 资产就是被验收过的那份字节。

Release 是唯一公开下载入口，资产带 SHA256，下载方可自行校验。已接受这次的发布面：任何拿到 Release 的人都能安装这份未签名安装包。

### 本机构建或复用 ARM64 UTM VM（未选）

现有 UTM VM 是 ARM64，x64 目标只能跑模拟，构建时间与失败模式都不可控，产物也无法追溯到具体的源提交。

本机构建要求本机具备完整 Windows x64 打包工具链与授权环境，且分发仍需人工上传，正是本次要消除的环节。

两者都无法给出发布级的 SHA 固定点与可复现的验收环境。

### 同身份覆盖（已选）

沿用官方 appId 与 productName，安装包覆盖到同一安装目录，数据目录因此天然继承。

覆盖安装的 uninstaller 由 electron-builder 以 `/KEEP_APP_DATA` 路径启动，不删 Electron userData 与 `.dsh`；现有初始化只补缺失文件，不重写已有文档。

代价是定制包与官方包在同一身份上互斥：装了定制包就不再是官方包，反之亦然。这一代价被用户已明确接受。

### 独立身份并存（未选）

独立身份需要新的 appId、productName、Electron userData 目录、单实例锁、卸载登记项，并且要么另起 `DSH_HOME` 与 profile 名，要么复制现有数据过去。

它换来的是两个应用并存，而本次需求恰恰是「覆盖安装并继承原配置」，两者互斥。并存还使更新通道、卸载行为和用户认知三处分叉，收益不抵成本。仅当产品需要同时保留官方版与定制版时才值得采用。

## 受控 core 输入

唯一 core 来源是 `apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz`，132805 字节，SHA256 `8a03ce849d860f680fddf065b8060ddb9ebd65d2fe5ed9406abc22d7c2f095d7`。

同级 sidecar `apps/desktop/resources/custom-core/dsh-tools-0.2.2-rc.3.unified.2.tgz.sha256` 以 `sha256sum` 格式记 `<64 位十六进制>  <文件名>`；脚本只从 sidecar 读取期望值，避免脚本常量与文件漂移，sidecar 因此是唯一固定点。

该 tarball 是源输入而非构建产物：不放进 `.desktop-build`，不用机器绝对路径，也不要求从仓库外手工投递。二进制随实现一并提交，本设计只固定位置、字节数与 SHA256。

tarball 不进安装包：`apps/desktop/resources/` 下只有图标经 `extraResources` 显式加入，electron-builder 的 `files` 逐项列出运行时文件，不含该目录。安装包内不存在该 tarball 是验收项之一。

包内 `package.json` 声明 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，共 65 个条目，仅含 `lib/`、`locale/`、`src/` 与 `package.json`。

## 构建期替换

替换点固定在 `apps/desktop/scripts/package-target.ts` 的 `pack()` 完成 dsh 家族打包之后、`prepare:packages`（即 `apps/desktop/scripts/prepare-package-set.ts`）执行之前。此时 `packedDsh` 目录里是待选闭包，尚未形成 package set，也尚未安装。

替换动作是：校验字节数与 SHA256，移除 `packedDsh` 内官方 `deepseek-ai-dsh-tools-0.2.2-rc.3.tgz`，从受控路径写入 `deepseek-ai-dsh-tools-0.2.2-rc.3.unified.2.tgz`，再复算写入文件的 SHA256。命名沿用 release 打包的 `<unscoped>-<version>.tgz` 约定，与目录内其他 tarball 一致。

后续链路自动承接，无需额外改动：

- `prepare-package-set.ts` 解出包名与版本，生成 `desktop-packages.json` 记录 `{ name, version: "0.2.2-rc.3.unified.2", file, bytes, integrity: "sha512-…" }`。
- `desktopCorePackageOverrides` 为该记录生成 `file:` override，lockfile 因此指向本地 tarball 并校验 integrity。
- `prepare-dsh.ts` 把 package set 中每个包名传给 `writeDesktopRuntime`，`desktop-runtime.json` 的 `sharedPackages` 因此记录 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`，`files` 记录每个 runtime 文件的 sha256。
- `parseDesktopCorePackageSet` 只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 做版本等于 `0.2.2-rc.3` 的强校验；`dsh-tools` 允许带 prerelease 前缀，`0.2.2-rc.3.unified.2` 是合法 semver。

版本不动的另一个理由在包自身：该 tarball 的 `peerDependencies` 要求 `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-scope`、`dsh-session`、`dsh-system-prompt`、`dsh-user-approval` 均为 `0.2.2-rc.3`，与官方 runtime 的其余部分正好对齐，因此只有 `dsh-tools` 一个包的版本发生变化。

## 打包环境的未签名例外

未签名 Windows 与未签名 macOS 适用同一条规则：不解析 mandatory policy origin，不写 `extraMetadata.dshMandatoryUpdatePolicy`，`publish` 为 `null`，产物不含更新源配置，应用因此没有更新源，不会拉取官方更新包。

为此允许两处最小改动，都只是把条件收紧到「已签名才解析」：`apps/desktop/scripts/desktop-package-environment.mjs` 中 `validateDesktopPackageEnvironment` 的策略校验从「非 macOS 或已签名」改为「已签名」；`apps/desktop/scripts/electron-builder-config.mjs` 中 `policy` 的取值条件从 `packagesMacOS && unsigned` 改为 `unsigned`。策略的查询、阻断、登录与下载页运行时代码不改。

未签名 Windows 也不再读 `.env.windows`：`main()` 对未签名目标一律选择本地环境，像 `localMacOSPackageEnvironment` 那样剥掉继承的发布设置，并固定 `DSH_DESKTOP_APP_ID=com.deepseek.dsh`（官方 Windows appId）与 `DSH_DESKTOP_UNSIGNED=1`。macOS 未签名用 `com.deepseek.harness` 是为了不冒充官方身份；Windows 定制包按用户拍板必须沿用官方身份才能覆盖安装。其余设置（压缩等级、并发、镜像）沿用既有默认值。

「缺失即停」的前置随 `.env.windows` 一起取消：没有该文件不再阻塞构建，未签名 Windows 不要求任何 origin。

## 失败即停

以下情况一律中止构建并报告，不产生安装包：

- tarball 缺失、不可读、不是普通文件，或字节数不等于 132805。
- sidecar 缺失，或格式不是 `sha256sum` 的两段式。
- SHA256 与 sidecar 不符，或替换后写入文件的 SHA256 与 sidecar 不符；报告须同时给出期望值与实际值。
- 替换前 `packedDsh` 内官方 `deepseek-ai-dsh-tools-0.2.2-rc.3.tgz` 不是恰好一份，即缺失或重复。
- 替换前已存在任何定制 `dsh-tools` tarball，即重包。
- 替换后定制 tarball 不是恰好一份，或官方 tarball 仍有残留。
- `desktop-packages.json` 中 `@deepseek-ai/dsh-tools` 记录不是恰好一条，或版本不是 `0.2.2-rc.3.unified.2`。
- `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-desktop-host` 版本不等于 `0.2.2-rc.3`（既有 `RELEASE_PACKAGES` 校验）。

替换点不得依赖 `prepare-package-set.ts` 的 `duplicate packed package` 兜底：那条规则在更晚的阶段才触发，报错也不指向重包原因。

构建失败时 workflow 不进入验收 job，也不创建 Release。失败信息不含任何环境变量取值。

## 可复现性

core 内容只由该 tarball 的字节决定，字节数与 SHA256 是入口守卫；tarball 内每个 runtime 文件在 `desktop-runtime.json` 的 `files` 里都有 sha256 与字节数。

两次同输入构建应在 `desktop-packages.json` 的 `integrity`、`desktop-runtime.json` 的 `sharedPackages` 与 core 相关 `files` 条目上完全一致。Electron 二进制、Node/pnpm/Python 发行版与 asar 容器本身的时间戳差异不在可复现性承诺范围内。

不通过「锁死上游版本号」实现可复现，因为 tarball 是本地构建产物而非 registry 版本；固定点是仓库内路径加 sidecar 里的 SHA256。

## 原配置、会话、插件保留契约

appId 与 productName 不变，因此 Electron userData 仍是 `%APPDATA%\@deepseek-ai\dsh-desktop`，其中 `desktop/settings.json`、`desktop/keybindings.json`、浏览器存储与缓存原样保留。

`DSH_HOME` 默认仍为 `%USERPROFILE%\.dsh`，Desktop 独占的 profile 仍是 `profiles/desktop`；会话、settings、credentials、`dsh.profile.bundles`、已安装插件都在此处。

现有的缺失即创建初始化保持原样，本设计不新增任何重置、迁移或覆盖分支，也不引入配置版本迁移。

覆盖安装走 `/KEEP_APP_DATA` 路径，卸载器不删除 userData 与 `.dsh`；这一点由 electron-builder 的原地更新调用方式保证，实现不得改成普通卸载路径。

插件清单 `dsh.profile.bundles` 的读写不属于本期范围。core 版本变化对插件兼容性的判断仍由既有 allow-version 策略负责。

## 插件不进包

安装包只含 core 闭包：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-desktop-host` 及其必需的本地 workspace 依赖，加上替换后的 `dsh-tools`。

包内不含 `dsh-tool-registry`，不含任何业务插件 tarball，不含 `profiles/desktop/node_modules`，不含用户数据，也不含受控 core tarball 本身。

这条边界靠构建输入控制而非过滤规则：`packedDsh` 只来自 dsh 家族打包，替换只动一个包名。

## CI 构建与验收

workflow 为 `.github/workflows/desktop-custom-core-windows.yml`，仅 `workflow_dispatch` 触发，全部 job 在 `windows-2022` x64 上运行，`permissions.contents` 按 job 最小化（只有发布 job 需要写）。

输入为 `publish_release`（布尔，默认 `false`）与 `release_tag`（字符串，`publish_release` 为真时必填）。默认路径只构建与验收，不碰 Release。

三个 job 串行：

- `package`：安装 Node 24 与根 `packageManager` 固定的 pnpm，执行 `pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned`，校验 package set 与 runtime 记录，解出 `app.asar` 校验包内容，把 NSIS 安装包和校验摘要上传为 Artifact。
- `acceptance`：下载同一运行的 Artifact，在本次 runner 的一次性用户配置里完成基线安装、数据播种、覆盖安装与哈希对比、启动冒烟、fixture 插件验收。任一项失败即失败。
- `release`：仅在 `publish_release` 为真且前两个 job 成功时运行，创建 GitHub Release。

Artifact 只是同一次运行内的验收输入，不作为下载入口，也不在正文里给出链接。

### 基线安装包

覆盖安装验收需要一份官方 `0.2.2-rc.3` 安装包作为基线段。两个方案都可行，计划阶段必须选定一个并写进 workflow，不留为未知：

- 同 workflow 基线构建：在官方 `0.2.2-rc.3` 源码提交上以同一工具链构建 `package:win:x64:unsigned`，基线与定制包的工具链、目录布局与安装参数完全一致，无外部资产来源。
- 固定官方资产：记录官方 `0.2.2-rc.3` Windows x64 安装包的下载地址与 SHA256，验收前校验 SHA 后使用。

计划阶段选定后，基线固定点（提交或 URL + SHA256）写入 workflow，验收日志记录实际使用的基线与摘要。

### 隔离用户环境

隔离由 runner 本身提供：GitHub 托管的 `windows-2022` runner 是一次性虚拟机，其用户配置、`%USERPROFILE%`、`%APPDATA%`、`%LOCALAPPDATA%` 在 job 结束即销毁，不接触任何真实用户配置。

安装为每用户安装（`perMachine: false`、无提权），基线安装与定制覆盖安装落在同一用户目录，正是数据继承的验证对象。

不引入用户数据目录覆盖开关：`DSH_DESKTOP_USER_DATA_DIR` 只被开发启动器 `apps/desktop/scripts/dev.ts` 读取，打包产物不读，因此不作为隔离手段。

### 重包判定

替换前：`packedDsh` 内 `@deepseek-ai/dsh-tools` 的官方 tarball 恰好一份，且不存在任何定制 tarball。

替换后：定制 tarball 恰好一份，且不再存在官方 tarball。

替换 helper 的负向测试同时放入官方与定制两份 tarball 时，必须抛出显式的重包错误，而不是让后续 package set 报通用重复。

### unified.2 生效验收

除包版本、字节数与 manifest 记录之外，用测试专用 fixture 插件验证 core 行为的差异。fixture 只存在于隔离测试环境的 profile 插件目录，不进安装包，也不要求任何业务插件参与。

fixture 在其 scope 内注册自己的工具，并施加 `includeOwn: true` 的 allow-list。该清单只写一个合法的继承工具名，不含这个 own 工具，以免 rc3 以未知全局工具拒绝该调用。

验收判定：unified.2 的目录投影不列出该工具，调用被拒绝；官方 rc3 上同一 fixture 的 own 工具可见且可执行。两次观察使用同一 fixture 字节、同一 scope 配置、同一调用参数。

fixture 的来源路径与哈希记入验收日志，以证明测试输入本身可复现。

## 发布边界

Release 只在 `package` 与 `acceptance` 都通过且 `publish_release` 为真时创建，默认 `prerelease: true`。

资产为 NSIS 安装包本身加一份 SHA256 摘要。正文标注未签名状态、安装时 SmartScreen 会提示「更多信息 → 仍要运行」，并写明该包沿用官方身份、会替换同版本官方安装。

不发布到 test / production 更新通道，不写 COS，不触发 `desktop-publish` 或 `desktop-rollout`，不产生发布完成记录；`publish` 保持 `null`。

Release 是用户本次明确授权的将来目标：本次只落设计，不 push、不触发 workflow、不创建 Release。

## 验收清单

构建与 manifest：

- workflow 在 `windows-2022` x64 上完成构建，`desktop-packages.json` 含且仅含一条 `@deepseek-ai/dsh-tools` 记录，版本 `0.2.2-rc.3.unified.2`，`integrity` 对应替换后 tarball 的 sha512。
- `desktop-runtime.json` 的 `release.version` 为 `0.2.2-rc.3`，`sharedPackages` 含 `@deepseek-ai/dsh-tools@0.2.2-rc.3.unified.2`。
- 构建日志无 SHA 校验失败，替换点报告期望与实际摘要。

安装包内容：

- 解出安装包内的 `resources/app.asar`，`dsh/node_modules/@deepseek-ai/dsh-tools/package.json` 版本为 `0.2.2-rc.3.unified.2`。
- 同一路径下不存在 `dsh-tool-registry`，不存在任何业务插件包。
- 全部 `.tgz` 输入中 `@deepseek-ai/dsh-tools` 只有一份，且不含受控 core tarball。
- 不存在 `app-update.yml` 等更新源配置。

覆盖安装与数据保留：

- 在 runner 的一次性用户配置中安装基线 `0.2.2-rc.3`，产生可识别数据：至少一个会话、非默认设置项、一个已启用插件（可用同一 fixture 插件，无需业务插件）。
- 记录哈希清单：`%USERPROFILE%\.dsh` 下 `sessions`、settings、credentials、`profiles/desktop` 的 `package.json` 与 `dsh.profile.bundles`，以及 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop\*.json`。
- 安装定制包覆盖同一目录，再次记录同一清单，逐项哈希一致。
- 启动应用：Host 健康检查通过，上述会话可打开，插件仍处于启用状态。

unified.2 生效：

- fixture 插件在定制包上被拒绝且不出现在目录投影中。
- 同一 fixture 在基线包上可见且可执行。
- 业务插件不参与该项判定。

负向验证：

- 临时移走受控 tarball 执行一次构建，构建在替换点失败并给出路径，未产出安装包。
- 篡改一份 tarball 副本使 SHA256 变化，构建失败并同时报出期望值与实际值。
- 同时保留官方与定制两份 `dsh-tools` tarball，替换 helper 显式失败并报重包。

## 留给实现者

实现位置：替换逻辑放在 `package-target.ts` 的 `pack()` 与 `prepare:packages` 之间，仅对 `target.platform === 'win32'` 且 `unsigned` 生效。是否扩展 macOS 不在本期决定，本期实现不得默认对 macOS 开启。

常量归属：路径是仓库相对路径，SHA256 只来自 sidecar；禁止从 registry、`latest` 标签或网络解析版本。

失败信息格式：须包含阶段名、期望 SHA256、实际 SHA256、tarball 计数与文件绝对路径，且不含任何环境变量取值。

校验入口：`--check` 在 `packageTarget` 之前返回，不执行 `pack()`，也不产出 package set；`--prepare-only` 会执行 `pack()` 与 `prepare:packages`，因此同样经过替换点。SHA 校验必须位于 `pack()` 之后的实际构建路径内；是否额外提供独立预检命令由实现者判断，但不得让 `--check` 的成功被误读为「tarball 已校验」。

工作流细节：Node 与 pnpm 版本取自根 `package.json`；缓存、Artifact 保留天数与并发组按仓库既有 Windows 工作流惯例取值；`release` job 需要 `contents: write`，其余 job 只读。

fixture 插件：形态、安装方式与断言脚本由实现者决定。它只能存在于隔离测试环境，不得进入安装包或产品代码。

文档更新：本设计不要求修改 `apps/desktop/README.md`。若实现改变了安装包内容清单、用户可见行为或打包环境约束，再按 `docs/AGENTS.md` 的分层规则补到对应拥有者文档。

范围守卫：实现不得引入配置迁移、插件 allow-version 调整、自动更新行为改动、非 Release 的上传步骤或用户数据目录覆盖开关；这些属于非目标，出现即视为偏离设计。
