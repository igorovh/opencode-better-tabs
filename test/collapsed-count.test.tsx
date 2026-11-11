import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { sleep, startTui, type Session, type Tui } from "./harness"

const sessions: Session[] = ["alpha", "beta"].flatMap((project) =>
  [1, 2, 3].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)

let dir: string
const running: Tui[] = []
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

const startWith = async (
  plugin: typeof sourcePlugin,
  list: Session[],
  collapsed: Record<string, boolean>,
) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-collapsed-"))
  writeFileSync(
    path.join(dir, "tabs.json"),
    JSON.stringify({ global: { tabs: list.map((session) => ({ sessionID: session.id })), unread: {} }, cwd: {} }),
  )
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ collapsed, autoGroup: true, restoreMode: "auto", groupOrder: [] }),
  )
  const tui = await startTui({ stateDir: dir, sessions: list, plugin })
  running.push(tui)
  await settle(tui)
  return tui
}

for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    test("a collapsed group shows its tab count, expanded groups do not", async () => {
      const tui = await startWith(plugin, sessions, { alpha: true })
      const frame = await tui.frame()

      expect(frame.includes("▸ alpha (3)")).toBe(true)
      expect(frame.includes("▾ beta")).toBe(true)
      expect(frame.includes("beta (")).toBe(false)
    })

    test("the count is dropped before the name is truncated", async () => {
      const longName = "averyveryverylongprojectname"
      const list: Session[] = [1, 2].map((n) => ({
        id: `long${n}`,
        projectID: longName,
        directory: `/${longName}`,
        title: `t${n}`,
      }))
      const tui = await startWith(plugin, list, { [longName]: true })
      const frame = await tui.frame()

      expect(frame.includes(longName)).toBe(true)
      expect(frame.includes("(2)")).toBe(false)
    })

    test("a very long name truncates without the count", async () => {
      const veryLong = "averyveryveryverylongprojectname123456"
      const list: Session[] = [1, 2].map((n) => ({
        id: `vlong${n}`,
        projectID: veryLong,
        directory: `/${veryLong}`,
        title: `t${n}`,
      }))
      const tui = await startWith(plugin, list, { [veryLong]: true })
      const frame = await tui.frame()

      expect(frame.includes("(2)")).toBe(false)
      expect(frame.includes("…")).toBe(true)
    })
  })
}
