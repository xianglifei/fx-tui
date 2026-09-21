/**
 * Terminal UI state: the session-event-to-view reducer and the external store
 * React subscribes to.
 *
 * Completed transcript entries are append-only and rendered once through
 * Ink's Static region; streaming text and pending tool calls stay in the
 * dynamic region until they settle. Chunk events are batched on a flush
 * interval so high-frequency token streams do not thrash React renders.
 *
 * Tool cards prefer the tools' own presentation views (presentCall /
 * presentResult) when a presenter bridge is installed; they degrade to raw
 * name/args/text otherwise.
 */

import { randomUUID } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Declaration-merge carrier: importing these types registers the `llm/retry`
// and `llm/retry-started` session events this reducer consumes.
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { ApprovalBridge } from './approval-bridge.js'
import type { ApprovalChoice, ApprovalPrompt, BridgeHooks } from './approval-bridge.js'
import { QuestionBridge } from './question-bridge.js'
import type { ActiveQuestion } from './question-bridge.js'
import { DEFAULT_STATUS_LINE } from './statusline.js'
import type { StatusLineItemId } from './statusline.js'
import { formatCount, formatElapsed, truncateLine } from './text.js'

// -- Transcript items ---------------------------------------------------------

export interface UserItem { readonly kind: 'user'; readonly text: string; readonly images?: readonly string[]; readonly outputs?: readonly string[] }
export interface AssistantItem { readonly kind: 'assistant'; readonly text: string; readonly interrupted: boolean }

export interface ToolItem {
  readonly kind: 'tool'
  readonly name: string
  readonly title: string
  readonly args: string
  readonly ok: boolean
  readonly result: string
  readonly elapsedMs: number
  readonly exitCode?: number
  readonly signal?: string
  readonly view?: ToolResultView
  readonly verbose: boolean
}

export interface NoticeItem { readonly kind: 'notice'; readonly text: string; readonly tone: 'info' | 'error' | 'warn' }
export interface PanelItem { readonly kind: 'panel'; readonly title: string; readonly lines: readonly string[] }

/**
 * Settled reasoning of one step, inline-expanded（Ctrl+T 展开态）: header +
 * body capped at THINKING_INLINE_LINE_CAP lines. `chars` is the step's full
 * reasoning length; `truncated` marks a body that shows only part of it.
 */
export interface ThinkingItem {
  readonly kind: 'thinking'
  readonly text: string
  readonly chars: number
  readonly durationMs: number
  readonly truncated: boolean
}

/** Splash box shown once at the top of a fresh transcript (startup facts). */
export interface BannerItem {
  readonly kind: 'banner'
  readonly fxVersion: string
  readonly dshVersion: string
  readonly model: string
  readonly sessionId: string
  readonly cwd: string
  readonly resumed: boolean
}
export type FinalItem = UserItem | AssistantItem | ToolItem | NoticeItem | PanelItem | BannerItem | ThinkingItem

export interface PendingTool {
  readonly callId: string
  readonly name: string
  readonly title: string
  readonly args: string
  readonly startedAt: number
}

// Approval and question waterfalls live in their own bridge modules; the
// types stay re-exported here — the snapshot and the views consume them.
export type { ApprovalChoice, ApprovalPrompt } from './approval-bridge.js'
export type { ActiveQuestion } from './question-bridge.js'
export { QUESTION_WINDOW } from './question-bridge.js'

export interface PendingImage {
  readonly ref: ImageAttachmentRef
  readonly label: string
}

/**
 * A `!`-run's output stashed for the next submitted message: dsh has no
 * inject-without-turn seam, so manual-run output rides the user's next
 * message as an extra text block — visible to the model without triggering
 * a reply on its own. `text` is the capped transport block; `summary` is
 * the one-line tray/echo label.
 */
export interface PendingOutput {
  readonly id: string
  readonly command: string
  readonly text: string
  readonly summary: string
}

/**
 * A message submitted while the agent was busy. 'queue' rides as its own next
 * turn (Tab / follow-up); 'steer' enters at the next step boundary (Enter
 * while busy). Both promote into the transcript when their session event lands.
 */
export interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly images: readonly string[]
  readonly outputs: readonly string[]
  readonly mode: 'queue' | 'steer'
}

export type Phase = 'idle' | 'thinking' | 'streaming' | 'tool'

/**
 * A live LLM request retry wait, surfaced from dsh-llm-retry's durable
 * `llm/retry` event: without it a backoff window is indistinguishable from a
 * hang. `maxRetries`/`delayMs` are null under the unbounded policy / before
 * the wait is scheduled.
 */
export interface RetryWait {
  readonly attempt: number
  readonly maxRetries: number | null
  readonly delayMs: number | null
  /** Provider-neutral machine failure code (rate-limit, timeout, …). */
  readonly reason: string
}

/**
 * Tool-approval stance, cycled with Shift+Tab:
 * 'ask' prompts for every approval request (allowlist memory still applies),
 * 'auto' allows every request without prompting.
 */
export type ApprovalMode = 'ask' | 'auto'

export interface Snapshot {
  readonly version: number
  readonly items: readonly FinalItem[]
  readonly pendingTools: readonly PendingTool[]
  readonly pendingImages: readonly PendingImage[]
  readonly pendingOutputs: readonly PendingOutput[]
  readonly queuedMessages: readonly QueuedMessage[]
  readonly todos: readonly TodoItem[]
  readonly childAgents: number
  readonly verboseTranscript: boolean
  readonly streaming: string
  readonly phase: Phase
  readonly phaseDetail: string
  readonly usage: string
  readonly reasoningChars: number
  /** Live reasoning buffer（思考全文，封顶截断）+ measured duration, for the
   * expanded live tail（Ctrl+T）. */
  readonly reasoningText: string
  readonly reasoningDurationMs: number
  readonly thinkingExpanded: boolean
  readonly approval: ApprovalPrompt | null
  readonly question: ActiveQuestion | null
  readonly questionFreeText: boolean
  readonly contextTokens: number
  readonly contextWindow?: number
  readonly effortLabel: string
  readonly lastUsage: TokenUsage | null
  readonly verboseToolDetail: boolean
  readonly exitArmed: boolean
  readonly sessionId: string
  readonly model: string
  readonly approvalMode: ApprovalMode
  readonly retryWait: RetryWait | null
  readonly statusLineItems: readonly StatusLineItemId[]
  readonly gitBranch: string
  readonly customStatus: string | null
  readonly compacting: boolean
}

/** Bridge to the tools registry's presentation layer; optional. */
export interface ToolPresenter {
  presentCall(name: string, rawArgs: string): ToolCallView | undefined
  presentResult(name: string, rawArgs: string, result: {
    content: readonly ContentBlock[]
    isError: boolean
    meta: unknown
  }): ToolResultView | undefined
}

const FLUSH_INTERVAL_MS = 60
const EXIT_ARM_MS = 2500
const RESULT_PREVIEW_LIMIT = 800
/** Hard cap of the retained reasoning text（head-anchored）: bounds memory
 * and the Ctrl+T panel; the char count keeps counting past it. */
const REASONING_TEXT_CAP = 100_000
/** Inline body lines of a settled, expanded thinking block. */
const THINKING_INLINE_LINE_CAP = 40

export class TuiStore {
  private items: FinalItem[] = []
  private pendingTools = new Map<string, PendingTool>()
  private pendingImages: PendingImage[] = []
  private pendingOutputs: PendingOutput[] = []
  /** Stash order across both trays, so ⌫ retracts whichever landed last. */
  private stashOrder: Array<{ kind: 'image'; ref: ImageAttachmentRef } | { kind: 'output'; id: string }> = []
  private queuedMessages: QueuedMessage[] = []
  private todos: TodoItem[] = []
  private childAgentCount = 0
  private verboseTranscript = false
  private streamBuf = ''
  private streamText = ''
  private phase: Phase = 'idle'
  private phaseDetail = ''
  private usage = ''
  private reasoningChars = 0
  private reasoningText = ''
  private reasoningDirty = false
  private thinkingExpanded = false
  /** Full（capped）text of the most recent settled reasoning, for the idle
   * Ctrl+T detail panel; null before the first settled step of the session. */
  private lastReasoning: { text: string; chars: number; durationMs: number } | null = null
  private reasoningStartMs: number | null = null
  private reasoningLastMs: number | null = null
  private readonly approvals: ApprovalBridge
  private readonly questions: QuestionBridge
  private contextTokens = 0
  private contextWindow: number | undefined
  private pressureWarnedLevel = 0
  private effortLabel = ''
  private lastUsage: TokenUsage | null = null
  private streamStartMs: number | null = null
  private verboseToolDetail = false
  private turnToolCalls = 0
  private exitArmed = false
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  private echoedId: string | null = null
  private replaying = false
  private approvalMode: ApprovalMode = 'ask'
  private retryWait: RetryWait | null = null
  private statusLineItems: readonly StatusLineItemId[] = [...DEFAULT_STATUS_LINE]
  private gitBranch = ''
  private customStatus: string | null = null
  private compacting = false
  private lastBanner: Omit<BannerItem, 'kind'> | null = null
  private snapshot!: Snapshot
  private readonly listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    sessionId: string,
    model: string,
    private readonly presenter?: ToolPresenter,
    initialApprovalMode: ApprovalMode = 'ask',
  ) {
    this.sessionId = sessionId
    this.model = model
    this.approvalMode = initialApprovalMode
    const hooks: BridgeHooks = {
      commit: () => this.commit(),
      addNotice: (text, tone) => this.addNotice(text, tone),
    }
    this.approvals = new ApprovalBridge(hooks)
    this.questions = new QuestionBridge(hooks)
    this.rebuild()
  }

  private sessionId: string
  private model: string

  // -- React external-store plumbing -------------------------------------

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  readonly getSnapshot = (): Snapshot => this.snapshot

  private rebuild(): void {
    const question = this.questions.current
    this.snapshot = {
      version: this.snapshot?.version !== undefined ? this.snapshot.version + 1 : 1,
      items: [...this.items],
      pendingTools: [...this.pendingTools.values()],
      pendingImages: [...this.pendingImages],
      pendingOutputs: [...this.pendingOutputs],
      queuedMessages: [...this.queuedMessages],
      todos: [...this.todos],
      childAgents: this.childAgentCount,
      verboseTranscript: this.verboseTranscript,
      streaming: this.streamText,
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      usage: this.usage,
      reasoningChars: this.reasoningChars,
      reasoningText: this.reasoningText,
      reasoningDurationMs: this.reasoningLastMs !== null && this.reasoningStartMs !== null
        ? Math.max(0, this.reasoningLastMs - this.reasoningStartMs)
        : 0,
      thinkingExpanded: this.thinkingExpanded,
      approval: this.approvals.current,
      question,
      questionFreeText: question !== null && (question.item.options ?? []).length === 0,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      effortLabel: this.effortLabel,
      lastUsage: this.lastUsage,
      verboseToolDetail: this.verboseToolDetail,
      exitArmed: this.exitArmed,
      sessionId: this.sessionId,
      model: this.model,
      approvalMode: this.approvalMode,
      retryWait: this.retryWait,
      statusLineItems: this.statusLineItems,
      gitBranch: this.gitBranch,
      customStatus: this.customStatus,
      compacting: this.compacting,
    }
  }

  private commit(): void {
    this.rebuild()
    for (const fn of this.listeners) fn()
  }

  start(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => this.flushStream(), FLUSH_INTERVAL_MS)
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) clearInterval(this.flushTimer)
    if (this.exitTimer !== null) clearTimeout(this.exitTimer)
    this.flushTimer = null
    this.exitTimer = null
    // Fail-closed: a waterfall still pending at teardown must not dangle.
    this.approvals.cancelQuiet()
    this.questions.cancelQuiet()
  }

  private flushStream(): void {
    // Reasoning deltas set reasoningDirty: without this branch a pure-thinking
    // phase (no text in streamBuf) would never commit, and the live tail and
    // the status bar's char count would freeze until the step settles.
    if (this.streamBuf === '' && !this.reasoningDirty) return
    if (this.streamBuf !== '') {
      this.streamText += this.streamBuf
      this.streamBuf = ''
    }
    this.reasoningDirty = false
    this.commit()
  }

  // -- Session event reducer ----------------------------------------------

  /** Fold one live session event into the view state. */
  onEvent(ev: SessionEvent): void {
    switch (ev.type) {
      case 'turn/start': {
        this.phase = 'thinking'
        this.phaseDetail = ''
        this.retryWait = null
        this.resetReasoning()
        this.turnToolCalls = 0
        break
      }
      case 'step/start': {
        this.phase = 'thinking'
        break
      }
      case 'user/message': {
        const message = ev.data
        if (message.source.kind !== 'user') {
          if (this.verboseTranscript && !this.replaying) {
            this.items.push({
              kind: 'notice',
              tone: 'info',
              text: `注入上下文（${message.source.kind}）：${truncate(blocksToText(message.content), 80)}`,
            })
          }
          break
        }
        const isEcho = this.echoedId !== null && message.id === this.echoedId
        if (isEcho) this.echoedId = null
        // A queued echo's matching session event promotes it to the transcript.
        const queuedIndex = this.queuedMessages.findIndex(q => q.id === message.id)
        if (queuedIndex >= 0) {
          const queued = this.queuedMessages[queuedIndex]!
          this.queuedMessages.splice(queuedIndex, 1)
          this.items.push({
            kind: 'user',
            text: queued.text,
            ...(queued.images.length > 0 ? { images: queued.images } : {}),
            ...(queued.outputs.length > 0 ? { outputs: queued.outputs } : {}),
          })
          break
        }
        if (isEcho) break // idle-time echo already rendered
        this.items.push({ kind: 'user', text: blocksToText(message.content) })
        break
      }
      case 'assistant/message': {
        this.streamBuf = ''
        this.streamText = ''
        const text = blocksToText(ev.data.message.content)
        // A settled record of this step's reasoning. Live deltas carry the
        // measured duration; a replayed message contributes only its
        // reasoning blocks (sessions persisted before this feature simply
        // have none, and settle nothing — same as before).
        const thinking = this.settledThinking(blocksToReasoningText(ev.data.message.content))
        if (thinking !== null) this.items.push(thinking)
        // Tool-only rounds carry no text: the message that holds the tool_use
        // blocks would otherwise become a blank transcript item rendering two
        // empty rows between consecutive tool cards. Keep interrupted pushes —
        // they carry the visible truncation notice.
        if (text.trim() !== '' || ev.data.interrupted === true) {
          this.items.push({
            kind: 'assistant',
            text,
            interrupted: ev.data.interrupted === true,
          })
        }
        if (ev.data.usage !== undefined) {
          this.lastUsage = { ...ev.data.usage }
          const durationMs = this.streamStartMs !== null ? Math.max(0, ev.time - this.streamStartMs) : null
          this.usage = formatUsage(ev.data.usage, durationMs)
        }
        this.streamStartMs = null
        this.resetReasoning()
        this.phase = 'thinking'
        this.phaseDetail = ''
        break
      }
      case 'tool/call': {
        this.finalizeStream(false)
        const view = this.presenter?.presentCall(ev.data.name, ev.data.arguments)
        this.pendingTools.set(ev.data.callId, {
          callId: ev.data.callId,
          name: ev.data.name,
          title: callViewTitle(view) ?? ev.data.name,
          args: ev.data.arguments,
          startedAt: ev.time,
        })
        this.phase = 'tool'
        this.phaseDetail = callViewTitle(view) ?? ev.data.name
        break
      }
      case 'tool/result': {
        const data = ev.data
        const callId = toolResultCallId(data.message)
        const pending = callId !== undefined ? this.pendingTools.get(callId) : undefined
        if (callId !== undefined) this.pendingTools.delete(callId)
        const view = pending !== undefined && this.presenter !== undefined
          ? this.presenter.presentResult(pending.name, pending.args, {
              content: resultBlocks(data.message),
              isError: data.error !== undefined,
              meta: data.meta,
            })
          : undefined
        const exit = view?.card === 'terminal' ? view : undefined
        this.turnToolCalls += 1
        this.items.push({
          kind: 'tool',
          name: pending?.name ?? '(unknown tool)',
          title: view?.title ?? pending?.title ?? (pending?.name ?? '(unknown tool)'),
          args: pending?.args ?? '',
          ok: data.error === undefined,
          result: toolResultText(data.message, data.error),
          elapsedMs: pending !== undefined ? Math.max(0, ev.time - pending.startedAt) : 0,
          exitCode: exit?.exitCode,
          signal: exit?.signal,
          view,
          verbose: this.verboseToolDetail,
        })
        this.phase = 'thinking'
        this.phaseDetail = ''
        break
      }
      case 'request/context': {
        if (ev.data.contextWindow !== undefined) this.contextWindow = ev.data.contextWindow
        break
      }
      case 'request/header': {
        // The effort actually carried by requests; absent means the model
        // runs its provider default.
        const effort = ev.data.header.config.reasoningEffort
        this.effortLabel = effort !== undefined && effort !== '' ? effort : ''
        break
      }
      case 'todo/write': {
        this.todos = [...ev.data.todos]
        break
      }
      case 'llm/retry': {
        // Live only: historic retries are /trace material, not transcript rows
        // (a resumed session would otherwise lead with stale failure lines).
        if (this.replaying) break
        const data = ev.data
        this.retryWait = {
          attempt: data.retry,
          maxRetries: data.mode === 'normal' ? data.maxRetries : null,
          delayMs: data.delayMs,
          reason: data.failure.code,
        }
        const max = data.mode === 'normal' ? `/${data.maxRetries}` : ''
        const delay = data.delayMs !== undefined ? `${Math.max(1, Math.round(data.delayMs / 1000))}s 后` : '等待退避'
        this.items.push({
          kind: 'notice',
          tone: 'warn',
          text: truncateLine(`⟳ 请求失败，第 ${data.retry}${max} 次重试（${delay}）：${data.failure.code} ${data.failure.message}`, 160),
        })
        break
      }
      case 'llm/retry-started': {
        // The backoff wait completed; the next attempt is in flight. Whether
        // it succeeded shows in what arrives next, not here.
        this.retryWait = null
        break
      }
      case 'turn/end': {
        this.finalizeStream(ev.data.reason.kind === 'aborted')
        // An abort mid-reasoning never reaches assistant/message; keep the
        // partial text for the Ctrl+T panel (no transcript item — nothing
        // settled to show inline).
        this.stashReasoning()
        this.phase = 'idle'
        this.phaseDetail = ''
        this.retryWait = null
        this.resetReasoning()
        this.streamStartMs = null
        // A dim one-line closure marker for tool-heavy turns; single-tool
        // turns stay quiet.
        if (!this.replaying && this.turnToolCalls >= 2) {
          this.items.push({ kind: 'notice', tone: 'info', text: `本轮共 ${this.turnToolCalls} 次工具调用` })
        }
        this.turnToolCalls = 0
        if (ev.data.reason.kind === 'aborted' && this.queuedMessages.length > 0) {
          // A user cancel clears queued inbox work; reflect the drop.
          this.items.push({
            kind: 'notice',
            tone: 'warn',
            text: `已丢弃排队中的 ${this.queuedMessages.length} 条消息（轮次被中断）`,
          })
          this.queuedMessages = []
        }
        const reason = ev.data.reason
        if (reason.kind === 'error') {
          this.items.push({ kind: 'notice', tone: 'error', text: `错误：${reason.error.message}` })
        } else if (!this.replaying) {
          if (reason.kind === 'aborted') this.items.push({ kind: 'notice', tone: 'warn', text: '已中断' })
          else if (reason.kind === 'blocked') this.items.push({ kind: 'notice', tone: 'warn', text: '轮次被阻塞（blocked）' })
          else if (reason.kind === 'max-tokens') this.items.push({ kind: 'notice', tone: 'warn', text: '已达到输出 token 上限' })
        }
        break
      }
      default:
        break
    }
    // Replay folds thousands of events with no listener attached (or worse,
    // with React attached during a session switch): skip the O(N²) snapshot
    // rebuilds and let finishReplay commit exactly once at the end.
    if (!this.replaying) this.commit()
  }

  /** Fold one live assistant-stream chunk frame (`agent/assistant-stream`)
   * into the view state — the process-local replacement for the retired
   * `assistant/chunk` session event. Chunk frames stay batched on the flush
   * interval, so like the old chunk case this path never commits. */
  onAssistantStreamFrame(frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      // First visible delta opens the TPS measurement window; the paired
      // assistant/message closes it against its usage report.
      if (this.streamStartMs === null) this.streamStartMs = frame.time
      this.streamBuf += chunk.text
      this.phase = 'streaming'
    } else if (chunk.type === 'reasoning-delta') {
      if (this.reasoningStartMs === null) this.reasoningStartMs = frame.time
      this.reasoningLastMs = frame.time
      this.reasoningChars += chunk.text.length
      // Full text for the live tail and the Ctrl+T panel, head-anchored at
      // the cap; the char count keeps counting past it.
      if (this.reasoningText.length < REASONING_TEXT_CAP) {
        this.reasoningText = `${this.reasoningText}${chunk.text}`.slice(0, REASONING_TEXT_CAP)
      }
      this.reasoningDirty = true
    }
  }

  /** Fold the whole persisted log of a resumed session (no streaming). */
  replay(events: readonly SessionEvent[]): void {
    this.replaying = true
    try {
      for (const ev of events) this.onEvent(ev)
    } finally {
      this.replaying = false
    }
  }

  /** Convert leftover pending tools (interrupted history) into final cards. */
  finishReplay(): void {
    for (const tool of this.pendingTools.values()) {
      this.items.push({
        kind: 'tool', name: tool.name, title: tool.title, args: tool.args,
        ok: true, result: '(结果未记录)', elapsedMs: 0, verbose: this.verboseToolDetail,
      })
    }
    this.pendingTools.clear()
    this.retryWait = null
    this.phase = 'idle'
    this.phaseDetail = ''
    this.commit()
  }

  private finalizeStream(interrupted: boolean): void {
    if (this.streamBuf !== '') {
      this.streamText += this.streamBuf
      this.streamBuf = ''
    }
    if (this.streamText !== '') {
      this.items.push({ kind: 'assistant', text: this.streamText, interrupted })
      this.streamText = ''
    }
  }

  private resetReasoning(): void {
    this.reasoningChars = 0
    this.reasoningText = ''
    this.reasoningStartMs = null
    this.reasoningLastMs = null
  }

  /** Remember the in-flight reasoning as the panel target（Ctrl+T）; a no-op
   * when the step reasoned nothing. */
  private stashReasoning(): void {
    if (this.reasoningChars <= 0 || this.reasoningText === '') return
    this.lastReasoning = {
      text: this.reasoningText,
      chars: this.reasoningChars,
      durationMs: this.reasoningStartMs !== null && this.reasoningLastMs !== null
        ? Math.max(0, this.reasoningLastMs - this.reasoningStartMs)
        : 0,
    }
  }

  /** Settled transcript record of the step's reasoning: the one-line summary
   * notice in collapsed mode, the inline body block in expanded mode
   * （Ctrl+T）. Stashes the full text for the idle detail panel either way.
   * `replayText` backs the record when no live deltas were seen (resumed
   * sessions); it carries no duration. */
  private settledThinking(replayText: string): FinalItem | null {
    this.stashReasoning()
    const chars = this.reasoningChars > 0 ? this.reasoningChars : replayText.length
    if (chars <= 0) return null
    const text = this.reasoningChars > 0 ? this.reasoningText : replayText
    const durationMs = this.reasoningStartMs !== null && this.reasoningLastMs !== null
      ? Math.max(0, this.reasoningLastMs - this.reasoningStartMs)
      : 0
    if (!this.thinkingExpanded) {
      const firstLine = text.split('\n').map(line => line.trim()).find(line => line !== '')
      const summary = firstLine !== undefined ? truncateLine(firstLine, 60) : `${chars} 字`
      return { kind: 'notice', tone: 'info', text: `✻ 思考：${summary} · ${formatElapsed(durationMs)}` }
    }
    const lines = text.trimStart().split('\n')
    const shown = lines.slice(0, THINKING_INLINE_LINE_CAP)
    return {
      kind: 'thinking',
      text: shown.join('\n').trim() === '' ? '' : shown.join('\n'),
      chars,
      durationMs,
      truncated: lines.length > THINKING_INLINE_LINE_CAP || text.length >= REASONING_TEXT_CAP,
    }
  }

  /** Toggle the thinking display（Ctrl+T）: expanded shows the live reasoning
   * tail while it streams and settles later steps as inline blocks; collapsing
   * is silent — the visible change is its own feedback. Expanding while no
   * reasoning is in flight prints the last settled step's full text as a
   * panel: Static rows cannot re-render, so like Ctrl+O the reveal for
   * already-settled content is a one-shot print. */
  toggleThinking(): boolean {
    this.thinkingExpanded = !this.thinkingExpanded
    if (this.thinkingExpanded) {
      if (this.reasoningChars > 0 && this.phase === 'thinking') this.commit()
      else if (this.lastReasoning !== null) this.emitLastThinkingDetail()
      else this.addNotice('当前没有可展示的思考内容（仅记录本次会话运行中产生的思考）')
    } else {
      this.commit()
    }
    return this.thinkingExpanded
  }

  /** Full text of the last settled step's reasoning as a bordered panel,
   * viewport-capped like the Ctrl+O tool detail and head-anchored — the
   * common want is how the model started thinking, and the summary notice
   * already carries the first line. */
  private emitLastThinkingDetail(): void {
    const last = this.lastReasoning
    if (last === null) return
    const lines = last.text.trimStart().split('\n')
    const cap = Math.max(10, (process.stdout.rows ?? 40) - 12)
    const shown = lines.slice(0, cap)
    this.addPanel(`思考全文 · ${formatCount(last.chars)} 字 · ${formatElapsed(last.durationMs)}`, [
      ...shown,
      ...(lines.length > shown.length ? [`…（还有 ${lines.length - shown.length} 行未显示）`] : []),
    ])
  }

  // -- Local actions -------------------------------------------------------

  /** Echo a submitted message: immediately as a transcript item when idle, or
   * as a pending indicator when the agent is busy (promoted on its session
   * event). `mode` only labels the indicator — delivery semantics belong to
   * the caller's steer/follow-up choice. The ride-along trays (images, `!`
   * outputs) are echoed as `📎`/`🧾` label lines so the user can see what the
   * model is about to receive. */
  echoUser(
    id: string,
    text: string,
    opts: { images?: readonly string[]; outputs?: readonly string[]; mode?: 'queue' | 'steer' } = {},
  ): void {
    this.echoedId = id
    const images = opts.images ?? []
    const outputs = opts.outputs ?? []
    if (this.phase !== 'idle') {
      this.queuedMessages.push({ id, text, images, outputs, mode: opts.mode ?? 'queue' })
    } else {
      this.items.push({
        kind: 'user',
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(outputs.length > 0 ? { outputs } : {}),
      })
      this.phase = 'thinking'
      this.phaseDetail = ''
    }
    this.commit()
  }

  /** Reset for a live switch to another persisted session. */
  reset(sessionId: string, model: string, events: readonly SessionEvent[]): void {
    // Defensive fail-closed: a waterfall still pending across a session switch
    // must not dangle (the upstream abort path normally clears it first; the
    // quiet variant skips the notice — the old transcript is discarded here).
    this.approvals.cancelQuiet()
    this.questions.cancelQuiet()
    this.sessionId = sessionId
    this.model = model
    this.items = []
    if (this.lastBanner !== null) {
      // Fresh batch, fresh facts: the banner re-leads the transcript with the
      // switched-to session's id and model.
      this.lastBanner = { ...this.lastBanner, sessionId, model }
      this.items.push({ kind: 'banner', ...this.lastBanner })
    }
    this.pendingTools.clear()
    this.pendingImages = []
    this.pendingOutputs = []
    this.stashOrder = []
    this.queuedMessages = []
    this.todos = []
    this.childAgentCount = 0
    this.turnToolCalls = 0
    this.retryWait = null
    this.streamBuf = ''
    this.streamText = ''
    this.phase = 'idle'
    this.phaseDetail = ''
    this.usage = ''
    this.lastReasoning = null
    this.thinkingExpanded = false
    this.resetReasoning()
    this.effortLabel = ''
    this.lastUsage = null
    this.streamStartMs = null
    this.pressureWarnedLevel = 0
    this.echoedId = null
    // Cached custom-command output belongs to the outgoing session; the
    // watcher's session-switch refresh repopulates it.
    this.customStatus = null
    this.replay(events)
    this.finishReplay()
  }

  /** Update the status-bar model label (after a /model switch). */
  setModel(model: string): void {
    this.model = model
    this.commit()
  }

  /** Apply a /statusline configuration change (startup seed included). */
  setStatusLineItems(items: readonly StatusLineItemId[]): void {
    this.statusLineItems = [...items]
    this.commit()
  }

  /** Git-branch segment; '' hides it (not a repository / unreadable). */
  setGitBranch(branch: string): void {
    if (this.gitBranch === branch) return
    this.gitBranch = branch
    this.commit()
  }

  /** Custom-command segment; null hides it (no data yet, cleared on session
   * switch, or empty stdout). */
  setCustomStatus(text: string | null): void {
    if (this.customStatus === text) return
    this.customStatus = text
    this.commit()
  }

  /** Auto-compaction in progress: a transient segment while history is being
   * rewritten at idle — the one moment "still idle?" is ambiguous. */
  setCompacting(value: boolean): void {
    if (this.compacting === value) return
    this.compacting = value
    this.commit()
  }

  setChildAgentCount(count: number): void {
    this.childAgentCount = count
    this.commit()
  }

  toggleVerboseTranscript(): boolean {
    this.verboseTranscript = !this.verboseTranscript
    this.addNotice(this.verboseTranscript
      ? 'Transcript 模式已开启：显示注入的上下文消息'
      : 'Transcript 模式已关闭')
    return this.verboseTranscript
  }

  /** Queue an image to ride along with the next submitted message. */
  addPendingImage(ref: ImageAttachmentRef, label: string): void {
    this.pendingImages.push({ ref, label })
    this.stashOrder.push({ kind: 'image', ref })
    this.commit()
  }

  /** Take and clear the queued images (called when the next message is submitted). */
  consumePendingImages(): PendingImage[] {
    if (this.pendingImages.length === 0) return []
    const images = this.pendingImages
    this.pendingImages = []
    this.stashOrder = this.stashOrder.filter(entry => entry.kind !== 'image')
    this.commit()
    return images
  }

  /** Retract the most recently queued image (Backspace on an empty editor);
   * undefined when the tray is already empty. */
  removeLastPendingImage(): PendingImage | undefined {
    const removed = this.pendingImages.pop()
    if (removed !== undefined) {
      const orderIndex = this.stashOrder.findIndex(entry => entry.kind === 'image' && entry.ref === removed.ref)
      if (orderIndex >= 0) this.stashOrder.splice(orderIndex, 1)
      this.commit()
    }
    return removed
  }

  /** Drop every queued image (`Alt+Backspace`, `/image clear`); returns how many went away. */
  clearPendingImages(): number {
    const count = this.pendingImages.length
    if (count === 0) return 0
    this.pendingImages = []
    this.stashOrder = this.stashOrder.filter(entry => entry.kind !== 'image')
    this.commit()
    return count
  }

  // -- Pending-output tray (`!` shell runs) ---------------------------------

  /** Queue one `!`-run output to ride along with the next submitted message. */
  addPendingOutput(output: Omit<PendingOutput, 'id'>): PendingOutput {
    const pending: PendingOutput = { ...output, id: randomUUID() }
    this.pendingOutputs.push(pending)
    this.stashOrder.push({ kind: 'output', id: pending.id })
    this.commit()
    return pending
  }

  /** Take and clear the queued outputs (called when the next message is submitted). */
  consumePendingOutputs(): PendingOutput[] {
    if (this.pendingOutputs.length === 0) return []
    const outputs = this.pendingOutputs
    this.pendingOutputs = []
    this.stashOrder = this.stashOrder.filter(entry => entry.kind !== 'output')
    this.commit()
    return outputs
  }

  /** Retract whatever stashed last — image or `!` output, real stash order —
   * on Backspace over an empty editor. */
  removeLastStashed(): { kind: 'image'; label: string } | { kind: 'output'; command: string } | undefined {
    const entry = this.stashOrder.pop()
    if (entry === undefined) return undefined
    if (entry.kind === 'image') {
      const index = this.pendingImages.findIndex(image => image.ref === entry.ref)
      if (index < 0) return undefined
      const [removed] = this.pendingImages.splice(index, 1)
      this.commit()
      return { kind: 'image', label: removed!.label }
    }
    const index = this.pendingOutputs.findIndex(output => output.id === entry.id)
    if (index < 0) return undefined
    const [removed] = this.pendingOutputs.splice(index, 1)
    this.commit()
    return { kind: 'output', command: removed!.command }
  }

  /** Drop every stashed item across both trays (`Alt+Backspace`); returns the count. */
  clearStash(): number {
    const count = this.pendingImages.length + this.pendingOutputs.length
    if (count === 0) return 0
    this.pendingImages = []
    this.pendingOutputs = []
    this.stashOrder = []
    this.commit()
    return count
  }

  /** Drop already-rendered transcript items; the previous Ink mount's Static
   * output stays in the terminal scrollback, so a fresh mount must not re-render it.
   * The banner leads the fresh batch (its previous copy was flushed away). */
  discardRenderedItems(): void {
    this.items = this.lastBanner !== null ? [{ kind: 'banner', ...this.lastBanner }] : []
    this.commit()
  }

  addNotice(text: string, tone: NoticeItem['tone'] = 'info'): void {
    this.items.push({ kind: 'notice', text, tone })
    this.commit()
  }

  /** Prominent bordered feedback (command output, help), unlike subtle notices. */
  addPanel(title: string, lines: readonly string[]): void {
    this.items.push({ kind: 'panel', title, lines })
    this.commit()
  }

  /** Welcome banner as the transcript's first item; push before any replay.
   * Remembered so session switches and external-editor re-mounts can lead a
   * fresh Static batch with the banner again. */
  addBanner(banner: Omit<BannerItem, 'kind'>): void {
    this.lastBanner = banner
    this.items.push({ kind: 'banner', ...banner })
    this.commit()
  }

  setInterrupting(): void {
    if (this.phase === 'idle') return
    this.phaseDetail = '中断中…'
    this.commit()
  }

  armExit(): void {
    this.exitArmed = true
    if (this.exitTimer !== null) clearTimeout(this.exitTimer)
    this.exitTimer = setTimeout(() => {
      this.exitArmed = false
      this.commit()
    }, EXIT_ARM_MS)
    this.commit()
  }

  toggleVerboseToolDetail(): boolean {
    this.verboseToolDetail = !this.verboseToolDetail
    this.addNotice(this.verboseToolDetail
      ? '工具详情已切换为完整显示（影响之后完成的卡片）'
      : '工具详情已切换为摘要显示（影响之后完成的卡片）')
    if (this.verboseToolDetail) this.emitLastToolDetail()
    return this.verboseToolDetail
  }

  /** Static transcript items never re-render, so the global toggle cannot
   * restyle already-settled cards; instead, switching to full detail prints
   * the latest tool call's complete output as a panel — the common want is
   * the full text of what was just truncated. Bounded by the viewport so the
   * panel itself never becomes an over-viewport Static item. Terminal cards
   * lead with the full command: their compact header truncates it, so this
   * panel is the only place the raw text survives. */
  private emitLastToolDetail(): void {
    let i = this.items.length - 1
    while (i >= 0 && this.items[i]!.kind === 'notice') i--
    const item = this.items[i]
    if (item === undefined || item.kind !== 'tool') return
    const view = item.view
    const command = view !== undefined && view.card === 'terminal' ? (view.title ?? item.title) : undefined
    const output = view !== undefined && view.card === 'terminal' && view.output !== undefined ? view.output : item.result
    const body = command !== undefined ? [command, '', ...output.split('\n')] : output.split('\n')
    const cap = Math.max(10, (process.stdout.rows ?? 40) - 12)
    const shown = body.slice(0, cap)
    this.addPanel(`工具详情 · ${truncateLine(item.title, 60)}`, [
      ...shown,
      ...(body.length > shown.length ? [`…（还有 ${body.length - shown.length} 行未显示）`] : []),
    ])
  }

  /** Set the approval stance directly（/config 路径）；an optional notice replaces
   * the default announcement. */
  setApprovalMode(mode: ApprovalMode, notice?: string): void {
    const changed = this.approvalMode !== mode
    this.approvalMode = mode
    if (notice !== undefined) this.addNotice(notice)
    else if (changed) this.commit()
  }

  /** Cycle the approval stance（每次询问 ⇄ 自动允许）and announce the switch;
   * returns the new mode. Session-scoped: Shift+Tab never rewrites the saved
   * startup default — persisting that is `/config`'s job. */
  cycleApprovalMode(): ApprovalMode {
    const next = this.approvalMode === 'ask' ? 'auto' : 'ask'
    this.setApprovalMode(next, next === 'auto'
      ? '自动允许模式已开启：工具调用不再逐个询问（shift+tab 切回）'
      : '已切回每次询问模式：工具调用将逐个请求批准')
    return next
  }

  /** Context pressure from the token meter; window comes from request/context events.
   * Crossing 80%/95% upward warns once per episode; dropping back below 80%
   * (a /compact) re-arms the warnings. */
  setContextPressure(tokens: number): void {
    this.contextTokens = tokens
    if (this.contextWindow !== undefined && this.contextWindow > 0 && tokens > 0) {
      const ratio = tokens / this.contextWindow
      if (ratio >= 0.95 && this.pressureWarnedLevel < 2) {
        this.pressureWarnedLevel = 2
        this.items.push({
          kind: 'notice',
          tone: 'warn',
          text: '上下文已用 95% 以上：建议立即 /compact 压缩历史（或 /config autocompact on 开启自动压缩）',
        })
      } else if (ratio >= 0.8 && this.pressureWarnedLevel < 1) {
        this.pressureWarnedLevel = 1
        this.items.push({
          kind: 'notice',
          tone: 'warn',
          text: '上下文已用 80% 以上：可用 /compact 压缩历史',
        })
      } else if (ratio < 0.8) {
        this.pressureWarnedLevel = 0
      }
    }
    this.commit()
  }

  /** Remove one pending queued/steered message from the indicator list
   * (Alt+Up recall); undefined when the id is no longer pending. */
  removeQueued(id: string): QueuedMessage | undefined {
    const index = this.queuedMessages.findIndex(message => message.id === id)
    if (index < 0) return undefined
    const [removed] = this.queuedMessages.splice(index, 1)
    this.commit()
    return removed
  }

  /** Raw args of a pending call, for approval memory keys and prompts. */
  pendingToolFor(callId: string | undefined): PendingTool | undefined {
    if (callId === undefined) return undefined
    return this.pendingTools.get(callId)
  }

  // -- Approval bridge -----------------------------------------------------

  askApproval(req: { toolName: string; reason: string; command?: string }): Promise<ApprovalChoice> {
    return this.approvals.ask(req)
  }

  answerApproval(choice: ApprovalChoice): void {
    this.approvals.answer(choice)
  }

  /** Withdraw a pending approval prompt (request aborted upstream); resolves
   * fail-closed — see ApprovalBridge.cancel. */
  cancelApproval(): void {
    this.approvals.cancel()
  }

  // -- User-questions bridge -------------------------------------------------

  askQuestions(items: readonly AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> {
    return this.questions.ask(items)
  }

  toggleQuestionOption(label: string): void {
    this.questions.toggleOption(label)
  }

  moveQuestionCursor(delta: 1 | -1): void {
    this.questions.moveCursor(delta)
  }

  pointQuestionCursor(index: number): void {
    this.questions.pointCursor(index)
  }

  confirmQuestion(defaultLabel?: string): void {
    this.questions.confirm(defaultLabel)
  }

  submitFreeTextAnswer(text: string): void {
    this.questions.submitFreeText(text)
  }

  skipQuestion(): void {
    this.questions.skip()
  }

  cancelQuestions(): void {
    this.questions.cancel()
  }
}

// -- Helpers -----------------------------------------------------------------

function callViewTitle(view: ToolCallView | undefined): string | undefined {
  return view?.card === 'generic' ? view.title
    : view?.card === 'terminal' ? view.title
      : view?.card === 'diff' ? view.title
        : undefined
}

function blocksToText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Reasoning content of a persisted assistant message — the replay-side
 * substitute for live reasoning deltas, which never ride session events. */
function blocksToReasoningText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'reasoning') text += block.text
  }
  return text
}

export { blocksToText as blocksToTextOf }

function resultBlocks(message: ToolResultMessage): readonly ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const block of message.content as readonly ContentBlock[]) {
    if (block.type === 'tool-result') blocks.push(...block.content)
    else blocks.push(block)
  }
  return blocks
}

function toolResultCallId(message: ToolResultMessage): string | undefined {
  for (const block of message.content as readonly ContentBlock[]) {
    if (block.type === 'tool-result') return block.toolCallId
  }
  return undefined
}

export { toolResultCallId as toolResultCallIdOf }

function toolResultText(message: ToolResultMessage, error: { name: string; code: string } | undefined): string {
  const parts: string[] = []
  for (const block of message.content as readonly ContentBlock[]) {
    if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    } else if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  if (parts.length === 0 && error !== undefined) parts.push(`${error.name}: ${error.code}`)
  return truncate(parts.join('\n'), RESULT_PREVIEW_LIMIT)
}

export { toolResultText as toolResultTextOf }

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断）`
}

/** Status-bar usage summary: in/out counts, cache-hit share of the prompt,
 * and output speed for live-streamed requests. The speed needs a real
 * measurement window — a single-chunk answer spans a millisecond or two and
 * would advertise absurd rates, so short windows stay unreported. */
function formatUsage(usage: TokenUsage, durationMs: number | null): string {
  let text = `↑${formatCount(usage.inputTokens)} ↓${formatCount(usage.outputTokens)}`
  const cacheRead = usage.cacheReadTokens ?? 0
  const promptTotal = usage.inputTokens + cacheRead + (usage.cacheWriteTokens ?? 0)
  if (cacheRead > 0 && promptTotal > 0) {
    text += ` · 缓存 ${Math.round((cacheRead / promptTotal) * 100)}%`
  }
  if (durationMs !== null && durationMs >= 500 && usage.outputTokens > 0) {
    text += ` · ${(usage.outputTokens / (durationMs / 1000)).toFixed(1)} tok/s`
  }
  return text
}

/** Compact one-line preview of raw tool arguments. */
export function formatToolArgs(args: string, limit: number): string {
  if (args === '') return ''
  let preview = args
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed === 'object' && parsed !== null) {
      const entries = Object.entries(parsed as Record<string, unknown>)
      preview = entries
        .slice(0, 4)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
      if (entries.length > 4) preview += ` …（${entries.length - 4} 个参数已省略）`
    }
  } catch {
    // raw JSON string as produced by the model — keep as-is
  }
  return truncateLine(preview, limit)
}
