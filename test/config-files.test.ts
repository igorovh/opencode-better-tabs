import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  cliConfigPath,
  readTabsMode,
  tabsOverridden,
  writeTabsMode,
} from "../src/config-files"

const KEYS = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_CLI_CONFIG_CONTENT"] as const
let saved: Record<string, string | undefined>
let dir: string

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
  dir = mkdtempSync(path.join(os.tmpdir(), "better-tabs-config-"))
  process.env.XDG_CONFIG_HOME = path.join(dir, "config")
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

test("cli.json follows OPENCODE_CONFIG_DIR before XDG_CONFIG_HOME, like the host", () => {
  expect(cliConfigPath()).toBe(path.join(dir, "config", "opencode", "cli.json"))
  process.env.OPENCODE_CONFIG_DIR = path.join(dir, "custom")
  expect(cliConfigPath()).toBe(path.join(dir, "custom", "cli.json"))
})

test("hiding tabs keeps comments and other settings in cli.json", () => {
  const file = cliConfigPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{\n  // keep me\n  "animations": false,\n  "tabs": { "enabled": true, },\n}\n')

  expect(readTabsMode()).toBe("on")
  writeTabsMode("off")

  const text = readFileSync(file, "utf8")
  expect(text).toContain("// keep me")
  expect(text).toContain('"animations": false')
  expect(text).not.toContain('"enabled"')
  expect(readTabsMode()).toBe("off")
  expect(readdirSync(path.dirname(file))).toEqual(["cli.json"])
})

test("a broken cli.json is reported and left untouched", () => {
  const file = cliConfigPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ "tabs": ')
  expect(() => writeTabsMode("off")).toThrow("not a valid JSON object")
  expect(readFileSync(file, "utf8")).toBe('{ "tabs": ')
})

test("only a tabs key in OPENCODE_CLI_CONFIG_CONTENT overrides cli.json", () => {
  expect(tabsOverridden()).toBe(false)
  process.env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ theme: "tabs" })
  expect(tabsOverridden()).toBe(false)
  process.env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ tabs: { mode: "on" } })
  expect(tabsOverridden()).toBe(true)
})
