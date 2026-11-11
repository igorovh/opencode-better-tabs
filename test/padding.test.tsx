import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { sleep, startTui, type Session, type Tui } from "./harness"

const sessions: Session[] = ["alpha", "beta", "gamma"].flatMap((project) =>
  [1, 2].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)

let dir: string
const running: Tui[] = []
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text))
const blank = (frame: string, row: number) => frame.split("\n")[row]?.trim() === ""
const groupsInFrame = (frame: string) =>
  ["alpha", "beta", "gamma"].filter((name) => frame.includes(`▾ ${name}`)).sort(
    (left, right) => frame.indexOf(`▾ ${left}`) - frame.indexOf(`▾ ${right}`),
  )
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

const start = async (plugin: typeof sourcePlugin, padding?: number, list = sessions) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-padding-"))
  writeFileSync(
    path.join(dir, "tabs.json"),
    JSON.stringify({ global: { tabs: list.map((session) => ({ sessionID: session.id })), unread: {} }, cwd: {} }),
  )
  const tui = await startTui({
    stateDir: dir,
    sessions: list,
    plugin,
    options: padding === undefined ? {} : { padding },
  })
  running.push(tui)
  await settle(tui)
  return tui
}

for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    test("pads every row with a blank line above and below when asked", async () => {
      const tui = await start(plugin, 1)
      const frame = await tui.frame()
      const first = rowOf(frame, "alpha 1")

      expect(first).toBeGreaterThan(0)
      expect(blank(frame, first - 1)).toBe(true)
      expect(blank(frame, first + 1)).toBe(true)
      expect(rowOf(frame, "alpha 2") - first).toBe(3)
      expect(rowOf(frame, "alpha 1") - rowOf(frame, "▾ alpha")).toBe(3)
    })

    test("pads the new-session row too", async () => {
      const tui = await start(plugin, 1, sessions.slice(0, 2))
      const frame = await tui.frame()
      const newSession = rowOf(frame, "+ New session")

      // Bottom padding of "alpha 2", the spacer, then the top padding of the new-session row.
      expect(newSession - rowOf(frame, "alpha 2")).toBe(4)
      expect(blank(frame, newSession + 1)).toBe(true)
    })

    test("keeps rows on consecutive lines by default", async () => {
      const tui = await start(plugin)
      const frame = await tui.frame()
      const first = rowOf(frame, "alpha 1")

      expect(rowOf(frame, "alpha 2") - first).toBe(1)
      expect(rowOf(frame, "alpha 1") - rowOf(frame, "▾ alpha")).toBe(1)
    })

    test("dropping on a padded header still drops before that header", async () => {
      const tui = await start(plugin, 1)
      const frame = await tui.frame()
      const from = rowOf(frame, "▾ gamma")
      const to = rowOf(frame, "▾ alpha")

      await tui.mouse.pressDown(5, from)
      for (let y = from - 1; y >= to; y--) await tui.mouse.emitMouseEvent("drag", 5, y)
      await tui.mouse.release(5, to)
      await settle(tui)

      expect(groupsInFrame(await tui.frame())).toEqual(["gamma", "alpha", "beta"])
    })

    test("dropping on the bottom padding of a header drops after that group", async () => {
      const tui = await start(plugin, 1)
      const frame = await tui.frame()
      const from = rowOf(frame, "▾ gamma")
      const to = rowOf(frame, "▾ alpha") + 1

      await tui.mouse.pressDown(5, from)
      for (let y = from - 1; y >= to; y--) await tui.mouse.emitMouseEvent("drag", 5, y)
      await tui.mouse.release(5, to)
      await settle(tui)

      expect(groupsInFrame(await tui.frame())).toEqual(["alpha", "gamma", "beta"])
    })
  })
}
