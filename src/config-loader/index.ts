import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Mount descriptor matching @ai-hero/sandcastle's `MountConfig`.
 * Kept duplicated here (rather than importing from sandcastle) so config-loader
 * can be unit-tested without pulling the SDK into the test graph.
 */
const MountConfigSchema = z.strictObject({
  hostPath: z.string().min(1),
  sandboxPath: z.string().min(1),
  readonly: z.boolean().optional(),
});

const HookSchema = z.strictObject({
  command: z.string().min(1),
});

/**
 * The Zod schema for `<repoRoot>/.tide/config.ts`.
 *
 * Only `linear.team` is required. `sandbox.mounts` and `hooks.onSandboxReady`
 * default to empty arrays. `env` is intentionally rejected to prevent the
 * host-vs-sandbox split-brain documented in the PRD.
 */
export const TideConfigSchema = z
  .strictObject({
    linear: z.strictObject({
      team: z.string().min(1),
    }),
    sandbox: z
      .strictObject({
        mounts: z.array(MountConfigSchema).optional().default([]),
      })
      .optional()
      .default({ mounts: [] }),
    hooks: z
      .strictObject({
        onSandboxReady: z.array(HookSchema).optional().default([]),
      })
      .optional()
      .default({ onSandboxReady: [] }),
  })
  .transform((cfg) => ({
    linear: cfg.linear,
    sandbox: { mounts: cfg.sandbox.mounts },
    hooks: { onSandboxReady: cfg.hooks.onSandboxReady },
  }));

export type TideConfig = z.infer<typeof TideConfigSchema>;

export interface LoadConfigOptions {
  /** Repo root containing `.tide/config.ts`. */
  repoRoot: string;
}

/**
 * Dynamically imports `<repoRoot>/.tide/config.ts`, validates with Zod,
 * and returns the parsed config. Throws when the file is missing, the
 * import fails, the default export is missing, or Zod rejects.
 */
export async function loadConfig(
  options: LoadConfigOptions
): Promise<TideConfig> {
  const configPath = join(options.repoRoot, ".tide", "config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`tide: config file not found at ${configPath}`);
  }

  // Bun supports runtime dynamic import() of arbitrary .ts files on disk,
  // including from a compiled binary. We use a file:// URL so absolute paths
  // on every platform import correctly.
  const url = pathToFileURL(configPath).href;
  const mod: unknown = await import(url);

  let raw: unknown = undefined;
  if (mod !== null && typeof mod === "object" && "default" in mod) {
    raw = (mod as Record<"default", unknown>).default;
  }

  if (raw === undefined) {
    throw new Error(
      `tide: ${configPath} has no default export. Use \`export default { ... }\`.`
    );
  }

  return TideConfigSchema.parse(raw);
}
