# fx-tui 安装指南

fx-tui 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的树外 bundle 插件。装好它一共涉及四件事：

- Node.js >= 22.19 和 pnpm
- DeepSeek Harness 本体（dsh CLI）0.1.1-rc.2 或更高 —— fx-tui 的运行时依赖，没有它无法启动
- DeepSeek API key（去 [platform.deepseek.com](https://platform.deepseek.com) 申请）
- 克隆并构建 fx-tui，注册为 dsh 的 fx profile

最省事的用法：回到 [README 的「安装」一节](../README.md#安装)，把那句话复制给任意终端编码 agent，它会读取本页并自动完成全部步骤。下面的内容也可以人工逐步执行或排查问题。

## 交给 Agent 一键安装（推荐）

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
   版本不低于 0.1.1-rc.2。这是 fx-tui 的运行时本体，没有它 fx 无法启动。
   注意：dsh 目前以 rc 预发布版滚动发布（如 0.1.1-rc.2），按 semver 规则
   rc 版小于同号正式版属正常现象，不要因 -rc 后缀判定"版本不满足"而中止，
   也不要自行放宽或收紧版本条件。

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

## 手动安装（备查）

**第 1 步：安装 DeepSeek Harness 本体（dsh）。** fx-tui 是 dsh 的插件，
没有 dsh 就无法运行——这是最容易被忽略的一步：

```sh
node --version          # 需 >= 22.19；没有先装 Node.js
npm install -g @deepseek-ai/dsh
dsh --version           # 确认 >= 0.1.1-rc.2（dsh 目前均为 rc 预发布版，属正常）
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
