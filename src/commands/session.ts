/** Session commands: /sessions (keyword-filtered picker), /rename, and the
 * lifecycle set (/new, /clear, /resume, /fork, /rewind) that mints or forks
 * the live session. */

import { basename } from 'node:path'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'
import { pick } from './pick.js'
import { dropsCompaction, isSeedable, sliceThrough, userTurns } from './seed.js'

/** How many rewind targets /rewind offers before it stops looking back. */
const REWIND_WINDOW = 20

/** Latest log-backed title of the current session (display-optional). */
export async function currentSessionTitle(c: CommandCtx): Promise<string | undefined> {
  try {
    const snapshot = await c.ctx.sessionQuery.readTitle(c.agent().session.id)
    return snapshot?.title
  } catch {
    return undefined
  }
}

/** `/rename <title>`: pin an explicit user title; automatic generation stops. */
export async function runRename(c: CommandCtx, arg: string): Promise<void> {
  const titleService = c.ctx.get('sessionTitle')
  const raw = arg.trim()
  if (raw === '') {
    const current = await currentSessionTitle(c)
    c.store.addPanel('会话重命名', [
      current !== undefined ? `当前标题：${current}` : '当前会话还没有标题',
      '',
      '用法：/rename <新标题>（重命名后自动生成标题停止，/sessions 列表按标题展示）',
    ])
    return
  }
  if (titleService === undefined) {
    c.store.addNotice('会话标题服务不可用（需要 dsh-base 提供 sessionTitle）', 'error')
    return
  }
  try {
    const snapshot = titleService.rename(c.agent().session, raw)
    c.store.addNotice(`会话已重命名：「${snapshot.title}」`)
  } catch (error) {
    c.store.addNotice(`重命名失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

export async function listSessionChoices(c: CommandCtx, query: string): Promise<void> {
  let records
  try {
    records = await c.ctx.sessionQuery.listSessions()
  } catch (error) {
    c.store.addNotice(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  // Forked sessions are listed too. /fork, /clear and /rewind all leave the
  // old log behind as the parent, so filtering children out would hide exactly
  // the history those commands exist to preserve. Subagent sessions are the
  // only ones nobody picks by hand.
  const visible = records.filter(record => record.header.origin !== 'subagent')
  // Titles fold once for the newest slice — the listing stays cheap even
  // with a large session corpus.
  const titleById = new Map<string, string>()
  try {
    const observations = await c.ctx.sessionQuery.readTitleSnapshots(visible.slice(0, 100).map(record => record.header.id))
    for (const observation of observations) {
      if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
        titleById.set(observation.sessionId, observation.value.title.title)
      }
    }
  } catch { /* titles are display-optional */ }
  const needle = query.trim().toLowerCase()
  const filtered = needle === ''
    ? visible
    : visible.filter(record => {
        const title = titleById.get(record.header.id) ?? ''
        const haystack = `${title} ${record.header.cwd ?? ''} ${record.header.id}`.toLowerCase()
        return haystack.includes(needle)
      })
  if (filtered.length === 0) {
    c.store.addNotice(needle === '' ? '没有可切换的会话' : `没有匹配「${query.trim()}」的会话`)
    return
  }
  // Duplicate labels (same minute + directory) would make the picker's
  // label→record lookup ambiguous; a counter suffix keeps them unique.
  // Bounded, not capped at the window: the question card scrolls.
  const seenLabels = new Map<string, number>()
  const choices = filtered.slice(0, 100).map(record => {
    const stamp = stampOf(record.header.createdAt)
    const dir = record.header.cwd !== undefined ? basename(record.header.cwd) : '?'
    const title = titleById.get(record.header.id)
    let label = `${title !== undefined ? `${truncateLine(title, 24)} · ` : ''}${stamp} · ${dir}${record.live ? ' · 运行中' : ''}${record.header.parentSession !== undefined ? ' · 分支' : ''}`
    const seen = seenLabels.get(label) ?? 0
    seenLabels.set(label, seen + 1)
    if (seen > 0) label = `${label} #${seen + 1}`
    return {
      label,
      description: record.header.id.slice(0, 21),
      id: record.header.id,
    }
  })
  const chosen = await pick(c, `选择要切换到的会话${needle !== '' ? `（过滤：${query.trim()}）` : ''}`, choices)
  const target = choices.find(choice => choice.label === chosen)
  if (target === undefined) return
  await c.switchSession(target.id)
}

/** `/resume [id|关键词]`: an unambiguous id switches straight there; anything
 * else falls through to the /sessions picker, which filters on the same text. */
export async function runResume(c: CommandCtx, query: string): Promise<void> {
  const needle = query.trim()
  if (needle === '') {
    await listSessionChoices(c, '')
    return
  }
  let records
  try {
    records = await c.ctx.sessionQuery.listSessions()
  } catch (error) {
    c.store.addNotice(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  const byId = records.filter(record => record.header.origin !== 'subagent'
    && (record.header.id === needle || record.header.id.startsWith(needle)))
  if (byId.length === 1 && byId[0] !== undefined) {
    await c.switchSession(byId[0].header.id)
    return
  }
  await listSessionChoices(c, needle)
}

/** `/new`: a blank session with no lineage. */
export async function runNew(c: CommandCtx): Promise<void> {
  const id = await c.startSession(undefined)
  if (id !== undefined) c.store.addNotice(`已开始新会话 ${id}`)
}

/** `/clear`: a blank session that keeps the current one as its parent, so the
 * cleared history stays one /tree away instead of being dropped. */
export async function runClear(c: CommandCtx): Promise<void> {
  const parent = c.agent().session.id
  const id = await c.startSession({ parentSession: parent, events: [] })
  if (id !== undefined) {
    c.store.addNotice(`已清空会话 ${id}：原内容保留在 ${parent}（/tree 看血缘，/sessions 可切回）`)
  }
}

/** `/fork`: copy the live session and move to the copy. */
export async function runFork(c: CommandCtx): Promise<void> {
  const agent = c.agent()
  // Own the array: `session.events` is a snapshot getter, and this outlives the
  // agent it came from.
  const events = [...agent.session.events]
  const check = isSeedable(events)
  if (!check.ok) {
    c.store.addNotice(`无法复制当前会话：${check.reason}（先按 Esc 中断，等这一轮落地再试）`, 'warn')
    return
  }
  const id = await c.startSession({ parentSession: agent.session.id, events })
  if (id !== undefined) c.store.addNotice(`已复制会话 → ${id}（${agent.session.id} 原样保留）`)
}

/** `/rewind`: drop one turn and everything after it, into a forked session. */
export async function runRewind(c: CommandCtx): Promise<void> {
  const agent = c.agent()
  const events = [...agent.session.events]
  const turns = userTurns(events)
  if (turns.length === 0) {
    c.store.addNotice('当前会话还没有可回退的轮次')
    return
  }
  // Newest first: the usual reason to rewind is the last thing just said.
  const candidates = turns.slice(-REWIND_WINDOW).toReversed()
  const seenLabels = new Map<string, number>()
  const choices = candidates.map(turn => {
    const preview = truncateLine(turn.preview, 32)
    // Cutting before a compaction replace revives the history it folded away,
    // which is allowed but can put the context back over the window.
    const caveat = dropsCompaction(events, turn.seq - 1) ? ' · 会撤销一次压缩' : ''
    let label = `${stampOf(turn.time)} · ${preview}${caveat}`
    const seen = seenLabels.get(label) ?? 0
    seenLabels.set(label, seen + 1)
    if (seen > 0) label = `${label} #${seen + 1}`
    return { label, turn }
  })
  const chosen = await pick(c, '回退到哪一轮之前（该轮及之后的全部丢弃）', choices)
  const target = choices.find(choice => choice.label === chosen)
  if (target === undefined) return
  const seed = sliceThrough(events, target.turn.seq - 1)
  const check = isSeedable(seed)
  if (!check.ok) {
    c.store.addNotice(`无法回退到该处：${check.reason}`, 'warn')
    return
  }
  const dropped = turns.filter(turn => turn.seq >= target.turn.seq).length
  const id = await c.startSession({ parentSession: agent.session.id, events: seed })
  if (id !== undefined) {
    c.store.addNotice(`已回退 ${dropped} 轮 → ${id}（${agent.session.id} 原样保留）`)
  }
}

/** `M-D HH:mm` — the shape every session listing and rewind label uses. */
function stampOf(time: number): string {
  const at = new Date(time)
  return `${at.getMonth() + 1}-${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
