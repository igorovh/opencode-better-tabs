import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { readJson, sleep, startTui, type Session, type Tui } from "./harness"

const sessions: Session[] = ["alpha", "beta"].flatMap((project) =>
  [1, 2].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)
const ids = sessions.map((session) => session.id)

let dir: string
const running: Tui[] = []
const settle = async (...tuis: Tui[]) => {
  for (let round = 0; round < 5; round++) {
    await sleep(120)
    for (const tui of tuis) await tui.flush()
  }
}
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text))
const tabsInFrame = (frame: string) =>
  sessions
    .filter((session) => frame.includes(session.title))
    .sort((left, right) => frame.indexOf(left.title) - frame.indexOf(right.title))
    .map((session) => session.id)
// Moves one row at a time, like a real pointer, so live reordering sees every step.
const drag = async (tui: Tui, from: number, to: number) => {
  await tui.mouse.pressDown(5, from)
  if (to < from) for (let y = from - 1; y >= to; y--) await tui.mouse.emitMouseEvent("drag", 5, y)
  if (to > from) for (let y = from + 1; y <= to; y++) await tui.mouse.emitMouseEvent("drag", 5, y)
  await tui.mouse.release(5, to)
}

afterEach(async () => {
  while (running.length) await running.pop()!.stop()
  rmSync(dir, { recursive: true, force: true })
})

const init = (state?: object) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-custom-"))
  writeFileSync(path.join(dir, "tabs.json"), JSON.stringify({ global: { tabs: ids.map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }))
  if (state) writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
}

// The compiled build is what a GitHub install loads; it must render and react like the source.
for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    const start = async (options: { tabState?: Record<string, Record<string, unknown>> } = {}) => {
      const tui = await startTui({ stateDir: dir, sessions, plugin, ...options })
      running.push(tui)
      return tui
    }

    test("repository grouping stays the default", async () => {
      init()
      const tui = await start()
      await settle(tui)
      const frame = await tui.frame()
      expect(frame).toContain("▾ alpha")
      expect(frame).toContain("▾ beta")
      expect(frame).not.toContain("Ungrouped")
    })

    test("toggling to custom seeds groups from repository names and persists", async () => {
      init()
      const first = await start()
      await settle(first)
      await first.command("better-tabs.grouping")
      await settle(first)
      const state = readJson(dir, "state")
      expect(state.grouping).toBe("custom")
      expect(state.customGroups).toEqual({ alpha1: "alpha", alpha2: "alpha", beta1: "beta", beta2: "beta" })
      expect(await first.frame()).toContain("▾ alpha")
      await first.stop()
      running.pop()

      const second = await start()
      await settle(second)
      expect(await second.frame()).toContain("▾ alpha")
      expect(readJson(dir, "state").grouping).toBe("custom")
    })

    test("the group command moves the active tab to a named group", async () => {
      init()
      const tui = await start({ tabState: { alpha1: { active: true } } })
      await settle(tui)
      await tui.command("better-tabs.set-group", "Red")
      await settle(tui)
      const frame = await tui.frame()
      expect(frame).toContain("▾ Red")
      expect(rowOf(frame, "alpha 1")).toBeGreaterThan(rowOf(frame, "▾ Red"))
      expect(rowOf(frame, "alpha 1")).toBeLessThan(rowOf(frame, "▾ alpha"))
      const state = readJson(dir, "state")
      expect(state.grouping).toBe("custom")
      expect(state.customGroups.alpha1).toBe("Red")
      await tui.stop()
      running.pop()

      const second = await start({ tabState: { alpha1: { active: true } } })
      await settle(second)
      expect(await second.frame()).toContain("▾ Red")
    })

    test("dragging a tab onto another group moves it in custom mode", async () => {
      init()
      const tui = await start()
      await settle(tui)
      await tui.command("better-tabs.grouping")
      await settle(tui)
      const frame = await tui.frame()
      await drag(tui, rowOf(frame, "beta 1"), rowOf(frame, "▾ alpha"))
      await settle(tui)
      expect(tabsInFrame(await tui.frame())).toEqual(["beta1", "alpha1", "alpha2", "beta2"])
      expect(readJson(dir, "state").customGroups.beta1).toBe("alpha")
      expect(tui.hostOrder()).toEqual(["beta1", "alpha1", "alpha2", "beta2"])
    })

    test("dragging a tab onto another group stays inside its group in repository mode", async () => {
      init()
      const tui = await start()
      await settle(tui)
      const frame = await tui.frame()
      const before = tui.hostOrder()
      await drag(tui, rowOf(frame, "beta 1"), rowOf(frame, "▾ alpha"))
      await settle(tui)
      expect(tabsInFrame(await tui.frame())).toEqual(["alpha1", "alpha2", "beta1", "beta2"])
      expect(tui.hostOrder()).toEqual(before)
    })

    test("ungroup moves the current tab back to Ungrouped", async () => {
      init()
      const tui = await start({ tabState: { alpha1: { active: true } } })
      await settle(tui)
      await tui.command("better-tabs.set-group", "Red")
      await settle(tui)
      expect(await tui.frame()).toContain("▾ Red")
      await tui.command("better-tabs.ungroup")
      await settle(tui)
      const frame = await tui.frame()
      expect(frame).toContain("▾ Ungrouped")
      expect(rowOf(frame, "alpha 1")).toBeGreaterThan(rowOf(frame, "▾ Ungrouped"))
      expect(readJson(dir, "state").customGroups.alpha1).toBeUndefined()
    })

    test("dropping a tab on a collapsed group opens that group", async () => {
      init({
        collapsed: { "custom:beta": true },
        autoGroup: true,
        restoreMode: "auto",
        groupOrder: [],
        grouping: "custom",
        customGroups: { alpha1: "alpha", alpha2: "alpha", beta1: "beta", beta2: "beta" },
      })
      const tui = await start({ tabState: { alpha1: { active: true } } })
      await settle(tui)
      const frame = await tui.frame()
      expect(frame).toContain("▸ beta")
      await drag(tui, rowOf(frame, "alpha 2"), rowOf(frame, "▸ beta"))
      await settle(tui)
      const next = await tui.frame()
      expect(next).toContain("▾ beta")
      expect(tabsInFrame(next)).toEqual(["alpha1", "alpha2", "beta1", "beta2"])
      expect(readJson(dir, "state").customGroups.alpha2).toBe("beta")
    })
  })
}
