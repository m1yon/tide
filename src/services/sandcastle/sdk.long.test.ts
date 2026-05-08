// Live-arm contract test: runs the SandcastleService contract against a
// real `SandcastleSdkService`. Lives in `*.long.test.ts` so it ships only
// in `bun run ftest`, not the pre-commit `bun run test` path.
//
// The transcript-read scenarios in the contract suite touch only the
// `transcript-extract` parser composed inside `SandcastleSdkService` — no
// Docker is required for them, so the live arm stays cheap. Deeper
// scenarios (real `run` with real Docker, real `createWorktree` against a
// real git repo) are intentionally NOT part of the contract: the live arm
// covers a small set of smoke scenarios; full coverage lives on the
// in-memory arm.

import { SandcastleSdkService } from "./sdk.ts";
import { sandcastleServiceContract } from "./contract.ts";

sandcastleServiceContract("SandcastleSdkService", () => {
  return new SandcastleSdkService();
});
