/** The slash menu: built-in commands, the dsh command registry, and
 * user-invocable skills under their own section. The catalog is
 * display-optional — a failed fetch keeps the last good list. */

import type { MenuEntry } from '../ui/Input.js'
import type { CommandCtx } from './types.js'

export const builtinCommands: readonly MenuEntry[] = [
  { name: 'help', description: '查看按键与命令帮助', kind: 'builtin' },
  { name: 'status', description: '查看运行状态与插件树', kind: 'builtin' },
  { name: 'sessions', description: '切换会话（可带关键词过滤）', kind: 'builtin' },
  { name: 'rename', description: '重命名当前会话', kind: 'builtin' },
  { name: 'model', description: '切换模型 / provider', kind: 'builtin' },
  { name: 'effort', description: '切换推理强度档位', kind: 'builtin' },
  { name: 'btw', description: '侧问：复用上下文单轮提问，不打断主任务', kind: 'builtin' },
  { name: 'context', description: '查看上下文水位与组成明细', kind: 'builtin' },
  { name: 'doctor', description: '环境自检（Node/路由/密钥/终端）', kind: 'builtin' },
  { name: 'config', description: '查看 / 修改设置（权限、更新、通知、自动压缩）', kind: 'builtin' },
  { name: 'theme', description: '切换配色主题：自动 / 浅色 / 深色 / Ghostty 精选', kind: 'builtin' },
  { name: 'export', description: '导出当前会话为 Markdown', kind: 'builtin' },
  { name: 'edit', description: '用 $EDITOR 编写长消息', kind: 'builtin' },
  { name: 'image', description: '附加图片：<路径>… 或直接拖入终端；空参查看明细', kind: 'builtin' },
  { name: 'new', description: '开始一个新会话', kind: 'builtin' },
  { name: 'clear', description: '清空会话（原内容保留在父会话，/tree 可找回）', kind: 'builtin' },
  { name: 'resume', description: '按 id 或关键词恢复会话（无参＝会话选择器）', kind: 'builtin' },
  { name: 'fork', description: '复制当前会话并切到副本', kind: 'builtin' },
  { name: 'rewind', description: '回退到某一轮之前（丢弃该轮及以后）', kind: 'builtin' },
  { name: 'tree', description: '查看会话家族树（fork / clear 的血缘）', kind: 'builtin' },
  { name: 'trace', description: '查看当前会话的事件轨迹', kind: 'builtin' },
  { name: 'skills', description: '列出可用技能与来源目录', kind: 'builtin' },
  { name: 'provider', description: '查看已注册 provider 与当前路由', kind: 'builtin' },
  { name: 'login', description: '查看 API 凭证状态（不接受密钥参数）', kind: 'builtin' },
  { name: 'logout', description: '查看清除凭证的方法', kind: 'builtin' },
  { name: 'balance', description: '查询 DeepSeek 账户余额', kind: 'builtin' },
  { name: 'update', description: '拉取 fx-tui 最新代码并重建（git 克隆安装时可用）', kind: 'builtin' },
  { name: 'exit', description: '退出 fx-tui', kind: 'builtin' },
]

export interface SkillCatalog {
  /** Merged menu: built-ins + dsh registry commands + skills (no duplicates). */
  list(): readonly MenuEntry[]
  /** Refetch the skill catalog (at startup, on skills/change, per session). */
  refresh(): Promise<void>
  /** Shared skills-registry lookup options for the current session. */
  lookup(): { cwd: string; scope: object }
}

export function createSkillCatalog(c: CommandCtx): SkillCatalog {
  let skillEntries: readonly MenuEntry[] = []
  const skillLookup = (): { cwd: string; scope: object } => ({
    cwd: c.agent().session.header.cwd ?? process.cwd(),
    scope: c.agent(),
  })
  return {
    lookup: skillLookup,
    async refresh(): Promise<void> {
      try {
        const skills = await c.ctx.skills.list(skillLookup())
        skillEntries = skills
          .filter(skill => skill.invocation.userInvocable)
          .map(skill => ({ name: skill.name, description: skill.description, kind: 'skill' as const }))
      } catch { /* the catalog is display-optional */ }
    },
    list(): readonly MenuEntry[] {
      const dsh: MenuEntry[] = []
      try {
        for (const descriptor of c.ctx.commands.list(c.agent())) {
          if (builtinCommands.some(builtin => builtin.name === descriptor.name)) continue
          dsh.push({ name: descriptor.name, description: descriptor.description, kind: 'dsh' })
        }
      } catch { /* the registry is display-optional */ }
      const commands = [...builtinCommands, ...dsh]
      // Commands win same-name collisions, mirroring runCommand's dispatch order.
      const skills = skillEntries.filter(skill => !commands.some(command => command.name === skill.name))
      return [...commands, ...skills]
    },
  }
}
