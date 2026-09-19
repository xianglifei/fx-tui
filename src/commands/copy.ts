/** /copy — copy the most recent assistant reply (its raw Markdown) to the
 * macOS clipboard. Terminal selection drags in rendered-glyph residue, so a
 * clipboard round-trip is the only clean export path for a single reply. */

import { writeClipboardText } from '../clipboard.js'
import { formatCount } from '../text.js'
import type { CommandCtx } from './types.js'

export async function runCopy(
  c: CommandCtx,
  write: (text: string) => Promise<void> = writeClipboardText,
): Promise<void> {
  const snapshot = c.store.getSnapshot()
  let text = ''
  for (let i = snapshot.items.length - 1; i >= 0; i--) {
    const item = snapshot.items[i]
    if (item !== undefined && item.kind === 'assistant' && item.text.trim() !== '') {
      text = item.text
      break
    }
  }
  // Mid-turn there is no settled item yet; the live partial reply is still
  // the reply the user is looking at.
  if (text === '') text = snapshot.streaming
  if (text.trim() === '') {
    c.store.addNotice('还没有可复制的回复', 'warn')
    return
  }
  try {
    await write(text)
    c.store.addNotice(`已复制最后一条回复（${formatCount(text.length)} 字符）到剪贴板`)
  } catch (error) {
    c.store.addNotice(`复制失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}
