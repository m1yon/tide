import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRepoRoot } from "../repo-discovery/index.ts";

/**
 * Files that `tide init` writes into `.tide/`. The order is the order
 * we report missing/conflicting files in error output.
 */
const TARGET_FILES = [
  "config.ts",
  "Dockerfile",
  "prompt.md",
  ".env.example",
  ".gitignore",
] as const;

type TargetFile = (typeof TARGET_FILES)[number];

const CONFIG_TS_TEMPLATE = `// The only required field is \`linear.team\`. Everything else is optional
// with sensible defaults. See https://github.com/m1yon/tide for the full
// schema (validated by tide via Zod at load time).

export default {
  linear: {
    // Linear team key (the prefix Linear assigns to issues, e.g. "ENG").
    team: "REPLACE_ME",
  },

  // Optional. Bind-mount host paths into the docker sandbox.
  // sandbox: {
  //   mounts: [
  //     // { hostPath: "/Users/me/.aws", containerPath: "/root/.aws", readOnly: true },
  //   ],
  // },

  // Optional. Commands to run inside the sandbox once it is ready.
  // hooks: {
  //   onSandboxReady: [
  //     // { command: "bun install" },
  //   ],
  // },
};
`;

const DOCKERFILE_TEMPLATE = `# Minimal tide sandbox image.
# Customize for the repo's stack (add language toolchains, package managers,
# project-specific binaries, etc.). The build context is the repo root, so
# any path relative to the repo is COPYable here.

FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    git \\
    gnupg \\
    unzip \\
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \\
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
      > /etc/apt/sources.list.d/github-cli.list \\
 && apt-get update && apt-get install -y --no-install-recommends gh \\
 && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash \\
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Claude Code CLI (installed via Bun's npm-compatible registry).
RUN bun install -g @anthropic-ai/claude-code \\
 && ln -s /root/.bun/install/global/node_modules/.bin/claude /usr/local/bin/claude

WORKDIR /workspace

CMD ["bash"]
`;

const PROMPT_MD_TEMPLATE = `You are working on GitHub issue {{ISSUE_ID}} in the parent PRD {{PARENT_ID}}.

Branch: {{BRANCH}}

## Issue: {{ISSUE_TITLE}}

{{ISSUE_CONTENT}}

## Parent PRD

{{PRD_CONTENT}}

## Instructions

1. Read the issue and the parent PRD carefully.
2. Implement the changes required by this issue (and only this issue).
3. Run the project's test and lint commands; both must pass.
4. Commit with a conventional message ending in \`(fixes #{{ISSUE_ID}})\`.
5. Close the issue with a comment that links to your commit.
`;

const ENV_EXAMPLE_TEMPLATE = `# Required by the host CLI (consumed by tide; NOT forwarded into the sandbox).
LINEAR_API_KEY=

# Required inside the sandbox (forwarded by tide to the docker provider).
ANTHROPIC_API_KEY=

# --- Repo-specific keys ---
# Add any environment variables your sandbox needs below. Everything in this
# file (except LINEAR_API_KEY) is forwarded into the docker sandbox.
# AWS_PROFILE=
# AWS_REGION=
`;

const GITIGNORE_TEMPLATE = `.env
worktrees/
logs/
`;

const TEMPLATES: Record<TargetFile, string> = {
  "config.ts": CONFIG_TS_TEMPLATE,
  Dockerfile: DOCKERFILE_TEMPLATE,
  "prompt.md": PROMPT_MD_TEMPLATE,
  ".env.example": ENV_EXAMPLE_TEMPLATE,
  ".gitignore": GITIGNORE_TEMPLATE,
};

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
  for (const name of TARGET_FILES) {
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
  for (const name of TARGET_FILES) {
    writeFileSync(join(tideDir, name), TEMPLATES[name]);
  }

  stdout(`tide: scaffolded .tide/ at ${repoRoot}\n`);
  stdout(`  next steps:\n`);
  stdout(`    1. set linear.team in .tide/config.ts\n`);
  stdout(`    2. copy .tide/.env.example to .tide/.env and fill in keys\n`);
  stdout(`    3. customize .tide/Dockerfile and .tide/prompt.md\n`);
  return 0;
}
