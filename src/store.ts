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

import type { ContentBlock, TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import stringWidth from 'string-width'

// -- Transcript items ---------------------------------------------------------

export interface UserItem { readonly kind: 'user'; readonly text: string; readonly images?: readonly string[] }
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
export type FinalItem = UserItem | AssistantItem | ToolItem | NoticeItem | PanelItem | BannerItem

export interface PendingTool {
  readonly callId: string
  readonly name: string
  readonly title: string
  readonly args: string
  readonly startedAt: number
}

export interface ApprovalPrompt {
  readonly seq: number
  readonly toolName: string
  readonly reason: string
  readonly command?: string
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'reject'

export interface ActiveQuestion {
  readonly item: AskUserQuestionItem
  readonly selected: readonly string[]
  readonly index: number
  readonly total: number
  /** Highlighted option (arrow-key channel); digits jump-select through the
   * visible window. Lives here — not in the view — because the estimator
   * budgets the visible option window and must agree with the render. */
  readonly cursor: number
  /** First visible option of the QUESTION_WINDOW sliding window. */
  readonly scroll: number
}

/** Options visible at once in a question card; a longer list scrolls through
 * this window instead of being capped (which used to strand /sessions at the
 * newest 9 and force /theme into 8-per-page pagination). */
export const QUESTION_WINDOW = 9

export interface PendingImage {
  readonly ref: ImageAttachmentRef
  readonly label: string
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
  readonly mode: 'queue' | 'steer'
}

export type Phase = 'idle' | 'thinking' | 'streaming' | 'tool'

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
  readonly queuedMessages: readonly QueuedMessage[]
  readonly todos: readonly TodoItem[]
  readonly childAgents: number
  readonly verboseTranscript: boolean
  readonly streaming: string
  readonly phase: Phase
  readonly phaseDetail: string
  readonly usage: string
  readonly reasoningChars: number
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

export class TuiStore {
  private items: FinalItem[] = []
  private pendingTools = new Map<string, PendingTool>()
  private pendingImages: PendingImage[] = []
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
  private reasoningHead = ''
  private reasoningStartMs: number | null = null
  private reasoningLastMs: number | null = null
  private approval: ApprovalPrompt | null = null
  private approvalResolve: ((choice: ApprovalChoice) => void) | null = null
  private approvalSeq = 0
  private questionQueue: AskUserQuestionItem[] = []
  private questionAnswers: AskUserQuestionAnswerItem[] = []
  private questionActive: ActiveQuestion | null = null
  private questionResolve: ((answer: AskUserQuestionAnswer) => void) | null = null
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
    this.snapshot = {
      version: this.snapshot?.version !== undefined ? this.snapshot.version + 1 : 1,
      items: [...this.items],
      pendingTools: [...this.pendingTools.values()],
      pendingImages: [...this.pendingImages],
      queuedMessages: [...this.queuedMessages],
      todos: [...this.todos],
      childAgents: this.childAgentCount,
      verboseTranscript: this.verboseTranscript,
      streaming: this.streamText,
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      usage: this.usage,
      reasoningChars: this.reasoningChars,
      approval: this.approval,
      question: this.questionActive,
      questionFreeText: this.questionActive !== null && (this.questionActive.item.options ?? []).length === 0,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      effortLabel: this.effortLabel,
      lastUsage: this.lastUsage,
      verboseToolDetail: this.verboseToolDetail,
      exitArmed: this.exitArmed,
      sessionId: this.sessionId,
      model: this.model,
      approvalMode: this.approvalMode,
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
  }

  private flushStream(): void {
    if (this.streamBuf === '') return
    this.streamText += this.streamBuf
    this.streamBuf = ''
    this.commit()
  }

  // -- Session event reducer ----------------------------------------------

  /** Fold one live session event into the view state. */
  onEvent(ev: SessionEvent): void {
    switch (ev.type) {
      case 'turn/start': {
        this.phase = 'thinking'
        this.phaseDetail = ''
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
          })
          break
        }
        if (isEcho) break // idle-time echo already rendered
        this.items.push({ kind: 'user', text: blocksToText(message.content) })
        break
      }
      case 'assistant/chunk': {
        if (this.replaying) break
        const chunk = ev.data.chunk
        if (chunk.type === 'text-delta') {
          // First visible delta opens the TPS measurement window; the paired
          // assistant/message closes it against its usage report.
          if (this.streamStartMs === null) this.streamStartMs = ev.time
          this.streamBuf += chunk.text
          this.phase = 'streaming'
        } else if (chunk.type === 'reasoning-delta') {
          if (this.reasoningStartMs === null) this.reasoningStartMs = ev.time
          this.reasoningLastMs = ev.time
          this.reasoningChars += chunk.text.length
          if (this.reasoningHead.length < 200) this.reasoningHead += chunk.text
        }
        return // batched; flushed on the interval tick
      }
      case 'assistant/message': {
        this.streamBuf = ''
        this.streamText = ''
        const text = blocksToText(ev.data.message.content)
        // A settled one-line record of this step's reasoning (replays never
        // saw the deltas, so replayed transcripts simply omit it).
        const thinking = this.reasoningNotice()
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
      case 'turn/end': {
        this.finalizeStream(ev.data.reason.kind === 'aborted')
        this.phase = 'idle'
        this.phaseDetail = ''
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
    this.reasoningHead = ''
    this.reasoningStartMs = null
    this.reasoningLastMs = null
  }

  /** Settled one-line record of the step's reasoning: first line as summary +
   * live-measured thinking duration. null when the step reasoned nothing. */
  private reasoningNotice(): NoticeItem | null {
    if (this.reasoningChars <= 0) return null
    const firstLine = this.reasoningHead.split('\n').map(line => line.trim()).find(line => line !== '')
    const summary = firstLine !== undefined
      ? truncateLine(firstLine, 60)
      : `${this.reasoningChars} 字`
    const durationMs = this.reasoningStartMs !== null && this.reasoningLastMs !== null
      ? Math.max(0, this.reasoningLastMs - this.reasoningStartMs)
      : 0
    return {
      kind: 'notice',
      tone: 'info',
      text: `✻ 思考：${summary} · ${formatDuration(durationMs)}`,
    }
  }

  // -- Local actions -------------------------------------------------------

  /** Echo a submitted message: immediately as a transcript item when idle, or
   * as a pending indicator when the agent is busy (promoted on its session
   * event). `mode` only labels the indicator — delivery semantics belong to
   * the caller's steer/follow-up choice. */
  echoUser(id: string, text: string, images?: readonly string[], mode: 'queue' | 'steer' = 'queue'): void {
    this.echoedId = id
    if (this.phase !== 'idle') {
      this.queuedMessages.push({ id, text, images: images ?? [], mode })
    } else {
      this.items.push({ kind: 'user', text, ...(images !== undefined && images.length > 0 ? { images } : {}) })
      this.phase = 'thinking'
      this.phaseDetail = ''
    }
    this.commit()
  }

  /** Reset for a live switch to another persisted session. */
  reset(sessionId: string, model: string, events: readonly SessionEvent[]): void {
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
    this.queuedMessages = []
    this.todos = []
    this.childAgentCount = 0
    this.turnToolCalls = 0
    this.streamBuf = ''
    this.streamText = ''
    this.phase = 'idle'
    this.phaseDetail = ''
    this.usage = ''
    this.resetReasoning()
    this.effortLabel = ''
    this.lastUsage = null
    this.streamStartMs = null
    this.pressureWarnedLevel = 0
    this.echoedId = null
    this.replay(events)
    this.finishReplay()
  }

  /** Update the status-bar model label (after a /model switch). */
  setModel(model: string): void {
    this.model = model
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
    this.commit()
  }

  /** Take and clear the queued images (called when the next message is submitted). */
  consumePendingImages(): PendingImage[] {
    if (this.pendingImages.length === 0) return []
    const images = this.pendingImages
    this.pendingImages = []
    this.commit()
    return images
  }

  /** Retract the most recently queued image (Backspace on an empty editor);
   * undefined when the tray is already empty. */
  removeLastPendingImage(): PendingImage | undefined {
    const removed = this.pendingImages.pop()
    if (removed !== undefined) this.commit()
    return removed
  }

  /** Drop every queued image (`Alt+Backspace`, `/image clear`); returns how many went away. */
  clearPendingImages(): number {
    const count = this.pendingImages.length
    if (count === 0) return 0
    this.pendingImages = []
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
   * panel itself never becomes an over-viewport Static item. */
  private emitLastToolDetail(): void {
    let i = this.items.length - 1
    while (i >= 0 && this.items[i]!.kind === 'notice') i--
    const item = this.items[i]
    if (item === undefined || item.kind !== 'tool') return
    const lines = item.result.split('\n')
    const cap = Math.max(10, (process.stdout.rows ?? 40) - 12)
    const shown = lines.slice(0, cap)
    this.addPanel(`工具详情 · ${item.title}`, [
      ...shown,
      ...(lines.length > shown.length ? [`…（还有 ${lines.length - shown.length} 行未显示）`] : []),
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
    return new Promise(resolve => {
      this.approvalSeq += 1
      this.approval = { seq: this.approvalSeq, toolName: req.toolName, reason: req.reason, command: req.command }
      this.approvalResolve = resolve
      this.commit()
    })
  }

  answerApproval(choice: ApprovalChoice): void {
    if (this.approvalResolve === null) return
    const resolve = this.approvalResolve
    const toolName = this.approval?.toolName ?? '(tool)'
    this.approvalResolve = null
    this.approval = null
    const label = choice === 'once' ? '已允许（本次）'
      : choice === 'session' ? '已允许（本会话内同类调用不再询问）'
        : choice === 'always' ? '已允许（已写入记忆，之后自动放行）'
          : '已拒绝'
    this.items.push({
      kind: 'notice',
      tone: choice === 'reject' ? 'warn' : 'info',
      text: `${label} ${toolName}`,
    })
    this.commit()
    resolve(choice)
  }

  /** Withdraw a pending approval prompt (request aborted upstream). Resolves
   * fail-closed: leaving the promise pending would hang the awaiting
   * approval/request waterfall forever. */
  cancelApproval(): void {
    if (this.approvalResolve === null) return
    const resolve = this.approvalResolve
    const toolName = this.approval?.toolName ?? '(tool)'
    this.approvalResolve = null
    this.approval = null
    this.items.push({
      kind: 'notice',
      tone: 'warn',
      text: `审批请求已撤销，按拒绝处理：${toolName}`,
    })
    this.commit()
    resolve('reject')
  }

  // -- User-questions bridge -------------------------------------------------

  askQuestions(items: readonly AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> {
    return new Promise(resolve => {
      this.questionQueue = [...items]
      this.questionAnswers = []
      this.questionResolve = resolve
      this.advanceQuestion()
    })
  }

  toggleQuestionOption(label: string): void {
    const active = this.questionActive
    if (active === null) return
    const selected = active.item.multiSelect === true
      ? (active.selected.includes(label)
          ? active.selected.filter(l => l !== label)
          : [...active.selected, label])
      : [label]
    this.questionActive = { ...active, selected }
    this.commit()
  }

  /** Move the option highlight one step (wraps around); the visible window
   * slides only when the cursor would leave it. */
  moveQuestionCursor(delta: 1 | -1): void {
    const active = this.questionActive
    if (active === null) return
    const count = (active.item.options ?? []).length
    if (count === 0) return
    const cursor = ((active.cursor + delta) % count + count) % count
    this.placeQuestionCursor(cursor)
  }

  /** Point the highlight at an absolute option index (digit keys map to
   * positions within the visible window; the view resolves that mapping). */
  pointQuestionCursor(index: number): void {
    const active = this.questionActive
    if (active === null) return
    const count = (active.item.options ?? []).length
    if (count === 0) return
    this.placeQuestionCursor(Math.min(Math.max(0, index), count - 1))
  }

  private placeQuestionCursor(cursor: number): void {
    const active = this.questionActive
    if (active === null) return
    const count = (active.item.options ?? []).length
    let scroll = Math.min(Math.max(0, active.scroll), Math.max(0, count - QUESTION_WINDOW))
    if (cursor < scroll) scroll = cursor
    if (cursor >= scroll + QUESTION_WINDOW) scroll = cursor - QUESTION_WINDOW + 1
    this.questionActive = { ...active, cursor, scroll }
    this.commit()
  }

  /** Confirm the option selection for the active question; a default label
   * (plan-review's approve option) applies when nothing is selected. */
  confirmQuestion(defaultLabel?: string): void {
    const active = this.questionActive
    if (active === null) return
    const selected = active.selected.length > 0
      ? [...active.selected]
      : defaultLabel !== undefined ? [defaultLabel] : []
    if (selected.length === 0) return
    this.questionAnswers.push({ id: active.item.id, selected })
    this.advanceQuestion()
  }

  /** Free-text answer for the active question (typed in the main input box). */
  submitFreeTextAnswer(text: string): void {
    const active = this.questionActive
    if (active === null) return
    const trimmed = text.trim()
    if (trimmed === '') return
    this.questionAnswers.push({ id: active.item.id, selected: [], custom: trimmed })
    this.advanceQuestion()
  }

  /** Skip the active question with no selection. */
  skipQuestion(): void {
    const active = this.questionActive
    if (active === null) return
    this.questionAnswers.push({ id: active.item.id, selected: [] })
    this.advanceQuestion()
  }

  /** Withdraw the whole pending questionnaire (request aborted upstream). */
  cancelQuestions(): void {
    if (this.questionResolve === null) return
    const resolve = this.questionResolve
    this.questionResolve = null
    this.questionActive = null
    this.questionQueue = []
    this.questionAnswers = []
    this.commit()
    resolve({ answers: [] })
  }

  private advanceQuestion(): void {
    const next = this.questionQueue.shift()
    if (next === undefined) {
      const resolve = this.questionResolve
      this.questionResolve = null
      this.questionActive = null
      this.commit()
      resolve?.({ answers: this.questionAnswers })
      return
    }
    // A plan review starts on its approve option so bare Enter approves —
    // the same one-press default the digit-era card had.
    const options = next.options ?? []
    const approveLabel = next.intent?.kind === 'plan-review' ? next.intent.approve : undefined
    const approveIndex = approveLabel !== undefined ? options.findIndex(option => option.label === approveLabel) : -1
    this.questionActive = {
      item: next,
      selected: [],
      index: this.questionAnswers.length + 1,
      total: this.questionAnswers.length + 1 + this.questionQueue.length,
      cursor: approveIndex >= 0 ? approveIndex : 0,
      scroll: 0,
    }
    this.commit()
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Same scale as ui/estimate.ts's formatElapsed; kept local because the UI
 * module imports this one (a reverse import would close a cycle). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
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

function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  if (stringWidth(line) <= width) return line
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = stringWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}
