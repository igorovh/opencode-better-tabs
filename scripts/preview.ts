// Renders the tab bar with sample tabs to a PNG, for reviews: bun run preview -- --out bar.png
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Resvg } from "@resvg/resvg-js"
import { RGBA, rgbToHex } from "@opentui/core"
import { sleep, startTui, type Session } from "../test/harness"

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "preview.png" },
    options: { type: "string", default: "{}" },
    hover: { type: "string" },
    width: { type: "string", default: "40" },
    height: { type: "string", default: "30" },
    scale: { type: "string", default: "2" },
  },
})

// A dark palette close to OpenCode's default theme; any other key falls back to the muted text color.
const hex = (value: string) => RGBA.fromHex(value)
const palette = {
  background: {
    raised: { base: hex("#141414"), high: hex("#232323"), max: hex("#2e2e2e") },
    action: { primary: { selected: hex("#3d2c1c") } },
  },
  text: {
    base: hex("#eeeeee"),
    muted: hex("#808080"),
    feedback: { error: { base: hex("#e06c75") }, warning: { base: hex("#e5c07b") } },
  },
  hue: {
    accent: { 200: hex("#fab283"), 300: hex("#f5a742") },
    interactive: { 200: hex("#5c9cf5") },
  },
}
const fallback = hex("#808080")
const themed = (node: any): any =>
  new Proxy(node, {
    get: (target, key) => {
      const value = target[key]
      if (value instanceof RGBA) return value
      if (value && typeof value === "object") return themed(value)
      return key in fallback ? (fallback as any)[key] : themed({})
    },
  })

const sessions: Session[] = [
  { id: "api1", projectID: "api", directory: "/api", title: "Fix the login redirect" },
  { id: "api2", projectID: "api", directory: "/api", title: "Add rate limiting to uploads" },
  { id: "api3", projectID: "api", directory: "/api", title: "Review the billing PR" },
  { id: "web1", projectID: "web", directory: "/web", title: "Dark mode for settings" },
  { id: "web2", projectID: "web", directory: "/web", title: "Flaky checkout test" },
  { id: "docs1", projectID: "docs", directory: "/docs", title: "Write the plugin guide" },
]
const tabState = {
  api1: { active: true },
  api2: { busy: true },
  web1: { attention: true },
  web2: { unread: "error" },
  docs1: { unread: "activity" },
}

// One spare column, since the close cross is wider than its cell in most fonts.
const width = Number(values.width) + 1
const height = Number(values.height)
const dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-preview-"))
writeFileSync(
  path.join(dir, "tabs.json"),
  JSON.stringify({ global: { tabs: sessions.map((session) => ({ sessionID: session.id })), unread: {} }, cwd: {} }),
)
const tui = await startTui({
  stateDir: dir,
  sessions,
  options: JSON.parse(values.options!),
  theme: themed(palette),
  tabState,
  size: { width: Number(values.width) + 40, height },
})
for (let round = 0; round < 5; round++) {
  await sleep(120)
  await tui.flush()
}
if (values.hover) {
  const row = (await tui.frame()).split("\n").findIndex((line) => line.includes(values.hover!))
  if (row === -1) throw new Error(`No row shows "${values.hover}"`)
  await tui.mouse.moveTo(Math.floor(width / 2), row)
  await sleep(120)
}
const frame = await tui.spans()
await tui.stop()
rmSync(dir, { recursive: true, force: true })

const cell = { width: 9, height: 18 }
const base = rgbToHex(palette.background.raised.base)
const color = (value: RGBA, fallbackHex: string) => (value.a === 0 ? fallbackHex : rgbToHex(value))
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const parts: string[] = []
frame.lines.slice(0, height).forEach((line, row) => {
  let col = 0
  for (const span of line.spans) {
    for (const char of span.text) {
      if (col >= width) break
      const x = col * cell.width
      const y = row * cell.height
      parts.push(`<rect x="${x}" y="${y}" width="${cell.width}" height="${cell.height}" fill="${color(span.bg, base)}"/>`)
      if (char.trim())
        parts.push(`<text x="${x}" y="${y + 13}" fill="${color(span.fg, "#eeeeee")}">${escape(char)}</text>`)
      col++
    }
  }
})
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * cell.width}" height="${height * cell.height}">
<rect width="100%" height="100%" fill="${base}"/>
<g font-family="DejaVu Sans Mono, Cascadia Mono, Consolas, monospace" font-size="15">${parts.join("")}</g>
</svg>`
const png = new Resvg(svg, { fitTo: { mode: "zoom", value: Number(values.scale) } }).render().asPng()
writeFileSync(values.out!, png)
console.log(`Wrote ${values.out}`)
