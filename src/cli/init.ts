import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRepoRoot } from "../repo-discovery/index.ts";
// `config.ts` is loaded as text by Bun, but TypeScript resolves the real
// file's exports — hence the cast. The other four templates have no
// TS-resolvable extension, so the ambient decls in `init-templates.d.ts`
// type them as `string` directly.
import configTsRaw from "./init-templates/config.ts" with { type: "text" };
import dockerfile from "./init-templates/Dockerfile" with { type: "text" };
import promptMd from "./init-templates/prompt.md" with { type: "text" };
import envExample from "./init-templates/.env.example" with { type: "text" };
import gitignore from "./init-templates/.gitignore" with { type: "text" };

const configTs = configTsRaw as unknown as string;

/**
 * Files that `tide init` writes into `.tide/`. Iteration order is the order
 * we report missing/conflicting files in error output.
 */
const TARGETS = [
  { name: "config.ts", content: configTs },
  { name: "Dockerfile", content: dockerfile },
  { name: "prompt.md", content: promptMd },
  { name: ".env.example", content: envExample },
  { name: ".gitignore", content: gitignore },
] as const;

export interface InitOptions {
  /** Repo root override (used by tests). Defaults to repo-discovery from cwd. */
  repoRoot?: string;
  /** I/O sinks. Default to process.stdout / process.stderr. */
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

/**
 * Scaffolds a `.tide/` directory at the discovered (or supplied) repo root.
 * Refuses and returns a non-zero exit code if any of the target files
 * already exist.
 */
export function init(options: InitOptions = {}): number {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  const tideDir = join(repoRoot, ".tide");
  const existing: string[] = [];
  for (const { name } of TARGETS) {
    if (existsSync(join(tideDir, name))) {
      existing.push(`.tide/${name}`);
    }
  }

  if (existing.length > 0) {
    stderr(
      `tide init: refusing to overwrite existing file(s):\n${existing.map((f) => `  - ${f}`).join("\n")}\n`
    );
    return 1;
  }

  mkdirSync(tideDir, { recursive: true });
  for (const { name, content } of TARGETS) {
    writeFileSync(join(tideDir, name), content);
  }

  stdout(`tide: scaffolded .tide/ at ${repoRoot}\n`);
  stdout(`  next steps:\n`);
  stdout(`    1. set linear.team in .tide/config.ts\n`);
  stdout(`    2. copy .tide/.env.example to .tide/.env and fill in keys\n`);
  stdout(`    3. customize .tide/Dockerfile and .tide/prompt.md\n`);
  return 0;
}
