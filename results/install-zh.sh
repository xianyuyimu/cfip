#!/usr/bin/env bash
# ============================================================
# 3x-ui 中文菜单 —— 一次装上, 永久生效
#   /usr/local/bin/x-ui  (wrapper, 每次执行时实时汉化上游脚本)
#   /etc/3xui-zh/zhify.py (汉化引擎)
#   /etc/3xui-zh/upstream.sh (上游原始脚本缓存)
#   /usr/local/bin/x-ui-zh-* (管理命令)
#
# 升级/更新菜单时上游会覆盖 /usr/bin/x-ui, 但那只是原始脚本,
# 用户敲的 x-ui 永远走 wrapper, 所以汉化不会丢。
# ============================================================
set -uo pipefail

ZDIR=/etc/3xui-zh
UPSTREAM=/usr/bin/x-ui
WRAPPER=/usr/local/bin/x-ui
RAW_MAIN="https://raw.githubusercontent.com/MHSanaei/3x-ui/main/x-ui.sh"

R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[0;34m'; P='\033[0m'
ok()   { echo -e "${G}[✓]${P} $*"; }
warn() { echo -e "${Y}[!]${P} $*"; }
err()  { echo -e "${R}[✗]${P} $*" >&2; }

[[ $EUID -ne 0 ]] && { err "请用 root 运行"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"

# ---------- 1. 汉化引擎 ----------
install -d "$ZDIR"
if [[ -f "$HERE/zhify.py" ]]; then
    install -m 0644 "$HERE/zhify.py" "$ZDIR/zhify.py"
else
    err "缺少 zhify.py, 请把它和本脚本放在同一目录"
    exit 1
fi
ok "汉化引擎已安装: $ZDIR/zhify.py"

# ---------- 2. 备份现状 ----------
if [[ -f "$WRAPPER" ]] && ! grep -q "3xui-zh wrapper" "$WRAPPER" 2>/dev/null; then
    cp -f "$WRAPPER" "$WRAPPER.bak.$(date +%s)"
    warn "已备份原 $WRAPPER"
fi
if [[ -f "$UPSTREAM" ]] && [[ ! -f "$ZDIR/original-x-ui.sh" ]]; then
    cp -f "$UPSTREAM" "$ZDIR/original-x-ui.sh"
fi

# ---------- 3. wrapper ----------
cat > "$WRAPPER" << 'WRAPEOF'
#!/usr/bin/env bash
# 3xui-zh wrapper —— 实时汉化上游脚本后执行
ZH_DIR=/etc/3xui-zh
UPSTREAM=/usr/bin/x-ui
CACHE=$ZH_DIR/upstream.sh
RAW_MAIN="https://raw.githubusercontent.com/MHSanaei/3x-ui/main/x-ui.sh"

# 解析应使用的上游脚本地址(与上游 installed_script_url 同逻辑)
pick_url() {
    local ver=""
    if [[ -x /etc/x-ui/x-ui ]]; then
        ver=$(/etc/x-ui/x-ui -v 2>/dev/null | tr -d '[:space:]')
    fi
    if [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        local u="https://raw.githubusercontent.com/MHSanaei/3x-ui/v${ver}/x-ui.sh"
        if curl -fsIL -o /dev/null --max-time 8 "$u" 2>/dev/null; then
            echo "$u"; return
        fi
    fi
    echo "$RAW_MAIN"
}

# 缓存有效期 10 分钟, 避免每次执行都联网
need_fetch=1
if [[ -s "$CACHE" ]] && [[ -f /etc/x-ui/x-ui ]]; then
    ver_now=$(/etc/x-ui/x-ui -v 2>/dev/null | tr -d '[:space:]')
    ver_cached=$(head -3 "$CACHE" | grep -oE '3xui-zh-cache-v[0-9.]+' | sed 's/.*-v//')
    age=$(( $(date +%s) - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0) ))
    [[ "$ver_now" == "$ver_cached" && $age -lt 600 ]] && need_fetch=0
fi

if [[ $need_fetch -eq 1 ]]; then
    url=$(pick_url)
    tmp=$(mktemp /tmp/xui-zh.XXXXXX)
    if curl -fsSL --max-time 20 -o "$tmp" "$url" && [[ -s "$tmp" ]]; then
        ver_now=$(/etc/x-ui/x-ui -v 2>/dev/null | tr -d '[:space:]' || echo "")
        { echo "# 3xui-zh-cache-v${ver_now} $url"; cat "$tmp"; } > "$CACHE"
        rm -f "$tmp"
    else
        rm -f "$tmp"
        # 拉取失败: 用已有缓存, 没缓存就用本地原始脚本
        [[ -s "$CACHE" ]] || {
            if [[ -f "$UPSTREAM" ]]; then
                cp -f "$UPSTREAM" "$CACHE"
            else
                echo "x-ui 未安装, 且无法获取脚本" >&2; exit 1
            fi
        }
    fi
fi

# 去掉首行缓存标记
raw=$(mktemp /tmp/xui-raw.XXXXXX)
sed '1{/^# 3xui-zh-cache-v/d}' "$CACHE" > "$raw"
zh=$(mktemp /tmp/xui-zh-out.XXXXXX)

# bash -n 只查语法; 上游改结构可能汉化后仍"语法合法"却行为错乱,
# 这里额外校验关键锚点是否还在, 确保汉化确实作用在正确的脚本上
anchor_ok=1
# x-ui.sh 的结构特征: 管理菜单函数 + 子命令分支
grep -q 'show_menu' "$raw" || anchor_ok=0
grep -q 'check_install' "$raw" || anchor_ok=0

if [[ $anchor_ok -eq 1 ]] && python3 "$ZH_DIR/zhify.py" "$raw" "$zh" 2>/dev/null && bash -n "$zh" 2>/dev/null; then
    chmod +x "$zh"
    "$zh" "$@"; rc=$?
    rm -f "$raw" "$zh"
    exit $rc
else
    # 汉化或语法检查失败: 直接跑原始脚本, 保证功能不残
    echo -e "\033[0;33m[!] 汉化失败, 本次以原版运行 (可执行 x-ui-zh-fix 修复)\033[0m" >&2
    bash "$raw" "$@"; rc=$?
    rm -f "$raw" "$zh"
    exit $rc
fi
WRAPEOF
chmod +x "$WRAPPER"
ok "wrapper 已安装: $WRAPPER"

# ---------- 4. 管理命令 ----------
cat > /usr/local/bin/x-ui-zh-fix << 'FIXEOF'
#!/usr/bin/env bash
# 强制重新拉取上游脚本并汉化, 并检查汉化后语法
set -u
Z=/etc/3xui-zh
ver=$(/etc/x-ui/x-ui -v 2>/dev/null | tr -d '[:space:]')
url="https://raw.githubusercontent.com/MHSanaei/3x-ui/v${ver}/x-ui.sh"
curl -fsIL -o /dev/null --max-time 8 "$url" 2>/dev/null || url="https://raw.githubusercontent.com/MHSanaei/3x-ui/main/x-ui.sh"
rm -f "$Z/upstream.sh"
echo "拉取: $url"
if ! curl -fsSL --max-time 30 -o /tmp/_up.sh "$url"; then echo "下载失败"; exit 1; fi
{ echo "# 3xui-zh-cache-v${ver} $url"; cat /tmp/_up.sh; } > "$Z/upstream.sh"
rm -f /tmp/_up.sh
x-ui > /dev/null 2>&1 || true
echo "已刷新 (缓存已重建)"
FIXEOF
chmod +x /usr/local/bin/x-ui-zh-fix

cat > /usr/local/bin/x-ui-zh-off << 'OFFEOF'
#!/usr/bin/env bash
# 临时切回原版(直接执行上游脚本), 不卸载
exec /usr/bin/x-ui "$@"
OFFEOF
chmod +x /usr/local/bin/x-ui-zh-off

cat > /usr/local/bin/x-ui-zh-uninstall << 'UNEOF'
#!/usr/bin/env bash
# 彻底移除中文包装, 恢复原版
set -u
[[ $EUID -ne 0 ]] && { echo "请用 root 运行"; exit 1; }
if [[ -f /etc/3xui-zh/original-x-ui.sh ]]; then
    cp -f /etc/3xui-zh/original-x-ui.sh /usr/local/bin/x-ui
    echo "已恢复原版 wrapper"
else
    rm -f /usr/local/bin/x-ui
    echo "已移除 wrapper"
fi
rm -f /usr/local/bin/x-ui-zh-off /usr/local/bin/x-ui-zh-uninstall /usr/local/bin/x-ui-zh-fix
rm -rf /etc/3xui-zh
echo "卸载完成, x-ui 回到官方原版 (中文菜单仍可用 x-ui-zh-on 重新安装)"
UNEOF
chmod +x /usr/local/bin/x-ui-zh-uninstall
ok "管理命令: x-ui-zh-fix / x-ui-zh-off / x-ui-zh-uninstall"

# ---------- 5. 自检 ----------
if [[ ! -x "$UPSTREAM" ]]; then
    warn "未检测到 $UPSTREAM (面板可能还没装), wrapper 已就位, 装完后直接敲 x-ui 即可"
else
    if bash "$WRAPPER" status > /dev/null 2>&1; then
        ok "自检通过: x-ui 中文版可正常运行"
    else
        warn "自检未通过, 请运行 x-ui-zh-fix 查看详情"
    fi
fi

echo
echo -e "${B}════════ 安装完成 ════════${P}"
echo "  直接敲  ${G}x-ui${P}        进入中文菜单"
echo "  ${Y}x-ui-zh-fix${P}     强制刷新汉化 (上游更新后使用)"
echo "  ${Y}x-ui-zh-off${P}     临时用原版英文 (透传给官方脚本)"
echo "  ${Y}x-ui-zh-uninstall${P} 卸载汉化"
echo -e "${B}═══════════════════════════${P}"
