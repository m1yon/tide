# Vendored patches

Patches in this directory are applied via Bun's `patchedDependencies` (see
`package.json`). `bun install` re-applies them on every install; nothing else
in the workflow needs to change.

## `@ai-hero/sandcastle@0.5.6`

### Symptom

Re-running `tide run` on the same parent issue (same Linear-derived
`branchName`) errored at worktree creation:

> Branch '<b>' is already checked out in worktree at '<path>'. Use a different
> branch name, or wait for the other run to finish.

The user had to `git worktree remove` the previous run's worktree by hand
before retrying.

### Cause

Tide bridges sandcastle's hardcoded `<repo>/.sandcastle/` directory to
`<repo>/.tide/` with a relative symlink (`ensureSandcastleSymlink` in
`src/cli/run.ts`). `git worktree list --porcelain` canonicalizes paths via
realpath, so a managed worktree comes back as `<repo>/.tide/worktrees/...`.

Sandcastle's `WorktreeManager.create` decides whether a colliding worktree is
sandcastle-managed (and therefore reusable) by `startsWith` against the
un-canonicalized `<repo>/.sandcastle/worktrees` prefix. Through the symlink
that check fails, the worktree is treated as external, and create throws
instead of reusing.

`pruneStale` in the same file already canonicalizes the prefix via
`fs.realPath` before comparing — `create` was simply missed.

### The patch

In `WorktreeManager.create`, when a collision is found, resolve `worktreesDir`
through `fs.realPath` (with a fallback to the raw path on error, mirroring
`pruneStale`'s pattern) and accept a collision path that starts with either
the raw or canonicalized prefix when deciding `isManagedWorktree`. ~5 LOC.

### Why patch instead of waiting

Upstream's `pruneStale` got the same fix in 0.5.6 — `create` was overlooked
and the symptom only surfaces with a symlinked `.sandcastle/`. Carrying a
small patch unblocks resume-on-re-run today; waiting on upstream means every
aborted run requires manual cleanup.

### Deletion criteria

When upstream sandcastle ships the same canonicalization in `create`:

1. Bump the version pin in `package.json` past the fix.
2. Delete the `patchedDependencies` entry for `@ai-hero/sandcastle`.
3. Delete this patch file.

### Manual smoke after a sandcastle bump

1. `tide run` against any parent issue with at least one open sub-issue.
2. Abort partway (Ctrl-C, or let an iteration fail).
3. Re-run `tide run` on the same parent.
4. Confirm sandcastle logs `Reusing existing worktree at <path> (branch
'<branch>')` instead of throwing the "already checked out" error.
