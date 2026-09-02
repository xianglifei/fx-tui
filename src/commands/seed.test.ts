import { describe, expect, it } from 'vitest'
import { dropsCompaction, isSeedable, sliceThrough, userTurns } from './seed.js'
import { sessionEvent } from './test-helpers.js'

const turnStart = (seq: number, turn = 1): ReturnType<typeof sessionEvent> =>
  sessionEvent('turn/start', { turn }, seq)
const turnEnd = (seq: number, turn = 1): ReturnType<typeof sessionEvent> =>
  sessionEvent('turn/end', { turn, reason: { kind: 'completed' } }, seq)
const stepStart = (seq: number): ReturnType<typeof sessionEvent> =>
  sessionEvent('step/start', { turn: 1, step: 1 }, seq)
const stepEnd = (seq: number): ReturnType<typeof sessionEvent> =>
  sessionEvent('step/end', { turn: 1, step: 1 }, seq)
const toolCall = (seq: number, callId: string): ReturnType<typeof sessionEvent> =>
  sessionEvent('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' }, seq)
const toolResult = (seq: number, callId: string): ReturnType<typeof sessionEvent> =>
  sessionEvent('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] },
  }, seq)
const userMessage = (seq: number, text: string): ReturnType<typeof sessionEvent> =>
  sessionEvent('user/message', { turn: 1, content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)

describe('isSeedable', () => {
  it('accepts a fully closed log', () => {
    const events = [turnStart(0), stepStart(1), toolCall(2, 'a'), toolResult(3, 'a'), stepEnd(4), turnEnd(5)]

    expect(isSeedable(events)).toEqual({ ok: true })
  })

  it('accepts a turn that closed with no step at all', () => {
    expect(isSeedable([turnStart(0), turnEnd(1)])).toEqual({ ok: true })
  })

  it('rejects a log whose last turn never closed', () => {
    const check = isSeedable([turnStart(0), stepStart(1), stepEnd(2)])

    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('轮')
  })

  it('rejects a log whose last step never closed', () => {
    const check = isSeedable([turnStart(0), stepStart(1), turnEnd(2)])

    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('步骤')
  })

  it('rejects a dangling tool call, which is what an interrupted turn leaves behind', () => {
    const check = isSeedable([turnStart(0), stepStart(1), toolCall(2, 'a'), stepEnd(3), turnEnd(4)])

    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('工具')
  })

  it('pairs parallel tool results by callId rather than by order', () => {
    const events = [
      turnStart(0), stepStart(1),
      toolCall(2, 'a'), toolCall(3, 'b'),
      toolResult(4, 'b'), toolResult(5, 'a'),
      stepEnd(6), turnEnd(7),
    ]

    expect(isSeedable(events)).toEqual({ ok: true })
  })

  it('rejects a result whose callId was never opened', () => {
    const check = isSeedable([turnStart(0), toolResult(1, 'ghost'), turnEnd(2)])

    expect(check.ok).toBe(false)
  })

  it('ignores event types it does not know about', () => {
    const events = [
      turnStart(0),
      sessionEvent('approval/request', { callId: 'a' }, 1),
      sessionEvent('todo/write', { todos: [] }, 2),
      turnEnd(3),
    ]

    expect(isSeedable(events)).toEqual({ ok: true })
  })

  it('accepts an empty log', () => {
    expect(isSeedable([])).toEqual({ ok: true })
  })
})

describe('sliceThrough', () => {
  it('keeps events up to the boundary inclusive', () => {
    const events = [turnStart(0), stepStart(1), stepEnd(2), turnEnd(3)]

    expect(sliceThrough(events, 2).map(event => event.seq)).toEqual([0, 1, 2])
  })

  it('returns an empty prefix for a boundary before the first event', () => {
    expect(sliceThrough([turnStart(0), turnEnd(1)], -1)).toEqual([])
  })
})

describe('userTurns', () => {
  it('lists every closed turn carrying user text, oldest first', () => {
    const events = [
      turnStart(0), userMessage(1, '第一轮\n第二行'), turnEnd(2),
      turnStart(3), userMessage(4, '第二轮'), turnEnd(5),
    ]

    const turns = userTurns(events)

    expect(turns.map(turn => turn.seq)).toEqual([0, 3])
    expect(turns[0]?.preview).toBe('第一轮')
    expect(turns[1]?.preview).toBe('第二轮')
  })

  it('skips turns with no user text, which nothing would recognize', () => {
    const events = [turnStart(0), sessionEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '自动' }] } }, 1), turnEnd(2)]

    expect(userTurns(events)).toEqual([])
  })

  it('ignores messages the model or a tool injected rather than the user', () => {
    const events = [turnStart(0), sessionEvent('user/message', { turn: 1, content: [{ type: 'text', text: '注入' }], source: { kind: 'tool' } }, 1), turnEnd(2)]

    expect(userTurns(events)).toEqual([])
  })
})

describe('dropsCompaction', () => {
  it('is false when the discarded tail holds no replace', () => {
    const events = [userMessage(0, 'hi', ), turnEnd(1)]

    expect(dropsCompaction(events, 1)).toBe(false)
  })

  it('is true when truncating discards a compaction replace', () => {
    const compacted = sessionEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '压缩摘要' }] },
    }, 2)
    Object.assign(compacted, { surfaceOp: { op: 'replace', start: 0, end: 1 } })

    expect(dropsCompaction([userMessage(0, 'hi'), turnEnd(1), compacted], 1)).toBe(true)
  })

  it('is false once the boundary is past the replace', () => {
    const compacted = sessionEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '压缩摘要' }] },
    }, 1)
    Object.assign(compacted, { surfaceOp: { op: 'replace', start: 0, end: 0 } })

    expect(dropsCompaction([userMessage(0, 'hi'), compacted], 1)).toBe(false)
  })
})
