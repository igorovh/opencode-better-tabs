import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import compiledPlugin from "../dist/tui.js"
import sourcePlugin from "../src/tui"
import { sleep, startTui, type Session, type Tui } from "./harness"

const sessions: Session[] = ["alpha", "beta"].flatMap((project) =>
  [1, 2].map((n) => ({ id: `${project}${n}`, projectID: project, directory: `/${project}`, title: `${project} ${n}` })),
)

let dir: string
const running: Tui[] = []
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text))
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

const start = async (plugin: typeof sourcePlugin, options: Record<string, unknown> = {}) => {
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-close-"))
  writeFileSync(
    path.join(dir, "tabs.json"),
    JSON.stringify({ global: { tabs: sessions.map((session) => ({ sessionID: session.id })), unread: {} }, cwd: {} }),
  )
  const tui = await startTui({ stateDir: dir, sessions, plugin, options })
  running.push(tui)
  await settle(tui)
  return tui
}

// Records the dialog questions and the tabs the plugin actually closes.
const spy = (tui: Tui) => {
  const asked: { title: string; message: string; label?: { confirm?: string; cancel?: string } }[] = []
  const closed: string[] = []
  let answer = () => true
  const ctx = tui.ctx as any
  ctx.ui.dialog.confirm = async (options: (typeof asked)[number]) => {
    asked.push(options)
    return answer()
  }
  ctx.ui.tabs.close = (sessionID?: string) => {
    closed.push(sessionID ?? "active")
    return true
  }
  return { asked, closed, answerWith: (next: () => boolean) => (answer = next) }
}

// The cross only reacts once its row is hovered.
const clickCross = async (tui: Tui, row: number) => {
  await tui.mouse.moveTo(38, row)
  await settle(tui)
  await tui.mouse.click(38, row)
  await settle(tui)
}

for (const [name, plugin] of [
  ["source", sourcePlugin],
  ["dist", compiledPlugin],
] as const) {
  describe(name, () => {
    test("closes at once when the option is off", async () => {
      const tui = await start(plugin)
      const spyState = spy(tui)
      const frame = await tui.frame()

      await clickCross(tui, rowOf(frame, "alpha 1"))
      await tui.mouse.click(6, rowOf(frame, "beta 1"), 1)
      await settle(tui)

      expect(spyState.asked).toEqual([])
      expect(spyState.closed).toEqual(["alpha1", "beta1"])
    })

    test("asks before closing with the cross and closes when accepted", async () => {
      const tui = await start(plugin, { confirmClose: true })
      const spyState = spy(tui)
      const frame = await tui.frame()

      await clickCross(tui, rowOf(frame, "alpha 1"))

      expect(spyState.asked).toHaveLength(1)
      expect(spyState.asked[0]!.title).toBe("Close tab")
      expect(spyState.asked[0]!.message).toContain("alpha 1")
      expect(spyState.asked[0]!.label).toEqual({ confirm: "Close", cancel: "Cancel" })
      expect(spyState.closed).toEqual(["alpha1"])
    })

    test("keeps the tab when the dialog is cancelled", async () => {
      const tui = await start(plugin, { confirmClose: true })
      const spyState = spy(tui)
      spyState.answerWith(() => false)
      const frame = await tui.frame()

      await clickCross(tui, rowOf(frame, "beta 2"))

      expect(spyState.asked).toHaveLength(1)
      expect(spyState.closed).toEqual([])
    })

    test("asks before closing with a middle click", async () => {
      const tui = await start(plugin, { confirmClose: true })
      const spyState = spy(tui)
      const frame = await tui.frame()

      await tui.mouse.click(6, rowOf(frame, "beta 1"), 1)
      await settle(tui)

      expect(spyState.asked).toHaveLength(1)
      expect(spyState.closed).toEqual(["beta1"])
    })

    test("commands close without asking, they are deliberate", async () => {
      const tui = await start(plugin, { confirmClose: true })
      const spyState = spy(tui)

      await tui.command("better-tabs.close")
      await tui.command("better-tabs.archive")

      expect(spyState.asked).toEqual([])
      expect(spyState.closed).toEqual(["active", "active"])
    })
  })
}
