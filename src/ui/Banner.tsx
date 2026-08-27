/**
 * The welcome banner: the first transcript item of a fresh process — an
 * ASCII-art "FX" logo beside the session facts (model, versions, session,
 * workspace) inside a rounded box, Claude-Code-style. Narrow terminals drop
 * the logo before the fact values are allowed to truncate.
 *
 * The banner is committed once as a Static item. While the conversation is
 * shorter than the viewport, the elastic filler in App.tsx keeps the box
 * pinned to the terminal's top edge; once the screen fills, it erodes into
 * scrollback line by line like any other content.
 */

import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import type { BannerItem } from '../store.js'

/** ANSI-shadow "FX"; every line is LOGO_WIDTH cells wide. */
const LOGO = [
  '███████╗ ██╗  ██╗',
  '██╔════╝ ╚██╗██╔╝',
  '█████╗   ╚███╔╝ ',
  '██╔══╝   ██╔██╗ ',
  '██║     ██╔╝ ██╗',
  '╚═╝     ╚═╝  ╚═╝',
]
const LOGO_WIDTH = 17
/** Gap between the logo block and the facts column. */
const LOGO_GAP = 2
/** Fixed label column（`模 型` 等双字标签 5 cells）plus its gap to the value. */
const LABEL_WIDTH = 7
/** Below this content width the logo is dropped so facts stay readable. */
const MIN_INFO_WIDTH = 40

const HINT = '输入消息开始对话 · /help 查看按键与命令'

/** Rendered rows of the banner box (2 borders + content rows); keep in sync with the layout. */
export const BANNER_BOX_HEIGHT = LOGO.length + 2

export function WelcomeBanner(props: { item: BannerItem; width: number }): ReactElement {
  const item = props.item
  // Border (2) + paddingX (2) cannot carry content.
  const inner = Math.max(20, props.width - 4)
  const infoWidth = inner >= LOGO_WIDTH + LOGO_GAP + MIN_INFO_WIDTH
    ? inner - LOGO_WIDTH - LOGO_GAP
    : inner
  const showLogo = infoWidth < inner
  // Reserve one cell for the truncation ellipsis so a cut value never wraps.
  const valueBudget = Math.max(8, infoWidth - LABEL_WIDTH - 1)

  const facts: Array<{ label: string; value: string }> = [
    { label: '模 型', value: item.model },
    {
      label: '版 本',
      value: [
        `fx-tui v${item.fxVersion}`,
        ...(item.dshVersion !== '' ? [`dsh ${item.dshVersion}`] : []),
      ].join(' · '),
    },
    {
      label: '会 话',
      value: `${item.sessionId.slice(0, 21)}${item.resumed ? ' · 已恢复历史会话' : ''}`,
    },
    { label: '目 录', value: homeRelative(item.cwd) },
  ]

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={props.width}
    >
      <Box flexDirection="row">
        {showLogo && (
          <Box flexDirection="column" marginRight={LOGO_GAP}>
            {LOGO.map((line, index) => (
              <Text key={index} color="cyan" bold>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" justifyContent="center">
          {facts.map(fact => (
            <Box key={fact.label}>
              <Box width={LABEL_WIDTH}><Text dimColor>{fact.label}</Text></Box>
              <Text>{truncateLine(fact.value, valueBudget)}</Text>
            </Box>
          ))}
          <Text>{' '}</Text>
          <Text dimColor>{truncateLine(HINT, infoWidth - 1)}</Text>
        </Box>
      </Box>
    </Box>
  )
}

function homeRelative(cwd: string): string {
  const home = process.env.HOME
  if (home === undefined || home === '' || !cwd.startsWith(home)) return cwd
  return `~${cwd.slice(home.length)}`
}

function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = charWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}
