import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, type SetupLabelsFn } from "./setup.ts";
import {
  SETUP_LABEL_NAMES,
  type LinearContext,
  type SetupLabelResult,
} from "../linear/index.ts";

interface Sinks {
  stdout: string[];
  stderr: string[];
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
}

function makeSinks(): Sinks {
  const sinks: Sinks = {
    stdout: [],
    stderr: [],
    pushStdout: () => undefined,
    pushStderr: () => undefined,
  };
  sinks.pushStdout = (s: string) => {
    sinks.stdout.push(s);
  };
  sinks.pushStderr = (s: string) => {
    sinks.stderr.push(s);
  };
  return sinks;
}

interface SetupLabelsCapture {
  ctx: LinearContext | null;
  callCount: number;
}

function buildSetupLabels(
  results: SetupLabelResult[],
  capture: SetupLabelsCapture
): SetupLabelsFn {
  return (ctx) => {
    capture.callCount += 1;
    capture.ctx = ctx;
    return Promise.resolve(results);
  };
}

describe("tide setup", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-setup-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeValidEnv(): void {
    writeFileSync(
      join(tideDir, ".env"),
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n"
    );
  }

  function writeValidConfig(): void {
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
  }

  test("on a fresh team, creates all three labels and exits zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const results: SetupLabelResult[] = SETUP_LABEL_NAMES.map((name) => ({
      name,
      created: true,
    }));

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels(results, capture),
    });

    expect(code).toBe(0);
    expect(capture.callCount).toBe(1);
    expect(capture.ctx?.apiKey).toBe("lk");
    expect(capture.ctx?.teamKey).toBe("ENG");

    const out = sinks.stdout.join("");
    expect(out).toContain("ENG");
    expect(out).toContain("created");
    for (const name of SETUP_LABEL_NAMES) expect(out).toContain(name);
    expect(out).toContain("created 3 label(s)");
  });

  test("on a fully provisioned team, reports nothing-to-do and exits zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const results: SetupLabelResult[] = SETUP_LABEL_NAMES.map((name) => ({
      name,
      created: false,
    }));

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels(results, capture),
    });

    expect(code).toBe(0);
    const out = sinks.stdout.join("");
    expect(out).toContain("already present");
    expect(out).toContain("nothing to do");
  });

  test("partial pre-existing: reports both created and already-present sections", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const results: SetupLabelResult[] = [
      { name: "prd", created: false },
      { name: "ready-for-agent", created: true },
      { name: "ready-for-human", created: true },
    ];

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels(results, capture),
    });

    expect(code).toBe(0);
    const out = sinks.stdout.join("");
    expect(out).toContain("created:");
    expect(out).toContain("already present:");
    expect(out).toContain("ready-for-agent");
    expect(out).toContain("ready-for-human");
    expect(out).toContain("prd");
  });

  test("missing .tide/.env yields non-zero exit and a clear hint", async () => {
    writeValidConfig();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels([], capture),
    });

    expect(code).toBe(1);
    expect(capture.callCount).toBe(0);
    expect(sinks.stderr.join("")).toContain("env file not found");
  });

  test("missing LINEAR_API_KEY yields non-zero exit and names the key", async () => {
    writeFileSync(join(tideDir, ".env"), "ANTHROPIC_API_KEY=ak\n");
    writeValidConfig();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels([], capture),
    });

    expect(code).toBe(1);
    expect(capture.callCount).toBe(0);
    expect(sinks.stderr.join("")).toContain("LINEAR_API_KEY");
  });

  test("missing .tide/config.ts yields non-zero exit", async () => {
    writeValidEnv();
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: buildSetupLabels([], capture),
    });

    expect(code).toBe(1);
    expect(capture.callCount).toBe(0);
    expect(sinks.stderr.join("")).toContain("config file not found");
  });

  test("Linear setupLabels failure surfaces a clear error and non-zero exit", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const setupLabelsFn: SetupLabelsFn = () =>
      Promise.reject(new Error("invalid api key"));

    const code = await setup({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      setupLabels: setupLabelsFn,
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("invalid api key");
  });

  test("invoked outside any git repo errors clearly without a stack trace", async () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });
    const sinks = makeSinks();
    const capture: SetupLabelsCapture = { ctx: null, callCount: 0 };

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(lonely);
      code = await setup({
        stdout: sinks.pushStdout,
        stderr: sinks.pushStderr,
        setupLabels: buildSetupLabels([], capture),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(1);
    expect(capture.callCount).toBe(0);
    expect(sinks.stderr.join("")).toContain("not inside a git repository");
  });
});
