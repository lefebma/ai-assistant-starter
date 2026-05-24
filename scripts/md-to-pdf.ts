#!/usr/bin/env -S npx tsx
/**
 * Convert a markdown file to a styled PDF using Playwright (Chromium).
 * Usage: npx tsx scripts/md-to-pdf.ts <input.md> [output.pdf]
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'
import { chromium } from 'playwright'

const CSS = `
@page { size: Letter; margin: 0.75in 0.75in 0.9in 0.75in; }
* { box-sizing: border-box; }
html, body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.5;
  color: #1a2332;
  margin: 0;
  padding: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1 {
  font-size: 22pt;
  color: #1a2332;
  border-bottom: 3px solid #2563eb;
  padding-bottom: 0.3em;
  margin: 0 0 0.6em 0;
  page-break-after: avoid;
}
h2 {
  font-size: 15pt;
  color: #1a2332;
  margin: 1.4em 0 0.4em 0;
  border-bottom: 1px solid #d1d5db;
  padding-bottom: 0.2em;
  page-break-after: avoid;
}
h3 {
  font-size: 12pt;
  color: #1a2332;
  margin: 1.2em 0 0.3em 0;
  page-break-after: avoid;
}
h4 { font-size: 10.5pt; color: #374151; margin: 0.8em 0 0.3em 0; }
p { margin: 0.4em 0 0.7em 0; }
strong { color: #1a2332; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: #f3f4f6;
  padding: 0.1em 0.35em;
  border-radius: 3px;
}
pre {
  background: #f3f4f6;
  border-left: 3px solid #2563eb;
  padding: 0.7em 1em;
  border-radius: 3px;
  overflow-x: auto;
  font-size: 9pt;
  line-height: 1.4;
}
ul, ol { margin: 0.4em 0 0.8em 0; padding-left: 1.4em; }
li { margin: 0.15em 0; }
li > p { margin: 0.1em 0; }
blockquote {
  border-left: 3px solid #2563eb;
  background: #f8fafc;
  margin: 0.8em 0;
  padding: 0.5em 1em;
  color: #475569;
  font-style: italic;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.7em 0;
  font-size: 9.5pt;
  page-break-inside: avoid;
}
th, td {
  border: 1px solid #d1d5db;
  padding: 0.45em 0.7em;
  text-align: left;
  vertical-align: top;
}
th {
  background: #1a2332;
  color: #ffffff;
  font-weight: 600;
}
tr:nth-child(even) td { background: #f8fafc; }
hr {
  border: none;
  border-top: 1px solid #e5e7eb;
  margin: 1.5em 0;
}
em { color: #475569; }
.footer {
  position: fixed;
  bottom: 0.4in;
  left: 0.75in;
  right: 0.75in;
  font-size: 8.5pt;
  color: #9ca3af;
  border-top: 1px solid #e5e7eb;
  padding-top: 0.3em;
  display: flex;
  justify-content: space-between;
}
`

async function main() {
  const inputArg = process.argv[2]
  if (!inputArg) {
    console.error('Usage: npx tsx scripts/md-to-pdf.ts <input.md> [output.pdf]')
    process.exit(1)
  }
  const input = resolve(inputArg)
  const output = process.argv[3]
    ? resolve(process.argv[3])
    : input.replace(/\.md$/, '.pdf')

  const md = readFileSync(input, 'utf-8')
  const html = marked.parse(md, { async: false }) as string
  const title = basename(input, '.md')

  const fullHtml = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<style>${CSS}</style>
</head><body>
${html}
</body></html>`

  const tmp = mkdtempSync(join(tmpdir(), 'md2pdf-'))
  const htmlPath = join(tmp, 'doc.html')
  writeFileSync(htmlPath, fullHtml)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: 'networkidle' })
  await page.pdf({
    path: output,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.75in', bottom: '0.9in', left: '0.75in', right: '0.75in' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="font-size:8.5pt;color:#9ca3af;width:100%;padding:0 0.75in;display:flex;justify-content:space-between;">
      <span>ELS Partners</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`,
  })
  await browser.close()

  console.log(`PDF written: ${output}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
