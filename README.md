<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset=".github/assets/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://github.com/KRFOSS/opencode/actions/workflows/release-fork.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/KRFOSS/opencode/release-fork.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![OpenCode Terminal UI](services/site/public/v1/docs/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# Install the latest CLI release (Linux / macOS)
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash

# Run from source with Nix
nix run github:KRFOSS/opencode/dev

# Install from source with Nix
nix profile add github:KRFOSS/opencode/dev
```

The [release-fork workflow](.github/workflows/release-fork.yml) publishes CLI binaries,
`install.sh`, and `SHA256SUMS` to [GitHub Releases](https://github.com/KRFOSS/opencode/releases).
Download an archive directly for Linux (`opencode-linux-*.tar.gz`), macOS
(`opencode-darwin-*.zip`), or Windows (`opencode-windows-*.zip`).

To install a specific release:

```bash
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash -s -- --version v2.3.0-krfoss.1
```

#### Installation Directory

The install script installs OpenCode to `$HOME/.opencode/bin`. Use `--dir <path>` to change it.

### Desktop App

This fork's release workflow currently publishes the CLI only. To build the desktop app from source:

```bash
nix build github:KRFOSS/opencode/dev#opencode-desktop
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
