/** /image and the shared image-attachment path (also fed by terminal
 * file-drops pasted into the input box). */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { expandPath, imageMediaTypeOf, tokenizePathList } from '../path-drops.js'
import type { CommandCtx } from './types.js'

/** Attach each path to the next outgoing message; one bad path reports and
 * moves on instead of aborting the rest. Shared by `/image` (whose arguments
 * arrive pre-tokenized) and by terminal file-drops pasted into the input box. */
export async function attachImagePaths(c: CommandCtx, paths: readonly string[]): Promise<void> {
  for (const pathArg of paths) {
    const absolute = expandPath(pathArg)
    const mediaType = imageMediaTypeOf(absolute)
    if (mediaType === undefined) {
      c.store.addNotice(`不支持的图片格式：${basename(absolute)}（支持 png / jpeg / webp / gif）`, 'error')
      continue
    }
    let data: Uint8Array
    try {
      data = new Uint8Array(readFileSync(absolute))
    } catch (error) {
      c.store.addNotice(`读取图片失败：${absolute}（${error instanceof Error ? error.message : String(error)}）`, 'error')
      continue
    }
    const name = basename(absolute)
    try {
      const [ref] = await c.ctx.attachments.saveImages([{ data, mediaType, name }])
      if (ref === undefined) {
        c.store.addNotice('图片保存失败：未返回引用', 'error')
        continue
      }
      c.store.addPendingImage(ref, `${name}（${ref.width}×${ref.height}）`)
      c.store.addNotice(`已附加图片 ${name}（${ref.width}×${ref.height}），将随下一条消息发送`)
    } catch (error) {
      c.store.addNotice(`图片校验失败：${name}（${error instanceof Error ? error.message : String(error)}）`, 'error')
    }
  }
}

export async function runImage(c: CommandCtx, rest: string): Promise<void> {
  const tokens = tokenizePathList(rest)
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === 'clear') {
    const cleared = c.store.clearPendingImages()
    c.store.addNotice(cleared > 0 ? `已清空 ${cleared} 张待发送图片` : '当前没有待发送的图片')
    return
  }
  if (tokens.length === 0) {
    const snap = c.store.getSnapshot()
    if (snap.pendingImages.length === 0) {
      c.store.addNotice('用法：/image <图片路径>（支持 png / jpeg / webp / gif，可写多个路径）', 'warn')
      return
    }
    c.store.addPanel('已附加的图片（随下一条消息发送）', [
      ...snap.pendingImages.map(image => `· ${image.label}`),
      '',
      '⌫ 输入框为空时撤销最后一张 · ⌥⌫ 清空全部 · /image clear 同效',
    ])
    return
  }
  await attachImagePaths(c, tokens)
}
