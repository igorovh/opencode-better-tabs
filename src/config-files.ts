import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export type TabsMode = "auto" | "on" | "off"

const home = () => os.homedir()

// Mirrors the host's Global paths (packages/util/src/global.ts and global-roots.ts).
export function cliConfigPath() {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "opencode")
  return path.join(base, "cli.json")
}

function parseObject(text: string, source: string): Record<string, any> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${source} is not a valid JSON object`)
  return value
}

function readText(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined
}

function writeAtomic(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    renameWithRetry(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

// Windows refuses the rename for a moment while another process (the host's watcher) holds the file.
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
      Bun.sleepSync(20 * (attempt + 1))
    }
  }
}

// Edits one value in place, so comments and formatting in the file survive.
function writeValue(file: string, keyPath: string[], value: unknown) {
  const text = readText(file) ?? "{}\n"
  parseObject(text, file)
  const edited = applyEdits(text, modify(text, keyPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
  writeAtomic(file, edited.endsWith("\n") ? edited : edited + "\n")
}

function readObject(file: string) {
  const text = readText(file)
  return text === undefined ? {} : parseObject(text, file)
}

// The host lets OPENCODE_CLI_CONFIG_CONTENT override cli.json, so a `tabs` key there wins.
export function tabsOverridden() {
  const content = process.env.OPENCODE_CLI_CONFIG_CONTENT
  if (!content) return false
  try {
    return parseObject(content, "OPENCODE_CLI_CONFIG_CONTENT").tabs !== undefined
  } catch {
    return false
  }
}

export function readTabsMode(): TabsMode {
  const tabs = readObject(cliConfigPath()).tabs ?? {}
  if (tabs.mode === "auto" || tabs.mode === "on" || tabs.mode === "off") return tabs.mode
  if (tabs.enabled === false) return "off"
  if (tabs.enabled === true) return "on"
  return "auto"
}

export function writeTabsMode(mode: TabsMode) {
  const file = cliConfigPath()
  writeValue(file, ["tabs", "mode"], mode)
  // The legacy boolean would contradict the new mode.
  if (readObject(file).tabs?.enabled !== undefined) writeValue(file, ["tabs", "enabled"], undefined)
}
