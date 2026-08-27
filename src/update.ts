/**
 * Self-update pipeline for git-cloned installs: preflight checks, a
 * fast-forward-only pull of the current branch from origin, then dependency
 * install and rebuild — all in the clone the dsh profile points at. The
 * running process keeps its old modules until restart; callers must surface
 * that whenever `applied` is true.
 *
 * @module fx-tui
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** How long each stage may run before its whole process tree gets killed. */
const QUICK_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 90_000
const PULL_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 300_000

export interface UpdateOutcome {
  ok: boolean
  /** True when new commits were applied and a restart would take effect. */
  applied: boolean
  lines: string[]
}

/** Progress reporter called once per stage with a short status line. */
export type UpdateProgress = (text: string) => void

/**
 * Directory of this compiled module's package (lib/index.js → package root) —
 * identical to the clone registered as the dsh fx profile.
 */
export function installedRoot(): string | null {
  const libDir = dirname(fileURLToPath(import.meta.url))
  return dirname(libDir)
}

interface ShellResult {
  code: number
  out: string
  err: string
}

/** Run one shell snippet with a wall-clock cap; SIGKILLs the tree on timeout so pnpm/tsc subprocesses die too. */
function runShell(cwd: string, script: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let out = ''
    let err = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out: clip(out), err: clip(err) })
    }
    timer = setTimeout(() => {
      const pid = child.pid
      if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
      }
      child.kill('SIGKILL')
      err += '\n(超时被强制结束)'
    }, timeoutMs)
    child.stdout?.on('data', chunk => { out += chunk })
    child.stderr?.on('data', chunk => { err += chunk })
    child.on('error', error => { err += String(error); finish(-1) })
    child.on('close', code => finish(code ?? -1))
  })
}

const CLIP_CHARS = 4000

function clip(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length > CLIP_CHARS ? `…${trimmed.slice(-CLIP_CHARS)}` : trimmed
}

const tail = (lines: readonly string[], count: number): readonly string[] =>
  lines.slice(-count)

/** Run git, throwing nothing — failures come back inside the result text. */
async function git(root: string, args: string, timeoutMs = QUICK_TIMEOUT_MS): Promise<ShellResult> {
  return runShell(root, `git ${args}`, timeoutMs)
}

/**
 * pnpm resolution inside the spawned shell: plain pnpm first, corepack's shim
 * when pnpm is missing. login shell (-l) keeps PATH sane for GUI-launched fx.
 */
function pnpmCommand(args: string): string {
  return '(command -v pnpm >/dev/null 2>&1 && exec pnpm || exec corepack pnpm) ' + args
}

export async function performSelfUpdate(options: {
  root: string
  force: boolean
  currentVersion: string
}, progress: UpdateProgress): Promise<UpdateOutcome> {
  const { root, force, currentVersion } = options
  const fail = (...lines: string[]): UpdateOutcome => ({ ok: false, applied: false, lines })

  if (!existsSync(join(root, '.git'))) {
    return fail(
      `安装目录不是 git 克隆：${root}`,
      '请重新克隆后重装，或在该目录手动排查（docs/install.md）。',
    )
  }

  progress('[1/5] 检查当前分支…')
  const branchResult = await git(root, 'rev-parse --abbrev-ref HEAD')
  if (branchResult.code !== 0) {
    return fail(`读取分支失败：${branchResult.err}`)
  }
  const branch = branchResult.out.trim()
  if (branch === '' || branch === 'HEAD') {
    return fail(
      '仓库处于 detached HEAD 状态，无法安全自动升级。',
      `可手动执行：cd ${root} && git checkout main`,
      '然后 pnpm install && pnpm run build（pnpm 缺失时用 corepack pnpm）。',
    )
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return fail(`分支名包含异常字符，拒绝写入 shell 命令：${branch}；请在终端手动更新。`)
  }

  progress('[2/5] 检查本地改动…')
  const dirty = await git(root, 'status --porcelain --untracked-files=no')
  if (dirty.code !== 0) {
    return fail(`读取工作区状态失败：${dirty.err}`)
  }
  const dirtyFiles = dirty.out.split('\n').filter(line => line !== '').map(line => line.slice(3))
  if (dirtyFiles.length > 0 && !force) {
    return fail(
      '工作区有未提交的改动（未跟踪文件不算），自动升级可能覆盖它们：',
      ...tail(dirtyFiles.map(name => `· ${name}`), 8),
      '',
      '先提交或暂存后再 /update；确认改动可舍弃可用 /update --force 强行继续',
      `（git stash -u 也可一键收起）。`,
    )
  }

  progress('[3/5] 从 GitHub 拉取最新代码…')
  const fetch = await git(root, `fetch origin ${branch}`, FETCH_TIMEOUT_MS)
  if (fetch.code !== 0) {
    return fail(
      'git fetch 失败——检查网络（GitHub 可达性）或远程地址后重试。',
      ...tail(fetch.err.trim().split('\n'), 4),
    )
  }

  const headBefore = await git(root, 'rev-parse --short HEAD')
  if (headBefore.code !== 0) return fail(`读取当前提交失败：${headBefore.err}`)
  const remote = await git(root, `rev-parse --short origin/${branch}`)
  if (remote.code !== 0) return fail(`读取远端进度失败：${remote.err}`)
  if (headBefore.out.trim() === remote.out.trim()) {
    return { ok: true, applied: false, lines: ['已是最新（远端没有新提交）。'] }
  }

  const behind = await git(root, `rev-list --count HEAD..origin/${branch}`)
  const behindCount = behind.code === 0 ? Number.parseInt(behind.out.trim(), 10) : NaN

  progress('[4/5] 快进合并到远端…')
  const pull = await git(root, `pull --ff-only origin ${branch}`, PULL_TIMEOUT_MS)
  if (pull.code !== 0) {
    return fail(
      '快进合并失败。常见原因：本地有额外提交、或 git 拒绝覆盖本地改动。',
      ...tail(pull.err.trim().split('\n'), 6),
      '',
      force ? '请手动处理该目录（提交、stash 或 reset）后再试。'
        : '改动可舍弃时用 /update --force 重试；否则手动执行 git stash -u 后再 /update。',
    )
  }

  progress('[5/5] 安装依赖并重建…')
  const install = await runShell(root, pnpmCommand('install --frozen-lockfile'), INSTALL_TIMEOUT_MS)
  if (install.code !== 0) {
    progress('锁定依赖与新代码不一致？改用常规安装重试…')
    const loose = await runShell(root, pnpmCommand('install'), INSTALL_TIMEOUT_MS)
    if (loose.code !== 0) {
      return fail(
        '依赖安装失败（已尝试 frozen 与常规两种模式）：',
        ...tail((loose.err || loose.out).trim().split('\n'), 6),
        '',
        `可进目录手动定位：cd ${root} && pnpm install`,
      )
    }
  }
  const build = await runShell(root, pnpmCommand('run build'), BUILD_TIMEOUT_MS)
  if (build.code !== 0) {
    return fail(
      '重建失败（tsc 报错）：',
      ...tail((build.err || build.out).trim().split('\n'), 6),
      '',
      `可进目录查看完整错误：cd ${root} && pnpm run build`,
    )
  }

  const rebuilt = await probeRebuiltVersion(root)
  const versionLine = rebuilt === undefined ? ''
    : rebuilt === currentVersion ? `版本号仍为 v${rebuilt}（新提交未升版本号）`
    : `版本 v${currentVersion} → v${rebuilt}`
  return {
    ok: true,
    applied: true,
    lines: [
      `已应用 ${Number.isNaN(behindCount) ? '?' : behindCount} 个新提交`
      + `${versionLine === '' ? '' : ' · '}${versionLine}。`,
      '',
      'CHANGELOG 见仓库根目录；运行中的进程仍是旧代码，需重启加载。',
    ],
  }
}

/** Read FX_TUI_VERSION out of the freshly built bundle via cache-busting import. */
async function probeRebuiltVersion(root: string): Promise<string | undefined> {
  try {
    const entry = pathToFileURL(join(root, 'lib', 'index.js'))
    const fresh = (await import(`${entry.href}?fx-update=${Date.now()}`)) as {
      FX_TUI_VERSION?: unknown
    }
    return typeof fresh.FX_TUI_VERSION === 'string' ? fresh.FX_TUI_VERSION : undefined
  } catch {
    return undefined
  }
}
