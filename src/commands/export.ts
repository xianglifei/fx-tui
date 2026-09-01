/** /export: dump the current session log as a Markdown file in the cwd. */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blocksToTextOf, toolResultCallIdOf, toolResultTextOf } from '../store.js'
import type { CommandCtx } from './types.js'

export async function exportSession(c: CommandCtx): Promise<void> {
  const agent = c.agent()
  const lines: string[] = [
    `# fx-tui 会话导出 · ${agent.id}`,
    '',
    `- 模型：${c.modelLabel()}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '---',
    '',
  ]
  const pendingNames = new Map<string, string>()
  for (const event of agent.session.events) {
    if (event.type === 'tool/call') {
      try {
        const parsed = JSON.parse(event.data.arguments) as Record<string, unknown>
        const summary = typeof parsed.command === 'string' ? parsed.command
          : typeof parsed.path === 'string' ? parsed.path : ''
        pendingNames.set(event.data.callId, `${event.data.name}${summary !== '' ? `（${summary}）` : ''}`)
      } catch {
        pendingNames.set(event.data.callId, event.data.name)
      }
    } else if (event.type === 'tool/result') {
      const callId = toolResultCallIdOf(event.data.message)
      const name = callId !== undefined ? pendingNames.get(callId) : undefined
      if (callId !== undefined) pendingNames.delete(callId)
      lines.push(`> 🔧 **工具** ${name ?? '(unknown)'}：${toolResultTextOf(event.data.message, undefined).split('\n')[0] ?? ''}`, '')
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') {
        lines.push(`## 👤 用户`, '', blocksToTextOf(event.data.content), '')
      }
    } else if (event.type === 'assistant/message') {
      const text = blocksToTextOf(event.data.message.content)
      if (text !== '') lines.push(`## 🤖 助手`, '', text, '')
    }
  }
  const file = resolve(process.cwd(), `fx-tui-export-${agent.id.slice(0, 13)}.md`)
  try {
    writeFileSync(file, lines.join('\n'), { encoding: 'utf8' })
    c.store.addPanel('会话已导出', [file])
  } catch (error) {
    c.store.addNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}
