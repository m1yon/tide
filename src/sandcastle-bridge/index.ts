// Sandcastle bridge — host-side filesystem module owning the lifecycle of the
// runtime symlink at `<repoRoot>/.sandcastle` → `.tide/`. Sandcastle hardcodes
// `.sandcastle/{worktrees,logs}/` for its own writes; tide's convention is
// `.tide/`. The symlink redirects sandcastle's writes into the tide-shaped
// place so worktree paths line up across runs.
//
// Six on-disk shapes are recognised. Only "missing" and "intact" are safe;
// the other four silently break subsequent `tide run` invocations at the
// PR-submission step's worktree-collision check. Setup repairs after explicit
// confirmation; doctor detects only.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const SANDCASTLE_DIR_NAME = ".sandcastle";
const TIDE_DIR_NAME = ".tide";
/** Relative target so the repo can be moved without breaking the link. */
const SYMLINK_TARGET = TIDE_DIR_NAME;

export type BridgeState =
  | { kind: "missing" }
  | { kind: "intact" }
  | { kind: "wrong-symlink-target"; target: string }
  | { kind: "real-dir-empty" }
  | { kind: "real-dir-with-content"; entries: string[] }
  | { kind: "regular-file" };

/**
 * Classify the on-disk shape of `<repoRoot>/.sandcastle`. Pure inspection —
 * never modifies the filesystem.
 */
export function classifyBridge(repoRoot: string): BridgeState {
  const bridgePath = path.join(repoRoot, SANDCASTLE_DIR_NAME);
  let stat;
  try {
    stat = lstatSync(bridgePath);
  } catch {
    return { kind: "missing" };
  }

  if (stat.isSymbolicLink()) {
    const target = readlinkSync(bridgePath);
    if (target === SYMLINK_TARGET) return { kind: "intact" };
    return { kind: "wrong-symlink-target", target };
  }

  if (stat.isDirectory()) {
    if (isTreeEmpty(bridgePath)) return { kind: "real-dir-empty" };
    return {
      kind: "real-dir-with-content",
      entries: readdirSync(bridgePath),
    };
  }

  return { kind: "regular-file" };
}

/**
 * Walks the tree under `p` and returns true if it contains no non-directory
 * entries at any depth. Captures the user-incident shape: a real `.sandcastle/`
 * directory with empty `worktrees/` and `logs/` subdirectories, residue of a
 * mid-run bridge break.
 */
function isTreeEmpty(p: string): boolean {
  const entries = readdirSync(p, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) return false;
    if (!isTreeEmpty(path.join(p, e.name))) return false;
  }
  return true;
}

function ensureTideDir(repoRoot: string): void {
  const tideDir = path.join(repoRoot, TIDE_DIR_NAME);
  if (!existsSync(tideDir)) {
    mkdirSync(tideDir, { recursive: true });
  }
}

function createSymlink(repoRoot: string): void {
  ensureTideDir(repoRoot);
  symlinkSync(SYMLINK_TARGET, path.join(repoRoot, SANDCASTLE_DIR_NAME), "dir");
}

/**
 * Destructively repair the bridge from any of the four broken states. The
 * caller must confirm-gate first — passing `intact` or `missing` throws.
 */
export function repairBridge(repoRoot: string, state: BridgeState): void {
  const bridgePath = path.join(repoRoot, SANDCASTLE_DIR_NAME);
  switch (state.kind) {
    case "intact":
      throw new Error(
        "repairBridge: bridge is already intact — caller must confirm-gate first"
      );
    case "missing":
      throw new Error(
        "repairBridge: bridge is missing — caller must confirm-gate first"
      );
    case "wrong-symlink-target":
      unlinkSync(bridgePath);
      createSymlink(repoRoot);
      return;
    case "real-dir-empty":
      rmSync(bridgePath, { recursive: true });
      createSymlink(repoRoot);
      return;
    case "real-dir-with-content":
      rmSync(bridgePath, { recursive: true, force: true });
      createSymlink(repoRoot);
      return;
    case "regular-file":
      unlinkSync(bridgePath);
      createSymlink(repoRoot);
      return;
  }
}

/**
 * Human-readable summary of the bridge state. Used by setup's confirm prompt
 * (so the user knows what is about to be deleted) and by doctor's FAIL hint.
 */
export function describeBridgeForUser(state: BridgeState): string {
  switch (state.kind) {
    case "missing":
      return "Sandcastle bridge: missing — no .sandcastle entry at repo root.";
    case "intact":
      return "Sandcastle bridge: intact (.sandcastle → .tide).";
    case "wrong-symlink-target":
      return `Sandcastle bridge: symlink at .sandcastle points at "${state.target}" instead of ".tide".`;
    case "real-dir-empty":
      return "Sandcastle bridge: real directory at .sandcastle/ (empty — only empty subdirectories).";
    case "real-dir-with-content":
      return `Sandcastle bridge: real directory at .sandcastle/ containing: ${state.entries.join(", ")}.`;
    case "regular-file":
      return "Sandcastle bridge: regular file at .sandcastle (expected a symlink).";
  }
}

/**
 * Residual `tide run` safety net: creates the symlink only when the bridge is
 * `missing`, no-ops when `intact`, throws on every other state with a hint to
 * run `tide setup`. Replaces the prior silent-bail behavior — a broken bridge
 * at run time fails fast rather than crashing later at the PR-submission
 * worktree-collision check.
 */
export function createBridgeIfMissing(repoRoot: string): void {
  const state = classifyBridge(repoRoot);
  switch (state.kind) {
    case "intact":
      return;
    case "missing":
      createSymlink(repoRoot);
      return;
    case "wrong-symlink-target":
    case "real-dir-empty":
    case "real-dir-with-content":
    case "regular-file":
      throw new Error(
        `${describeBridgeForUser(state)} Run \`tide setup\` to repair.`
      );
  }
}
