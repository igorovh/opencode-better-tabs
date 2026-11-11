// Records the real OpenCode TUI with this plugin to a GIF: bun run record -- --out demo.gif --step "hover Dark mode"
// Needs opencode (OPENCODE_BIN), ttyd (TTYD_BIN) and ffmpeg. Sessions are created through the API, so no model runs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Page } from "playwright"

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "demo.gif" },
    step: { type: "string", multiple: true, default: [] },
    steps: { type: "string" },
    options: { type: "string", default: "{}" },
    plugin: { type: "string", default: path.join(import.meta.dir, "..") },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "720" },
    sidebar: { type: "boolean", default: false },
  },
})

const STEPS_HELP = `Steps, one per --step or per line of --steps <file>:
  wait <ms>                 pause
  hover <text>              move the pointer onto the row showing <text>
  click <text>              left-click that row
  middle <text>             middle-click that row
  close <text>              hover that row, then click its close cross
  drag <text> -> <text>     drag one row onto another, such as a group header
  key <keys>                press keys, such as alt+2 or ctrl+p
  type <text>               type text, such as /close (add "key Enter" to run it)`

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode"
const ttydBin = process.env.TTYD_BIN ?? "ttyd"
const steps = [...values.step!, ...(values.steps ? readFileSync(values.steps, "utf8").split(/\r?\n/) : [])]
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
if (!steps.length) console.log(`No steps given, so the GIF shows the bar at rest.\n${STEPS_HELP}`)

const sessions = [
  { project: "api", title: "Fix the login redirect" },
  { project: "api", title: "Add rate limiting to uploads" },
  { project: "web", title: "Dark mode for settings" },
  { project: "web", title: "Flaky checkout test" },
  { project: "docs", title: "Write the plugin guide" },
]

const work = mkdtempSync(path.join(os.tmpdir(), "better-tabs-record-"))
const port = () => 40000 + Math.floor(Math.random() * 20000)
const serverPort = port()
const ttydPort = serverPort + 1
const password = "record"
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(work, "config"),
  XDG_DATA_HOME: path.join(work, "data"),
  XDG_STATE_HOME: path.join(work, "state"),
  XDG_CACHE_HOME: path.join(work, "cache"),
  OPENCODE_SERVER_PASSWORD: password,
}
const children: ChildProcess[] = []
const stopAll = () => {
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)])
    else child.kill("SIGTERM")
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T | undefined>, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

try {
  // Each project needs its own root commit: OpenCode groups sessions by it.
  for (const project of new Set(sessions.map((session) => session.project))) {
    const dir = path.join(work, "repos", project)
    mkdirSync(dir, { recursive: true })
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args])
    git("init", "-q")
    git("commit", "-q", "--allow-empty", "-m", `init ${project}`)
  }
  mkdirSync(path.join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  writeFileSync(
    path.join(env.XDG_CONFIG_HOME, "opencode", "cli.json"),
    JSON.stringify({
      tabs: { scope: "global", layout: "vertical", mode: "auto" },
      plugins: [{ package: path.resolve(values.plugin!).replaceAll("\\", "/"), options: JSON.parse(values.options!) }],
    }),
  )

  const server = spawn(opencodeBin, ["serve", "--port", String(serverPort)], { env, stdio: "ignore" })
  children.push(server)
  const api = `http://127.0.0.1:${serverPort}`
  const auth = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
  await until("the OpenCode server", async () => (await fetch(`${api}/api/info`, { headers: auth })).ok || undefined)

  const ids: string[] = []
  for (const session of sessions) {
    const response = await fetch(`${api}/api/session`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: session.title, location: { directory: path.join(work, "repos", session.project) } }),
    })
    if (!response.ok) throw new Error(`Creating a session failed: ${response.status} ${await response.text()}`)
    ids.push(((await response.json()) as { data: { id: string } }).data.id)
  }
  // The host restores open tabs from this file; "latest" is the release channel's state directory.
  for (const channel of ["latest", "beta", "dev"]) {
    const dir = path.join(env.XDG_STATE_HOME, "opencode", channel, "tui")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "tabs.json"),
      JSON.stringify({ global: { tabs: ids.map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }),
    )
  }

  const ttyd = spawn(
    ttydBin,
    ["-p", String(ttydPort), "-W", "-t", "fontSize=15", "-t", "disableLeaveAlert=true", opencodeBin, "--server", api],
    { env, cwd: path.join(work, "repos", sessions[0]!.project), stdio: "ignore" },
  )
  children.push(ttyd)
  await until("ttyd", async () => (await fetch(`http://127.0.0.1:${ttydPort}`)).ok || undefined)

  const width = Number(values.width)
  const height = Number(values.height)
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: path.join(work, "video"), size: { width, height } },
  })
  const page = await context.newPage()
  const started = Date.now()
  await page.goto(`http://127.0.0.1:${ttydPort}`)
  await until("the tab bar", async () => (await screenLines(page)).some((line) => line.includes("New session")) || undefined)
  await sleep(1500)
  const ready = (Date.now() - started) / 1000

  for (const step of steps) {
    await runStep(page, step)
    await sleep(700)
  }
  await sleep(1500)
  const crop = values.sidebar ? await sidebarCrop(page) : ""
  const video = page.video()!
  await context.close()
  await browser.close()

  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      ready.toFixed(2),
      "-i",
      await video.path(),
      "-vf",
      `${crop}fps=12,scale='min(960,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
      values.out!,
    ],
    { stdio: "inherit" },
  )
  if (ffmpeg.status !== 0) throw new Error("ffmpeg failed")
  console.log(`Wrote ${values.out}`)
} finally {
  stopAll()
  rmSync(work, { recursive: true, force: true, maxRetries: 5 })
}

// ttyd exposes its xterm.js instance as window.term.
async function screenLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (window as any).term
    if (!term) return []
    const buffer = term.buffer.active
    return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString() ?? "")
  })
}

async function cellOf(page: Page, text: string, which: "start" | "middle" | "close" = "middle") {
  const lines = await screenLines(page)
  const row = lines.findIndex((line) => line.includes(text))
  if (row === -1) throw new Error(`No row shows "${text}"`)
  const line = lines[row]!
  let col = line.indexOf(text) + (which === "middle" ? Math.floor(text.length / 2) : 0)
  if (which === "close") {
    col = line.indexOf("✕")
    if (col === -1) throw new Error(`The row "${text}" shows no close cross`)
  }
  const box = await page.evaluate(() => {
    const term = (window as any).term
    const rect = document.querySelector(".xterm-screen")!.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width / term.cols, height: rect.height / term.rows }
  })
  return { x: box.x + (col + 0.5) * box.width, y: box.y + (row + 0.5) * box.height }
}

async function runStep(page: Page, step: string) {
  const [verb, ...rest] = step.split(" ")
  const arg = rest.join(" ")
  console.log(`> ${step}`)
  switch (verb) {
    case "wait":
      return sleep(Number(arg))
    case "hover": {
      const at = await cellOf(page, arg)
      return page.mouse.move(at.x, at.y, { steps: 12 })
    }
    case "click":
    case "middle": {
      const at = await cellOf(page, arg)
      await page.mouse.move(at.x, at.y, { steps: 12 })
      await sleep(300)
      return page.mouse.click(at.x, at.y, { button: verb === "middle" ? "middle" : "left" })
    }
    case "close": {
      const row = await cellOf(page, arg)
      await page.mouse.move(row.x, row.y, { steps: 12 })
      await sleep(400)
      const cross = await cellOf(page, arg, "close")
      await page.mouse.move(cross.x, cross.y, { steps: 8 })
      await sleep(400)
      return page.mouse.click(cross.x, cross.y)
    }
    case "drag": {
      const [from, to] = arg.split("->").map((part) => part.trim())
      const start = await cellOf(page, from!, "start")
      const end = await cellOf(page, to!, "start")
      await page.mouse.move(start.x, start.y, { steps: 8 })
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 20 })
      await sleep(300)
      return page.mouse.up()
    }
    case "key":
      return page.keyboard.press(arg.split("+").map((key) => (key.length === 1 ? key : key[0]!.toUpperCase() + key.slice(1))).join("+"))
    case "type":
      return page.keyboard.type(arg, { delay: 60 })
    default:
      throw new Error(`Unknown step "${step}"\n${STEPS_HELP}`)
  }
}

// Crops the video to the tab bar, which ends a little after the group shortcuts on the right.
async function sidebarCrop(page: Page) {
  const lines = await screenLines(page)
  const end = Math.max(...lines.map((line) => line.search(/alt\+\d/)).map((at) => (at === -1 ? -1 : at + 5)))
  if (end <= 0) return ""
  const width = await page.evaluate((cols) => {
    const term = (window as any).term
    const rect = document.querySelector(".xterm-screen")!.getBoundingClientRect()
    return Math.round(rect.left + ((cols + 3) * rect.width) / term.cols)
  }, end)
  return `crop=${width - (width % 2)}:ih:0:0,`
}
