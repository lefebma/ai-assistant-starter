// A small, escaping markdown renderer. Pure ES module, no DOM: the tests
// import it in node. Input is escaped first and only then formatted, so the
// output never carries a < that came from the input.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
}

// Private-use characters mark held-back spans. Input copies are stripped first.
const HOLD_OPEN = ''
const HOLD_CLOSE = ''
const HOLD_RE = /(\d+)/g

function emphasis(escaped) {
  return escaped
    .replace(/\*\*(?=\S)([^]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
}

function inline(raw) {
  const held = []
  const hold = (html) => {
    held.push(html)
    return HOLD_OPEN + (held.length - 1) + HOLD_CLOSE
  }
  let s = raw.replace(/[]/g, '')
  // Inline code: held back raw, so nothing inside it is formatted.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold('<code>' + escapeHtml(code) + '</code>'))
  // Links: http and https only. Anything else stays as plain text.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return whole
    return hold(
      '<a href="' + escapeHtml(url) + '" rel="noopener noreferrer" target="_blank">' + emphasis(escapeHtml(label)) + '</a>'
    )
  })
  s = emphasis(escapeHtml(s))
  // Held spans can nest (link text keeps code holds), so restore until stable.
  for (let i = 0; i < 3 && HOLD_RE.test(s); i++) {
    HOLD_RE.lastIndex = 0
    s = s.replace(HOLD_RE, (_, n) => held[Number(n)] ?? '')
  }
  return s
}

const FENCE_RE = /^\s*```/
const HEADING_RE = /^(#{1,3})\s+(.*)$/
const BULLET_RE = /^\s*[-*]\s+(.*)$/
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let para = []
  let list = null // { tag, items }

  const flushPara = () => {
    if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>')
    para = []
  }
  const flushList = () => {
    if (list) out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>')
    list = null
  }
  const flush = () => {
    flushPara()
    flushList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      flush()
      const code = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) code.push(lines[i++])
      out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>')
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const h = line.match(HEADING_RE)
    if (h) {
      flush()
      const level = h[1].length
      out.push('<h' + level + '>' + inline(h[2].trim()) + '</h' + level + '>')
      continue
    }
    const b = line.match(BULLET_RE)
    const n = b ? null : line.match(NUMBER_RE)
    if (b || n) {
      flushPara()
      const tag = b ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      if (!list) list = { tag, items: [] }
      list.items.push((b ?? n)[1])
      continue
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // An indented continuation of the last list item.
      list.items[list.items.length - 1] += ' ' + line.trim()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flush()
  return out.join('')
}
