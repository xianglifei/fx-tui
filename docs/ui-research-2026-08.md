# 终端 Coding Agent TUI 交互调研 — 钉底输入框 / 菜单 / 工具展示（2026-08）

本文记录一次针对三个问题的横向调研：①为什么我们的输入框不能稳定钉底、别人为什么可以；
②各家菜单（斜杠补全、选择器、审批）怎么实现；③各家如何展示工具调用。
调研对象：OpenAI Codex CLI、OpenCode、Pi（badlogic → earendil-works）、小米 MiMo-Code，
辅以 Claude Code、Gemini CLI、Charm Crush。所有结论来自各仓库源码、issue 跟踪器与官方
文档的实际阅读（2026-08-29 快照），关键处附链接。对应实施见 v0.18.0–v0.20.0 的
CHANGELOG 条目。

---

## 一、输入框钉底：各家架构对比

一句话本质：**稳的项目每一帧都从确定的起点把输入框画在确定的位置；靠"上一帧位置 +
增量修正"的实现里，终端只能往上滚、不能滚回来，任何一帧算错，误差单向累积。**

| 项目 | 屏幕模式 | 钉底机制 | 已知失败模式 |
|---|---|---|---|
| Codex | inline + 原生滚动缓冲 | 定稿历史经 DEC 滚动区域推入终端 scrollback；活区 ratatui 双缓冲 cell-diff；Flutter 式 flex，composer 是最后非 flex 子元素 | 滚动区域技巧对模拟器敏感：xterm.js 丢行 [#27644](https://github.com/openai/codex/issues/27644)、resize 丢 scrollback [#37987](https://github.com/openai/codex/issues/37987)、视口跳顶 [#37777](https://github.com/openai/codex/issues/37777) |
| OpenCode / MiMo-Code | 永远 alt screen | Yoga flexbox：转写 `scrollbox flexGrow=1` + 底部 dock `flexShrink=0`，每帧全树重排 + cell-diff（MiMo 是 OpenCode 硬 fork） | 结构性不跳；代价是失去原生 scrollback/复制。Window 下仍有闪烁类问题 [#44866](https://github.com/sst/opencode/issues/44866) |
| Pi | 默认 inline + 可选 alt screen | 自研渲染器：全文档逐行 diff + CSI 2026 同步输出，编辑器是文档尾部 | 视口上方变化触发全屏重画 [#6131](https://github.com/earendil-works/pi/issues/6131)、[#8281](https://github.com/earendil-works/pi/issues/8281)；官方缓解＝切 fullscreen 模式 |
| Claude Code | inline / 实验性全屏 | **fork 了 Ink**：自有 Screen Buffer cell-diff + blitting + 虚拟列表（2.1.101 移除了 Ink clearTerminal 的 CSI 3J） | 仍有输入框随历史漂移投诉 [#51530](https://github.com/anthropics/claude-code/issues/51530) |
| Gemini CLI | inline / 可选 alt | **也 fork 了 Ink**（`@jrichman/ink`）：TerminalBuffer 渲染器 + VirtualizedList | flicker 史诗 [#10673](https://github.com/google-gemini/gemini-cli/issues/10673)；终局方案自研 TerminalBuffer |
| fx-tui（改前） | inline（stock Ink 7） | 预算恒等式 `banner+定稿+弹性填充+动态区 = rows−1` + 手工行数估算 + 高度事后上报 | 见下节根因 |

### fx-tui 的三个根因（改前）

1. **输入框高度上报比绘制晚一帧（H1）**：`InputBox` 在 `useLayoutEffect` 里上报高度，
   而 Ink 在 React commit 的 mutation 阶段（`resetAfterCommit` → `onRender`）就已把帧
   写出、layout effect 在其后才跑。任何让输入框变高的提交（换行、粘贴、菜单开、图片托盘）
   都先画出超预算帧 → 终端物理滚动 N 行 → 补偿帧把锚点留在滚动后的位置 → 输入框永久
   上移 N 行。收缩方向下一帧自愈，所以症状永远是"往上跳、不回来"。30fps 节流偶尔把
   两帧合并掩盖问题；流式期间（store 60ms flush + spinner 100ms tick）帧保持热态更容易
   分离——越忙越容易跳。
2. **菜单开合走独立提交（H2）**：斜杠菜单在 `useEffect`（passive）派生，@ 文件菜单更是
   异步 `listWorkspaceFiles().then(...)` 后才 setMenu——宏任务必然落在节流窗外，+11 行
   的菜单帧必然带着旧填充独立成帧：短会话触发 Ink 全清兜底（清 scrollback 重放转写），
   长会话滚 11 行。
3. **行数估算失配（H3）**：排队/注入消息行渲染可达 `width+19` 列（2 行）预算只计 1 行，
   每次运行中提交消息必失配；菜单 label 未截断；自研 charWidth 对 emoji 按 1 列计
   （string-width 按 2）；自由文本问题的 detail 未截断但预算计 1 行。

CHANGELOG 里 0.5.1 / 0.6.x / 0.7.0 / 0.13.0 / 0.13.4 修的都是这一族问题——逐案修补到头的信号。
Ink 上游也有对应缺陷记录：[#973](https://github.com/vadimdemedes/ink/issues/973)（Static 块超高后
动态区整体上移）、[#935](https://github.com/vadimdemedes/ink/issues/935)、[#990](https://github.com/vadimdemedes/ink/issues/990)。

### 业界的两条出路

- **Gemini 式纪律（stock Ink 内做到基本稳定）**：动态区每个子区域高度固定/封顶
  （输入 viewport 固定 10 行内部滚动、建议列表 8 行、工具输出 15 行截断），动态区总高
  几乎恒定；并有 `useFlickerDetector`——根元素实测高度超过终端高度直接记
  `AppEvent.Flicker`（"这是渲染 bug 该修的标志"）。
- **fork/替换渲染器**：Anthropic、Google 都走了这条路；或换 alt-screen 框架
  （OpenCode/OpenTUI、Crush/Bubble Tea）。Pi 则双模式并存让用户自选。

---

## 二、菜单

### fx-tui 改前

- 唯一箭头键菜单：斜杠/@ 补全面板（8 槽固定高度、↑↓/Tab/Enter/Esc、分组头）——形态
  本身已是业界主流。
- 其余所有选项菜单（agent 提问、计划审批、/sessions、/model、/effort、/theme、/config）
  全部经由 `pick()` → `QuestionView`，被锁死在"数字 1–9 + Enter"、9 选项上限、无箭头键。
  /theme 被迫 8 个一页分页、/sessions 只显示最新 9 个。
- 审批是字母 y/s/a/n（这个形态接近业界最快实践）。

### 各家对照

| 交互 | Claude Code | Codex | OpenCode / MiMo | Gemini CLI | Pi |
|---|---|---|---|---|---|
| 斜杠补全 | 输入框上方浮动面板，箭头+Tab+Enter，两列（命令+暗色描述），高度随终端自适应 | 通用 popup 引擎：8 行上限、精确>前缀排序、匹配字符加粗、PageUp/Down（[command_popup.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/command_popup.rs)） | 输入框上方绝对定位浮层（≤10 行、按上方空间截断），fuzzysort + frecency（[autocomplete.tsx](https://github.com/sst/opencode/blob/dev/packages/tui/src/component/prompt/autocomplete.tsx)） | 8 行面板（上方/下方可配），Tab/Enter 接受，←→ 展开长描述（[SuggestionsDisplay.tsx](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/components/SuggestionsDisplay.tsx)） | 画在输入框**下方**，↑↓ 环绕 + Enter（[select-list.ts](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/select-list.ts)） |
| 全局选择器 | 箭头键列表带描述分组 | 全屏分页器 | Ctrl+P 命令面板：居中模态 DialogSelect，搜索+分类+翻页 | RadioButtonSelect（箭头+数字双通道，`showNumbers`） | 居中 overlay SelectList |
| 审批/确认 | 箭头键单选 Yes / Yes-and-don't-ask / No | 底部面板内联箭头键选择，大 diff 升级全屏分页器 | 内联替换输入框位置 | 排队进动态区的单选卡 | 居中 overlay |

**成熟方案结论**：Ink 生态没有现成浮动菜单库（@inkjs/ui 2024 年起停更、ink-select-input
无描述无弹窗），抄形态比引依赖对。共识三件套：①补全面板（箭头+Tab+Enter+Esc、实时
过滤、每行"标签+暗色描述"、固定槽位）；②居中/全屏命令面板式选择器；③内联箭头键单选
做审批。注意 Gemini 的 RadioSelect **保留了数字快捷键**——箭头与数字不是二选一。

---

## 三、工具调用展示

### fx-tui 改前

每个完成的工具调用 = 圆角边框卡片：空行 + 上下边框 + 头行 + 最多 12 行输出 + 溢出提示
≈ 17 行；一轮 N 个调用 N 张框。Ctrl+O 只影响之后完成的卡片（Static 已打印的项永不重绘，
已定稿卡片无法再展开）。思考内容完全隐藏（只有状态栏字数）。

### 各家对照

| 维度 | Codex（最克制） | Claude Code | OpenCode / MiMo | Gemini CLI | Pi |
|---|---|---|---|---|---|
| 每个调用 | **一行** `• Ran <命令>`（bash 高亮；spinner→绿✓/红✗）；同轮多命令折叠 `• Ran N commands`（[exec_cell/render.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs)） | 一行 `⏺ Bash(cmd)` + 状态点（执行中闪烁/绿/红），同类调用可分组 | 一行图标沟槽（`$ ← ✱ → %`）+ 摘要；generic 工具默认只一行、输出整体隐藏 | 状态字形 `✓ o ⊷ ? x` + 密集三段视图 | 状态背景色块 + 每工具自定义渲染 |
| 输出预览 | 5 行头+尾截断 + `… +N lines (ctrl+t)` | 摘要行，Ctrl+O 展开 | shell 10 行，**点击展开/收起** | 15 行截断，Ctrl+O 更多 | 5 行，Ctrl+O 展开 |
| 思考 | 不流式内联；一行 shimmer 头，正文只进 Ctrl+T 转写浏览器 | 暗斜体 `✻ Thinking…` 折叠块 | 默认折叠一行"标题+时长"，点击展开（/thinking 切换） | 斜体头 + 左边框气泡流式 | 一行 "Thinking..."，Ctrl+T 展开 |
| diff | 内联预览 12 行封顶，完整进分页器 | 高亮 + 行号，可展开 | **完全展开**，宽度>120 自动分栏 | 高亮渲染 15 行截断 | 红/绿 + 行内反色 |

没有任何一家默认给每个工具调用画边框盒子；共识是"**一行摘要 + 个位数行预览 + 显式
展开**"，边框/颜色只用于**状态**（失败红、成功绿）而非容器。边框卡片每张约 4 行是纯
视觉开销，信息密度只有竞品的 1/3–1/5。

### 架构性约束备忘

- Ink `<Static>` 已打印的项**永不重绘**（React 侧不重渲染、终端里已进 scrollback）——
  "对已定稿卡片再展开/再折叠"在 inline+Static 架构里做不到，Codex/Claude 用 alt-screen
  转写浏览器（Ctrl+T/Ctrl+O）解决。我们的折衷：Ctrl+O 切换时把最近一次调用的完整输出
  以面板形式补打进转录。
- 转录内"同轮多命令折叠"同理需要可重绘的活视图；我们采用 Codex 的实际机制——**并行
  运行中的工具行合并为一行**（`compact_group_display_lines` 的对应物），定稿后逐卡进转录。

---

## 四、实施对照（本仓库已落地版本）

| 版本 | 内容 |
|---|---|
| v0.18.0 | 输入框/菜单高度提升到 App 同 commit 派生（根治 H1/H2）；排队消息、运行中工具、菜单行、自由文本 detail 全部单行化或精确计数（H3）；truncateLine 改 string-width 口径；帧高自检日志 |
| v0.19.0 | QuestionView 箭头键 + 数字双通道 + 9 行滑动窗（解除 9 选项上限，/theme 去分页）；工具卡片紧凑化（单行状态头 + 缩进预览，终端/generic 5 行、diff 8 行，去边框）；思考折叠摘要行；Ctrl+O 输出最近调用完整明细面板 |
| v0.20.0 | 斜杠菜单模糊匹配 + 匹配字符高亮 + ←→ 展开长描述；并行工具运行行合并；轮末工具计数提示 |
