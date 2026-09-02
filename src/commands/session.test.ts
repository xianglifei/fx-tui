import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { currentSessionTitle, listSessionChoices, runRename } from './session.js'
import { answerPick, awaitCard, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

afterEach(cleanupTempHomes)

interface RecordOptions {
  readonly cwd?: string
  readonly live?: boolean
  readonly parent?: string
  readonly origin?: string
}

const CREATED = Date.UTC(2026, 0, 2, 3, 4)

function record(id: string, options: RecordOptions = {}): unknown {
  return {
    header: {
      id,
      cwd: options.cwd ?? '/tmp/work',
      createdAt: CREATED,
      ...(options.parent !== undefined ? { parentSession: options.parent } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    },
    live: options.live ?? false,
  }
}

function settledTitle(sessionId: string, title: string): unknown {
  return { status: 'fulfilled', sessionId, value: { sessionId, title: { title } } }
}

function ctxWithSessions(records: readonly unknown[], titles: readonly unknown[] = []): Context {
  return {
    sessionQuery: {
      listSessions: async () => records,
      readTitleSnapshots: async () => titles,
      readTitle: async () => undefined,
    },
  } as unknown as Context
}

describe('listSessionChoices filtering', () => {
  it('reports an empty corpus instead of opening a picker', async () => {
    const { c, log } = makeCtx({ ctx: ctxWithSessions([]) })
    await listSessionChoices(c, '')

    expect(log.notices[0]).toBe('没有可切换的会话')
  })

  it('matches a keyword against the title, the cwd or the session id', async () => {
    const records = [
      record('sess-aaa', { cwd: '/tmp/work' }),
      record('sess-bbb', { cwd: '/tmp/other' }),
    ]
    const titles = [settledTitle('sess-aaa', '重构会话')]

    const byTitle = makeCtx({ ctx: ctxWithSessions(records, titles) })
    const titlePicker = listSessionChoices(byTitle.c, '重构')
    expect((await awaitCard(byTitle.store)).item.options?.length).toBe(1)
    await skipPick(byTitle.store)
    await titlePicker

    const byCwd = makeCtx({ ctx: ctxWithSessions(records, titles) })
    const cwdPicker = listSessionChoices(byCwd.c, '/tmp/other')
    const cwdCard = await awaitCard(byCwd.store)
    expect(cwdCard.item.options?.[0]?.description).toContain('sess-bbb')
    await skipPick(byCwd.store)
    await cwdPicker

    const byId = makeCtx({ ctx: ctxWithSessions(records, titles) })
    const idPicker = listSessionChoices(byId.c, 'sess-aaa')
    expect((await awaitCard(byId.store)).item.options?.length).toBe(1)
    await skipPick(byId.store)
    await idPicker
  })

  it('reports no match when nothing satisfies the keyword', async () => {
    const { c, log } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa')]) })
    await listSessionChoices(c, '不存在的标题')

    expect(log.notices[0]).toContain('没有匹配')
  })

  it('hides subagent and child sessions from the switcher', async () => {
    const ctx = ctxWithSessions([
      record('sess-parent'),
      record('sess-child', { parent: 'sess-parent' }),
      record('sess-sub', { origin: 'subagent' }),
    ])
    const { c, store } = makeCtx({ ctx })
    const pending = listSessionChoices(c, '')
    const card = await awaitCard(store)
    await skipPick(store)
    await pending

    expect(card.item.options?.length).toBe(1)
    expect(card.item.options?.[0]?.description).toContain('sess-parent')
  })

  it('disambiguates identical labels with a counter suffix', async () => {
    const { c, store } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa'), record('sess-bbb')]) })
    const pending = listSessionChoices(c, '')
    const card = await awaitCard(store)
    await skipPick(store)
    await pending

    const labels = (card.item.options ?? []).map(option => option.label)
    expect(labels.length).toBe(2)
    expect(labels[1]).toContain('#2')
  })

  it('switches to the chosen session', async () => {
    const { c, store, log } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa', { live: true })]) })
    const pending = listSessionChoices(c, '')
    const card = await awaitCard(store)
    await answerPick(store, card.item.options?.[0]?.label ?? '')
    await pending

    expect(log.switched).toEqual(['sess-aaa'])
  })

  it('reports a listing failure instead of throwing', async () => {
    const ctx = {
      sessionQuery: { listSessions: async () => { throw new Error('storage down') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await listSessionChoices(c, '')

    expect(log.notices[0]).toContain('读取会话列表失败')
  })
})

describe('runRename', () => {
  it('shows the current title and the usage on the bare command', async () => {
    const { c, log } = makeCtx()
    await runRename(c, '')

    expect(log.panels[0]?.title).toBe('会话重命名')
    expect(log.panels[0]?.lines.join('\n')).toContain('用法：/rename')
  })

  it('reports a missing title service', async () => {
    const { c, log } = makeCtx()
    await runRename(c, '新标题')

    expect(log.notices[0]).toContain('会话标题服务不可用')
  })

  it('renames through the service and echoes the new title', async () => {
    const ctx = {
      get: (key: string) => (key === 'sessionTitle' ? { rename: () => ({ title: '新标题' }) } : undefined),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runRename(c, '新标题')

    expect(log.notices[0]).toContain('新标题')
  })

  it('surfaces a rename failure', async () => {
    const ctx = {
      get: () => ({ rename: () => { throw new Error('read-only store') } }),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runRename(c, '新标题')

    expect(log.notices[0]).toContain('重命名失败：read-only store')
  })
})

describe('currentSessionTitle', () => {
  it('degrades to undefined when the title query throws', async () => {
    const ctx = {
      sessionQuery: { readTitle: async () => { throw new Error('nope') } },
    } as unknown as Context
    const { c } = makeCtx({ ctx })

    await expect(currentSessionTitle(c)).resolves.toBeUndefined()
  })
})
