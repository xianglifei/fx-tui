# Changelog

本项目的所有显著变更记录于此。版本格式遵循 [SemVer](https://semver.org/)，
条目参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.6.1] - 2026-08-27

### 修复：横幅视口填充改为弹性空白

- **对话后横幅不再消失**：0.6.0 把撑满视口的空白在首帧一次性写死进 Static 区，
  任何新消息都会把整个画面上滚、横幅随即出屏，而中间的空白纹丝不动（对话一轮即消失）。
  现在空白改到**动态区顶部逐帧重算**（`行数 − 横幅 − 已落定内容 − 底部区域`）：
  会话不足一屏时新消息先消耗空白——横幅钉在屏幕顶缘、输入框钉底、**零滚动**
  （Claude Code 式）；空白耗尽后才自然滚动，横幅逐行没入 scrollback
- 配套：`InputBox` 向 `App` 上报精确渲染行数（编辑器行数/菜单/图片提示），
  供 filler 预算吸收布局变化；`/sessions` 切换与 `/edit` 外部编辑器返回后，
  横幅作为新 Static 批次的首条目重新打印（会话 id/模型随 `reset` 更新）
- 实测（pty + 终端模拟器）：初始/短对话零滚动/长对话渐进出屏/补全菜单零滚动/
  resize 重钉底/40 列降级，六场景全通过

## [0.6.0] - 2026-08-27

### 启动横幅（welcome banner）

- 进程启动时在终端顶部渲染 ASCII 品牌盒（Claude Code 式）：圆角 box-drawing 边框 +
  ANSI-shadow `FX` logo + 信息区（模型 / `fx-tui`+`dsh` 版本 / 会话 / 工作目录 / 提示行），
  取代原启动 notice 一行灰字
- dsh 版本号从已安装的 `@deepseek-ai/dsh-agent` package.json 读取（展示用途，读取失败则省略）
- 横幅是 Static 区第一个 transcript 条目：随对话自然滚入 scrollback，`--resume` 恢复会话
  时标注"已恢复历史会话"
- 全新会话首帧用空白填充撑满视口：横幅落在屏幕顶缘、输入框钉底（Claude Code 式
  启动画面）。填充预算为 Ink 追加在非全屏帧末尾的换行符预留一行（Ink 只按动态区
  高度判断全屏，横幅+输入区远小于视口时必然多出该换行，会把首帧整体上顶一行，
  正是"横幅顶边框滚出视口"的成因）；恢复会话有历史时不填充，由历史自然撑满
- 窄终端降级：先截断信息值（预留省略号宽度，保证不换行），空间不足再隐藏 logo 只留信息区；
  盒子宽度与底部输入框对齐——同为终端全宽，顶部横幅与底部输入区边框同宽，视觉齐整

## [0.5.1] - 2026-08-27

### 修复

- 补全菜单（/ 命令、@ 文件）改为**固定高度**：菜单打开期间始终占满 8 个条目槽位
  （过滤时用空行填充）。此前输入过滤会让菜单变矮、动态区帧收缩，输入框因此上浮。
  现在打字全程帧高不变，输入框钉底稳定（帧分析实证：过滤各步 cursorUp 恒定）。
  菜单内回车执行时，关闭与命令结果在同一个渲染提交中原子应用，无中间跳变。

## [0.5.0] - 2026-08-27

### 终端工程打磨（M5）

- 防闪烁：启用 Ink `incrementalRendering`（只重绘变更行），流式输出/菜单/Static 追加全量回归
- 滚动边界：动态区全部列表高度上限（菜单 8 / TODO 8 / plan 30 / 排队消息 5）
- `/status` 运行状态面板：版本/模型/会话/上下文/工作区 + 已加载插件树（registry 枚举）
- Windows 防御代码（编辑器 spawn 走 shell、kitty release 事件守卫；未实测，文档如实标注）
- IME 文档化：pty 内可自动化部分全链路回归，真机矩阵列为用户验证项

### 直达命令与输入体验

- `bin/fx` 透传启动脚本：装进 PATH 后 `fx` 直接启动（参数透传，`fx --resume <id>` 可用），
  含防呆检测——dsh 未安装或 fx profile 未装时输出可操作的修复命令而非裸报错
- 输入框去掉常驻占位提示：默认单行光标，仅输入超行时自然增高（消除两行→一行的跳动）

## [0.4.0] - 2026-08-27

### 会话与多任务（M4）

- `/sessions` 会话选择器 + **活体切换**：flush → dispose 当前 agent → resume 目标会话 → 状态重置与历史重放
- `/model` 模型切换：选择器热切换（改 `ModelSelectionRef.current`，下一步请求生效），
  并经 `agentDefaultModel.saveSelection` 持久化为默认
- 排队输入（steering）：忙碌时提交显示 `⏳ 已排队`，inbox 唤醒消费后提升为正式消息；中断丢弃并提示
- TODO 面板：`todo/write` 快照实时渲染（◐ 进行中 / ☐ 待办 / ☑ 完成 + 完成计数）
- subagent 徽标：`agent/created`/`agent/disposed` 按 parentSession 过滤，状态栏显示 `🌱×N`
- Plan 审批卡片：计划模式（`/plan`）下 `exit_plan_mode` 提交的计划经 plan-review 意图
  渲染为品红审批卡——计划 markdown 结构化展示、批准选项 `✓` 绿色标注、Enter 直接批准
- `/export` 会话导出为 Markdown 时间线
- `Ctrl+R` Transcript 模式：显示注入的隐藏上下文（plugin 快照、技能目录等）
- `/permission` 权限模式切换（dsh 注册表命令，随 slash 菜单自动并入）

### 体验修复

- 输入框钉底：启动时一次性行冲刷把首帧推到屏幕最底行（Claude Code 式），之后由自然滚动保持
- 命令反馈面板化：`/help` 与命令结果从一行灰字改为青色边框面板（修复"看起来没反应"）
- kitty 键盘协议 release 事件守卫：防止 kitty/WezTerm/Ghostty 下按键双触发

## [0.3.0] - 2026-08-27

### 输入效率（M3）

- Slash 命令补全菜单：`/` 弹出（内置 + dsh 命令注册表自动并入 /compact、/feedback、
  /goal、/permission…），↑↓ 导航、Tab 补全、Enter 执行（`ctx.commands.execute` 分发）
- @-文件引用：`@` 弹出工作区 fuzzy 路径补全（零依赖自研评分器，basename/前缀加权，
  30s 缓存跳过 node_modules/.git 等），Tab 补全相对路径，模型自动读取该文件
- `/edit` 外部编辑器：挂起 Ink → 打开 `$EDITOR` → 编辑内容回填输入框
- `/image <路径>` 图片附加：经 `ctx.attachments.saveImages` 持久化，ImageBlock 随下一条
  消息发送；配视觉路由（deepseek-v4-flash-vision-exp）验证了完整多模态闭环
- 修复：`readdir recursive` 返回绝对 parentPath——剥回工作区相对路径

## [0.2.0] - 2026-08-27

### 工具可见性与审批（M2）

- 工具卡片接入官方呈现层（`presentCall/presentResult`）：terminal 卡（耗时 + 退出码 pill）、
  diff 卡（LCS 红绿着色 + 路径头）、search/read/web 卡
- `Ctrl+O` 工具详情 摘要⇄完整 切换
- 审批四选项（一次/会话/总是/拒绝）+ 语义签名记忆（bash 按命令、fs 按路径），
  `a` 持久化到 `$DSH_HOME/fx-tui-allowlist.json`，同类调用自动放行
- agent 提问答 UI：`ctx.userQuestions.registerProvider`——选项卡（数字键多/单选）与
  自由文本两种模式；patch 挂载 `dsh-tool-ask-user` 提供 `ask_user_question` 工具
- 上下文水位：`tokenMeter.measure` + `request/context` 容量 → 状态栏 `上下文 N%·已用/容量`，
  窄终端右侧按优先级降级
- 修复：chunk 提交路径绕过自由文本问答分支、StatusBar columns=0 防御、
  `ctx.userQuestions` 需要 inject 声明

## [0.1.0] - 2026-08-27

### 核心回路（M1）

- 首个可用版本：dsh 树外 bundle（`dsh.bundle` manifest + `cordis.patch.yml` 叠加 dsh-base）
- 多行输入框：码点级光标编辑、Enter 提交 / Ctrl+J 换行、输入历史、bracketed paste 通道、
  块输入规范化
- 流式 Markdown 渲染（marked + cli-highlight + wrap-ansi，CJK 感知）、状态栏
  （阶段/思考字数/token 用量）、工具调用卡片、`--resume` 会话恢复、Esc 中断、
  双击 Ctrl+C 退出、`/help` `/exit` 内置命令
- 端到端验证于 dsh 0.1.1-rc.2：真实模型回路、工具执行、中断、恢复

[0.5.1]: https://github.com/xianglifei/fx-tui/releases/tag/v0.5.1
[0.5.0]: https://github.com/xianglifei/fx-tui/releases/tag/v0.5.0
[0.4.0]: https://github.com/xianglifei/fx-tui/releases/tag/v0.4.0
[0.3.0]: https://github.com/xianglifei/fx-tui/releases/tag/v0.3.0
[0.2.0]: https://github.com/xianglifei/fx-tui/releases/tag/v0.2.0
[0.1.0]: https://github.com/xianglifei/fx-tui/releases/tag/v0.1.0
