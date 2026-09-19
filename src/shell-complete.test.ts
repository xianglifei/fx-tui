import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  completeShellCommand,
  completeShellPath,
  isPathLikeWord,
  listPathCommands,
  quoteShellWord,
  shellWordAt,
} from './shell-complete.js'

const root = mkdtempSync(join(tmpdir(), 'fx-shell-complete-'))
mkdirSync(join(root, 'bin'))
mkdirSync(join(root, 'bin', 'sub'))
mkdirSync(join(root, 'docs'))
writeFileSync(join(root, 'README.md'), '')
writeFileSync(join(root, 'my file.txt'), '')
symlinkSync(join(root, 'bin'), join(root, 'bin-link'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('shellWordAt', () => {
  it('extracts the first word as command position', () => {
    expect(shellWordAt('!git sta', 4)).toEqual({ start: 1, query: 'git', command: true })
    // the cursor on the second word is no longer command position
    expect(shellWordAt('!git sta', 8)).toEqual({ start: 5, query: 'sta', command: false })
  })

  it('splits words on whitespace and tracks the cursor', () => {
    const word = shellWordAt('!ls src/ui', 7)
    expect(word).toEqual({ start: 4, query: 'src', command: false })
  })

  it('handles the double-bang prefix and the prefix cursor', () => {
    expect(shellWordAt('!!npm run', 5)).toMatchObject({ start: 2, query: 'npm', command: true })
    expect(shellWordAt('!!npm run', 9)).toMatchObject({ start: 6, query: 'run', command: false })
    expect(shellWordAt('!npm', 0)).toBeUndefined()
    // cursor right after the bang: empty word (the menu gate ignores it)
    expect(shellWordAt('!npm', 1)).toEqual({ start: 1, query: '', command: true })
  })

  it('returns an empty query between spaces', () => {
    expect(shellWordAt('!ls ', 4)).toEqual({ start: 4, query: '', command: false })
  })

  it('rejects non-bang lines', () => {
    expect(shellWordAt('ls -la', 6)).toBeUndefined()
  })
})

describe('isPathLikeWord', () => {
  it('flags path-ish queries', () => {
    expect(isPathLikeWord('./bin')).toBe(true)
    expect(isPathLikeWord('src/u')).toBe(true)
    expect(isPathLikeWord('~/.c')).toBe(true)
    expect(isPathLikeWord('vit')).toBe(false)
  })
})

describe('completeShellCommand', () => {
  const names = ['git', 'gitk', 'go', 'node', 'npm']

  it('prefix-matches in order and respects the limit', () => {
    expect(completeShellCommand('git', names)).toEqual(['git', 'gitk'])
    expect(completeShellCommand('n', names, 1)).toEqual(['node'])
    expect(completeShellCommand('zzz', names)).toEqual([])
  })
})

describe('completeShellPath', () => {
  it('completes bare basenames in the workspace root', async () => {
    const matches = await completeShellPath('RE', root)
    expect(matches.map(match => match.label)).toEqual(['README.md'])
    expect(matches[0]!.directory).toBe(false)
  })

  it('marks directories with a trailing slash and completes inside them', async () => {
    const matches = await completeShellPath('b', root)
    expect(matches.map(match => match.label)).toEqual(['bin/', 'bin-link'])
    const inside = await completeShellPath('bin/', root)
    expect(inside.map(match => match.label)).toEqual(['bin/sub/'])
  })

  it('expands ~ to the given home but keeps it in the labels', async () => {
    const matches = await completeShellPath('~/b', root, { home: root })
    expect(matches.map(match => match.label)).toEqual(['~/bin/', '~/bin-link'])
    // A bare ~ (no slash) lists the home directory itself.
    const bare = await completeShellPath('~', root, { home: root })
    expect(bare.length).toBeGreaterThan(0)
    expect(bare.every(match => match.label.startsWith('~/'))).toBe(true)
  })

  it('returns nothing for a nonexistent directory', async () => {
    expect(await completeShellPath('nope/', root)).toEqual([])
  })

  it('handles names that need quoting for the shell', async () => {
    const matches = await completeShellPath('my', root)
    expect(matches.map(match => match.label)).toEqual(['my file.txt'])
    expect(quoteShellWord('my file.txt')).toBe(`'my file.txt'`)
  })
})

describe('listPathCommands', () => {
  it('unions PATH entries with the workspace node_modules/.bin', async () => {
    const binDir = join(root, 'path-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'fx-tool'), '')
    const localBin = join(root, 'node_modules', '.bin')
    mkdirSync(localBin, { recursive: true })
    writeFileSync(join(localBin, 'fx-local'), '')
    const names = await listPathCommands({ pathEnv: binDir, cwd: root })
    expect(names).toContain('fx-tool')
    expect(names).toContain('fx-local')
  })

  it('skips missing PATH entries (the local .bin still applies)', async () => {
    const names = await listPathCommands({ pathEnv: '/nonexistent-fx-path', cwd: root })
    expect(names).toContain('fx-local')
    expect(names).not.toContain('fx-tool')
  })
})

describe('quoteShellWord', () => {
  it('leaves shell-safe words untouched', () => {
    expect(quoteShellWord('bin/sub/')).toBe('bin/sub/')
    expect(quoteShellWord('node')).toBe('node')
  })

  it('single-quotes words with spaces and escapes embedded quotes', () => {
    expect(quoteShellWord(`a'b`)).toBe(`'a'\\''b'`)
  })
})
