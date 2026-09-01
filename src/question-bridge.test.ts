import { describe, expect, it } from 'vitest'
import { QUESTION_WINDOW, QuestionBridge } from './question-bridge.js'

const hooks = { commit: () => {}, addNotice: () => {} }

const option = (label: string): { label: string } => ({ label })

describe('QuestionBridge', () => {
  it('walks the queue and resolves the collected answers', async () => {
    const bridge = new QuestionBridge(hooks)
    const pending = bridge.ask([
      { id: 'a', question: 'A', options: [option('x'), option('y')] },
      { id: 'b', question: 'B', options: [option('p')] },
    ])
    expect(bridge.current?.item.id).toBe('a')
    bridge.toggleOption('x')
    bridge.confirm()
    expect(bridge.current?.item.id).toBe('b')
    bridge.skip()
    expect(await pending).toEqual({
      answers: [
        { id: 'a', selected: ['x'] },
        { id: 'b', selected: [] },
      ],
    })
    expect(bridge.current).toBeNull()
  })

  it('the cursor slides the visible window when it leaves it', () => {
    const bridge = new QuestionBridge(hooks)
    void bridge.ask([{ id: 'a', question: 'Q', options: Array.from({ length: 12 }, (_, i) => option(`o${i}`)) }])
    bridge.moveCursor(1)
    expect(bridge.current?.cursor).toBe(1)
    expect(bridge.current?.scroll).toBe(0)
    bridge.pointCursor(QUESTION_WINDOW) // first index outside the window
    expect(bridge.current?.cursor).toBe(QUESTION_WINDOW)
    expect(bridge.current?.scroll).toBe(1)
  })

  it('confirm without a selection holds until a default applies', async () => {
    const bridge = new QuestionBridge(hooks)
    const pending = bridge.ask([{ id: 'a', question: 'Q', options: [option('批准'), option('修改')] }])
    bridge.confirm()
    expect(bridge.current?.item.id).toBe('a')
    bridge.confirm('批准')
    expect(await pending).toEqual({ answers: [{ id: 'a', selected: ['批准'] }] })
  })

  it('free-text answers ride as custom', async () => {
    const bridge = new QuestionBridge(hooks)
    const pending = bridge.ask([{ id: 'a', question: 'Q' }])
    bridge.submitFreeText('  好的  ')
    expect(await pending).toEqual({ answers: [{ id: 'a', selected: [], custom: '好的' }] })
  })

  it('cancel withdraws the whole waterfall with an empty answer set', async () => {
    const bridge = new QuestionBridge(hooks)
    const pending = bridge.ask([{ id: 'a', question: 'Q', options: [option('x')] }])
    bridge.cancel()
    expect(await pending).toEqual({ answers: [] })
    expect(bridge.current).toBeNull()
  })
})
