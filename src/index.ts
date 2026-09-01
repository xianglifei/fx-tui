/**
 * fx-tui — interactive terminal surface for DeepSeek Harness.
 *
 * An out-of-tree dsh bundle: this runner mounts on top of dsh-base, creates
 * (or resumes) one persistent Agent, renders an Ink app over the session
 * event stream, answers approval requests from the keyboard (with
 * session/persistent memory), answers agent questions through the
 * user-questions seam, dispatches slash commands (built-ins plus the dsh
 * command registry), completes @-file references, attaches images to the
 * next message, and shows live context pressure.
 *
 * @module fx-tui
 */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import type { Instance } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Declaration-merge carriers: importing these types registers the ctx keys and
// events we consume (agents, agentDefaultModel, sessions, session/event,
// approval/request, userQuestions, tokenMeter, compaction, sessionTitle,
// cmdlineArgs, appExit, skills, skills/change).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

import { ApprovalMemory } from './approval-memory.js'
import { maybeAutoUpdate } from './auto-update.js'
import { expandPath, imageMediaTypeOf, tokenizePathList } from './path-drops.js'
import { FxSettings } from './settings.js'
import { TuiStore } from './store.js'
import type { ApprovalMode, ToolPresenter } from './store.js'
import { blocksToTextOf, formatToolArgs, toolResultCallIdOf, toolResultTextOf } from './store.js'
import { detectTerminalBackground } from './terminal-bg.js'
import { InputHistory } from './history.js'
import { NOTIFY_MIN_TURN_MS, notifyTurnComplete, notifyModeLabel } from './notify.js'
import type { NotifyMode } from './notify.js'
import { App } from './ui/App.js'
import { draftCapture } from './ui/Input.js'
import type { MenuEntry } from './ui/Input.js'
import { truncateLine } from './ui/estimate.js'
import { renderMarkdownLines } from './markdown.js'
import { activeThemeName, resolveTheme, setActiveTheme, themeDisplayLabel, GHOSTTY_PICKER_ENTRIES } from './ui/theme.js'
import type { ThemeName, ThemeSetting } from './ui/theme.js'
import type { GhosttyThemeId } from './ui/ghostty-themes.js'
import { installedRoot, performSelfUpdate } from './update.js'
import type { ToolResult } from '@deepseek-ai/dsh-tools'

export const FX_TUI_VERSION = '0.20.3'

/** Idle window after launch before the one-shot background update check fires. */
const AUTO_UPDATE_DELAY_MS = 120_000

/** Quiet gap after the last resize event before the rebuild remount fires. */
const RESIZE_DEBOUNCE_MS = 300

/** Auto-compaction engages above this context ratio (when enabled via /config). */
const AUTO_COMPACT_RATIO = 0.85

/** Stable Cordis plugin name. */
export const name = 'fx-tui-runner'

/** Core services required before the TUI can drive an agent. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'userQuestions', 'attachments', 'commands', 'llm', 'sessionQuery', 'skills']

const USAGE = `fx-tui v${FX_TUI_VERSION} — DeepSeek Harness 的交互式终端界面

用法：fx [选项]（即 dsh --profile fx）

选项：
  --resume <sessionId>   恢复一个已持久化的会话
  -h, --help             显示帮助
  -v, --version          显示版本

按键：Enter 发送（运行中＝注入当前轮）· Ctrl+J 换行 · ↑↓ 历史/菜单 · Tab 补全或运行中排队 ·
Alt+↑ 取回消息 · Ctrl+V 粘贴文本/图片 · Shift+Tab 权限模式 · Esc 中断 · Ctrl+O 工具详情 · Ctrl+C 清空/双击退出

命令与技能：输入 / 弹出补全菜单（「命令」与「技能」双分组标题，随输入实时筛选）；
选中技能插入 /技能名 手势，回车发送后模型自动加载该技能（也可在消息中直接写 /技能名）。
`

interface CliOptions {
  resume?: string
}

function readCliOptions(ctx: Context, exit: (code: number) => void | Promise<void>): CliOptions | null {
  const raw: readonly string[] = ctx.get('cmdlineArgs')?.get() ?? []
  const options: CliOptions = {}
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      void exit(0)
      return null
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`fx-tui v${FX_TUI_VERSION}\n`)
      void exit(0)
      return null
    }
    if (arg === '--resume') {
      const value = raw[++i]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--resume 需要一个会话 id')
      }
      options.resume = value
      continue
    }
    if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length)
      if (value === '') throw new Error('--resume 需要一个会话 id')
      options.resume = value
      continue
    }
    throw new Error(`未知参数：${arg}（可用：--resume <id>，--help 查看帮助）`)
  }
  return options
}

/** dsh core version from the installed harness (display-only; blank when unreadable). */
function readDshVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@deepseek-ai/dsh-agent/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** Mount the interactive terminal surface. */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('fx-tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  void main(ctx, exit).catch((error: unknown) => {
    process.stderr.write(`fx-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    void exit(1)
  })
}

async function main(ctx: Context, exit: (code: number) => void | Promise<void>): Promise<void> {
  const debug = process.env.FX_TUI_DEBUG !== undefined
  const debugLog = (label: string, data?: unknown): void => {
    if (!debug) return
    try {
      appendFileSync('/tmp/fx-debug.log', `${Date.now()} ${label} ${JSON.stringify(data) ?? ''}\n`)
    } catch { /* debug logging is best-effort */ }
  }

  // Loader siblings mount concurrently: await the complete application before
  // creating an Agent so its scoped tools and adapters are fully composed.
  await ctx.get('loader')?.await()

  const options = readCliOptions(ctx, exit)
  if (options === null) return
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  // Early process shutdown can dispose the tree while we are starting up.
  if (agents === undefined || defaultModel === undefined) return
  const registry = agents
  const defaultModelService = defaultModel

  const selection = defaultModelService.currentSelection()
  // The live selection ref: mutating `current` switches the model from the next step.
  let selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    selectionRef = { current: selectionRef.current ?? selection, assembled: undefined }
    installModelSelection(agentCtx, selectionRef)
  }

  let handle = options.resume !== undefined
    ? await registry.resume({ resumeSessionId: SessionId(options.resume), agentOptions, setup })
    : await registry.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
  let agent: Agent = handle.agent

  const modelLabel = (): string =>
    `${agent.options.provider ?? selectionRef.current?.provider ?? ''}/${agent.options.model ?? selectionRef.current?.model ?? ''}`
  const presenter = createPresenter(ctx)
  // Startup default approval stance comes from the persisted settings file
  // (default 'auto'); Shift+Tab then changes the session without touching it.
  const settings = new FxSettings(process.env.DSH_HOME)
  // Background tone detected once before the first render; /theme auto
  // re-resolves against this value instead of re-querying the terminal.
  let detectedTheme: ThemeName | null = null
  const store = new TuiStore(agent.id, modelLabel(), presenter, settings.approvalMode)
  const memory = new ApprovalMemory(process.env.DSH_HOME)
  // Persistent input history (↑/↓ browse): the live array is handed to the
  // editor by reference, pushes need no React notification path.
  const inputHistory = new InputHistory(process.env.DSH_HOME)
  const history: readonly string[] = inputHistory.entries
  // Long-turn completion tracking (turn/start → turn/end) and opt-in
  // auto-compaction bookkeeping.
  let turnStartedAt: number | null = null
  let autoCompactTried = false
  let autoCompacting = false
  store.addBanner({
    fxVersion: FX_TUI_VERSION,
    dshVersion: readDshVersion(),
    model: modelLabel(),
    sessionId: agent.id,
    cwd: process.cwd(),
    resumed: options.resume !== undefined,
  })
  store.replay(agent.session.events)
  store.finishReplay()

  // Live subagent tracking: children created against this session show a badge.
  const childAgents = new Set<string>()
  const syncChildCount = (): void => { store.setChildAgentCount(childAgents.size) }
  ctx.on('agent/created', payload => {
    if (payload.agent.session.header.parentSession === agent.session.id) {
      childAgents.add(payload.agent.id)
      syncChildCount()
    }
  })
  ctx.on('agent/disposed', payload => {
    if (childAgents.delete(payload.agent.id)) syncChildCount()
  })

  ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    debugLog('event', event.type)
    store.onEvent(event)
    // Long-turn completion notification: measured turn/start → turn/end, so
    // back-to-back turns each announce themselves; aborted turns are the ones
    // the user is present for.
    if (event.type === 'turn/start') {
      turnStartedAt = event.time
    } else if (event.type === 'turn/end') {
      const elapsed = turnStartedAt !== null ? Math.max(0, event.time - turnStartedAt) : 0
      turnStartedAt = null
      if (elapsed >= NOTIFY_MIN_TURN_MS && event.data.reason.kind !== 'aborted') {
        notifyTurnComplete(settings.notify, event.data.reason.kind !== 'error', elapsed)
      }
    }
    // Refresh context pressure once per completed step: the meter is O(surface)
    // and the next request's size is what the user cares about.
    if (event.type === 'assistant/message' || event.type === 'turn/end') {
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          store.setContextPressure(meter.measure(agent.session).totalTokens)
        } catch { /* metering is display-only */ }
      }
    }
  })

  // Auto-compaction (opt-in via /config): fires when the agent reaches idle
  // with the context water level above AUTO_COMPACT_RATIO. One attempt per
  // high-pressure episode — the flag re-arms once compaction (or a manual
  // /compact) drops the level back below the threshold.
  ctx.on('agent/status', payload => {
    if (payload.agent.id !== agent.id || payload.status !== 'idle') return
    const snapshot = store.getSnapshot()
    if (snapshot.contextWindow === undefined || snapshot.contextWindow <= 0) return
    const ratio = snapshot.contextTokens / snapshot.contextWindow
    if (ratio < AUTO_COMPACT_RATIO) {
      autoCompactTried = false
      return
    }
    if (autoCompactTried) return
    autoCompactTried = true
    void maybeAutoCompact()
  })

  /** Pressure-triggered history compaction through the kernel engine; runs
   * from true idle so the durable lock is free. Failure paths surface as
   * notices — the turn loop itself is never affected. */
  async function maybeAutoCompact(): Promise<void> {
    if (!settings.autoCompact || autoCompacting || agent.status !== 'idle') return
    const compaction = ctx.get('compaction')
    if (compaction === undefined) return
    autoCompacting = true
    try {
      store.addNotice('上下文水位较高：正在自动压缩历史（/config autocompact off 可关闭）')
      const result = await compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal)
      if (result === null) {
        store.addNotice('自动压缩：内核判断当前没有可安全压缩的区间（可手动 /compact）', 'warn')
        return
      }
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          store.setContextPressure(meter.measure(agent.session).totalTokens)
        } catch { /* metering is display-only */ }
      }
      store.addNotice('✅ 已自动压缩历史上下文')
    } catch (error) {
      store.addNotice(`自动压缩失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      autoCompacting = false
    }
  }

  ctx.on('approval/request', async (req, next) => {
    if (req.agent.id !== agent.id) return next()
    // Auto mode (Shift+Tab) answers every ask without prompting.
    if (store.getSnapshot().approvalMode === 'auto') return 'allowed-once'
    debugLog('approval-request', { toolName: req.toolName, reason: req.reason })
    const pending = store.pendingToolFor(req.callId)
    const key = ApprovalMemory.key(req.toolName, pending?.args ?? '')
    if (pending !== undefined && memory.isAllowed(key)) {
      store.addNotice(`已按记忆规则自动允许 ${req.toolName}（总是授权可删除 $DSH_HOME/fx-tui-allowlist.json 清除）`)
      return 'allowed-once'
    }
    const withdraw = (): void => { store.cancelApproval() }
    req.signal?.addEventListener('abort', withdraw, { once: true })
    const choice = await store.askApproval({
      toolName: req.toolName,
      reason: req.reason ?? '',
      command: pending !== undefined ? formatToolArgs(pending.args, 120) : undefined,
    })
    req.signal?.removeEventListener('abort', withdraw)
    if (choice === 'session') memory.allowSession(key)
    if (choice === 'always') memory.allowAlways(key)
    return choice === 'reject' ? 'rejected' : 'allowed-once'
  })

  const unregisterQuestions = ctx.userQuestions.registerProvider({
    ask: (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      debugLog('question', request.questions.map(q => q.id))
      const withdraw = (): void => { store.cancelQuestions() }
      request.signal?.addEventListener('abort', withdraw, { once: true })
      return store.askQuestions(request.questions).then(answer => {
        request.signal?.removeEventListener('abort', withdraw)
        return answer
      })
    },
  })
  ctx.effect(() => () => { unregisterQuestions() })

  let instance: Instance | null = null

  // -- Slash commands ---------------------------------------------------------

  const builtinCommands: readonly MenuEntry[] = [
    { name: 'help', description: '查看按键与命令帮助', kind: 'builtin' },
    { name: 'status', description: '查看运行状态与插件树', kind: 'builtin' },
    { name: 'sessions', description: '切换会话（可带关键词过滤）', kind: 'builtin' },
    { name: 'rename', description: '重命名当前会话', kind: 'builtin' },
    { name: 'model', description: '切换模型 / provider', kind: 'builtin' },
    { name: 'effort', description: '切换推理强度档位', kind: 'builtin' },
    { name: 'btw', description: '侧问：复用上下文单轮提问，不打断主任务', kind: 'builtin' },
    { name: 'context', description: '查看上下文水位与组成明细', kind: 'builtin' },
    { name: 'doctor', description: '环境自检（Node/路由/密钥/终端）', kind: 'builtin' },
    { name: 'config', description: '查看 / 修改设置（权限、更新、通知、自动压缩）', kind: 'builtin' },
    { name: 'theme', description: '切换配色主题：自动 / 浅色 / 深色 / Ghostty 精选', kind: 'builtin' },
    { name: 'export', description: '导出当前会话为 Markdown', kind: 'builtin' },
    { name: 'edit', description: '用 $EDITOR 编写长消息', kind: 'builtin' },
    { name: 'image', description: '附加图片：<路径>… 或直接拖入终端；空参查看明细', kind: 'builtin' },
    { name: 'update', description: '拉取 fx-tui 最新代码并重建（git 克隆安装时可用）', kind: 'builtin' },
    { name: 'exit', description: '退出 fx-tui', kind: 'builtin' },
  ]

  /** Interactive single-choice picker reusing the question UI; resolves undefined when skipped.
   * Options render in a scrolling window, so lists beyond nine no longer need slicing. */
  async function pick(title: string, options: readonly { label: string; description?: string }[]): Promise<string | undefined> {
    if (options.length === 0) return undefined
    const answer = await store.askQuestions([{
      id: `fx-tui-pick-${Date.now()}`,
      question: title,
      options: options.map(option => ({
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
      })),
    }])
    return answer.answers[0]?.selected[0]
  }

  async function switchSession(sessionId: string): Promise<void> {
    if (agent.session.id === sessionId) {
      store.addNotice('已在当前会话中')
      return
    }
    if (agent.status === 'running') {
      store.addNotice('当前任务运行中：先等它完成或按 Esc 中断，再切换会话', 'warn')
      return
    }
    try {
      await ctx.get('sessions')?.flush(agent.session)
    } catch { /* best-effort durability before switching */ }
    try {
      await handle.dispose()
      handle = await registry.resume({ resumeSessionId: SessionId(sessionId), agentOptions: agent.options, setup })
      agent = handle.agent
      // The new session may live in another workspace: project skills differ.
      void refreshSkills()
      childAgents.clear()
      syncChildCount()
      autoCompactTried = false
      store.reset(agent.id, modelLabel(), agent.session.events)
      store.addNotice(`已切换到会话 ${agent.id}`)
    } catch (error) {
      store.addNotice(`切换会话失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function listSessionChoices(query: string): Promise<void> {
    let records
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (error) {
      store.addNotice(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const parents = records.filter(record => !record.header.parentSession && record.header.origin !== 'subagent')
    // Titles fold once for the newest slice — the listing stays cheap even
    // with a large session corpus.
    const titleById = new Map<string, string>()
    try {
      const observations = await ctx.sessionQuery.readTitleSnapshots(parents.slice(0, 100).map(record => record.header.id))
      for (const observation of observations) {
        if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
          titleById.set(observation.sessionId, observation.value.title.title)
        }
      }
    } catch { /* titles are display-optional */ }
    const needle = query.trim().toLowerCase()
    const filtered = needle === ''
      ? parents
      : parents.filter(record => {
          const title = titleById.get(record.header.id) ?? ''
          const haystack = `${title} ${record.header.cwd ?? ''} ${record.header.id}`.toLowerCase()
          return haystack.includes(needle)
        })
    if (filtered.length === 0) {
      store.addNotice(needle === '' ? '没有可切换的会话' : `没有匹配「${query.trim()}」的会话`)
      return
    }
    // Duplicate labels (same minute + directory) would make the picker's
    // label→record lookup ambiguous; a counter suffix keeps them unique.
    // Bounded, not capped at the window: the question card scrolls.
    const seenLabels = new Map<string, number>()
    const choices = filtered.slice(0, 100).map(record => {
      const created = new Date(record.header.createdAt)
      const stamp = `${created.getMonth() + 1}-${created.getDate()} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`
      const dir = record.header.cwd !== undefined ? basename(record.header.cwd) : '?'
      const title = titleById.get(record.header.id)
      let label = `${title !== undefined ? `${truncateLine(title, 24)} · ` : ''}${stamp} · ${dir}${record.live ? ' · 运行中' : ''}`
      const seen = seenLabels.get(label) ?? 0
      seenLabels.set(label, seen + 1)
      if (seen > 0) label = `${label} #${seen + 1}`
      return {
        label,
        description: record.header.id.slice(0, 21),
        id: record.header.id,
      }
    })
    const chosen = await pick(`选择要切换到的会话${needle !== '' ? `（过滤：${query.trim()}）` : ''}`, choices)
    const target = choices.find(choice => choice.label === chosen)
    if (target === undefined) return
    await switchSession(target.id)
  }

  async function listModelChoices(): Promise<void> {
    const providers = ctx.llm.listProviders()
    if (providers.length === 0) {
      store.addNotice('没有已注册的模型 provider')
      return
    }
    const options: { label: string; description?: string }[] = []
    for (const provider of providers) {
      let models: readonly { id: string }[] = []
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch { /* provider without a listing stays absent */ }
      for (const model of models) {
        options.push({ label: `${provider.id}/${model.id}` })
      }
    }
    if (options.length === 0) {
      store.addNotice('没有可列举的模型')
      return
    }
    const chosen = await pick(`切换模型（当前 ${modelLabel()}）`, options)
    if (chosen === undefined) return
    const [provider, ...rest] = chosen.split('/')
    const model = rest.join('/')
    if (provider === undefined || model === '') return
    selectionRef.current = { provider, model }
    store.setModel(`${provider}/${model}`)
    store.addNotice(`模型已切换为 ${provider}/${model}（下一步请求生效）`)
    try {
      await defaultModelService.saveSelection({ provider, model })
    } catch { /* persisting the default is best-effort */ }
  }

  // -- Session rename ----------------------------------------------------------

  /** Latest log-backed title of the current session (display-optional). */
  async function currentSessionTitle(): Promise<string | undefined> {
    try {
      const snapshot = await ctx.sessionQuery.readTitle(agent.session.id)
      return snapshot?.title
    } catch {
      return undefined
    }
  }

  /** `/rename <title>`: pin an explicit user title; automatic generation stops. */
  async function runRename(arg: string): Promise<void> {
    const titleService = ctx.get('sessionTitle')
    const raw = arg.trim()
    if (raw === '') {
      const current = await currentSessionTitle()
      store.addPanel('会话重命名', [
        current !== undefined ? `当前标题：${current}` : '当前会话还没有标题',
        '',
        '用法：/rename <新标题>（重命名后自动生成标题停止，/sessions 列表按标题展示）',
      ])
      return
    }
    if (titleService === undefined) {
      store.addNotice('会话标题服务不可用（需要 dsh-base 提供 sessionTitle）', 'error')
      return
    }
    try {
      const snapshot = titleService.rename(agent.session, raw)
      store.addNotice(`会话已重命名：「${snapshot.title}」`)
    } catch (error) {
      store.addNotice(`重命名失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  // -- Reasoning effort ----------------------------------------------------------

  /** `/effort`: picker over the model's adapter-owned effort tiers, or a
   * direct one-shot form (`/effort <id|name>`, `/effort status`). Switching
   * rides the same model-selection ref as /model — next request wins. */
  async function runEffort(arg: string): Promise<void> {
    const current = selectionRef.current ?? selection
    let reasoning: { efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[]; defaultEffort?: ReasoningEffortId } | undefined
    try {
      const info = await ctx.llm.resolveModelInfo(current.provider, current.model)
      reasoning = info.reasoning
    } catch { /* route without reasoning metadata reports below */ }
    if (reasoning === undefined || reasoning.efforts.length === 0) {
      store.addNotice(`当前模型 ${current.provider}/${current.model} 没有可切换的推理强度档位`, 'warn')
      return
    }
    const active = current.reasoningEffort ?? reasoning.defaultEffort
    const activeName = reasoning.efforts.find(effort => effort.id === active)?.name ?? active ?? '(模型默认)'
    const raw = arg.trim()
    if (raw !== '' && raw.toLowerCase() !== 'status') {
      const key = raw.toLowerCase()
      const effort = reasoning.efforts.find(effort => effort.id.toLowerCase() === key || effort.name.toLowerCase() === key)
      if (effort === undefined) {
        store.addNotice(`未知档位：${raw}（可用：${reasoning.efforts.map(effort => effort.id).join(' / ')}）`, 'warn')
        return
      }
      applyEffort(current, effort.id, effort.name)
      return
    }
    if (raw.toLowerCase() === 'status') {
      store.addPanel('推理强度', [
        `当前：${activeName}${active === undefined ? '（未显式设置）' : ''}`,
        ...reasoning.efforts.map(effort =>
          `· ${effort.name}（${effort.id}${effort.id === active ? ' · 当前' : effort.id === reasoning?.defaultEffort ? ' · 默认' : ''}）${effort.description !== undefined ? ` — ${effort.description}` : ''}`),
      ])
      return
    }
    const chosen = await pick(`推理强度（当前 ${activeName}）`, reasoning.efforts.map(effort => ({
      label: effort.name,
      description: `${effort.id === active ? '当前' : effort.id === reasoning?.defaultEffort ? '默认' : effort.id}${effort.description !== undefined ? ` · ${truncateLine(effort.description, 26)}` : ''}`,
    })))
    if (chosen === undefined) return
    const effort = reasoning.efforts.find(effort => effort.name === chosen)
    if (effort !== undefined) applyEffort(current, effort.id, effort.name)
  }

  function applyEffort(current: { provider: string; model: string }, effortId: ReasoningEffortId, name: string): void {
    selectionRef.current = { provider: current.provider, model: current.model, reasoningEffort: effortId }
    try {
      void defaultModelService.saveSelection({ provider: current.provider, model: current.model, reasoningEffort: effortId })
        .catch(() => { /* persisting the default is best-effort */ })
    } catch { /* saveSelection rejection is handled above */ }
    store.addNotice(`推理强度已切换为 ${name}（下一步请求生效，已存为启动默认）`)
  }

  // -- Side question (/btw) -------------------------------------------------------

  let btwController: AbortController | null = null

  /** `/btw <question>`: one no-tools model call over the current conversation
   * surface. It never touches the session log (no history, no token meter),
   * never interrupts the main turn, and supersedes any in-flight side ask. */
  async function runBtw(question: string): Promise<void> {
    const trimmed = question.trim()
    if (trimmed === '') {
      store.addNotice('用法：/btw <问题>（复用当前上下文的单轮侧问，不打断主任务、不写入会话）', 'warn')
      return
    }
    if (btwController !== null) btwController.abort()
    const controller = new AbortController()
    btwController = controller
    store.addNotice(`侧问中（不打断主任务）：${truncateLine(trimmed, 50)}`)
    try {
      const route = selectionRef.current ?? selection
      const message = createUserMessage({
        content: [{ type: 'text', text: `（侧问，请直接简要回答）${trimmed}` }],
        source: { kind: 'user' },
      })
      const chunks = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
        messages: [...agent.session.deriveMessages(), message],
        signal: controller.signal,
      })
      let answer = ''
      let failure = ''
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') answer += chunk.text
        else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') failure = '模型返回错误'
          else if (chunk.reason.kind === 'aborted') failure = '已中止'
        }
      }
      if (controller.signal.aborted) return // superseded by a newer side ask
      if (failure !== '') {
        store.addNotice(`侧问失败：${failure}`, 'error')
        return
      }
      if (answer.trim() === '') {
        store.addNotice('侧问没有返回内容', 'warn')
        return
      }
      const width = Math.max(24, (process.stdout.columns ?? 80) - 6)
      store.addPanel(`侧问：${trimmed}`, [
        '',
        ...renderMarkdownLines(answer, width),
        '',
        '（侧问不写入会话历史，也不计入 token 统计）',
      ])
    } catch (error) {
      if (controller.signal.aborted) return
      store.addNotice(`侧问失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      if (btwController === controller) btwController = null
    }
  }

  // -- Context detail (/context) ---------------------------------------------------

  /** `/context`: water level plus a heuristic composition split (system /
   * tools / messages) — composition figures are estimates, the level and the
   * last provider usage report are not. */
  function runContext(): void {
    const meter = ctx.get('tokenMeter')
    const snapshot = store.getSnapshot()
    let total = snapshot.contextTokens
    if (meter !== undefined) {
      try {
        total = meter.measure(agent.session).totalTokens
      } catch { /* keep the last refreshed value */ }
    }
    const window = snapshot.contextWindow
    const percent = window !== undefined && window > 0 ? ` · ${Math.round((total / window) * 100)}%` : ''
    // Newest request/header reconstructs the envelope the next request sends.
    let systemChars = 0
    let toolCount = 0
    let toolChars = 0
    for (let i = agent.session.events.length - 1; i >= 0; i--) {
      const event = agent.session.events[i]!
      if (event.type !== 'request/header') continue
      systemChars = event.data.header.system?.length ?? 0
      const tools = event.data.header.tools ?? []
      toolCount = tools.length
      toolChars = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)
      break
    }
    const estimate = (chars: number): number => Math.round(chars / 3)
    const usage = snapshot.lastUsage
    const lines = [
      `上下文水位：${total} tokens${window !== undefined && window > 0 ? ` / ${window}` : ''}${percent}`,
      '',
      '组成（启发式估算，仅看大致占比）：',
      `· 系统提示：约 ${estimate(systemChars)} tokens（${systemChars} 字符）`,
      `· 工具定义：${toolCount} 个 · 约 ${estimate(toolChars)} tokens`,
      `· 对话消息：约 ${Math.max(0, total - estimate(systemChars) - estimate(toolChars))} tokens`,
      '',
      '最近一次请求用量（provider 报告）：',
      usage !== null
        ? `· 输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens ?? 0} · 缓存写 ${usage.cacheWriteTokens ?? 0}${usage.reasoningTokens !== undefined ? ` · 推理 ${usage.reasoningTokens}` : ''}`
        : '· 尚无用量记录（还没有完成过一次请求）',
    ]
    store.addPanel('已加载上下文', lines)
  }

  // -- Environment self-check (/doctor) ----------------------------------------------

  /** `/doctor`: startup facts as ✓/✗/· lines; failures point at the fix. */
  async function runDoctor(): Promise<void> {
    const lines: string[] = []
    const check = (ok: boolean | null, label: string, detail: string): void => {
      lines.push(`${ok === true ? '✓' : ok === false ? '✗' : '·'} ${label}${detail !== '' ? `：${detail}` : ''}`)
    }
    check(parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22, 'Node', `${process.version}（要求 ≥22.19）`)
    check(true, '平台', `${process.platform}/${process.arch}${process.platform === 'darwin' ? '' : '（fx-tui 仅在 macOS 上验证）'}`)
    const dshVersion = readDshVersion()
    check(dshVersion !== '', 'dsh 内核', dshVersion !== '' ? dshVersion : '版本号不可读（不影响使用）')
    const route = selectionRef.current ?? selection
    const providers = ctx.llm.listProviders().map(provider => provider.id)
    check(providers.includes(route.provider), '模型路由', `${route.provider}/${route.model}${providers.includes(route.provider) ? '' : `（provider 未注册，可用：${providers.join(' / ') || '无'}）`}`)
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      const window = info.context?.contextWindow
      const efforts = info.reasoning?.efforts.length ?? 0
      check(true, '模型能力', `上下文窗口 ${window !== undefined ? window : '未知'} · 推理档位 ${efforts > 0 ? efforts : '无'}`)
    } catch (error) {
      check(false, '模型能力', `解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
    const hasCredentials = process.env.DEEPSEEK_API_KEY !== undefined || existsSync(join(dshHome, '.credentials.yaml'))
    check(hasCredentials, 'API 凭证', hasCredentials ? '可用（DEEPSEEK_API_KEY 或 dsh 凭证文件）' : '未找到（DEEPSEEK_API_KEY 未设置且无 ~/.dsh/.credentials.yaml）')
    check(true, '设置文件', `${settings.location}${existsSync(settings.location) ? '' : '（尚未生成，首次修改设置时创建）'}`)
    check(true, '输入历史', `${inputHistory.entries.length} 条（$DSH_HOME/fx-tui-input-history.json）`)
    check(process.stdout.isTTY === true, '终端', `TTY=${process.stdout.isTTY === true ? '是' : '否'} · ${process.stdout.columns ?? '?'}×${process.stdout.rows ?? '?'} · TERM=${process.env.TERM ?? '(未设置)'}`)
    check(existsSync(process.cwd()), '工作目录', process.cwd())
    store.addPanel('环境自检 /doctor', lines)
  }

  /** Persisted-settings labels; keeps notices and panels uniform. */
  const modeLabel = (mode: ApprovalMode): string => mode === 'auto' ? '自动允许' : '每次询问'
  const DIRECT_MODE_WORDS: Record<string, ApprovalMode> = {
    auto: 'auto', ask: 'ask',
    '自动允许': 'auto', 自动: 'auto',
    '每次询问': 'ask', 询问: 'ask',
  }
  const AUTO_WORDS: Record<string, boolean> = {
    on: true, off: false,
    开启: true, 开: true, 打开: true,
    关闭: false, 关: false,
  }
  const NOTIFY_WORDS: Record<string, NotifyMode> = {
    off: 'off', bell: 'bell', system: 'system',
    关闭: 'off', 铃声: 'bell', 终端铃声: 'bell', 系统: 'system', 系统通知: 'system',
  }

  /** `/config`: interactive picker for the persisted startup defaults, or a
   * direct one-shot form (`/config permission auto|ask`,
   * `/config autoupdate on|off`, `/config notify off|bell|system`,
   * `/config autocompact on|off`). Changing a default also flips the current
   * session so both views stay consistent — unlike Shift+Tab, which never
   * touches the file. */
  async function runConfig(arg: string): Promise<void> {
    const tokens = arg.split(/\s+/).filter(token => token !== '')
    if (tokens.length > 0) {
      const [key, value] = tokens
      const modeTarget = key === 'permission' && value !== undefined ? DIRECT_MODE_WORDS[value.toLowerCase()] : undefined
      if (modeTarget !== undefined) {
        applyApprovalMode(modeTarget)
        return
      }
      const autoRaw = key === 'autoupdate' && value !== undefined ? value.toLowerCase() : undefined
      if (autoRaw !== undefined) {
        const autoTarget = AUTO_WORDS[autoRaw]
        if (autoTarget === undefined) {
          store.addNotice('用法：/config autoupdate <on|off>', 'warn')
          return
        }
        applyAutoUpdate(autoTarget)
        return
      }
      const notifyRaw = key === 'notify' && value !== undefined ? value.toLowerCase() : undefined
      if (notifyRaw !== undefined) {
        const notifyTarget = NOTIFY_WORDS[notifyRaw]
        if (notifyTarget === undefined) {
          store.addNotice('用法：/config notify <off|bell|system>（关闭 / 终端铃声 / macOS 系统通知）', 'warn')
          return
        }
        applyNotify(notifyTarget)
        return
      }
      const compactRaw = key === 'autocompact' && value !== undefined ? value.toLowerCase() : undefined
      if (compactRaw !== undefined) {
        const compactTarget = AUTO_WORDS[compactRaw]
        if (compactTarget === undefined) {
          store.addNotice('用法：/config autocompact <on|off>（水位过高时自动 /compact）', 'warn')
          return
        }
        applyAutoCompact(compactTarget)
        return
      }
      store.addNotice('用法：/config（交互选择）· /config permission <auto|ask> · /config autoupdate <on|off> · /config notify <off|bell|system> · /config autocompact <on|off>', 'warn')
      return
    }
    const modeChosen = await pick(`设置启动默认权限模式（当前 ${modeLabel(settings.approvalMode)}）`, [
      { label: '自动允许', description: '工具调用不再逐个询问；之后每次启动默认开启' },
      { label: '每次询问', description: '工具调用逐个请求批准；之后每次启动默认关闭' },
    ])
    const modeTarget = DIRECT_MODE_WORDS[modeChosen ?? '']
    if (modeTarget !== undefined) applyApprovalMode(modeTarget)
    const autoChosen = await pick(`后台自动更新（当前 ${settings.autoUpdate ? '开启' : '关闭'}）`, [
      { label: '开启', description: '启动约两分钟后静默拉取新版本并重建；每 24 小时最多联网一次，重启 fx 生效' },
      { label: '关闭', description: '仅在手动运行 /update 时联网' },
    ])
    if (autoChosen !== undefined) {
      const autoTarget = AUTO_WORDS[autoChosen]
      if (autoTarget !== undefined) applyAutoUpdate(autoTarget)
    }
    const notifyChosen = await pick(`长任务完成通知（当前 ${notifyModeLabel(settings.notify)}）`, [
      { label: '终端铃声', description: '回合超过 10 秒结束时响铃（终端的铃声/视觉提示设置决定表现形式）' },
      { label: '系统通知', description: 'macOS 通知中心弹窗 + 提示音（同样只在超过 10 秒的回合结束时）' },
      { label: '关闭', description: '不做任何提醒' },
    ])
    if (notifyChosen !== undefined) {
      const notifyTarget = NOTIFY_WORDS[notifyChosen]
      if (notifyTarget !== undefined) applyNotify(notifyTarget)
    }
    const compactChosen = await pick(`自动压缩历史（当前 ${settings.autoCompact ? '开启' : '关闭'}）`, [
      { label: '开启', description: '空闲且上下文水位 ≥85% 时自动压缩历史（/compact 同款，压缩后无法完整回放旧对话）' },
      { label: '关闭', description: '只在 80%/95% 水位警告，由你手动 /compact' },
    ])
    if (compactChosen !== undefined) {
      const compactTarget = AUTO_WORDS[compactChosen]
      if (compactTarget !== undefined) applyAutoCompact(compactTarget)
    }
  }

  function applyNotify(target: NotifyMode): void {
    const changed = settings.notify !== target
    settings.setNotify(target)
    if (!changed) {
      store.addNotice(`完成通知已是${notifyModeLabel(target)}（${settings.location}）`)
      return
    }
    store.addNotice(`完成通知已保存为${notifyModeLabel(target)}（${settings.location}）`)
  }

  function applyAutoCompact(target: boolean): void {
    const changed = settings.autoCompact !== target
    settings.setAutoCompact(target)
    const state = target ? '开启' : '关闭'
    if (!changed) {
      store.addNotice(`自动压缩已是${state}（${settings.location}）`)
      return
    }
    store.addNotice(
      `自动压缩已保存为${state}` + (target ? '：空闲且上下文水位 ≥85% 时自动压缩历史' : '') + `（${settings.location}）`,
    )
  }

  function applyAutoUpdate(target: boolean): void {
    const changed = settings.autoUpdate !== target
    settings.setAutoUpdate(target)
    const state = target ? '开启' : '关闭'
    if (!changed) {
      store.addNotice(`自动更新已是${state}（${settings.location}）`)
      return
    }
    store.addNotice(
      `自动更新已保存为${state}` + (target ? '：启动约两分钟后后台检查，每 24 小时最多联网一次，更新落盘后重启 fx 生效' : '')
      + `（${settings.location}）`,
    )
  }

  function applyApprovalMode(target: ApprovalMode): void {
    const savedChanged = settings.approvalMode !== target
    settings.setApprovalMode(target)
    const sessionLabel = modeLabel(store.getSnapshot().approvalMode)
    store.setApprovalMode(target)
    if (!savedChanged && sessionLabel === modeLabel(target)) {
      store.addNotice(`启动默认权限模式已是${modeLabel(target)}（${settings.location}）`)
      return
    }
    store.addNotice(
      `启动默认权限模式已保存为${modeLabel(target)}（${settings.location}）`
      + (sessionLabel !== modeLabel(target) ? `，本次会话也已切换为${modeLabel(target)}` : ''),
    )
  }

  // -- Theme ------------------------------------------------------------------

  /** Direct-form lookup: base words plus every Ghostty id and display name
   * (normalized: lowercase, runs of spaces become hyphens). */
  const THEME_WORDS: Record<string, ThemeSetting> = {
    auto: 'auto', light: 'light', dark: 'dark',
    自动: 'auto', 自动检测: 'auto',
    浅色: 'light', 深色: 'dark',
  }
  for (const entry of GHOSTTY_PICKER_ENTRIES) {
    THEME_WORDS[entry.id] = entry.id
    THEME_WORDS[entry.name.toLowerCase().replace(/\s+/g, '-')] = entry.id
  }

  const themeSettingLabel = (setting: ThemeSetting): string =>
    setting === 'auto' ? '自动检测' : themeDisplayLabel(setting)

  /** Persist a theme choice and re-render everything in its palette. */
  function applyTheme(setting: ThemeSetting): void {
    const resolved = resolveTheme(setting, detectedTheme)
    const savedChanged = settings.theme !== setting
    const activeChanged = activeThemeName() !== resolved
    settings.setTheme(setting)
    setActiveTheme(resolved)
    if (!savedChanged && !activeChanged) {
      store.addNotice(`主题已是${themeSettingLabel(setting)}（${settings.location}）`)
      return
    }
    store.addNotice(
      `主题已保存为${themeSettingLabel(setting)}`
      + (setting === 'auto'
        ? detectedTheme !== null ? `：当前终端检测为${themeDisplayLabel(resolved)}背景` : '：未能检测终端背景色，本次按浅色处理'
        : '')
      + `（${settings.location}）`,
    )
    if (!activeChanged) return
    // The submitted command text is consumed, not a draft to carry over: the
    // module-level capture would otherwise restore it into the fresh editor.
    draftCapture.state = null
    void remountForThemeChange()
  }

  /** Ghostty picker: the question card scrolls, so all 14 themes fit in one
   * flat list — the 8-per-page pagination the digit-key era needed is gone. */
  async function pickGhosttyTheme(): Promise<GhosttyThemeId | undefined> {
    const options = GHOSTTY_PICKER_ENTRIES.map(entry => ({
      label: entry.name,
      description: `${entry.dark ? '深色' : '浅色'} · ${entry.summary}`,
    }))
    const chosen = await pick('Ghostty 精选主题（深色 10 · 浅色 4）', options)
    if (chosen === undefined) return undefined
    return GHOSTTY_PICKER_ENTRIES.find(entry => entry.name === chosen)?.id
  }

  /** `/theme`: interactive picker (base themes, or the paged Ghostty
   * selection), or a direct one-shot form (`/theme auto|light|dark`,
   * `/theme <ghostty-id>`, display names and 中文别名 all accepted). */
  async function runTheme(arg: string): Promise<void> {
    const raw = arg.trim()
    if (raw !== '') {
      const key = raw.toLowerCase().replace(/\s+/g, '-')
      const target = THEME_WORDS[key]
      if (target === undefined) {
        store.addPanel('未知主题', [
          `未找到主题「${raw}」。基础主题：auto / light / dark（自动检测 / 浅色 / 深色）`,
          '',
          'Ghostty 精选：',
          ...GHOSTTY_PICKER_ENTRIES.map(entry => `· ${entry.id}（${entry.name} · ${entry.dark ? '深色' : '浅色'}）`),
          '',
          '或直接运行 /theme 用菜单选择。',
        ])
        return
      }
      applyTheme(target)
      return
    }
    for (;;) {
      const current = settings.theme
      const currentTone = resolveTheme(current, detectedTheme)
      const chosen = await pick(
        `配色主题（当前 ${themeSettingLabel(current)}，显示为${themeDisplayLabel(currentTone)}）`,
        [
          { label: '自动检测', description: '启动时探测终端背景色（OSC 11），测不出按浅色' },
          { label: '浅色', description: '内置浅色配色（跟随终端 ANSI 色映射）' },
          { label: '深色', description: '内置深色配色（hex 定色，黑底可读）' },
          { label: 'Ghostty 精选（14 款）', description: '社区最热门主题移植（10 深 + 4 浅）' },
        ],
      )
      if (chosen === undefined) return
      if (chosen === 'Ghostty 精选（14 款）') {
        const id = await pickGhosttyTheme()
        if (id === undefined) continue // back / Esc: return to the base picker
        applyTheme(id)
        return
      }
      const target = THEME_WORDS[chosen]
      if (target !== undefined) applyTheme(target)
      return
    }
  }


  async function exportSession(): Promise<void> {
    const lines: string[] = [
      `# fx-tui 会话导出 · ${agent.id}`,
      '',
      `- 模型：${modelLabel()}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '---',
      '',
    ]
    const pendingNames = new Map<string, string>()
    for (const event of agent.session.events) {
      if (event.type === 'tool/call') {
        try {
          const parsed = JSON.parse(event.data.arguments) as Record<string, unknown>
          const summary = typeof parsed.command === 'string' ? parsed.command
            : typeof parsed.path === 'string' ? parsed.path : ''
          pendingNames.set(event.data.callId, `${event.data.name}${summary !== '' ? `（${summary}）` : ''}`)
        } catch {
          pendingNames.set(event.data.callId, event.data.name)
        }
      } else if (event.type === 'tool/result') {
        const callId = toolResultCallIdOf(event.data.message)
        const name = callId !== undefined ? pendingNames.get(callId) : undefined
        if (callId !== undefined) pendingNames.delete(callId)
        lines.push(`> 🔧 **工具** ${name ?? '(unknown)'}：${toolResultTextOf(event.data.message, undefined).split('\n')[0] ?? ''}`, '')
      } else if (event.type === 'user/message') {
        if (event.data.source.kind === 'user') {
          lines.push(`## 👤 用户`, '', blocksToTextOf(event.data.content), '')
        }
      } else if (event.type === 'assistant/message') {
        const text = blocksToTextOf(event.data.message.content)
        if (text !== '') lines.push(`## 🤖 助手`, '', text, '')
      }
    }
    const file = resolve(process.cwd(), `fx-tui-export-${agent.id.slice(0, 13)}.md`)
    try {
      writeFileSync(file, lines.join('\n'), { encoding: 'utf8' })
      store.addPanel('会话已导出', [file])
    } catch (error) {
      store.addNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  let updating = false

  /** `/update`: self-update the git clone this TUI runs from. All work happens
   * in that directory; the live process keeps its old modules until restart. */
  async function runUpdate(force: boolean): Promise<void> {
    if (updating) {
      store.addNotice('/update 已在执行中，请等当前一次结束', 'warn')
      return
    }
    updating = true
    try {
      const root = installedRoot()
      if (root === null || !existsSync(resolve(root, '.git'))) {
        store.addPanel('fx-tui 无法自更新', [
          `未能定位安装目录或缺少 .git：${root ?? '(unknown)'}`,
          '源码克隆安装才支持 /update；安装步骤见 docs/install.md。',
        ])
        return
      }
      if (root.split('/').includes('node_modules')) {
        store.addPanel('检测到包管理器安装', [
          `安装位置在 node_modules 下：${root}`,
          'npm 分发未启用前没有自动升级通道；发布后可用 npm i -g fx-tui 升级。',
          '',
          '提示：按 docs/install.md 做 git 克隆安装即可用 /update 自动升级。',
        ])
        return
      }
      const outcome = await performSelfUpdate(
        { root, force, currentVersion: FX_TUI_VERSION },
        (step: string) => store.addNotice(step),
      )
      if (outcome.ok && outcome.applied) {
        store.addPanel(
          'fx-tui 升级完成',
          [...outcome.lines, '', '重启生效：空输入时双击 Ctrl+C 退出，重新运行 fx'],
        )
      } else if (outcome.ok) {
        store.addNotice(outcome.lines[0] ?? '已是最新')
      } else {
        store.addPanel('fx-tui 升级未完成', outcome.lines)
      }
    } catch (error) {
      store.addNotice(`/update 异常中断：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      updating = false
    }
  }

  // -- Slash menu: commands + skills ------------------------------------------

  /** User-invocable skills merged into the slash menu under their own section.
   * The catalog is display-optional: a failed fetch keeps the last good list. */
  let skillEntries: readonly MenuEntry[] = []
  /** Lookup options shared by the menu refresh and the /name passthrough. */
  const skillLookup = (): { cwd: string; scope: object } => ({
    cwd: agent.session.header.cwd ?? process.cwd(),
    scope: agent,
  })
  async function refreshSkills(): Promise<void> {
    try {
      const skills = await ctx.skills.list(skillLookup())
      skillEntries = skills
        .filter(skill => skill.invocation.userInvocable)
        .map(skill => ({ name: skill.name, description: skill.description, kind: 'skill' as const }))
    } catch { /* the catalog is display-optional */ }
  }
  void refreshSkills()
  ctx.on('skills/change', () => { void refreshSkills() })

  function listCommands(): readonly MenuEntry[] {
    const dsh: MenuEntry[] = []
    try {
      for (const descriptor of ctx.commands.list(agent)) {
        if (builtinCommands.some(builtin => builtin.name === descriptor.name)) continue
        dsh.push({ name: descriptor.name, description: descriptor.description, kind: 'dsh' })
      }
    } catch { /* the registry is display-optional */ }
    const commands = [...builtinCommands, ...dsh]
    // Commands win same-name collisions, mirroring runCommand's dispatch order.
    const skills = skillEntries.filter(skill => !commands.some(command => command.name === skill.name))
    return [...commands, ...skills]
  }

  async function runCommand(line: string): Promise<void> {
    const trimmed = line.trim()
    const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
    const rest = trimmed.slice(1 + name.length).trim()
    debugLog('command', trimmed)
    try {
      switch (name) {
        case 'help':
          store.addPanel('fx-tui 按键与命令', [
            'Enter 发送消息（agent 运行中＝注入当前轮下一步生效） · Ctrl+J 或 Opt+Enter 换行 · ↑↓ 输入历史/菜单导航',
            'Tab 补全菜单高亮项；agent 运行中无菜单时＝把输入排入下一轮 · Shift+Tab 切换权限模式',
            'Alt+↑ 取回最后一条未处理消息 · Ctrl+V 粘贴剪贴板（文本直接插入，图片自动附加）',
            'Esc 中断轮次/清空/关闭菜单/跳过 · Ctrl+O 工具详情 摘要⇄完整 · Ctrl+R Transcript 模式',
            'Ctrl+C 清空输入（空输入双击退出）',
            '',
            '内置命令：/help 帮助 · /status 运行状态 · /sessions [关键词] 切换会话 · /rename <标题> 重命名 ·',
            '  /model 模型 · /effort 推理强度 · /btw <问题> 侧问 · /context 上下文明细 · /doctor 自检 ·',
            '  /config 设置（权限/更新/通知/自动压缩） · /theme 主题 · /export 导出 · /edit 外部编辑器 ·',
            '  /image <路径…> 附加图片 · /update 升级自身 · /exit 退出',
            'dsh 命令（来自注册表）：/compact 压缩历史 · /goal 长任务目标 · /feedback 反馈（输入 / 查看全部）',
            '技能：/ 菜单技能分组选中插入 /技能名 手势；消息里直接写 /技能名 亦可（命令优先于同名技能）',
            '',
            '输入历史跨会话保存在 $DSH_HOME/fx-tui-input-history.json（上限 500 条）',
          ])
          return
        case 'exit': case 'quit': case 'bye':
          await shutdown()
          return
        case 'status': {
          const plugins: string[] = []
          try {
            ctx.registry.forEach(runtime => {
              if (runtime.name !== undefined) plugins.push(runtime.name)
            })
          } catch { /* registry inspection is display-optional */ }
          const snapshot = store.getSnapshot()
          const themeActiveLabel = themeDisplayLabel(activeThemeName())
          const themeSavedLabel = themeSettingLabel(settings.theme)
          const context = snapshot.contextWindow !== undefined && snapshot.contextWindow > 0
            ? `${snapshot.contextTokens} / ${snapshot.contextWindow} tokens`
            : `${snapshot.contextTokens} tokens`
          const title = await currentSessionTitle()
          const pluginLines = plugins.slice(0, 15).map(name => `· ${name}`)
          if (plugins.length > 15) pluginLines.push(`…（共 ${plugins.length} 个插件）`)
          store.addPanel('运行状态', [
            `fx-tui v${FX_TUI_VERSION} · Node ${process.version} · ${process.platform}/${process.arch}`,
            `模型：${modelLabel()}${snapshot.effortLabel !== '' ? ` · 推理 ${snapshot.effortLabel}` : ''} · 会话：${agent.id}`,
            title !== undefined ? `标题：${title}` : '标题：（未设置，/rename 可命名）',
            `权限模式：当前会话 ${modeLabel(snapshot.approvalMode)}（shift+tab 切换）· 启动默认 ${modeLabel(settings.approvalMode)}（/config 修改）`,
            `主题：${themeSavedLabel === themeActiveLabel ? themeActiveLabel : `${themeSavedLabel}，显示为${themeActiveLabel}`}（/theme 修改）`,
            `通知：${notifyModeLabel(settings.notify)}（/config notify 修改） · 自动压缩：${settings.autoCompact ? '开启' : '关闭'}（/config autocompact 修改）`,
            `上下文：${context} · 工作区：${process.cwd()}`,
            '',
            `已加载插件（${plugins.length}）：`,
            ...pluginLines,
          ])
          return
        }
        case 'sessions':
          await listSessionChoices(rest)
          return
        case 'rename':
          await runRename(rest)
          return
        case 'model':
          await listModelChoices()
          return
        case 'effort':
          await runEffort(rest)
          return
        case 'btw':
          await runBtw(rest)
          return
        case 'context':
          runContext()
          return
        case 'doctor':
          await runDoctor()
          return
        case 'config': case 'setting': case 'settings':
          await runConfig(rest)
          return
        case 'theme':
          await runTheme(rest)
          return
        case 'export':
          await exportSession()
          return
        case 'edit':
          await openExternalEditor()
          return
        case 'image': {
          const tokens = tokenizePathList(rest)
          if (tokens.length === 1 && tokens[0]!.toLowerCase() === 'clear') {
            const cleared = store.clearPendingImages()
            store.addNotice(cleared > 0 ? `已清空 ${cleared} 张待发送图片` : '当前没有待发送的图片')
            return
          }
          if (tokens.length === 0) {
            const snap = store.getSnapshot()
            if (snap.pendingImages.length === 0) {
              store.addNotice('用法：/image <图片路径>（支持 png / jpeg / webp / gif，可写多个路径）', 'warn')
              return
            }
            store.addPanel('已附加的图片（随下一条消息发送）', [
              ...snap.pendingImages.map(image => `· ${image.label}`),
              '',
              '⌫ 输入框为空时撤销最后一张 · ⌥⌫ 清空全部 · /image clear 同效',
            ])
            return
          }
          await attachImagePaths(tokens)
          return
        }
        case 'update': {
          const argTokens = rest.split(/\s+/).filter(token => token !== '')
          if (argTokens.some(token => token !== '--force' && token.toLowerCase() !== 'force')) {
            store.addNotice('用法：/update [--force]（--force 允许带着未提交改动升级）', 'warn')
            return
          }
          await runUpdate(argTokens.length > 0)
          return
        }
        case 'forget': case 'forget-approvals':
          store.addNotice('总是授权记录在 $DSH_HOME/fx-tui-allowlist.json，删除该文件即可清除（本会话记忆随进程结束失效）', 'warn')
          return
        default: {
          const commands = ctx.commands
          if (commands.find(agent, name) !== undefined) {
            const execution = await commands.execute(agent, trimmed, [], new AbortController().signal)
            if (execution === undefined) {
              store.addNotice(`/${name}：命令未执行（语法或名称未解析）`, 'warn')
            } else if (execution.result.kind === 'error') {
              store.addPanel(`/${name} 执行失败`, [execution.result.text])
            } else if (execution.result.text !== undefined && execution.result.text !== '') {
              store.addPanel(`/${name}`, [execution.result.text])
            } else {
              store.addNotice(`/${name} 完成`)
            }
          } else {
            // Unknown to both command registries, the name may still address a
            // user-invocable skill: the upstream agent detects the /name gesture
            // in user messages and injects the skill body itself, so the whole
            // line rides as a plain message instead of erroring out.
            const skill = await ctx.skills.get(name, skillLookup()).catch(() => undefined)
            if (skill !== undefined && skill.invocation.userInvocable) {
              actions.onSubmit(trimmed)
            } else {
              store.addNotice(`未知命令：/${name}（输入 / 查看可用命令与技能）`, 'warn')
            }
          }
          return
        }
      }
    } catch (error) {
      store.addNotice(`命令执行失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /** Attach each path to the next outgoing message; one bad path reports and
   * moves on instead of aborting the rest. Shared by `/image` (whose arguments
   * arrive pre-tokenized) and by terminal file-drops pasted into the input box. */
  async function attachImagePaths(paths: readonly string[]): Promise<void> {
    for (const pathArg of paths) {
      const absolute = expandPath(pathArg)
      const mediaType = imageMediaTypeOf(absolute)
      if (mediaType === undefined) {
        store.addNotice(`不支持的图片格式：${basename(absolute)}（支持 png / jpeg / webp / gif）`, 'error')
        continue
      }
      let data: Uint8Array
      try {
        data = new Uint8Array(readFileSync(absolute))
      } catch (error) {
        store.addNotice(`读取图片失败：${absolute}（${error instanceof Error ? error.message : String(error)}）`, 'error')
        continue
      }
      const name = basename(absolute)
      try {
        const [ref] = await ctx.attachments.saveImages([{ data, mediaType, name }])
        if (ref === undefined) {
          store.addNotice('图片保存失败：未返回引用', 'error')
          continue
        }
        store.addPendingImage(ref, `${name}（${ref.width}×${ref.height}）`)
        store.addNotice(`已附加图片 ${name}（${ref.width}×${ref.height}），将随下一条消息发送`)
      } catch (error) {
        store.addNotice(`图片校验失败：${name}（${error instanceof Error ? error.message : String(error)}）`, 'error')
      }
    }
  }

  /** Open $EDITOR on a scratch file; the edited text seeds the input box after re-mount. */
  async function openExternalEditor(): Promise<void> {
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi'
    const scratch = resolve(tmpdir(), `fx-tui-${randomUUID()}.md`)
    try {
      writeFileSync(scratch, '', { encoding: 'utf8' })
    } catch (error) {
      store.addNotice(`无法创建临时文件：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    instance?.unmount()
    try {
      await instance?.waitUntilExit()
    } catch { /* unmount already settled */ }
    store.discardRenderedItems()
    spawnSync(editor, [scratch], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
    let seed: string | undefined
    try {
      const text = readFileSync(scratch, 'utf8').replace(/\s+$/, '')
      seed = text === '' ? undefined : text
    } catch { /* an unreadable scratch file just seeds nothing */ }
    try {
      unlinkSync(scratch)
    } catch { /* cleanup is best-effort */ }
    bottomFlush()
    instance = render(
      createElement(App, { store, history, actions, listCommands, seed }),
      { exitOnCtrlC: false, incrementalRendering: true },
    )
    store.start()
  }

async function shutdown(): Promise<void> {
  detachResizeRebuild()
  instance?.unmount()
  store.dispose()
  if (agent.status === 'running') {
    agent.cancel({ kind: 'user' })
    await Promise.race([
      agent.whenIdle().catch(() => {}),
      new Promise(resolve => { setTimeout(resolve, 3000) }),
    ])
  }
  try {
    await ctx.get('sessions')?.flush(agent.session)
  } catch {
    // flushing on exit is best-effort
  }
  await exit(0)
}

/**
 * Park the cursor at the viewport's home position so the first Ink frame
 * renders top-down OVER the startup screen and lands with the input box on
 * the terminal's bottom row, like Claude Code. The frame is exactly one row
 * shorter than the viewport (the filler reserves it), so writing it never
 * scrolls: newline padding here would push a full page of blank rows into
 * the scrollback buffer, leaving an empty screenful above the banner when
 * the user scrolls their mouse wheel up. Scrolling up instead reveals the
 * pre-launch shell history (nothing at all in a fresh tab).
 */
function homeCursor(): void {
  const out = process.stdout
  if (out.isTTY === true) {
    out.write('\x1b[H')
  }
}

/**
 * Wipe the visible viewport before the first frame mounts. Re-launching over
 * a previous run's leftovers — dead command menus, input boxes, status bars
 * Ink never erases on unmount — otherwise paints the new frame on top of
 * them: Ink only redraws its own regions and cannot see residue in the main
 * buffer. ESC[2J clears the viewport alone (never ESC[3J) so the scrollback
 * buffer keeps pre-launch shell history and earlier conversations reachable
 * by scrolling up — the same contract homeCursor()'s startup screen assumes.
 */
function wipeViewport(): void {
  const out = process.stdout
  if (out.isTTY === true) {
    out.write('\x1b[2J')
  }
}

/**
 * Drop the entire scrollback buffer (ESC[3J). Resize rebuilds replay the
 * whole transcript as the sole copy of history, which requires the old
 * reflowed rows above the viewport to be gone — any survivor becomes a
 * duplicated seam. Unlike the launch path (which keeps pre-launch shell
 * history), the rebuild sacrifices it for a guaranteed-clean transcript.
 */
function wipeScrollback(): void {
  const out = process.stdout
  if (out.isTTY === true) {
    out.write('\x1b[3J')
  }
}

/**
 * Scroll the current on-screen content into the scrollback buffer before a
 * re-mount (external editor): the visible transcript above the input exists
 * only in the viewport — it has never scrolled — so a plain repaint would
 * erase it from view. Deliberately uses newline padding; the blank rows it
 * adds below are repainted by the next mount.
 */
function bottomFlush(): void {
  const out = process.stdout
  const rows = out.rows
  if (out.isTTY === true && typeof rows === 'number' && rows > 0 && rows < 1000) {
    out.write('\n'.repeat(rows))
  }
}

  const actions = {
    /** Submit routes by busy state: idle opens a new turn (follow-up); busy
     * steers the running turn (next step boundary); an explicit queue option
     * (Tab) always books its own next turn. */
    onSubmit(text: string, opts?: { queue?: boolean }): void {
      debugLog('submit', text)
      const images = store.consumePendingImages()
      const content: ContentBlock[] = []
      if (text !== '') content.push({ type: 'text', text })
      for (const image of images) content.push({ type: 'image', attachment: image.ref })
      if (content.length === 0) return
      inputHistory.push(text)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      const busy = store.getSnapshot().phase !== 'idle'
      const steer = busy && opts?.queue !== true
      store.echoUser(
        message.id,
        text,
        images.map(image => image.label),
        steer ? 'steer' : 'queue',
      )
      if (steer) agent.steer(message)
      else agent.followup(message)
    },
    runCommand(line: string): void {
      void runCommand(line)
    },
    /** Terminal drop: the input box extracted existing image paths from a
     * pasted drop chunk; attach them like /image would. */
    onDroppedFiles(paths: readonly string[]): void {
      debugLog('dropped-files', paths)
      void attachImagePaths(paths)
    },
    /** Clipboard image (Ctrl+V): the attachment channel is the same as /image. */
    onClipboardImage(data: Uint8Array, name: string): void {
      debugLog('clipboard-image', name)
      void (async () => {
        try {
          const [ref] = await ctx.attachments.saveImages([{ data, mediaType: 'image/png', name }])
          if (ref === undefined) {
            store.addNotice('剪贴板图片保存失败：未返回引用', 'error')
            return
          }
          store.addPendingImage(ref, `${name}（${ref.width}×${ref.height}，剪贴板）`)
          store.addNotice(`已附加剪贴板图片（${ref.width}×${ref.height}），将随下一条消息发送`)
        } catch (error) {
          store.addNotice(`剪贴板图片校验失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      })()
    },
    /** Alt+Up: pull the newest unclaimed message back into the editor. The
     * inbox removal is durably logged; a message the driver already claimed
     * stays on its way into the transcript. */
    onRecallPending(): string | null {
      const pending = store.getSnapshot().queuedMessages
      const newest = pending[pending.length - 1]
      if (newest === undefined) return null
      let stillPending = true
      try {
        stillPending = agent.inbox.remove(MessageId(newest.id))
      } catch {
        // An identity the inbox never held (already claimed and promoted):
        // fall through and let the store drop its stale indicator below.
        stillPending = false
      }
      if (!stillPending) {
        // The driver claimed it between the indicator render and this recall;
        // drop the stale indicator — its user/message event renders the text.
        store.removeQueued(newest.id)
        return null
      }
      const removed = store.removeQueued(newest.id)
      if (removed === undefined) return null
      if (removed.images.length > 0) store.addNotice('已取回消息（随原消息附加的图片不会取回，需重新附加）')
      else store.addNotice('已取回最后一条未处理消息到输入框')
      return removed.text
    },
    onInterrupt(): void {
      store.setInterrupting()
      agent.cancel({ kind: 'user' })
    },
    onExit(): void {
      debugLog('exit')
      void shutdown()
    },
  }

  // Theme resolution needs the terminal's background tone: an explicit
  // setting wins; otherwise the OSC 11 detection decides. Detection borrows
  // stdin in raw mode for a bounded window BEFORE ink takes the terminal over
  // (same ownership window the wipe/home writes run in).
  detectedTheme = await detectTerminalBackground()
  setActiveTheme(resolveTheme(settings.theme, detectedTheme))
  debugLog('theme', { setting: settings.theme, detected: detectedTheme, resolved: activeThemeName() })

  wipeViewport()
  homeCursor()
  instance = render(
    createElement(App, { store, history, actions, listCommands }),
    { exitOnCtrlC: false, incrementalRendering: true },
  )

  store.start()

  // -- Terminal resize rebuild -------------------------------------------------
  //
  // Ink commits settled transcript rows once through <Static> and never
  // revisits them; when the terminal reflows on resize, every on-screen line
  // moves while Ink's row accounting for its own frame stays where it was, so
  // redraws erase and repaint at stale offsets — and nothing repairs itself
  // when the window is restored, because the reflowed rows are already the
  // buffer's truth. The only reliable recovery is to unmount, reset the
  // terminal, and mount a fresh tree at the new size.
  //
  // Replay scope: EVERYTHING, with ESC[3J clearing the scrollback first.
  // Any scheme that replays only a tail against the surviving scrollback
  // needs a seam between the old reflowed copy and the fresh render — and no
  // estimator is exact enough to align them row-for-row: replay short of the
  // seam duplicates the head, overshooting it duplicates middle rows (the
  // user saw the same message three times). Wiping the scrollback removes the
  // old copy entirely, so the fresh render is the ONLY copy: rows beyond the
  // viewport scroll into an empty scrollback as its seamless continuation.
  // The price is pre-launch shell history above the transcript, which resize
  // gives up in exchange for a guaranteed-clean transcript.
  // The in-progress draft survives via draftCapture, handed to the new mount
  // as `restore`. Debounced because dragging a window fires resize events in
  // a burst; only the final size matters.
  let mountedCols = process.stdout.columns
  let mountedRows = process.stdout.rows
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let rebuilding = false
  let rebuildQueued = false

  const scheduleRebuild = (): void => {
    if (rebuildTimer !== null) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      void remountAtCurrentSize()
    }, RESIZE_DEBOUNCE_MS)
  }

  /** Shared remount body: unmount, reset the terminal, and replay the whole
   * transcript as the sole copy. `force` skips the size-unchanged guard —
   * theme switches remount at the same size to recolor the full transcript. */
  const performRemount = async (options: { force?: boolean } = {}): Promise<void> => {
    const out = process.stdout
    if (options.force !== true && out.columns === mountedCols && out.rows === mountedRows) return
    rebuilding = true
    try {
      instance?.unmount()
      try {
        await instance?.waitUntilExit()
      } catch { /* unmount already settled */ }
      wipeViewport()
      wipeScrollback()
      homeCursor()
      mountedCols = out.columns
      mountedRows = out.rows
      // The restored draft rides through draftCapture; App derives its own
      // first-frame input height from it (same commit as the filler budget).
      const restore = draftCapture.state ?? undefined
      instance = render(
        createElement(App, {
          store,
          history,
          actions,
          listCommands,
          restore,
          rebuilding: true,
        }),
        { exitOnCtrlC: false, incrementalRendering: true },
      )
      store.start()
    } finally {
      rebuilding = false
      if (rebuildQueued) {
        rebuildQueued = false
        scheduleRebuild()
      }
    }
  }

  const remountAtCurrentSize = async (): Promise<void> => {
    if (rebuilding) {
      rebuildQueued = true
      return
    }
    await performRemount()
  }

  /** Full replay in the new palette after a theme switch. When a resize
   * rebuild is already in flight, skip: its replay picks up the new palette
   * anyway. */
  const remountForThemeChange = async (): Promise<void> => {
    if (rebuilding) return
    await performRemount({ force: true })
  }

  const detachResizeRebuild = (): void => {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    process.stdout.off('resize', scheduleRebuild)
  }

  if (process.stdout.isTTY === true) {
    process.stdout.on('resize', scheduleRebuild)
  }

  // Background self-update, deep enough into the session that startup imports
  // have settled; .unref() keeps the pending timer from delaying process exit.
  setTimeout(() => {
    void maybeAutoUpdate(
      {
        dshHome: process.env.DSH_HOME,
        isAutoEnabled: () => settings.autoUpdate,
        isBusy: () => updating,
        setBusy: () => { updating = true },
        releaseBusy: () => { updating = false },
        notify: text => store.addNotice(text),
      },
      { currentVersion: FX_TUI_VERSION },
    ).catch(() => { /* background pass is strictly best-effort */ })
  }, AUTO_UPDATE_DELAY_MS).unref()

  ctx.effect(() => () => {
    detachResizeRebuild()
    store.dispose()
    instance?.unmount()
  })
}

/** Bridge the tools registry's presentation layer into the store. */
function createPresenter(ctx: Context): ToolPresenter {
  return {
    presentCall(name: string, rawArgs: string) {
      const definition = ctx.get('tools')?.get(name)
      if (definition?.presentCall === undefined) return undefined
      try {
        return definition.presentCall(parseArgs(rawArgs))
      } catch {
        return undefined
      }
    },
    presentResult(name: string, rawArgs: string, result: {
      content: readonly ContentBlock[]
      isError: boolean
      meta: unknown
    }) {
      const definition = ctx.get('tools')?.get(name)
      if (definition?.presentResult === undefined) return undefined
      try {
        const toolResult: ToolResult = {
          content: [...result.content],
          isError: result.isError,
          ...(result.meta === undefined ? {} : { meta: result.meta as ToolResult['meta'] }),
        }
        return definition.presentResult(parseArgs(rawArgs), toolResult)
      } catch {
        return undefined
      }
    },
  }
}

function parseArgs(rawArgs: string): unknown {
  if (rawArgs === '') return {}
  return JSON.parse(rawArgs)
}
