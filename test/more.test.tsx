import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { sleep, startTui, type Session, type Tui } from "./harness"

// Two groups of four: 13 rows with the gaps and the "New session" row.
const sessions: Session[] = ["alpha", "beta"].flatMap((project) =>
  [1, 2, 3, 4].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)

let dir: string
const running: Tui[] = []
const lines = (frame: string) => frame.split("\n")
const settle = async (tui: Tui) => {
  for (let round = 0; round < 5; round++) {
    await sleep(120)
    await tui.flush()
  }
}

afterEach(async () => {
  while (running.length) await running.pop()!.stop()
  rmSync(dir, { recursive: true, force: true })
})

const start = async (plugin: typeof sourcePlugin, height: number) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-more-"))
  writeFileSync(
    path.join(dir, "tabs.json"),
    JSON.stringify({ global: { tabs: sessions.map((session) => ({ sessionID: session.id })), unread: {} }, cwd: {} }),
  )
  const tui = await startTui({ stateDir: dir, sessions, plugin, size: { width: 80, height } })
  running.push(tui)
  await settle(tui)
  return tui
}

for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    test("counts the sessions below the bar on its last line", async () => {
      const tui = await start(plugin, 10)
      const frame = await tui.frame()

      // The last two lines hold a blank line and the count, so beta 1-4 are hidden below the beta header.
      expect(lines(frame)[8]!.trim()).toBe("")
      expect(lines(frame)[9]).toContain("and 4 more sessions")
      expect(frame).toContain("▾ beta")
      expect(frame).not.toContain("beta 1")
    })

    test("shows nothing when only the New session row is below the bar", async () => {
      const tui = await start(plugin, 12)
      const frame = await tui.frame()

      expect(frame).toContain("beta 4")
      expect(frame).not.toContain("more session")
    })

    test("scrolls down on click until every session is in view", async () => {
      const tui = await start(plugin, 10)
      await tui.mouse.click(20, 9)
      await settle(tui)
      const frame = await tui.frame()

      expect(frame).toContain("beta 4")
      expect(frame).not.toContain("more session")
    })
  })
}
