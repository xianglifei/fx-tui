/** /skills: the skill catalog as a panel.
 *
 * The `/` menu already offers the same entries as completions; this is the
 * whole list at once, with each one's origin bucket so a name that shadowed
 * another is identifiable.
 */

import { truncateLine } from '../ui/estimate.js'
import type { SkillCatalog } from './menu.js'
import type { CommandCtx } from './types.js'

/** Skills listed before the panel says how many more exist. */
const SKILL_LIMIT = 60

/** Where a skill came from, in the words the directories use. */
const SOURCE_LABELS: Record<string, string> = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  'user-dsh': '用户 ~/.dsh/skills',
  'user-agents': '用户 ~/.agents/skills',
  bundled: '内置',
  runtime: '运行时',
  custom: '自定义',
}

export async function runSkills(c: CommandCtx, catalog: SkillCatalog): Promise<void> {
  let skills
  try {
    skills = await c.ctx.skills.list(catalog.lookup())
  } catch (error) {
    c.store.addNotice(`读取技能列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  if (skills.length === 0) {
    c.store.addNotice('还没有可用技能（项目 .dsh/skills 或 ~/.dsh/skills 下放 SKILL.md 即可添加）')
    return
  }
  const shown = skills.slice(0, SKILL_LIMIT)
  const lines = shown.map(skill => {
    const source = SOURCE_LABELS[skill.source] ?? skill.source
    return `/${skill.name} · ${source} · ${truncateLine(skill.description, 56)}`
  })
  if (skills.length > shown.length) {
    lines.push(`…（共 ${skills.length} 个技能，只列出前 ${shown.length} 个；输入 / 可按名称筛选）`)
  }
  lines.push('', '输入 /技能名 直接调用；消息里写 /技能名 同样触发（命令优先于同名技能）')
  c.store.addPanel(`技能（${skills.length}）`, lines)
}
