# Windows 适配调研笔记（暂缓存档）

> 调研时间：**2026-08-28** · 基准版本：**fx-tui 0.14.0** / dsh **0.1.1-rc.2**
> 当期决定：**暂缓适配**，fx-tui 继续 macOS 优先。本文是那轮调研的完整存档，
> 重启适配时以本文为起点，避免重复劳动。
>
> ⚠️ 文中 `file:line` 以 0.14.0 代码为准，后续版本会漂移，按符号名重新定位即可；
> dsh 侧结论基于 0.1.1-rc.2（上游处于 developer preview，声明会有 breaking
> changes），重启时先复核「上游证据」一节的链接是否仍然成立。

## 一、背景与决定

- 起因：身边出现 Windows 用户，想知道 fx-tui 能否在 Windows 上使用。
- 结论：**dsh 上游已原生支持 Windows，fx-tui 自身存在少量 macOS 假设，修复成本约一天、零新增依赖**——技术上完全可行。
- 决定暂缓的理由：项目处于快速加功能阶段；宣称「支持」后的持续成本主要不在代码（平台敏感面很窄），而在**验证债**（开发者用 Mac，无法真机验证 Windows）与**预期管理**（用户把「支持」当承诺）。当前无足够的 Windows 用户压力。
- 过渡期替代方案：Windows 用户直接用 dsh 上游自带的 Web UI（`dsh web`，默认
  http://127.0.0.1:3080）或上游 TUI，两者均已官方支持 Windows。

## 二、dsh 上游 Windows 支持证据（已核实）

仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（公开、MIT、developer preview；issues 关闭所以网上搜不到讨论，证据在设计笔记与发布物里）：

1. **TUI 官方支持 Windows**——设计笔记
   [2026-07-20-windows-tui-support](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/feature/2026-07-20-windows-tui-support.md)
   （状态 implemented，2026-08-04 归档）：TUI 在 Windows 上与 macOS/Linux 同等支持，
   「no platform rejection or reduced Windows mode」；Windows 端启用 virtual-terminal
   输入、不走 Unix 独有的 SIGWINCH。**明确边界：老式控制台（conhost）不在支持范围，
   「unsupported historical Windows console environments do not receive a
   compatibility layer」**——即用户必须用 Windows Terminal / VS Code 终端等
   支持 VT 序列的现代终端。
2. **Windows 默认 shell 是 PowerShell**——笔记
   [2026-08-01-windows-pwsh-default](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-08-01-windows-pwsh-default.md)
   （implemented）：Windows 主机默认挂载受 ACL restricted-token 沙箱约束的 pwsh
   执行器，bash 工具默认不出现（想换 bash 需 WSL/Git-Bash + cordis.patch.yml 覆盖，
   且必须同时关 pwsh 行、开 bash 行，两者注册同一个 `bash` 服务，改一半会在加载时报错）。
   **对 fx-tui 用户的使用预期：Windows 会话里 agent 产出的是 PowerShell 方言命令。**
3. **工程投入**：2026-08-08 起 PR CI 有原生 Windows lane（同目录
   `2026-08-08-native-windows-pull-request-ci.md`）；专门的 `sandbox-windows-acl` 包；
   npm 二进制全平台齐备——`node-addon-require-builtin` 发布 win32-x64/arm64/ia32
   msvc 子包，`node-pty` 自带 ConPTY 预编译。
4. **pwsh 执行器的二进制解析顺序**（dsh-pwsh-local 源码核实）：
   `%ProgramFiles%\PowerShell\7\pwsh.exe` → PATH 上的 `pwsh.exe` → 回退系统自带
   `System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1）。
   **用户无需额外安装 PowerShell**，装了 PowerShell 7 体验更好。
5. **`DSH_HOME` 解析**（dsh-home-paths 源码核实）：`DSH_HOME` 环境变量优先，
   否则 `join(homedir(), '.dsh')` → Windows 上即 `%USERPROFILE%\.dsh`；dsh 自身还
   会展开 `~` 与 `~\` 前缀。
6. 所有 `@deepseek-ai/*` 包的 package.json 均**无 `os` 字段限制**，
   `npm install -g @deepseek-ai/dsh` 在 Windows 不会被 npm 拦截。

## 三、fx-tui 侧排查清单（基准 0.14.0）

### 会坏（必须修）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `bin/fx` | `#!/bin/sh` POSIX 脚本（`command -v`/`[ -d ]`/`exec`/`$HOME`），cmd/PowerShell 下无法执行 |
| 2 | `src/update.ts:53` | 硬编码 `spawn('/bin/sh', ['-lc', script])`，win32 直接 ENOENT——`/update` 与自动升级共用的全部 10 个操作（git rev-parse/fetch/pull/rev-list/status、pnpm install/build）都过这一条通道 |
| 3 | `src/update.ts:104-106` | pnpm 兜底片段是 POSIX 语法（`command -v`、`>/dev/null 2>&1`、`if/fi`） |
| 4 | `src/update.ts:68-75` | 超时强杀用 `process.kill(-pid, 'SIGKILL')` 进程组语义，win32 抛 EINVAL（被 catch 吞掉，孙进程成孤儿）；win32 下需 `taskkill /T /F` 杀树 |
| 5 | `src/path-drops.ts:91-94` | 引号外 `\` 当转义符**吞掉**：`C:\Users\a.png` → `C:Usersa.png`，拖图/`/image` 报找不到文件（双引号内的盘符路径反而没问题——现有代码当时特意处理过） |
| 6 | `src/path-drops.ts:111-124` | 手写 `file://` 解码切坏盘符：`file:///C:/Users/a.png` → `/C:/Users/a.png`（非法路径）；应改走 `node:url` 的 `fileURLToPath` |
| 7 | `src/workspace-files.ts:59-61` | @-补全的仓库相对化与忽略目录过滤全部按 `/` 字符串处理；win32 下 `readdir`/`join` 产出 `\`，前缀剥离失败 → 菜单显示绝对路径、`.git`/`node_modules` 等忽略名单失效 |
| 8 | `src/index.ts:614`、`src/auto-update.ts:58` | npm 安装形态检测 `root.split('/')` 在 win32 永不命中 → `/update` 走错分支（然后死在 /bin/sh），自动升级返回错误路径 |
| 9 | `src/index.ts:816` | 编辑器默认 `'vi'` 在 Windows 不存在，spawnSync 的 ENOENT 又没检查 → `/edit` 静默无效（829 行的 `shell: win32` 本身是对的） |
| 10 | `docs/install.md` | 只写了 macOS/Linux（brew、`/opt/homebrew/bin`、heredoc、`chmod 600`），Windows 无安装路径 |

### 降级（不致命，建议顺手修）

- `src/index.ts:155`：debugLog 硬编码 `/tmp/fx-debug.log`，win32 下静默丢失（try/catch 吞掉）。
- `src/ui/Banner.tsx:98-102`：`homeRelative` 只读 `process.env.HOME`（win32 未定义）→ 横幅不缩写、显示完整路径；应回退 `USERPROFILE`。
- `src/path-drops.ts:35-36`：`~\...`（反斜杠波浪号）不识别，小问题。
- 老式 conhost：OSC 11 探测 120ms 超时后静默按浅色主题（by design，优雅降级）——但上游本就不支持 conhost，文档声明「需 Windows Terminal 等现代终端」即可。

### 已兼容（无需动）

设置/审批记忆/自动升级的文件路径全部 `path.join` + `homedir()`（win32 正确），
`wx` 排他锁可用；`installedRoot`/`probeRebuiltVersion` 走 `fileURLToPath`/
`pathToFileURL`（盘符安全）；`ESC[H`/`ESC[2J`/`ESC[3J` 清屏与 resize 监听、
isTTY 守卫均 Windows Terminal 兼容；OSC 11 背景探测 + COLORFGBG 回退全平台可用；
取消全部走 AbortController（无 SIGWINCH/SIGHUP/termios/stty/osascript/chmod/软链）；
草稿文件走 `os.tmpdir()`；`\r\n` 归一化已有；`cordis.patch.yml` 平台中立；
CJK 宽度是 `string-width` 逻辑计算、不依赖字体；**fx-tui 自身依赖全部纯 JS、无原生模块**。

## 四、适配方案骨架（重启时直接开工）

定位为 **best-effort 档**：修全已知断点，文档明确「以 macOS 为准，Windows 尽力而为，
问题欢迎反馈但不承诺即时修复」，暂不上 Windows CI。**零新增依赖，估约一天。**

- **A. 启动器**：新增 `bin/fx.cmd` 镜像 `bin/fx` 三段逻辑（`where dsh` 检查、
  `DSH_HOME` 默认 `%USERPROFILE%\.dsh` 检查 `profiles\fx`、`dsh --profile fx %*`
  透传）。**错误信息用英文**——cmd.exe 默认 GBK 代码页下 UTF-8 中文会乱码。
  同时新增 `.gitattributes`：`*.cmd text eol=crlf`（批处理对 LF 敏感）、
  `bin/fx text eol=lf`。npm `files` 字段不含 bin/，发布形态不受影响。
- **B. update.ts 跨平台执行器**：POSIX 路径**原样保留**（`/bin/sh -lc`、detached
  进程组、`kill(-pid)`）；win32 分支——git 命令经 `%ComSpec% /d /s /c` 执行
  （脚本文本两平台通用，纯 git 子命令无 shell 方言；分支名已有正则白名单防注入），
  不 detached，超时改 `taskkill /pid <pid> /T /F` 杀进程树；pnpm 操作 win32 先跑
  `pnpm <args>`（参数全是常量，无注入面），退出码 **9009**（cmd 的
  command-not-found，与系统区域无关）时重试 `corepack pnpm <args>`，POSIX 保留
  现有 if/fi 片段。
- **C. 路径处理修复**（平台中立写法，macOS 行为零变化）：workspace-files 改
  `path.relative` + `[\\/]` 分割、basename 兼容双分隔符；两处 node_modules 检测
  改 `[\\/]` 分割；path-drops 在 win32 下引号外 `\` 视为字面字符（POSIX 转义行为
  不变），`file://` 改走 `fileURLToPath`（try/catch 失败回退现有手写解码）。
- **D. 体验修复**：编辑器默认值 win32 → `notepad`（POSIX 仍 `vi`），spawnSync
  失败给出可见提示；Banner `HOME` 未定义回退 `USERPROFILE`；debugLog 改
  `join(tmpdir(), 'fx-debug.log')`（CHANGELOG 注明路径变化）。
- **E. 安装文档**：install.md 的 Agent 一键安装与手动安装均补 Windows（PowerShell）
  分支——Node ≥ 22.19（winget / nvm-windows）、API key 写
  `%USERPROFILE%\.dsh\.credentials.yaml`（无 chmod）、clone/build、
  `dsh plugin --profile fx add "$PWD"`、启动器
  `copy bin\fx.cmd "%LOCALAPPDATA%\Microsoft\WindowsApps\"`（该目录用户可写且默认
  在 PATH，免管理员）。前置要求注明：Windows 10/11 + Windows Terminal / VS Code
  终端（上游明确不为 conhost 提供兼容层）；PowerShell 7 可选（dsh 自动回退 5.1）。
- **F. 版本**：`FX_TUI_VERSION` → 0.15.0，CHANGELOG 建版本段落。

## 五、维护负担结论（为什么当时敢做 / 为什么可以等）

- **平台敏感面只有四类**：拉起子进程、路径字符串处理、文件系统交互入口
  （拖图/@-补全）、终端能力检测。其余功能（渲染/UI/命令/会话/设置）经
  Ink + Node + `path.join` 天然跨平台——本次全库扫描中约九成代码在 Windows 上
  本来就能跑。
- **真正的持续成本**按档位走：写代码的轻微习惯（近零）→ 验证债（Mac 上无法真机
  测 Windows，**最真实的一项**）→ 预期管理（取决于文档怎么宣称）。第三档
  「一等公民」（Windows CI + 每功能双平台验证）才是重负担，除非 Windows 用户
  成规模，否则不必上。
- **晚做的代价可控**：POSIX 假设会随新功能缓慢累积（又几个 `split('/')`、又一处
  硬编码 shell），移植成本单调上涨；但代码库体量不大，涨幅有限。
- **半支持比不做更糟**：只给启动器+文档而不修 update/路径，Windows 用户第一天
  就撞已知 bug，支持成本反而转嫁到维护者身上。要做就修全断点，要么先不做。
- **等待期零成本习惯**（顺便保持，让将来的移植一直是「小活」）：路径一律用
  `path` 模块函数、分割用 `[\\/]`、不硬编码 shell 路径、拉起子进程时显式考虑
  `.cmd` shim。

## 六、重启适配的检查单

1. 复核第二节 dsh 侧结论（笔记链接 + 当前 dsh 版本——上游是 dev preview，可能有变）。
2. 按第三节清单对最新代码重新定位各断点（符号名仍有效，行号会漂移）。
3. 按第四节 A–F 开工；先在本机（macOS）跑 `pnpm typecheck && pnpm run build`，
   路径逻辑用 node 脚本做 POSIX 回归冒烟。
4. 真机验证只能借 Windows 机器（或 Windows 用户按 install.md 走一遍），重点验证：
   启动器、拖图、@-补全、`/update`、`/edit`、`/theme` 的 OSC 11 探测
   （Windows Terminal 下应命中深/浅色正确档）。
