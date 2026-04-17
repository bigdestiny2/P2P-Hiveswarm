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

// ─── The big boy — shown on `start` ───────────────────────────────

const MAIN_LOGO = [
  '    ██╗  ██╗██╗██╗   ██╗███████╗██████╗ ███████╗██╗      █████╗ ██╗   ██╗',
  '    ██║  ██║██║██║   ██║██╔════╝██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝',
  '    ███████║██║██║   ██║█████╗  ██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ',
  '    ██╔══██║██║╚██╗ ██╔╝██╔══╝  ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ',
  '    ██║  ██║██║ ╚████╔╝ ███████╗██║  ██║███████╗███████╗██║  ██║   ██║   ',
  '    ╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   '
]

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

function gradientLogo () {
  const palette = [C.cyan, C.blue, C.purple, C.magenta, C.pink, C.magenta]
  return MAIN_LOGO.map((line, i) => paint(palette[i % palette.length] + BOLD, line)).join('\n')
}

// ─── Public banners ──────────────────────────────────────────────

export function mainBanner (version) {
  const tagline = pick(TAGLINES)
  const border = paint(C.dim, '═'.repeat(74))
  const lines = [
    '',
    gradientLogo(),
    '',
    '         ' + rainbowLine('▚▞▚▞▚▞▚▞  p2p relay infrastructure  ▚▞▚▞▚▞▚▞'),
    '',
    '   ' + paint(C.green, 'v' + version) + '  ' + paint(C.dim, tagline),
    '   ' + border,
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
