/**
 * Terminal UI state: the session-event-to-view reducer and the external store
 * React subscribes to.
 *
 * Completed transcript entries are append-only and rendered once through
 * Ink's Static region; streaming text and pending tool calls stay in the
 * dynamic region until they settle. Chunk events are batched on a flush
 * interval so high-frequency token streams do not thrash React renders.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface UserItem { readonly kind: 'user'; readonly text: string }
export interface AssistantItem { readonly kind: 'assistant'; readonly text: string; readonly interrupted: boolean }
export interface ToolItem { readonly kind: 'tool'; readonly name: string; readonly args: string; readonly ok: boolean; readonly result: string }
export interface NoticeItem { readonly kind: 'notice'; readonly text: string; readonly tone: 'info' | 'error' | 'warn' }
export type FinalItem = UserItem | AssistantItem | ToolItem | NoticeItem

export interface PendingTool { readonly callId: string; readonly name: string; readonly args: string }

export interface ApprovalPrompt {
  readonly seq: number
  readonly toolName: string
  readonly reason: string
}

export type Phase = 'idle' | 'thinking' | 'streaming' | 'tool'

export interface Snapshot {
  readonly version: number
  readonly items: readonly FinalItem[]
  readonly pendingTools: readonly PendingTool[]
  readonly streaming: string
  readonly phase: Phase
  readonly phaseDetail: string
  readonly usage: string
  readonly reasoningChars: number
  readonly approval: ApprovalPrompt | null
  readonly exitArmed: boolean
  readonly sessionId: string
  readonly model: string
}

const FLUSH_INTERVAL_MS = 60
const EXIT_ARM_MS = 2500
const RESULT_PREVIEW_LIMIT = 800

export class TuiStore {
  private items: FinalItem[] = []
  private pendingTools = new Map<string, PendingTool>()
  private streamBuf = ''
  private streamText = ''
  private phase: Phase = 'idle'
  private phaseDetail = ''
  private usage = ''
  private reasoningChars = 0
  private approval: ApprovalPrompt | null = null
  private approvalResolve: ((outcome: 'allowed-once' | 'rejected') => void) | null = null
  private approvalSeq = 0
  private exitArmed = false
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  private echoedId: string | null = null
  private replaying = false
  private snapshot!: Snapshot
  private readonly listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(readonly sessionId: string, readonly model: string) {
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
      streaming: this.streamText,
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      usage: this.usage,
      reasoningChars: this.reasoningChars,
      approval: this.approval,
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
        this.pendingTools.set(ev.data.callId, {
          callId: ev.data.callId,
          name: ev.data.name,
          args: ev.data.arguments,
        })
        this.phase = 'tool'
        this.phaseDetail = ev.data.name
        break
      }
      case 'tool/result': {
        const data = ev.data
        const callId = toolResultCallId(data.message)
        const pending = callId !== undefined ? this.pendingTools.get(callId) : undefined
        if (callId !== undefined) this.pendingTools.delete(callId)
        this.items.push({
          kind: 'tool',
          name: pending?.name ?? '(unknown tool)',
          args: pending?.args ?? '',
          ok: data.error === undefined,
          result: toolResultText(data.message, data.error),
        })
        this.phase = 'thinking'
        this.phaseDetail = ''
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
      this.items.push({ kind: 'tool', name: tool.name, args: tool.args, ok: true, result: '(结果未记录)' })
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
  echoUser(id: string, text: string): void {
    this.echoedId = id
    this.items.push({ kind: 'user', text })
    this.phase = 'thinking'
    this.phaseDetail = ''
    this.commit()
  }

  addNotice(text: string, tone: NoticeItem['tone'] = 'info'): void {
    this.items.push({ kind: 'notice', text, tone })
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

  // -- Approval bridge -----------------------------------------------------

  askApproval(req: { toolName: string; reason: string }): Promise<'allowed-once' | 'rejected'> {
    return new Promise(resolve => {
      this.approvalSeq += 1
      this.approval = { seq: this.approvalSeq, toolName: req.toolName, reason: req.reason }
      this.approvalResolve = resolve
      this.commit()
    })
  }

  answerApproval(outcome: 'allowed-once' | 'rejected'): void {
    if (this.approvalResolve === null) return
    const resolve = this.approvalResolve
    const toolName = this.approval?.toolName ?? '(tool)'
    this.approvalResolve = null
    this.approval = null
    this.items.push({
      kind: 'notice',
      tone: outcome === 'allowed-once' ? 'info' : 'warn',
      text: outcome === 'allowed-once' ? `已允许 ${toolName}（本次）` : `已拒绝 ${toolName}`,
    })
    this.commit()
    resolve(outcome)
  }
}

// -- Helpers -----------------------------------------------------------------

function blocksToText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

function toolResultCallId(message: ToolResultMessage): string | undefined {
  for (const block of message.content) {
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
