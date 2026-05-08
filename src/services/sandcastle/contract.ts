// Shared contract test for `SandcastleService`. Invoked once against the
// in-memory fake (in the short suite, always runs) and once against the
// SDK-backed implementation (in the `*.long.test.ts` suite, runs only in
// `bun run ftest`).
//
// The contract is intentionally narrow — sandcastle's `run` and
// `createWorktree` produce wildly different results between the live arm
// (real Docker, real git worktree) and the in-memory arm (scripted
// queue, stub Worktree), so this suite asserts only on the API shape both
// implementations must satisfy: `readFinalAssistantMessage` resolves to a
// string. Behaviour-level coverage lives on the in-memory test (full
// scenarios cheap to run) and on the live arm's smoke tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandcastleService } from "./index.ts";

/**
 * Factory invoked by the contract suite to produce a fresh service per
 * scenario. Returning `undefined` from the live-arm factory skips the arm
 * entirely — the long test uses this to opt out cleanly when a required
 * dependency (Docker, git, credentials) is unavailable.
 */
export type SandcastleServiceFactory = () =>
  | Promise<SandcastleService | undefined>
  | SandcastleService
  | undefined;

/**
 * Scenarios both `InMemorySandcastleService` and `SandcastleSdkService`
 * must satisfy. The shape is intentionally narrow: the SDK arm composes
 * `transcript-extract` (a pure parser) so reading from a real log file
 * works there; the in-memory arm returns the empty string for unseeded
 * paths, which still satisfies the API-shape contract that the method
 * resolves to a string. Behaviour-rich scenarios live on the
 * implementation-specific test files.
 */
export function sandcastleServiceContract(
  name: string,
  factory: SandcastleServiceFactory
): void {
  describe(`SandcastleService contract — ${name}`, () => {
    test("readFinalAssistantMessage resolves to a string for a missing/empty log path", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      const dir = mkdtempSync(join(tmpdir(), "sandcastle-contract-"));
      try {
        const logPath = join(dir, "agent.log");
        writeFileSync(logPath, "");
        const message = await svc.readFinalAssistantMessage(logPath);
        expect(typeof message).toBe("string");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
