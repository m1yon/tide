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
 * Creates any missing target files; existing files are left untouched.
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
  mkdirSync(tideDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  for (const { name, content } of TARGETS) {
    const path = join(tideDir, name);
    if (existsSync(path)) {
      skipped.push(`.tide/${name}`);
      continue;
    }
    writeFileSync(path, content);
    created.push(`.tide/${name}`);
  }

  if (created.length === 0) {
    stdout(`tide: .tide/ already scaffolded at ${repoRoot}; nothing to do\n`);
    return 0;
  }

  stdout(`tide: scaffolded .tide/ at ${repoRoot}\n`);
  if (created.length > 0) {
    stdout(`  created:\n`);
    for (const f of created) stdout(`    - ${f}\n`);
  }
  if (skipped.length > 0) {
    stdout(`  skipped (already exist):\n`);
    for (const f of skipped) stdout(`    - ${f}\n`);
  }
  stdout(`  next steps:\n`);
  stdout(`    1. set linear.team in .tide/config.ts\n`);
  stdout(`    2. copy .tide/.env.example to .tide/.env and fill in keys\n`);
  stdout(`    3. customize .tide/Dockerfile and .tide/prompt.md\n`);
  return 0;
}
