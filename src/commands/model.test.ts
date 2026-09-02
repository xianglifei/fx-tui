import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { listModelChoices, runEffort } from './model.js'
import { answerPick, awaitCard, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

afterEach(cleanupTempHomes)

const EFFORTS = [
  { id: 'low' as ReasoningEffortId, name: '低', description: '更快，更省' },
  { id: 'high' as ReasoningEffortId, name: '高', description: '更慢，更细' },
]

function ctxWith(
  efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[] = EFFORTS,
  providers: readonly { id: string }[] = [],
  models: readonly { id: string }[] = [],
): Context {
  return {
    llm: {
      listProviders: () => providers,
      listModels: async () => models,
      resolveModelInfo: async () => ({ reasoning: { efforts: [...efforts], defaultEffort: efforts[0]?.id } }),
    },
  } as unknown as Context
}

describe('/effort', () => {
  it('reports a model with no effort tiers', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith([]) })
    await runEffort(c, 'high')

    expect(log.notices[0]).toContain('没有可切换的推理强度档位')
  })

  it('falls back to the no-tier notice when the route cannot be resolved', async () => {
    const ctx = {
      llm: { resolveModelInfo: async () => { throw new Error('unknown route') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runEffort(c, '')

    expect(log.notices[0]).toContain('没有可切换的推理强度档位')
  })

  it('lists every tier, collapsing 当前 and 默认 when they coincide', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith() })
    await runEffort(c, 'status')

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toBe('推理强度')
    expect(body).toContain('low')
    expect(body).toContain('high')
    // The selection carries no explicit effort, so the active tier is the
    // default one and only one marker is warranted.
    expect(body).toContain('当前')
    expect(body).not.toContain('默认')
  })

  it('marks the default separately when the active tier differs', async () => {
    const { c, log } = makeCtx({
      ctx: ctxWith(),
      selectionRef: {
        current: { provider: 'p', model: 'm', reasoningEffort: 'high' as ReasoningEffortId },
      } as unknown as ModelSelectionRef,
    })
    await runEffort(c, 'status')

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(body).toContain('high · 当前')
    expect(body).toContain('low · 默认')
  })

  it('applies a direct id or display name, case-insensitively', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith() })
    await runEffort(c, 'HIGH')
    expect(c.selectionRef.current?.reasoningEffort).toBe('high')
    expect(log.savedSelections.at(-1)?.reasoningEffort).toBe('high')

    const second = makeCtx({ ctx: ctxWith() })
    await runEffort(second.c, '低')
    expect(second.c.selectionRef.current?.reasoningEffort).toBe('low')
  })

  it('rejects an unknown tier and lists the valid ones', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith() })
    await runEffort(c, 'turbo')

    expect(log.notices[0]).toContain('未知档位：turbo')
    expect(log.notices[0]).toContain('low / high')
  })

  it('applies a picked tier', async () => {
    const { c, store } = makeCtx({ ctx: ctxWith() })
    const pending = runEffort(c, '')
    const card = await awaitCard(store)
    await answerPick(store, card.item.options?.[1]?.label ?? '')
    await pending

    expect(c.selectionRef.current?.reasoningEffort).toBe('high')
  })

  it('a skipped picker leaves the selection alone', async () => {
    const { c, store } = makeCtx({ ctx: ctxWith() })
    const pending = runEffort(c, '')
    await skipPick(store)
    await pending

    expect(c.selectionRef.current?.reasoningEffort).toBeUndefined()
  })
})

describe('/model', () => {
  it('reports when no provider is registered', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith() })
    await listModelChoices(c)

    expect(log.notices[0]).toBe('没有已注册的模型 provider')
  })

  it('reports when no model can be listed', async () => {
    const { c, log } = makeCtx({ ctx: ctxWith(EFFORTS, [{ id: 'p' }], []) })
    await listModelChoices(c)

    expect(log.notices[0]).toBe('没有可列举的模型')
  })

  it('switches the live selection and saves it as the default', async () => {
    const { c, store, log } = makeCtx({ ctx: ctxWith(EFFORTS, [{ id: 'p' }], [{ id: 'm2' }]) })
    const pending = listModelChoices(c)
    const card = await awaitCard(store)
    await answerPick(store, card.item.options?.[0]?.label ?? '')
    await pending

    expect(c.selectionRef.current).toEqual({ provider: 'p', model: 'm2' })
    expect(store.getSnapshot().model).toBe('p/m2')
    expect(log.savedSelections).toEqual([{ provider: 'p', model: 'm2' }])
    expect(log.notices.at(-1)).toContain('模型已切换为 p/m2')
  })

  it('a skipped picker changes nothing', async () => {
    const { c, store, log } = makeCtx({ ctx: ctxWith(EFFORTS, [{ id: 'p' }], [{ id: 'm2' }]) })
    const pending = listModelChoices(c)
    await skipPick(store)
    await pending

    expect(c.selectionRef.current).toEqual({ provider: 'p', model: 'm' })
    expect(log.savedSelections).toEqual([])
  })
})
