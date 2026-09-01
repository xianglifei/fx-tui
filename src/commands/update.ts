/** /update: self-update the git clone this TUI runs from. All work happens
 * in that directory; the live process keeps its old modules until restart. */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { installedRoot, performSelfUpdate } from '../update.js'
import type { CommandCtx } from './types.js'

export async function runUpdate(c: CommandCtx, force: boolean): Promise<void> {
  if (c.updating()) {
    c.store.addNotice('/update 已在执行中，请等当前一次结束', 'warn')
    return
  }
  c.setUpdating(true)
  try {
    const root = installedRoot()
    if (root === null || !existsSync(resolve(root, '.git'))) {
      c.store.addPanel('fx-tui 无法自更新', [
        `未能定位安装目录或缺少 .git：${root ?? '(unknown)'}`,
        '源码克隆安装才支持 /update；安装步骤见 docs/install.md。',
      ])
      return
    }
    if (root.split('/').includes('node_modules')) {
      c.store.addPanel('检测到包管理器安装', [
        `安装位置在 node_modules 下：${root}`,
        'npm 分发未启用前没有自动升级通道；发布后可用 npm i -g fx-tui 升级。',
        '',
        '提示：按 docs/install.md 做 git 克隆安装即可用 /update 自动升级。',
      ])
      return
    }
    const outcome = await performSelfUpdate(
      { root, force, currentVersion: c.fxVersion },
      (step: string) => c.store.addNotice(step),
    )
    if (outcome.ok && outcome.applied) {
      c.store.addPanel(
        'fx-tui 升级完成',
        [...outcome.lines, '', '重启生效：空输入时双击 Ctrl+C 退出，重新运行 fx'],
      )
    } else if (outcome.ok) {
      c.store.addNotice(outcome.lines[0] ?? '已是最新')
    } else {
      c.store.addPanel('fx-tui 升级未完成', outcome.lines)
    }
  } catch (error) {
    c.store.addNotice(`/update 异常中断：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    c.setUpdating(false)
  }
}
