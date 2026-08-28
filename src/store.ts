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
}

export interface PendingImage {
  readonly ref: ImageAttachmentRef
  readonly label: string
}

/** A message submitted while the agent was busy; delivered when the turn claims it. */
export interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly images: readonly string[]
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
  private approval: ApprovalPrompt | null = null
  private approvalResolve: ((choice: ApprovalChoice) => void) | null = null
  private approvalSeq = 0
  private questionQueue: AskUserQuestionItem[] = []
  private questionAnswers: AskUserQuestionAnswerItem[] = []
  private questionActive: ActiveQuestion | null = null
  private questionResolve: ((answer: AskUserQuestionAnswer) => void) | null = null
  private contextTokens = 0
  private contextWindow: number | undefined
  private verboseToolDetail = false
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
        this.reasoningChars = 0
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
          this.streamBuf += chunk.text
          this.phase = 'streaming'
        } else if (chunk.type === 'reasoning-delta') {
          this.reasoningChars += chunk.text.length
        }
        return // batched; flushed on the interval tick
      }
      case 'assistant/message': {
        this.streamBuf = ''
        this.streamText = ''
        const text = blocksToText(ev.data.message.content)
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
        if (ev.data.usage !== undefined) this.usage = formatUsage(ev.data.usage)
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
      case 'todo/write': {
        this.todos = [...ev.data.todos]
        break
      }
      case 'turn/end': {
        this.finalizeStream(ev.data.reason.kind === 'aborted')
        this.phase = 'idle'
        this.phaseDetail = ''
        this.reasoningChars = 0
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
    this.commit()
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

  // -- Local actions -------------------------------------------------------

  /** Echo a submitted message: immediately as a transcript item when idle, or
   * as a queued indicator when the agent is busy (promoted on its session event). */
  echoUser(id: string, text: string, images?: readonly string[]): void {
    this.echoedId = id
    if (this.phase !== 'idle') {
      this.queuedMessages.push({ id, text, images: images ?? [] })
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
    this.streamBuf = ''
    this.streamText = ''
    this.phase = 'idle'
    this.phaseDetail = ''
    this.usage = ''
    this.reasoningChars = 0
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
    return this.verboseToolDetail
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

  /** Context pressure from the token meter; window comes from request/context events. */
  setContextPressure(tokens: number): void {
    this.contextTokens = tokens
    this.commit()
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

  /** Withdraw a pending approval prompt (request aborted upstream). */
  cancelApproval(): void {
    if (this.approvalResolve === null) return
    this.approvalResolve = null
    this.approval = null
    this.commit()
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
    this.questionActive = {
      item: next,
      selected: [],
      index: this.questionAnswers.length + 1,
      total: this.questionAnswers.length + 1 + this.questionQueue.length,
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

function formatUsage(usage: TokenUsage): string {
  let text = `↑${formatCount(usage.inputTokens)} ↓${formatCount(usage.outputTokens)}`
  if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
    text += ` · 缓存 ${formatCount(usage.cacheReadTokens)}`
  }
  return text
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = charWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}
