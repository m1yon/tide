import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withTempRepo } from "./with-temp-repo.ts";

describe("withTempRepo", () => {
  test("creates a temp directory containing an initialised git repo", async () => {
    let captured = "";
    await withTempRepo((repoRoot) => {
      captured = repoRoot;
      expect(existsSync(repoRoot)).toBe(true);
      expect(statSync(repoRoot).isDirectory()).toBe(true);
      expect(existsSync(join(repoRoot, ".git"))).toBe(true);
      return Promise.resolve();
    });
    // Cleanup happened after the callback returned.
    expect(captured).not.toBe("");
    expect(existsSync(captured)).toBe(false);
  });

  test("makes an initial commit on the default branch", async () => {
    await withTempRepo((repoRoot) => {
      const log = spawnSync("git", ["-C", repoRoot, "log", "--oneline"], {
        encoding: "utf8",
      });
      expect(log.status).toBe(0);
      expect(log.stdout.trim().length).toBeGreaterThan(0);
      return Promise.resolve();
    });
  });

  test("cleans up the temp directory when the callback throws", async () => {
    let captured = "";
    const boom = new Error("boom");
    let caught: unknown;
    try {
      await withTempRepo((repoRoot) => {
        captured = repoRoot;
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(captured).not.toBe("");
    expect(existsSync(captured)).toBe(false);
  });

  test("forwards the callback's return value", async () => {
    const result = await withTempRepo((repoRoot) =>
      Promise.resolve(repoRoot.length)
    );
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });
});
