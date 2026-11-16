<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset=".github/assets/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">오픈 소스 AI 코딩 에이전트.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/release.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![OpenCode Terminal UI](services/site/public/v1/docs/assets/lander/screenshot.png)](https://opencode.ai)

---

### 설치

이 저장소의 CLI는 [GitHub Releases](https://github.com/KRFOSS/opencode/releases)에서 설치할 수 있습니다.

```bash
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash
```

설치 스크립트는 플랫폼에 맞는 바이너리를 선택하고 기본적으로 `$HOME/.opencode/bin`에 설치합니다. Windows에서는 Git Bash 또는 MSYS2에서 실행하거나 릴리즈의 ZIP 파일을 직접 다운로드하여 압축을 푸세요.

| 플랫폼 | 다운로드 |
| --- | --- |
| Linux x64 (glibc) | `opencode-linux-x64.tar.gz` |
| Linux x64 (glibc, baseline) | `opencode-linux-x64-baseline.tar.gz` |
| Linux ARM64 (glibc) | `opencode-linux-arm64.tar.gz` |
| Linux x64 (musl) | `opencode-linux-x64-musl.tar.gz` |
| Linux x64 (musl, baseline) | `opencode-linux-x64-baseline-musl.tar.gz` |
| Linux ARM64 (musl) | `opencode-linux-arm64-musl.tar.gz` |
| Windows x64 | `opencode-windows-x64.zip` |
| Windows x64 (baseline) | `opencode-windows-x64-baseline.zip` |
| Windows ARM64 | `opencode-windows-arm64.zip` |

`baseline`은 AVX2를 지원하지 않는 x64 CPU용이며, `musl`은 Alpine Linux 등 musl 기반 환경용입니다. 현재 포크 릴리즈 워크플로는 Linux와 Windows CLI를 배포합니다.

```bash
# Nix로 실행
nix run github:KRFOSS/opencode/dev#opencode

# Nix 프로필에 설치
nix profile install github:KRFOSS/opencode/dev#opencode
```

Nix flake는 Linux x64·ARM64와 macOS Apple Silicon을 대상으로 합니다.

### 소스에서 실행

이 저장소의 버전을 실행하려면 저장소를 복제한 뒤 Bun으로 워크스페이스 의존성을 설치하세요. [package.json](./package.json)의 `packageManager`에 지정된 Bun 버전 이상이 필요합니다. 원본 프로젝트의 설치 스크립트와 배포 패키지는 원본 버전을 설치합니다.

```bash
git clone --branch dev https://github.com/KRFOSS/opencode.git
cd opencode
bun install
bun run dev .
```

명령어는 저장소 루트에서 실행하세요. 다른 프로젝트를 열려면 `.` 대신 프로젝트 경로를 전달하세요. 개발 TUI를 설치된 OpenCode 백그라운드 서버와 실행 중인 세션에 연결하려면 `bun run dev:live .`을 사용하세요.

```bash
# 저장소 린트 및 타입 검사
bun run check

# 테스트는 대상 패키지 디렉터리에서 실행
cd packages/core
bun run test
```

### 데스크톱 앱 (BETA)

의존성을 설치한 뒤 저장소 루트에서 이 저장소의 데스크톱 앱을 실행하세요.

```bash
bun run dev:desktop
```

Nix로 데스크톱 앱을 실행할 수도 있습니다.

```bash
nix run github:KRFOSS/opencode/dev#opencode-desktop
```

원본 프로젝트의 데스크톱 배포판은 [opencode.ai/download](https://opencode.ai/download)에서 받을 수 있습니다.

### Agents

OpenCode 에는 내장 에이전트 2개가 있으며 `Tab` 키로 전환할 수 있습니다.

- **build** - 기본값, 개발 작업을 위한 전체 권한 에이전트
- **plan** - 분석 및 코드 탐색을 위한 읽기 전용 에이전트
  - 기본적으로 파일 편집을 거부
  - bash 명령 실행 전에 권한을 요청
  - 낯선 코드베이스를 탐색하거나 변경을 계획할 때 적합

또한 복잡한 검색과 여러 단계 작업을 위한 **general** 서브 에이전트가 포함되어 있습니다.
내부적으로 사용되며, 메시지에서 `@general` 로 호출할 수 있습니다.

[agents](https://opencode.ai/docs/agents) 에 대해 더 알아보세요.

### 문서

OpenCode 설정에 대한 자세한 내용은 [**문서**](https://opencode.ai/docs) 를 참고하세요.

### 기여하기

OpenCode 에 기여하고 싶다면, Pull Request 를 제출하기 전에 [contributing docs](./CONTRIBUTING.md) 를 읽어주세요.

### OpenCode 기반으로 만들기

OpenCode 와 관련된 프로젝트를 진행하면서 이름에 "opencode"(예: "opencode-dashboard" 또는 "opencode-mobile") 를 포함한다면, README 에 해당 프로젝트가 OpenCode 팀이 만든 것이 아니며 어떤 방식으로도 우리와 제휴되어 있지 않다는 점을 명시해 주세요.

---

**커뮤니티에 참여하기** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
