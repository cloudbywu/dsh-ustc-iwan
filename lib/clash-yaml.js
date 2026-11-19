import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const field = 'route-exclude-address'
const rejected = () => { throw new Error('unsupported-yaml') }
export const TUN_MAP_MISSING = 'tun-map-missing'

function document(buffer) {
  const text = decoder.decode(buffer)
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]|\r(?!\n)/u.test(text)) rejected()
  const doc = parseDocument(text, { strict: true, uniqueKeys: true })
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.tag || doc.contents.anchor) rejected()
  return { root: doc.contents, text }
}

// Refuse complex mapping keys/merges at the two levels which can affect the
// selected path. Never resolve aliases or re-serialize any unrelated node.
function child(map, name) {
  for (const { key } of map.items) {
    if (!isScalar(key) || typeof key.value !== 'string' || key.tag || key.anchor || key.value === '<<') rejected()
  }
  return map.items.find(({ key }) => key.value === name)
}

function clean(node) {
  return !node || !(isAlias(node) || node.tag || node.anchor)
}

function lineStart(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1
}

export function readTunExclusions(buffer, { generated = false } = {}) {
  const { root, text } = document(buffer)
  const tun = child(root, 'tun')?.value
  if (!tun && generated) return { entries: [] }
  if (!generated && !tun) throw new Error(TUN_MAP_MISSING)
  if (!generated && clean(tun) && ((isScalar(tun) && tun.value === null) || (isMap(tun) && !tun.items.length))) {
    throw new Error(TUN_MAP_MISSING)
  }
  if (!isMap(tun) || !clean(tun) || (!generated && (tun.flow || root.flow))) rejected()
  const pair = child(tun, field)
  if (pair && !clean(pair.value)) rejected()
  const value = pair?.value
  let entries = []
  if (isSeq(value)) {
    entries = value.items.map(item => {
      if (!isScalar(item) || !clean(item) || typeof item.value !== 'string' || !item.range) rejected()
      return item.value
    })
  } else if (pair && !(isScalar(value) && value.value === null)) rejected()
  const auto = child(tun, 'auto-route')?.value
  const autoRoute = isScalar(auto) && clean(auto) && typeof auto.value === 'boolean' ? auto.value : null
  return { entries, autoRoute, append: generated ? undefined : add => patch(text, tun, pair, add) }
}

function patch(text, tun, pair, add) {
  if (!add.length) return Buffer.from(text)
  const start = lineStart(text, tun.items[0].key.range[0])
  const indent = text.slice(start, tun.items[0].key.range[0])
  if (!/^ +$/.test(indent)) rejected()
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = margin => add.map(entry => margin + '- ' + entry + newline).join('')
  const replace = (from, to, insert) => Buffer.from(text.slice(0, from) + insert + text.slice(to))
  if (!pair) return replace(start, start, indent + field + ':' + newline + lines(indent))

  const value = pair.value
  const [keyStart, keyEnd] = pair.key.range
  if (text.slice(lineStart(text, keyStart), keyStart) !== indent) rejected()
  if (isSeq(value) && value.flow && value.items.length) {
    const [from, to] = value.range
    if (text[to - 1] !== ']' || /[\r\n]/.test(text.slice(from, to))) rejected()
    const lastEnd = value.items.at(-1).range[1]
    if (!/^ *,? *$/.test(text.slice(lastEnd, to - 1))) rejected()
    return replace(lastEnd, lastEnd, ', ' + add.join(', '))
  }
  if (isSeq(value) && !value.flow && value.items.length) {
    const [from, to] = value.items.at(-1).range
    const margin = /^( *)- +$/.exec(text.slice(lineStart(text, from), from))?.[1]
    if (!margin || /[\r\n]/.test(text.slice(from, to))) rejected()
    const eol = text.indexOf('\n', to)
    if (eol === -1) return replace(text.length, text.length, newline + lines(margin))
    return replace(eol + 1, eol + 1, lines(margin))
  }

  // Turn generated [] (or plain null/blank) into a block list, removing
  // only the value and keeping the key's inline comment verbatim.
  const [from, to] = value.range
  const colon = text.indexOf(':', keyEnd)
  if (colon < 0 || colon > from || /[\r\n]/.test(text.slice(keyEnd, to))) rejected()
  if (isSeq(value) && !/^\[ *\]$/.test(text.slice(from, to))) rejected()
  const eol = text.indexOf('\n', to)
  const end = eol === -1 ? text.length : eol + 1
  return replace(from, end, text.slice(to, end) + (eol === -1 ? newline : '') + lines(indent))
}

// In v2.5.10 the GUI switch is persisted separately from Clash's tun.enable.
export function readTunSwitch(buffer) {
  const { root } = document(buffer)
  const pair = child(root, 'enable_tun_mode')
  if (!pair) return false
  const value = pair.value
  if (!isScalar(value) || !clean(value) || (value.value !== null && typeof value.value !== 'boolean')) rejected()
  return value.value ?? false
}
