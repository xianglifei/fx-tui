/**
 * Workspace file listing and fuzzy path matching for @-references.
 *
 * The listing is a shallow cached walk (30s TTL) of the session workspace
 * that skips VCS/build directories and caps the entry count; matching is a
 * subsequence scorer with a basename bonus so `@app ts` finds `src/app.ts`.
 */

import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

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

/**
 * Hand-rolled DFS instead of `readdir({ recursive: true })`: the built-in
 * recursive read materializes EVERY entry of the tree (node_modules among
 * them, often hundreds of thousands of Dirents) before any filtering can
 * run. Here an ignored directory is pruned the moment its entry is seen —
 * it is never entered, so its contents never exist in memory at all.
 * Directory symlinks are not followed (no cycles).
 */
async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skip, like the recursive walk did
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break
      if (IGNORED_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue
      // Uniform name check: prunes ignored directories before descending and
      // skips files named like one (a file literally called `build`).
      if (IGNORED_SEGMENTS.has(entry.name)) continue
      if (entry.isDirectory()) {
        queue.push(join(dir, entry.name))
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)))
      }
    }
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
