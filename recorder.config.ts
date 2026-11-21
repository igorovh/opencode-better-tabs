// How `bun run record` and `bun run tui` set up the real OpenCode TUI with this plugin (opencode-tui-recorder).
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defineRecorder } from "opencode-tui-recorder"

export default defineRecorder({
  config: ({ plugin, options }) => ({
    "cli.json": { tabs: { scope: "global", layout: "vertical", mode: "auto" }, plugins: [{ package: plugin, options }] },
  }),
  // Busy and unread tabs need a model run, so show those states with `bun run preview` instead.
  sessions: [
    { project: "api", title: "Fix the login redirect" },
    { project: "api", title: "Add rate limiting to uploads" },
    { project: "web", title: "Dark mode for settings" },
    { project: "web", title: "Flaky checkout test" },
    { project: "docs", title: "Write the plugin guide" },
  ],
  // Tabs show "Untitled session" until the titles load; with many sessions some titles sit below the bar.
  ready: {
    label: "the tab bar with the session titles",
    test: (lines, { sessions }) => lines.some((line) => sessions.some((s) => line.includes(s.title))),
  },
  match: "leftmost",
  // The host restores open tabs from this file; "latest" is the release channel's state directory.
  async seed({ work, sessions }) {
    for (const channel of ["latest", "beta", "dev"]) {
      const dir = path.join(work, "state", "opencode", channel, "tui")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "tabs.json"), JSON.stringify({ global: { tabs: sessions.map((s) => ({ sessionID: s.id })), unread: {} }, cwd: {} }))
    }
  },
  steps: {
    close: {
      usage: "close <text>              hover that row, then click its close cross",
      async run(ctx) {
        const row = await ctx.cell(ctx.arg)
        await ctx.page.mouse.move(row.x, row.y, { steps: 12 })
        await ctx.sleep(400)
        const cross = await ctx.cell(ctx.arg, { char: "✕" })
        await ctx.page.mouse.move(cross.x, cross.y, { steps: 8 })
        await ctx.sleep(400)
        await ctx.page.mouse.click(cross.x, cross.y)
      },
    },
  },
  // --crop keeps the tab bar, which ends a little after the group shortcuts on the right.
  async crop(ctx) {
    const modifier = String(ctx.options.modifier ?? "alt").toLowerCase()
    const hint = new RegExp(`${modifier.replaceAll("+", "\\+")}\\+[a-z0-9]`, "i")
    // Only group headers: the main pane's footer shows shortcuts such as ctrl+p too.
    const headers = (await ctx.screen()).filter((line) => /^\s*[▾▸]/.test(line))
    const end = Math.max(-1, ...headers.map((line) => line.search(hint)).map((at) => (at === -1 ? -1 : at + modifier.length + 2)))
    if (end <= 0) return ""
    const width = await ctx.page.evaluate((cols) => {
      const term = (window as any).term
      const rect = document.querySelector(".xterm-screen")!.getBoundingClientRect()
      return Math.round(rect.left + ((cols + 3) * rect.width) / term.cols)
    }, end)
    return `crop=${width - (width % 2)}:ih:0:0,`
  },
})
