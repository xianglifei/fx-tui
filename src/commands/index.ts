/** The slash-command dispatcher: parses `/name args`, routes built-ins to
 * their handlers, then the dsh command registry, and finally treats unknown
 * names as the /skill gesture riding a plain message (the upstream agent
 * injects the skill body itself). */

import type { SkillCatalog } from './menu.js'
import { runBtw } from './btw.js'
import { runConfig } from './config.js'
import { exportSession } from './export.js'
import { runContext, runDoctor, runHelp, runStatus } from './info.js'
import { runImage } from './image.js'
import { listModelChoices, runEffort } from './model.js'
import { listSessionChoices, runRename } from './session.js'
import { runTheme } from './theme.js'
import { runUpdate } from './update.js'
import type { CommandCtx } from './types.js'

export function createCommandRunner(c: CommandCtx, catalog: SkillCatalog): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    const trimmed = line.trim()
    const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
    const rest = trimmed.slice(1 + name.length).trim()
    c.debugLog('command', trimmed)
    try {
      switch (name) {
        case 'help':
          runHelp(c)
          return
        case 'exit': case 'quit': case 'bye':
          await c.exit()
          return
        case 'status':
          await runStatus(c)
          return
        case 'sessions':
          await listSessionChoices(c, rest)
          return
        case 'rename':
          await runRename(c, rest)
          return
        case 'model':
          await listModelChoices(c)
          return
        case 'effort':
          await runEffort(c, rest)
          return
        case 'btw':
          await runBtw(c, rest)
          return
        case 'context':
          runContext(c)
          return
        case 'doctor':
          await runDoctor(c)
          return
        case 'config': case 'setting': case 'settings':
          await runConfig(c, rest)
          return
        case 'theme':
          await runTheme(c, rest)
          return
        case 'export':
          await exportSession(c)
          return
        case 'edit':
          await c.openExternalEditor()
          return
        case 'image':
          await runImage(c, rest)
          return
        case 'update': {
          const argTokens = rest.split(/\s+/).filter(token => token !== '')
          if (argTokens.some(token => token !== '--force' && token.toLowerCase() !== 'force')) {
            c.store.addNotice('用法：/update [--force]（--force 允许带着未提交改动升级）', 'warn')
            return
          }
          await runUpdate(c, argTokens.length > 0)
          return
        }
        case 'forget': case 'forget-approvals':
          c.store.addNotice('总是授权记录在 $DSH_HOME/fx-tui-allowlist.json，删除该文件即可清除（本会话记忆随进程结束失效）', 'warn')
          return
        default: {
          const commands = c.ctx.commands
          if (commands.find(c.agent(), name) !== undefined) {
            const execution = await commands.execute(c.agent(), trimmed, [], new AbortController().signal)
            if (execution === undefined) {
              c.store.addNotice(`/${name}：命令未执行（语法或名称未解析）`, 'warn')
            } else if (execution.result.kind === 'error') {
              c.store.addPanel(`/${name} 执行失败`, [execution.result.text])
            } else if (execution.result.text !== undefined && execution.result.text !== '') {
              c.store.addPanel(`/${name}`, [execution.result.text])
            } else {
              c.store.addNotice(`/${name} 完成`)
            }
          } else {
            // Unknown to both command registries, the name may still address a
            // user-invocable skill: the upstream agent detects the /name gesture
            // in user messages and injects the skill body itself, so the whole
            // line rides as a plain message instead of erroring out.
            const skill = await c.ctx.skills.get(name, catalog.lookup()).catch(() => undefined)
            if (skill !== undefined && skill.invocation.userInvocable) {
              c.submitMessage(trimmed)
            } else {
              c.store.addNotice(`未知命令：/${name}（输入 / 查看可用命令与技能）`, 'warn')
            }
          }
          return
        }
      }
    } catch (error) {
      c.store.addNotice(`命令执行失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }
}
