/** @jsxImportSource @opentui/solid */
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
// OpenCode files sessions outside any repository under this shared project ID.
const GLOBAL_PROJECT = "global"
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

  const groupOf = (sessionID: string) => {
    const session = ctx.data.session.get(sessionID)
    if (!session) return undefined
    const directory = session.location.directory
    if (session.projectID === GLOBAL_PROJECT) {
      const normalized = path.resolve(directory)
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized
      return { key: `dir:${key}`, name: path.basename(normalized) || normalized, noGit: true }
    }
    const project = ctx.data.project.get(session.projectID)
    const canonical = project?.canonical ?? directory
    const name = project?.name || path.basename(canonical) || canonical
    return { key: session.projectID, name, noGit: false }
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
  const timer = setInterval(() => {
    measure()
    if (anyBusy()) setTick((value) => (value + 1) % SPINNER.length)
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
  const click = (event: MouseEvent, run: () => void) => {
    event.stopPropagation()
    run()
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

  const finishDrag = (key: string) => {
    const current = drag()
    if (!current || current.key !== key) return false
    setDrag(undefined)
    if (current.moved) moveGroup(key, current.target)
    return current.moved
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
        onMouseDrag={(event: MouseEvent) => {
          const current = drag()
          if (!current || current.key !== props.group.key) return
          event.stopPropagation()
          const moved = current.moved || event.y !== current.startY
          if (moved) setDrag({ ...current, moved, target: dropTarget(current.key, event.y) })
        }}
        onMouseDragEnd={(event: MouseEvent) => {
          event.stopPropagation()
          finishDrag(props.group.key)
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            // A finished drag reorders; a plain click toggles the group.
            if (!finishDrag(props.group.key) && event.button === 0) toggleGroup(props.group.key)
          })
        }
      >
        <Show
          when={!compact()}
          fallback={
            <>
              <text fg={theme().hue.accent[200]}>
                {truncate(arrow() + props.group.name, innerWidth() - (marker() ? 1 : 0))}
              </text>
              <box flexGrow={1} />
              <text fg={marker()?.color}>{marker()?.char ?? ""}</text>
            </>
          }
        >
          <text fg={theme().text.muted}>{` ${arrow()} `}</text>
          <text fg={dragging() ? theme().text.base : theme().hue.accent[200]}>
            {truncate(props.group.name, nameWidth())}
          </text>
          <text fg={theme().text.muted}>{noGitLabel()}</text>
          <box flexGrow={1} />
          <For each={counts()}>{(item) => <text fg={item.color}>{item.text + " "}</text>}</For>
          <Show when={keys()}>
            <text fg={dragging() ? theme().text.base : selected() ? theme().hue.accent[200] : theme().text.muted}>
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
        <text fg={theme().hue.accent[300]}>{props.tab.active ? "▌" : " "}</text>
        <text fg={status(props.tab).color}>{status(props.tab).char}</text>
        <Show
          when={!compact()}
          fallback={
            <text fg={theme().hue.accent[200]}>
              {armed() ? (slotKeys[props.position] ?? "") : ""}
            </text>
          }
        >
          <text>{" "}</text>
          <text fg={titleColor()}>
            {truncate(titleOf(props.tab), titleWidth())}
          </text>
          <box flexGrow={1} />
          <Show when={showKeys()}>
            <text fg={armed() ? theme().hue.accent[200] : theme().text.muted}>{keys() + " "}</text>
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
            <text fg={closeHovered() ? theme().text.feedback.error.base : theme().text.muted}>
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
        <text fg={theme().text.muted}>{compact() ? " +" : " + New session"}</text>
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
