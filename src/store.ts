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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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
export type FinalItem = UserItem | AssistantItem | ToolItem | NoticeItem | PanelItem

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

export type Phase = 'idle' | 'thinking' | 'streaming' | 'tool'

export interface Snapshot {
  readonly version: number
  readonly items: readonly FinalItem[]
  readonly pendingTools: readonly PendingTool[]
  readonly pendingImages: readonly PendingImage[]
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
  private snapshot!: Snapshot
  private readonly listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly sessionId: string,
    readonly model: string,
    private readonly presenter?: ToolPresenter,
  ) {
    this.rebuild()
  }

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
        if (message.source.kind !== 'user') break
        if (this.echoedId !== null && message.id === this.echoedId) {
          this.echoedId = null
          break
        }
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
        this.items.push({
          kind: 'assistant',
          text: blocksToText(ev.data.message.content),
          interrupted: ev.data.interrupted === true,
        })
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
      case 'turn/end': {
        this.finalizeStream(ev.data.reason.kind === 'aborted')
        this.phase = 'idle'
        this.phaseDetail = ''
        this.reasoningChars = 0
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

  /** Echo a submitted message immediately; the matching session event is deduped by id. */
  echoUser(id: string, text: string, images?: readonly string[]): void {
    this.echoedId = id
    this.items.push({ kind: 'user', text, ...(images !== undefined && images.length > 0 ? { images } : {}) })
    this.phase = 'thinking'
    this.phaseDetail = ''
    this.commit()
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

  /** Drop already-rendered transcript items; the previous Ink mount's Static
   * output stays in the terminal scrollback, so a fresh mount must not re-render it. */
  discardRenderedItems(): void {
    this.items = []
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

  /** Confirm the option selection for the active question. */
  confirmQuestion(): void {
    const active = this.questionActive
    if (active === null) return
    if (active.selected.length === 0) return
    this.questionAnswers.push({ id: active.item.id, selected: [...active.selected] })
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

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断）`
}

function formatUsage(usage: TokenUsage): string {
  let text = `↑${formatCount(usage.inputTokens)} ↓${formatCount(usage.outputTokens)}`
  if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
    text += ` · 缓存↑${formatCount(usage.cacheReadTokens)}`
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
