# AGENTS.md — fx-tui 协作约定（Agent 长期记忆）

本文件面向任何在本仓库工作的编码 agent（ZCode、Claude Code 等），内容为
**持久化的项目规则**：随 git 分发，克隆到任何机器都同样生效。开工前先读完，
与本文件冲突时以本文件为准，除非用户当次明确另有指示。

## 硬性规则

1. **每次提交 / 推送到云端仓库（origin），都必须同步更新根目录的
   `CHANGELOG.md`**——按 Keep a Changelog 的中文格式写入对应版本段落：
   - 功能/修复类提交写清动机、行为与影响面，风格对齐既有条目（加粗小标题 +
     细节展开）；
   - 纯文档微调并入当前版本段落即可，但绝不允许出现「无 CHANGELOG 条目的提交」；
   - 忘了写就补写后再推，已推出的分支用追加提交修正而不是强推。
2. **提交前验证**：`pnpm typecheck && pnpm run build` 必须通过再提交。
3. **版本纪律**：功能变更须同步升 `src/index.ts` 的 `FX_TUI_VERSION`
   （显示口径）并在 CHANGELOG 建版本段落。
4. **不要把无关未跟踪文件带进提交**：`.zcode/`、`.workbuddy/`、
   `review-report.*` 等工作区工具产物一律 `git add` 具体路径，禁止裸
   `git add -A` / `git add .`。

## 既有约定（沿袭现状）

- 提交信息风格：`type: 英文短概述 — 关键细节`，type 取 feat / fix /
  docs / chore 等，参考 `git log --oneline` 历史；主分支当前直接推进 main。
- 文档语言：README、docs/、CHANGELOG 面向用户的内容用中文；源码注释用英文，
  跟随现有代码风格（strict TS、防御式编码、注释只讲约束不讲实现步骤）。
- 运行时依赖克制：新功能优先零新增依赖，引入第三方库需在 CHANGELOG 条目中说明理由。

## 注意事项（非规则，但是事实）

- `package.json` 的 `version` 字段（0.1.0）与 `FX_TUI_VERSION` 长期脱节，
  当前以 `FX_TUI_VERSION` 为准；将来启用 npm 分发前必须先对齐二者。
