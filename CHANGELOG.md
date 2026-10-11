# Changelog

## [Unreleased] - 2026-03-11

### 修复
- 修复 Vaults 页（或任何非终端标签页）点击顶部 AI 助手按钮完全没反应：AI 面板只存在于终端层且需要终端/工作区上下文，之前只会把"已打开"状态写到永远画不出来的标签上。现在会先切到终端——有会话就跳到该标签并打开面板，没有任何会话则先开一个本地终端再打开

### 设计原理
- `application/state/resolveAiPanelTerminalTab.ts` 把"当前标签能否承载 AI 面板"和"该切到哪个终端标签"提成纯函数，便于单测（`resolveAiPanelTerminalTab.test.ts`）
- dsh 走 `electron/bridges/aiBridge/sdk/dshDriver.cjs`：`runTurn` 只做 spawn + stdout 转发；会话续接、工具调用事件、附件暂未映射，属刻意的最小第一步

### 功能
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
