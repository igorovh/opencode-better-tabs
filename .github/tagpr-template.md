chore: release {{.NextVersion}}

Merging this PR tags {{.NextVersion}} on the merge commit and publishes a GitHub release with notes from the merged PR titles.

- Patch by default. Add the `tagpr:minor` or `tagpr:major` label for a bigger bump.
- Test the changes in OpenCode before merging: this is the release step.
