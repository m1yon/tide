// Interactive clack prompts:
//   - pickParent: single-select over the parent / standalone tree, sorted by
//     issue-number desc, formatted "#NN <title> (X subs)" (suffix omitted for
//     standalones).
//   - resolveLinearIssue: list every PRD-labelled Linear issue on the
//     configured team and render a single select whose first option is
//     "[Create new Linear PRD]" and whose remaining options are the existing
//     PRDs sorted by `updatedAt` desc. Picking an existing PRD returns it
//     directly; picking "create new" falls through to createIssueForParent.
//     If zero PRDs match, the select is skipped and the create path runs
//     immediately.

import { select, isCancel, cancel, spinner, log } from "@clack/prompts";
import type { TreeNode } from "../github/index.ts";
import {
  createIssueForParent,
  listExistingPRDs,
  type ExistingPRD,
  type LinearContext,
  type LinearResult,
  type ParentForLinear,
} from "../linear/index.ts";

export async function pickParent(tree: TreeNode[]): Promise<TreeNode> {
  const sorted = [...tree].sort((a, b) => b.root.number - a.root.number);
  const options = sorted.map((node) => {
    const subCount = node.subs.length;
    const suffix = subCount > 0 ? ` (${String(subCount)} subs)` : "";
    return {
      value: node.root.number,
      label: `#${String(node.root.number)} ${node.root.title}${suffix}`,
    };
  });

  const picked = await select({
    message: "Pick a parent issue (or standalone):",
    options,
  });

  if (isCancel(picked)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const found = tree.find((n) => n.root.number === picked);
  if (!found) {
    // Should be impossible: picked is one of the values we passed in.
    throw new Error(
      `Internal error: picked issue ${String(picked)} not in tree`
    );
  }
  return found;
}

async function createPRD(
  ctx: LinearContext,
  parent: ParentForLinear
): Promise<LinearResult> {
  const sp = spinner();
  sp.start("Creating Linear issue");
  try {
    const result = await createIssueForParent(ctx, parent);
    sp.stop(`Linear issue created: ${result.identifier}`);
    return result;
  } catch (err) {
    sp.stop("Linear create failed");
    throw err;
  }
}

export async function resolveLinearIssue(
  ctx: LinearContext,
  parent: ParentForLinear
): Promise<LinearResult> {
  const sp = spinner();
  sp.start("Searching Linear for existing PRDs");
  let existing: ExistingPRD[];
  try {
    existing = await listExistingPRDs(ctx);
  } catch (err) {
    sp.stop("Linear PRD search failed");
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    throw err;
  }
  sp.stop(
    existing.length === 0
      ? "No existing Linear PRDs"
      : `Found ${String(existing.length)} existing PRD(s)`
  );

  if (existing.length === 0) {
    return await createPRD(ctx, parent);
  }

  // The select's value is a numeric index into `existing`, with -1 reserved
  // for the "create new" option. Object-valued options would be cleaner but
  // confuse clack's Option<Value> inference for non-primitive values.
  const CREATE_INDEX = -1;
  const options: { value: number; label: string }[] = [
    { value: CREATE_INDEX, label: "[Create new Linear PRD]" },
    ...existing.map((prd, i) => ({
      value: i,
      label: `${prd.identifier} ${prd.title} — ${prd.state}`,
    })),
  ];

  const choice = await select<number>({
    message: "Linear PRD:",
    options,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  if (choice === CREATE_INDEX) {
    return await createPRD(ctx, parent);
  }
  const prd = existing[choice];
  if (!prd) {
    // Should be impossible: choice was one of the option values we provided.
    throw new Error(
      `Internal error: picked PRD index ${String(choice)} not in list`
    );
  }
  return {
    branchName: prd.branchName,
    identifier: prd.identifier,
    url: prd.url,
  };
}
