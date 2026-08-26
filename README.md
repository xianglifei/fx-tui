# fx-tui

DeepSeek Harness（dsh）的交互式终端界面 —— 一个树外 bundle 插件，基于 Ink（React）渲染，滚动式布局。

```
❯ 帮我看看这个报错
⚙ bash 运行中…
✓ bash command=ls -la
  README.md  src  …

● 就绪 · deepseek-official/deepseek-v4-flash · ↑1.2k ↓345 · session-3f2a…
┌─────────────────────────────┐
│ 说点什么…（Enter 发送）        │
└─────────────────────────────┘
```

## 特性

- **滚动式聊天界面**：主屏保留终端 scrollback，历史可搜索、可复制
- **多行输入框**：光标编辑、输入历史（↑/↓）、CJK 宽度安全
- **流式 Markdown 渲染**：代码高亮（cli-highlight）、CJK 感知换行（wrap-ansi）
- **工具调用卡片**：参数摘要、结果预览、成功/失败状态
- **审批提示**：工具执行前 y/n 批准（对接 `ctx.approval`）
- **状态栏**：spinner + 当前阶段 + 思考字数 + token 用量 + 模型/会话
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
| `Enter` | 发送消息 |
| `Ctrl+J` / `Opt+Enter` | 输入框内换行 |
| `↑` / `↓` | 翻阅输入历史（光标在首行/末行时） |
| `Esc` | 中断当前轮次 / 清空输入 |
| `Ctrl+C` | 清空输入；空输入时再按一次退出 |
| `y` / `n` | 审批提示：允许一次 / 拒绝 |
| `/help` `/exit` | 内置命令 |

## 开发

```sh
pnpm run watch                # watch 编译到 lib/
# profile 里是 pnpm link，改完重启 dsh --profile fx 即可生效
pnpm run typecheck
```

架构：`src/index.ts`（runner 插件：Cordis 生命周期 + Agent 驱动 + 事件桥）→ `src/store.ts`（session 事件 → 视图状态的归约器，React 外部 store）→ `src/ui/`（Ink 组件）+ `src/markdown.ts`（Markdown → ANSI 渲染）。

`cordis.patch.yml` 叠加在 `@deepseek-ai/dsh-base` 之上：禁用 HMR、注入 persona、挂载本包 runner。

## 已知限制（M1）

- 无 slash 命令补全菜单、@-文件引用（M3）
- 审批只有「允许一次/拒绝」，没有「本次会话/总是」（M2）
- 无模型切换、会话选择器（M4）
- 主题固定（暂缓）

## License

MIT
