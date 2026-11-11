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

## Pull requests

- PRs are squash-merged and the title becomes the changelog entry, so it must be a Conventional Commit such as
  `feat: confirm before closing a tab` or `fix: keep the tab order after a restart`.

## Releases

- tagpr keeps a `chore: release vX.Y.Z` PR open; merging it tags the release and publishes the GitHub release.
- Do not bump the version, create a tag, or merge the release PR until the user has confirmed the change works in
  their OpenCode. Commit fixes locally and wait for that confirmation.
