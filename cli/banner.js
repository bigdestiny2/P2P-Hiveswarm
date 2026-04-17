/**
 * Cypherpunk ASCII banners for the HiveRelay TUI.
 * Pure strings + ANSI escapes — no dependencies.
 */

const ESC = '\x1b['
const RESET = ESC + '0m'
const BOLD = ESC + '1m'

const C = {
  green: ESC + '38;5;46m',
  cyan: ESC + '38;5;51m',
  magenta: ESC + '38;5;201m',
  purple: ESC + '38;5;135m',
  yellow: ESC + '38;5;226m',
  orange: ESC + '38;5;208m',
  red: ESC + '38;5;196m',
  blue: ESC + '38;5;39m',
  pink: ESC + '38;5;213m',
  dim: ESC + '38;5;240m',
  grey: ESC + '38;5;245m',
  white: ESC + '38;5;255m'
}

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR

function paint (color, text) {
  if (!useColor()) return text
  return color + text + RESET
}

// ─── The big boy — 3D extruded, shown on `start` ──────────────────
//
// Layers (front-to-back):
//   1. Top highlight  — bright white bevel above each letter (▁ chars)
//   2. Main face      — gradient-colored solid block letters
//   3. Depth wall     — dim colored extrusion to lower-right (╲ diagonals)
//   4. Floor shadow   — dim offset ghost below (▀ half-blocks, -2 opacity)
//
// The result simulates a 3D-extruded logo lit from the upper-left, with the
// letters floating slightly above a reflective floor.

// Top highlight — thin bright bevel sitting on top of each letter's face
const MAIN_TOP_BEVEL = '    ▁▁   ▁▁ ▁▁ ▁▁   ▁▁ ▁▁▁▁▁▁ ▁▁▁▁▁▁  ▁▁▁▁▁▁ ▁▁      ▁▁▁▁▁  ▁▁   ▁▁ '

const MAIN_LOGO = [
  '    ██╗  ██╗██╗██╗   ██╗███████╗██████╗ ███████╗██╗      █████╗ ██╗   ██╗',
  '    ██║  ██║██║██║   ██║██╔════╝██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝',
  '    ███████║██║██║   ██║█████╗  ██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ',
  '    ██╔══██║██║╚██╗ ██╔╝██╔══╝  ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ',
  '    ██║  ██║██║ ╚████╔╝ ███████╗██║  ██║███████╗███████╗██║  ██║   ██║   ',
  '    ╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   '
]

// Depth-wall — a single row of slim diagonal strokes under the logo,
// offset slightly right to simulate the extrusion casting downward. The
// characters match the column positions of the bottom of each letter.
const MAIN_DEPTH_WALL = '     ▝▘  ▝▘▝▘  ▝▘   ▝▘▝▘▝▘▝▘ ▝▘▝▘▝▘  ▝▘▝▘▝▘▝▘ ▝▘     ▝▘▝▘▝▘  ▝▘   ▝▘  '

// Floor reflection — half-block ▀ under the main logo, slightly offset
const MAIN_FLOOR = '      ▀▀  ▀▀▀▀  ▀▀   ▀▀▀▀▀▀▀ ▀▀▀▀▀▀  ▀▀▀▀▀▀ ▀▀      ▀▀▀▀▀  ▀▀   ▀▀  '

// Honeycomb hive glyph — three interlocking hexagons
const HIVE_GLYPH = [
  '           ⬡⬢⬡           ',
  '         ⬢     ⬢         ',
  '       ⬡   ▲▲▲   ⬡       ',
  '         ⬢  █  ⬢         ',
  '           ⬡⬢⬡           ',
  '         ⬢     ⬢         ',
  '       ⬡         ⬡       ',
  '         ⬢     ⬢         ',
  '           ⬡⬢⬡           '
]

const TAGLINES = [
  '// always-on p2p infrastructure. no central server. no vendor lock.',
  '// encrypted-at-rest. dht-native. federated. unstoppable.',
  '// your laptop sleeps. your app stays online.',
  '// no backend. no account. just keys and peers.',
  '// the relay is not a server — it is a peer that remembers.',
  '// ctrl+c the author. content persists.',
  '// signed, replicated, discoverable. stateless at the edges.',
  '// WE ARE THE INFRASTRUCTURE.'
]

const MATRIX_RAIN = '01· ▚▚ ·10 ▞▞ 11 ·0· ▚▞ 10· ▞▚ 01 ▞▞ ·1· ▚▚ 10· ▞▞ 00 ▚▞ ·1·'

// ─── Helpers ─────────────────────────────────────────────────────

function pick (arr) { return arr[Math.floor(Math.random() * arr.length)] }

function rainbowLine (line) {
  if (!useColor()) return line
  const palette = [C.cyan, C.blue, C.purple, C.magenta, C.pink, C.magenta, C.purple, C.blue]
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') { out += ' '; continue }
    out += palette[i % palette.length] + ch
  }
  return out + RESET
}

// 3D-extruded logo: top bevel + gradient face + depth wall + floor shadow.
// Drawn as stacked rows. In monochrome terminals it falls back to the flat
// gradient, because the depth effect relies entirely on color contrast.
function logo3D () {
  if (!useColor()) return MAIN_LOGO.join('\n')
  const faceGradient = [C.cyan, C.blue, C.purple, C.magenta, C.pink, C.magenta]
  const depthGradient = [C.dim, C.dim, C.grey, C.grey, C.dim, C.dim]

  const lines = []
  // Top highlight bevel — one row of bright ▁ above the logo
  lines.push(paint(C.white + BOLD, MAIN_TOP_BEVEL))
  // Main face with vertical gradient (cyan → blue → purple → magenta → pink)
  for (let i = 0; i < MAIN_LOGO.length; i++) {
    lines.push(paint(faceGradient[i % faceGradient.length] + BOLD, MAIN_LOGO[i]))
  }
  // Depth wall — single row of diagonal extrusion marks below the logo
  lines.push(paint(depthGradient[0], MAIN_DEPTH_WALL))
  // Floor shadow — dim half-block reflection
  lines.push(paint(C.grey, MAIN_FLOOR))
  return lines.join('\n')
}

// ─── Public banners ──────────────────────────────────────────────

export function mainBanner (version) {
  const tagline = pick(TAGLINES)
  // Cyberpunk frame corners — looks like an old CRT / oscilloscope
  const topFrame = paint(C.cyan, '   ╱═══') + paint(C.dim, '╾──────────────────────────────────────────────────────────╼') + paint(C.cyan, '═══╲')
  const botFrame = paint(C.cyan, '   ╲═══') + paint(C.dim, '╾──────────────────────────────────────────────────────────╼') + paint(C.cyan, '═══╱')
  const lines = [
    '',
    topFrame,
    logo3D(),
    '',
    '         ' + rainbowLine('▚▞▚▞▚▞▚▞  p2p relay infrastructure  ▚▞▚▞▚▞▚▞'),
    '',
    '   ' + paint(C.green, 'v' + version) + '  ' + paint(C.dim, tagline),
    botFrame,
    ''
  ]
  return lines.join('\n')
}

export function setupBanner (version) {
  const lines = [
    '',
    paint(C.cyan + BOLD, '  ╔══════════════════════════════════════════════════════════════╗'),
    paint(C.cyan + BOLD, '  ║') + paint(C.magenta + BOLD, '         H I V E R E L A Y  ·  I N I T I A L I Z E            ') + paint(C.cyan + BOLD, '║'),
    paint(C.cyan + BOLD, '  ║') + paint(C.dim, '              [ cypherpunk p2p infrastructure ]               ') + paint(C.cyan + BOLD, '║'),
    paint(C.cyan + BOLD, '  ╚══════════════════════════════════════════════════════════════╝'),
    '',
    '  ' + paint(C.green, '>') + ' ' + paint(C.white, 'hiverelay ') + paint(C.dim, 'v' + version) + '  ' + paint(C.cyan, '// no gods. no masters. just peers.'),
    ''
  ]
  return lines.join('\n')
}

export function testnetBanner (version) {
  const lines = [
    '',
    paint(C.yellow, '    ╓─╥──────────────────────────────────────────────╥─╖'),
    paint(C.yellow, '    ║ ') + paint(C.green + BOLD, '⬢') + paint(C.cyan + BOLD, '  H I V E R E L A Y  ') + paint(C.purple, '╳  ') + paint(C.pink + BOLD, 'T E S T N E T') + '  ' + paint(C.green + BOLD, '⬡') + paint(C.yellow, ' ║'),
    paint(C.yellow, '    ║ ') + paint(C.dim, '  three relays · one client · zero external deps') + paint(C.yellow, '  ║'),
    paint(C.yellow, '    ╙─╨──────────────────────────────────────────────╨─╜'),
    '',
    '  ' + paint(C.dim, '[') + paint(C.green, 'ok') + paint(C.dim, '] ') + paint(C.white, 'v' + version) + '  ' + paint(C.magenta, MATRIX_RAIN),
    ''
  ]
  return lines.join('\n')
}

export function statusBanner () {
  const lines = [
    '',
    '  ' + paint(C.green, '⬢') + paint(C.cyan, '⬡') + paint(C.green, '⬢') + ' ' + paint(C.cyan + BOLD, 'HIVERELAY STATUS') + ' ' + paint(C.green, '⬢') + paint(C.cyan, '⬡') + paint(C.green, '⬢'),
    '  ' + paint(C.dim, '────────────────────────'),
    ''
  ]
  return lines.join('\n')
}

export function helpBanner (version) {
  const lines = [
    '',
    paint(C.green + BOLD, '     ┌─────────────────────────────────────────────────────────────┐'),
    paint(C.green + BOLD, '     │  ') + paint(C.cyan + BOLD, 'H   I   V   E   R   E   L   A   Y') + '   ' + paint(C.magenta, 'v' + version) + '  ' + '  '.padEnd(9) + paint(C.green + BOLD, '│'),
    paint(C.green + BOLD, '     │  ') + paint(C.dim, '// peer-to-peer relay infrastructure for the cypherpunk era') + paint(C.green + BOLD, '│'),
    paint(C.green + BOLD, '     └─────────────────────────────────────────────────────────────┘'),
    ''
  ]
  return lines.join('\n')
}

// Operator management console — shown when entering `hiverelay manage` TUI.
// Clears screen and displays a compact 3D logo + connection strip so the
// operator immediately knows what they're configuring.
export function manageBanner (host, port, version) {
  // Scan-line effect across the top
  const scan = '▁'.repeat(70)
  const rule = '═'.repeat(70)
  const endpoint = `${host}:${port}`

  if (!useColor()) {
    return [
      '',
      '  ╔' + '═'.repeat(68) + '╗',
      '  ║   HIVERELAY MANAGEMENT CONSOLE · v' + version + ' '.repeat(Math.max(0, 30 - version.length)) + '║',
      '  ║   Connected → ' + endpoint.padEnd(52) + '║',
      '  ╚' + '═'.repeat(68) + '╝',
      ''
    ].join('\n')
  }

  const clear = '\x1b[2J\x1b[H'
  return [
    clear,
    '',
    paint(C.cyan, '  ╱▔') + paint(C.dim, scan) + paint(C.cyan, '▔╲'),
    // Compact 3D title row — letter-spaced with depth shading
    '  ' + paint(C.cyan + BOLD, '│ ') +
      paint(C.cyan + BOLD, '█▀█') + ' ' + paint(C.blue + BOLD, '█') + ' ' +
      paint(C.purple + BOLD, '█') + ' ' + paint(C.magenta + BOLD, '█▀▀') + ' ' +
      paint(C.pink + BOLD, '█▀█') + ' ' + paint(C.magenta + BOLD, '█▀▀') + ' ' +
      paint(C.purple + BOLD, '█') + ' ' + paint(C.blue + BOLD, '█▀█') + ' ' +
      paint(C.cyan + BOLD, '█▄█') + '   ' +
      paint(C.white + BOLD, 'MANAGEMENT CONSOLE') + '  ' + paint(C.cyan + BOLD, '│'),
    '  ' + paint(C.cyan + BOLD, '│ ') +
      paint(C.cyan + BOLD, '█▀█') + ' ' + paint(C.blue + BOLD, '█') + ' ' +
      paint(C.purple + BOLD, '█') + ' ' + paint(C.magenta + BOLD, '█▀▀') + ' ' +
      paint(C.pink + BOLD, '██▀') + ' ' + paint(C.magenta + BOLD, '█▀▀') + ' ' +
      paint(C.purple + BOLD, '█') + ' ' + paint(C.blue + BOLD, '█▀█') + ' ' +
      paint(C.cyan + BOLD, ' █ ') + '   ' +
      paint(C.dim, '// operator control plane       ') + paint(C.cyan + BOLD, ' │'),
    '  ' + paint(C.cyan + BOLD, '│ ') +
      paint(C.cyan + BOLD, '▀ ▀') + ' ' + paint(C.blue + BOLD, '▀') + ' ' +
      paint(C.purple + BOLD, '▀') + ' ' + paint(C.magenta + BOLD, '▀▀▀') + ' ' +
      paint(C.pink + BOLD, '▀ ▀') + ' ' + paint(C.magenta + BOLD, '▀▀▀') + ' ' +
      paint(C.purple + BOLD, '▀▀▀') + ' ' + paint(C.blue + BOLD, '▀ ▀') + ' ' +
      paint(C.cyan + BOLD, ' ▀ ') + '   ' + ' '.repeat(32) + paint(C.cyan + BOLD, '│'),
    '  ' + paint(C.cyan, '╲▁') + paint(C.dim, rule) + paint(C.cyan, '▁╱'),
    '',
    '  ' + paint(C.green, '⬢') + ' ' + paint(C.cyan, 'link:     ') + paint(C.white + BOLD, endpoint) +
      '   ' + paint(C.green, '⬢') + ' ' + paint(C.cyan, 'v') + paint(C.magenta, version) +
      '   ' + paint(C.dim, '// ctrl+c to exit // q to back'),
    ''
  ].join('\n')
}

// Sub-menu header — used inside each settings page so every screen feels
// part of the same cypherpunk UI.
export function sectionHeader (title, subtitle = '') {
  if (!useColor()) {
    return [
      '',
      '  ── ' + title + ' ' + '─'.repeat(Math.max(4, 60 - title.length)),
      subtitle ? '  // ' + subtitle : null,
      ''
    ].filter(Boolean).join('\n')
  }
  const bar = '─'.repeat(Math.max(4, 60 - title.length))
  return [
    '',
    '  ' + paint(C.cyan + BOLD, '▓▓▓') + ' ' + paint(C.magenta + BOLD, title.toUpperCase()) +
      ' ' + paint(C.cyan, bar),
    subtitle ? '  ' + paint(C.dim, '// ' + subtitle) : null,
    ''
  ].filter(Boolean).join('\n')
}

export function shutdownBanner () {
  if (!useColor()) return '\n  signing off. fnord.\n'
  const lines = [
    '',
    '  ' + paint(C.red, '⬢') + ' ' + paint(C.dim, 'disconnecting from the swarm...'),
    '  ' + paint(C.dim, '// until next time, keep your keys close and your peers closer.'),
    ''
  ]
  return lines.join('\n')
}

export function divider (ch = '─', color = C.dim) {
  const width = Math.min(process.stdout.columns || 78, 78)
  return paint(color, ch.repeat(width))
}

// Mini hex icon — useful inline
export const HEX = useColor() ? paint(C.green, '⬢') : '*'
export const HEX_DIM = useColor() ? paint(C.dim, '⬡') : '.'
export const OK = useColor() ? paint(C.green, '✓') : '[ok]'
export const WARN = useColor() ? paint(C.yellow, '⚠') : '[!]'
export const ERR = useColor() ? paint(C.red, '✗') : '[x]'
export const ARROW = useColor() ? paint(C.cyan, '▶') : '>'

export { C, paint, HIVE_GLYPH, MATRIX_RAIN }
