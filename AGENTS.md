# Agent notes

## Checks

- Run `bun run typecheck`, `bun test` and `bun run compile` before you push. CI fails when `dist/` does not match
  `src/`, so commit the rebuilt `dist/` with every source change.

## UI preview

- `bun run preview -- --out bar.png` renders the tab bar with sample tabs (active, busy, waiting, unread, error).
- `--options '{"padding":1}'` passes plugin options, `--hover "<row text>"` hovers a row, and `--width` and
  `--height` set the size in cells.
- When a change affects what the bar shows, render it on the base branch and on your branch and post both images
  as "Before" and "After".

## Demo recordings

- `bun run record -- --out demo.gif --step "hover Dark mode" --step "close Flaky checkout"` records the real
  OpenCode TUI with this checkout's plugin to a GIF. It needs `opencode`, `ttyd` and `ffmpeg` on `PATH` (or
  `OPENCODE_BIN` and `TTYD_BIN`) and Playwright's Chromium. Run it without steps to see the step list.
- `--options '{"confirmClose":true}'` passes plugin options and `--sidebar` crops the GIF to the tab bar.
  `--plugin <path>` records another checkout, such as a worktree of the base branch.
- `--sessions sessions.json` replaces the sample tabs with a JSON array of `{ "project", "title" }`. Busy and
  unread tabs need a model run, so show those states with `bun run preview`. Sessions are created in the
  listed order, so the last one has the most recent activity.
- `expect <text>` and `expect-not <text>` steps fail the recording when the screen does not match, so a GIF
  doubles as a test. Put them after every action, for example `close Two`, `expect Close tab`, `key Enter`,
  `expect-not Two`. `expect-above <a> -> <b>` checks an order, such as `expect-above docs -> api`. A failed
  step stops the steps but still writes the GIF, then exits with an error.
- A check in a before-and-after recording should pass on the PR branch and fail on the base branch. A check
  that passes on both, such as `expect New session`, proves nothing about the change.
- Every PR that changes `src/` in a way the user can see or touch must include a GIF of the changed behaviour,
  before and after. A reviewer records them when the author did not: read the diff, script the new behaviour
  with `expect` checks, record it on the PR branch and on the base branch, and post the steps with the GIFs.

## Pull requests

- PRs are squash-merged and the title becomes the changelog entry, so it must be a Conventional Commit such as
  `feat: confirm before closing a tab` or `fix: keep the tab order after a restart`.

## Releases

- tagpr keeps a `chore: release vX.Y.Z` PR open; merging it tags the release and publishes the GitHub release.
- Do not bump the version, create a tag, or merge the release PR until the user has confirmed the change works in
  their OpenCode. Commit fixes locally and wait for that confirmation.
