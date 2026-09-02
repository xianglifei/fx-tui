import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachImagePaths, runImage } from './image.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fx-tui-image-'))
  writeFileSync(join(dir, 'shot.png'), 'not really a png', { encoding: 'utf8' })
  writeFileSync(join(dir, 'my shot.png'), 'spaced name', { encoding: 'utf8' })
  writeFileSync(join(dir, 'notes.txt'), 'text', { encoding: 'utf8' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  cleanupTempHomes()
})

const REF = { id: 'img-1', width: 4, height: 2 } as unknown as ImageAttachmentRef

function ctxSaving(result: readonly ImageAttachmentRef[]): Context {
  return { attachments: { saveImages: async () => result } } as unknown as Context
}

describe('attachImagePaths', () => {
  it('attaches an existing image and reports its dimensions', async () => {
    const { c, store } = makeCtx({ ctx: ctxSaving([REF]) })
    await attachImagePaths(c, [join(dir, 'shot.png')])

    expect(store.getSnapshot().pendingImages.map(image => image.label)).toEqual(['shot.png（4×2）'])
  })

  it('reports an unsupported extension and keeps going', async () => {
    const { c, store, log } = makeCtx({ ctx: ctxSaving([REF]) })
    await attachImagePaths(c, [join(dir, 'notes.txt')])

    expect(log.notices[0]).toContain('不支持的图片格式')
    expect(store.getSnapshot().pendingImages.length).toBe(0)
  })

  it('reports an unreadable path instead of throwing', async () => {
    const { c, log } = makeCtx({ ctx: ctxSaving([REF]) })
    await attachImagePaths(c, [join(dir, 'missing.png')])

    expect(log.notices[0]).toContain('读取图片失败')
  })

  it('reports an attachment service that returns no reference', async () => {
    const { c, log } = makeCtx({ ctx: ctxSaving([]) })
    await attachImagePaths(c, [join(dir, 'shot.png')])

    expect(log.notices[0]).toContain('图片保存失败')
  })
})

describe('/image', () => {
  it('tokenizes quoted paths so spaces survive', async () => {
    const { c, store } = makeCtx({ ctx: ctxSaving([REF]) })
    await runImage(c, `"${join(dir, 'my shot.png')}"`)

    expect(store.getSnapshot().pendingImages.map(image => image.label)).toEqual(['my shot.png（4×2）'])
  })

  it('prints the usage line with nothing pending', async () => {
    const { c, log } = makeCtx()
    await runImage(c, '')

    expect(log.notices[0]).toContain('用法：/image')
    expect(log.panels.length).toBe(0)
  })

  it('lists pending images on the bare command', async () => {
    const { c, log } = makeCtx({ ctx: ctxSaving([REF]) })
    await runImage(c, join(dir, 'shot.png'))
    await runImage(c, '')

    expect(log.panels[0]?.title).toContain('已附加的图片')
    expect(log.panels[0]?.lines.join('\n')).toContain('shot.png（4×2）')
  })

  it('clears the tray and distinguishes an already empty one', async () => {
    const { c, store, log } = makeCtx({ ctx: ctxSaving([REF]) })
    await runImage(c, 'clear')
    expect(log.notices.at(-1)).toBe('当前没有待发送的图片')

    await runImage(c, join(dir, 'shot.png'))
    expect(store.getSnapshot().pendingImages.length).toBe(1)

    await runImage(c, 'clear')
    expect(log.notices.at(-1)).toContain('已清空 1 张')
    expect(store.getSnapshot().pendingImages.length).toBe(0)
  })
})
