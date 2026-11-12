/** @jsxImportSource @opentui/solid */
import { existsSync } from "node:fs"
import path from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, type BoxRenderable, type MouseEvent, type Renderable } from "@opentui/core"
import { Portal } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import {
  readTabsMode,
  tabsOverridden,
  writeTabsMode,
  type TabsMode,
} from "./config-files"
import { readOptions } from "./options"

type Tab = ReturnType<Context["ui"]["tabs"]["list"]>[number]
type Group = { key: string; name: string; noGit: boolean; tabs: Tab[] }

// Matches the host's SESSION_TABS_COMPACT_BREAKPOINT: when the user drags its bar this narrow, both bars shrink together.
const NARROW_BREAKPOINT = 12
const CHORD_TIMEOUT = 3000
// How far tab titles lean from the base text colour towards the muted one.
const TITLE_DIM = 0.2
const MIN_GROUP_NAME = 6
// Older OpenCode builds file sessions outside any repository under this shared project ID.
const GLOBAL_PROJECT = "global"
// Ticks of the 100 ms timer between checks for a `.git` created after startup.
const GIT_RECHECK_TICKS = 50
const SYNC_RETRY = 5000
const UNKNOWN_GROUP = "\u0000unknown"
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type State = {
  collapsed: Record<string, boolean>
  autoGroup: boolean
  restoreMode: TabsMode
  groupOrder: string[]
}

function truncate(value: string, width: number) {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return "…"
  return value.slice(0, width - 1) + "…"
}

function mix(from: RGBA, to: RGBA, amount: number) {
  const blend = (a: number, b: number) => a + (b - a) * amount
  return RGBA.fromValues(blend(from.r, to.r), blend(from.g, to.g), blend(from.b, to.b), blend(from.a, to.a))
}

function findGitRoot(directory: string) {
  for (let current = path.resolve(directory); ; ) {
    if (existsSync(path.join(current, ".git"))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function moveItem<T>(items: readonly T[], from: number, to: number) {
  const result = [...items]
  const [item] = result.splice(from, 1)
  result.splice(Math.max(0, Math.min(to, result.length)), 0, item!)
  return result
}

function BetterTabs() {
  const ctx = usePlugin()
  const theme = () => ctx.theme
  const [state, update] = ctx.storage.store<State>("state", {
    initial: { collapsed: {}, autoGroup: true, restoreMode: "auto", groupOrder: [] },
  })
  const [memory, setMemory] = ctx.storage.memory<{ ids: string[] }>("memory", { initial: { ids: [] } })

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Better tabs", message, variant })
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error")

  const options = readOptions(ctx.options)
  for (const warning of options.warnings) toast(warning, "warning")
  const { modifier, slotKeys, confirmClose, padding } = options
  // Dragging is off in recent mode: activity would undo any manual move at once.
  const recent = options.sort === "recent"

  // Tabs, sessions and groups ------------------------------------------------------------------

  // While tabs are hidden the host no longer tracks them, so fall back to the last known list.
  const tabs = createMemo<readonly Tab[]>(() => {
    if (ctx.ui.tabs.enabled()) return ctx.ui.tabs.list()
    return memory.ids.map((sessionID) => ({ sessionID, active: false, busy: false, attention: false }))
  })

  createEffect(() => {
    if (!ctx.ui.tabs.enabled()) return
    const ids = ctx.ui.tabs.list().map((tab) => tab.sessionID)
    if (ids.length) setMemory((draft) => void (draft.ids = ids))
  })

  // A failed sync is retried later; otherwise the tab would stay in the "…" group for good.
  const requested = new Set<string>()
  const [syncRetry, setSyncRetry] = createSignal(0)
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  onCleanup(() => retryTimers.forEach(clearTimeout))
  createEffect(() => {
    syncRetry()
    for (const tab of tabs()) {
      const sessionID = tab.sessionID
      if (ctx.data.session.get(sessionID) || requested.has(sessionID)) continue
      requested.add(sessionID)
      void ctx.data.session.sync(sessionID).catch(() => {
        const timer = setTimeout(() => {
          retryTimers.delete(timer)
          requested.delete(sessionID)
          setSyncRetry((value) => value + 1)
        }, SYNC_RETRY)
        retryTimers.add(timer)
      })
    }
  })

  // OpenCode never re-checks `vcs` for a known project, so a later `git init` is detected on disk.
  const gitCache = new Map<string, boolean>()
  const [gitVersion, setGitVersion] = createSignal(0)
  const insideGit = (directory: string) => {
    gitVersion()
    let found = gitCache.get(directory)
    if (found === undefined) gitCache.set(directory, (found = findGitRoot(directory)))
    return found
  }
  const recheckGit = () => {
    let changed = false
    for (const [directory, found] of gitCache) {
      const now = findGitRoot(directory)
      if (now === found) continue
      gitCache.set(directory, now)
      changed = true
    }
    if (changed) setGitVersion((value) => value + 1)
  }

  const groupOf = (sessionID: string) => {
    const session = ctx.data.session.get(sessionID)
    if (!session) return undefined
    const directory = session.location.directory
    if (session.projectID === GLOBAL_PROJECT) {
      const normalized = path.resolve(directory)
      // Default Windows and macOS file systems ignore case, so `~/Repo` and `~/repo` are one folder.
      const key = process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized
      return { key: `dir:${key}`, name: path.basename(normalized) || normalized, noGit: !insideGit(normalized) }
    }
    const project = ctx.data.project.get(session.projectID)
    const canonical = project?.canonical ?? directory
    const name = project?.name || path.basename(canonical) || canonical
    // Directories without a repository get their own project with no `vcs`.
    return { key: session.projectID, name, noGit: !!project && !project.vcs && !insideGit(canonical) }
  }

  const titleOf = (tab: Pick<Tab, "sessionID" | "title">) =>
    ctx.data.session.get(tab.sessionID)?.title ?? tab.title ?? "Untitled session"

  // `busy` marks the start of the latest run, so a tab moves once per message instead of while it streams.
  const activityOf = (sessionID: string) => {
    const time = ctx.data.session.get(sessionID)?.time
    return time?.busy ?? time?.created ?? 0
  }
  const groupActivity = (group: Group) => Math.max(0, ...group.tabs.map((tab) => activityOf(tab.sessionID)))

  // Saving the order is async, so moves made before it lands use this local copy instead.
  const [localOrder, setLocalOrder] = createSignal<string[]>()
  let orderWrites = 0

  // Groups in their saved order, or by latest activity in recent mode; ties and new groups follow in tab order.
  const orderedGroups = createMemo(() => {
    const result = new Map<string, Group>()
    for (const tab of tabs()) {
      const info = groupOf(tab.sessionID) ?? { key: UNKNOWN_GROUP, name: "…", noGit: false }
      const group = result.get(info.key) ?? { ...info, tabs: [] }
      group.tabs.push(tab)
      result.set(info.key, group)
    }
    const order = localOrder() ?? state.groupOrder ?? []
    const rank = (key: string) => {
      const index = order.indexOf(key)
      return index === -1 ? order.length : index
    }
    const list = [...result.values()]
    if (recent)
      for (const group of list) group.tabs.sort((left, right) => activityOf(right.sessionID) - activityOf(left.sessionID))
    return list.sort((left, right) => (recent && groupActivity(right) - groupActivity(left)) || rank(left.key) - rank(right.key))
  })

  // Live reorder while a group header or a tab is being dragged.
  const [drag, setDrag] = createSignal<{ key: string; startY: number; moved: boolean; target: number }>()
  const [tabDrag, setTabDrag] = createSignal<{ sessionID: string; startY: number; moved: boolean; target: number }>()
  const groups = createMemo(() => {
    let list = orderedGroups()
    const current = drag()
    if (current?.moved) {
      const from = list.findIndex((group) => group.key === current.key)
      if (from !== -1) list = moveItem(list, from, current.target)
    }
    const dragged = tabDrag()
    if (!dragged?.moved) return list
    return list.map((group) => {
      const from = group.tabs.findIndex((tab) => tab.sessionID === dragged.sessionID)
      return from === -1 ? group : { ...group, tabs: moveItem(group.tabs, from, dragged.target) }
    })
  })

  const moveGroup = (key: string, to: number) => {
    const list = orderedGroups().map((group) => group.key)
    const from = list.indexOf(key)
    if (from === -1) return
    const next = moveItem(list, from, to)
    const merge = (saved: readonly string[] = []) => [...next, ...saved.filter((item) => !next.includes(item))]
    setLocalOrder(merge(localOrder() ?? state.groupOrder))
    const write = ++orderWrites
    void update((draft) => void (draft.groupOrder = merge(draft.groupOrder)))
      .catch(fail)
      .finally(() => {
        if (write === orderWrites) setLocalOrder(undefined)
      })
  }

  // Tabs keep their order in the host list, so a move puts the tab next to its new neighbour there.
  const moveTab = (sessionID: string, to: number) => {
    const ids = orderedGroups()
      .find((group) => group.tabs.some((tab) => tab.sessionID === sessionID))
      ?.tabs.map((tab) => tab.sessionID)
    if (!ids) return
    const next = moveItem(ids, ids.indexOf(sessionID), to)
    const at = next.indexOf(sessionID)
    const host = ctx.ui.tabs.list().map((tab) => tab.sessionID).filter((id) => id !== sessionID)
    const index = at > 0 ? host.indexOf(next[at - 1]!) + 1 : host.indexOf(next[1] ?? "")
    if (index >= 0) ctx.ui.tabs.move(sessionID, index)
  }

  // Order the host's tabs like our groups, so both bars agree.
  const applyGrouping = () => {
    if (!ctx.ui.tabs.enabled()) return
    const list = orderedGroups()
    if (list.some((group) => group.key === UNKNOWN_GROUP)) return
    const target = list.flatMap((group) => group.tabs.map((tab) => tab.sessionID))
    const current = ctx.ui.tabs.list().map((tab) => tab.sessionID)
    target.forEach((id, index) => {
      if (current[index] === id) return
      ctx.ui.tabs.move(id, index)
      current.splice(current.indexOf(id), 1)
      current.splice(index, 0, id)
    })
  }
  createEffect(() => {
    if (!state.autoGroup) return
    orderedGroups()
    untrack(applyGrouping)
  })

  const focus = (sessionID: string) => {
    if (!ctx.ui.tabs.focus(sessionID)) ctx.ui.router.navigate({ type: "session", sessionID })
  }

  // Two-step shortcuts: alt+G picks group G, then alt+T opens tab T of that group ----------------

  // Terminal rows are one cell tall, so padding adds whole blank lines around the label.
  const rowHeight = 1 + padding * 2

  // The selected group is tracked by key: saving a new order is async, so positions lag behind.
  const [pending, setPending] = createSignal<string>()
  let chordTimer: ReturnType<typeof setTimeout> | undefined
  const clearChord = () => {
    clearTimeout(chordTimer)
    chordTimer = undefined
    setPending(undefined)
  }
  onCleanup(clearChord)

  const armChord = (key: string) => {
    setPending(key)
    clearTimeout(chordTimer)
    chordTimer = setTimeout(clearChord, CHORD_TIMEOUT)
  }

  // Returns false when the key selects nothing, so it falls through to other bindings.
  const chord = (slot: number) => {
    const selected = pending()
    if (selected === undefined) {
      const group = groups()[slot]
      if (!group) return false
      armChord(group.key)
      return
    }
    const tab = groups().find((group) => group.key === selected)?.tabs[slot]
    clearChord()
    if (tab) focus(tab.sessionID)
  }

  // Moves the selected group and keeps it selected, so it can be moved again.
  const moveSelected = (delta: number) => {
    const selected = pending()
    if (selected === undefined) return
    if (recent) return toast('Groups follow recent activity; set sort to "manual" to move them')
    const from = orderedGroups().findIndex((group) => group.key === selected)
    if (from === -1) return
    moveGroup(selected, Math.max(0, Math.min(orderedGroups().length - 1, from + delta)))
    armChord(selected)
  }

  const slotLabel = (slot: number) => {
    const key = slotKeys[slot]
    if (!key) return ""
    const list = ctx.keymap.shortcuts(`better-tabs.key.${key}`)
    return list.find((value) => !value.includes(" ")) ?? list[0] ?? `${modifier}+${key}`
  }

  // Overlay geometry ---------------------------------------------------------------------------
  // The `app` slot sits in the content column right after the host's vertical tabs. The column's
  // parent row also holds the host tab bar, so we portal into that row and cover the bar there;
  // children placed outside their parent's bounds are culled.

  let anchor: BoxRenderable | undefined
  const [host, setHost] = createSignal<Renderable>()
  const [geometry, setGeometry] = createSignal({ width: 0, height: 0 })
  const measure = () => {
    if (!anchor || anchor.isDestroyed) return
    const row = anchor.parent?.parent ?? undefined
    if (row !== host()) setHost(row)
    const width = row ? anchor.screenX - row.screenX : 0
    const height = row ? row.height : 0
    const previous = geometry()
    if (previous.width !== width || previous.height !== height) setGeometry({ width, height })
  }

  const [tick, setTick] = createSignal(0)
  const anyBusy = createMemo(() => tabs().some((tab) => tab.busy))
  let ticks = 0
  const timer = setInterval(() => {
    measure()
    if (anyBusy()) setTick((value) => (value + 1) % SPINNER.length)
    if (++ticks % GIT_RECHECK_TICKS === 0) recheckGit()
  }, 100)
  onCleanup(() => clearInterval(timer))

  const visible = () => ctx.ui.tabs.enabled() && geometry().width >= 5 && tabs().length > 0
  const innerWidth = () => Math.max(1, geometry().width - 1)
  const narrow = () => geometry().width < NARROW_BREAKPOINT

  // Rows ---------------------------------------------------------------------------------------

  // Rows are keyed by string IDs so they survive reorders; a dragged header must not remount.
  const groupKeys = createMemo(() => groups().map((group) => group.key), [], {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  })
  const groupByKey = (key: string) => groups().find((group) => group.key === key)
  // A collapsed group opens while selected, then keeps showing only its active tab.
  const visibleTabIDs = (group: Group) =>
    group.tabs
      .filter((tab) => !state.collapsed[group.key] || tab.active || pending() === group.key)
      .map((tab) => tab.sessionID)

  const status = (tab: Tab) => {
    const t = theme()
    if (tab.attention) return { char: "!", color: t.text.feedback.warning.base }
    if (tab.busy) return { char: SPINNER[tick()]!, color: t.hue.interactive[200] }
    if (tab.unread === "error") return { char: "•", color: t.text.feedback.error.base }
    if (tab.unread === "activity") return { char: "•", color: t.hue.accent[200] }
    return { char: " ", color: t.text.muted }
  }

  const groupStatus = (group: Group) => {
    const found =
      group.tabs.find((tab) => tab.attention) ?? group.tabs.find((tab) => tab.busy) ?? group.tabs.find((tab) => tab.unread)
    return found ? status(found) : undefined
  }

  // Per-group activity counters; when space runs out, unread goes first and waiting stays longest.
  const groupCounts = (group: Group, width: number) => {
    const t = theme()
    const count = (match: (tab: Tab) => boolean) => group.tabs.filter(match).length
    const busy = count((tab) => tab.busy)
    const waiting = count((tab) => !!tab.attention)
    const unread = count((tab) => !!tab.unread)
    const error = group.tabs.some((tab) => tab.unread === "error")
    const items = [
      { drop: 1, n: busy, text: `${SPINNER[tick()]}${busy}`, color: t.hue.interactive[200] },
      { drop: 2, n: waiting, text: `!${waiting}`, color: t.text.feedback.warning.base },
      { drop: 0, n: unread, text: `•${unread}`, color: error ? t.text.feedback.error.base : t.hue.accent[200] },
    ].filter((item) => item.n > 0)
    const fits = (list: typeof items) => list.reduce((sum, item) => sum + item.text.length + 1, 0) <= width
    let shown = items
    for (const level of [0, 1, 2]) {
      if (fits(shown)) break
      shown = shown.filter((item) => item.drop !== level)
    }
    return fits(shown) ? shown : []
  }

  const toggleGroup = (key: string) =>
    void update((draft) => {
      if (draft.collapsed[key]) delete draft.collapsed[key]
      else draft.collapsed[key] = true
    }).catch(fail)

  const [hovered, setHovered] = createSignal<string>()
  // Releasing a drag also sends "up" to whatever row is under the pointer; that is not a click.
  let dropped = false
  // "up" also reaches the pressed row after drag end cleared the drag, so the pressed header is kept here.
  let pressedGroup: string | undefined
  const click = (event: MouseEvent, run: () => void) => {
    event.stopPropagation()
    if (!dropped) run()
  }

  const background = () => theme().background.raised.base
  const titleColor = createMemo(() => mix(theme().text.base, theme().text.muted, TITLE_DIM))
  const rowBackground = (id: string, active: boolean) =>
    active ? theme().background.raised.max : hovered() === id ? theme().background.raised.high : background()

  // Drop position among the other groups, from where their headers sit on screen. Compare against
  // the middle of the header so dropping on a padded row still means "on that header".
  const headers = new Map<string, BoxRenderable>()
  const dropTarget = (key: string, y: number) =>
    orderedGroups().filter((group) => {
      if (group.key === key) return false
      const header = headers.get(group.key)
      return !!header && !header.isDestroyed && header.screenY + (header.height - 1) / 2 < y
    }).length

  // Tabs move within their group, and the dragged tab takes the place of the row under the pointer.
  const tabRows = new Map<string, BoxRenderable>()
  const tabDropTarget = (sessionID: string, y: number) => {
    const own = tabRows.get(sessionID)
    const group = orderedGroups().find((item) => item.tabs.some((tab) => tab.sessionID === sessionID))
    if (!own || own.isDestroyed || !group) return 0
    return group.tabs.filter((tab) => {
      const row = tabRows.get(tab.sessionID)
      if (tab.sessionID === sessionID || !row || row.isDestroyed) return false
      return row.screenY > own.screenY ? row.screenY <= y : row.screenY + row.height - 1 < y
    }).length
  }

  // Drag events go to whatever row the pointer first moved onto, so the whole bar handles them.
  const dragMove = (event: MouseEvent) => {
    const current = drag()
    if (current) {
      if (recent) return
      const moved = current.moved || event.y !== current.startY
      if (moved) setDrag({ ...current, moved, target: dropTarget(current.key, event.y) })
      return
    }
    const dragged = tabDrag()
    if (!dragged) return
    const moved = dragged.moved || event.y !== dragged.startY
    if (moved) setTabDrag({ ...dragged, moved, target: tabDropTarget(dragged.sessionID, event.y) })
  }

  const finishDrag = () => {
    const current = drag()
    const dragged = tabDrag()
    setDrag(undefined)
    setTabDrag(undefined)
    if (current?.moved) moveGroup(current.key, current.target)
    else if (dragged?.moved) moveTab(dragged.sessionID, dragged.target)
    else return false
    dropped = true
    setTimeout(() => (dropped = false))
    return true
  }

  function GroupRow(props: { group: Group; position: number; collapsed: boolean }) {
    const id = () => `group:${props.group.key}`
    const selected = () => pending() === props.group.key
    const dragging = () => drag()?.key === props.group.key && drag()?.moved
    const arrow = () => (props.collapsed && !selected() ? "▸" : "▾")
    // Group shortcuts give way to the tab shortcuts while a group is selected.
    const keys = () => (dragging() ? "⇅" : pending() === undefined ? slotLabel(props.position) : "")
    const keysWidth = () => (keys() ? keys().length + 2 : 0)
    const counts = createMemo(() => groupCounts(props.group, innerWidth() - 3 - MIN_GROUP_NAME - keysWidth()))
    const countsWidth = () => counts().reduce((width, item) => width + item.text.length + 1, 0)
    const nameWidth = () => innerWidth() - 3 - countsWidth() - keysWidth()
    const marker = () => groupStatus(props.group)
    const noGitLabel = () => (props.group.noGit && nameWidth() - props.group.name.length >= 7 ? " no git" : "")
    let header: BoxRenderable | undefined
    onCleanup(() => {
      if (headers.get(props.group.key) === header) headers.delete(props.group.key)
    })
    return (
      <box
        ref={(element: BoxRenderable) => headers.set(props.group.key, (header = element))}
        flexDirection="row"
        height={rowHeight}
        flexShrink={0}
        paddingTop={padding}
        backgroundColor={
          dragging()
            ? theme().background.action.primary.selected
            : selected()
              ? theme().background.raised.high
              : rowBackground(id(), false)
        }
        onMouseOver={() => setHovered(id())}
        onMouseOut={() => setHovered(undefined)}
        onMouseDown={(event: MouseEvent) => {
          if (event.button !== 0) return
          event.stopPropagation()
          pressedGroup = props.group.key
          setDrag({ key: props.group.key, startY: event.y, moved: false, target: props.position })
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            // A finished drag reorders; a click pressed and released on this header toggles the group.
            const over = !!header && event.y >= header.screenY && event.y < header.screenY + header.height
            if (!finishDrag() && event.button === 0 && pressedGroup === props.group.key && over)
              toggleGroup(props.group.key)
          })
        }
      >
        <Show
          when={!narrow()}
          fallback={
            <>
              <text selectable={false} fg={theme().hue.accent[200]}>
                {truncate(arrow() + props.group.name, innerWidth() - (marker() ? 1 : 0))}
              </text>
              <box flexGrow={1} />
              <text selectable={false} fg={marker()?.color}>{marker()?.char ?? ""}</text>
            </>
          }
        >
          <text selectable={false} fg={theme().text.muted}>{` ${arrow()} `}</text>
          <text selectable={false} fg={dragging() ? theme().text.base : theme().hue.accent[200]}>
            {truncate(props.group.name, nameWidth())}
          </text>
          <text selectable={false} fg={theme().text.muted}>{noGitLabel()}</text>
          <box flexGrow={1} />
          <For each={counts()}>{(item) => <text selectable={false} fg={item.color}>{item.text + " "}</text>}</For>
          <Show when={keys()}>
            <text selectable={false} fg={dragging() ? theme().text.base : selected() ? theme().hue.accent[200] : theme().text.muted}>
              {keys() + " "}
            </text>
          </Show>
        </Show>
      </box>
    )
  }

  function TabRow(props: { tab: Tab; groupKey: string; position: number }) {
    const id = () => `tab:${props.tab.sessionID}`
    const armed = () => pending() === props.groupKey
    const dragged = () =>
      (!!drag()?.moved && props.groupKey === drag()?.key) ||
      (!!tabDrag()?.moved && tabDrag()?.sessionID === props.tab.sessionID)
    // A collapsed group hides rows, so the drop position could not be read from the screen.
    const draggable = () => {
      const group = groupByKey(props.groupKey)
      return !recent && !!group && visibleTabIDs(group).length === group.tabs.length
    }
    let row: BoxRenderable | undefined
    onCleanup(() => {
      if (tabRows.get(props.tab.sessionID) === row) tabRows.delete(props.tab.sessionID)
    })
    // Tabs show the second key of the chord only while their group is selected.
    const keys = () => (armed() ? slotLabel(props.position) : "")
    // Layout: marker, status, space, title, space, keys, space, close button (2 columns, always reserved).
    const showKeys = () => keys().length > 0 && innerWidth() - 5 - keys().length - 2 >= 6
    const titleWidth = () => innerWidth() - 5 - (showKeys() ? keys().length + 2 : 0)
    const [closeHovered, setCloseHovered] = createSignal(false)
    return (
      <box
        ref={(element: BoxRenderable) => tabRows.set(props.tab.sessionID, (row = element))}
        flexDirection="row"
        height={rowHeight}
        flexShrink={0}
        paddingTop={padding}
        backgroundColor={dragged() ? theme().background.raised.high : rowBackground(id(), props.tab.active)}
        onMouseOver={() => setHovered(id())}
        onMouseOut={() => setHovered(undefined)}
        onMouseDown={(event: MouseEvent) => {
          pressedGroup = undefined
          if (event.button !== 0 || !draggable()) return
          event.stopPropagation()
          setTabDrag({ sessionID: props.tab.sessionID, startY: event.y, moved: false, target: props.position })
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            if (finishDrag()) return
            if (event.button === 1) void requestClose(props.tab.sessionID).catch(fail)
            else if (event.button === 0) focus(props.tab.sessionID)
          })
        }
      >
        <text selectable={false} fg={theme().hue.accent[300]}>{props.tab.active ? "▌" : " "}</text>
        <text selectable={false} fg={status(props.tab).color}>{status(props.tab).char}</text>
        <Show
          when={!narrow()}
          fallback={
            <text selectable={false} fg={theme().hue.accent[200]}>
              {armed() ? (slotKeys[props.position] ?? "") : ""}
            </text>
          }
        >
          <text selectable={false}>{" "}</text>
          <text selectable={false} fg={titleColor()}>
            {truncate(titleOf(props.tab), titleWidth())}
          </text>
          <box flexGrow={1} />
          <Show when={showKeys()}>
            <text selectable={false} fg={armed() ? theme().hue.accent[200] : theme().text.muted}>{keys() + " "}</text>
          </Show>
          {/* Shown on row hover; only a click on the cross itself closes the tab. */}
          <box
            width={2}
            flexShrink={0}
            onMouseOver={() => setCloseHovered(true)}
            onMouseOut={() => setCloseHovered(false)}
            onMouseUp={(event: MouseEvent) =>
              click(event, () => {
                if (event.button === 0 && hovered() === id()) void requestClose(props.tab.sessionID).catch(fail)
              })
            }
          >
            <text selectable={false} fg={closeHovered() ? theme().text.feedback.error.base : theme().text.muted}>
              {hovered() === id() ? "✕ " : "  "}
            </text>
          </box>
        </Show>
      </box>
    )
  }

  // Rows keep their last known data: closing a tab updates the data before the row unmounts,
  // and a Show accessor read in that window throws a stale-read error.
  function sticky<T>(read: () => T | undefined) {
    let last: T | undefined
    return createMemo(() => (last = read() ?? last))
  }

  function GroupBlock(props: { groupKey: string; position: number }) {
    const group = sticky(() => groupByKey(props.groupKey))
    return (
      <Show when={group()}>
        <Show when={props.position > 0}>
          <box height={1} flexShrink={0} />
        </Show>
        <GroupRow group={group()!} position={props.position} collapsed={!!state.collapsed[props.groupKey]} />
        <For each={visibleTabIDs(group()!)}>
          {(sessionID) => <TabItem group={group()!} sessionID={sessionID} />}
        </For>
      </Show>
    )
  }

  function TabItem(props: { group: Group; sessionID: string }) {
    const tab = sticky(() => props.group.tabs.find((item) => item.sessionID === props.sessionID))
    const position = () => props.group.tabs.findIndex((item) => item.sessionID === props.sessionID)
    return (
      <Show when={tab()}>
        <TabRow tab={tab()!} groupKey={props.group.key} position={Math.max(0, position())} />
      </Show>
    )
  }

  function NewSessionRow() {
    return (
      <box
        flexDirection="row"
        height={rowHeight}
        flexShrink={0}
        paddingTop={padding}
        backgroundColor={rowBackground("new", false)}
        onMouseOver={() => setHovered("new")}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event: MouseEvent) => click(event, () => ctx.keymap.dispatch("session.new"))}
      >
        <text selectable={false} fg={theme().text.muted}>{narrow() ? " +" : " + New session"}</text>
      </box>
    )
  }

  // Commands -----------------------------------------------------------------------------------

  const toggleHidden = () => {
    try {
      if (tabsOverridden())
        toast("OPENCODE_CLI_CONFIG_CONTENT overrides tabs, so cli.json changes have no effect", "warning")
      const mode = readTabsMode()
      if (mode === "off") {
        writeTabsMode(state.restoreMode === "off" ? "auto" : state.restoreMode)
        return
      }
      void update((draft) => void (draft.restoreMode = mode)).catch(fail)
      writeTabsMode("off")
    } catch (error) {
      fail(error)
    }
  }

  const closeCurrent = () => {
    if (!ctx.ui.tabs.close()) toast("No tab is open", "warning")
  }

  // Single-click closes are easy to trigger by accident; commands stay immediate.
  const requestClose = async (sessionID: string) => {
    if (confirmClose) {
      const tab = tabs().find((item) => item.sessionID === sessionID)
      const answer = await ctx.ui.dialog.confirm({
        title: "Close tab",
        message: tab ? `Close “${titleOf(tab)}”? The session is kept and can be reopened.` : "Close this tab?",
        label: { confirm: "Close", cancel: "Cancel" },
      })
      if (!answer) return
    }
    ctx.ui.tabs.close(sessionID)
  }

  const setAllCollapsed = (collapsed: boolean) =>
    void update((draft) => {
      draft.collapsed = {}
      if (collapsed) for (const group of groups()) draft.collapsed[group.key] = true
    }).catch(fail)

  const openPicker = async () => {
    const options = groups().flatMap((group, position) =>
      group.tabs.map((tab, index) => ({
        title: titleOf(tab),
        value: tab.sessionID,
        category: group.name,
        footer:
          position < slotKeys.length && index < slotKeys.length ? `${slotLabel(position)} ${slotLabel(index)}` : undefined,
      })),
    )
    const selected = await ctx.ui.dialog.select({
      title: "Tabs",
      placeholder: "Search tabs",
      options,
      current: tabs().find((tab) => tab.active)?.sessionID,
    })
    if (selected) focus(selected)
  }

  // Slash completion runs while the prompt has focus, which only global layers reach.
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "better-tabs.picker",
        title: "Find tab",
        group: "Better tabs",
        bind: "<leader>p",
        palette: true,
        slash: { name: "tabs" },
        run: () => void openPicker().catch(fail),
      },
      {
        id: "better-tabs.hide",
        title: "Show or hide tabs",
        group: "Better tabs",
        bind: "<leader>h",
        palette: true,
        slash: { name: "tabs-hide" },
        run: toggleHidden,
      },
      {
        id: "better-tabs.close",
        title: "Close current tab",
        group: "Better tabs",
        palette: true,
        slash: { name: "close" },
        run: closeCurrent,
      },
      {
        id: "better-tabs.archive",
        title: "Archive current tab",
        group: "Better tabs",
        palette: true,
        slash: { name: "archive" },
        run: closeCurrent,
      },
      {
        id: "better-tabs.group",
        title: "Group tabs by repository",
        group: "Better tabs",
        palette: true,
        run: applyGrouping,
      },
      {
        id: "better-tabs.autogroup",
        title: "Toggle automatic tab grouping",
        group: "Better tabs",
        palette: true,
        run: () =>
          void update((draft) => void (draft.autoGroup = !draft.autoGroup))
            .then(() => toast(`Automatic grouping ${state.autoGroup ? "on" : "off"}`))
            .catch(fail),
      },
      {
        id: "better-tabs.collapse-all",
        title: "Collapse all tab groups",
        group: "Better tabs",
        palette: true,
        run: () => setAllCollapsed(true),
      },
      {
        id: "better-tabs.expand-all",
        title: "Expand all tab groups",
        group: "Better tabs",
        palette: true,
        run: () => setAllCollapsed(false),
      },
    ],
  }))

  // Only while a group is selected: these outrank escape (interrupt) and alt+arrows (tab cycling).
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 200,
    enabled: () => pending() !== undefined,
    commands: [
      {
        title: "Cancel tab group selection",
        group: "Better tabs",
        // Some terminals swallow a bare escape, so alt+x and alt+escape cancel too.
        bind: `escape,${modifier}+x,${modifier}+escape`,
        run: clearChord,
      },
      { title: "Move tab group up", group: "Better tabs", bind: `${modifier}+up`, run: () => moveSelected(-1) },
      { title: "Move tab group down", group: "Better tabs", bind: `${modifier}+down`, run: () => moveSelected(1) },
    ],
  }))

  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: slotKeys.map((key, slot) => ({
      id: `better-tabs.key.${key}`,
      title: `Select tab group ${slot + 1}, then a tab in it`,
      group: "Better tabs",
      bind: `${modifier}+${key}`,
      run: () => chord(slot),
    })),
  }))

  return (
    <>
      <box ref={(element: BoxRenderable) => (anchor = element)} height={0} flexShrink={0} />
      <Show when={visible() && host()} keyed>
        {(row) => (
          <Portal
            mount={row}
            ref={(element) => {
              // Portal wraps content in a flex child; pin it over the host bar like the host's own tab menu.
              const container = element as BoxRenderable
              container.position = "absolute"
              container.left = 0
              container.top = 0
              container.zIndex = 20
            }}
          >
            <box
              width={innerWidth()}
              height={geometry().height}
              flexDirection="column"
              backgroundColor={background()}
              onMouseDown={() => (pressedGroup = undefined)}
              onMouseDrag={dragMove}
              onMouseDragEnd={() => finishDrag()}
              onMouseUp={() => finishDrag()}
            >
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
                <box flexDirection="column" flexShrink={0} paddingTop={1}>
                  <For each={groupKeys()}>
                    {(key, position) => <GroupBlock groupKey={key} position={position()} />}
                  </For>
                  <box height={1} flexShrink={0} />
                  <NewSessionRow />
                </box>
              </scrollbox>
            </box>
          </Portal>
        )}
      </Show>
    </>
  )
}

export default Plugin.define({
  id: "better-tabs",
  setup(context) {
    void context.data.project.sync().catch(() => {})
    return context.ui.slot({ append: "app", render: () => <BetterTabs /> })
  },
})
