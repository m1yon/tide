import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WritePolicy = "skip-if-exists" | "overwrite-silent-if-identical";

export type WriteOutcome = "created" | "overwritten" | "unchanged" | "skipped";

export interface WriteTarget {
  targetPath: string;
  content: string;
  policy: WritePolicy;
}

export interface WriteResult {
  targetPath: string;
  outcome: WriteOutcome;
}

/**
 * Writes a list of templated files to disk, returning the per-target outcome.
 *
 * Policies:
 *  - `skip-if-exists`: write only if the target does not exist. Used for
 *    user-owned files (`.tide/config.ts`, etc.) where a hand-edit must
 *    survive re-running setup.
 *  - `overwrite-silent-if-identical`: write only when the bytes differ from
 *    what is already on disk. Used for tide-owned files (bundled skills)
 *    where the canonical version always wins, but we don't want to churn
 *    mtimes (or log lines) when nothing actually changed.
 *
 * Parent directories are created as needed.
 */
export function writeTemplates(targets: WriteTarget[]): WriteResult[] {
  return targets.map((target) => writeOne(target));
}

function writeOne({ targetPath, content, policy }: WriteTarget): WriteResult {
  const exists = existsSync(targetPath);

  if (policy === "skip-if-exists") {
    if (exists) {
      return { targetPath, outcome: "skipped" };
    }
    writeWithMkdir(targetPath, content);
    return { targetPath, outcome: "created" };
  }

  if (!exists) {
    writeWithMkdir(targetPath, content);
    return { targetPath, outcome: "created" };
  }

  const current = readFileSync(targetPath, "utf8");
  if (current === content) {
    return { targetPath, outcome: "unchanged" };
  }
  writeFileSync(targetPath, content);
  return { targetPath, outcome: "overwritten" };
}

function writeWithMkdir(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
}
