/**
 * Workspace file listing and fuzzy path matching for @-references.
 *
 * The listing is a shallow cached walk (30s TTL) of the session workspace
 * that skips VCS/build directories and caps the entry count; matching is a
 * subsequence scorer with a basename bonus so `@app ts` finds `src/app.ts`.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const IGNORED_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', '__pycache__', '.next', '.cache', 'coverage',
])
const IGNORED_PREFIXES = ['.DS_Store']
const MAX_FILES = 4000
const CACHE_TTL_MS = 30_000

let cache: { at: number; files: string[] } | null = null
let inflight: Promise<string[]> | null = null

export function listWorkspaceFiles(root: string): Promise<string[]> {
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.files)
  if (inflight !== null) return inflight
  inflight = walk(root)
    .then(files => {
      cache = { at: Date.now(), files }
      return files
    })
    .catch(() => {
      return [] as string[]
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function invalidateWorkspaceFiles(): void {
  cache = null
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.DS_Store')) continue
    const parent = (entry as { parentPath?: string }).parentPath ?? ''
    const joined = parent === '' ? entry.name : join(parent, entry.name)
    // readdir with an absolute root yields absolute parent paths; strip back to relative.
    const prefix = root.endsWith('/') ? root : `${root}/`
    const relative = joined.startsWith(prefix) ? joined.slice(prefix.length) : joined
    if (relative.split('/').some(segment => IGNORED_SEGMENTS.has(segment))) continue
    if (IGNORED_PREFIXES.some(prefixName => entry.name.startsWith(prefixName))) continue
    files.push(relative)
  }
  files.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return files
}

export interface FileMatch {
  path: string
  score: number
}

/** Fuzzy subsequence match with basename and prefix bonuses; best first. */
export function fuzzyMatchPaths(query: string, candidates: readonly string[], limit: number): FileMatch[] {
  const q = query.toLowerCase()
  if (q === '') {
    return candidates.slice(0, limit).map(path => ({ path, score: 0 }))
  }
  const matches: FileMatch[] = []
  for (const path of candidates) {
    const score = scorePath(q, path.toLowerCase())
    if (score !== null) matches.push({ path, score })
  }
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return matches.slice(0, limit)
}

/** Score one candidate path against the query; null = no subsequence match.
 * Exported for tests. */
export function scorePath(query: string, path: string): number | null {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  let score = 0
  if (basename.startsWith(query)) score += 100
  else if (basename.includes(query)) score += 60
  let qi = 0
  let streak = 0
  let matchedInBasename = true
  for (let pi = 0; pi < path.length && qi < query.length; pi++) {
    if (path[pi] === query[qi]) {
      streak++
      score += 10 + streak * 2 + (pi === 0 || path[pi - 1] === '/' || path[pi - 1] === '.' || path[pi - 1] === '_' || path[pi - 1] === '-' ? 6 : 0)
      if (pi < path.length - basename.length) matchedInBasename = false
      qi++
    } else {
      streak = 0
    }
  }
  if (qi < query.length) return null
  if (matchedInBasename) score += 20
  // Shorter paths win ties — reward focus over sprawl.
  score -= Math.floor(path.length / 8)
  return score
}
