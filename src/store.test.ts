import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
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

describe('TuiStore pending-output tray', () => {
  const OUTPUT = (command: string) => ({
    command,
    text: `用户在本地终端手动执行了命令：\n$ ${command}\n✓ 退出 0\n\nout-of-${command}`,
    summary: `$ ${command} · 退出 0 · 12 字符`,
  })

  it('add/consume round-trips the tray and updates the snapshot', () => {
    const store = new TuiStore('s1', 'model')
    store.addPendingOutput(OUTPUT('npm test'))
    expect(store.getSnapshot().pendingOutputs).toHaveLength(1)

    const consumed = store.consumePendingOutputs()
    expect(consumed).toHaveLength(1)
    expect(consumed[0]!.command).toBe('npm test')
    expect(store.getSnapshot().pendingOutputs).toEqual([])
  })

  it('removeLastStashed retracts in real stash order across both trays', () => {
    const store = new TuiStore('s1', 'model')
    const ref = { id: 'img-1' } as never
    store.addPendingImage(ref, 'a.png')
    store.addPendingOutput(OUTPUT('ls'))
    store.addPendingImage({ id: 'img-2' } as never, 'b.png')

    // newest first: b.png → ls → a.png
    expect(store.removeLastStashed()).toEqual({ kind: 'image', label: 'b.png' })
    expect(store.removeLastStashed()).toEqual({ kind: 'output', command: 'ls' })
    expect(store.removeLastStashed()).toEqual({ kind: 'image', label: 'a.png' })
    expect(store.removeLastStashed()).toBeUndefined()
    expect(store.getSnapshot().pendingImages).toEqual([])
    expect(store.getSnapshot().pendingOutputs).toEqual([])
  })

  it('clearStash empties both trays and reports the count', () => {
    const store = new TuiStore('s1', 'model')
    store.addPendingImage({ id: 'img-1' } as never, 'a.png')
    store.addPendingOutput(OUTPUT('ls'))
    expect(store.clearStash()).toBe(2)
    expect(store.clearStash()).toBe(0)
  })

  it('consuming images leaves outputs untouched and vice versa', () => {
    const store = new TuiStore('s1', 'model')
    store.addPendingImage({ id: 'img-1' } as never, 'a.png')
    store.addPendingOutput(OUTPUT('ls'))
    expect(store.consumePendingImages()).toHaveLength(1)
    expect(store.getSnapshot().pendingOutputs).toHaveLength(1)
    expect(store.consumePendingOutputs()).toHaveLength(1)
  })

  it('reset() clears the output tray', () => {
    const store = new TuiStore('s1', 'model')
    store.addPendingOutput(OUTPUT('ls'))
    store.reset('s2', 'model', [])
    expect(store.getSnapshot().pendingOutputs).toEqual([])
  })
})

describe('TuiStore echoUser with ride-along trays', () => {
  it('idle echo renders 🧾 output labels on the user item', () => {
    const store = new TuiStore('s1', 'model')
    store.echoUser('m1', '修复失败的测试', { outputs: ['$ npm test · 退出 1 · 2.1k 字符'] })

    const item = store.getSnapshot().items.at(-1)
    expect(item).toMatchObject({ kind: 'user', text: '修复失败的测试', outputs: ['$ npm test · 退出 1 · 2.1k 字符'] })
  })

  it('busy echo queues with outputs and promotes them on the session event', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.echoUser('m9', '继续', { outputs: ['$ ls · 退出 0 · 5 字符'], mode: 'steer' })
    expect(store.getSnapshot().queuedMessages[0]).toMatchObject({ text: '继续', outputs: ['$ ls · 退出 0 · 5 字符'], mode: 'steer' })

    store.onEvent(ev('user/message', { id: 'm9', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, 50))
    const item = store.getSnapshot().items.at(-1)
    expect(item).toMatchObject({ kind: 'user', text: '继续', outputs: ['$ ls · 退出 0 · 5 字符'] })
    expect(store.getSnapshot().queuedMessages).toEqual([])
  })
})


// -- Thinking（Ctrl+T）---------------------------------------------------------

const reasoningChunk = (text: string, time: number): AssistantStreamFrame =>
  ({ type: 'chunk', time, chunk: { type: 'reasoning-delta', index: 0, text } } as unknown as AssistantStreamFrame)

/** assistant/message settles the step: the thinking record lands first, the
 * visible reply last — assertions address them as at(-2) / at(-1). */
const settleStep = (store: TuiStore, time = 2): void => {
  store.onEvent(ev('assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] }, interrupted: false }, time))
}

/** A committing no-op event: onAssistantStreamFrame never commits, so the
 * snapshot only reflects reasoning state after some event lands. */
const commitTick = (store: TuiStore): void => {
  store.onEvent(ev('request/context', {}, 999))
}

describe('TuiStore thinking settle (collapsed default)', () => {
  it('settles the one-line summary notice before the reply', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('第一行思考\n第二行思考', 10))
    store.onAssistantStreamFrame(reasoningChunk('收尾', 60))
    settleStep(store, 110)

    expect(store.getSnapshot().items.at(-2)).toMatchObject({ kind: 'notice', text: '✻ 思考：第一行思考 · 50ms' })
    expect(store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'assistant' })
  })

  it('flushes reasoning progress so the live tail and char count tick', async () => {
    const store = new TuiStore('s1', 'model')
    store.start()
    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('思考中', 10))
    // The flush interval runs on a real timer; poll briefly instead of
    // importing fake timers for one assertion.
    const deadline = Date.now() + 2000
    while (store.getSnapshot().reasoningChars === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    store.dispose()
    expect(store.getSnapshot().reasoningChars).toBeGreaterThan(0)
  })
})

describe('TuiStore thinking expanded (Ctrl+T)', () => {
  it('expands: settle emits an inline thinking block, capped at 40 lines', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.toggleThinking() // expand before any reasoning exists → notice, no content
    expect(store.getSnapshot().thinkingExpanded).toBe(true)

    store.onAssistantStreamFrame(reasoningChunk(Array.from({ length: 45 }, (_, i) => `行${i}`).join('\n'), 10))
    store.onAssistantStreamFrame(reasoningChunk('收尾', 60))
    settleStep(store, 110)

    const item = store.getSnapshot().items.at(-2)
    expect(item?.kind).toBe('thinking')
    const thinking = item as Extract<NonNullable<typeof item>, { kind: 'thinking' }>
    expect(thinking.text.split('\n')).toHaveLength(40)
    expect(thinking.text).toContain('行0')
    expect(thinking.chars).toBeGreaterThan(0)
    expect(thinking.durationMs).toBe(50)
    expect(thinking.truncated).toBe(true)
  })

  it('collapses silently: no extra notice, next settle is a one-line notice again', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('想想', 10))
    settleStep(store)

    const before = store.getSnapshot().items.length
    expect(store.toggleThinking()).toBe(true)
    expect(store.getSnapshot().items.length).toBe(before + 1) // the full-text panel
    expect(store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'panel' })
    expect(store.toggleThinking()).toBe(false)
    expect(store.getSnapshot().items.length).toBe(before + 1) // silent collapse

    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('再想想', 10))
    settleStep(store)
    expect(store.getSnapshot().items.at(-2)).toMatchObject({ kind: 'notice' })
    expect(store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'assistant' })
  })

  it('idle expand prints the last settled reasoning as a full-text panel', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('第一步的思考', 10))
    settleStep(store)
    store.onEvent(TURN_END)

    store.toggleThinking()
    const panel = store.getSnapshot().items.at(-1)
    expect(panel).toMatchObject({ kind: 'panel' })
    expect(panel?.kind === 'panel' && panel.lines[0]).toBe('第一步的思考')
    expect(panel?.kind === 'panel' && panel.title).toContain('思考全文')
  })

  it('idle expand with no recorded reasoning announces the gap', () => {
    const store = new TuiStore('s1', 'model')
    store.toggleThinking()
    expect(store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'notice' })
  })
})

describe('TuiStore thinking cap and replay', () => {
  it('caps the retained text at 100k chars while the count keeps rising', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(TURN_START)
    store.onAssistantStreamFrame(reasoningChunk('a'.repeat(60_000), 10))
    store.onAssistantStreamFrame(reasoningChunk('b'.repeat(60_000), 20))
    commitTick(store)

    expect(store.getSnapshot().reasoningText).toHaveLength(100_000)
    expect(store.getSnapshot().reasoningChars).toBe(120_000)
  })

  it('replays reasoning blocks from the persisted message (no duration)', () => {
    const store = new TuiStore('s1', 'model')
    store.replay([
      ev('assistant/message', {
        message: { content: [{ type: 'reasoning', text: '回想一下…\n再想想' }, { type: 'text', text: '答案' }] },
        interrupted: false,
      }, 2),
    ])
    store.finishReplay()

    expect(store.getSnapshot().items.at(-2)).toMatchObject({ kind: 'notice', text: '✻ 思考：回想一下… · 0ms' })
    expect(store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'assistant' })
    expect(store.getSnapshot().items.map(entry => entry.kind)).not.toContain('thinking')
  })

  it('expanded mode settles replayed reasoning blocks inline too', () => {
    const resumed = new TuiStore('s2', 'model')
    resumed.toggleThinking()
    resumed.replay([
      ev('assistant/message', {
        message: { content: [{ type: 'reasoning', text: '回放的思考' }, { type: 'text', text: '答案' }] },
        interrupted: false,
      }, 2),
    ])
    resumed.finishReplay()

    expect(resumed.getSnapshot().items.at(-2)).toMatchObject({
      kind: 'thinking', text: '回放的思考', durationMs: 0, truncated: false,
    })
  })
})

describe('TuiStore tool detail panel (Ctrl+O)', () => {
  const terminalPresenter = {
    presentCall: () => undefined,
    presentResult: () => ({ card: 'terminal', title: 'echo hi', output: 'out1\nout2', exitCode: 0 }) as const,
  }

  const runTerminalCard = (presenter: typeof terminalPresenter): TuiStore => {
    const store = new TuiStore('s1', 'model', presenter)
    store.onEvent(ev('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' }, 1))
    store.onEvent(ev('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }] },
    }, 2))
    return store
  }

  it('leads the panel with the full command, then a blank line, then the output', () => {
    const store = runTerminalCard(terminalPresenter)
    store.toggleVerboseToolDetail()

    const panel = store.getSnapshot().items.at(-1)
    expect(panel?.kind).toBe('panel')
    expect(panel?.kind === 'panel' && panel.lines.slice(0, 3)).toEqual(['echo hi', '', 'out1'])
    expect(panel?.kind === 'panel' && panel.title).toBe('工具详情 · echo hi')
  })

  it('non-terminal cards keep output-only panels', () => {
    const store = new TuiStore('s1', 'model')
    store.onEvent(ev('tool/call', { callId: 'c2', name: 'web_fetch', arguments: '{}' }, 1))
    store.onEvent(ev('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'body' }] }] },
    }, 2))
    store.toggleVerboseToolDetail()

    const panel = store.getSnapshot().items.at(-1)
    expect(panel?.kind === 'panel' && panel.lines[0]).toBe('body')
  })
})
