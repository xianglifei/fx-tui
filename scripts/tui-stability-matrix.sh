#!/bin/bash
# fx-tui 底部输入框稳定性真机测试矩阵（tmux + capture-pane + 溢出日志）
#
# 被测不变量：
#   I1  splash 阶段输入框底边框(╰)在第 rows-2 行（filler 预算含 1 行 trailing
#       row，故不是 rows-1）；滚动阶段允许 ±1 行浮动的钉底
#   I2  splash 阶段 banner 顶边框(╭)在第 1 行（无物理滚动）
#   I3  相对用例前基线，frame-overflow 日志增量为 0
#   I4  稳定后连续两次抓屏逐字节一致（无振荡/抖动）
#
# 密封性：场景组之间重启 fx 会话——TC6 这类溢出会把 ink 光标模型永久打歪
# （bug 家族特性：永不自愈），必须隔离，不能让后续用例继承坏基线。
#
# 前提：tmux、fx 全局可用（仓库 link 安装）、python3。
# 用法：scripts/tui-stability-matrix.sh [cols rows]（默认 80 30）。退出码 = 失败断言数。
# 滚动阶段的底边框位置受 stock ink 结构性失步限制（docs/ui-research-2026-08.md 第五节），
# 相关断言记为 INFO 观测值，不计入成败。

set -u
COLS=${1:-80}
ROWS=${2:-30}
WORK=/tmp/fx-layout-tests
DEBUG_LOG=/tmp/fx-debug.log
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SESSION=fxv
PASS=0; FAIL=0

mkdir -p "$WORK"; : > "$WORK/results.txt"

cap()        { tmux capture-pane -t "$SESSION" -p; }
bottom_row() { cap | grep -n '^╰' | tail -1 | cut -d: -f1; }
banner_row() { cap | grep -n '^╭' | head -1 | cut -d: -f1; }
overflows() {
  if [ -f "$DEBUG_LOG" ]; then grep -c frame-overflow "$DEBUG_LOG" || true; else echo 0; fi
}

start_session() {  # <cols> <rows>
  tmux kill-server 2>/dev/null; sleep 0.5; rm -f "$DEBUG_LOG"
  tmux new-session -d -x "$1" -y "$2" -s "$SESSION" -c "$REPO" "FX_TUI_DEBUG=1 fx"
  sleep 8
}
record() {
  if [ "${4:-}" = "info" ]; then
    if eval "$3" >/dev/null 2>&1; then
      echo "INFO-OK  $1  $2" >> "$WORK/results.txt"
    else
      echo "INFO  $1  $2（结构性限制观测值，不计成败）" >> "$WORK/results.txt"
    fi
    return
  fi
  if eval "$3" >/dev/null 2>&1; then
    echo "PASS  $1  $2" >> "$WORK/results.txt"; PASS=$((PASS+1))
  else
    echo "FAIL  $1  $2" >> "$WORK/results.txt"; FAIL=$((FAIL+1))
  fi
}
check_case() {  # <case> <期望底行> <期望banner行|0=跳过> [滚动容差]
  local c="$1" wb="$2" wban="$3" tol="${4:-0}" info="${5:-}" b
  b=$(bottom_row)
  if [ "$tol" = "0" ]; then
    record "$c" "I1 底边框=$b 期望$wb"      "[ '$b' = '$wb' ]" "$info"
  else
    record "$c" "I1 底边框=$b 期望$((wb-tol))~$((wb+tol))" "[ '$b' -ge '$((wb-tol))' ] && [ '$b' -le '$((wb+tol))' ]" "$info"
  fi
  [ "$wban" != "0" ] && record "$c" "I2 banner=$(banner_row) 期望$wban" "[ \"\$(banner_row)\" = '$wban' ]"
  record "$c" "I4 屏幕稳定(双抓一致)" "{ cap > $WORK/n.txt; sleep 0.4; cap > $WORK/l.txt; diff -q $WORK/n.txt $WORK/l.txt; }"
}
check_overflow() { record "$1" "I3 无新增溢出(基线$2)" "[ \"\$(overflows)\" = '$2' ]"; }

paste()     { tmux load-buffer -b fxp "$1" && tmux paste-buffer -t "$SESSION:0.0" -b fxp -p; }
type_text() { tmux send-keys -t "$SESSION" -l "$1"; }
settle()    { sleep "${1:-1.5}"; }
clear_editor() { type_text " "; tmux send-keys -t "$SESSION" C-c; settle 0.8; }  # 空编辑器上 C-c 会武装退出，先补空格保证非空
draft()     { python3 - "$1" > "$WORK/draft.txt" <<'EOF'
import sys
n = int(sys.argv[1])
print("\n".join(f"草稿第 {i} 行" if i != 20 else "" for i in range(1, n + 1)), end="")
EOF
}

echo "=== fx-tui 底部输入框稳定性矩阵 ==="

# ── 组1：splash 阶段各项刺激（80x30）──────────────────────────────
start_session "$COLS" "$ROWS"
OV0=$(overflows)

check_case TC1-boot "$((ROWS-2))" 1; check_overflow TC1-boot "$OV0"

type_text "$(python3 -c "print('x'*720, end='')")"; settle 2
check_case TC2-type-wrap "$((ROWS-2))" 1; check_overflow TC2-type-wrap "$OV0"
clear_editor

check_case TC3-clear "$((ROWS-2))" 1; check_overflow TC3-clear "$OV0"

type_text "/"; settle
check_case TC4a-menu-open "$((ROWS-2))" 1; check_overflow TC4a-menu-open "$OV0"
tmux send-keys -t "$SESSION" Escape; settle
check_case TC4b-menu-close "$((ROWS-2))" 1; check_overflow TC4b-menu-close "$OV0"
clear_editor

draft 40; paste "$WORK/draft.txt"; settle
check_case TC5-capped-paste "$((ROWS-2))" 1; check_overflow TC5-capped-paste "$OV0"
record TC5-indicator "指示行内容正确" "cap | grep -q '编辑区共 40 行'"

# TC6：封顶草稿 + @文件菜单（8+11+12+3=34 > 30，预算约束关键用例）
type_text "@ui"; settle 2.5
check_case TC6-menu-over-cap "$((ROWS-2))" 1; check_overflow TC6-menu-over-cap "$OV0"
record TC6-menu-shown "菜单确已打开(有补全提示行)" "cap | grep -q '↑↓ 选择'"
clear_editor

# TC11 菜单快速开合 ×5（每轮完整复位，避开 dismiss 抑制与 exitArmed）
for i in 1 2 3 4 5; do type_text "/"; settle 0.5; tmux send-keys -t "$SESSION" Escape; settle 0.4; clear_editor; done
settle
check_case TC11-menu-loop "$((ROWS-2))" 1; check_overflow TC11-menu-loop "$OV0"

type_text "$(python3 -c "print('burst'*120, end='')")"; settle 2
check_case TC9-burst "$((ROWS-2))" 1; check_overflow TC9-burst "$OV0"

# ── 组2：resize 重建（80x30 → 100x40，草稿保留）─────────────────
start_session "$COLS" "$ROWS"
draft 40; paste "$WORK/draft.txt"; settle
tmux resize-window -t "$SESSION" -x 100 -y 40; settle 4
ROWS=40; COLS=100
check_case TC8-resize "$((ROWS-2))" 1; check_overflow TC8-resize "0"
record TC8-draft-kept "重建后草稿保留" "cap | grep -q '草稿第 40 行'"

# ── 组3：filler 耗尽 → 滚动阶段钉底（100x40）────────────────────
start_session "$COLS" "$ROWS"
tc7_done=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  case $((i % 3)) in 0) cmd="/context" ;; 1) cmd="/help" ;; 2) cmd="/cost" ;; esac
  type_text "$cmd"; settle 0.6; tmux send-keys -t "$SESSION" Enter; settle 1.8
  if [ "$(banner_row)" != "1" ]; then tc7_done=1; break; fi
done
record TC7-exhausted "banner 已滚出（耗尽达成）" "[ '$tc7_done' = '1' ]"
settle
check_case TC7-bottom "$((ROWS-2))" 0 1 info; check_overflow TC7-bottom "0"

# ── 组4：真实提交刺激（延续滚动阶段；无凭证时退化为错误提示刺激）──
type_text "你好，请只回复一个字"; settle 0.5
tmux send-keys -t "$SESSION" Enter
for s in 1 2 3; do settle 1.5; check_case "TC-S$s-stream" "$((ROWS-2))" 0 1 info; check_overflow "TC-S$s-stream" "0"; done
tmux send-keys -t "$SESSION" Escape; settle 1.5
check_case TC-S4-interrupted "$((ROWS-2))" 0 1 info; check_overflow TC-S4-interrupted "0"
clear_editor

tmux kill-server 2>/dev/null
echo "=== 结果：PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -gt 0 ] && grep '^FAIL' "$WORK/results.txt"
exit "$FAIL"
