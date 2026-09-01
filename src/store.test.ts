import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TuiStore } from './store.js'

const ev = (type: string, data: unknown, time: number): SessionEvent =>
  ({ type, data, time } as unknown as SessionEvent)

const TURN_START = ev('turn/start', {}, 0)
const USER_MSG = ev('user/message', { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, 1)
const ASSISTANT_MSG = ev('assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] }, interrupted: false }, 2)
const TURN_END = ev('turn/end', { reason: { kind: 'completed' } }, 3)

const LOG = [TURN_START, USER_MSG, ASSISTANT_MSG, TURN_END]

describe('TuiStore replay batching', () => {
  it('replay commits nothing on its own; finishReplay commits exactly once', () => {
    const store = new TuiStore('s1', 'model')
    let commits = 0
    const unsubscribe = store.subscribe(() => { commits += 1 })

    store.replay(LOG)
    expect(commits).toBe(0)

    store.finishReplay()
    expect(commits).toBe(1)
    expect(store.getSnapshot().items.map(item => item.kind)).toEqual(['user', 'assistant'])

    unsubscribe()
  })

  it('live events still commit immediately after a replay', () => {
    const store = new TuiStore('s1', 'model')
    store.replay(LOG)
    store.finishReplay()

    let commits = 0
    const unsubscribe = store.subscribe(() => { commits += 1 })
    store.onEvent(ev('turn/start', {}, 10))
    expect(commits).toBe(1)

    unsubscribe()
  })

  it('reset() folds a persisted log with a single trailing commit', () => {
    const store = new TuiStore('s1', 'model')
    store.replay(LOG)
    store.finishReplay()

    let commits = 0
    const unsubscribe = store.subscribe(() => { commits += 1 })
    store.reset('s2', 'model', [USER_MSG, ASSISTANT_MSG])
    expect(commits).toBe(1)
    expect(store.getSnapshot().items.map(item => item.kind)).toEqual(['user', 'assistant'])

    unsubscribe()
  })

  it('reset() fail-closes a pending approval and question waterfall', async () => {
    const store = new TuiStore('s1', 'model')
    const approval = store.askApproval({ toolName: 'bash', reason: '' })
    const question = store.askQuestions([{ id: 'q', question: 'Q', options: [{ label: 'x' }] }])

    store.reset('s2', 'model', [])

    expect(await approval).toBe('reject')
    expect(await question).toEqual({ answers: [] })
  })

  it('dispose() fail-closes a pending approval waterfall', async () => {
    const store = new TuiStore('s1', 'model')
    const approval = store.askApproval({ toolName: 'bash', reason: '' })

    store.dispose()

    expect(await approval).toBe('reject')
  })
})
