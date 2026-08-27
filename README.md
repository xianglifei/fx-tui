# fx-tui

DeepSeek Harness（dsh）的交互式终端界面 —— 一个树外 bundle 插件，基于 Ink（React）渲染，滚动式布局。

```
❯ 在当前目录创建 hello.txt，内容写"你好"
✓ Write ./hello.txt · 22ms
  hello.txt
  + 你好

✓ cat ./hello.txt · 35ms · exit 0
  你好

● 就绪 · deepseek-official/deepseek-v4-flash · 上下文 2%·17.2k/1.0M
┌─────────────────────────────────────────────────────────────────┐
│ 说点什么…（Enter 发送 · Ctrl+J 换行 · /help 查看按键）           │
└─────────────────────────────────────────────────────────────────┘
```

## 特性

- **滚动式聊天界面**：主屏保留终端 scrollback，历史可搜索、可复制
- **多行输入框**：光标编辑、输入历史（↑/↓）、粘贴通道、CJK 宽度安全
- **流式 Markdown 渲染**：代码高亮（cli-highlight）、CJK 感知换行
- **工具调用卡片**（官方呈现层 `presentCall/presentResult`）：命令卡（耗时 + 退出码）、
  文件改动卡（红绿 diff）、搜索卡、读文件卡、web 卡
- **工具详情切换**：`Ctrl+O` 在摘要/完整输出之间切换（影响之后完成的卡片）
- **审批四选项**：沙箱升级时 `[y] 允许一次 · [s] 本会话不再问 · [a] 总是允许 · [n] 拒绝`
- **审批记忆**：`s`/`a` 的授权按语义签名（bash 按命令、文件工具按路径）记忆，
  `a` 持久化到 `$DSH_HOME/fx-tui-allowlist.json`，之后同类调用自动放行
- **agent 提问答 UI**：`ask_user_question` 渲染成选项卡（数字键选择）或自由文本问答
- **上下文水位**：状态栏实时显示 `上下文 N%·已用/容量`（token-meter）
- **状态栏**：spinner + 阶段 + 思考字数 + token 用量（窄终端自动降级）
- **中断与退出**：Esc 中断当前轮次，双击 Ctrl+C 退出
- **会话持久化**：`--resume <id>` 恢复历史会话（dsh session log）

## 安装

前置：已安装 [dsh](https://github.com/deepseek-ai/deepseek-harness) CLI（0.1.1-rc.2），`~/.dsh/.credentials.yaml` 里配好 `DEEPSEEK_API_KEY`。

```sh
git clone <this-repo> && cd fx-tui
pnpm install && pnpm run build
dsh plugin --profile fx add "$(pwd)"
```

## 使用

```sh
dsh --profile fx                    # 新会话
dsh --profile fx --resume <id>      # 恢复会话
```

### 按键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送消息 / 确认选择 / 提交自由文本回答 |
| `Ctrl+J` | 输入框内换行 |
| `↑` / `↓` | 翻阅输入历史（光标在首行/末行时） |
| `Esc` | 中断当前轮次 / 清空输入 / 跳过问题 |
| `Ctrl+O` | 工具详情 摘要⇄完整 切换 |
| `Ctrl+C` | 清空输入；空输入时再按一次退出 |
| `y` `s` `a` `n` | 审批：一次 / 本会话 / 总是（记住）/ 拒绝 |
| 数字键 | 问题选项选择 |
| `/help` `/exit` | 内置命令 |

### 审批记忆

选择 `s`（本会话）或 `a`（总是）后，相同动作的后续审批自动放行：

- bash 命令按**命令原文**记忆（如 `touch ~/x`）
- 文件读写按**路径**记忆
- 其他工具按完整参数记忆

`a` 的记忆持久化在 `$DSH_HOME/fx-tui-allowlist.json`，删除该文件即清除全部"总是"授权。

## 开发

```sh
pnpm run watch                # watch 编译到 lib/
# profile 里是 pnpm link，改完重启 dsh --profile fx 即可生效
pnpm run typecheck
FX_TUI_DEBUG=1 dsh --profile fx   # 事件流写 /tmp/fx-debug.log
```

架构：`src/index.ts`（runner 插件：Agent 驱动 + 事件桥 + 审批/提问适配器 + 工具呈现桥）
→ `src/store.ts`（session 事件 → 视图状态的归约器，React 外部 store）
→ `src/ui/`（Ink 组件）+ `src/markdown.ts`（Markdown→ANSI）+ `src/diff.ts`（diff 着色）
+ `src/approval-memory.ts`（审批记忆）。

`cordis.patch.yml` 叠加在 `@deepseek-ai/dsh-base` 之上：禁用 HMR、注入 persona、挂载
`dsh-tool-ask-user`（给模型 ask_user_question 工具）和本包 runner。

## 已知限制（M2 后）

- 无 slash 命令补全菜单、@-文件引用、图片粘贴（M3）
- 无模型切换、会话选择器、todo/plan 渲染（M4）
- 主题固定（暂缓）
- IME 与鼠标细节以真实终端实测为准

## License

MIT
