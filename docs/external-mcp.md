# 对外 MCP（External MCP）与外部 Agent 接入

> 一句话结论：Netcatty 的「对外 MCP」已在本机验证可用——Hermes（本机 AI agent）能通过它读取
> 保险箱、打开会话、执行终端命令、读写 SFTP 文件。本文记录开启方式、发现文件、工具清单、
> 权限语义、已知限制，以及本次实测的证据。

## 1. 它是什么

设置 → AI → **对外 MCP** 把 Netcatty 变成一台 **本机 MCP 服务器**（`netcatty-remote-hosts`），
供 Codex / Claude Code / Cursor / Grok / Hermes 等外部客户端接入，工具面与应用内 Agent 相同：
终端、SFTP、Vault、端口转发、片段、脚本、附件。

- 只监听 **127.0.0.1**，使用轮换 token，不做 OAuth（本机桌面桥接，非公网服务）。
- **客户端连接期间必须保持 Netcatty 运行**。关闭开关会删除 discovery 文件，客户端随即失联。
- 写操作复用 设置 → AI → 安全 的权限模式（观察 / 确认 / 自动）以及命令黑名单。
- 密码与私钥**不会**通过 MCP 返回。

## 2. 开启与模式（设置 → AI → 对外 MCP）

| 选项 | 含义 |
|------|------|
| 可用模式：临时 | 空闲超时后自动关闭对外 MCP |
| 可用模式：常开 | Netcatty 启动时自动恢复对外 MCP |
| 空闲超时 | 临时模式下，超过该分钟数无 MCP 操作即自动关闭 |
| host_open 时激活窗口 | MCP 客户端打开主机时把主窗口切到前台；关闭可无打扰继续手头工作 |
| AI 会话静默运行 | AI 打开的会话不出现在标签栏、重启不恢复，可在托盘面板查看 |
| 已打开会话空闲超时 | AI 打开的会话超过该分钟数无终端/文件操作即自动关闭 |
| 写操作权限模式 | 与「设置 → AI → 安全」同一项：自动=不再弹本应用审批；确认=每次询问 |

设置页本身会显示并允许复制 **Launcher**（启动脚本路径）与 **Discovery**（发现文件路径），
还提供一段可直接粘进客户端的注册提示词。

## 3. 发现文件（Discovery）

应用运行且开关打开时写入，关闭即删除。

本机实测（Linux）：

```
~/.config/netcatty/external-mcp/discovery.json     # 对外 MCP
~/.config/netcatty/netcatty-tool-cli/discovery.json # 内部 CLI / Skills 模式（另一条链路）
```

字段（外部 MCP）：`version` / `host` / `port` / `token` / `pid` / `permissionMode` /
`chatSessionId` / `updatedAt`。
字段（tool-cli）：`port` / `token` / `pid` / `permissionMode` / `updatedAt`。

本次实测值（token 已隐去）：外部 MCP = `{"version": 1, "host": "127.0.0.1", "port": 36055, "token": "[REDACTED]", "pid": 129997, "permissionMode": "auto", "chatSessionId": "__external_mcp__", "updatedAt": "2026-10-11T00:40:04.846Z"}`；tool-cli = `{"port": 36055, "token": "[REDACTED]", "pid": 129997, "permissionMode": "auto"}`。

> `token` 是本机凭据，不要粘贴到聊天/issue/日志里。macOS 对应路径在
> `~/Library/Application Support/<productName>/`，Windows 在 `%APPDATA%\<productName>\`。

## 4. 接入方式

### 4.1 Hermes（已配置完成）

```bash
hermes mcp add netcatty --command node \
  --args /home/hongdayu/workspace/Netcatty/electron/mcp/netcatty-external-mcp-server.cjs
# 交互提示 “Enable all 15 tools?” 选 Y（非交互：printf 'Y\n' | hermes mcp add ...）
hermes mcp list        # netcatty ✓ enabled
```

- 配置落在 `~/.hermes/config.yaml`（`mcp_servers.netcatty`）。
- 新会话自动带上这些工具；**当前已打开的会话**用 `/reload-mcp` 立即加载。
- 工具太多想精简：`hermes mcp configure netcatty`（按需勾选），或 `hermes mcp test netcatty` 复测连通性。

### 4.2 通用 MCP 客户端（stdio）

任何支持 stdio MCP 的客户端都能用同一个 launcher（它自己读取 discovery、注入端口与 token）：

```json
{
  "mcpServers": {
    "netcatty": {
      "command": "node",
      "args": ["<repo>/electron/mcp/netcatty-external-mcp-server.cjs"]
    }
  }
}
```

打包版路径在 `app.asar.unpacked/electron/mcp/netcatty-external-mcp-server.cjs`；
最省事的做法是直接从设置页复制 **Launcher** 路径。

## 5. 工具清单

### 5.1 默认暴露的 15 个

| 工具 | 作用 |
|------|------|
| `get_environment` | 列出作用域内会话 + 返回操作指南（先调用它） |
| `load_netcatty_tools` | 按 toolset 加载更多工具（见 5.2） |
| `host_open` | 打开保险箱主机 → 新建标签并连接，返回 `sessionId` |
| `session_close` | 关闭由 `host_open` 打开的会话 |
| `terminal_execute` | 在指定会话执行短命令并等结果（`sessionId`, `command`） |
| `terminal_start` | 在指定会话启动长跑命令（同上） |
| `terminal_poll` | 增量读取长跑命令输出 |
| `terminal_stop` | 停止长跑命令 |
| `terminal_read_context` | 读取终端屏幕/回滚缓冲的有限片段 |
| `sftp_list` | 列远程目录 |
| `sftp_read_file` / `sftp_write_file` | 读写远程文件 |
| `sftp_download` / `sftp_upload` | 下载 / 上传 |
| `vault_hosts_list` | 列保险箱主机（仅元数据，无密码/私钥） |

### 5.2 按需加载的 toolset（`load_netcatty_tools`）

`attachments` · `sftp_advanced` · `vault_hosts` · `vault_notes` · `snippets` · `scripts` ·
`portforward` · `all`

展开后新增（`all` 实测，输出约 50+ 条，此处为前缀部分）：
`list_attachments`、`read_attachment`、`ftp_upload`、`sftp_stat/home/mkdir/delete/rename/chmod`、
`host_get`、`vault_hosts_create/update/delete/import`、`host_notes_get/set`、
`vault_identities_list`、`vault_proxy_profiles_list`、`vault_groups_list/create/update/delete`、
`vault_notes_list/get/create/update/delete/import`、
`snippets_list/get/run/create/update/delete`、`scripts_list/get/create` …

> 完整清单以 `load_netcatty_tools {"toolset":"all"}` 的返回为准。

#### `ftp_upload`（toolset `sftp_advanced`）

给**没有 SFTP 的主机**（telnet / 串口设备）用的 FTP/FTPS 上传，走主进程内置的 `basic-ftp` 客户端
（不需要在本机安装任何外部程序）：

```
ftp_upload { host, port?, user?, password?, secure?, insecure?, remoteDir?, files, timeoutMs? }
```

- `files`：本地文件路径，支持 JSON 数组或逗号/换行分隔（上传的是**本机**文件，主进程直接读盘）。
- `secure: "true"` → FTPS（显式 TLS）；自签证书再传 `insecure: "true"`。
- **凭据必须显式传**：保险箱里的主机密码在渲染层，主进程按设计读不到（`vault_hosts_list`
  也只返回元数据）。要么在参数里给 `user/password`，要么在应用里用终端拖拽（那条路能读到保险箱）。
- 连不上或登录失败时返回 `{ ok:false, code }`：`EAUTH`（530）、`ENOENT`（550）、`ETIMEDOUT`、`ENOTFOUND` 等。
- 该能力 `policy.write = true`：确认模式会请求批准，观察模式直接拒绝。

## 6. 本次实测记录（本机，应用为 `release/linux-unpacked` 打包版）

| 步骤 | 结果 |
|------|------|
| `initialize` | `netcatty-remote-hosts v1.0.0` |
| `tools/list` | 15 个基础工具 |
| `get_environment` | 返回环境说明（终端/SFTP/Vault/串口/网络设备会话的用法与路由规则） |
| `vault_hosts_list` | `{"ok": true, "hosts": []}`（本机这个 profile 保险箱为空） |
| `load_netcatty_tools {"toolset":"all"}` | 成功展开 catalog 工具（见 5.2） |
| `hermes mcp add netcatty ...` | ✓ 15/15 工具启用，写入 `~/.hermes/config.yaml` |

自测脚本（本机 Hermes 侧的临时探针，可直接复用）：

```bash
node ~/.hermes/cache/scratch/nc-mcp-client.mjs              # 握手 + tools/list
node ~/.hermes/cache/scratch/nc-mcp-client.mjs all          # 打印全部工具名
node ~/.hermes/cache/scratch/nc-mcp-client.mjs schemas terminal_execute,host_open
node ~/.hermes/cache/scratch/nc-mcp-client.mjs call vault_hosts_list '{}'
```

## 7. 已知限制与坑

1. **没有“新建本地终端”工具**：`terminal_execute/start/poll/stop/read_context` 都需要已存在的
   `sessionId`。取得会话的两条路：在应用里手动开一个终端，或用 `host_open` 打开保险箱主机
   （保险箱为空时这条不通）。
2. 应用必须在运行且开关打开；关掉开关 = discovery 被删 = 客户端连接失败
   （launcher 会提示 “Enable External MCP in Netcatty Settings → AI and keep the app running”）。
3. 会话作用域：`get_environment` 只列当前作用域内会话；AI 打开的会话默认静默（不进标签栏），
   可在托盘面板查看，受会话空闲超时约束。
4. Hermes 侧：工具清单在 `~/.hermes/config.yaml`；新增/修改后要么开新会话，要么 `/reload-mcp`。
5. 打包版与源码版的 launcher 路径不同（`app.asar.unpacked` 内），但读的是同一个 discovery。

## 8. 相关代码位置

- `electron/mcp/netcatty-external-mcp-server.cjs` — 外部 MCP 启动引导（读 discovery、注入 env、加载 stdio server）
- `electron/mcp/netcatty-mcp-server.cjs` — catalog 驱动的 stdio MCP 实现
- `electron/cli/externalMcpDiscoveryPath.cjs` / `externalMcpDiscovery.cjs` — 发现文件的路径解析与读写
- `electron/cli/discoveryPath.cjs` — tool-cli（内部 CLI / Skills 模式）发现文件
- 设置界面文案：`application/i18n/locales/<locale>/ai.ts` 的 `ai.externalMcp.*`
