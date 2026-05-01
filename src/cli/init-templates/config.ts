// The only required field is `linear.team`. Everything else is optional
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
  //     // { hostPath: "/Users/me/.aws", sandboxPath: "/root/.aws", readOnly: true },
  //   ],
  // },

  // Optional. Commands to run inside the sandbox once it is ready.
  // hooks: {
  //   onSandboxReady: [
  //     // { command: "bun install" },
  //   ],
  // },
};
