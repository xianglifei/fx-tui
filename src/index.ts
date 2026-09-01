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
import { FxSettings } from './settings.js'
import { TuiStore } from './store.js'
import type { ToolPresenter } from './store.js'
import { formatToolArgs } from './store.js'
import { detectTerminalBackground } from './terminal-bg.js'
import { InputHistory } from './history.js'
import { NOTIFY_MIN_TURN_MS, notifyTurnComplete } from './notify.js'
import { App } from './ui/App.js'
import { draftCapture } from './ui/Input.js'
import { activeThemeName, resolveTheme, setActiveTheme } from './ui/theme.js'
import type { ThemeName } from './ui/theme.js'
import { attachImagePaths } from './commands/image.js'
import { createSkillCatalog } from './commands/menu.js'
import { createCommandRunner } from './commands/index.js'
import type { CommandCtx } from './commands/types.js'
import type { ToolResult } from '@deepseek-ai/dsh-tools'

export const FX_TUI_VERSION = '0.21.0'

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

  // -- Command layer -----------------------------------------------------------
  // Handlers live in src/commands/*: this wiring injects the runner-owned
  // state they are not allowed to reach for themselves (the live agent
  // binding, settings, the lifecycle callbacks, the update busy flag).

  let updating = false

  const commandCtx: CommandCtx = {
    ctx,
    store,
    agent: () => agent,
    settings,
    selectionRef,
    selection,
    modelLabel,
    historyEntries: history,
    fxVersion: FX_TUI_VERSION,
    detectedTheme: () => detectedTheme,
    dshVersion: readDshVersion,
    debugLog,
    submitMessage: text => actions.onSubmit(text),
    switchSession,
    openExternalEditor,
    exit: shutdown,
    remountForThemeChange: () => remountForThemeChange(),
    updating: () => updating,
    setUpdating: value => { updating = value },
    saveDefaultSelection: sel => defaultModelService.saveSelection(sel).catch(() => { /* persisting the default is best-effort */ }),
  }
  const catalog = createSkillCatalog(commandCtx)
  void catalog.refresh()
  ctx.on('skills/change', () => { void catalog.refresh() })
  const runCommand = createCommandRunner(commandCtx, catalog)

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
      void catalog.refresh()
      childAgents.clear()
      syncChildCount()
      autoCompactTried = false
      store.reset(agent.id, modelLabel(), agent.session.events)
      store.addNotice(`已切换到会话 ${agent.id}`)
    } catch (error) {
      store.addNotice(`切换会话失败：${error instanceof Error ? error.message : String(error)}`, 'error')
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
      createElement(App, { store, history, actions, listCommands: catalog.list, seed }),
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
      void attachImagePaths(commandCtx, paths)
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
    createElement(App, { store, history, actions, listCommands: catalog.list }),
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
          listCommands: catalog.list,
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
