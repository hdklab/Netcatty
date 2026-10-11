#!/usr/bin/env bash
#
# run-ui.sh — 一键拉起 Netcatty UI（本地看效果 / 排查界面问题）
#
# 用法:
#   ./scripts/run-ui.sh               # dev 模式（默认）: Vite 热更新 + Electron，改代码即时生效
#   ./scripts/run-ui.sh dist          # 打包模式: vite build + electron-builder --dir 后启动 release/ 里的可执行文件
#   ./scripts/run-ui.sh dist --no-build   # 直接用上次的 release/ 构建启动（最快）
#
# 常用选项:
#   --port <n>         Vite 端口（默认 5173）
#   --debug[=端口]     开远程调试（默认 9222），配合 chrome://inspect 看渲染进程 console
#   --fresh           用一次性的临时 user-data-dir 启动（等同全新安装，用来复现首次启动/引导问题）
#   --data-dir <dir>  指定 user-data-dir（保留你自己的 hosts/设置）
#   --sandbox         启用 Chromium 沙箱（默认为关，因为本地 electron 的 chrome-sandbox 不是 setuid root）
#   --quiet           不把应用日志回显到终端（只写日志文件）
#   --restart         启动前先杀掉上一次由本脚本拉起的实例
#   -h | --help       帮助
#
# 日志: ~/.cache/netcatty-ui/<mode>-<时间戳>/  （另有 latest-dev / latest-dist 软链）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="dev"
VITE_HOST="localhost"   # 必须和主进程的 dev origin 一致：windowManager 会把 127.0.0.1 归一成 localhost
VITE_PORT="${NETCATTY_UI_PORT:-5173}"
DEBUG=0
DEBUG_PORT="${NETCATTY_UI_DEBUG_PORT:-9222}"
FRESH=0
DATA_DIR=""
DO_BUILD=1
USE_SANDBOX=0
QUIET=0
RESTART=0
EXTRA_ELECTRON_ARGS=()

usage() { awk 'NR==1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    dev|dist) MODE="$1"; shift ;;
    --dev) MODE="dev"; shift ;;
    --dist) MODE="dist"; shift ;;
    --port) VITE_PORT="${2:?--port 需要一个端口号}"; shift 2 ;;
    --port=*) VITE_PORT="${1#*=}"; shift ;;
    --debug) DEBUG=1; shift ;;
    --debug=*) DEBUG=1; DEBUG_PORT="${1#*=}"; shift ;;
    --fresh) FRESH=1; shift ;;
    --data-dir) DATA_DIR="${2:?--data-dir 需要一个路径}"; shift 2 ;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --sandbox) USE_SANDBOX=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --restart) RESTART=1; shift ;;
    --) shift; EXTRA_ELECTRON_ARGS+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) die_unknown="$1"; printf 'error: 未知参数 %s\n\n' "$die_unknown" >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m[ui]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ui]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ui] error:\033[0m %s\n' "$*" >&2; exit 1; }

LOG_ROOT="${NETCATTY_UI_LOG_DIR:-$HOME/.cache/netcatty-ui}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$LOG_ROOT/$MODE-$STAMP"
PID_FILE="$LOG_ROOT/$MODE.pids"
mkdir -p "$LOG_DIR"
ln -sfn "$LOG_DIR" "$LOG_ROOT/latest-$MODE"

VITE_LOG="$LOG_DIR/vite.log"
APP_LOG="$LOG_DIR/app.log"
VITE_PID=""
APP_PID=""

# ---------------------------------------------------------------- 基础检查

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1"; }

check_platform() {
  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) die "本脚本只支持 Linux/macOS（当前 $(uname -s)）；Windows 请用 npm run dev。" ;;
  esac
}

check_node() {
  require_cmd node
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 22 ]] || die "需要 Node >= 22，当前 v$major。"
  [[ -d "$ROOT/node_modules" ]] || die "先跑 npm ci 安装依赖。"
}

# Electron 的 npm 包偶尔会只剩 locales（二进制没下全），这里自动从本地缓存补回。
ensure_electron() {
  local bin="$ROOT/node_modules/electron/dist/electron"
  local win_bin="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [[ -x "$bin" || -x "$win_bin" ]]; then return 0; fi

  say "Electron 二进制缺失，尝试修复（先走 install.js，再用本地缓存包解压）"
  node "$ROOT/node_modules/electron/install.js" >"$LOG_DIR/electron-install.log" 2>&1 || true
  if [[ ! -x "$bin" && ! -x "$win_bin" ]]; then
    local version zip cache
    version="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
    cache="${ELECTRON_CACHE:-$HOME/.cache/electron}"
    zip="$(ls -1 "$cache"/*/"electron-v${version}-$(uname -s | tr '[:upper:]' '[:lower:]')-"*.zip 2>/dev/null | head -1 || true)"
    [[ -n "$zip" ]] || die "Electron 二进制缺失，本地缓存里也没有 electron-v$version 的包。联网后跑一次: npm rebuild electron"
    mkdir -p "$ROOT/node_modules/electron/dist"
    unzip -q -o "$zip" -d "$ROOT/node_modules/electron/dist"
    printf 'electron' > "$ROOT/node_modules/electron/path.txt"
    say "已从缓存恢复 Electron: $(basename "$zip")"
  fi
  local ok=0
  [[ -x "$bin" ]] && ok=1
  [[ -x "$win_bin" ]] && ok=1
  [[ "$ok" = 1 ]] || die "Electron 二进制仍然不可用，见 $LOG_DIR/electron-install.log"
}

port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  exec 3<&- 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
  return 0
}

kill_pid_if_ours() {
  local pid="$1" expect="$2"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local cmdline=""
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" == *"$ROOT"* || "$cmdline" == *"$expect"* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
}

stop_previous() {
  [[ -f "$PID_FILE" ]] || return 0
  say "结束上一次的 $MODE 实例"
  while read -r expect pid; do
    kill_pid_if_ours "$pid" "$expect"
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  sleep 0.5
}

cleanup() {
  local code=$?
  trap - INT TERM EXIT
  if [[ -n "$APP_PID" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "$VITE_PID" ]]; then kill "$VITE_PID" 2>/dev/null || true; fi
  if [[ -n "$APP_PID" ]]; then wait "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "$VITE_PID" ]]; then wait "$VITE_PID" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  exit "$code"
}

# ---------------------------------------------------------------- 启动参数

build_electron_args() {
  local -a args=(".")
  if [[ "$USE_SANDBOX" = 0 ]]; then args+=("--no-sandbox"); fi
  if [[ "$DEBUG" = 1 ]]; then args+=("--remote-debugging-port=$DEBUG_PORT"); fi
  if [[ -n "$DATA_DIR" ]]; then args+=("--user-data-dir=$DATA_DIR"); fi
  if [[ "${#EXTRA_ELECTRON_ARGS[@]}" -gt 0 ]]; then args+=("${EXTRA_ELECTRON_ARGS[@]}"); fi
  printf '%s\0' "${args[@]}"
}

resolve_data_dir() {
  if [[ "$FRESH" = 1 ]]; then
    DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/netcatty-ui-XXXXXX")"
    say "使用全新 profile: $DATA_DIR"
  fi
}

banner() {
  local target="$1"
  cat <<EOF

 netcatty UI 已启动
   target      : $target
   profile     : ${DATA_DIR:-默认（沿用你自己的 Netcatty 配置）}
   app log     : $APP_LOG
   vite log    : ${VITE_LOG}  (dev 模式)
   本次目录    : $LOG_DIR
   快捷链接    : $LOG_ROOT/latest-$MODE
EOF
  if [[ "$DEBUG" = 1 ]]; then
    cat <<EOF
   调试        : http://127.0.0.1:$DEBUG_PORT/json/list  （或 chrome://inspect）
EOF
  fi
  cat <<EOF
   停止        : 在终端里按 Ctrl+C
EOF
}

# ---------------------------------------------------------------- dev 模式

start_vite() {
  if port_busy "$VITE_PORT"; then
    warn "端口 $VITE_PORT 已被占用；先结束本脚本上一次的 vite，如仍占用请手动处理或换 --port。"
    stop_previous
    sleep 0.5
    port_busy "$VITE_PORT" && die "端口 $VITE_PORT 仍被占用（ss -ltnp | grep $VITE_PORT 查一下）。"
  fi
  say "启动 Vite（http://$VITE_HOST:$VITE_PORT）"
  ( exec "$ROOT/node_modules/.bin/vite" --port "$VITE_PORT" --strictPort --host "$VITE_HOST" ) \
    >"$VITE_LOG" 2>&1 &
  VITE_PID=$!
}

wait_vite() {
  local i
  for i in $(seq 1 120); do
    if port_busy "$VITE_PORT"; then return 0; fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then
      warn "Vite 退出了，日志尾部:"
      tail -n 30 "$VITE_LOG" >&2 || true
      die "Vite 启动失败（完整日志: $VITE_LOG）"
    fi
    sleep 0.5
  done
  warn "Vite 日志尾部:"; tail -n 30 "$VITE_LOG" >&2 || true
  die "等待 Vite 超时（$VITE_LOG）"
}

start_dev() {
  ensure_electron
  resolve_data_dir
  wait_vite_ok=0
  start_vite
  wait_vite
  mapfile -d '' -t args < <(build_electron_args)
  say "启动 Electron（dev，热更新已开）"
  if [[ "$QUIET" = 1 ]]; then
    VITE_DEV_SERVER_URL="http://$VITE_HOST:$VITE_PORT" node "$ROOT/electron/launch.cjs" "${args[@]}" \
      >>"$APP_LOG" 2>&1 &
  else
    VITE_DEV_SERVER_URL="http://$VITE_HOST:$VITE_PORT" node "$ROOT/electron/launch.cjs" "${args[@]}" \
      > >(tee -a "$APP_LOG") 2>&1 &
  fi
  APP_PID=$!
  printf 'vite %s\nelectron %s\n' "$VITE_PID" "$APP_PID" > "$PID_FILE"
  banner "dev (Vite :$VITE_PORT + Electron)"
  wait "$APP_PID" || true
}

# ---------------------------------------------------------------- dist 模式

dist_binary() {
  case "$(uname -s)" in
    Linux)  printf '%s' "$ROOT/release/linux-unpacked/netcatty" ;;
    Darwin) printf '%s' "$ROOT/release/mac/Netcatty.app/Contents/MacOS/Netcatty" ;;
  esac
}

build_dist() {
  say "构建渲染层（npm run build）"
  npm run build >"$LOG_DIR/build.log" 2>&1 || { tail -n 40 "$LOG_DIR/build.log" >&2; die "构建失败，见 $LOG_DIR/build.log"; }
  say "打包成可执行目录（electron-builder --dir，通常 1~3 分钟）"
  NODE_OPTIONS=--disable-warning=DEP0190 npx electron-builder --config electron-builder.config.cjs --dir --publish=never \
    >>"$LOG_DIR/build.log" 2>&1 || { tail -n 40 "$LOG_DIR/build.log" >&2; die "打包失败，见 $LOG_DIR/build.log"; }
}

start_dist() {
  resolve_data_dir
  local bin
  bin="$(dist_binary)"
  if [[ "$DO_BUILD" = 1 ]]; then
    build_dist
  elif [[ ! -x "$bin" ]]; then
    die "没有现成构建（$bin 不存在）。去掉 --no-build 重新跑。"
  fi
  [[ -x "$bin" ]] || die "找不到可执行文件: $bin"
  mapfile -d '' -t args < <(build_electron_args)
  args=("${args[@]:1}")   # dist 模式不要 "." 这个参数
  say "启动打包版: $bin"
  if [[ "$QUIET" = 1 ]]; then
    "$bin" "${args[@]}" >>"$APP_LOG" 2>&1 &
  else
    "$bin" "${args[@]}" > >(tee -a "$APP_LOG") 2>&1 &
  fi
  APP_PID=$!
  printf '%s %s\n' "$bin" "$APP_PID" > "$PID_FILE"
  banner "dist ($bin)"
  wait "$APP_PID" || true
}

# ---------------------------------------------------------------- main

check_platform
check_node
[[ "$RESTART" = 1 ]] && stop_previous
trap cleanup INT TERM EXIT

case "$MODE" in
  dev)  start_dev ;;
  dist) start_dist ;;
esac

say "应用已退出。日志: $APP_LOG"
