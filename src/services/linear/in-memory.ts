// Domain-shaped in-memory `LinearService` implementation. Tests construct
// it with a small seed and call `runCli` (or the per-module entry point)
// directly. Observation methods (`transitionsOf`, `commentsOn`,
// `labelsOf`) are intentionally NOT on the `LinearService` interface —
// production code references the interface only; tests reference the
// concrete fake type when asserting on observed Linear writes.
//
// Failure-injection is supported via `failNext(method, error)` — useful
// for testing infra-error paths without restructuring the seed. For
// scenarios where return values must vary per call (e.g. the runner's
// mid-run queue rebuild simulating a human adding a sub-issue), tests can
// install a temporary handler via `setFetchSubIssuesHandler(...)` etc;
// the handler is consulted before the default state-based response.

import {
  IN_REVIEW_STATE_NAME,
  SETUP_LABEL_NAMES,
  type LinearIssueContent,
  type PRD,
  type ProvisionInReviewStateResult,
  type SetupLabelResult,
  type StandaloneIssue,
  type SubIssue,
} from "../../linear/index.ts";
import type { LinearService } from "./index.ts";

/**
 * Seed for an `InMemoryLinearService`. Every field is optional; defaults
 * behave like an empty Linear team that already has the canonical labels
 * and the `In Review` workflow state.
 */
export interface InMemoryLinearSeed {
  /** PRDs returned by `listPRDs()`. */
  prds?: readonly PRD[];
  /** Standalone Issues returned by `listStandaloneIssues()`. */
  standaloneIssues?: readonly StandaloneIssue[];
  /** Direct sub-issues, keyed by parent UUID. Returned by
   * `fetchSubIssues(parentId)`. */
  subIssuesByParent?: Readonly<Record<string, readonly SubIssue[]>>;
  /** Body + comments, keyed by issue UUID. */
  issueContent?: Readonly<Record<string, LinearIssueContent>>;
  /** Initial labels on each issue, keyed by issue UUID. Updated by
   * `flipLabelToReadyForHuman`. */
  initialLabels?: Readonly<Record<string, readonly string[]>>;
  /** Initial canonical labels present on the team. Defaults to all three. */
  existingTeamLabels?: readonly string[];
  /** Whether the team has the `In Review` workflow state. Defaults to true. */
  inReviewStatePresent?: boolean;
  /** Whether `viewer()` succeeds. Defaults to true. */
  viewerOk?: boolean;
}

type MethodName = keyof LinearService;

export class InMemoryLinearService implements LinearService {
  #prds: PRD[];
  #standaloneIssues: StandaloneIssue[];
  #subIssuesByParent: Map<string, SubIssue[]>;
  #issueContent: Map<string, LinearIssueContent>;
  #labels: Map<string, string[]>;
  #existingTeamLabels: Set<string>;
  #inReviewStatePresent: boolean;
  #viewerOk: boolean;

  /** Per-issue chronological list of state-name transitions. */
  #transitions = new Map<string, string[]>();
  /** Per-issue chronological list of comment bodies. */
  #comments = new Map<string, string[]>();

  /** Pending one-shot failures by method name. */
  #failures = new Map<MethodName, Error>();

  /** Optional observer fired before every method dispatch. Tests install
   * this to capture cross-method call order in a single `events` array
   * (interleaving Linear method calls with whatever else they're tracking,
   * e.g. `sandcastleRun` invocations). */
  onMethodCall:
    | ((method: MethodName, args: readonly unknown[]) => void)
    | undefined;

  /** Optional handlers installed by tests for per-call overrides. */
  #fetchSubIssuesHandler:
    | ((parentId: string) => Promise<SubIssue[]>)
    | undefined;
  #fetchIssueContentHandler:
    | ((issueId: string) => Promise<LinearIssueContent>)
    | undefined;
  #listPRDsHandler: (() => Promise<PRD[]>) | undefined;
  #listStandaloneIssuesHandler: (() => Promise<StandaloneIssue[]>) | undefined;

  constructor(seed: InMemoryLinearSeed = {}) {
    this.#prds = [...(seed.prds ?? [])];
    this.#standaloneIssues = [...(seed.standaloneIssues ?? [])];
    this.#subIssuesByParent = new Map();
    for (const [k, v] of Object.entries(seed.subIssuesByParent ?? {})) {
      this.#subIssuesByParent.set(k, [...v]);
    }
    this.#issueContent = new Map();
    for (const [k, v] of Object.entries(seed.issueContent ?? {})) {
      this.#issueContent.set(k, v);
    }
    this.#labels = new Map();
    for (const [k, v] of Object.entries(seed.initialLabels ?? {})) {
      this.#labels.set(k, [...v]);
    }
    this.#existingTeamLabels = new Set(
      seed.existingTeamLabels ?? [...SETUP_LABEL_NAMES]
    );
    this.#inReviewStatePresent = seed.inReviewStatePresent ?? true;
    this.#viewerOk = seed.viewerOk ?? true;
  }

  // ------- failure injection -------

  /**
   * Make the *next* call to `method` throw `error` instead of executing.
   * One-shot: cleared after firing. Useful for stress-testing infra-error
   * paths without restructuring the seed.
   */
  failNext(method: MethodName, error: Error): void {
    this.#failures.set(method, error);
  }

  // ------- handler overrides for advanced test scenarios -------

  /** Override the default state-based `fetchSubIssues` behaviour. The
   * handler is consulted on every call until `null` is passed to clear it.
   * Used by runner-rebuild tests that need different responses per call. */
  setFetchSubIssuesHandler(
    handler: ((parentId: string) => Promise<SubIssue[]>) | null
  ): void {
    this.#fetchSubIssuesHandler = handler ?? undefined;
  }

  setFetchIssueContentHandler(
    handler: ((issueId: string) => Promise<LinearIssueContent>) | null
  ): void {
    this.#fetchIssueContentHandler = handler ?? undefined;
  }

  setListPRDsHandler(handler: (() => Promise<PRD[]>) | null): void {
    this.#listPRDsHandler = handler ?? undefined;
  }

  setListStandaloneIssuesHandler(
    handler: (() => Promise<StandaloneIssue[]>) | null
  ): void {
    this.#listStandaloneIssuesHandler = handler ?? undefined;
  }

  // ------- mutable seed accessors -------

  /** Replace (or extend) the sub-issue list for a parent. Used by tests
   * that mutate state mid-scenario. */
  setSubIssues(parentId: string, subIssues: readonly SubIssue[]): void {
    this.#subIssuesByParent.set(parentId, [...subIssues]);
  }

  setIssueContent(issueId: string, content: LinearIssueContent): void {
    this.#issueContent.set(issueId, content);
  }

  // ------- observation methods (NOT on the LinearService interface) -------

  /** Workflow-state names this issue was transitioned to, in order. */
  transitionsOf(issueId: string): string[] {
    return [...(this.#transitions.get(issueId) ?? [])];
  }

  /** Comment bodies posted on this issue, in order. */
  commentsOn(issueId: string): string[] {
    return [...(this.#comments.get(issueId) ?? [])];
  }

  /** Current labels on this issue. Reflects flips applied via
   * `flipLabelToReadyForHuman`. */
  labelsOf(issueId: string): string[] {
    return [...(this.#labels.get(issueId) ?? [])];
  }

  // ------- LinearService implementation -------

  viewer(): Promise<void> {
    return this.#withFailureCheck("viewer", () => {
      if (!this.#viewerOk) {
        return Promise.reject(new Error("Linear viewer query failed"));
      }
      return Promise.resolve();
    });
  }

  listPRDs(): Promise<PRD[]> {
    return this.#withFailureCheck("listPRDs", () => {
      if (this.#listPRDsHandler) return this.#listPRDsHandler();
      return Promise.resolve([...this.#prds]);
    });
  }

  listStandaloneIssues(): Promise<StandaloneIssue[]> {
    return this.#withFailureCheck("listStandaloneIssues", () => {
      if (this.#listStandaloneIssuesHandler)
        return this.#listStandaloneIssuesHandler();
      return Promise.resolve([...this.#standaloneIssues]);
    });
  }

  setupLabels(): Promise<SetupLabelResult[]> {
    return this.#withFailureCheck("setupLabels", () => {
      const results: SetupLabelResult[] = [];
      for (const name of SETUP_LABEL_NAMES) {
        if (this.#existingTeamLabels.has(name)) {
          results.push({ name, created: false });
          continue;
        }
        this.#existingTeamLabels.add(name);
        results.push({ name, created: true });
      }
      return Promise.resolve(results);
    });
  }

  provisionInReviewState(): Promise<ProvisionInReviewStateResult> {
    return this.#withFailureCheck("provisionInReviewState", () => {
      const created = !this.#inReviewStatePresent;
      this.#inReviewStatePresent = true;
      return Promise.resolve({ name: IN_REVIEW_STATE_NAME, created });
    });
  }

  assertInReviewStatePresent(): Promise<void> {
    return this.#withFailureCheck("assertInReviewStatePresent", () => {
      if (!this.#inReviewStatePresent) {
        return Promise.reject(
          new Error(
            `Linear team has no \`started\`-type workflow state named "${IN_REVIEW_STATE_NAME}". ` +
              `Run \`tide setup\` to provision it.`
          )
        );
      }
      return Promise.resolve();
    });
  }

  fetchSubIssues(parentId: string): Promise<SubIssue[]> {
    return this.#withFailureCheck(
      "fetchSubIssues",
      () => {
        if (this.#fetchSubIssuesHandler)
          return this.#fetchSubIssuesHandler(parentId);
        const subs = this.#subIssuesByParent.get(parentId);
        if (!subs) return Promise.resolve([]);
        return Promise.resolve([...subs]);
      },
      [parentId]
    );
  }

  fetchIssueContent(issueId: string): Promise<LinearIssueContent> {
    return this.#withFailureCheck(
      "fetchIssueContent",
      () => {
        if (this.#fetchIssueContentHandler)
          return this.#fetchIssueContentHandler(issueId);
        const content = this.#issueContent.get(issueId);
        if (content) return Promise.resolve(content);
        // Synthetic default — the issue UUID becomes the identifier so tests
        // that don't seed content still get a deterministic, debuggable
        // response.
        return Promise.resolve({
          identifier: issueId,
          title: issueId,
          body: "",
          comments: [],
        });
      },
      [issueId]
    );
  }

  transitionToInProgress(issueId: string): Promise<void> {
    return this.#recordTransition(
      "transitionToInProgress",
      issueId,
      "In Progress"
    );
  }

  transitionToDone(issueId: string): Promise<void> {
    return this.#recordTransition("transitionToDone", issueId, "Done");
  }

  transitionToInReview(issueId: string): Promise<void> {
    return this.#withFailureCheck(
      "transitionToInReview",
      () => {
        if (!this.#inReviewStatePresent) {
          return Promise.reject(
            new Error(
              `No workflow state named "${IN_REVIEW_STATE_NAME}" exists on the team for issue "${issueId}". ` +
                `Run \`tide setup\` to provision it.`
            )
          );
        }
        const list = this.#transitions.get(issueId) ?? [];
        list.push(IN_REVIEW_STATE_NAME);
        this.#transitions.set(issueId, list);
        return Promise.resolve();
      },
      [issueId]
    );
  }

  flipLabelToReadyForHuman(issueId: string): Promise<void> {
    return this.#withFailureCheck(
      "flipLabelToReadyForHuman",
      () => {
        if (!this.#existingTeamLabels.has("ready-for-human")) {
          return Promise.reject(
            new Error(
              `Linear team has no "ready-for-human" label. Run \`tide setup\` to provision it.`
            )
          );
        }
        const current = this.#labels.get(issueId) ?? [];
        const filtered = current.filter((l) => l !== "ready-for-agent");
        if (!filtered.includes("ready-for-human")) {
          filtered.push("ready-for-human");
        }
        this.#labels.set(issueId, filtered);
        return Promise.resolve();
      },
      [issueId]
    );
  }

  postComment(issueId: string, body: string): Promise<void> {
    return this.#withFailureCheck(
      "postComment",
      () => {
        const list = this.#comments.get(issueId) ?? [];
        list.push(body);
        this.#comments.set(issueId, list);
        return Promise.resolve();
      },
      [issueId, body]
    );
  }

  // ------- internals -------

  #withFailureCheck<T>(
    method: MethodName,
    body: () => Promise<T>,
    args: readonly unknown[] = []
  ): Promise<T> {
    this.onMethodCall?.(method, args);
    const err = this.#failures.get(method);
    if (err !== undefined) {
      this.#failures.delete(method);
      return Promise.reject(err);
    }
    return body();
  }

  #recordTransition(
    method: MethodName,
    issueId: string,
    stateName: string
  ): Promise<void> {
    return this.#withFailureCheck(method, () => {
      const list = this.#transitions.get(issueId) ?? [];
      list.push(stateName);
      this.#transitions.set(issueId, list);
      return Promise.resolve();
    }, [issueId]);
  }
}
