/** Session commands: /sessions (keyword-filtered picker) and /rename. */

import { basename } from 'node:path'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'
import { pick } from './pick.js'

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
  const parents = records.filter(record => !record.header.parentSession && record.header.origin !== 'subagent')
  // Titles fold once for the newest slice — the listing stays cheap even
  // with a large session corpus.
  const titleById = new Map<string, string>()
  try {
    const observations = await c.ctx.sessionQuery.readTitleSnapshots(parents.slice(0, 100).map(record => record.header.id))
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
    c.store.addNotice(needle === '' ? '没有可切换的会话' : `没有匹配「${query.trim()}」的会话`)
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
  const chosen = await pick(c, `选择要切换到的会话${needle !== '' ? `（过滤：${query.trim()}）` : ''}`, choices)
  const target = choices.find(choice => choice.label === chosen)
  if (target === undefined) return
  await c.switchSession(target.id)
}
