# tide

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Skills

`tide setup` writes three Claude Code skills into `<repoRoot>/.claude/skills/tide-*/`. Once setup has run, the slash commands work in any Claude Code session opened against the repo:

- `/tide-to-prd` — author a tide PRD in Linear from a brief or conversation context. Applies the `prd` label and the `[<repo>] ` title prefix; leaves the issue ready for `/tide-to-issues`.
- `/tide-to-issues` — break a PRD into queueable Linear sub-issues. Each child carries `ready-for-agent`, the `[<repo>] ` prefix, the PRD as parent, and `blockedBy` relations for ordering.
- `/tide-triage` — triage Linear issues in the tide team. Applies the canonical label vocabulary (`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), normalises titles to the `[<repo>] ` prefix, and moves items out of the `Triage` state.

The skill bodies are committed under `.claude/skills/tide-*/`. Re-running `tide setup` after a tide upgrade overwrites them with the bundled bytes (silent if identical, mtime-changing rewrite otherwise). User-authored skills under `.claude/skills/` outside the `tide-*/` namespace are never touched.
