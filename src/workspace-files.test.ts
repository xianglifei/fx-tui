import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fuzzyMatchPaths, invalidateWorkspaceFiles, listWorkspaceFiles, scorePath } from './workspace-files.js'

describe('scorePath', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(scorePath('zzz', 'src/app.ts')).toBeNull()
  })

  it('basename prefix beats mid-word containment', () => {
    expect(scorePath('app', 'app.ts')!).toBeGreaterThan(scorePath('app', 'myapp.ts')!)
  })

  it('matches out-of-order subsequences', () => {
    expect(scorePath('appts', 'src/app.ts')).not.toBeNull()
    expect(scorePath('appts', 'src/app.ts')).toBeGreaterThan(0)
  })
})

describe('fuzzyMatchPaths', () => {
  it('ranks prefix+basename first, then ties by shorter path', () => {
    const matches = fuzzyMatchPaths('app', ['src/deep/app.ts', 'src/app.ts', 'lib/myapp.ts'], 10)
    expect(matches.map(m => m.path)).toEqual(['src/app.ts', 'src/deep/app.ts', 'lib/myapp.ts'])
  })

  it('respects the limit and drops non-matches', () => {
    const matches = fuzzyMatchPaths('app', ['src/app.ts', 'lib/myapp.ts', 'x.ts'], 1)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.path).toBe('src/app.ts')
  })

  it('empty query returns candidates in order', () => {
    expect(fuzzyMatchPaths('', ['b', 'a'], 10).map(m => m.path)).toEqual(['b', 'a'])
  })
})

describe('listWorkspaceFiles', () => {
  it('prunes ignored directories before descending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-walk-'))
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')
      mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
      writeFileSync(join(dir, '.git', 'objects', 'ab'), '')
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'out.js'), '')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'app.ts'), '')
      writeFileSync(join(dir, 'build'), '') // a FILE named like an ignored segment
      writeFileSync(join(dir, 'package.json'), '')

      invalidateWorkspaceFiles()
      const files = await listWorkspaceFiles(dir)

      expect(files).toContain('src/app.ts')
      expect(files).toContain('package.json')
      expect(files.some(f => f.includes('node_modules'))).toBe(false)
      expect(files.some(f => f.includes('.git'))).toBe(false)
      expect(files.some(f => f.startsWith('dist'))).toBe(false)
      expect(files).not.toContain('build')
    } finally {
      invalidateWorkspaceFiles()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
