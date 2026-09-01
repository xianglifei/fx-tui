# dsh 0.1.2-alpha 升级预研笔记

> **本文性质**：升级前期调研存档。dsh 上游出现新版本后，本文记录「它改了什么、
> 对 fx-tui 的实际影响如何、怎么修」，供将来**不得不升级时**直接复用，避免重复调研。
> 定位与 [windows-support-notes.md](windows-support-notes.md) 相同：调研已完成并暂缓，
> 重启适配时以本文为准。

- **核实日期**：2026-08-31
- **核实对象**：fx-tui `v0.20.2`（`FX_TUI_VERSION`），锁定 dsh 全家桶 `0.1.1-rc.2`
- **核实手段**：npm registry + GitHub API + **隔离目录实跑 `tsc`**（非仅读发版说明）
- **一句话结论**：上游确有 `0.1.2-alpha.2`，但只在 **`alpha` 通道**，`latest`/`next`
  仍是 `0.1.1-rc.2`；若切到该版本，fx-tui 有 **2 处真实 API 断点、约 10 行改动**即可修好。
  **当前建议不升级**，等 `rc`（会进 `next` 通道）再动。

---

## 1. TL;DR

| 问题 | 结论 |
|---|---|
| dsh 是不是出新版本了？ | 是，但只在 **alpha 通道**：`0.1.2-alpha.2`（2026-08-30）。`latest`/`next` 仍为 `0.1.1-rc.2` |
| 我现在受影响吗？ | **不受影响**。本机 `dsh --version` = `0.1.1-rc.2`，与 fx-tui 锁定版本一致 |
| 升级会断吗？ | 会。实测 **4 个编译错误**，归因为 **2 处 API 变更** |
| 修起来难吗？ | 不难。加 1 个 types-only devDep + 约 10 行改动，实测回到 **0 错误** |
| 那现在要不要升？ | **不要**。等 `next` 通道推进到 `0.1.2-rc.x` 再动（理由见 §9） |

---

## 2. 证据来源与核实方法

### 2.1 只采信权威源

调研中出现过若干第三方聚合站点（dsharness.org、dsh-plugin.org、dsh.hicyou.com、
ofox.io、CSDN 等），**均不予采信** —— 其中有的仍声称「上游自 2026-08-13 起零提交、
停在 0.1.0-rc.6」，已明显过时。本文所有结论只来自：

| 用途 | 权威源 |
|---|---|
| 版本与 dist-tag | `https://registry.npmjs.org/@deepseek-ai%2F<包名>` |
| tag / commit 时间线 | `https://api.github.com/repos/deepseek-ai/deepseek-harness` |
| API 面差异 | 直接下载两个版本的 npm tarball，diff 其中的 `.d.ts` |
| 破坏点清单 | 隔离目录安装新版本后实跑 `tsc`（**决定性证据**） |
| 作用域语义 | 新版本包内 `dsh-scope` 的 `.d.ts` 契约注释 |

### 2.2 为什么必须实跑 tsc

GitHub 的 compare API 对 `files` **硬上限 300 条**，本次差异有 1313 个提交，靠它
取不到全量变更；且 diff 出来的绝大多数是 web/GUI 与 `.agents/notes` 文档噪音。
而**发版说明会漏掉类型层面的静默破坏**，因此最终以「装上新版跑编译」为准，
并额外跑一个旧版本基线作对照，证明错误**确实由升级引入**而非原本就有。

---

## 3. 版本现状快照（2026-08-31）

### 3.1 dist-tag

| 包 | `latest` | `next` | `alpha` |
|---|---|---|---|
| `@deepseek-ai/dsh` | `0.1.1-rc.2` | `0.1.1-rc.2` | **`0.1.2-alpha.2`** |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.6` | `0.1.1-rc.2` | **`0.1.2-alpha.2`** |
| `@deepseek-ai/dsh-llm` | `0.0.1-rc.1` | `0.1.1-rc.2` | **`0.1.2-alpha.2`** |
| `@deepseek-ai/dsh-session` | `0.0.1-rc.1` | `0.1.1-rc.2` | **`0.1.2-alpha.2`** |
| `@deepseek-ai/cordis` | `4.0.2` | `4.0.1-rc.4` | — |

> 注意：`latest` 在不同包上并不一致（dsh 主包 `latest` 是 `0.1.1-rc.2`，而 dsh-agent
> 的 `latest` 还停在 `0.1.0-rc.6`）。这与 fx-tui 现有状况一致 —— AGENTS.md 已记录
> `package.json` 的 `version` 与 `FX_TUI_VERSION` 长期脱节；此处同理，**不要望文生义
> 认为 `latest` 就是最新**。

### 3.2 上游活跃度

- tag：… `dsh-v0.1.1-rc.1` → `dsh-v0.1.1-rc.2` → `dsh-v0.1.2-alpha.1` → **`dsh-v0.1.2-alpha.2`**（`0a53fb55`）
- `dsh-v0.1.1-rc.2...dsh-v0.1.2-alpha.2`：**ahead_by 1313**，变更主体为 web/GUI 与文档
- alpha 期间新增包：`webhook`
- cordis 同期发布 `4.0.2`（commit `6af96785`，vendor 系 release）

### 3.3 上游的预发布通道策略（决定「该不该升」）

上游在 `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md`
明确定义了 dist-tag 映射，成熟度顺序为：

```
alpha  <  canary  <  rc(next)  <  stable(latest)
```

原文要点：

- `latest` 只给**稳定版**（无预发布段）；`rc` 等非 alpha/canary 预发布进 `next`；
  `alpha`/`canary` 映射到同名 tag。
- 「npm dist-tags are mutable aliases and do not participate in version precedence.」
- alpha 的定位是「exercise the publication path and provide early bytes,
  **not to be relied upon**」。

**这是建议不升级的主要依据**：不是因为改不动，而是因为 alpha 按上游自己的定义
就不是拿来依赖的，API 在 alpha → rc 之间还可能再变。

---

## 4. 实测影响面

### 4.1 对照实验

| 环境 | dsh 版本 | cordis | `tsc --noEmit` 结果 |
|---|---|---|---|
| **基线**（fx-tui 现状） | `0.1.1-rc.2` | `4.0.1` | ✅ **0 错误** |
| **目标** | `0.1.2-alpha.2` | `4.0.2` | ❌ **4 错误** |
| 目标 + 修复后 | `0.1.2-alpha.2` | `4.0.2` | ✅ **0 错误** |

基线为 0 错误，证明下列 4 个错误**完全由升级引入**。

### 4.2 错误清单（行号基于 fx-tui v0.20.2）

```text
src/index.ts(350,49):  error TS2339: Property 'registerProvider' does not exist on type 'UserQuestionService'.
src/store.ts(17,29):   error TS2614: Module '"@deepseek-ai/dsh-session"' has no exported member 'TodoItem'.
src/store.ts(429,12):  error TS2678: Type '"todo/write"' is not comparable to type '"agent/inbox/spliced" | ... | "user/message"'.
src/store.ts(430,29):  error TS2339: Property 'data' does not exist on type 'never'.
```

4 个错误归因为 **2 处 API 变更**（§5、§6），其余全部通过。

### 4.3 新版导出符号变动（原始证据）

按包统计被移除 / 新增的导出名。**加粗**为 fx-tui 实际用到者。

| 包 | 移除 | 新增 |
|---|---|---|
| `dsh-session` | JsonValue, isJsonValue, snapshotJsonValue, **`TodoItem`** | EncodedSeq, chunkRowLength, decodeSeqRanges, encodeSeqRanges, isChunkRow |
| `dsh-user-questions` | **`UserQuestionProvider`** | AskUserQuestionRequestEvent |
| `dsh-user-approval` | （事件 `approval/asked`/`approval/decided` 的声明被移除） | ApprovalRequestEvent |
| `dsh-llm` | CallId, OFFLOADED_IMAGE_TEXT, assertNever, deepFreeze, isTokenDelta, offloadRequestImages | ToolCallId, ImageAttachmentAccess, LlmImageRequestPricing, offloadedImageText, TYPERT_REMOTE, … |
| `dsh-tools` | CodeDispatchEventData, CodeDispatchLog, CodeDispatchStartEventData, SDK_SECTION_ORDER | PtcDispatchEventData, PtcDispatchLog, PtcDispatchStartEventData |
| `dsh-token-meter` | SurfaceTokenFold, foldSurfaceTokens | MeterSurfaceNode, PricedSurface, SurfaceTokenPlan, TurnTokenUsage, commitSurfaceTokens, planSurfaceTokens, priceSurface, deriveTurnTokenUsage, … |
| `dsh-session-title` | collectSessionTitleMessages | TitleInputState, TitleProjection, titleProjectionDefinition |
| `dsh-agent` | — | TurnBoundaryProjection |
| `dsh-attachment` | — | requestImageDimensions |
| `dsh-session-query` | — | SessionObservation, SessionObservationReader, … |
| `dsh-skill` / `dsh-commands` / `dsh-compaction` / `dsh-agent-default-model` | 无变化 | 无变化 |

---

## 5. 断点一：提问机制从「全局 provider」改为「作用域 waterfall」

### 5.1 变更内容

旧（`dsh-user-questions@0.1.1-rc.2`）：

```ts
export interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
class UserQuestionService extends Service {
  registerProvider(provider: UserQuestionProvider): () => void  // ← 被删除
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

新（`0.1.2-alpha.2`）：`registerProvider` 与 `UserQuestionProvider` 一并删除，
改为 agent 作用域的 Cordis waterfall 事件：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>
    ): Promise<AskUserQuestionAnswer>
  }
}
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}
```

即：**「注册一个全局单例 provider」→「在事件瀑布里挂一个可委托的监听者」**。

### 5.2 作用域语义（关键，编译期看不见）

新版 `ask()` 的实现分两种情况：

```js
return await (agent === undefined
  ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
  : this.ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer))
```

工具调用提问（正常路径）会带上 agent，走 `scopeTarget(agent, agent)` 作用域分发。
`dsh-scope` 的契约注释给出了决定性说明：

> 「admits **untagged listeners globally**, and admits tagged listeners for a
> matching key or any of its ancestors … A tag BELOW the dispatch key stays
> excluded — **events flow up the chain, never down**.」

**推论**：fx-tui 把监听挂在 bundle 自己的 `ctx`（未打标签）上，会被**全局接纳**，
与旧的全局 provider 行为等价 —— 这是本次迁移可以直接挂 `ctx` 的依据。
若将来需要「只响应自己这个 agent」，则应改为挂在 `setup(agentCtx)` 回调内
（`src/index.ts:192`，那里已有 `installModelSelection(agentCtx, selectionRef)` 的先例）。

子 agent 无需担心：上游在 `ask()` 内会先校验「human interaction 只对活的
runtime root 有效」，被拥有的子 agent 会在分发前以 `DELEGATED_CALLER` 被拒。

### 5.3 其他行为差异

- 新增错误码 `ASK_ABORTED`（signal 已/被 abort）；无监听者应答时为 `NO_PROVIDER`
- 旧代码注册的 abort 监听（`store.cancelQuestions()`）逻辑**仍需保留**

---

## 6. 断点二：TODO 域从 `dsh-session` 拆到 `dsh-tool-todo`

### 6.1 变更内容

| 项 | 旧 | 新 |
|---|---|---|
| `TodoItem` 类型 | `@deepseek-ai/dsh-session` | **`@deepseek-ai/dsh-tool-todo`** |
| `todo/write` 会话事件 | 声明在 `dsh-session` 的 `SessionEventMap` | 由 `dsh-tool-todo` 通过 module augmentation 合并回去 |

新版 `dsh-tool-todo` 的 `lib/types/types.d.ts`：

```ts
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'todo/write': { todos: TodoItem[] }
  }
}
```

这是**纯粹的组织性拆分**（把领域类型收敛到领域包），`TodoItem` 字段一字未改，
所以 fx-tui 的 TODO 面板渲染逻辑无需变动，只需改 import 来源。

### 6.2 一个容易踩的坑

`todo/write` 能重新出现在 `SessionEventMap` 里，**前提是 `dsh-tool-todo` 的类型
被纳入本次编译**。当前靠 `store.ts` 里 `import type { TodoItem }` 顺带加载即可满足，
但这是**隐式依赖** —— 若将来重构掉这个 import，`src/store.ts:429` 的
`case 'todo/write'` 会立刻报错。

**建议**：在 `src/index.ts:35-48` 那批 declaration-merge carrier 里显式补一行
`import type {} from '@deepseek-ai/dsh-tool-todo'`，把「加载 todo 事件声明」
这件事变成显式意图（与现有 `dsh-compaction`、`dsh-session-title` 等 carrier 一致）。

---

## 7. 非破坏性变更（编译通过，但需留意）

以下各项实测 `tsc` 均无报错，但存在语义变化，升级后应做运行时冒烟。

### 7.1 审批事件的作用域变了（无影响，但要知道）

`approval/request` 仍在，但声明位置从 `dsh-user-approval/lib/types/index.d.ts`
移到 `lib/types/types.d.ts`，且：

```diff
-'approval/request'(this: Scoped<ApprovalService>, req: ApprovalRequest, next): Promise<ApprovalOutcome>
+'approval/request'(this: Scoped<Agent>,          req: ApprovalRequestEvent, next): Promise<ApprovalOutcome>
```

fx-tui 不受影响：`src/index.ts:327` 本就有 `if (req.agent.id !== agent.id) return next()`
的过滤，且按 §5.2 的作用域语义，未打标签的监听者仍被全局接纳。

另外 `approval/asked`、`approval/decided` 两个会话事件的声明被移除 —— fx-tui 未使用。
若将来想做审批审计流水，注意这两个事件已不在。

### 7.2 token-meter 换了一整套 API（**建议冒烟**）

`SurfaceTokenFold`、`foldSurfaceTokens` 被移除，换成
`planSurfaceTokens` / `commitSurfaceTokens` / `priceSurface` / `deriveTurnTokenUsage` / `TurnTokenUsage` 等。

fx-tui 用的 `ctx.tokenMeter.measure(agent.session)` 仍在、类型通过，但**用量统计的
语义已经变了**。升级后状态栏这几项要人工核对：

- token 用量与「已用/容量」水位
- **缓存命中率**
- 输出速度 tok/s

### 7.3 重命名（fx-tui 均未使用）

- `CallId` → `ToolCallId`（`dsh-llm`）；`dsh-session` 的 `tool/call` 事件 `callId` 类型随之改
- `CodeDispatch*` → `PtcDispatch*`（`dsh-tools`）
- `collectSessionTitleMessages` → `titleProjectionDefinition` / `TitleProjection`

### 7.4 依赖面

- alpha 的 `dsh-agent` 新增 5 个 peer 依赖：`dsh-scope`、`dsh-system-prompt`、
  `dsh-typert-protocol`、`dsh-session-projection`、`dsh-invariants`。
  这些由 **dsh host 提供**，fx-tui **不需要**加进 `package.json`
  （实测在探针里是作为传递依赖自动装上的）。
- alpha 要求 `@deepseek-ai/cordis` **`^4.0.2`**。fx-tui 现有 peerDep 写的是 `^4.0.1`，
  `^` 已允许 `4.0.2`，**无需改动**；但若要表达得更准确，可顺势提到 `^4.0.2`。

---

## 8. 修复方案（已验证，可直接套用）

以下改动在隔离副本上实跑 `tsc` 后为 **0 错误**。行号基于 fx-tui v0.20.2。

### 8.1 加 types-only devDep

`package.json` → `devDependencies`：

```diff
   "@deepseek-ai/dsh-token-meter": "0.1.1-rc.2",
+  "@deepseek-ai/dsh-tool-todo": "0.1.2-alpha.2",
   "@deepseek-ai/dsh-tools": "0.1.1-rc.2",
```

与现有 `dsh-compaction`、`dsh-session-title` 一样属于 types-only 依赖，
**不增加运行时依赖**（符合 AGENTS.md 的「运行时依赖克制」约定）。

### 8.2 改 TodoItem 的 import 来源

`src/store.ts:17`：

```diff
-import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
+import type { SessionEvent } from '@deepseek-ai/dsh-session'
+import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
```

### 8.3 补显式 carrier（建议，见 §6.2）

`src/index.ts`，在现有 carrier 区（第 35-48 行那批）追加：

```diff
 import type {} from '@deepseek-ai/dsh-tools'
+import type {} from '@deepseek-ai/dsh-tool-todo'
 import type {} from '@deepseek-ai/dsh-user-questions'
```

### 8.4 提问机制改挂 waterfall 事件

`src/index.ts:350-361`，整块替换：

```diff
-  const unregisterQuestions = ctx.userQuestions.registerProvider({
-    ask: (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
-      debugLog('question', request.questions.map(q => q.id))
-      const withdraw = (): void => { store.cancelQuestions() }
-      request.signal?.addEventListener('abort', withdraw, { once: true })
-      return store.askQuestions(request.questions).then(answer => {
-        request.signal?.removeEventListener('abort', withdraw)
-        return answer
-      })
-    },
-  })
-  ctx.effect(() => () => { unregisterQuestions() })
+  ctx.on('user-questions/request', async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
+    debugLog('question', request.questions.map(q => q.id))
+    const withdraw = (): void => { store.cancelQuestions() }
+    request.signal?.addEventListener('abort', withdraw, { once: true })
+    return store.askQuestions(request.questions).then(answer => {
+      request.signal?.removeEventListener('abort', withdraw)
+      return answer
+    })
+  })
```

两点说明：

1. 函数体**原样保留**，只是从 provider 的 `ask()` 搬进事件监听。
2. `ctx.effect(() => () => unregisterQuestions())` 可以删掉 —— 旧写法需要一个手动
   disposer，而 `ctx.on(...)` 由 Cordis 在插件卸载时自动回收。

### 8.5 关于 `inject`

`src/index.ts:87` 的 `inject` 里保留了 `'userQuestions'`。迁移后 fx-tui 代码不再直接
调用 `ctx.userQuestions`，但该服务仍须被加载（提问工具依赖它），**保持原样即可**。

---

## 9. 决策建议与升级触发条件

### 9.1 现在不升级的理由

1. **alpha 的定位就是不稳定**：上游白纸黑字写明 `alpha < canary < rc < stable`，
   且 alpha 是为「跑通发布链路」存在，不供依赖。alpha → rc 之间 API 仍可能再动，
   现在适配有白做的风险。
2. **bundle 必须与 host 同版本**：fx-tui 是跑在 dsh host 进程里的树外 bundle，
   类型面必须跟 host 的 dsh 版本对齐。用 `0.1.1-rc.2` 编译的 fx-tui 配 alpha host
   正是会出问题的组合。
3. **代价不对称**：等 rc 出来只需改这 10 行；现在升则要替上游承担整段 alpha 的不稳定性。

### 9.2 什么时候该动

**触发条件**：`next` 通道从 `0.1.1-rc.2` 推进到 `0.1.2-rc.x`（即 rc 已出）。

检查方式：

```sh
npm view @deepseek-ai/dsh dist-tags
# 关注 latest / next 是否脱离 0.1.1-rc.2
```

### 9.3 动手时的完整清单

1. 把本文 §8 的四处改动落盘
2. `pnpm typecheck && pnpm run build` 必须通过（AGENTS.md 硬性规则 2）
3. 同步升 `src/index.ts` 的 `FX_TUI_VERSION`（AGENTS.md 规则 3）
4. 在 `CHANGELOG.md` 新建版本段落，风格对齐既有条目（AGENTS.md 规则 1）
5. 按 §7.2 做**运行时冒烟**，重点核对状态栏 token 用量 / 缓存命中率 / tok/s
6. 冒烟项：TODO 面板（`todo_write`）、agent 提问卡（`ask_user_question`）、审批四选项

---

## 10. 复现步骤（附录）

将来若要重新核实或核对本文结论，按此搭一个**不污染工作区**的隔离探针：

```sh
# 1) 探针目录：拷源码 + tsconfig，不拷 node_modules
rm -rf /tmp/fxtui-alpha-probe && mkdir -p /tmp/fxtui-alpha-probe
cp -R <fx-tui>/src        /tmp/fxtui-alpha-probe/src
cp    <fx-tui>/tsconfig.json /tmp/fxtui-alpha-probe/

# 2) package.json：保留 fx-tui 的 7 个运行时依赖，把 dsh-* 全部换成目标版本
#    （cordis 跟随目标版本；alpha 需 4.0.2）

# 3) 安装并编译
cd /tmp/fxtui-alpha-probe
npm install --no-audit --no-fund
./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

几个坑，避免重复踩：

- **基线对照必须做**，否则分不清错误是升级引入还是原本就有。基线（0.1.1-rc.2）
  的 npm 安装会遇到 `cordis-plugin-loader` peer 冲突，需加 `--legacy-peer-deps`
  （真实项目用 pnpm，不存在此问题）。
- 直接用 `npx tsc` 可能解析到错误的命令，**用 `./node_modules/typescript/bin/tsc`**。
- GitHub compare API 的 `files` 硬上限 300 条，**取不到全量变更**，别指望它。
- 拿 API 面差异最快的方式是**下载两个版本的 tarball 直接 diff `.d.ts`**，
  比看提交记录干净得多。

---

## 11. 未完成 / 待验证

诚实标注本次调研的边界，重启适配时优先补这几项：

1. **只验证了类型层面**。未拿真实的 `dsh@alpha` host 跑运行时冒烟 ——
   那需要把全局 dsh 换成 alpha，会改动开发环境，本次未做。
2. **token-meter 语义变化未实测**（§7.2），状态栏数字的正确性待人工核对。
3. **作用域语义是读契约注释 + 实现代码推得的**（§5.2），未经真机验证。
   若迁移后发现 agent 提问卡不再弹出，第一嫌疑就是这里 ——
   优先尝试把监听移进 `setup(agentCtx)`。
4. 本文快照截止 2026-08-31。上游迭代很快（alpha.1 → alpha.2 仅隔数日），
   **重启适配时须重新核实版本号与 dist-tag**，不要直接照抄本文的版本号。
