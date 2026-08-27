# fx-tui

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的交互式终端界面 —— 一个树外 bundle 插件，基于 Ink（React）渲染，滚动式布局，输入框钉底。

```
╭──────────────────────────────────────────────────────────────────╮
│ ███████╗ ██╗  ██╗  模 型  deepseek-official/deepseek-v4-flash    │
│ ██╔════╝ ╚██╗██╔╝  版 本  fx-tui v0.7.0 · dsh 0.1.1-rc.2         │
│ █████╗   ╚███╔╝    会 话  session-875b6543-505a                  │
│ ██╔══╝   ██╔██╗    目 录  ~/Code/Github/fx-tui                   │
│ ██║     ██╔╝ ██╗                                                 │
│ ╚═╝     ╚═╝  ╚═╝   输入消息开始对话 · /help 查看按键与命令       │
╰──────────────────────────────────────────────────────────────────╯

❯ 在当前目录创建 hello.txt，内容写"你好"
✓ Write ./hello.txt · 22ms
  hello.txt
  + 你好

✓ cat ./hello.txt · 35ms · exit 0
  你好

● 就绪 · deepseek-official/deepseek-v4-flash · 上下文 2%·17.2k/1.0M
╭──────────────────────────────────────────────────────────────────╮
│ ▏                                                                │
╰──────────────────────────────────────────────────────────────────╯
```

## 功能清单

### 对话与渲染

- **启动横幅**：进程启动时在屏幕顶缘渲染 ASCII 品牌盒（box-drawing 边框 +
  FX ASCII logo + 模型/版本/会话/工作目录）。视口空白是**弹性**的：会话不足
  一屏时新消息先消耗空白，横幅钉在顶缘、输入框钉底、零滚动（Claude Code 式）；
  内容超屏后自然滚动、横幅逐行滚入 scrollback。窄终端自动降级（先截断值、再隐藏 logo）
- **滚动式聊天界面**：主屏保留终端 scrollback，历史可搜索、可复制
- **流式 Markdown 渲染**：代码高亮（cli-highlight）、CJK 感知换行（wrap-ansi）
- **多行输入框**：光标编辑、输入历史（↑/↓）、粘贴通道（bracketed paste）、
  CJK 宽度安全、**钉底显示**（Claude Code 式始终位于屏幕最后一行）
- **状态栏**：阶段 spinner + 思考字数 + token 用量 + **上下文水位**
  （`上下文 N%·已用/容量`，token-meter 驱动）+ 窄终端自动降级
- **增量渲染**：Ink `incrementalRendering` 只重绘变更行，降低闪烁

### 工具可见性

- **工具调用卡片**（官方呈现层 `presentCall/presentResult`）：命令卡（耗时 + 退出码）、
  文件改动卡（红绿 diff 着色）、搜索卡、读文件卡、web 卡
- **工具详情切换**：`Ctrl+O` 在摘要/完整输出之间切换
- **Transcript 模式**：`Ctrl+R` 显示注入的隐藏上下文（plugin 快照、技能目录等）

### 权限与人机协作

- **审批四选项**：沙箱升级时 `[y] 允许一次 · [s] 本会话不再问 · [a] 总是允许 · [n] 拒绝`
- **审批记忆**：按语义签名（bash 按命令、文件工具按路径）记忆，`a` 持久化到
  `$DSH_HOME/fx-tui-allowlist.json`，同类调用自动放行
- **agent 提问答 UI**：`ask_user_question` 渲染成选项卡（数字键选择）或自由文本问答
- **Plan 审批卡片**：计划模式（`/plan`）下计划 markdown 结构化展示、批准选项 `✓` 标注、
  Enter 直接批准
- **权限模式**：启动默认为「自动允许」（工具调用不再逐个询问）；`/config`（交互
  选择或 `/config permission <auto|ask>`）修改并持久化该默认到
  `$DSH_HOME/fx-tui-settings.json`，删除文件即重置回默认；会话内 Shift+Tab 随时
  切换 `每次询问 ⇄ 自动允许`（仅本会话生效，不写回设置文件），`/status`
  同时展示启动默认与当前会话两个值

### 输入效率

- **Slash 命令补全菜单**：`/` 弹出菜单（内置 + dsh 命令注册表自动并入：
  /compact、/feedback、/goal、/permission…），↑↓ 导航、Tab 补全、Enter 执行
- **@-文件引用**：输入 `@` 弹出工作区文件的 fuzzy 路径补全（零依赖自研评分器），
  选中后模型自动读取该文件
- **$EDITOR 长消息**：`/edit` 挂起 TUI → 打开 `$EDITOR` → 编辑内容回填输入框
- **图片输入**：`/image <路径>` 附加图片（png/jpeg/webp/gif，经 dsh attachment 服务
  持久化），随下一条消息发送；配视觉路由（如 deepseek-v4-flash-vision-exp）可识图
- **排队输入（steering）**：agent 忙碌时提交显示 `⏳ 已排队`，轮次结束自动消费

### 会话与多任务

- **会话切换**：`/sessions` 弹出选择器**活体切换**（时间/目录/运行中标记）
- **模型切换**：`/model` 选择器热切换（下一步请求生效）并持久化为默认
- **TODO 面板**：`todo_write` 任务列表实时渲染（◐ 进行中 / ☐ 待办 / ☑ 完成）
- **subagent 徽标**：子 agent 运行时状态栏显示 `🌱×N`
- **会话导出**：`/export` 导出为 Markdown 时间线；`fx --resume <id>` 恢复会话
- **运行状态面板**：`/status` 显示版本/模型/会话/上下文/工作区 + 已加载插件树

## 安装

### 方式一：交给你的 Agent 一键安装

把下面这段 Prompt 复制给任意终端编码 agent（Claude Code、ZCode 等）即可：

```text
帮我安装 fx-tui——DeepSeek Harness（dsh）的交互式终端界面（一个树外 bundle 插件）。

仓库地址：https://github.com/xianglifei/fx-tui

请严格按以下顺序执行，每一步完成后再进行下一步；任何一步失败就停下，
把错误原文完整告诉我，不要自行猜测或跳过：

1. 检查并安装 Node.js >= 22.19（fx-tui 和 dsh 都依赖它）：
   node --version
   若未安装或版本过低：macOS 用 brew install node@22（或用 nvm install 22），
   Linux 用系统包管理器或 nvm；装完重开 shell 再验证一次。

2. 检查并安装 pnpm：
   pnpm --version
   若未安装：corepack enable（Node 自带）或 npm install -g pnpm。

3. 检查并安装 DeepSeek Harness 本体（dsh CLI）：
   dsh --version
   若未安装：npm install -g @deepseek-ai/dsh，装完再跑一次 dsh --version 确认
   版本 >= 0.1.1。这是 fx-tui 的运行时本体，没有它 fx 无法启动。

4. 检查并配置 DeepSeek API key：
   读取 ~/.dsh/.credentials.yaml，确认包含 DEEPSEEK_API_KEY 一行。
   若文件或该行不存在：提醒我先去 https://platform.deepseek.com 申请密钥，
   然后替我创建（mkdir -p ~/.dsh，写入 DEEPSEEK_API_KEY: sk-xxx，
   并 chmod 600 ~/.dsh/.credentials.yaml）。

5. 克隆并构建 fx-tui：
   git clone https://github.com/xianglifei/fx-tui.git ~/fx-tui
   cd ~/fx-tui && pnpm install && pnpm run build

6. 安装为 dsh 的 fx profile（树外插件，官方机制）：
   dsh plugin --profile fx add "$(pwd)"

7. 安装 fx 直达命令（复制启动脚本到 PATH 目录）：
   macOS：cp bin/fx /opt/homebrew/bin/fx
   Linux：sudo cp bin/fx /usr/local/bin/fx

8. 验证，把每条命令的实际输出告诉我：
   fx --help     # 应输出 fx-tui 的帮助（若提示 dsh 未安装或 profile 未装，
                 # 说明第 3/6 步没成功，回到对应步骤排查）
   fx            # 应进入交互式界面；输入 /status 可查看运行状态；
                 # 按 Ctrl+C 两次退出

全部通过后告诉我 fx 已就绪，并提示我用 fx --help 查看用法。
```

### 方式二：手动安装

**第 1 步：安装 DeepSeek Harness 本体（dsh）。** fx-tui 是 dsh 的插件，
没有 dsh 就无法运行——这是最容易被忽略的一步：

```sh
node --version          # 需 >= 22.19；没有先装 Node.js
npm install -g @deepseek-ai/dsh
dsh --version           # 确认 >= 0.1.1
```

**第 2 步：配置 DeepSeek API key**（没有的话去
[platform.deepseek.com](https://platform.deepseek.com) 申请）：

```sh
mkdir -p ~/.dsh
cat > ~/.dsh/.credentials.yaml << 'EOF'
DEEPSEEK_API_KEY: sk-你的密钥
EOF
chmod 600 ~/.dsh/.credentials.yaml
```

**第 3 步：安装 fx-tui：**

```sh
git clone https://github.com/xianglifei/fx-tui.git && cd fx-tui
pnpm install && pnpm run build
dsh plugin --profile fx add "$(pwd)"
cp bin/fx /opt/homebrew/bin/fx   # 或任意 PATH 目录（Linux 常用 /usr/local/bin）
```

> `fx` 启动脚本自带防呆检测：dsh 未安装或 fx profile 未装时会给出对应的
> 修复命令，而不是裸报错。

## 使用

```sh
fx                                  # 新会话（等价于 dsh --profile fx）
fx --resume <id>                    # 恢复会话
```

### 按键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送消息 / 确认选择 / 提交自由文本回答 / 执行或补全菜单项 |
| `Ctrl+J` | 输入框内换行 |
| `↑` / `↓` | 翻阅输入历史 / 菜单导航（菜单打开时） |
| `Tab` | 补全菜单高亮项（命令 / 文件路径） |
| `Esc` | 中断当前轮次 / 清空输入 / 跳过问题 / 关闭菜单 |
| `Ctrl+O` | 工具详情 摘要⇄完整 切换 |
| `Ctrl+R` | Transcript 模式（显示注入的上下文） |
| `Ctrl+C` | 清空输入；空输入时再按一次退出 |
| `y` `s` `a` `n` | 审批：一次 / 本会话 / 总是（记住）/ 拒绝 |
| 数字键 | 问题选项选择 |
| `/help` `/status` `/sessions` `/model` `/export` `/edit` `/image <路径>` `/exit` | 内置命令（`/` 查看全部） |

### 审批记忆

选择 `s`（本会话）或 `a`（总是）后，相同动作的后续审批自动放行：

- bash 命令按**命令原文**记忆（如 `touch ~/x`）
- 文件读写按**路径**记忆，其他工具按完整参数记忆

`a` 的记忆持久化在 `$DSH_HOME/fx-tui-allowlist.json`，删除该文件即清除全部"总是"授权。

## 开发

```sh
pnpm run watch                # watch 编译到 lib/
# profile 里是 pnpm link，改完重启 fx 即可生效
pnpm run typecheck
FX_TUI_DEBUG=1 fx             # 事件流写 /tmp/fx-debug.log
```

架构：`src/index.ts`（runner 插件：Agent 驱动 + 事件桥 + 审批/提问适配器 + 工具呈现桥）
→ `src/store.ts`（session 事件 → 视图状态的归约器，React 外部 store）
→ `src/ui/`（Ink 组件）+ `src/markdown.ts`（Markdown→ANSI）+ `src/diff.ts`（diff 着色）
+ `src/approval-memory.ts`（审批记忆）+ `src/workspace-files.ts`（@-文件补全）。

`cordis.patch.yml` 叠加在 `@deepseek-ai/dsh-base` 之上：禁用 HMR、注入 persona、挂载
`dsh-tool-ask-user`（给模型 ask_user_question 工具）和本包 runner。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 已知限制

- 会话/模型选择器一次最多 9 项（问题组件的数字键上限）
- 主题固定（暂缓）
- **Windows 未实测**：已加防御代码（编辑器 spawn 走 shell、kitty release 事件守护），
  欢迎反馈
- **IME 以真机为准**：CJK 输入/粘贴/流式渲染已全链路回归，但输入法预编辑需要真实
  终端确认——推荐 iTerm2/WezTerm/kitty；如遇预编辑异常，可用 `/edit` 外部编辑器托底

## License

MIT
