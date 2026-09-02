import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { runTrace, runTree } from './trace.js'
import { cleanupTempHomes, makeCtx, sessionEvent } from './test-helpers.js'

afterEach(cleanupTempHomes)

const CREATED = Date.UTC(2026, 0, 2, 3, 4)

interface RecordOptions {
  readonly cwd?: string
  readonly parent?: string
}

function session(id: string, options: RecordOptions = {}): unknown {
  return {
    header: {
      id,
      cwd: options.cwd ?? '/tmp/work',
      createdAt: CREATED,
      ...(options.parent !== undefined ? { parentSession: options.parent } : {}),
    },
    live: false,
    persisted: true,
  }
}

function traced(parts: {
  readonly target: unknown
  readonly ancestors: readonly unknown[]
  readonly descendants: readonly unknown[]
  readonly complete?: boolean
  readonly unresolvedParentId?: string
}): Context {
  return {
    sessionQuery: {
      traceSession: async () => ({
        target: parts.target,
        ancestors: parts.ancestors,
        descendants: parts.descendants,
        ...(parts.complete === false
          ? { complete: false, unresolvedParentId: parts.unresolvedParentId ?? 'sess-unknown' }
          : { complete: true, root: parts.ancestors.at(-1) ?? parts.target }),
      }),
      readTitleSnapshots: async (ids: readonly string[]) =>
        ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: `标题-${id}` } } })),
    },
  } as unknown as Context
}

describe('runTree', () => {
  it('indents the lineage and marks the live session', async () => {
    const ctx = traced({
      target: session('s1', { parent: 's0' }),
      ancestors: [session('s0')],
      descendants: [{ session: session('s2', { parent: 's1' }), descendants: [] }],
    })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    const panel = log.panels[0]
    expect(panel?.title).toBe('会话家族树')
    expect(panel?.lines[0]).toBe('标题-s0 · 1-2 11:04 · work · s0')
    expect(panel?.lines[1]).toContain('* ')
    expect(panel?.lines[1]).toContain('标题-s1')
    // Two levels deep: the ancestor sits at depth 0, the live session at 1.
    expect(panel?.lines[2]).toMatch(/^ {4}标题-s2/)
  })

  it('admits the chain leaves the visible corpus', async () => {
    const ctx = traced({
      target: session('s1', { parent: 's0' }),
      ancestors: [session('s0')],
      descendants: [],
      complete: false,
      unresolvedParentId: 'sess-missing',
    })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.panels[0]?.lines[0]).toContain('sess-missing')
  })

  it('reports a failed lineage read instead of an empty tree', async () => {
    const ctx = {
      sessionQuery: { traceSession: async () => { throw new Error('no corpus') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.notices[0]).toContain('no corpus')
    expect(log.panels).toEqual([])
  })

  it('says when the lineage is longer than it rendered', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      session: session(`s${index}`, { parent: 's1' }),
      descendants: [],
    }))
    const ctx = traced({ target: session('s1'), ancestors: [], descendants: many })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.panels[0]?.lines.join('\n')).toContain('只显示前 40 个')
  })
})

describe('runTrace', () => {
  it('reports an empty session rather than an empty panel', () => {
    const { c, log } = makeCtx()

    runTrace(c)

    expect(log.notices[0]).toContain('还没有任何事件')
  })

  it('collapses a run of streaming chunks into one line', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }, 0),
      sessionEvent('assistant/chunk', { turn: 1, step: 1, delta: 'a' }, 1),
      sessionEvent('assistant/chunk', { turn: 1, step: 1, delta: 'b' }, 2),
      sessionEvent('assistant/chunk', { turn: 1, step: 1, delta: 'c' }, 3),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
    ]
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const lines = log.panels[0]?.lines ?? []
    expect(lines).toContain('#1 · +1.0s · 流式输出 3 块')
    // Four events, three of which fold into one line.
    expect(lines[0]).toContain('共 3 条记录')
  })

  it('labels the events a reader actually cares about', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }, 0),
      sessionEvent('user/message', { turn: 1, content: [{ type: 'text', text: '读一下这个文件' }], source: { kind: 'user' } }, 1),
      sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }, 2),
      sessionEvent('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } }, 3),
      sessionEvent('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] }, error: { name: 'E', code: 'EACCES' } }, 4),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('轮次 1 开始')
    expect(body).toContain('用户：读一下这个文件')
    expect(body).toContain('工具调用 read（a.ts）')
    expect(body).toContain('工具结果 完成')
    expect(body).toContain('工具结果 失败 EACCES')
    expect(body).toContain('轮次 1 结束（completed）')
  })

  it('windows the tail and says how much it dropped', () => {
    const events = Array.from({ length: 80 }, (_, seq) => sessionEvent('todo/write', { todos: [] }, seq))
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const lines = log.panels[0]?.lines ?? []
    expect(lines[0]).toContain('共 80 条记录，显示最后 60 条')
    expect(lines.at(-1)).toContain('#79')
  })
})
