# Minimal tide sandbox image.
# Customize for the repo's stack (add language toolchains, package managers,
# project-specific binaries, etc.). The build context is the repo root, so
# any path relative to the repo is COPYable here.

FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    unzip \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Claude Code CLI (installed via Bun's npm-compatible registry).
RUN bun install -g @anthropic-ai/claude-code \
 && ln -s /root/.bun/install/global/node_modules/.bin/claude /usr/local/bin/claude

WORKDIR /workspace

CMD ["bash"]
