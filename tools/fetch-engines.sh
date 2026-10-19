#!/usr/bin/env bash
# =============================================================================
# Nova 多内核浏览器 —— 引擎抓取器
#
# 把可下载的内核程序拉到 native/engines/ 下（Trident 由系统 mshtml.dll 提供，不下载）。
#
#   bash tools/fetch-engines.sh              # 抓全部
#   bash tools/fetch-engines.sh --list       # 只看目标
#   bash tools/fetch-engines.sh --no-extract # 只下载，不解包
#
# 依赖：curl + tar(含 bz2) + unzip —— 都是系统自带，无 npm 依赖。
# 抓完跑 `node tools/check-engines.js` 校验并生成清单。
# =============================================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINES="$ROOT/native/engines"
DL="$ENGINES/_downloads"
mkdir -p "$DL"

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; OK=$'\033[32m'; BAD=$'\033[31m'
  WARN=$'\033[33m'; CY=$'\033[36m'; R=$'\033[0m'
else
  B=''; D=''; OK=''; BAD=''; WARN=''; CY=''; R=''
fi

ONLY=''; LIST_ONLY=0; DO_EXTRACT=1
for a in "$@"; do
  case "$a" in
    --only=*)     ONLY="${a#--only=}" ;;
    --list)       LIST_ONLY=1 ;;
    --no-extract) DO_EXTRACT=0 ;;
    -h|--help)    sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
  esac
done

# ---------------------------------------------------------------------------
# 版本钉死 —— 内核程序必须可复现，不追「最新」
# ---------------------------------------------------------------------------
CEF_VER='154.0.34'
CEF_CHROMIUM='154.0.8037.98'
CEF_TAG="cef_binary_${CEF_VER}+g14c5a08+chromium-${CEF_CHROMIUM}"

mb() { awk -v b="$1" 'BEGIN{printf "%.1f MB", b/1048576}'; }
banner() { printf '\n%s%s%s\n' "$B" "$1" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$OK" "$R" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$BAD" "$R" "$1"; }
info() { printf '  %s%s%s\n' "$D" "$1" "$R"; }
hint() { printf '    %s%s%s\n' "$D" "$1" "$R"; }

# ---------------------------------------------------------------------------
# 下载：断点续传；已完整则跳过
# ---------------------------------------------------------------------------
fetch() {
  local url="$1" out="$2" expect="$3"
  local have=0
  [ -f "$out" ] && have=$(wc -c < "$out" | tr -d ' ')

  if [ "$expect" != "0" ] && [ "$have" = "$expect" ]; then
    ok "已在本地且大小一致，跳过下载 $(mb "$have")"
    return 0
  fi

  local args=(-L --fail --retry 3 --retry-delay 2 --connect-timeout 20 -s -o "$out")
  if [ "$have" -gt 0 ]; then
    info "已有 $(mb "$have")，尝试断点续传…"
    args+=(-C -)
  fi

  if ! curl "${args[@]}" "$url"; then
    bad "下载失败：$url"
    return 1
  fi

  local got; got=$(wc -c < "$out" | tr -d ' ')
  if [ "$expect" != "0" ] && [ "$got" != "$expect" ]; then
    bad "大小不符：期望 $(mb "$expect")，实际 $(mb "$got")"
    return 1
  fi
  ok "下载完成 $(mb "$got")"
}

# ---------------------------------------------------------------------------
# 解包
# ---------------------------------------------------------------------------
extract_zip() {  # $1=归档 $2=目标目录
  local a="$1" d="$2"
  rm -rf "$d"; mkdir -p "$d"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$a" -d "$d" || { bad "unzip 解包失败"; return 1; }
  else
    # Windows 自带 bsdtar 也能解 zip
    tar -xf "$a" -C "$d" || { bad "tar 解包失败"; return 1; }
  fi
  ok "解包完成 → $(basename "$d")"
  return 0
}

extract_tar_bz2() {  # $1=归档 $2=目标目录（剥离顶层目录）
  local a="$1" d="$2"
  rm -rf "$d"; mkdir -p "$d"
  tar -xjf "$a" -C "$d" --strip-components=1 || { bad "tar.bz2 解包失败"; return 1; }
  ok "解包完成 → $(basename "$d")"
  return 0
}

# ---------------------------------------------------------------------------
# 目标清单
# ---------------------------------------------------------------------------
CEF_URL="https://cef-builds.spotifycdn.com/${CEF_TAG}_windows64_minimal.tar.bz2"

want() { [ -z "$ONLY" ] && return 0; [ "$ONLY" = "$1" ]; }

printf '\n%sNova 内核抓取器%s  %s→ %s%s\n' "$B" "$R" "$D" "$ENGINES" "$R"
printf '%s双内核：Chromium(Blink) / Trident(IE)%s\n' "$D" "$R"

banner '抓取目标'
for id in chromium-cef trident chromium-electron; do
  if want "$id"; then printf '  %s●%s %-20s\n' "$CY" "$R" "$id"
  else              printf '  %s○%s %s%-20s%s\n' "$D" "$R" "$D" "$id" "$R"; fi
done
[ "$LIST_ONLY" = 1 ] && { echo; exit 0; }

# 工具链预检
banner '[0] 工具链'
MISSING=''
for t in curl tar; do command -v "$t" >/dev/null 2>&1 || MISSING="$MISSING $t"; done
if [ -n "$MISSING" ]; then
  bad "缺少：$MISSING —— 无法继续"; exit 1
fi
ok "curl / tar 就绪$(command -v unzip >/dev/null 2>&1 && echo ' / unzip 就绪' || echo ' （无 unzip，改用 tar 解 zip）')"

FAILED=0

# ---------------------------------------------------------------------------
# [1] Chromium · CEF
# ---------------------------------------------------------------------------
if want chromium-cef; then
  banner '[1] Chromium · CEF 嵌入内核'
  info "CEF ${CEF_VER} / Chromium ${CEF_CHROMIUM}"
  info 'Chromium 官方可嵌入发行版。自带 cefclient.exe，解包即可独立运行验证。'
  INFO=$(curl -sIL --max-time 30 "$CEF_URL" | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n+0}')
  info "远端 $(mb "$INFO")"
  if fetch "$CEF_URL" "$DL/${CEF_TAG}_windows64_minimal.tar.bz2" "$INFO"; then
    [ "$DO_EXTRACT" = 1 ] && extract_tar_bz2 "$DL/${CEF_TAG}_windows64_minimal.tar.bz2" "$ENGINES/chromium-cef" || true
  else
    FAILED=$((FAILED+1))
  fi
fi

# ---------------------------------------------------------------------------
# [2] Trident —— 系统组件，不下载
# ---------------------------------------------------------------------------
if want trident; then
  banner '[2] Trident/IE · 系统组件'
  info 'IE 内核不是可下载的独立程序 —— 它就是系统里的 mshtml.dll，由 Windows 提供。'
  info '这里只登记，不下载任何东西。'
  for dll in '/c/Windows/System32/mshtml.dll' '/c/Windows/SysWOW64/mshtml.dll'; do
    if [ -f "$dll" ]; then
      ok "$(basename "$(dirname "$dll")")/mshtml.dll  $(mb "$(wc -c < "$dll" | tr -d ' ')")"
    else
      bad "$dll 不存在（非 Windows 或已裁减系统）"
    fi
  done
fi

# ---------------------------------------------------------------------------
# [3] Chromium · Electron —— npm 管理，这里只提示
# ---------------------------------------------------------------------------
if want chromium-electron; then
  banner '[3] Chromium · Electron 主内核 (npm 管理)'
  if [ -f "$ROOT/node_modules/electron/package.json" ]; then
    V=$(grep -o '"version": *"[^"]*"' "$ROOT/node_modules/electron/package.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    ok "Electron $V 已安装"
    hint "不是本脚本拉的，由 npm install 获取 —— 项目主渲染内核。"
  else
    bad '未安装 → 在项目根目录跑 npm install'
  fi
fi

# ---------------------------------------------------------------------------
banner '完成'
if [ "$FAILED" -gt 0 ]; then
  printf '  %s%d 个目标下载失败%s\n' "$WARN" "$FAILED" "$R"
else
  printf '  %s下载阶段无失败%s\n' "$OK" "$R"
fi
printf '  档案 → %s\n' "$(cd "$DL" && pwd)"
printf '\n  下一步：%snode tools/check-engines.js%s\n\n' "$CY" "$R"
