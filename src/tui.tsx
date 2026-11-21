/** @jsxImportSource @opentui/solid */
import { existsSync } from "node:fs"
import path from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, type BoxRenderable, type MouseEvent, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { Portal } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import {
  readTabsMode,
  tabsOverridden,
  writeTabsMode,
  type TabsMode,
} from "./config-files"
import { readOptions } from "./options"
import { metadataParent, resolveParents } from "./sub-sessions"

type Tab = ReturnType<Context["ui"]["tabs"]["list"]>[number]
type Group = { key: string; name: string; noGit: boolean; tabs: Tab[] }

// Matches the host's SESSION_TABS_COMPACT_BREAKPOINT: when the user drags its bar this narrow, both bars shrink together.
const NARROW_BREAKPOINT = 12
const CHORD_TIMEOUT = 3000
// How far tab titles lean from the base text colour towards the muted one.
const TITLE_DIM = 0.2
const SUB_TITLE_DIM = 0.6
const MIN_GROUP_NAME = 6
// Older OpenCode builds file sessions outside any repository under this shared project ID.
const GLOBAL_PROJECT = "global"
// Ticks of the 100 ms timer between checks for a `.git` created after startup.
const GIT_RECHECK_TICKS = 50
const SYNC_RETRY = 5000
// How long to wait for the host to show a tab move before checking the order again.
const HOST_MOVE_WAIT = 1000
const UNKNOWN_GROUP = "\u0000unknown"
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type State = {
  collapsed: Record<string, boolean>
  autoGroup: boolean
  restoreMode: TabsMode
  groupOrder: string[]
  grouping: "repo" | "custom"
  customGroups: Record<string, string>
  // Sub-session links set in the bar: a parent ID, or null to undo the agent's or OpenCode's link.
  parents: Record<string, string | null>
}

// Tabs without a custom group land here, so no tab is ever left without a group.
const UNGROUPED = "Ungrouped"
const customKey = (name: string) => `custom:${name}`
const UNGROUPED_KEY = customKey(UNGROUPED)
const cleanGroupName = (name: string | undefined) => {
  const clean = (name ?? "").trim()
  return !clean || clean.toLowerCase() === UNGROUPED.toLowerCase() ? UNGROUPED : clean
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
    initial: { collapsed: {}, autoGroup: true, restoreMode: "auto", groupOrder: [], grouping: "repo", customGroups: {}, parents: {} },
  })
  const [memory, setMemory] = ctx.storage.memory<{ ids: string[] }>("memory", { initial: { ids: [] } })

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Better tabs", message, variant })
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error")

  const options = readOptions(ctx.options)
  for (const warning of options.warnings) toast(warning, "warning")
  const { modifier, slotKeys, confirmClose, padding, subSessions } = options
  // Dragging is off in recent mode: activity would undo any manual move at once.
  const recent = options.sort === "recent"

  // Tabs, sessions and groups ------------------------------------------------------------------

  // While tabs are hidden the host no longer tracks them, so fall back to the last known list.
  // Until the host shows our latest move, tabs keep the order we asked for, so a dropped tab does not flicker.
  const [awaitedOrder, setAwaitedOrder] = createSignal<string[]>()
  const tabs = createMemo<readonly Tab[]>(() => {
    if (ctx.ui.tabs.enabled()) {
      const list = ctx.ui.tabs.list()
      const order = awaitedOrder()
      if (!order || order.length !== list.length) return list
      const rank = new Map(order.map((id, index) => [id, index]))
      return list.every((tab) => rank.has(tab.sessionID))
        ? [...list].sort((left, right) => rank.get(left.sessionID)! - rank.get(right.sessionID)!)
        : list
    }
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

  // Default Windows and macOS file systems ignore case, so `~/Repo` and `~/repo` are one folder.
  const folderOf = (directory: string) => {
    const normalized = path.resolve(directory)
    return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized
  }

  const groupOf = (sessionID: string) => {
    const session = ctx.data.session.get(sessionID)
    if (!session) return undefined
    const directory = session.location.directory
    if (session.projectID === GLOBAL_PROJECT) {
      const normalized = path.resolve(directory)
      const folder = folderOf(directory)
      return { key: `dir:${folder}`, folder, name: path.basename(normalized) || normalized, noGit: !insideGit(normalized) }
    }
    const project = ctx.data.project.get(session.projectID)
    const canonical = project?.canonical ?? directory
    const name = project?.name || path.basename(canonical) || canonical
    // Directories without a repository get their own project with no `vcs`.
    const noGit = !!project && !project.vcs && !insideGit(canonical)
    return { key: session.projectID, folder: folderOf(canonical), name, noGit }
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

  // Repository grouping is the default; custom grouping assigns tabs to your own named groups.
  const grouping = () => state.grouping ?? "repo"
  // Like localOrder: group changes show at once, before the async save lands.
  const [localGroups, setLocalGroups] = createSignal<Record<string, string | null>>({})
  let groupWrites = 0
  const customMap = () => {
    const local = Object.entries(localGroups())
    if (!local.length) return state.customGroups ?? {}
    const result = { ...state.customGroups }
    for (const [id, name] of local) {
      if (name === null) delete result[id]
      else result[id] = name
    }
    return result
  }

  const customInfo = (sessionID: string) => {
    const name = cleanGroupName(customMap()[sessionID])
    return { key: customKey(name), name, noGit: false }
  }

  // Sub-sessions follow their parent tab instead of a group. A link set in the bar wins over the agent's
  // (session metadata) and OpenCode's own parentID.
  const linkOf = (sessionID: string) => {
    const own = state.parents?.[sessionID]
    if (own !== undefined) return own ?? undefined
    const session = ctx.data.session.get(sessionID)
    const linked = metadataParent(session?.metadata)
    return linked === undefined ? session?.parentID : (linked ?? undefined)
  }
  const parents = createMemo(() =>
    subSessions ? resolveParents(tabs().map((tab) => tab.sessionID), linkOf) : new Map<string, string>(),
  )
  const childrenOf = (sessionID: string) => tabs().filter((tab) => parents().get(tab.sessionID) === sessionID)
  const familyOf = (sessionID: string) => [sessionID, ...childrenOf(sessionID).map((tab) => tab.sessionID)]

  // Groups in their saved order, or by latest activity in recent mode; ties and new groups follow in tab order.
  const orderedGroups = createMemo(() => {
    const order = localOrder() ?? state.groupOrder ?? []
    const rank = (key: string) => {
      const index = order.indexOf(key)
      return index === -1 ? order.length : index
    }
    // Rewriting a repository's first commit gives it a new project ID, so projects in one folder share a group
    // under their best-ranked key, which keeps the saved order and collapsed state.
    const links = parents()
    const roots = tabs().filter((tab) => !links.has(tab.sessionID))
    const children = new Map<string, Tab[]>()
    for (const tab of tabs()) {
      const parent = links.get(tab.sessionID)
      if (parent) children.set(parent, [...(children.get(parent) ?? []), tab])
    }
    const keyOf = new Map<string, string>()
    for (const tab of roots) {
      const info = groupOf(tab.sessionID)
      if (!info) continue
      const current = keyOf.get(info.folder)
      const better = current === undefined || (rank(info.key) - rank(current) || (info.key < current ? -1 : 1)) < 0
      if (better) keyOf.set(info.folder, info.key)
    }
    const result = new Map<string, Group>()
    for (const tab of roots) {
      if (grouping() === "custom") {
        const info = customInfo(tab.sessionID)
        const group = result.get(info.key) ?? { ...info, tabs: [] }
        group.tabs.push(tab)
        result.set(info.key, group)
        continue
      }
      const info = groupOf(tab.sessionID)
      const key = info ? keyOf.get(info.folder)! : UNKNOWN_GROUP
      const group = result.get(key) ?? { key, name: info?.name ?? "…", noGit: info?.noGit ?? false, tabs: [] }
      if (info && info.key === key) Object.assign(group, { name: info.name, noGit: info.noGit })
      group.tabs.push(tab)
      result.set(key, group)
    }
    const list = [...result.values()]
    const byActivity = (left: Tab, right: Tab) => activityOf(right.sessionID) - activityOf(left.sessionID)
    const familyActivity = (tab: Tab) =>
      Math.max(activityOf(tab.sessionID), ...(children.get(tab.sessionID) ?? []).map((child) => activityOf(child.sessionID)))
    for (const group of list) {
      if (recent) group.tabs.sort((left, right) => familyActivity(right) - familyActivity(left))
      group.tabs = group.tabs.flatMap((tab) => {
        const family = children.get(tab.sessionID) ?? []
        return [tab, ...(recent ? [...family].sort(byActivity) : family)]
      })
    }
    const last = (group: Group) => (group.key === UNGROUPED_KEY ? 1 : 0)
    return list.sort(
      (left, right) =>
        last(left) - last(right) || (recent && groupActivity(right) - groupActivity(left)) || rank(left.key) - rank(right.key),
    )
  })

  // Live reorder while a group header or a tab is being dragged.
  const [drag, setDrag] = createSignal<{ key: string; startY: number; moved: boolean; target: number }>()
  const [tabDrag, setTabDrag] = createSignal<{
    sessionID: string
    startY: number
    moved: boolean
    targetGroup: string
    target: number
    // An ungrouped tab under the pointer: dropping there makes a new group of the two tabs.
    partner?: string
  }>()
  const groups = createMemo(() => {
    let list = orderedGroups()
    const current = drag()
    if (current?.moved) {
      const from = list.findIndex((group) => group.key === current.key)
      if (from !== -1) list = moveItem(list, from, current.target)
    }
    const dragged = tabDrag()
    if (!dragged?.moved || dragged.partner) return list
    // Only preview moves inside the tab's own group: showing it in another group would unmount
    // its row mid-drag and the pointer would lose the drag. A cross-group target highlights its
    // header instead (see GroupRow) and the tab moves there on release.
    const source = list.find((group) => group.tabs.some((tab) => tab.sessionID === dragged.sessionID))
    if (!source || source.key !== dragged.targetGroup || source.key === UNGROUPED_KEY) return list
    const family = familyOf(dragged.sessionID)
    return list.map((group) => {
      if (group.key !== source.key) return group
      return { ...group, tabs: moveFamily(group.tabs, family, dragged.target) }
    })
  })

  // A parent tab moves together with its sub-sessions; `to` counts the other tabs.
  const moveFamily = <T extends { sessionID: string }>(items: readonly T[], family: readonly string[], to: number) => {
    const rest = items.filter((item) => !family.includes(item.sessionID))
    const block = items.filter((item) => family.includes(item.sessionID))
    rest.splice(Math.max(0, Math.min(to, rest.length)), 0, ...block)
    return rest
  }

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
  // In custom mode the tab can also join another group, which updates its stored group first.
  const moveTab = (sessionID: string, targetGroupKey: string, to: number) => {
    const list = orderedGroups()
    const source = list.find((group) => group.tabs.some((tab) => tab.sessionID === sessionID))
    if (!source) return
    const target = list.find((group) => group.key === targetGroupKey) ?? source
    // Tabs in Ungrouped keep the host order; dropping one on another makes a group instead.
    if (source.key === UNGROUPED_KEY && target.key === UNGROUPED_KEY) return
    if (grouping() === "custom" && target.key !== source.key) assignGroup([sessionID], target.name, true)
    const family = familyOf(sessionID)
    const ids = target.tabs.map((tab) => tab.sessionID).filter((id) => !family.includes(id))
    const at = Math.max(0, Math.min(to, ids.length))
    const next = [...ids.slice(0, at), sessionID, ...ids.slice(at)]
    const position = next.indexOf(sessionID)
    const host = ctx.ui.tabs.list().map((tab) => tab.sessionID).filter((id) => id !== sessionID)
    const index = position > 0 ? host.indexOf(next[position - 1]!) + 1 : host.indexOf(next[1] ?? "")
    if (index >= 0) moveHostTab(sessionID, index)
  }

  // The host shows a move only later, and moves sent before that read stale positions and undo each other.
  // So one tab moves at a time, and the next waits until the host shows the order we asked for.
  let awaited: { order: string; until: number } | undefined
  const [hostWait, setHostWait] = createSignal(0)
  const hostOrder = () => ctx.ui.tabs.list().map((tab) => tab.sessionID)
  const moveHostTab = (sessionID: string, index: number) => {
    const order = hostOrder().filter((id) => id !== sessionID)
    order.splice(index, 0, sessionID)
    awaited = { order: order.join(), until: Date.now() + HOST_MOVE_WAIT }
    setAwaitedOrder(order)
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      setHostWait((value) => value + 1)
    }, HOST_MOVE_WAIT)
    retryTimers.add(timer)
    ctx.ui.tabs.move(sessionID, index)
  }
  const hostSettled = () => {
    if (awaited && hostOrder().join() !== awaited.order && Date.now() < awaited.until) return false
    awaited = undefined
    setAwaitedOrder(undefined)
    return true
  }
  createEffect(() => {
    hostWait()
    ctx.ui.tabs.list()
    untrack(hostSettled)
  })

  // Order the host's tabs like our groups, so both bars agree. Returns true once they do.
  const applyGrouping = () => {
    if (!ctx.ui.tabs.enabled() || !hostSettled()) return false
    const list = orderedGroups()
    if (list.some((group) => group.key === UNKNOWN_GROUP)) return false
    const target = list.flatMap((group) => group.tabs.map((tab) => tab.sessionID))
    const current = hostOrder()
    const index = target.findIndex((id, at) => current[at] !== id)
    if (index === -1) return true
    moveHostTab(target[index]!, index)
    return false
  }
  // "Group tabs now" keeps going until the order matches, like automatic grouping.
  const [groupNow, setGroupNow] = createSignal(false)
  createEffect(() => {
    if (!state.autoGroup && !groupNow()) return
    hostWait()
    orderedGroups()
    if (untrack(applyGrouping)) setGroupNow(false)
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
    countHidden()
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
  // A collapsed group opens while selected, then keeps showing only its active tab (and that tab's parent).
  const visibleTabIDs = (group: Group) => {
    const active = group.tabs.find((tab) => tab.active)?.sessionID
    const parent = active && parents().get(active)
    return group.tabs
      .filter((tab) => !state.collapsed[group.key] || tab.active || tab.sessionID === parent || pending() === group.key)
      .map((tab) => tab.sessionID)
  }

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
  const subTitleColor = createMemo(() => mix(theme().text.base, theme().text.muted, SUB_TITLE_DIM))
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
  // In custom mode a tab can also join another group by dropping it on that group's rows or header.
  const tabRows = new Map<string, BoxRenderable>()
  const tabDropTarget = (sessionID: string, y: number) => {
    const own = tabRows.get(sessionID)
    const list = orderedGroups()
    const source = list.find((item) => item.tabs.some((tab) => tab.sessionID === sessionID))
    if (!own || own.isDestroyed || !source) return { groupKey: source?.key ?? "", index: 0 }
    const custom = grouping() === "custom"
    const family = familyOf(sessionID)
    // The group whose header or rows hold the pointer wins; above all groups means the first,
    // below all groups means the last.
    let target = list[0] ?? source
    for (const group of list) {
      const header = headers.get(group.key)
      const top = header && !header.isDestroyed ? header.screenY : undefined
      const rows = group.tabs
        .map((tab) => tabRows.get(tab.sessionID))
        .filter((row): row is BoxRenderable => !!row && !row.isDestroyed)
      const bottom = rows.length ? rows[rows.length - 1]!.screenY + rows[rows.length - 1]!.height - 1 : top
      if (top === undefined) continue
      if (y < top) break
      target = group
      if (bottom !== undefined && y <= bottom) break
    }
    if (!custom) target = source
    else if (target.key === UNGROUPED_KEY) {
      const partner = target.tabs.find((tab) => {
        const row = tabRows.get(tab.sessionID)
        return !family.includes(tab.sessionID) && !parents().has(tab.sessionID) && !!row && !row.isDestroyed && y >= row.screenY && y < row.screenY + row.height
      })
      if (partner) return { groupKey: target.key, index: 0, partner: partner.sessionID }
    }
    // The dragged tab takes the place of the row under the pointer: rows above the pointer stay
    // above it. Coming from above counts the row under the pointer too, so the tab lands after it.
    const fromAbove = own.screenY < y
    const rest = target.tabs.filter((tab) => !family.includes(tab.sessionID))
    let index = rest.filter((tab) => {
      const row = tabRows.get(tab.sessionID)
      if (!row || row.isDestroyed) return false
      return fromAbove ? row.screenY <= y : row.screenY + row.height - 1 < y
    }).length
    // Never land between a parent and its sub-sessions.
    while (index < rest.length && parents().has(rest[index]!.sessionID)) index++
    return { groupKey: target.key, index, partner: undefined as string | undefined }
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
    if (moved) {
      const target = tabDropTarget(dragged.sessionID, event.y)
      setTabDrag({ ...dragged, moved, targetGroup: target.groupKey, target: target.index, partner: target.partner })
    }
  }

  const finishDrag = () => {
    const current = drag()
    const dragged = tabDrag()
    setDrag(undefined)
    setTabDrag(undefined)
    if (current?.moved) moveGroup(current.key, current.target)
    else if (dragged?.moved && dragged.partner) assignGroup([dragged.partner, dragged.sessionID], nextGroupName())
    else if (dragged?.moved) moveTab(dragged.sessionID, dragged.targetGroup, dragged.target)
    else return false
    dropped = true
    setTimeout(() => (dropped = false))
    return true
  }

  function GroupRow(props: { group: Group; position: number; collapsed: boolean }) {
    const id = () => `group:${props.group.key}`
    const selected = () => pending() === props.group.key
    const dragging = () => drag()?.key === props.group.key && drag()?.moved
    // A tab dragged from another custom group lands here on release; highlight the header instead of
    // moving the row, so the drag keeps its target while it is in flight.
    const dropHint = () => {
      const current = tabDrag()
      if (!current?.moved || grouping() !== "custom" || current.targetGroup !== props.group.key) return false
      return orderedGroups().find((group) => group.tabs.some((tab) => tab.sessionID === current.sessionID))?.key !== props.group.key
    }
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
          dragging() || dropHint()
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
          // Ungrouped always stays last, so it is not dragged.
          if (props.group.key !== UNGROUPED_KEY)
            setDrag({ key: props.group.key, startY: event.y, moved: false, target: props.position })
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            // A finished drag reorders; a click pressed and released on this header toggles the group.
            const over = !!header && event.y >= header.screenY && event.y < header.screenY + header.height
            if (finishDrag()) return
            if (event.button === 2) void openGroupMenu(props.group).catch(fail)
            else if (event.button === 0 && pressedGroup === props.group.key && over) toggleGroup(props.group.key)
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
    const partner = () => !!tabDrag()?.moved && tabDrag()?.partner === props.tab.sessionID
    // A collapsed group hides rows, so the drop position could not be read from the screen.
    const draggable = () => {
      const group = groupByKey(props.groupKey)
      return !recent && !sub() && !!group && visibleTabIDs(group).length === group.tabs.length
    }
    // Sub-sessions sit indented under their parent; the parent shows how many it has.
    const sub = () => parents().has(props.tab.sessionID)
    const indent = () => (sub() ? 2 : 0)
    const countLabel = () => {
      const count = sub() ? 0 : childrenOf(props.tab.sessionID).length
      return count ? ` +${count}` : ""
    }
    let row: BoxRenderable | undefined
    onCleanup(() => {
      if (tabRows.get(props.tab.sessionID) === row) tabRows.delete(props.tab.sessionID)
    })
    // Tabs show the second key of the chord only while their group is selected.
    const keys = () => (armed() ? slotLabel(props.position) : "")
    // Layout: marker, status, space, title, space, keys, space, close button (2 columns, always reserved).
    const showKeys = () => keys().length > 0 && innerWidth() - 5 - indent() - keys().length - 2 >= 6
    const showCount = () => !!countLabel() && innerWidth() - 5 - (showKeys() ? keys().length + 2 : 0) - countLabel().length >= 6
    const titleWidth = () =>
      innerWidth() - 5 - indent() - (showKeys() ? keys().length + 2 : 0) - (showCount() ? countLabel().length : 0)
    const [closeHovered, setCloseHovered] = createSignal(false)
    return (
      <box
        ref={(element: BoxRenderable) => tabRows.set(props.tab.sessionID, (row = element))}
        flexDirection="row"
        height={rowHeight}
        flexShrink={0}
        paddingTop={padding}
        backgroundColor={
          partner()
            ? theme().background.action.primary.selected
            : dragged()
              ? theme().background.raised.high
              : rowBackground(id(), props.tab.active)
        }
        onMouseOver={() => setHovered(id())}
        onMouseOut={() => setHovered(undefined)}
        onMouseDown={(event: MouseEvent) => {
          pressedGroup = undefined
          if (event.button !== 0 || !draggable()) return
          event.stopPropagation()
          setTabDrag({ sessionID: props.tab.sessionID, startY: event.y, moved: false, targetGroup: props.groupKey, target: props.position })
        }}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            if (finishDrag()) return
            if (event.button === 1) void requestClose(props.tab.sessionID).catch(fail)
            else if (event.button === 2) void openTabMenu(props.tab).catch(fail)
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
          <Show when={sub()}>
            <text selectable={false} fg={theme().text.muted}>{"└ "}</text>
          </Show>
          <text selectable={false} fg={sub() ? subTitleColor() : titleColor()}>
            {truncate(titleOf(props.tab), titleWidth())}
          </text>
          <Show when={showCount()}>
            <text selectable={false} fg={theme().text.muted}>{countLabel()}</text>
          </Show>
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

  // Tab rows below the visible part of the bar; while any exist, the bar's last line counts them.
  let scroller: ScrollBoxRenderable | undefined
  const [hiddenBelow, setHiddenBelow] = createSignal(0)
  const countHidden = () => {
    if (!scroller || scroller.isDestroyed) return
    const bottom = scroller.screenY + geometry().height
    const ends = [...tabRows.values()].filter((row) => !row.isDestroyed).map((row) => row.screenY + row.height)
    // Checked against the whole bar first, so the line cannot hide the only row that made it appear.
    const count = ends.some((end) => end > bottom) ? ends.filter((end) => end > bottom - 1).length : 0
    if (count !== hiddenBelow()) setHiddenBelow(count)
  }

  function MoreRow() {
    const label = () => {
      const count = hiddenBelow()
      if (narrow()) return `+${count}`
      return truncate(`and ${count} more ${count === 1 ? "session" : "sessions"}`, innerWidth())
    }
    return (
      <box
        flexDirection="row"
        justifyContent="center"
        height={1}
        flexShrink={0}
        backgroundColor={rowBackground("more", false)}
        onMouseOver={() => setHovered("more")}
        onMouseOut={() => setHovered(undefined)}
        onMouseUp={(event: MouseEvent) =>
          click(event, () => {
            scroller?.scrollBy(1, "viewport")
            scroller?.afterLayout(countHidden)
          })
        }
      >
        <text selectable={false} fg={theme().text.muted}>{label()}</text>
      </box>
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
        <text selectable={false} fg={theme().text.muted}>{narrow() ? " +" : " + Start a new session"}</text>
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

  // Custom groups ------------------------------------------------------------------------------

  const activeTab = () => tabs().find((tab) => tab.active)

  // Named custom groups that hold an open tab, in bar order once custom groups are on.
  const customNames = () => {
    if (grouping() === "custom")
      return orderedGroups().filter((group) => group.key !== UNGROUPED_KEY).map((group) => group.name)
    return [...new Set(tabs().flatMap((tab) => customMap()[tab.sessionID] ?? []))]
  }

  const nextGroupName = () => {
    const taken = new Set(customNames().map((name) => name.toLowerCase()))
    let n = 1
    while (taken.has(`group ${n}`)) n++
    return `Group ${n}`
  }

  // Tabs without a custom group join the group named after their repository.
  const seedFromRepositories = (draft: State) => {
    draft.customGroups ??= {}
    for (const tab of tabs()) {
      if (draft.customGroups[tab.sessionID] !== undefined) continue
      const name = groupOf(tab.sessionID)?.name
      if (name) draft.customGroups[tab.sessionID] = name
    }
  }

  // Groups without a saved place follow the tab order, which the other mode changes, so the place is saved first.
  const switchGrouping = (draft: State, next: State["grouping"]) => {
    if ((draft.grouping ?? "repo") === next) return
    const shown = orderedGroups().map((group) => group.key)
    draft.groupOrder = [...shown, ...(draft.groupOrder ?? []).filter((key) => !shown.includes(key))]
    draft.grouping = next
  }

  const setGrouping = (next: State["grouping"], seed = false) =>
    update((draft) => {
      switchGrouping(draft, next)
      if (seed) seedFromRepositories(draft)
    })
      .then(() =>
        toast(
          next === "custom"
            ? "Custom groups on: drag a tab onto an ungrouped tab, or use /group <name>"
            : "Tabs are grouped by repository again; your custom groups are kept",
        ),
      )
      .catch(fail)

  // Moving tabs turns custom groups on, so the move is visible at once.
  const assignGroup = (sessionIDs: string[], input: string | undefined, quiet = false) => {
    const name = cleanGroupName(input)
    const switched = grouping() !== "custom"
    setLocalGroups((local) => ({ ...local, ...Object.fromEntries(sessionIDs.map((id) => [id, name === UNGROUPED ? null : name])) }))
    const write = ++groupWrites
    void update((draft) => {
      switchGrouping(draft, "custom")
      draft.customGroups ??= {}
      for (const id of sessionIDs) {
        if (name === UNGROUPED) delete draft.customGroups[id]
        else draft.customGroups[id] = name
      }
      // The tab is hidden while its new group stays collapsed, so open it.
      delete draft.collapsed[customKey(name)]
    })
      .then(() => {
        if (switched || !quiet) toast(switched ? `Custom groups on; moved to ${name}` : `Moved to ${name}`)
      })
      .catch(fail)
      .finally(() => {
        if (write === groupWrites) setLocalGroups({})
      })
  }

  const renameGroup = (from: string, input: string) => {
    const to = cleanGroupName(input)
    if (to === from) return
    void update((draft) => {
      draft.customGroups ??= {}
      for (const [id, name] of Object.entries(draft.customGroups)) {
        if (name !== from) continue
        if (to === UNGROUPED) delete draft.customGroups[id]
        else draft.customGroups[id] = to
      }
      // Removing a group must not hide its tabs by collapsing Ungrouped.
      if (to !== UNGROUPED && draft.collapsed[customKey(from)]) draft.collapsed[customKey(to)] = true
      delete draft.collapsed[customKey(from)]
      // Renaming onto an existing group merges into it, so that group keeps its place.
      const order = draft.groupOrder ?? []
      draft.groupOrder = order.includes(customKey(to))
        ? order.filter((key) => key !== customKey(from))
        : order.map((key) => (key === customKey(from) ? customKey(to) : key))
    })
      .then(() => toast(to === UNGROUPED ? `Removed ${from}` : `Renamed ${from} to ${to}`))
      .catch(fail)
  }

  const askName = async (title: string, value: string) => {
    const answer = await ctx.ui.dialog.prompt({ title, placeholder: "Group name", value })
    const name = answer?.trim()
    if (answer !== undefined && !name) toast("The group name is empty, so nothing changed", "warning")
    return name || undefined
  }

  const NEW_GROUP = "\u0000new"
  const ATTACH = "\u0000attach"
  const DETACH = "\u0000detach"

  // Sub-sessions --------------------------------------------------------------------------------

  const setParent = (sessionID: string, parent: string | null) =>
    void update((draft) => {
      draft.parents ??= {}
      draft.parents[sessionID] = parent
    })
      .then(() => toast(parent ? `Attached to ${titleOf({ sessionID: parent })}` : "Detached; it is a normal tab again"))
      .catch(fail)

  // Any top-level tab outside the tab's own family can be its parent.
  const pickParent = async (tab: Tab) => {
    const family = familyOf(tab.sessionID)
    const options = groups().flatMap((group) =>
      group.tabs
        .filter((item) => !family.includes(item.sessionID) && !parents().has(item.sessionID))
        .map((item) => ({ title: titleOf(item), value: item.sessionID, category: group.name })),
    )
    if (!options.length) return toast("Open another tab first, then attach this one to it", "warning")
    const selected = await ctx.ui.dialog.select({ title: `Attach “${titleOf(tab)}” to`, placeholder: "Search tabs", options })
    if (selected) setParent(tab.sessionID, selected)
  }

  const attachCurrent = async () => {
    const current = activeTab()
    if (!current) return toast("Open a tab first", "warning")
    return pickParent(current)
  }

  const detachCurrent = () => {
    const current = activeTab()
    if (!current) return toast("Open a tab first", "warning")
    if (!parents().has(current.sessionID)) return toast("This tab is not a sub-session", "warning")
    setParent(current.sessionID, null)
  }

  // Right-click on a tab, or /group without a name. A sub-session follows its parent, so it has no group of its own.
  const openTabMenu = async (tab: Tab) => {
    const current = customMap()[tab.sessionID]
    const parent = parents().get(tab.sessionID)
    const options = parent
      ? [{ title: `Detach from ${titleOf({ sessionID: parent })}`, value: DETACH, category: "Sub-session" }]
      : [
          ...customNames().map((name) => ({ title: name, value: name, category: "Move to group" })),
          { title: "New group…", value: NEW_GROUP, category: "Move to group" },
          ...(current ? [{ title: "Remove from group", value: UNGROUPED, category: "Move to group" }] : []),
          ...(subSessions ? [{ title: "Attach to a tab…", value: ATTACH, category: "Sub-session" }] : []),
        ]
    const selected = await ctx.ui.dialog.select({
      title: titleOf(tab),
      options,
      current: grouping() === "custom" && !parent ? current : undefined,
    })
    if (selected === undefined) return
    if (selected === DETACH) return setParent(tab.sessionID, null)
    if (selected === ATTACH) return pickParent(tab)
    const name = selected === NEW_GROUP ? await askName("New group", nextGroupName()) : selected
    if (name) assignGroup([tab.sessionID], name)
  }

  // Right-click on a group header; repository groups and Ungrouped open the group list instead.
  const openGroupMenu = async (group: Group): Promise<void> => {
    if (grouping() !== "custom" || group.key === UNGROUPED_KEY) return openGroups()
    const selected = await ctx.ui.dialog.select({
      title: group.name,
      options: [
        { title: "Rename…", value: "rename" },
        { title: "Remove group", value: "remove", description: "Its tabs go to Ungrouped" },
      ],
    })
    if (selected === "remove") renameGroup(group.name, UNGROUPED)
    if (selected !== "rename") return
    const name = await askName(`Rename ${group.name}`, group.name)
    if (name) renameGroup(group.name, name)
  }

  // /groups: every custom group and the grouping mode in one list.
  const openGroups = async (): Promise<void> => {
    const custom = grouping() === "custom"
    const count = (name: string) => tabs().filter((tab) => customMap()[tab.sessionID] === name).length
    const options = [
      ...customNames().map((name) => ({
        title: name,
        value: `group:${name}`,
        category: "Custom groups",
        footer: `${count(name)} ${count(name) === 1 ? "tab" : "tabs"}`,
      })),
      { title: "Group by repository", value: "mode:repo", category: "Grouping", footer: custom ? undefined : "on" },
      { title: "Custom groups", value: "mode:custom", category: "Grouping", footer: custom ? "on" : undefined },
      ...(custom ? [] : [{ title: "Custom groups, starting from repositories", value: "mode:seed", category: "Grouping" }]),
    ]
    const selected = await ctx.ui.dialog.select({ title: "Tab groups", placeholder: "Search groups", options })
    if (selected === "mode:repo" && custom) return setGrouping("repo")
    if (selected === "mode:custom" && !custom) return setGrouping("custom")
    if (selected === "mode:seed") return setGrouping("custom", true)
    if (!selected?.startsWith("group:")) return
    const name = selected.slice("group:".length)
    if (!custom) await update((draft) => switchGrouping(draft, "custom"))
    return openGroupMenu({ key: customKey(name), name, noGit: false, tabs: [] })
  }

  const groupCurrent = async (input?: string) => {
    const current = activeTab()
    if (!current) return toast("Open a tab first, then move it to a group", "warning")
    if (input?.trim() && parents().has(current.sessionID))
      return toast("A sub-session stays with its parent; use /detach first", "warning")
    if (input?.trim()) return assignGroup([current.sessionID], input)
    return openTabMenu(current)
  }

  const ungroupCurrent = () => {
    const current = activeTab()
    if (!current) return toast("Open a tab first", "warning")
    if (parents().has(current.sessionID)) return toast("A sub-session stays with its parent; use /detach first", "warning")
    if (!customMap()[current.sessionID]) return toast("This tab is not in a custom group", "warning")
    assignGroup([current.sessionID], UNGROUPED)
  }

  const setAllCollapsed = (collapsed: boolean) =>
    void update((draft) => {
      draft.collapsed = {}
      if (collapsed) for (const group of groups()) draft.collapsed[group.key] = true
    }).catch(fail)

  const openPicker = async () => {
    const options = groups().flatMap((group, position) =>
      group.tabs.map((tab, index) => ({
        title: (parents().has(tab.sessionID) ? "└ " : "") + titleOf(tab),
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

  const subSessionCommands = [
    {
      id: "better-tabs.attach",
      title: "Attach current tab to another tab",
      group: "Better tabs",
      palette: true,
      slash: { name: "attach" },
      run: () => void attachCurrent().catch(fail),
    },
    {
      id: "better-tabs.detach",
      title: "Detach current tab from its parent",
      group: "Better tabs",
      palette: true,
      slash: { name: "detach" },
      run: detachCurrent,
    },
  ] as const

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
        title: "Group tabs now",
        group: "Better tabs",
        palette: true,
        run: () => void setGroupNow(true),
      },
      {
        id: "better-tabs.grouping",
        title: grouping() === "custom" ? "Group tabs by repository" : "Use custom tab groups",
        group: "Better tabs",
        palette: true,
        run: () => void setGrouping(grouping() === "custom" ? "repo" : "custom"),
      },
      {
        id: "better-tabs.groups",
        title: "Tab groups",
        group: "Better tabs",
        palette: true,
        slash: { name: "groups" },
        run: () => void openGroups().catch(fail),
      },
      {
        id: "better-tabs.set-group",
        title: "Move current tab to a group",
        group: "Better tabs",
        palette: true,
        slash: { name: "group", arguments: true },
        run: (input?: string) => void groupCurrent(input).catch(fail),
      },
      {
        id: "better-tabs.ungroup",
        title: "Remove current tab from its group",
        group: "Better tabs",
        palette: true,
        slash: { name: "ungroup" },
        run: ungroupCurrent,
      },
      ...(subSessions ? subSessionCommands : []),
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
              <scrollbox
                ref={(element: ScrollBoxRenderable) => (scroller = element)}
                flexGrow={1}
                minHeight={0}
                scrollbarOptions={{ visible: false }}
              >
                <box flexDirection="column" flexShrink={0} paddingTop={1}>
                  <For each={groupKeys()}>
                    {(key, position) => <GroupBlock groupKey={key} position={position()} />}
                  </For>
                  <box height={1} flexShrink={0} />
                  <NewSessionRow />
                </box>
              </scrollbox>
              <Show when={hiddenBelow() > 0}>
                <MoreRow />
              </Show>
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
