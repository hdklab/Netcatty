# Changelog

## [Unreleased] - 2026-03-11

### 修复
- 修复外部 Agent（DeepSeek Harness / Hermes）答完以后 AI 面板一直显示 Stop 方块、箭头不再出现、并且再也发不出消息：渲染层靠主进程的 `done` IPC 结算轮次 promise，而 `dshDriver` / `hermesDriver` 没有发它，轮次永不收尾，于是 streaming 标记、发送闸门与 `isSending` 一起被卡住。两个驱动补上 `emitDone`，`sdkStreamHandlers` 再对"驱动跑完却没发 done"统一兜底（渲染层去重），避免以后新增驱动再犯
- 修复 Vaults / SFTP 等非终端页顶部 AI 按钮的行为：面板改为应用级全局侧栏（见"功能"），按钮只负责显示/隐藏，不再为此切换标签或新建终端

### 设计原理
- AI 面板的 Send/Stop 由 `useAIChatStreaming` 的模块级共享 streaming 集合驱动（终端层与全局侧栏两个实例共用）；`AgentRuntime.runTurn` 现在在自己拥有的每条退出路径上释放它，面板再与 `AgentRuntime.hasActiveTurn()` 对账，任何残留都不会再表现为永久 Stop
- 外部 SDK 驱动的完成契约：驱动结束必须 `emitter.emitDone()`——渲染层 `sdkAgentAdapter` 靠 `onAiSdkAgentDone` 结算轮次，漏发即"回答已到但轮次不收尾"
- 全局 AI 侧栏不提升 `useAIState`，而是把面板 `createPortal` 到 `AppView` 内容区里的 `#ai-sidebar-host`，并且该宿主是视图栈的 flex 兄弟节点：侧栏占位（内容区变窄）而非浮层，才不会盖住右侧按钮
- dsh 走 `electron/bridges/aiBridge/sdk/dshDriver.cjs`：`runTurn` 只做 spawn + stdout 转发；会话续接、工具调用事件、附件暂未映射，属刻意的最小第一步

### 功能
- 本地终端的「系统 → 概览」现在有数据了：SSH 统计路径（`netcatty:ssh:stats`）需要可探测的连接，本地 shell 只会回 "Session not found or not connected"，于是概览一直空白。新增本机统计采集器（Node `os` + `/proc/meminfo` + `/etc/os-release` + `statfs` + `/sys/class/net`，CPU/网络用两次采样求增量）与 IPC `netcatty:system:localServerStats`；渲染层仅在 SSH 统计以"未连接"失败时回退，且主进程会校验该会话确实是本地会话，已断开的远端会话不会被本机数据顶替
- AI 助手改为 VS Code 式全局侧栏：顶栏按钮显示/隐藏、可收成 44px 图标栏（状态存 `netcatty_ai_sidebar_v1`）；终端侧栏的 AI 入口也指向它，避免两个面板并存
- 新增 `docs/external-mcp.md`：对外 MCP 的开启方式、发现文件字段、15+ 按需工具清单、权限语义与 Hermes 接入命令
- 自建更新源可在应用内配置：设置 > 系统 > 软件更新 > 自建更新服务器填入「更新源地址 / 下载页地址」保存即生效（写入 `<userData>/self-hosted-update.json`，运行时热切换 feed，无需重启）；`NETCATTY_UPDATE_SERVER_URL` 仍优先并在界面上标注
- AI 助手 agent 列表新增 DeepSeek Harness（`dsh`）：自动发现 PATH 上的 `dsh`，选中后按最小可用方式接入（`dsh headless "<任务>"`，stdout 作为回复流），模型/凭据仍由 dsh 自己管理（`$DSH_HOME` / `DEEPSEEK_API_KEY`）
- 取消云端（GitHub）更新：应用不再向 GitHub 检查或下载更新，更新源改为预留的自建服务器（`infrastructure/config/selfHostedEndpoints.json` 的 `updateServerUrl`，或用 `NETCATTY_UPDATE_SERVER_URL` 启动时覆盖）；未配置时不发起任何检查、不显示下载入口，设置页明确提示"未配置更新源"
- 自建更新源按 electron-updater 的 generic 源接入（`latest.yml` / `latest-mac.yml` / `latest-linux*.yml` + 产物），另需 `latest.json` 作为应用内版本检查的元数据；契约见 `docs/self-hosted-update-and-config-server.md`
- 更新源默认指向本仓库的 GitHub Releases：出厂默认（`infrastructure/config/selfHostedEndpoints.json`）改为更新源 `https://github.com/hdklab/Netcatty/releases/latest/download`、下载页 `https://github.com/hdklab/Netcatty/releases`；`.github/workflows/build.yml` 的 release 作业在发布后把 `releases/tags/<tag>` 的 API 载荷（即应用解析所需的 GitHub 形状）作为 `latest.json` 补传到该 release，generic 源要的 `latest*.yml` 仍由 electron-builder 产出并随 release 上传，因此 feed 在下一次 `v*` 发版后即可完整使用
- "保存配置到自己的服务器"无需改代码：云端同步已内置 WebDAV / S3 供应商，可直接指向自建端点
- Linux deb/rpm/pacman 安装包启用应用内自动更新；未标记的开发包和 Snap 继续提供手动下载入口
- 终端新增"粘贴时自动上传剪贴板图片"选项：剪贴板含图片时，在远程会话中粘贴（快捷键/右键/中键）自动通过 SFTP 上传图片到远端 `.netcatty-paste-images/` 目录并输入远端路径，否则保持原有文本粘贴行为（设置 > 终端 > 行为，默认关闭）
- 修复自动更新 IPC 事件仅发送到单个窗口的问题，改为广播所有窗口（主窗口 + 设置窗口均可收到）
- 统一手动检查更新与自动更新的状态机，消除三套并行状态
- 手动"检查更新"通过 GitHub API 检测版本，发现更新后异步触发 electron-updater 下载
- 设置窗口中点击"检查更新"后，下载进度可实时反映在 UI 中
- 应用启动后 5 秒自动触发 `electron-updater` 检查更新，无需用户手动点击
- 发现新版本后自动开始下载（`autoDownload=true`）
- 下载完成后弹出持久 toast 通知，用户点击"立即重启"即可安装
- 下载失败时弹出错误 toast，提供"打开 Releases"降级入口
- Settings > System 进度条实时展示自动下载进度，由 `useUpdateCheck` 统一驱动
- Linux Snap、未标记的开发包等不支持 electron-updater 的平台自动跳过，保持原有 GitHub API 通知行为

### 设计原理
- `broadcastToAllWindows` 替换 `getSenderWindow` 单点发送，保证所有窗口都能收到 IPC 事件
- `manualCheckStatus` 字段追踪手动检查 UI 状态（idle/checking/available/up-to-date/error），与 `autoDownloadStatus` 在 UI 层按优先级渲染
- `SettingsSystemTab` 不再持有本地 update state，单向接收 `useUpdateCheck` 统一数据
- 将原有两套独立系统（GitHub API 通知 + electron-updater 手动下载）合并为统一状态机：`useUpdateCheck` 作为唯一事实来源，同时驱动 `App.tsx` toast 和 `SettingsSystemTab` 进度条
- 全局持久化 IPC 监听器在 `autoUpdateBridge.init()` 时一次性注册，避免每次手动下载请求重复注册/清理监听器
- `autoInstallOnAppQuit=false`，不做静默安装，由用户主动触发重启

### 接口变更（SettingsSystemTabProps）
- 移除：`autoDownloadStatus`、`downloadPercent`
- 新增：`updateState`（完整 UpdateState）、`checkNow`、`installUpdate`、`openReleasePage`

### 注意事项
- `checkNow` 语义：使用 GitHub API（`performCheck`）检测是否有新版本，若发现更新且 electron-updater 尚未开始下载，则异步触发 `bridge.checkForUpdate()` 启动自动下载流程
- 此功能仅对打包后的应用（Windows NSIS、macOS dmg/zip、Linux AppImage/deb/rpm/pacman）生效，dev 模式需配合 `forceDevUpdateConfig=true` + `dev-app-update.yml` 测试（见 `.gitignore`）
- `hasUpdate` 旧 toast 在 `autoDownloadStatus !== 'idle'` 时自动抑制，避免与新 toast 重复

### 功能（AI Agent 列表）
- 新增 Hermes（`hermes`，Nous Research 的 Hermes Agent CLI）：自动发现 PATH 上的 `hermes`，每轮以 oneshot 模式执行（`hermes -z "<任务>"`），stdout 作为回复流；模型、记忆与凭据由 Hermes 自己的配置管理
- 设置 > AI > Agent 新增「DeepSeek Harness」与「Hermes」两张卡片（检测状态 / 自定义路径 / 重新检测 / 重置），与其他外部 Agent 卡片一致

### 变更（移除内置 Catty）
- 内置 Catty（Netcatty 自带 Agent）不再出现：设置里的「默认 Agent」下拉与聊天面板的 Agent 选择器都只列外部 CLI Agent，应用只用外部 Agent 运行对话
- 新会话默认 Agent 改为 dsh；历史遗留的 `catty` 选择在读取时迁移为默认外部 Agent（`migrateLegacyAgentSelection`），旧会话仍可打开并改由外部 Agent 继续
- 一个外部 Agent 都没启用时，面板的选择器显示「未配置 Agent」并给出启用指引

### 设计原理（AI Agent 接线）
- 每个 Agent 的路径状态改为键控表（`MANAGED_AGENT_KEYS` / `agentPathControlsRef`）取代三元链：原来未覆盖的 key 会把写操作静默落到 mimo 的状态上
- 新增一个 Agent 的触点固定为五处：`domain/codingCliProviders.ts`（终端标签识别）、`domain/agentIcon.ts`（图标）、`infrastructure/ai/managedAgents.ts`（键与元数据）、`electron/bridges/aiBridge/agentDiscoveryHandlers.cjs`（发现与版本探测）、`electron/bridges/aiBridge/sdk/<name>Driver.cjs` + `sdk/index.cjs`（执行），设置页复用 `CopilotCliCard` 的 `i18nPrefix`
- 「默认 Agent」的空值兜底从内置 Catty 改为 `DEFAULT_EXTERNAL_AGENT_ID`（dsh），与 `canSendWithAgent` 只认可用外部 Agent 保持一致
