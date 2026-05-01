# Sandbox `gh` auth is host-fetched and tide-managed

The agent inside tide's docker sandbox owns the full GitHub side-effects of an iteration (closing its sub-issue, and eventually opening the PR — see ADR 0001). `gh` inside the sandbox therefore needs an auth token. Tide fetches it host-side via `gh auth token --hostname github.com`, injects it into the sandbox as `GH_TOKEN`, and forbids the user from setting `GH_TOKEN` in `.tide/.env`.

## Considered

- **Bind-mount the host's `~/.config/gh/` into the container.** Tracks whatever gh state the host has, no host-side fetch. Rejected: the on-disk layout differs across `gh` versions and OSes (macOS keychain, Linux plain file, Windows separate path), and `gh`'s storage location has churned. A mount-based design forces tide to encode the matrix.
- **Require `GH_TOKEN` in `.tide/.env`.** Explicit, no host-side coupling. Rejected: duplicates a credential the user has _already_ given to `gh` via `gh auth login` (which `tide doctor` already verifies), introducing a second source that drifts on rotation.
- **Move `gh issue close` (and the future PR-create) to the host.** Avoids sandbox auth entirely. Rejected: contradicts ADR 0001 — host-side `gh` calls "duplicate the git and `gh` access the sandbox already provides." Fragmenting the agent's lifecycle to dodge an auth wiring problem is the wrong trade.

## Consequences

`env-loader` rejects `GH_TOKEN` in `.tide/.env` (mirroring the _policy_, not the mechanism, of `LINEAR_API_KEY`: tide owns this key). User-friction cost is a one-line "tide manages this; remove it from .tide/.env" hint when the rejection fires.

The token is captured once at run-start; mid-run rotation is not handled. `gh auth login`'s default OAuth tokens are long-lived enough that this is a non-issue in practice; if it becomes one, refresh per iteration before invoking `run()`.

`tide doctor`'s existing "gh auth" step (which checks `gh auth status`) covers the new dependency: `gh auth token` and `gh auth status` consult the same auth state machine. A divergence would be a `gh` bug, not a tide-config bug, so no new doctor check is added.

The `--hostname github.com` pin matches the rest of tide's implicit assumption (Linear URL builder hardcodes `https://github.com/...`, `gh-identity`'s error message references github.com). When GHES support lands, `gh-identity` and `gh-token` get updated in lockstep.
