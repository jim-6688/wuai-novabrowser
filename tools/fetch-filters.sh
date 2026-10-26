#!/usr/bin/env bash
# ============================================================================
# Nova 过滤规则抓取器
# ----------------------------------------------------------------------------
# 下载三个拦截源所需的上游规则文件到 assets/filters/，并生成 sources.json 描述。
#
# 为什么用 bash：本环境的 Node 子进程被沙箱禁止（child_process 一律 EBUSY），
# 所以「下载 + 解包」交给 bash，「校验 + 清单」交给纯 Node（tools/check-filters.js）。
#
# 用法：
#   bash tools/fetch-filters.sh              # 抓取全部
#   bash tools/fetch-filters.sh --only=abp   # 仅抓某一源
#   bash tools/fetch-filters.sh --force      # 忽略已存在的文件，强制重下
# ============================================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
OUT="assets/filters"
mkdir -p "$OUT"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

ONLY=""
FORCE=0
for a in "$@"; do
  case "$a" in
    --only=*) ONLY="${a#--only=}" ;;
    --force)  FORCE=1 ;;
  esac
done

pass=0; fail=0; skip=0

# 记录每个文件「实际命中的镜像地址」，供引擎在界面上如实展示来源
MIRRORS_TMP="$OUT/.mirrors.tmp"
cp -f "$OUT/_mirrors.txt" "$MIRRORS_TMP" 2>/dev/null || : > "$MIRRORS_TMP"

# ---------------------------------------------------------------------------
# fetch <源id> <目标文件名> <url> [备用url...]
# 逐个 URL 尝试，第一个成功的写入目标文件；全部失败则记为 FAIL。
# ---------------------------------------------------------------------------
fetch() {
  local src="$1"; local name="$2"; shift 2
  local dest="$OUT/$name"

  if [ -n "$ONLY" ] && [ "$ONLY" != "$src" ]; then return 0; fi

  if [ -s "$dest" ] && [ "$FORCE" -eq 0 ]; then
    printf '  %-9s %-30s %s\n' "[跳过]" "$name" "$(wc -l < "$dest" | tr -d ' ') 行已存在"
    skip=$((skip+1)); return 0
  fi

  local tmp="$dest.part"
  for url in "$@"; do
    printf '  %-9s %-30s ' "[下载]" "$name"
    local code
    code=$(curl -sL --fail --retry 2 --retry-delay 2 --max-time 120 \
                -A "$UA" -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null)
    if [ "$code" = "200" ] && [ -s "$tmp" ]; then
      local bytes lines
      bytes=$(wc -c < "$tmp" | tr -d ' ')
      lines=$(wc -l < "$tmp" | tr -d ' ')
      # 规则文件必须够大，避免把错误页/截断响应当成规则
      if [ "$bytes" -lt 2000 ]; then
        printf '内容过小(%s B)，换源\n' "$bytes"
        continue
      fi
      mv "$tmp" "$dest"
      printf '%s\t%s\n' "$name" "$url" >> "$MIRRORS_TMP"
      printf 'OK  %s B / %s 行\n' "$bytes" "$lines"
      printf '           %s\n' "$url"
      pass=$((pass+1)); return 0
    else
      printf 'HTTP=%s，换源\n' "${code:-000}"
    fi
  done

  rm -f "$tmp"
  printf '  %-9s %-30s 所有源均不可达\n' "[失败]" "$name"
  fail=$((fail+1)); return 1
}

echo
echo "Nova 过滤规则抓取  ->  $OUT"
echo "======================================================================"

# --- 源 1：广告终结者 -------------------------------------------------------
# 官方 sub.adtchrome.com 已于 2026 停服（实测 502 upstream connect failed）。
# 其规则定位是「ChinaList + EasyList 的修正维护版」，因此用同血统的
# ChinaList 2.0 + CJX's Annoyance List 还原其覆盖面。
echo
echo "[1] 广告终结者（AdtChrome · ChinaList+EasyList 修正）"
fetch adtchrome "adt-chinalist-easylist.txt" \
  "http://sub.adtchrome.com/adt-chinalist-easylist.txt" \
  "https://sub.adtchrome.com/adt-chinalist-easylist.txt" \
  "https://cdn.jsdelivr.net/gh/Zsy-2014/ChinaList2.0@master/ChinaList2.0.txt"
fetch adtchrome "adt-annoyance.txt" \
  "https://cdn.jsdelivr.net/gh/cjx82630/cjxlist@master/cjx-annoyance.txt"

# --- 源 2：Adblock Plus -----------------------------------------------------
# EasyList 官方站 easylist.to 直连可用，但曾出现响应截断；
# filters.adtidy.org 是 AdGuard 维护的官方分发镜像，稳定且为完整版。
echo
echo "[2] Adblock Plus（EasyList 官方规则）"
fetch abp "easylist.txt" \
  "https://filters.adtidy.org/extension/chromium/filters/101.txt" \
  "https://easylist.to/easylist/easylist.txt"
fetch abp "easylist-china.txt" \
  "https://filters.adtidy.org/extension/chromium/filters/104.txt"
fetch abp "easyprivacy.txt" \
  "https://filters.adtidy.org/extension/chromium/filters/118.txt" \
  "https://easylist.to/easylist/easyprivacy.txt"

echo
echo "======================================================================"
printf '完成：成功 %s / 跳过 %s / 失败 %s\n' "$pass" "$skip" "$fail"

# 去重落盘（同名文件保留一个镜像地址）
sort -u "$MIRRORS_TMP" -o "$OUT/_mirrors.txt" 2>/dev/null && rm -f "$MIRRORS_TMP"
printf '镜像溯源写入 %s（%s 条）\n' "$OUT/_mirrors.txt" "$(wc -l < "$OUT/_mirrors.txt" | tr -d ' ')"
echo

if [ "$fail" -gt 0 ]; then exit 1; fi
