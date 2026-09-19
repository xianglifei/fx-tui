import { describe, expect, it } from 'vitest'
import { runCopy } from './copy.js'
import { makeCtx } from './test-helpers.js'

describe('runCopy', () => {
  it('copies the newest settled assistant reply', async () => {
    const { c, store } = makeCtx()
    store.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] }, interrupted: false }, time: 1 } as never)
    store.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# 新回复\n\n正文' }] }, interrupted: false }, time: 2 } as never)
    const written: string[] = []
    await runCopy(c, async text => { written.push(text) })
    expect(written).toEqual(['# 新回复\n\n正文'])
    expect(c.store.getSnapshot().items.at(-1)?.kind).toBe('notice')
  })

  it('falls back to the live streaming reply mid-turn', async () => {
    const { c, store } = makeCtx()
    // The stream buffer flushes on the store's 60ms tick, not synchronously.
    store.start()
    store.onAssistantStreamFrame({ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '正在生成的回复' } } as never)
    await new Promise(resolve => setTimeout(resolve, 80))
    const written: string[] = []
    await runCopy(c, async text => { written.push(text) })
    store.dispose()
    expect(written).toEqual(['正在生成的回复'])
  })

  it('warns when there is nothing to copy', async () => {
    const { c, log } = makeCtx()
    const written: string[] = []
    await runCopy(c, async text => { written.push(text) })
    expect(written).toEqual([])
    expect(log.notices.some(notice => notice.includes('还没有可复制的回复'))).toBe(true)
  })

  it('reports a clipboard failure as an error notice', async () => {
    const { c, log } = makeCtx()
    c.store.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] }, interrupted: false }, time: 1 } as never)
    await runCopy(c, async () => { throw new Error('pbcopy 退出码 1') })
    expect(log.notices.some(notice => notice.includes('复制失败') && notice.includes('pbcopy'))).toBe(true)
  })
})
