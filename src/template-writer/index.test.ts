import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTemplates, type WriteTarget } from "./index.ts";

describe("template-writer", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "template-writer-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("policy: skip-if-exists", () => {
    test("missing target → created (file written)", () => {
      const target = join(workDir, "a", "b", "config.ts");
      const targets: WriteTarget[] = [
        { targetPath: target, content: "hello\n", policy: "skip-if-exists" },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "created" }]);
      expect(readFileSync(target, "utf8")).toBe("hello\n");
    });

    test("existing target with different content → skipped (no write)", () => {
      const target = join(workDir, "config.ts");
      writeFileSync(target, "user content\n");
      const targets: WriteTarget[] = [
        {
          targetPath: target,
          content: "template content\n",
          policy: "skip-if-exists",
        },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "skipped" }]);
      expect(readFileSync(target, "utf8")).toBe("user content\n");
    });

    test("existing target with identical content → skipped (no write)", () => {
      const target = join(workDir, "config.ts");
      writeFileSync(target, "same\n");
      const targets: WriteTarget[] = [
        { targetPath: target, content: "same\n", policy: "skip-if-exists" },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "skipped" }]);
    });
  });

  describe("policy: overwrite-silent-if-identical", () => {
    test("missing target → created (file written)", () => {
      const target = join(workDir, "skills", "tide-to-prd", "SKILL.md");
      const targets: WriteTarget[] = [
        {
          targetPath: target,
          content: "skill body\n",
          policy: "overwrite-silent-if-identical",
        },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "created" }]);
      expect(readFileSync(target, "utf8")).toBe("skill body\n");
    });

    test("existing identical content → unchanged (no write, mtime preserved)", async () => {
      const target = join(workDir, "SKILL.md");
      writeFileSync(target, "identical\n");
      const before = statSync(target).mtimeMs;
      // Wait a bit so any write would change mtime measurably.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const targets: WriteTarget[] = [
        {
          targetPath: target,
          content: "identical\n",
          policy: "overwrite-silent-if-identical",
        },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "unchanged" }]);
      const after = statSync(target).mtimeMs;
      expect(after).toBe(before);
    });

    test("existing different content → overwritten (file rewritten)", () => {
      const target = join(workDir, "SKILL.md");
      writeFileSync(target, "user edits\n");
      const targets: WriteTarget[] = [
        {
          targetPath: target,
          content: "canonical\n",
          policy: "overwrite-silent-if-identical",
        },
      ];

      const results = writeTemplates(targets);

      expect(results).toEqual([{ targetPath: target, outcome: "overwritten" }]);
      expect(readFileSync(target, "utf8")).toBe("canonical\n");
    });
  });

  test("creates parent directories as needed", () => {
    const target = join(workDir, "deep", "nested", "path", "file.txt");
    expect(existsSync(join(workDir, "deep"))).toBe(false);

    const results = writeTemplates([
      { targetPath: target, content: "x", policy: "skip-if-exists" },
    ]);

    expect(results[0]?.outcome).toBe("created");
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("processes multiple targets in input order", () => {
    const a = join(workDir, "a.txt");
    const b = join(workDir, "b.txt");
    writeFileSync(b, "existing\n");
    const c = join(workDir, "c.txt");
    writeFileSync(c, "same\n");

    const results = writeTemplates([
      { targetPath: a, content: "new\n", policy: "skip-if-exists" },
      { targetPath: b, content: "would-overwrite\n", policy: "skip-if-exists" },
      {
        targetPath: c,
        content: "same\n",
        policy: "overwrite-silent-if-identical",
      },
    ]);

    expect(results).toEqual([
      { targetPath: a, outcome: "created" },
      { targetPath: b, outcome: "skipped" },
      { targetPath: c, outcome: "unchanged" },
    ]);
  });
});
