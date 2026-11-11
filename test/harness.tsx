/** @jsxImportSource @opentui/solid */
import { mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { PluginContextProvider } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import sourcePlugin from "../src/tui"

// Mirrors the host's TUI storage (packages/tui/src/context/storage.tsx): synchronous load, mutations
// applied to the on-disk draft under a file lock, and a debounced directory watcher that reloads.
const locks = new Map<string, Promise<unknown>>()
const withLock = <T,>(file: string, run: () => Promise<T>) => {
  const next = (locks.get(file) ?? Promise.resolve()).catch(() => {}).then(run)
  locks.set(file, next.catch(() => {}))
  return next
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createStorage(directory: string, writeDelay: number) {
  mkdirSync(directory, { recursive: true })
  const entries = new Map<string, { value: any; reload: () => void }>()
  const pending = new Set<Promise<void>>()
  const store = <Value extends object>(
    key: string,
    options: { initial: Value; key?: string },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>] => {
    const file = path.join(directory, key + ".json")
    const existing = entries.get(file)
    if (existing) return existing.value
    const load = (): Value => {
      try {
        return JSON.parse(readFileSync(file, "utf8"))
      } catch {
        return structuredClone(options.initial)
      }
    }
    const [value, setValue] = createStore(load())
    const merge = (next: Value) => reconcile(next, { key: options.key })
    const update = (mutation: (draft: Value) => void) => {
      const operation = withLock(file, async () => {
        const draft = load()
        mutation(draft)
        await sleep(writeDelay)
        const temp = `${file}.${Math.random().toString(36).slice(2)}.tmp`
        await writeFile(temp, JSON.stringify(draft))
        await rename(temp, file)
        batch(() => setValue(merge(draft)))
      })
      pending.add(operation)
      operation.finally(() => pending.delete(operation)).catch(() => {})
      return operation
    }
    const entry = [value, update] as const
    entries.set(file, { value: entry, reload: () => batch(() => setValue(merge(load()))) })
    return entry
  }
  const memories = new Map<string, any>()
  const memory = <Value extends object>(key: string, options: { initial: Value }) => {
    if (!memories.has(key)) {
      const [value, setValue] = createStore(options.initial)
      memories.set(key, [value, (mutation: (draft: Value) => void) => setValue((draft) => (mutation(draft), draft))])
    }
    return memories.get(key)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher: FSWatcher = watch(directory, () => {
    clearTimeout(timer)
    timer = setTimeout(() => entries.forEach((entry) => entry.reload()), 50)
  })
  return {
    store,
    memory,
    flush: async () => {
      while (pending.size) await Promise.allSettled(pending)
    },
    close: () => {
      clearTimeout(timer)
      watcher.close()
    },
  }
}

// Host session-tabs move (packages/tui/src/context/session-tabs-model.ts).
function moveSessionTab<T extends { sessionID: string }>(tabs: T[], sessionID: string, index: number) {
  const from = tabs.findIndex((tab) => tab.sessionID === sessionID)
  const to = Math.max(0, Math.min(tabs.length - 1, index))
  if (from === -1 || from === to) return tabs
  const next = tabs.filter((tab) => tab.sessionID !== sessionID)
  next.splice(to, 0, tabs[from]!)
  return next
}

export type Session = { id: string; projectID: string; directory: string; title: string }

const theme: any = new Proxy(RGBA.fromInts(128, 128, 128, 255), {
  get: (target, property) => (property in target ? (target as any)[property] : theme),
})

export type Tui = Awaited<ReturnType<typeof startTui>>

export async function startTui(options: {
  stateDir: string
  sessions: Session[]
  syncDelay?: number
  writeDelay?: number
  plugin?: typeof sourcePlugin
  options?: Record<string, unknown>
  theme?: any
  // Host tab flags by session ID, such as { active: true } or { unread: "error" }.
  tabState?: Record<string, Record<string, unknown>>
  size?: { width: number; height: number }
}) {
  const storage = createStorage(options.stateDir, options.writeDelay ?? 5)
  const server = new Map(options.sessions.map((session) => [session.id, session]))
  const [cache, setCache] = createStore<Record<string, any>>({})
  const sync = async (sessionID: string) => {
    await sleep(options.syncDelay ?? 0)
    const session = server.get(sessionID)
    if (!session) throw new Error("not found")
    setCache(sessionID, {
      id: session.id,
      projectID: session.projectID,
      title: session.title,
      location: { directory: session.directory },
    })
  }
  const [host, updateHost] = storage.store("tabs", {
    initial: { global: { tabs: [] as { sessionID: string; title?: string }[], unread: {} }, cwd: {} },
    key: "sessionID",
  })
  const layers: (() => any)[] = []
  const toasts: string[] = []

  const ctx: any = {
    theme: options.theme ?? theme,
    options: options.options ?? {},
    app: { channel: "test" },
    storage,
    data: {
      session: { get: (sessionID: string) => cache[sessionID], sync },
      project: {
        get: (id: string) => ({ id, name: id, canonical: id, vcs: "git" }),
        sync: async () => {},
      },
    },
    keymap: {
      layer: (factory: () => any) => void layers.push(factory),
      shortcuts: () => [],
      dispatch: () => {},
    },
    ui: {
      toast: { show: (toast: { message: string }) => void toasts.push(toast.message) },
      router: { navigate: () => {} },
      dialog: {
        confirm: async () => true,
        select: async () => undefined,
      },
      slot: (slot: { render: () => any }) => slot,
      tabs: {
        enabled: () => true,
        list: () =>
          host.global.tabs.map((tab: { sessionID: string; title?: string }) => ({
            ...tab,
            active: false,
            busy: false,
            attention: false,
            ...options.tabState?.[tab.sessionID],
          })),
        open: () => true,
        focus: () => true,
        close: () => true,
        move(sessionID: string, index: number) {
          if (moveSessionTab(host.global.tabs, sessionID, index) === host.global.tabs) return true
          void updateHost((draft) => void (draft.global.tabs = moveSessionTab(draft.global.tabs, sessionID, index)))
          return true
        },
      },
    },
  }

  const slot = (options.plugin ?? sourcePlugin).setup(ctx) as unknown as { render: () => any }
  const { width, height } = options.size ?? { width: 80, height: 30 }
  const setup = await testRender(
    () => (
      <PluginContextProvider value={ctx}>
        <box flexDirection="row" width={width} height={height}>
          <box width={40} />
          <box flexDirection="column" flexGrow={1}>
            {slot.render()}
          </box>
        </box>
      </PluginContextProvider>
    ),
    { width, height },
  )

  const run = (bind: string) => {
    for (const factory of layers.toReversed()) {
      const layer = factory()
      if (layer.enabled && !layer.enabled()) continue
      const command = layer.commands.find((item: any) => item.bind?.split(",").includes(bind))
      if (command) return command.run()
    }
    throw new Error(`No command bound to ${bind}`)
  }

  const command = (id: string) => {
    for (const factory of layers.toReversed()) {
      const layer = factory()
      const found = layer.commands.find((item: any) => item.id === id)
      if (found) return found.run()
    }
    throw new Error(`No command ${id}`)
  }

  return {
    ctx,
    toasts,
    run,
    command,
    hostOrder: () => host.global.tabs.map((tab: { sessionID: string }) => tab.sessionID),
    openTabs: (ids: string[]) =>
      updateHost((draft) => void (draft.global.tabs = ids.map((sessionID) => ({ sessionID })))),
    flush: storage.flush,
    mouse: setup.mockMouse,
    async frame() {
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
    async spans() {
      await setup.renderOnce()
      return setup.captureSpans()
    },
    async stop() {
      await storage.flush()
      setup.renderer.destroy()
      storage.close()
    },
  }
}

export function readJson(stateDir: string, key: string) {
  return JSON.parse(readFileSync(path.join(stateDir, key + ".json"), "utf8"))
}
