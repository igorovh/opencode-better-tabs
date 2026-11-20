import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MouseButtons } from "@opentui/core/testing"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { METADATA_KEY, metadataParent, resolveParents } from "../src/sub-sessions"
import { readJson, sleep, startTui, type Session, type Tui } from "./harness"

const base: Session[] = ["alpha", "beta"].flatMap((project) =>
  [1, 2].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)
const withParent = (id: string, link: Partial<Session>) => base.map((session) => (session.id === id ? { ...session, ...link } : session))

let dir: string
const running: Tui[] = []
const settle = async (...tuis: Tui[]) => {
  for (let round = 0; round < 5; round++) {
    await sleep(120)
    for (const tui of tuis) await tui.flush()
  }
}
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text))
const lineOf = (frame: string, text: string) => frame.split("\n").find((line) => line.includes(text)) ?? ""
const tabsInFrame = (frame: string) =>
  base
    .filter((session) => frame.includes(session.title))
    .sort((left, right) => frame.indexOf(left.title) - frame.indexOf(right.title))
    .map((session) => session.id)
const drag = async (tui: Tui, from: number, to: number) => {
  await tui.mouse.pressDown(5, from)
  if (to < from) for (let y = from - 1; y >= to; y--) await tui.mouse.emitMouseEvent("drag", 5, y)
  if (to > from) for (let y = from + 1; y <= to; y++) await tui.mouse.emitMouseEvent("drag", 5, y)
  await tui.mouse.release(5, to)
}

afterEach(async () => {
  while (running.length) await running.pop()!.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const init = (ids: string[], state?: object) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-sub-"))
  writeFileSync(path.join(dir, "tabs.json"), JSON.stringify({ global: { tabs: ids.map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }))
  if (state) writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
}
const allIDs = base.map((session) => session.id)
const state = (fields: object) => ({
  collapsed: {},
  autoGroup: true,
  restoreMode: "auto",
  groupOrder: [],
  grouping: "repo",
  customGroups: {},
  parents: {},
  ...fields,
})

describe("resolveParents", () => {
  test("maps sub-sessions to the top open tab and ignores closed parents and cycles", () => {
    const links: Record<string, string> = { b: "a", c: "b", d: "closed", x: "y", y: "x" }
    const result = resolveParents(["a", "b", "c", "d", "x", "y"], (id) => links[id])
    expect(Object.fromEntries(result)).toEqual({ b: "a", c: "a" })
  })

  test("reads the parent from session metadata", () => {
    expect(metadataParent({ [METADATA_KEY]: { parent: "ses_1" } })).toBe("ses_1")
    expect(metadataParent({ [METADATA_KEY]: { parent: null } })).toBeNull()
    expect(metadataParent({ other: true })).toBeUndefined()
    expect(metadataParent(undefined)).toBeUndefined()
  })
})

for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    const start = async (options: Partial<Parameters<typeof startTui>[0]> = {}) => {
      const tui = await startTui({ stateDir: dir, sessions: base, plugin, ...options })
      running.push(tui)
      return tui
    }

    test("a sub-session from another repository shows under its parent", async () => {
      init(allIDs)
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }) })
      await settle(tui)
      const frame = await tui.frame()
      expect(tabsInFrame(frame)).toEqual(["alpha1", "beta1", "alpha2", "beta2"])
      expect(rowOf(frame, "beta 1")).toBe(rowOf(frame, "alpha 1") + 1)
      expect(lineOf(frame, "beta 1")).toContain("└")
      expect(lineOf(frame, "alpha 1")).toContain("alpha 1 +1")
      expect(rowOf(frame, "beta 1")).toBeLessThan(rowOf(frame, "▾ beta"))
      expect(tui.hostOrder()).toEqual(["alpha1", "beta1", "alpha2", "beta2"])
    })

    test("the subSessions option turns sub-sessions off", async () => {
      init(allIDs)
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }), options: { subSessions: false } })
      await settle(tui)
      const frame = await tui.frame()
      expect(lineOf(frame, "beta 1")).not.toContain("└")
      expect(lineOf(frame, "alpha 1")).not.toContain("+1")
      expect(rowOf(frame, "beta 1")).toBeGreaterThan(rowOf(frame, "▾ beta"))
      expect(() => tui.command("better-tabs.attach")).toThrow()
    })

    test("the agent's metadata link works, and a detach in the bar overrides it", async () => {
      init(allIDs, state({ parents: { alpha2: null } }))
      const sessions = base.map((session) =>
        session.id === "beta1" || session.id === "alpha2"
          ? { ...session, metadata: { [METADATA_KEY]: { parent: session.id === "beta1" ? "alpha1" : "beta2" } } }
          : session,
      )
      const tui = await start({ sessions })
      await settle(tui)
      const frame = await tui.frame()
      expect(rowOf(frame, "beta 1")).toBe(rowOf(frame, "alpha 1") + 1)
      expect(lineOf(frame, "alpha 2")).not.toContain("└")
    })

    test("a sub-session goes back to its own group when its parent tab closes", async () => {
      init(["alpha2", "beta1", "beta2"])
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }) })
      await settle(tui)
      const frame = await tui.frame()
      expect(lineOf(frame, "beta 1")).not.toContain("└")
      expect(rowOf(frame, "beta 1")).toBeGreaterThan(rowOf(frame, "▾ beta"))
    })

    test("in custom mode a sub-session follows its parent and keeps its own group for later", async () => {
      init(allIDs, state({ grouping: "custom", customGroups: { alpha1: "Red", beta1: "Blue" } }))
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }), tabState: { beta1: { active: true } } })
      await settle(tui)
      let frame = await tui.frame()
      expect(frame).toContain("▾ Red")
      expect(frame).not.toContain("▾ Blue")
      expect(rowOf(frame, "beta 1")).toBe(rowOf(frame, "alpha 1") + 1)

      await tui.command("better-tabs.detach")
      await settle(tui)
      frame = await tui.frame()
      expect(frame).toContain("▾ Blue")
      expect(rowOf(frame, "beta 1")).toBeGreaterThan(rowOf(frame, "▾ Blue"))
      const saved = readJson(dir, "state")
      expect(saved.parents.beta1).toBeNull()
      expect(saved.customGroups.beta1).toBe("Blue")
    })

    test("/group refuses to move a sub-session away from its parent", async () => {
      init(allIDs, state({ grouping: "custom" }))
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }), tabState: { beta1: { active: true } } })
      await settle(tui)
      await tui.command("better-tabs.set-group", "Red")
      await settle(tui)
      expect(readJson(dir, "state").customGroups.beta1).toBeUndefined()
      expect(tui.toasts.at(-1)).toContain("/detach")
    })

    test("the tab menu attaches a tab to another one", async () => {
      init(allIDs)
      const tui = await start({
        dialog: {
          select: (dialog) =>
            dialog.options.find((option: { title: string }) => option.title === "Attach to a tab…")?.value ?? "alpha2",
        },
      })
      await settle(tui)
      await tui.mouse.click(5, rowOf(await tui.frame(), "beta 2"), MouseButtons.RIGHT)
      await settle(tui)
      const frame = await tui.frame()
      expect(rowOf(frame, "beta 2")).toBe(rowOf(frame, "alpha 2") + 1)
      expect(readJson(dir, "state").parents.beta2).toBe("alpha2")
    })

    test("dragging a parent moves its sub-sessions with it", async () => {
      init(allIDs)
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }) })
      await settle(tui)
      const frame = await tui.frame()
      await drag(tui, rowOf(frame, "alpha 2"), rowOf(frame, "alpha 1"))
      await settle(tui)
      expect(tabsInFrame(await tui.frame())).toEqual(["alpha2", "alpha1", "beta1", "beta2"])
      expect(tui.hostOrder()).toEqual(["alpha2", "alpha1", "beta1", "beta2"])
    })

    test("a collapsed group still shows the active sub-session with its parent", async () => {
      init(allIDs, state({ collapsed: { alpha: true } }))
      const tui = await start({ sessions: withParent("beta1", { parentID: "alpha1" }), tabState: { beta1: { active: true } } })
      await settle(tui)
      const frame = await tui.frame()
      expect(frame).toContain("▸ alpha")
      expect(frame).toContain("alpha 1")
      expect(frame).not.toContain("alpha 2")
      expect(rowOf(frame, "beta 1")).toBe(rowOf(frame, "alpha 1") + 1)
    })
  })
}
