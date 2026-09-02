import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { runBtw } from './btw.js'
import { cleanupTempHomes, makeBusy, makeCtx } from './test-helpers.js'

afterEach(cleanupTempHomes)

function ctxStreaming(chunks: readonly unknown[]): Context {
  return {
    llm: {
      stream: async function* (): AsyncGenerator<unknown> {
        for (const chunk of chunks) yield chunk
      },
    },
  } as unknown as Context
}

const DELTA = (text: string): unknown => ({ type: 'text-delta', text })
const FINISH = (kind: string): unknown => ({ type: 'finish', reason: { kind } })

describe('/btw', () => {
  it('prints the usage line for an empty question', async () => {
    const { c, log } = makeCtx()
    await runBtw(c, '   ')

    expect(log.notices[0]).toContain('用法：/btw')
  })

  it('refuses to run while a turn is in flight', async () => {
    const { c, log, store } = makeCtx({ ctx: ctxStreaming([DELTA('答案')]) })
    makeBusy(store)
    await runBtw(c, '现在几点？')

    expect(log.notices.at(-1)).toContain('回合结束时使用')
    expect(log.panels.length).toBe(0)
  })

  it('renders the answer in a panel and disclaims the session impact', async () => {
    const { c, log } = makeCtx({ ctx: ctxStreaming([DELTA('这是答案'), FINISH('completed')]) })
    await runBtw(c, '这是什么？')

    expect(log.panels[0]?.title).toBe('侧问：这是什么？')
    expect(log.panels[0]?.lines.join('\n')).toContain('这是答案')
    expect(log.panels[0]?.lines.join('\n')).toContain('不写入会话历史')
  })

  it('reports a provider error', async () => {
    const { c, log } = makeCtx({ ctx: ctxStreaming([FINISH('error')]) })
    await runBtw(c, '问题')

    expect(log.notices.at(-1)).toContain('侧问失败：模型返回错误')
  })

  it('reports an empty answer rather than an empty panel', async () => {
    const { c, log } = makeCtx({ ctx: ctxStreaming([DELTA('   '), FINISH('completed')]) })
    await runBtw(c, '问题')

    expect(log.notices.at(-1)).toContain('没有返回内容')
    expect(log.panels.length).toBe(0)
  })

  it('converts a thrown stream into an error notice', async () => {
    const ctx = {
      llm: {
        stream: async function* (): AsyncGenerator<never> {
          throw new Error('socket hang up')
        },
      },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runBtw(c, '问题')

    expect(log.notices.at(-1)).toContain('侧问失败：socket hang up')
  })

  it('a newer side ask supersedes the in-flight one', async () => {
    let calls = 0
    const ctx = {
      llm: {
        stream: async function* (options: { signal: AbortSignal }): AsyncGenerator<unknown> {
          calls += 1
          if (calls === 1) {
            // The first ask parks until its controller is aborted, then ends
            // without producing anything.
            await new Promise<void>(resolve => {
              options.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            return
          }
          yield DELTA('第二个答案')
          yield FINISH('completed')
        },
      },
    } as unknown as Context

    const first = makeCtx({ ctx })
    const pendingFirst = runBtw(first.c, '第一个问题')
    await new Promise(resolve => setTimeout(resolve, 10))

    const second = makeCtx({ ctx })
    await runBtw(second.c, '第二个问题')
    await pendingFirst

    // The superseded ask leaves only its "asking" notice — no panel, no error.
    expect(first.log.panels.length).toBe(0)
    expect(first.log.notices).toEqual(['侧问中（不打断主任务）：第一个问题'])
    expect(second.log.panels[0]?.lines.join('\n')).toContain('第二个答案')
  })
})
