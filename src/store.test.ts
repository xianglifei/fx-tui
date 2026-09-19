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

describe('TuiStore llm retry events', () => {
  const RETRY = (attempt: number): SessionEvent =>
    ev('llm/retry', {
      retryId: 'r1', turn: 1, step: 1, provider: 'p', mode: 'normal',
      policyKey: 'default', retry: attempt, maxRetries: 5, delayMs: 8000,
      failure: { message: 'Request timed out', code: 'timeout', status: 504 },
    }, 10 + attempt)

  const RETRY_STARTED = ev('llm/retry-started', { retryId: 'r1', turn: 1, step: 1, retry: 1 }, 20)

  it('a live retry surfaces a notice and the transient wait state', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onEvent(RETRY(2))

    const snapshot = store.getSnapshot()
    expect(snapshot.retryWait).toEqual({ attempt: 2, maxRetries: 5, delayMs: 8000, reason: 'timeout' })
    expect(snapshot.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'warn' })
    expect((snapshot.items.at(-1) as { text: string }).text).toContain('第 2/5 次重试')
  })

  it('retry-started clears the wait while the notice history remains', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onEvent(RETRY(1))
    store.onEvent(RETRY_STARTED)

    expect(store.getSnapshot().retryWait).toBeNull()
    expect(store.getSnapshot().items.some(item => item.kind === 'notice')).toBe(true)
  })

  it('the unbounded (always) policy omits maxRetries', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onEvent(ev('llm/retry', {
      retryId: 'r1', turn: 1, step: 1, provider: 'p', mode: 'always',
      policyKey: 'default', retry: 3, delayMs: 1000,
      failure: { message: '429', code: 'rate-limit' },
    }, 11))

    expect(store.getSnapshot().retryWait).toEqual({
      attempt: 3, maxRetries: null, delayMs: 1000, reason: 'rate-limit',
    })
  })

  it('turn boundaries and reset clear the wait', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onEvent(RETRY(1))
    store.onEvent(TURN_END)
    expect(store.getSnapshot().retryWait).toBeNull()

    store.onEvent(RETRY(1))
    store.reset('s2', 'model', [])
    expect(store.getSnapshot().retryWait).toBeNull()
  })

  it('replay leaves no retry notices and no stale wait', () => {
    const store = new TuiStore('s1', 'model')
    store.replay([TURN_START, RETRY(1), RETRY_STARTED, TURN_END])
    store.finishReplay()

    const snapshot = store.getSnapshot()
    expect(snapshot.retryWait).toBeNull()
    expect(snapshot.items.filter(item => item.kind === 'notice')).toEqual([])
  })
})

