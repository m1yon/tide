// GitHub-side types used by the PR submission tail step.
//
// The Linear-native flow no longer queries GitHub for issue tracking — PRDs
// and sub-issues live in Linear (see ADR-0004). The GitHub side is reduced
// to repo identity (`GhRepo`) for the eventual `gh pr create` invocation
// against the host's repo.

export interface GhRepo {
  owner: string;
  repo: string;
}
