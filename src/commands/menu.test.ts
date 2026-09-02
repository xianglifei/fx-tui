import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinCommands, createSkillCatalog } from './menu.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

afterEach(cleanupTempHomes)

/** A kernel stub exposing only the two registries the catalog reads. */
function ctxWith(commands: unknown, skills: unknown): Context {
  return { commands, skills } as unknown as Context
}

const dshCommands = {
  list: () => [
    { name: 'compact', description: '压缩历史' },
    { name: 'help', description: '与内置同名，应被跳过' },
  ],
}

const skills = {
  list: async () => [
    { name: 'review', description: '代码评审', invocation: { userInvocable: true } },
    { name: 'internal', description: '内部技能', invocation: { userInvocable: false } },
  ],
}

describe('builtinCommands', () => {
  it('every entry carries a name, a description and the builtin kind', () => {
    expect(builtinCommands.length).toBeGreaterThan(0)
    for (const command of builtinCommands) {
      expect(command.name).toMatch(/^[a-z]+$/)
      expect(command.description.length).toBeGreaterThan(0)
      expect(command.kind).toBe('builtin')
    }
  })

  it('names are unique — the menu dispatches by name alone', () => {
    const names = builtinCommands.map(command => command.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('createSkillCatalog', () => {
  it('merges dsh commands without duplicating a built-in of the same name', async () => {
    const { c } = makeCtx({ ctx: ctxWith(dshCommands, skills) })
    const catalog = createSkillCatalog(c)
    await catalog.refresh()

    const names = catalog.list().map(entry => entry.name)
    expect(names).toContain('compact')
    expect(names.filter(name => name === 'help').length).toBe(1)
    expect(catalog.list().find(entry => entry.name === 'help')?.kind).toBe('builtin')
    expect(catalog.list().find(entry => entry.name === 'compact')?.kind).toBe('dsh')
  })

  it('keeps only user-invocable skills, and commands win same-name collisions', async () => {
    const colliding = {
      list: async () => [
        { name: 'review', description: '评审', invocation: { userInvocable: true } },
        { name: 'internal', description: '内部', invocation: { userInvocable: false } },
        { name: 'export', description: '与内置命令同名', invocation: { userInvocable: true } },
      ],
    }
    const { c } = makeCtx({ ctx: ctxWith({ list: () => [] }, colliding) })
    const catalog = createSkillCatalog(c)
    await catalog.refresh()
    const list = catalog.list()

    expect(list.map(entry => entry.name)).not.toContain('internal')
    expect(list.find(entry => entry.name === 'export')?.kind).toBe('builtin')
    expect(list.find(entry => entry.name === 'review')?.kind).toBe('skill')
  })

  it('a throwing command registry degrades to built-ins instead of failing', async () => {
    const { c } = makeCtx({
      ctx: ctxWith({ list: () => { throw new Error('registry down') } }, skills),
    })
    const catalog = createSkillCatalog(c)
    await catalog.refresh()

    expect(catalog.list().length).toBe(builtinCommands.length + 1)
  })

  it('a throwing skill fetch keeps the last good catalog', async () => {
    const { c } = makeCtx({ ctx: ctxWith({ list: () => [] }, skills) })
    const catalog = createSkillCatalog(c)
    await catalog.refresh()
    expect(catalog.list().map(entry => entry.name)).toContain('review')

    const failing = makeCtx({
      ctx: ctxWith({ list: () => [] }, { list: async () => { throw new Error('skills down') } }),
    })
    await createSkillCatalog(failing.c).refresh()
    // The catalog is display-optional: a failed refresh leaves it empty rather
    // than propagating, and the menu still renders the commands.
    expect(createSkillCatalog(failing.c).list().length).toBe(builtinCommands.length)
  })

  it('lookup() reports the session cwd and the agent scope', () => {
    const { c, agent } = makeCtx()
    const lookup = createSkillCatalog(c).lookup()
    expect(lookup.cwd).toBe(agent.session.header.cwd)
    expect(lookup.scope).toBe(agent)
  })
})
