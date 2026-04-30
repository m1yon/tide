// Octokit GraphQL fetch for `ready-for-agent` issues with parent / sub-issue
// / blockedBy fields populated. Builds the parent -> flattened-descendants
// tree, applying the strict label rule (a sub-issue is included only when
// its parent is also labelled).
//
// Auth uses `gh auth token` shelled out at startup (no separate env var).
//
// owner/repo are parameterized: callers pass them in (typically resolved via
// `gh-identity`'s `getGhIdentity()`).

import { spawnSync } from "node:child_process";
import { graphql } from "@octokit/graphql";

const LABEL = "ready-for-agent";

// GraphQL feature headers required to expose the `blockedBy` field on Issue.
// `sub_issues` is enabled on the repo by default but listed for clarity.
const GH_FEATURE_HEADERS = {
  "GraphQL-Features": "issue_dependencies,sub_issues",
};

export interface GhRepo {
  owner: string;
  repo: string;
}

export interface FetchedIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  parent: { number: number; labels: string[] } | null;
  subIssues: number[];
  blockedBy: number[];
}

export interface TreeNode {
  // The top-level parent (or a standalone treated as its own parent).
  root: FetchedIssue;
  // Flattened descendants of any depth that are themselves labelled. May be
  // empty for standalones.
  subs: FetchedIssue[];
}

interface GqlIssueNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: { nodes: { name: string }[] };
  parent: {
    number: number;
    labels: { nodes: { name: string }[] };
  } | null;
  subIssues: { nodes: { number: number }[] };
  blockedBy: { nodes: { number: number }[] };
}

function ghAuthToken(): string {
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (r.status !== 0) {
    const stderr = r.stderr.trim();
    throw new Error(
      `\`gh auth token\` failed (exit ${String(r.status)}). Run \`gh auth login\` first.\n${stderr}`
    );
  }
  const token = r.stdout.trim();
  if (!token) {
    throw new Error(
      "`gh auth token` returned empty. Run `gh auth login` first."
    );
  }
  return token;
}

type Gql = ReturnType<typeof graphql.defaults>;

function client(): Gql {
  const token = ghAuthToken();
  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
      ...GH_FEATURE_HEADERS,
    },
  });
}

const QUERY = /* GraphQL */ `
  query ReadyForAgentIssues(
    $owner: String!
    $repo: String!
    $label: String!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: 100
        after: $cursor
        labels: [$label]
        states: [OPEN]
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          state
          labels(first: 20) {
            nodes {
              name
            }
          }
          parent {
            number
            labels(first: 20) {
              nodes {
                name
              }
            }
          }
          subIssues(first: 50) {
            nodes {
              number
            }
          }
          blockedBy(first: 50) {
            nodes {
              number
            }
          }
        }
      }
    }
  }
`;

async function fetchAllIssuesOnce(
  gql: Gql,
  ghRepo: GhRepo
): Promise<FetchedIssue[]> {
  const out: FetchedIssue[] = [];
  let cursor: string | null = null;
  for (;;) {
    const r: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: GqlIssueNode[];
        };
      };
    } = await gql(QUERY, {
      owner: ghRepo.owner,
      repo: ghRepo.repo,
      label: LABEL,
      cursor,
    });
    for (const n of r.repository.issues.nodes) {
      out.push({
        number: n.number,
        title: n.title,
        state: n.state,
        labels: n.labels.nodes.map((l) => l.name),
        parent: n.parent
          ? {
              number: n.parent.number,
              labels: n.parent.labels.nodes.map((l) => l.name),
            }
          : null,
        subIssues: n.subIssues.nodes.map((s) => s.number),
        blockedBy: n.blockedBy.nodes.map((b) => b.number),
      });
    }
    if (!r.repository.issues.pageInfo.hasNextPage) break;
    cursor = r.repository.issues.pageInfo.endCursor;
  }
  return out;
}

async function fetchAllIssuesWithRetry(
  gql: Gql,
  ghRepo: GhRepo
): Promise<FetchedIssue[]> {
  try {
    return await fetchAllIssuesOnce(gql, ghRepo);
  } catch {
    // One retry with a small backoff covers transient 5xx blips.
    await new Promise((res) => setTimeout(res, 1000));
    try {
      return await fetchAllIssuesOnce(gql, ghRepo);
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(`GitHub fetch failed after retry: ${msg}`, {
        cause: err2,
      });
    }
  }
}

// Group a flat list of labelled issues into parent-rooted trees.
function buildTree(issues: FetchedIssue[]): TreeNode[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const isLabelled = (n: FetchedIssue): boolean => n.labels.includes(LABEL);

  // Walk up the parent chain (using the input set as the source of truth on
  // labelling — a parent that's not in our input is by definition unlabelled)
  // until we find an issue whose immediate parent is null or absent from the
  // input.
  function topAncestor(start: FetchedIssue): FetchedIssue {
    let cur = start;
    for (;;) {
      if (!cur.parent) return cur;
      const parentInSet = byNumber.get(cur.parent.number);
      if (!parentInSet || !isLabelled(parentInSet)) return cur;
      cur = parentInSet;
    }
  }

  const rootsByNumber = new Map<number, TreeNode>();
  for (const issue of issues) {
    const root = topAncestor(issue);
    let entry = rootsByNumber.get(root.number);
    if (!entry) {
      entry = { root, subs: [] };
      rootsByNumber.set(root.number, entry);
    }
    if (issue.number !== root.number) {
      entry.subs.push(issue);
    }
  }

  // Sort sub lists for stable display downstream.
  for (const node of rootsByNumber.values()) {
    node.subs.sort((a, b) => a.number - b.number);
  }

  return [...rootsByNumber.values()];
}

export async function fetchTriageTree(ghRepo: GhRepo): Promise<TreeNode[]> {
  const gql = client();
  const issues = await fetchAllIssuesWithRetry(gql, ghRepo);
  return buildTree(issues);
}

// Helper for the early-exit guard and dep-graph build: closed sub-issues are
// common when resuming a partially-completed parent. We need to know the
// closed/open state of every sub-issue under the picked parent, including
// ones not in the labelled input set (a sub may have been closed and the
// label dropped).
//
// Returns the descendant chain under `rootNumber` (excluding the root
// itself), each entry hydrated with state, title, and a `blockedBy` list
// that has been resolved to remove blockers that are themselves closed
// (closed blockers can't actually block anything, so the dep-graph layer
// shouldn't see them).
export async function fetchSubtreeStates(
  ghRepo: GhRepo,
  rootNumber: number
): Promise<
  {
    number: number;
    state: "OPEN" | "CLOSED";
    blockedBy: number[];
    title: string;
  }[]
> {
  const gql = client();
  const visited = new Set<number>();
  const raw: {
    number: number;
    title: string;
    state: "OPEN" | "CLOSED";
    blockedByRaw: number[];
  }[] = [];
  const queue: number[] = [rootNumber];
  while (queue.length > 0) {
    const n = queue.shift();
    if (n === undefined) break;
    if (visited.has(n)) continue;
    visited.add(n);
    const r: {
      repository: {
        issue: {
          number: number;
          title: string;
          state: "OPEN" | "CLOSED";
          subIssues: { nodes: { number: number }[] };
          blockedBy: {
            nodes: { number: number; state: "OPEN" | "CLOSED" }[];
          };
        } | null;
      };
    } = await gql(
      /* GraphQL */ `
        query SubtreeState($owner: String!, $repo: String!, $num: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $num) {
              number
              title
              state
              subIssues(first: 50) {
                nodes {
                  number
                }
              }
              blockedBy(first: 50) {
                nodes {
                  number
                  state
                }
              }
            }
          }
        }
      `,
      { owner: ghRepo.owner, repo: ghRepo.repo, num: n }
    );
    const issue = r.repository.issue;
    if (!issue) continue;
    if (n !== rootNumber) {
      raw.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        // Drop closed blockers up front (they can't block anything).
        blockedByRaw: issue.blockedBy.nodes
          .filter((b) => b.state === "OPEN")
          .map((b) => b.number),
      });
    }
    for (const sub of issue.subIssues.nodes) {
      if (!visited.has(sub.number)) queue.push(sub.number);
    }
  }
  return raw.map((r) => ({
    number: r.number,
    title: r.title,
    state: r.state,
    blockedBy: r.blockedByRaw,
  }));
}

// Fetch a single issue's title, body, and comments. Used by the runner to
// hydrate per-iteration `promptArgs` for both the in-scope sub-issue and the
// parent (PRD context).
export async function fetchIssueContent(
  ghRepo: GhRepo,
  number: number
): Promise<{
  number: number;
  title: string;
  body: string;
  comments: string[];
}> {
  const gql = client();
  const r: {
    repository: {
      issue: {
        number: number;
        title: string;
        body: string | null;
        comments: { nodes: { body: string }[] };
      } | null;
    };
  } = await gql(
    /* GraphQL */ `
      query IssueContent($owner: String!, $repo: String!, $num: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $num) {
            number
            title
            body
            comments(first: 100) {
              nodes {
                body
              }
            }
          }
        }
      }
    `,
    { owner: ghRepo.owner, repo: ghRepo.repo, num: number }
  );
  if (!r.repository.issue) {
    throw new Error(`GitHub issue #${String(number)} not found.`);
  }
  return {
    number: r.repository.issue.number,
    title: r.repository.issue.title,
    body: r.repository.issue.body ?? "",
    comments: r.repository.issue.comments.nodes.map((c) => c.body),
  };
}

// Resolve the live state of an arbitrary set of issue numbers. Used by the
// orchestrator to filter closed blockers off the picked parent (or off any
// standalone) before passing to the dep-graph layer.
export async function fetchIssueStates(
  ghRepo: GhRepo,
  numbers: number[]
): Promise<Map<number, "OPEN" | "CLOSED">> {
  const gql = client();
  const out = new Map<number, "OPEN" | "CLOSED">();
  for (const n of numbers) {
    const r: {
      repository: {
        issue: { number: number; state: "OPEN" | "CLOSED" } | null;
      };
    } = await gql(
      /* GraphQL */ `
        query IssueState($owner: String!, $repo: String!, $num: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $num) {
              number
              state
            }
          }
        }
      `,
      { owner: ghRepo.owner, repo: ghRepo.repo, num: n }
    );
    if (r.repository.issue) {
      out.set(n, r.repository.issue.state);
    }
  }
  return out;
}
