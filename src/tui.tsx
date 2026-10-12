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
  readVerticalTabsWidth,
  writeTabsMode,
  writeVerticalTabsWidth,
  type TabsMode,
} from "./config-files"

type Tab = ReturnType<Context["ui"]["tabs"]["list"]>[number]
type Group = { key: string; name: string; noGit: boolean; tabs: Tab[] }

// Matches the host's SESSION_TABS_COMPACT_BREAKPOINT, so both bars switch modes at the same width.
const COMPACT_BREAKPOINT = 12
const COMPACT_WIDTH = 6
const DEFAULT_WIDTH = 42
const CHORD_TIMEOUT = 3000
// How far tab titles lean from the base text colour towards the muted one.
const TITLE_DIM = 0.2
const MIN_GROUP_NAME = 6
const MIN_STRIP_TITLE = 14
const MAX_STRIP_TITLE = 30
// Older OpenCode builds file sessions outside any repository under this shared project ID.
const GLOBAL_PROJECT = "global"
// Ticks of the 100 ms timer between checks for a `.git` created after startup.
const GIT_RECHECK_TICKS = 50
// alt+a/b/d/e/f edit the prompt (line start/end, word moves, word delete), so they are skipped.
const DEFAULT_KEYS = "123456789cghijklmnopqrstuvwxyz"
const UNKNOWN_GROUP = "\u0000unknown"
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type State = {
  collapsed: Record<string, boolean>
  autoGroup: boolean
  expandedWidth: number
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
    initial: { collapsed: {}, autoGroup: true, expandedWidth: DEFAULT_WIDTH, restoreMode: "auto", groupOrder: [] },
  })
  const [memory, setMemory] = ctx.storage.memory<{ ids: string[] }>("memory", { initial: { ids: [] } })

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Better tabs", message, variant })
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error")

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

  const requested = new Set<string>()
  createEffect(() => {
    for (const tab of tabs()) {
      if (ctx.data.session.get(tab.sessionID) || requested.has(tab.sessionID)) continue
      requested.add(tab.sessionID)
      void ctx.data.session.sync(tab.sessionID).catch(() => {})
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
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized
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

  // Groups in their saved order; groups without a saved position follow in tab order.
  const orderedGroups = createMemo(() => {
    const result = new Map<string, Group>()
    for (const tab of tabs()) {
      const info = groupOf(tab.sessionID) ?? { key: UNKNOWN_GROUP, name: "…", noGit: false }
      const group = result.get(info.key) ?? { ...info, tabs: [] }
      group.tabs.push(tab)
      result.set(info.key, group)
    }
    const order = state.groupOrder ?? []
    const rank = (key: string) => {
      const index = order.indexOf(key)
      return index === -1 ? order.length : index
    }
    return [...result.values()].sort((left, right) => rank(left.key) - rank(right.key))
  })

  // Live reorder while a group header is being dragged.
  const [drag, setDrag] = createSignal<{ key: string; startY: number; moved: boolean; target: number }>()
  const groups = createMemo(() => {
    const list = orderedGroups()
    const current = drag()
    if (!current?.moved) return list
    const from = list.findIndex((group) => group.key === current.key)
    return from === -1 ? list : moveItem(list, from, current.target)
  })

  const moveGroup = (key: string, to: number) => {
    const list = orderedGroups().map((group) => group.key)
    const from = list.indexOf(key)
    if (from === -1) return
    const next = moveItem(list, from, to)
    void update((draft) => {
      draft.groupOrder = [...next, ...(draft.groupOrder ?? []).filter((item) => !next.includes(item))]
    }).catch(fail)
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
  // Many terminals send ctrl+digit as a plain digit, so the modifier defaults to alt.
  const modifier = typeof ctx.options.modifier === "string" ? ctx.options.modifier : "alt"
  const slotKeys = [
    ...new Set((typeof ctx.options.keys === "string" ? ctx.options.keys : DEFAULT_KEYS).toLowerCase()),
  ].filter((key) => /^[a-z0-9]$/.test(key))

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
    const slot = slotBox()
    if (slot && !slot.isDestroyed) {
      if (slot !== host()) setHost(slot)
      const previous = geometry()
      if (previous.width !== slot.width || previous.height !== slot.height)
        setGeometry({ width: slot.width, height: slot.height })
      return
    }
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
  const compact = () => geometry().width < COMPACT_BREAKPOINT

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
  const click = (event: MouseEvent, run: () => void) => {
    event.stopPropagation()
    if (!dropped) run()
  }

  const background = () => theme().background.raised.base
  const titleColor = createMemo(() => mix(theme().text.base, theme().text.muted, TITLE_DIM))
  const rowBackground = (id: string, active: boolean) =>
    active ? theme().background.raised.max : hovered() === id ? theme().background.raised.high : background()

  // Drop position among the other groups, from where their headers sit on screen.
  const headers = new Map<string, BoxRenderable>()
  const dropTarget = (key: string, y: number) =>
    orderedGroups().filter((group) => {
      if (group.key === key) return false
      const header = headers.get(group.key)
      return !!header && !header.isDestroyed && header.screenY < y
    }).length

  // Drag events go to whatever row the pointer first moved onto, so the whole bar handles them.
  const dragMove = (event: MouseEvent) => {
    const current = drag()
    if (!current) return
    const moved = current.moved || event.y !== current.startY
    if (moved) setDrag({ ...current, moved, target: dropTarget(current.key, event.y) })
  }

  const finishDrag = () => {
    const current = drag()
    if (!current) return false
    setDrag(undefined)
    if (!current.moved) return false
    moveGroup(current.key, current.target)
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
        height={1}
        flexShrink={0}
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
          setDrag({ key: props.group.key, startY: event.y, moved: false, target: props.position })
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            // A finished drag reorders; a plain click toggles the group.
            if (!finishDrag() && event.button === 0) toggleGroup(props.group.key)
          })
        }
      >
        <Show
          when={!compact()}
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
    const dragged = () => !!drag()?.moved && props.groupKey === drag()?.key
    // Tabs show the second key of the chord only while their group is selected.
    const keys = () => (armed() ? slotLabel(props.position) : "")
    // Layout: marker, status, space, title, space, keys, space, close button (2 columns, always reserved).
    const showKeys = () => keys().length > 0 && innerWidth() - 5 - keys().length - 2 >= 6
    const titleWidth = () => innerWidth() - 5 - (showKeys() ? keys().length + 2 : 0)
    const [closeHovered, setCloseHovered] = createSignal(false)
    return (
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        backgroundColor={dragged() ? theme().background.raised.high : rowBackground(id(), props.tab.active)}
        onMouseOver={() => setHovered(id())}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            if (event.button === 1) ctx.ui.tabs.close(props.tab.sessionID)
            else if (event.button === 0) focus(props.tab.sessionID)
          })
        }
      >
        <text selectable={false} fg={theme().hue.accent[300]}>{props.tab.active ? "▌" : " "}</text>
        <text selectable={false} fg={status(props.tab).color}>{status(props.tab).char}</text>
        <Show
          when={!compact()}
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
                if (event.button === 0 && hovered() === id()) ctx.ui.tabs.close(props.tab.sessionID)
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
        height={1}
        flexShrink={0}
        backgroundColor={rowBackground("new", false)}
        onMouseOver={() => setHovered("new")}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event: MouseEvent) => click(event, () => ctx.keymap.dispatch("session.new"))}
      >
        <text selectable={false} fg={theme().text.muted}>{compact() ? " +" : " + New session"}</text>
      </box>
    )
  }

  // Horizontal strip: one row of colour-coded groups; one group shows its tabs -----------------

  const activeGroupKey = createMemo(() => groups().find((group) => group.tabs.some((tab) => tab.active))?.key)
  // A clicked group stays open until the active tab moves.
  const [viewed, setViewed] = createSignal<string>()
  createEffect(() => {
    activeGroupKey()
    setViewed(undefined)
  })
  const shownKey = () => pending() ?? viewed() ?? activeGroupKey() ?? groups()[0]?.key

  const groupColor = (group: Group, position: number) => {
    if (group.noGit) return theme().text.muted
    const palette = theme().categorical
    const scale = palette[position % palette.length]!
    return ctx.themeMode === "dark" ? scale[300] : scale[600]
  }
  const tint = (color: RGBA, amount: number) => mix(background(), color, amount)

  // Pill: space, key, space, name, space. Tabs: space, status, key, space, title, close button.
  const pillWidth = (group: Group, position: number) =>
    group.name.length + 3 + (pending() === undefined && slotKeys[position] ? 2 : 0)
  const foldedWidth = (group: Group) => {
    const counts = groupCounts(group, Infinity).reduce((sum, item) => sum + item.text.length + 1, 0)
    return counts ? counts + 1 : 0
  }
  // Space for the open group's tabs; when they do not fit, a window around the active tab is shown.
  const stripLayout = (width: number) => {
    const list = groups()
    const open = list.find((group) => group.key === shownKey())
    if (!open) return { title: 0, ids: [] as string[], hidden: 0 }
    const fixed = list.reduce(
      (sum, group, position) => sum + pillWidth(group, position) + 1 + (group === open ? 0 : foldedWidth(group)),
      4,
    )
    const available = width - fixed
    const count = Math.max(1, open.tabs.length)
    // Each tab adds 6 columns around its title: space, key, status, space, close button.
    const even = Math.floor(available / count) - 6
    if (even >= MIN_STRIP_TITLE)
      return { title: Math.min(MAX_STRIP_TITLE, even), ids: open.tabs.map((tab) => tab.sessionID), hidden: 0 }
    const fits = Math.max(1, Math.floor((available - 4) / (MIN_STRIP_TITLE + 6)))
    const title = Math.min(MAX_STRIP_TITLE, Math.floor((available - 4) / fits) - 6)
    const active = Math.max(0, open.tabs.findIndex((tab) => tab.active))
    const start = Math.max(0, Math.min(count - fits, active - Math.floor(fits / 2)))
    const ids = open.tabs.slice(start, start + fits).map((tab) => tab.sessionID)
    return { title, ids, hidden: open.tabs.length - fits }
  }

  function StripTab(props: { tab: Tab; group: Group; color: RGBA; position: number; width: number }) {
    const id = () => `strip:${props.tab.sessionID}`
    const key = () => (pending() === props.group.key ? (slotKeys[props.position] ?? "") : "")
    return (
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        backgroundColor={tint(props.color, props.tab.active ? 0.38 : hovered() === id() ? 0.26 : 0.14)}
        onMouseOver={() => setHovered(id())}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            if (event.button === 1) ctx.ui.tabs.close(props.tab.sessionID)
            else if (event.button === 0) focus(props.tab.sessionID)
          })
        }
      >
        <text selectable={false}>{" "}</text>
        <Show when={key()} fallback={<text selectable={false}>{" "}</text>}>
          <box backgroundColor={props.color} flexShrink={0}>
            <text selectable={false} fg={background()}>{key()}</text>
          </box>
        </Show>
        <text selectable={false} fg={status(props.tab).color}>{status(props.tab).char}</text>
        <text selectable={false} fg={props.tab.active ? theme().text.base : titleColor()}>
          {" " + truncate(titleOf(props.tab), props.width)}
        </text>
        <box
          width={2}
          flexShrink={0}
          onMouseUp={(event: MouseEvent) =>
            click(event, () => {
              if (event.button === 0 && hovered() === id()) ctx.ui.tabs.close(props.tab.sessionID)
            })
          }
        >
          <text selectable={false} fg={theme().text.muted}>{hovered() === id() ? "✕ " : "  "}</text>
        </box>
      </box>
    )
  }

  function StripTabItem(props: { group: Group; color: RGBA; sessionID: string; width: number }) {
    const tab = sticky(() => props.group.tabs.find((item) => item.sessionID === props.sessionID))
    const position = () => props.group.tabs.findIndex((item) => item.sessionID === props.sessionID)
    return (
      <Show when={tab()}>
        <StripTab
          tab={tab()!}
          group={props.group}
          color={props.color}
          position={Math.max(0, position())}
          width={props.width}
        />
      </Show>
    )
  }

  function StripGroup(props: { group: Group; position: number; width: number }) {
    const color = () => groupColor(props.group, props.position)
    const open = () => shownKey() === props.group.key
    const selected = () => pending() === props.group.key
    const key = () => (pending() === undefined ? (slotKeys[props.position] ?? "") : "")
    const dimmed = () => pending() !== undefined && !selected()
    return (
      <box flexDirection="row" height={1} flexShrink={0}>
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          backgroundColor={dimmed() ? tint(color(), 0.3) : color()}
          onMouseUp={(event: MouseEvent) => click(event, () => event.button === 0 && setViewed(props.group.key))}
        >
          <Show when={key()}>
            <text selectable={false} fg={mix(background(), color(), 0.5)}>
              {" " + key()}
            </text>
          </Show>
          <text selectable={false} fg={dimmed() ? color() : background()}>
            {" " + props.group.name + " "}
          </text>
        </box>
        <Show
          when={open()}
          fallback={
            <Show when={foldedWidth(props.group)}>
              <box flexDirection="row" height={1} flexShrink={0} backgroundColor={tint(color(), 0.14)}>
                <For each={groupCounts(props.group, Infinity)}>
                  {(item) => <text selectable={false} fg={item.color}>{" " + item.text}</text>}
                </For>
                <text selectable={false}>{" "}</text>
              </box>
            </Show>
          }
        >
          <For each={stripLayout(props.width).ids}>
            {(sessionID) => (
              <StripTabItem group={props.group} color={color()} sessionID={sessionID} width={stripLayout(props.width).title} />
            )}
          </For>
          <Show when={stripLayout(props.width).hidden}>
            <box flexShrink={0} backgroundColor={tint(color(), 0.14)}>
              <text selectable={false} fg={theme().text.muted}>{` +${stripLayout(props.width).hidden} `}</text>
            </box>
          </Show>
        </Show>
      </box>
    )
  }

  function Strip(props: { width: number }) {
    return (
      <box width={props.width} height={1} flexDirection="row" backgroundColor={background()}>
        <For each={groupKeys()}>
          {(key, position) => {
            const group = sticky(() => groupByKey(key))
            return (
              <Show when={group()}>
                <text selectable={false}>{" "}</text>
                <StripGroup group={group()!} position={position()} width={props.width} />
              </Show>
            )
          }}
        </For>
        <box flexGrow={1} />
        <box
          flexShrink={0}
          backgroundColor={rowBackground("strip:new", false)}
          onMouseOver={() => setHovered("strip:new")}
          onMouseOut={() => setHovered(undefined)}
          onMouseUp={(event: MouseEvent) => click(event, () => ctx.keymap.dispatch("session.new"))}
        >
          <text selectable={false} fg={theme().text.muted}>{" + "}</text>
        </box>
      </box>
    )
  }

  // Commands -----------------------------------------------------------------------------------

  const toggleCompact = () => {
    try {
      const current = readVerticalTabsWidth(ctx.app.channel) ?? geometry().width
      if (current < COMPACT_BREAKPOINT) {
        writeVerticalTabsWidth(
          ctx.app.channel,
          state.expandedWidth >= COMPACT_BREAKPOINT ? state.expandedWidth : DEFAULT_WIDTH,
        )
        return
      }
      void update((draft) => void (draft.expandedWidth = current)).catch(fail)
      writeVerticalTabsWidth(ctx.app.channel, COMPACT_WIDTH)
    } catch (error) {
      fail(error)
    }
  }

  const toggleHidden = () => {
    try {
      if (process.env.OPENCODE_CLI_CONFIG_CONTENT?.includes('"tabs"'))
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

  ctx.keymap.layer(() => ({
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
        id: "better-tabs.compact",
        title: "Toggle compact tabs",
        group: "Better tabs",
        bind: "<leader>k",
        palette: true,
        slash: { name: "tabs-compact" },
        run: toggleCompact,
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
      <Show when={ctx.ui.tabs.enabled() && tabs().length > 0 && stripSlot()} keyed>
        {(slot) => (
          <Portal mount={slot.box}>
            <Strip width={slot.width()} />
          </Portal>
        )}
      </Show>
    </>
  )
}

// Hosts that publish `session.tabs.*` hand us the bar's box; older hosts drop the claims, and we overlay
// the vertical bar only.
const [slotBox, setSlotBox] = createSignal<BoxRenderable>()

function TabsSlot(props: { width: number }) {
  onCleanup(() => setSlotBox(undefined))
  return <box ref={(element: BoxRenderable) => setSlotBox(element)} width={props.width} flexGrow={1} />
}

const [stripSlot, setStripSlot] = createSignal<{ box: BoxRenderable; width: () => number }>()

function StripSlot(props: { width: number }) {
  onCleanup(() => setStripSlot(undefined))
  return (
    <box
      ref={(element: BoxRenderable) => setStripSlot({ box: element, width: () => props.width })}
      width={props.width}
      height={1}
      flexShrink={0}
    />
  )
}

export default Plugin.define({
  id: "better-tabs",
  setup(context) {
    void context.data.project.sync().catch(() => {})
    const disposeApp = context.ui.slot({ append: "app", render: () => <BetterTabs /> })
    const disposeTabs = context.ui.slot({
      replace: "session.tabs.vertical",
      render: (input: { width: number }) => <TabsSlot width={input.width} />,
    } as unknown as Parameters<typeof context.ui.slot>[0])
    const disposeStrip = context.ui.slot({
      replace: "session.tabs.horizontal",
      render: (input: { width: number }) => <StripSlot width={input.width} />,
    } as unknown as Parameters<typeof context.ui.slot>[0])
    return () => {
      disposeStrip()
      disposeTabs()
      disposeApp()
    }
  },
})
