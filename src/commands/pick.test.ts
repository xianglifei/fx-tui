import { afterEach, describe, expect, it } from 'vitest'
import { pick } from './pick.js'
import { answerPick, awaitCard, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

afterEach(cleanupTempHomes)

describe('pick', () => {
  it('resolves undefined without opening a card when there is nothing to choose', async () => {
    const { c, store } = makeCtx()
    await expect(pick(c, '空列表', [])).resolves.toBeUndefined()
    expect(store.getSnapshot().question).toBeNull()
  })

  it('returns the chosen label', async () => {
    const { c, store } = makeCtx()
    const pending = pick(c, '选一个', [{ label: '甲' }, { label: '乙' }])
    await answerPick(store, '乙')
    await expect(pending).resolves.toBe('乙')
  })

  it('resolves undefined when the card is skipped', async () => {
    const { c, store } = makeCtx()
    const pending = pick(c, '选一个', [{ label: '甲' }])
    await skipPick(store)
    await expect(pending).resolves.toBeUndefined()
  })

  it('carries the option descriptions into the card', async () => {
    const { c, store } = makeCtx()
    const pending = pick(c, '带说明', [{ label: '甲', description: '第一个' }])
    await awaitCard(store)

    expect(store.getSnapshot().question?.item.options?.[0]?.description).toBe('第一个')

    await answerPick(store, '甲')
    await pending
  })

  it('questions are single-select at the store level', async () => {
    const { c, store } = makeCtx()
    const pending = pick(c, '选一个', [{ label: '甲' }, { label: '乙' }])
    await answerPick(store, '甲')
    store.toggleQuestionOption('乙')
    await expect(pending).resolves.toBe('甲')
  })
})
