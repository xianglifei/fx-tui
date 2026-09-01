import { describe, expect, it } from 'vitest'
import { fuzzyMatchPaths, scorePath } from './workspace-files.js'

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
