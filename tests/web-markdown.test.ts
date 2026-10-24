import { describe, it, expect } from 'vitest'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import { renderMarkdown, escapeHtml } from '../public/app/markdown.js'

const render = renderMarkdown as (text: string) => string
const escape = escapeHtml as (s: string) => string

/** Every tag the renderer may emit. Anything else that starts with < came from input. */
const OWN_TAGS = /<\/?(?:p|br|strong|em|code|pre|h[1-3]|ul|ol|li|a)(?:\s+(?:href|rel|target|class)="[^"<>]*")*\s*\/?>/g

function strayAngles(html: string): number {
  return (html.replace(OWN_TAGS, '').match(/</g) ?? []).length
}

describe('escapeHtml', () => {
  it('escapes the five HTML specials', () => {
    expect(escape(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  })
})

describe('renderMarkdown safety', () => {
  it('renders an img onerror payload as inert text', () => {
    const html = render('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(strayAngles(html)).toBe(0)
  })
  it('does not turn a javascript: link into a link', () => {
    const html = render('[x](javascript:alert(1))')
    expect(html).not.toContain('<a')
    expect(html).not.toMatch(/href=/)
    expect(html).toContain('[x](javascript:alert(1))')
  })
  it('refuses data: and mixed-case javascript links', () => {
    for (const url of ['JavaScript:alert(1)', 'data:text/html,hi', '//evil.example', 'vbscript:x']) {
      expect(render(`[x](${url})`)).not.toContain('<a')
    }
  })
  it('keeps quotes in a link url from breaking out of the attribute', () => {
    const html = render('[x](https://a.example/"onmouseover="alert(1))')
    expect(html).not.toMatch(/href="[^"]*"\s*onmouseover/)
    expect(strayAngles(html)).toBe(0)
  })
  it('renders script and style tags as text', () => {
    for (const s of ['<script>alert(1)</script>', '<style>body{}</style>', '<svg onload=alert(1)>', '<<b>>', '**<b>x</b>**', '`<x>`', '# <h1>']) {
      expect(strayAngles(render(s))).toBe(0)
    }
  })
  it('never leaks a < inside link text or headings', () => {
    expect(strayAngles(render('[<img src=x>](https://a.example)'))).toBe(0)
    expect(strayAngles(render('## <script>x</script>\n- <i>item</i>\n1. <b>one</b>'))).toBe(0)
  })
})

describe('renderMarkdown formatting', () => {
  it('makes paragraphs and line breaks', () => {
    expect(render('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>')
  })
  it('handles bold, em and nested emphasis', () => {
    expect(render('**bold**')).toBe('<p><strong>bold</strong></p>')
    expect(render('*em*')).toBe('<p><em>em</em></p>')
    expect(render('**bold *and em* here**')).toBe('<p><strong>bold <em>and em</em> here</strong></p>')
  })
  it('handles inline code without formatting inside it', () => {
    expect(render('use `a **b** <c>` now')).toBe('<p>use <code>a **b** &lt;c&gt;</code> now</p>')
  })
  it('keeps < inside fenced code, escaped', () => {
    const html = render('```js\nif (a < b) { x = "<div>" }\n```')
    expect(html).toBe('<pre><code>if (a &lt; b) { x = &quot;&lt;div&gt;&quot; }</code></pre>')
  })
  it('closes an unterminated fence at the end', () => {
    expect(render('```\n<x>')).toBe('<pre><code>&lt;x&gt;</code></pre>')
  })
  it('renders headings 1 to 3', () => {
    expect(render('# A\n## B\n### C')).toBe('<h1>A</h1><h2>B</h2><h3>C</h3>')
  })
  it('renders bullet and numbered lists', () => {
    expect(render('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(render('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })
  it('renders http and https links safely', () => {
    expect(render('[site](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">site</a></p>'
    )
    expect(render('[s](http://x.example/*y*)')).toBe(
      '<p><a href="http://x.example/*y*" rel="noopener noreferrer" target="_blank">s</a></p>'
    )
  })
  it('returns an empty string for empty input', () => {
    expect(render('')).toBe('')
    expect(render('   \n  ')).toBe('')
  })
})
