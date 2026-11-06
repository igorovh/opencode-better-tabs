import { expect, test } from "bun:test"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"
import { HOST_SPECIFIERS } from "../scripts/compile"

const dist = path.join(import.meta.dir, "..", "dist")
const builtins = new Set(builtinModules)

// A GitHub install only gets host modules from OpenCode; any other import would load a second copy or fail.
for (const file of ["index.js", "tui.js"]) {
  test(`dist/${file} imports only host modules and Node built-ins`, () => {
    const code = readFileSync(path.join(dist, file), "utf8")
    const specifiers = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(code).not.toMatch(/\brequire\(|import\(/)
    const foreign = specifiers.filter(
      (specifier) =>
        !specifier.startsWith("node:") && !builtins.has(specifier) && !HOST_SPECIFIERS.some((pattern) => pattern.test(specifier)),
    )
    expect(foreign).toEqual([])
  })
}
