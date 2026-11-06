// OpenCode skips the Solid JSX transform for files under node_modules (anomalyco/opencode#39986),
// so a plugin installed from GitHub has to ship JSX that is already compiled.
import { readFileSync, watch, writeFileSync } from "node:fs"
import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Modules the host maps to its own instances; see the README section "How it works".
export const HOST_MODULES = ["@opencode/plugin", "effect", "@opentui/core", "@opentui/solid", "solid-js"]
// Exact specifiers the host maps. Other subpaths (solid-js/web, @opentui/keymap) would load a second copy.
export const HOST_SPECIFIERS = [
  /^@opencode\/plugin(\/.*)?$/,
  /^effect(\/.*)?$/,
  /^@opentui\/core$/,
  /^@opentui\/solid(\/(components|jsx-runtime|jsx-dev-runtime))?$/,
  /^solid-js(\/store)?$/,
]

const root = path.join(import.meta.dir, "..")
const outdir = path.join(root, "dist")

export async function compile() {
  const result = await Bun.build({
    entrypoints: [path.join(root, "src/index.ts"), path.join(root, "src/tui.tsx")],
    outdir,
    root: path.join(root, "src"),
    target: "bun",
    format: "esm",
    // The host provides these; bundling them would create a second Solid instance. Anything else is bundled.
    external: HOST_MODULES.map((name) => `${name}*`),
    plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
  })
  if (!result.success) throw new AggregateError(result.logs, "Compile failed")
  for (const output of result.outputs) {
    // Bun marks each bundled module with a path relative to the machine's cwd; drop it so builds match.
    const code = readFileSync(output.path, "utf8").replace(/^\/\/ \S+\.[cm]?[jt]sx?\n/gm, "")
    writeFileSync(output.path, code)
  }
  return result.outputs.map((output) => path.relative(root, output.path).replaceAll("\\", "/"))
}

if (import.meta.main) {
  console.log((await compile()).join("\n"))
  if (process.argv.includes("--watch")) {
    let running = Promise.resolve()
    watch(path.join(root, "src"), { recursive: true }, () => {
      running = running
        .then(compile)
        .then(() => console.log(`compiled ${new Date().toLocaleTimeString()}`))
        .catch((error) => console.error(error))
    })
  }
}
