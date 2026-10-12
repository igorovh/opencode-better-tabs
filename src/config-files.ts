import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type TabsMode = "auto" | "on" | "off"

const home = () => os.homedir()

export function cliConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(home(), ".config")
  return path.join(base, "opencode", "cli.json")
}

// Mirrors the host TUI storage root (`<state>/<channel>/tui`), which it watches for external edits.
export function hostLayoutPath(channel: string) {
  const base = process.env.XDG_STATE_HOME || path.join(home(), ".local", "state")
  return path.join(base, "opencode", channel, "tui", "layout.json")
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, "utf8"))
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} is not a JSON object`)
  return value
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n")
  renameSync(temp, file)
}

export function readTabsMode(): TabsMode {
  const tabs = readJson(cliConfigPath()).tabs ?? {}
  if (tabs.mode === "auto" || tabs.mode === "on" || tabs.mode === "off") return tabs.mode
  if (tabs.enabled === false) return "off"
  if (tabs.enabled === true) return "on"
  return "auto"
}

export function writeTabsMode(mode: TabsMode) {
  const file = cliConfigPath()
  const config = readJson(file)
  const tabs = { ...(config.tabs ?? {}), mode }
  // The legacy boolean would contradict the new mode.
  delete tabs.enabled
  writeJsonAtomic(file, { ...config, tabs })
}

export function readVerticalTabsWidth(channel: string): number | undefined {
  const width = readJson(hostLayoutPath(channel)).verticalTabsWidth
  return typeof width === "number" ? width : undefined
}

export function writeVerticalTabsWidth(channel: string, width: number) {
  const file = hostLayoutPath(channel)
  writeJsonAtomic(file, { ...readJson(file), verticalTabsWidth: width })
}
