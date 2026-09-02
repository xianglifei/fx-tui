/** Read-only session introspection: /tree draws the lineage the fork commands
 * build, /trace dumps the event log the transcript is rendered from.
 *
 * Both are panels rather than pickers: /sessions already owns "go somewhere",
 * so these only answer "where am I" and "what happened".
 */

import { basename } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { blocksToTextOf } from '../store.js'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'

/** Nodes /tree renders before it stops and says the rest exist. */
const TREE_LIMIT = 40
/** /trace windows from the end: the tail is what the user just lived through. */
const TRACE_WINDOW = 60

export async function runTree(c: CommandCtx): Promise<void> {
  const current = c.agent().session.id
  let trace
  try {
    trace = await c.ctx.sessionQuery.traceSession(current)
  } catch (error) {
    c.store.addNotice(`读取会话血缘失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }

  // `ancestors` runs from the immediate parent outward, so reversing it puts
  // the oldest known ancestor at depth 0.
  const chain = [...trace.ancestors].toReversed()
  const rows: { depth: number; record: SessionRecord }[] = []
  let total = 0
  const push = (depth: number, record: SessionRecord): void => {
    total += 1
    if (rows.length < TREE_LIMIT) rows.push({ depth, record })
  }
  const walk = (node: SessionLineageNode, depth: number): void => {
    push(depth, node.session)
    for (const child of node.descendants) walk(child, depth + 1)
  }
  chain.forEach((record, depth) => push(depth, record))
  push(chain.length, trace.target)
  for (const child of trace.descendants) walk(child, chain.length + 1)

  const titleById = new Map<string, string>()
  try {
    const observations = await c.ctx.sessionQuery.readTitleSnapshots(rows.map(row => row.record.header.id))
    for (const observation of observations) {
      if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
        titleById.set(observation.sessionId, observation.value.title.title)
      }
    }
  } catch { /* titles are display-optional */ }

  const lines: string[] = []
  for (const row of rows) {
    const header = row.record.header
    const title = titleById.get(header.id)
    const dir = header.cwd !== undefined ? basename(header.cwd) : '?'
    const mark = header.id === current ? '* ' : ''
    lines.push(`${'  '.repeat(row.depth)}${mark}${title !== undefined ? truncateLine(title, 24) : '(无标题)'} · ${stampOf(header.createdAt)} · ${dir} · ${header.id.slice(0, 21)}`)
  }
  if (!trace.complete) lines.unshift(`… 更早的祖先不在可见范围内（${trace.unresolvedParentId}）`)
  if (total > rows.length) lines.push(`…（血缘共 ${total} 个会话，只显示前 ${rows.length} 个）`)
  lines.push('', '* 当前会话 · /sessions 可切换 · /fork /clear /rewind 会产生分支')
  c.store.addPanel('会话家族树', lines)
}

export function runTrace(c: CommandCtx): void {
  const events = c.agent().session.events
  if (events.length === 0) {
    c.store.addNotice('当前会话还没有任何事件')
    return
  }
  const lines = traceLines(events)
  const shown = lines.slice(-TRACE_WINDOW)
  const header = lines.length > shown.length
    ? `共 ${lines.length} 条记录，显示最后 ${shown.length} 条`
    : `共 ${lines.length} 条记录`
  c.store.addPanel('会话事件轨迹', [header, '', ...shown])
}

function traceLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  const origin = events[0]?.time ?? 0
  // Streaming chunks arrive by the hundreds and say nothing individually, so a
  // run of them collapses into one line anchored at its first seq.
  let chunks = 0
  let chunkSeq = 0
  let chunkAt = 0
  const flushChunks = (): void => {
    if (chunks === 0) return
    lines.push(`${prefix(chunkSeq, chunkAt - origin)}流式输出 ${chunks} 块`)
    chunks = 0
  }
  for (const event of events) {
    if (event.type === 'assistant/chunk') {
      if (chunks === 0) {
        chunkSeq = event.seq
        chunkAt = event.time
      }
      chunks += 1
      continue
    }
    flushChunks()
    lines.push(`${prefix(event.seq, event.time - origin)}${labelOf(event)}`)
  }
  flushChunks()
  return lines
}

function prefix(seq: number, delta: number): string {
  return `#${seq} · +${elapsed(delta)} · `
}

function elapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function labelOf(event: SessionEvent): string {
  switch (event.type) {
    case 'turn/start':
      return `轮次 ${event.data.turn} 开始`
    case 'turn/end':
      return `轮次 ${event.data.turn} 结束（${event.data.reason.kind}）`
    case 'step/start':
      return `步骤 ${event.data.step} 开始`
    case 'step/end':
      return `步骤 ${event.data.step} 结束`
    case 'user/message':
      return `用户：${preview(blocksToTextOf(event.data.content))}`
    case 'assistant/message':
      return `助手：${preview(blocksToTextOf(event.data.message.content))}`
    case 'tool/call':
      return `工具调用 ${event.data.name}（${argumentSummary(event.data.arguments)}）`
    case 'tool/result':
      return `工具结果 ${event.data.error === undefined ? '完成' : `失败 ${event.data.error.code}`}`
    default:
      return event.type
  }
}

/** The one argument worth reading, by the same heuristic /export uses. */
function argumentSummary(raw: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return preview(raw)
  }
  const summary = typeof parsed.command === 'string' ? parsed.command
    : typeof parsed.path === 'string' ? parsed.path
      : typeof parsed.pattern === 'string' ? parsed.pattern : ''
  return summary === '' ? '…' : preview(summary)
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(空)' : truncateLine(flat, 60)
}

/** `M-D HH:mm` — the shape every session listing uses. */
function stampOf(time: number): string {
  const at = new Date(time)
  return `${at.getMonth() + 1}-${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
