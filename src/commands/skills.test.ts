import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillCatalog } from './menu.js'
import { runSkills } from './skills.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

afterEach(cleanupTempHomes)

function skill(name: string, source: string, description: string): unknown {
  return {
    name,
    description,
    source,
    provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

function ctxWithSkills(skills: readonly unknown[]): Context {
  return { skills: { list: async () => skills } } as unknown as Context
}

function catalog(): SkillCatalog {
  return {
    list: () => [],
    refresh: async () => {},
    lookup: () => ({ cwd: process.cwd(), scope: {} }),
  }
}

describe('runSkills', () => {
  it('names each skill with the directory it came from', async () => {
    const skills = [
      skill('alpha', 'project-dsh', '项目技能'),
      skill('beta', 'user-dsh', '用户技能'),
      skill('gamma', 'mystery-source', '未知来源原样显示'),
    ]
    const { c, log } = makeCtx({ ctx: ctxWithSkills(skills) })

    await runSkills(c, catalog())

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(log.panels[0]?.title).toContain('3')
    expect(body).toContain('/alpha · 项目 .dsh/skills')
    expect(body).toContain('/beta · 用户 ~/.dsh/skills')
    expect(body).toContain('mystery-source')
  })

  it('says how many more exist when the catalog is longer than the panel', async () => {
    const skills = Array.from({ length: 70 }, (_, index) => skill(`s${index}`, 'bundled', '内置'))
    const { c, log } = makeCtx({ ctx: ctxWithSkills(skills) })

    await runSkills(c, catalog())

    expect(log.panels[0]?.lines.join('\n')).toContain('只列出前 60 个')
  })

  it('explains how to add one when the catalog is empty', async () => {
    const { c, log } = makeCtx({ ctx: ctxWithSkills([]) })

    await runSkills(c, catalog())

    expect(log.notices[0]).toContain('还没有可用技能')
    expect(log.panels).toEqual([])
  })

  it('reports a failed catalog read', async () => {
    const ctx = { skills: { list: async () => { throw new Error('no registry') } } } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    await runSkills(c, catalog())

    expect(log.notices[0]).toContain('no registry')
  })
})
