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
const recentActivity: Record<string, number> = { alpha1: 10, alpha2: 20, beta1: 60, beta2: 30, gamma1: 40, gamma2: 60 }
const recentSessions = sessions.map((session) => ({ ...session, time: { updated: recentActivity[session.id]! } }))

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
      recentSort,
      sessionList = sessions,
      ...options
    }: {
      syncDelay?: number
      writeDelay?: number
      recentSort?: false | "tabs" | "groups"
      sessionList?: Session[]
    } = {}) => {
      const tui = await startTui({
        stateDir: dir,
        sessions: sessionList,
        plugin,
        options: recentSort === undefined ? {} : { recentSort },
        ...options,
      })
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

    test("recentSort tabs orders activity within each group only", async () => {
      init()
      const tui = await start({ recentSort: "tabs", sessionList: recentSessions, syncDelay: 5 })
      await settle(tui)
      const frame = await tui.frame()
      const expected = ["alpha2", "alpha1", "beta1", "beta2", "gamma2", "gamma1"]

      expect(groupsInFrame(frame)).toEqual(["alpha", "beta", "gamma"])
      expect(tabsInFrame(frame)).toEqual(expected)
      expect(tui.hostOrder()).toEqual(expected)
    })

    test("recentSort groups orders groups and uses saved order for ties", async () => {
      init({ collapsed: {}, autoGroup: true, restoreMode: "auto", groupOrder: ["gamma", "alpha", "beta"] })
      const tui = await start({ recentSort: "groups", sessionList: recentSessions, syncDelay: 5 })
      await settle(tui)
      const frame = await tui.frame()
      const expected = ["gamma2", "gamma1", "beta1", "beta2", "alpha2", "alpha1"]

      expect(groupsInFrame(frame)).toEqual(["gamma", "beta", "alpha"])
      expect(tabsInFrame(frame)).toEqual(expected)
      expect(tui.hostOrder()).toEqual(expected)
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
        await tui.mouse.pressDown(5, from)
        for (let y = from - 1; y >= Math.min(to, from - 1); y--) await tui.mouse.emitMouseEvent("drag", 5, y)
        if (to > from) for (let y = from + 1; y <= to; y++) await tui.mouse.emitMouseEvent("drag", 5, y)
        await tui.mouse.release(5, to)
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
