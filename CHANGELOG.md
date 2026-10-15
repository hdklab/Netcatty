# Changelog

## [1.1.93] - 2026-10-15

### 功能
- **节点工作流：跨主机的执行顺序终于可以画出来了**：新增顶层「工作流」标签页 —— 左侧是工作流列表，中间是从节点调色板拖出来的画布，右侧是节点设置，运行结果落在底部抽屉里。此前自动化脚本只有「一个脚本 × N 个会话 + 顺序/并行开关」，表达不了「A 台做完第 1 步，B 台才做第 2 步，C 台只在 B 的检查匹配时才做第 3 步，B 失败则下游全停」。v1 提供四种节点：**主机命令**（SSH 执行，可多主机并发）、**条件判断**（Y / N 两个输出端口）、**等待**、**人工确认**（暂停，等你确认后继续）
- 节点设置覆盖：目标（指定主机 / 按分组每行一个 / 全部主机）、命令、视为成功的退出码、成功与失败正则、主机并发数、首台失败即停止、执行前询问、失败策略（中断下游 / 继续下游 / 走失败分支 / 跟随工作流设置）、重试次数与间隔、超时；命令黑名单在运行前拦截，命中即算错误，运行按钮禁用并列出原因
- 画布交互：拖拽建节点、从端口连线、选中连线后删除或直接拖端点改接目标、缩放平移与适应视图；条件节点端口标 Y / N、失败端口标 !；**回边画成琥珀色虚线**（普通依赖是实线），工具条上的「循环上限」默认 3；支持撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）；定义与运行记录自动存本机（`netcatty_workflows_v1` / `netcatty_workflow_runs_v1`，不进云同步）
- **终端：SSH 断线自动重连默认开启**：VPN / Wi-Fi 抖一下不再把标签停在「按回车重连」，同一 session id 原地重连，AI 会话与长任务在链路恢复后接着跑。干净的 shell 退出仍会关标签；空闲超时退出（TMOUT、服务端踢人、连接超时）只断开，不再每 5 秒重新登录一遍
- **终端：退出后默认不再自动关闭标签**：远端「优雅断开」（VPN 半关闭、跳板机清理空闲会话）常被报成 code 0 的正常退出，此前会正好在用户最需要保留 scrollback 时把标签删掉，还绕开了自动重连。想恢复旧行为可在 设置 > 终端 > 行为 里打开
- **AI：会话历史可以搜索了**：按标题与正文检索（含拼音匹配与完整的共享字段匹配），历史抽屉里直接过滤
- **AI：会话空闲超时从 30 分钟提到 8 小时**：`host_open` 打开的会话此前 30 分钟无活动就被回收，链路不稳时会把正在跑的 Agent 工作无声清掉，现在一个工作日内的抖动都覆盖得住；仍可在 设置 → AI 调短，有活跃执行的会话依旧不被回收

### 修复
- **小屏（如 1366×768 @125%）装不下窗口**：布局最小尺寸改为按当前显示器工作区收敛，可以缩小了；OS 触发 resize / 最大化后终端重新拿到键盘焦点，且不会从正在输入的表单里抢焦点
- zmodem 前导被分块切开的 `ZRQINIT` / `ZRINIT` 不再漏进终端（改为等齐再判定），此前会被当成普通输出显示出来
- **rz 上传的进度条不再中途冻住**：SSH 通道背压时上传循环停在 drain 等待上，而整个 channel window 恰好在这段窗口里被一次性发完，于是进度条一动不得到循环恢复才跳一大格（#3663）。现在把「已投递字节」报给进度：`getTransportPendingBytes()` 把 `writableLength` 与 channel 里还没发完的 `_chunk` 一起算（ssh2 在整块写完前不改 `writableLength`），并把每次进度轮询与 drain 竞速，通道一空立刻继续上传，不再白等一个节流间隔
- **AI 空闲提示符判定不再拖慢主进程**：此前对每个 PTY chunk 都归一化整段保留输出（最多 256K 字符做 ANSI / CR 剥离），只为判断它是否以提示符结尾；输出洪泛 + CRLF 行尾时会把终端 worker 占住数秒，Cancel、定时器和 keepalive 全被推迟（#3443）。现在只看一个固定尾部窗口（`PROMPT_SUFFIX_MIN_WINDOW_CHARS` 2048 起，随提示符长度线性放宽），只要提示符落在窗口内结果不变
- 光标行高亮在 xterm 外部销毁装饰后自愈重建；整行已着色的行不再每帧反复重建标记
- 传输中心取消一个独立上传不再连带中止同批次其它上传（单文件与批量分别按 `file` / `batch` 范围取消）
- 设置里的快捷键录制：只按修饰键（如 Ctrl+Alt）此前会丢，现在松手时才落盘
- 代码片段补全在输入参数时也会出现（此前参数打到一半没有提示），且输入变化后旧提示行立即清掉
- 代码片段导入导出保留「全部主机」与分组作用域：导出升到 v3，并兼容 v1 / v2
- 崩溃日志按天限量，已有的超大日志会被裁剪，不再无限增长
- Vault 笔记：写入失败后待提交的本地草稿不再丢，与外部改动冲突的内容也会保留到本轮成功落盘
- AI：Claude 模型回退列表补齐（保留家族别名与显式模型 ID，不会擅自加 effort 后缀，也不覆盖已保存的选择）
- AI：localStorage 配额吃紧时先裁剪工具输出再考虑丢会话 —— 此前会直接扔掉最早的会话，重启后历史列表看着是空的
- Electron 升级到 42.11.12：二次启动不再丢会话
- et 传输：镜像里没有 `/usr/bin/ssh` 时也能注入 PATH wrapper（改为先用 `findExecutable` 的绝对路径，再退到 `command -v` 与常见安装位置）

### 设计原理
- 工作流的领域层是纯逻辑、零 I/O（`domain/workflow/`，22 个文件）：`validate` 图校验与目标解析、`runPlan` 拓扑调度、`expression` 插值、`conditions` 比较、`commandOutcome` 结果判定、`loops` 回边、`concurrency` 有界并发、`sessionOutput` 屏幕输出提取、`serialize` 容错读写、`channel` 通道判定，全部走 `node --test`
- 调度语义：每轮重算「就绪节点 + 被占用的主机」，**两个节点不会同时动同一台主机**；节点收尾必须有明确判定（success / failed / skipped），漏判曾让下游永久等待，现在统一归一化；被停用的节点算 skipped 并把 `upstream-skipped` 级联给下游，不做直通
- 回边由 `loops.ts` 用 DFS 标记，调度时忽略被标记的边，于是调度器看到的始终是 DAG；失败节点若带回边且预算未用完，把它回连的目标及其全部下游重置为 pending 后重跑（`{{ loop.iteration }}` 暴露第几轮），预算用完才交给 `onError` 策略
- `{{ }}` 插值只支持白名单路径（`nodes.` / `loop.` / `workflow.vars` / `run.`）与固定过滤器（trim / upper / lower / head / tail / match / default），不引入 eval —— 导入的定义不能执行代码；引用不存在的节点会失败，除非显式写 `| default("…")`
- 执行通道按主机二分（`domain/workflow/channel.ts`）：直连 SSH 走一次性 `netcatty:ssh:exec`（有退出码、不需要打开终端、复用 `buildSftpHostCredentials` 的凭据解析）；telnet / 串口 / mosh / et / 跳板链没有 exec 通道，改为把命令打进该主机已打开的终端并读屏幕快照，输出提取按提示符行收尾、剥 ANSI、用命令回显定位起点 —— 没有回显说明会话被全屏程序占着，该主机直接判失败
- 会话通道没有退出码，因此默认视为成功，判定交给用户填的成功 / 失败正则
- 运行器（`application/state/workflowRunner.ts`）把一切外部世界（SSH、定时器、对话框）通过注入的 `WorkflowExecutor` 收口，所以顺序、重试、分支、取消这些语义可以用假执行器测；「执行前询问」被拒绝后该节点记为 skipped / `manual-declined`，下游按 skipped 级联
- 画布用 `@xyflow/react` 12.12.0（MIT，仅渲染层，不进主进程）：React Flow 自带的 `<Controls>` 在深色主题下渲染成白块，改为自绘缩放按钮；空图不会被激活时的 `fitView` 框住，所以第一个节点落位时会重新 fit；运行中的节点与连线按状态着色，连线中点的删除按钮只在选中 / 悬停时出现，避免遮挡
- 工作流标签页懒挂载、切走后只隐藏不卸载（`AppMounts.WorkflowViewMount`），回到标签页时画布状态还在
- 新增 `workflow.*` 文案命名空间，五种语言（en / zh-CN / zh-TW / ru / es）键保持一致，并加平行性测试 `workflowLocales.test.ts`
- 设计文档：`docs/designs/workflow-orchestration.md`（目标与非目标、与 n8n 的取舍、落地文件与未决项），另新增 `docs/designs/terminal-performance-parity.md` 记录当前架构下的理论性能与终端对齐基线

### 已知限制
- 工作流 v1 只有四种节点；从失败节点重跑（运行器已接受 `previousResults`，按钮未接）、导入导出、定时 / 事件触发都还没做，脚本节点、传输节点、端口转发节点仍在里程碑上
- 会话通道要求目标主机的终端已打开且空闲（正在跑全屏程序会吞掉输入），只能看可见屏幕、没有退出码，且整个过程在该终端里可见
- SSH exec 通道没有自己的中止通道：点「停止」后调度立刻停下，但已经发到线上的那条命令仍会跑完
- 为避免「退出即删标签」继续伤害老用户，本次对升级包做了一次性迁移；在 1.1.93 之前**手动开启过**「退出后关闭标签」的用户需要重新打开一次

## [1.1.92] - 2026-10-13

### 功能
- **启用外部 Agent 时会提示注册 Netcatty MCP 服务**：在侧栏启用一个外部 Agent（Codex / Claude / Grok / Hermes / OpenCode / dsh）时，先查询它是否支持并已注册 Netcatty MCP，未注册才弹窗询问安装；确认后写入该 Agent 自己的配置，并同步打开「对外 MCP」，跳过则直接启用。此前 Agent 会在没有任何 Netcatty 工具的情况下被静默启用
- **脚本可以直接拖进脚本包（含多选批量归类）**：堆叠（chip）视图此前既不是拖拽源、脚本包行也不是放置目标，该视图下完全无法归类脚本（本机存的正是堆叠视图）；现在 chip 与列表行一样可拖，列表行与带计数的包行都是放置目标，拖拽经过时高亮
- **FTP 客户端（lftp）路径可配置**：设置 → 文件传输新增「FTP 客户端（lftp）」一节 —— 路径输入、重新检测、清除，并实时显示「将执行：&lt;路径&gt;」等状态；没有配置时按平台自动探测常见安装位置
- **「文件传输」命名统一**：侧栏固定标签与设置页签从 SFTP 改为「文件传输」（五种语言同步），这个入口本来就同时承担 FTP / SCP / 本机传输

### 修复
- 脚本库打开时不再自动展开脚本包，默认全部折叠（本机 110 条脚本、单个包 91 条，此前一打开面板就是一屏平铺，且每次重新挂载都会再展开一遍），展开交给用户（包行箭头或工具条的「全部展开」）
- 拖拽文件上传时自动打开传输中心：此前只有拖文件夹才会打开它，拖单个文件只有顶栏角标在变，看不到进度
- **FTP 上传在传输中心登记为一条真实任务**：FTP 是一次阻塞式 lftp 调用、没有字节流，此前上传期间没有任何任务登记，上传完才弹一个成功提示；现在显示文件名、目标与进行条，成功自动收尾、失败落到「需要处理」

### 设计原理
- MCP 注册的判定与写入全部在主进程（`electron/bridges/externalMcp/agentMcpSetup.cjs`，配单测）：Agent 自己的配置文件属于它的私有状态，渲染层只拿到 `supported` / `installed` / `patchFile` / `profile` 这类结论，不碰路径也不拼命令。各 Agent 的写入口形态不同，因此按 `kind` 分档：`client-setup` 复用 Agent 官方 CLI（Codex / Claude / Grok），`dsh-profile` 往 profile 里插一段带起止标记的受管块（重装时先删旧块再插新块，不会重复堆叠），Hermes 与 OpenCode 直接改 JSON / JSONC 配置
- 安装这一步驱动渲染层已有的「对外 MCP」开关，而不让主进程悄悄改存储 —— 启动器只在开关打开时服务，开关状态与存储必须始终一致
- 拖拽载荷在既有的 `snippet-id` 之外新增 `snippet-ids` 承载整组选中项，一次写入完成而不是逐条循环；原有单条重排逻辑不受影响。落包时若目标包路径此前只被下级包隐含、还没登记在脚本包列表里，会一并写入，Vault 的脚本页随后就能看到这个包
- lftp 的解析顺序固定为「设置 → `NETCATTY_LFTP_PATH` → PATH → 平台常见位置」，指定路径存在但不可执行时明确报 `settings-invalid`，不静默回退（否则用户以为在用自己指定的那一份）。候选枚举是纯函数 `buildLftpCandidates`（Windows 的 Program Files / scoop / msys64 / cygwin，macOS 的 Homebrew / MacPorts，以及 /usr/local/bin、/snap/bin、Nix），设置只存本机、不进云同步
- 折叠状态改由用户显式控制，并补上 `aria-expanded`，折叠状态可以从 DOM 读到、测试里也能直接断言；只有「把脚本保存进某个包」这种显式操作仍然会展开目标包

## [1.1.91] - 2026-10-12

### 功能
- **没有 SSH 的设备也能用文件面板（FTP 文件浏览）**：telnet / 串口设备（例：`192.168.1.3` 只有 telnet:23 + FTP:21、没有 22）此前打开文件面板会永远停在「Connecting to …」，一个文件都列不出来——面板按 `host.port`(=23) 去拨 SSH，而主进程为 MFA 场景故意设的 `readyTimeout: 0` 让设备回完 telnet IAC 之后既不超时也不报错。现在没有 SSH 传输的主机自动走 FTP 文件模式，主机详情的「文件协议」下拉同时新增 **仅 FTP** 选项。后端复用外部 `lftp`，覆盖列目录 / 详情 / 新建目录 / 删除 / 重命名 / 读 / 写 / 上传 / 下载，上传与下载带进度和可中止
- **拖拽上传在没有 cwd 的设备上也可用**：没有 OSC7 的 telnet / 串口 shell 拿不到当前目录，现在文件落到 FTP 登录目录，并在提示里写明落点

### 修复
- 设备 `ls -l` 带硬链接数一列时（`-rwxr-xr-x    1 0        0          114924 Jan  1  1970 ECT8676_DPD_V2.2.9.4.bin`）列表解析结果为空、面板显示 0 项 → 正则容忍可选硬链接列，并保留 `cls -1` 与 MS-DOS 行格式兜底
- FTP 上传三处参数／语义错误会**把成功判成失败**或直接中止：`rm "/路径" -f` 被 lftp 当成「删名为 -f 的文件」（改为 `rm -rf "/路径"`）；`put -o` 的参数顺序非法（改为 `put "<本地>" -o "<远端>"`）；上传到 100% 后 `chmod` 抛「不支持 chmod」（FTP 上改为 no-op，UI 侧单独提示不支持）
- lftp 输出里的 `ftp://***:***@host:port/…` 不再回传渲染层（`scrubCredentials` / `pathFromLftpUrlLine`）

### 设计原理
- FTP 能力映射到既有 SCP 后端接口，由 `remoteFileBackend.cjs` 统一解析，`fileOps.cjs` / `transferBridge.cjs` 不需要为协议分叉；FTP 没有的符号链接元数据用「列父目录」实现 `stat`，`chmod` 显式降级为 no-op 并由 UI 承担提示
- FTP 模式**完全不碰 SSH**：`openSftp` 顶部直接分流（`sourceSessionId: null`），从根上消除「在 telnet 端口上拨 SSH 并永久挂起」
- lftp 一条命令一个进程，句柄被跟踪，关闭会话时一并 kill；lftp 脚本文件权限 0600 且口令不进 argv

## [1.1.90] - 2026-10-12

### 修复
- **AI 侧栏的会话作用域不再取决于「AI 子面板挂载了没有」**：侧栏的每条会话都是 scope 绑定的（`terminal:<sessionId>` / `workspace:<workspaceId>`），而注入给 Agent 的 Netcatty MCP 只暴露该 scope 下的会话。此前只有「已挂载 per-tab AI 子面板」的标签页才在 context 表里，于是刚打开的终端、或切到 Vaults / SFTP / 仪表盘再回到侧栏时，会话会掉到无主机的页面级 scope —— 终端明明开着，Agent 却报 `No hosts are available in the current scope`

### 设计原理
- 作用域解析收敛成纯函数 `application/state/aiSidebarScope.ts`（配单测）：优先当前标签页 → 其次「最后一个能承载侧栏的标签页」（且它仍然存活）→ 最后页面级兜底。Vaults / SFTP / 仪表盘这类没有终端的视图不再把会话踢回无主机 scope；被记忆的终端一旦关闭，记忆立即失效，Agent 不会被绑在一个已死的 session 上
- `useTerminalAiContexts` 不再只按「AI 子面板已挂载」的标签页建 context，而是覆盖所有能承载侧栏的标签页：工作区，以及所有非隐藏、不属于工作区的终端会话（工作区内的会话与 AI 打开的隐藏会话通过其宿主寻址，不单独占用一个 tab id）

## [1.1.89] - 2026-10-12

### 功能
- **AI 侧栏宽度可拖拽**：顶栏 ✨ 打开的全局 AI 会话面板现在可以拖左边线调宽（280 ~ 1200px，且不超过窗口 70%），宽度存 `netcatty_ai_sidebar_width`，重启/刷新后保持。默认宽度从写死的 380px 提到 **399px（+5%）**；拖拽热区 10px 宽、悬停时边线亮起、悬停 300ms 出文字提示（按住拖拽时提示自动收起），拖拽过程中不会误选文字
- 新增 `scripts/run-ui.sh`：一条命令拉起 UI（`dev` 走 Vite 热更新、`dist` 走 vite build + electron-builder --dir），可选 `--debug`（CDP 调试端口）、`--fresh` / `--data-dir`（独立 profile，可与正在运行的正式版并存）、`--restart`；日志按时间戳落在 `~/.cache/netcatty-ui/<mode>-<时间戳>/`。脚本还会自动修复"npm 包只剩 locales/ 没有 Electron 二进制"这一常见残缺状态

### 修复
- **自建更新源的版本元数据改由主进程读取**：feed 主机普遍不返回 `Access-Control-Allow-Origin`（出厂默认的 GitHub release asset 地址就没有），渲染进程直接 fetch `<baseUrl>/latest.json` 会被 CORS / opaque response 规则拦掉 —— 看着像网络故障，其实文件本身是好的。现在主进程用 `net.fetch` 取回、只把解析后的载荷交给渲染层（`netcatty:update:fetchReleaseMetadata`）
- 开发模式下 dev server URL 只在主进程归一化一次：`VITE_DEV_SERVER_URL` 写 `127.0.0.1` / `0.0.0.0` / `::1` 时窗口实际加载的是 `localhost`，而插件桥的 trusted-sender 校验比的是**原始** URL 的 origin，于是把应用自己的渲染进程判为不可信，`netcatty:plugins:*` 全部抛 `Untrusted plugin management sender`（每个终端挂载/刷新都刷一条堆栈）
- Linux 桌面项身份统一：`package.json` 的 `desktopName` 与 electron-builder 的 `syncDesktopName` 让 app_id / WM_CLASS / `.desktop` 文件名都取 `netcatty`，不再出现"任务栏认不出运行中的窗口属于哪个启动项"（`StartupWMClass` 默认取 productName `Netcatty`，与文件名大小写不一致时会发生）

### 设计原理
- AI 面板的宽度计算是纯函数（`application/state/aiSidebarWidth.ts` + 单测）；拖拽期间用 raf 节流做预览、松手才写盘，持久化复用 `useStoredNumber` 的懒写机制，避免拖拽过程中刷 localStorage。面板元素同时带 `max-width: 70vw`，窗口变窄时由 CSS 兜底，主内容不会被挤没
- 拖拽期间开 `terminalLayoutSuppressStore`（与终端侧栏、主机树一致），终端的逐帧 re-fit 被推迟到松手之后
- 版本元数据 IPC 只接受"有效源"：请求里的 `baseUrl` 必须与主进程当前生效源一致（`requested === effective`）才发请求，渲染层即使被注入脚本也无法让主进程去打任意地址；响应体 2MB 上限、15s 超时
- dev server URL 归一化收敛到 `electron/devServerUrl.cjs` 一处实现，`main.cjs`（加载窗口前）、`windowManager.cjs`、插件桥共用：窗口实际加载的 origin 与所有 origin 比较必须永远是同一个值

## [1.1.88] - 2026-10-11

### 功能
- **Hermes 改走 ACP（Agent Client Protocol）**：侧栏现在能显示 Hermes 完整的工作过程 —— 思考块、工具调用与结果（包括它经 Netcatty MCP 调用的 `mcp__netcatty_remote_hosts__*` 工具）、以及真实 token 用量（in / out / cached / reasoning）。ACP 需要应答客户端侧请求（`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`session/request_permission`），驱动按 Netcatty 权限模式决定 allow/deny（观察模式直接拒绝）。不需要单独 `authenticate`，凭据仍来自 `~/.hermes/.env`
- **DeepSeek Harness（dsh）改为读取 `dsh headless --json` 的运行事件**：`thinking` → 思考块、`tool_call` / `tool_result` → 工具调用卡片、`status.step_end.usage` → 真实用量（含 cached）、`text` / `final` → 正文。首个非空白字节不是 `{` 时整轮回落为原来的纯文本转发，所以老版本 dsh 或非 headless profile 行为不变
- **侧栏权限模式（观察 / 确认 / 自动）现在会传给外部 Agent 自己的工具沙箱**：dsh 映射为 `DSH_PERMISSION_MODE`（`read-only` / `workspace-write` / `danger-full-access`，未知值一律回落 `workspace-write`，不会误放宽），Hermes 走 ACP 的 `session/request_permission`

### 修复
- 「检查更新」失败时自动重试两次（0.8s / 2.5s 退避，手动检查与后台自动检查都走这条），不再因为更新源"发布到一半"或代理瞬时抖动就抛一个笼统的 `Fail to fetch`
- 更新检查的错误现在带上具体原因（HTTP 状态码或错误码，例如 `Fail to fetch (HTTP 404)`、`(ERR_NAME_NOT_RESOLVED)`），便于区分是 feed 没发完还是网络问题

### 设计原理
- ACP 驱动复用仓库既有的通用 ACP 实现（`createJsonRpcClient`、`translateGrokAcpUpdate`、`toAcpMcpServers`、`buildGrokAcpPermissionResponse` 等），Hermes 专属部分只有 `usage_update` 映射、工具结果文本提取与客户端请求处理；grok 驱动未被改动
- dsh 的事件解析是独立纯函数 `createDshJsonParser`：按首个字节判定 JSON / 纯文本两种模式，思考与正文都按增量去重（上游给的是累积文本）
- `hermes acp` 启动失败、或建立 session 之前出错时回落到原来的 `hermes -z` oneshot 模式；session 已建立后的失败只报错、不重复跑（避免同一任务执行两遍）

### 已知限制
- dsh 这一路目前**没有**把 Netcatty 的 MCP 工具注入进它的回合（Hermes 有，因为 Hermes 自己的配置里注册了 `netcatty`），因此 dsh 只能用自带的 bash / 文件工具，操作不到终端会话；要接的话可以照 ACP 那套注入
- 确认模式下 dsh 需要提权时没有审批通道（`sandbox escalation to "workspace-write" requires approval, but no approval channel is available`），只能放弃；可以像 Catty / MCP 那样把这类请求接到应用内的批准弹窗
- ACP 回合不做模型切换：Hermes 使用自身配置的模型，侧栏选择模型对 ACP 回合不生效（模型列表仍来自 `hermes` 自身）

## [1.1.87] - 2026-10-11


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
