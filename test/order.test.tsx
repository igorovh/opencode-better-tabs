import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { readJson, sleep, startTui, type Session, type Tui } from "./harness"

const sessions: Session[] = ["alpha", "beta", "gamma"].flatMap((project) =>
  [1, 2].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)
const ids = sessions.map((session) => session.id)
// Latest run start per session; gamma2 never ran, so its creation time counts. beta and gamma tie at 60.
const lastRun: Record<string, number | undefined> = { alpha1: 10, alpha2: 20, beta1: 60, beta2: 30, gamma1: 60 }
const recentSessions = sessions.map((session, index) => ({
  ...session,
  time: { created: index + 1, busy: lastRun[session.id] },
}))

let dir: string
const running: Tui[] = []
const settle = async (...tuis: Tui[]) => {
  for (let round = 0; round < 5; round++) {
    await sleep(120)
    for (const tui of tuis) await tui.flush()
  }
}
const groupsInFrame = (frame: string) =>
  ["alpha", "beta", "gamma"].filter((name) => frame.includes(`▾ ${name}`)).sort(
    (left, right) => frame.indexOf(`▾ ${left}`) - frame.indexOf(`▾ ${right}`),
  )
// Moves one row at a time, like a real pointer, so live reordering sees every step.
const drag = async (tui: Tui, from: number, to: number) => {
  await tui.mouse.pressDown(5, from)
  for (let y = from - 1; y >= Math.min(to, from - 1); y--) await tui.mouse.emitMouseEvent("drag", 5, y)
  if (to > from) for (let y = from + 1; y <= to; y++) await tui.mouse.emitMouseEvent("drag", 5, y)
  await tui.mouse.release(5, to)
}
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text))
const tabsInFrame = (frame: string) =>
  sessions
    .filter((session) => frame.includes(session.title))
    .sort((left, right) => frame.indexOf(left.title) - frame.indexOf(right.title))
    .map((session) => session.id)

afterEach(async () => {
  while (running.length) await running.pop()!.stop()
  rmSync(dir, { recursive: true, force: true })
})

const init = (state?: object) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-"))
  writeFileSync(path.join(dir, "tabs.json"), JSON.stringify({ global: { tabs: ids.map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }))
  if (state) writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
}

// The compiled build is what a GitHub install loads; it must render and react like the source.
for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    const start = async ({
      sort,
      sessionList = sessions,
      ...options
    }: {
      syncDelay?: number
      writeDelay?: number
      sort?: "manual" | "recent"
      sessionList?: Session[]
      tabState?: Record<string, Record<string, unknown>>
    } = {}) => {
      const tui = await startTui({ stateDir: dir, sessions: sessionList, plugin, options: sort ? { sort } : {}, ...options })
      running.push(tui)
      return tui
    }

    test("a moved group keeps its place after a restart", async () => {
      init()
      const first = await start({ syncDelay: 10 })
      await settle(first)
      expect(groupsInFrame(await first.frame())).toEqual(["alpha", "beta", "gamma"])

      first.run("alt+3")
      first.run("alt+up")
      await settle(first)
      expect(groupsInFrame(await first.frame())).toEqual(["alpha", "gamma", "beta"])
      await first.stop()
      running.pop()

      const second = await start({ syncDelay: 10 })
      await settle(second)
      expect(groupsInFrame(await second.frame())).toEqual(["alpha", "gamma", "beta"])
      expect(second.hostOrder()).toEqual(["alpha1", "alpha2", "gamma1", "gamma2", "beta1", "beta2"])
    })

    test("moves made before the order is saved are all applied", async () => {
      init()
      const tui = await start({ syncDelay: 10, writeDelay: 30 })
      await settle(tui)
      tui.run("alt+3")
      tui.run("alt+up")
      tui.run("alt+up")
      await settle(tui)
      expect(groupsInFrame(await tui.frame())).toEqual(["gamma", "alpha", "beta"])
      expect(readJson(dir, "state").groupOrder).toEqual(["gamma", "alpha", "beta"])
      expect(tui.hostOrder()).toEqual(["gamma1", "gamma2", "alpha1", "alpha2", "beta1", "beta2"])
    })

    test("two TUIs sharing the state agree on the order", async () => {
      init()
      const a = await start({ syncDelay: 10, writeDelay: 30 })
      const b = await start({ syncDelay: 10, writeDelay: 30 })
      await settle(a, b)
      a.run("alt+3")
      a.run("alt+up")
      await settle(a, b)
      expect(groupsInFrame(await b.frame())).toEqual(["alpha", "gamma", "beta"])
      b.run("alt+1")
      b.run("alt+down")
      await settle(a, b)
      expect(groupsInFrame(await a.frame())).toEqual(["gamma", "alpha", "beta"])
      expect(groupsInFrame(await b.frame())).toEqual(["gamma", "alpha", "beta"])
    })

    test("a saved order is applied when sessions load at different speeds", async () => {
      init({ collapsed: {}, autoGroup: true, restoreMode: "auto", groupOrder: ["gamma", "alpha", "beta"] })
      const a = await start({ syncDelay: 15, writeDelay: 20 })
      const b = await start({ syncDelay: 5, writeDelay: 20 })
      await settle(a, b)
      expect(groupsInFrame(await a.frame())).toEqual(["gamma", "alpha", "beta"])
      expect(groupsInFrame(await b.frame())).toEqual(["gamma", "alpha", "beta"])
      expect(a.hostOrder()).toEqual(["gamma1", "gamma2", "alpha1", "alpha2", "beta1", "beta2"])
    })

    test("recent sort puts the latest run first and keeps the saved order for ties", async () => {
      init({ collapsed: {}, autoGroup: true, restoreMode: "auto", groupOrder: ["gamma", "alpha", "beta"] })
      const tui = await start({ sort: "recent", sessionList: recentSessions, syncDelay: 5 })
      await settle(tui)
      const frame = await tui.frame()
      const expected = ["gamma1", "gamma2", "beta1", "beta2", "alpha2", "alpha1"]

      expect(groupsInFrame(frame)).toEqual(["gamma", "beta", "alpha"])
      expect(tabsInFrame(frame)).toEqual(expected)
      expect(tui.hostOrder()).toEqual(expected)
    })

    test("recent sort ignores dragging and alt+arrows", async () => {
      init()
      const tui = await start({ sort: "recent", sessionList: recentSessions, syncDelay: 5 })
      await settle(tui)
      const before = await tui.frame()
      expect(groupsInFrame(before)).toEqual(["beta", "gamma", "alpha"])

      await drag(tui, rowOf(before, "▾ alpha"), rowOf(before, "▾ beta"))
      await drag(tui, rowOf(before, "gamma 2"), rowOf(before, "gamma 1"))
      tui.run("alt+3")
      tui.run("alt+up")
      await settle(tui)
      expect(tabsInFrame(await tui.frame())).toEqual(tabsInFrame(before))
      expect(tui.toasts.at(-1)).toContain('set sort to "manual"')
    })

    for (const [name, from, to, expected] of [
      ["up onto the tab above", "beta 2", "beta 1", ["beta2", "beta1"]],
      ["down onto the tab below", "beta 1", "beta 2", ["beta2", "beta1"]],
      ["onto itself", "beta 1", "beta 1", ["beta1", "beta2"]],
      ["past its group", "beta 1", "gamma 2", ["beta2", "beta1"]],
    ] as const) {
      test(`dragging a tab ${name}`, async () => {
        init()
        const tui = await start({ syncDelay: 5 })
        await settle(tui)
        const frame = await tui.frame()
        await drag(tui, rowOf(frame, from), rowOf(frame, to))
        await settle(tui)
        const order = ["alpha1", "alpha2", ...expected, "gamma1", "gamma2"]
        expect(tabsInFrame(await tui.frame())).toEqual(order)
        expect(tui.hostOrder()).toEqual(order)
      })
    }

    test("a dragged tab keeps its place when grouping is off", async () => {
      init({ collapsed: {}, autoGroup: false, restoreMode: "auto", groupOrder: [] })
      writeFileSync(
        path.join(dir, "tabs.json"),
        JSON.stringify({ global: { tabs: ["alpha1", "beta1", "alpha2"].map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }),
      )
      const tui = await start({ syncDelay: 5 })
      await settle(tui)
      const frame = await tui.frame()
      await drag(tui, rowOf(frame, "alpha 2"), rowOf(frame, "alpha 1"))
      await settle(tui)
      expect(tui.hostOrder()).toEqual(["alpha2", "alpha1", "beta1"])
    })

    test("tabs of a collapsed group cannot be dragged", async () => {
      init({ collapsed: { beta: true }, autoGroup: true, restoreMode: "auto", groupOrder: [] })
      const tui = await start({ syncDelay: 5, tabState: { beta2: { active: true } } })
      await settle(tui)
      const frame = await tui.frame()
      await drag(tui, rowOf(frame, "beta 2"), rowOf(frame, "▾ alpha"))
      await settle(tui)
      expect(tui.hostOrder()).toEqual(ids)
    })

    for (const [target, expected] of [
      ["alpha header", ["gamma", "alpha", "beta"]],
      ["alpha tab", ["alpha", "gamma", "beta"]],
      ["below", ["alpha", "beta", "gamma"]],
    ] as const) {
      test(`dragging gamma and releasing on ${target}`, async () => {
        init()
        const tui = await start({ syncDelay: 5 })
        await settle(tui)
        const frame = await tui.frame()
        const from = rowOf(frame, "▾ gamma")
        const to = target === "alpha header" ? rowOf(frame, "▾ alpha") : target === "alpha tab" ? rowOf(frame, "alpha 1") : 28
        await drag(tui, from, to)
        await settle(tui)
        expect(groupsInFrame(await tui.frame())).toEqual([...expected])
        // Releasing a drag must not also toggle the group under the pointer.
        expect(readJson(dir, "state").collapsed).toEqual({})
      })
    }

    test("fast moves then a restart keep the final order", async () => {
      init()
      const first = await start({ syncDelay: 5, writeDelay: 15 })
      await settle(first)
      first.run("alt+1")
      for (const key of ["alt+down", "alt+down", "alt+up", "alt+down"]) {
        first.run(key)
        await sleep(8)
      }
      await settle(first)
      expect(groupsInFrame(await first.frame())).toEqual(["beta", "gamma", "alpha"])
      await first.stop()
      running.pop()
      const second = await start({ syncDelay: 5 })
      await settle(second)
      expect(groupsInFrame(await second.frame())).toEqual(["beta", "gamma", "alpha"])
      expect(second.hostOrder()).toEqual(["beta1", "beta2", "gamma1", "gamma2", "alpha1", "alpha2"])
    })
  })
}
