// Shared contract test for `LinearService`. Invoked once against the
// in-memory fake (in the short suite, always runs) and once against the
// SDK-backed implementation (in the `*.long.test.ts` suite, runs only in
// `bun run ftest` and requires Linear API credentials in the environment).
//
// Each scenario uses behaviour visible through the public interface only —
// no calls into observation methods or other fake-only surface. The same
// scenarios MUST hold for both implementations; that's the whole point of
// the contract.

import { describe, expect, test } from "bun:test";
import type { LinearService } from "./index.ts";

/**
 * Factory invoked by the contract suite to produce a fresh service per
 * scenario. The factory may be async (the SDK live arm typically performs
 * a setup call). Returning `undefined` from the live-arm factory skips the
 * arm entirely — the long test uses this to opt out cleanly when
 * credentials are absent.
 */
export type LinearServiceFactory = () =>
  | Promise<LinearService | undefined>
  | LinearService
  | undefined;

/**
 * Scenarios both `InMemoryLinearService` and `LinearSdkService` must
 * satisfy. The shape is intentionally small — full coverage of the SDK
 * translation lives on the in-memory arm (where a single seed builds a
 * scenario in three lines); the live arm exercises connectivity against
 * a real team via a smaller smoke set.
 */
export function linearServiceContract(
  name: string,
  factory: LinearServiceFactory
): void {
  describe(`LinearService contract — ${name}`, () => {
    test("viewer resolves quietly on a healthy backend", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      await svc.viewer();
    });

    test("listPRDs returns an array (possibly empty)", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      const prds = await svc.listPRDs();
      expect(Array.isArray(prds)).toBe(true);
    });

    test("listStandaloneIssues returns an array (possibly empty)", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      const issues = await svc.listStandaloneIssues();
      expect(Array.isArray(issues)).toBe(true);
    });

    test("setupLabels is idempotent — second call reports created:false for every canonical label", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      await svc.setupLabels();
      const second = await svc.setupLabels();
      expect(second.map((r) => r.name).sort()).toEqual([
        "prd",
        "ready-for-agent",
        "ready-for-human",
      ]);
      expect(second.every((r) => !r.created)).toBe(true);
    });

    test("provisionInReviewState is idempotent — second call reports created:false", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      await svc.provisionInReviewState();
      const second = await svc.provisionInReviewState();
      expect(second.created).toBe(false);
      expect(second.name).toBe("In Review");
    });

    test("assertInReviewStatePresent resolves quietly once the state has been provisioned", async () => {
      const svc = await factory();
      if (svc === undefined) return;
      await svc.provisionInReviewState();
      await svc.assertInReviewStatePresent();
    });
  });
}
