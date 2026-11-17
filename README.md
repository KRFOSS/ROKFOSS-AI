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
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/release.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![OpenCode Terminal UI](.github/assets/screenshot.png)](https://opencode.ai)

---

### Installation

Install this repository's CLI from [GitHub Releases](https://github.com/KRFOSS/opencode/releases).

```bash
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash
```

The installer selects the binary for your platform and installs it to `$HOME/.opencode/bin` by default. On Windows, run it in Git Bash or MSYS2, or download and extract a ZIP from the release assets.

| Platform                    | Download                                  |
| --------------------------- | ----------------------------------------- |
| Linux x64 (glibc)           | `opencode-linux-x64.tar.gz`               |
| Linux x64 (glibc, baseline) | `opencode-linux-x64-baseline.tar.gz`      |
| Linux x64 (musl)            | `opencode-linux-x64-musl.tar.gz`          |
| Linux x64 (musl, baseline)  | `opencode-linux-x64-baseline-musl.tar.gz` |
| Windows x64                 | `opencode-windows-x64.zip`                |
| Windows x64 (baseline)      | `opencode-windows-x64-baseline.zip`       |

Use `baseline` for x64 CPUs without AVX2, and `musl` for musl-based systems such as Alpine Linux. The fork release workflow publishes Linux and Windows x86_64 CLI builds. ARM builds are not supported.

```bash
# Run with Nix
nix run github:KRFOSS/opencode/dev#opencode

# Install into your Nix profile
nix profile install github:KRFOSS/opencode/dev#opencode
```

The Nix flake targets Linux x86_64.

### Run from source

To run this repository's version, clone it and install its workspace dependencies with Bun. Use the Bun version specified in the `packageManager` field of [package.json](./package.json) or newer. The upstream install script and published packages install the upstream version.

```bash
git clone --branch dev https://github.com/KRFOSS/opencode.git
cd opencode
bun install
bun run dev .
```

Run commands from the repository root. Pass a project directory instead of `.` to open another project. To connect the development TUI to an installed OpenCode background server and its live sessions, use `bun run dev:live .`.

```bash
# Lint and type-check the repository
bun run check

# Run tests from the affected package directory
cd packages/core
bun run test
```

### Desktop App (BETA)

Run this repository's desktop application from the repository root after installing dependencies:

```bash
bun run dev:desktop
```

You can also run the desktop app with Nix:

```bash
nix run github:KRFOSS/opencode/dev#opencode-desktop
```

The upstream desktop releases are available at [opencode.ai/download](https://opencode.ai/download).

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
