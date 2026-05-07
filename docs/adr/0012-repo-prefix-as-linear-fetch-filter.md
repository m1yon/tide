# Repo prefix as the Linear-fetch scope filter

Tide filters every Linear issue list query by `title: { startsWith: "[<repo>] " }`, where `<repo>` is the working tree's GitHub repository name (sourced from the existing gh-identity helper). Wrong-repo and unprefixed issues are invisible to the picker, the queue build, and the **queue rebuild** (ADR-0010). Lets one Linear team back multiple repos without cross-contaminating `tide run` queues.

The `[<repo>] ` prefix itself — open-bracket, repo name, close-bracket, single space — is written by the triage / to-prd / to-issues skills at issue-creation time (the sibling decision lives in the dotfiles repo's ADR for that work). Tide's responsibility is to consume it as a filter on every Linear fetch.

## Considered

- **Hard-fail at run-start in `runQueueAfterPick` if the picked root's title doesn't match the working repo.** Rejected: protects the picked root but not the **Sub-issues** under a **PRD**. Either gets an asymmetric design (validate root, trust children) — which lets a mistitled Sub-issue silently run against the wrong repo, exactly the failure the prefix exists to prevent — or grows a per-iteration recheck duplicating work the fetch layer is already in the right place to do. Filtering at the fetch layer is one invariant, applied uniformly.

- **Validate at the picked root level only; trust **Sub-issues** to inherit the parent's prefix.** Rejected for the same mistitled-child reason as above. The convenience of "PRD parent owns the repo identity" is real, but the silent-wrong-repo failure mode it permits is the worst possible outcome.

- **Hard-fail on missing prefix; warn-and-continue on mismatch (or vice versa).** Rejected: the fetch-layer filter collapses both fail modes into a single observable behaviour — the issue does not appear. The user-visible difference between "wrong repo" and "no prefix at all" disappears, which is fine: in both cases the recovery is the same (retitle, or pick a different issue).

- **Source `<repo>` from a fresh `git remote get-url origin` parse for byte-for-byte symmetry with the skill-side derivation.** Rejected: tide already has a load-bearing claim that `gh repo view` is the source of truth for repo identity (see the ADR comment in the gh-identity module). Splitting that contract for symmetry with a sibling repo's skill is not worth a second derivation. The two derivations agree on freshly-cloned repos; on a GitHub-renamed repo, `gh`-side correctly catches the drift while the skill-side `git remote` parse goes stale until the user runs `git remote set-url`.

- **Tolerate whitespace inside the brackets (`[ tide ]`) on the consumer side.** Rejected: the skill-side ADR specifies the exact `[<repo>] ` form. Tolerance on tide's side hides skill-side bugs that should surface loudly.

- **Add a `repo.name` field to `.tide/config.ts` so users can override the inferred name.** Rejected: ADR-0004 and the gh-identity module's existing comment both stake out "inferred not configured" as the contract. Introducing a config override here would re-open that decision for one feature, and the override is a footgun — a user who renames their GitHub repo and forgets to update the config gets silent wrong-repo runs back.

## Consequences

Every Linear list call in tide grows a `title: { startsWith: "[<repo>] " }` clause: PRD candidates, Standalone Issue candidates, and a PRD's direct **Sub-issues** at queue-build time and at every **iteration boundary**. The repo name is threaded through to the fetch layer from the caller (already available via gh-identity), so no new shell-out is added per call.

Migration: every Linear issue created before this change predates the prefix. Until each is manually retitled, it is invisible to tide. The skills that create issues (triage / to-prd / to-issues) write the prefix on new issues going forward; backfill of legacy issues is a one-time manual pass per repo. This is the same migration shape as ADR-0004's `prd` label introduction — user vocabulary, no auto-creation.

A side benefit: removing the prefix from a Linear issue mid-flight pauses it for tide without losing its identity, similar to the existing `ready-for-agent` label-removal pause. Not the primary purpose; falls out for free.

A subtle cost: a **Sub-issue** mistitled by a human typo becomes invisible with no error to point at. The user sees it in Linear, tide silently does not pick it up. Diagnosed by maintainer eyeball; fixed by retitle. The alternative — surfacing every "did not match" issue with a warning — would either be noisy (most non-matches are intentional cross-repo issues) or require tide to know about the user's other repo prefixes, which it doesn't.

When any of the three list paths returns zero issues, the CLI prints a message naming the working repo and the two recovery moves (retitle existing issues, or create one via the triage / to-prd skill), so an empty picker is never silently confusing.

The `[<repo>] ` form does not appear in PR bodies, branch names, or commit messages — those continue to follow ADR-0006 (branch name as the sole PR↔PRD link). The prefix is purely a Linear-side title affordance.
