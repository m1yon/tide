// Live-arm contract test: runs the LinearService contract against a real
// `LinearSdkService`. Lives in `*.long.test.ts` so it ships only in
// `bun run ftest`, not the pre-commit `bun run test` path.
//
// Requires `LINEAR_API_KEY` (a Linear personal API token) and
// `LINEAR_TEAM_KEY` (the canonical short key, e.g. `PER`) in the
// environment. When either is absent the factory returns `undefined`,
// which the contract suite interprets as "skip this scenario" — so the
// long suite is safe to run locally without credentials, but CI is
// expected to provision both.
//
// `LINEAR_REPO_NAME` is optional; defaults to a synthetic value because
// the connectivity-shaped contract scenarios don't depend on it.

import { LinearSdkService } from "./sdk.ts";
import { linearServiceContract } from "./contract.ts";

linearServiceContract("LinearSdkService", () => {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamKey = process.env.LINEAR_TEAM_KEY;
  if (
    typeof apiKey !== "string" ||
    apiKey === "" ||
    typeof teamKey !== "string" ||
    teamKey === ""
  ) {
    return undefined;
  }
  return new LinearSdkService({
    apiKey,
    teamKey,
    repoName: process.env.LINEAR_REPO_NAME ?? "tide-contract-test",
  });
});
