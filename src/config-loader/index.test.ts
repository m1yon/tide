import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig, TideConfigSchema } from "./index.ts";

describe("config-loader", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-config-loader-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeConfig(source: string): void {
    writeFileSync(join(tideDir, "config.ts"), source);
  }

  test("valid minimal config (only linear.team) parses with empty defaults", async () => {
    writeConfig(`export default { linear: { team: "ENG" } };\n`);

    const cfg = await loadConfig({ repoRoot });

    expect(cfg.linear.team).toBe("ENG");
    expect(cfg.sandbox.mounts).toEqual([]);
    expect(cfg.hooks.onSandboxReady).toEqual([]);
  });

  test("valid full config parses unchanged", async () => {
    writeConfig(`
      export default {
        linear: { team: "ENG" },
        sandbox: {
          mounts: [
            { hostPath: "/h", sandboxPath: "/s", readonly: true },
          ],
        },
        hooks: {
          onSandboxReady: [
            { command: "bun install" },
            { command: "task setup" },
          ],
        },
      };
    `);

    const cfg = await loadConfig({ repoRoot });

    expect(cfg.linear.team).toBe("ENG");
    expect(cfg.sandbox.mounts).toEqual([
      { hostPath: "/h", sandboxPath: "/s", readonly: true },
    ]);
    expect(cfg.hooks.onSandboxReady).toEqual([
      { command: "bun install" },
      { command: "task setup" },
    ]);
  });

  test("missing linear.team yields a Zod error referencing the path", () => {
    const err = (() => {
      try {
        TideConfigSchema.parse({ linear: {} });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(z.ZodError);
    const issues = (err as z.ZodError).issues;
    expect(issues.some((i) => i.path.join(".") === "linear.team")).toBe(true);
  });

  test("missing linear key entirely yields a Zod error", () => {
    expect(() => TideConfigSchema.parse({})).toThrow(z.ZodError);
  });

  test("malformed mounts (missing hostPath) yields a Zod error", () => {
    const err = (() => {
      try {
        TideConfigSchema.parse({
          linear: { team: "ENG" },
          sandbox: { mounts: [{ sandboxPath: "/s" }] },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(z.ZodError);
    const paths = (err as z.ZodError).issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("mounts"))).toBe(true);
  });

  test("presence of an `env` field yields a Zod error (split-brain prevention)", () => {
    const err = (() => {
      try {
        TideConfigSchema.parse({
          linear: { team: "ENG" },
          env: { FOO: "bar" },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(z.ZodError);
  });

  test("missing config file yields a clear error", async () => {
    // No file written.
    let caught: unknown = null;
    try {
      await loadConfig({ repoRoot });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("config file not found");
  });

  test("config without a default export yields a clear error", async () => {
    writeConfig(`export const x = 1;\n`);

    let caught: unknown = null;
    try {
      await loadConfig({ repoRoot });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("no default export");
  });

  test("hook entry with empty command is rejected", () => {
    expect(() =>
      TideConfigSchema.parse({
        linear: { team: "ENG" },
        hooks: { onSandboxReady: [{ command: "" }] },
      })
    ).toThrow(z.ZodError);
  });
});
