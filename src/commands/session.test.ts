import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  currentSessionTitle, listSessionChoices, runClear, runFork, runNew, runResume, runRewind, runRename,
} from './session.js'
import { answerPick, awaitCard, cleanupTempHomes, makeCtx, sessionEvent, skipPick } from './test-helpers.js'

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

  it('hides subagent sessions but keeps forked ones reachable', async () => {
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

    // /fork, /clear and /rewind all leave the old log behind as the parent, so
    // hiding children would hide the history those commands preserve.
    const options = card.item.options ?? []
    expect(options.length).toBe(2)
    expect(options[0]?.description).toContain('sess-parent')
    expect(options[1]?.label).toContain('分支')
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

/** One closed turn: user text in, nothing else. */
function turn(seq: number, text: string): ReturnType<typeof sessionEvent>[] {
  return [
    sessionEvent('turn/start', { turn: 1 }, seq),
    sessionEvent('user/message', { turn: 1, content: [{ type: 'text', text }], source: { kind: 'user' } }, seq + 1),
    sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, seq + 2),
  ]
}

describe('runNew', () => {
  it('starts a session with no lineage at all', async () => {
    const { c, log } = makeCtx()
    await runNew(c)

    expect(log.started).toEqual([undefined])
    expect(log.notices[0]).toContain('s-new')
  })

  it('stays silent when the runner reports a failure', async () => {
    const { c, log } = makeCtx({ startSession: async () => undefined })
    await runNew(c)

    expect(log.notices).toEqual([])
  })
})

describe('runClear', () => {
  it('keeps the current session as the parent but replays nothing', async () => {
    const { c, log } = makeCtx({}, { events: turn(0, 'hi') })
    await runClear(c)

    expect(log.started[0]?.parentSession).toBe('s1')
    expect(log.started[0]?.events).toEqual([])
    expect(log.notices[0]).toContain('s1')
  })
})

describe('runFork', () => {
  it('carries the whole log over and names the current session as parent', async () => {
    const events = [...turn(0, '第一轮'), ...turn(3, '第二轮')]
    const { c, log } = makeCtx({}, { events })
    await runFork(c)

    expect(log.started[0]?.parentSession).toBe('s1')
    expect(log.started[0]?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('refuses to copy a log whose last turn never closed', async () => {
    const events = [sessionEvent('turn/start', { turn: 1 }, 0)]
    const { c, log } = makeCtx({}, { events })
    await runFork(c)

    expect(log.started).toEqual([])
    expect(log.notices[0]).toContain('无法复制')
  })
})

describe('runRewind', () => {
  it('offers one target per user turn, newest first', async () => {
    const events = [...turn(0, '第一轮'), ...turn(3, '第二轮')]
    const { c, store } = makeCtx({}, { events })
    const pending = runRewind(c)
    const card = await awaitCard(store)
    await skipPick(store)
    await pending

    expect(card.item.options?.length).toBe(2)
    expect(card.item.options?.[0]?.label).toContain('第二轮')
  })

  it('drops the chosen turn and everything after it', async () => {
    const events = [...turn(0, '第一轮'), ...turn(3, '第二轮')]
    const { c, store, log } = makeCtx({}, { events })
    const pending = runRewind(c)
    const card = await awaitCard(store)
    // Newest first, so the first option rewinds to just before the second turn.
    await answerPick(store, card.item.options?.[0]?.label ?? '')
    await pending

    expect(log.started[0]?.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(log.notices[0]).toContain('已回退 1 轮')
  })

  it('starts nothing when the picker is dismissed', async () => {
    const { c, store, log } = makeCtx({}, { events: turn(0, 'hi') })
    const pending = runRewind(c)
    await awaitCard(store)
    await skipPick(store)
    await pending

    expect(log.started).toEqual([])
  })

  it('says so when the turn is empty', async () => {
    const { c, log } = makeCtx()
    await runRewind(c)

    expect(log.notices[0]).toContain('还没有可回退')
  })

  it('warns when the cut would undo a compaction', async () => {
    const compacted = sessionEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '压缩摘要' }] },
    }, 3)
    Object.assign(compacted, { surfaceOp: { op: 'replace', start: 0, end: 2 } })
    const events = [...turn(0, '第一轮'), compacted]
    const { c, store } = makeCtx({}, { events })
    const pending = runRewind(c)
    const card = await awaitCard(store)
    await skipPick(store)
    await pending

    expect(card.item.options?.[0]?.label).toContain('压缩')
  })
})

describe('runResume', () => {
  it('switches straight to an unambiguous id', async () => {
    const { c, log } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa'), record('sess-bbb')]) })
    await runResume(c, 'sess-bbb')

    expect(log.switched).toEqual(['sess-bbb'])
  })

  it('reports no match when the text is neither an id nor a keyword hit', async () => {
    const { c, log } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa')]) })
    await runResume(c, 'zzz')

    expect(log.switched).toEqual([])
    expect(log.notices[0]).toContain('没有匹配')
  })

  it('opens the picker when given no argument at all', async () => {
    const { c, store } = makeCtx({ ctx: ctxWithSessions([record('sess-aaa')]) })
    const pending = runResume(c, '')
    const card = await awaitCard(store)
    await skipPick(store)
    await pending

    expect(card.item.options?.length).toBe(1)
  })
})
