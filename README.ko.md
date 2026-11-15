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
  <a href="https://github.com/KRFOSS/opencode/actions/workflows/release-fork.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/KRFOSS/opencode/release-fork.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![OpenCode Terminal UI](services/site/public/v1/docs/assets/lander/screenshot.png)](https://opencode.ai)

---

### 설치

```bash
# 최신 CLI 릴리스 설치 (Linux)
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash

# Nix로 소스에서 실행
nix run github:KRFOSS/opencode/dev

# Nix로 소스에서 설치
nix profile add github:KRFOSS/opencode/dev
```

[release-fork 워크플로](.github/workflows/release-fork.yml)는 CLI 바이너리,
`install.sh`, `SHA256SUMS`를 [GitHub Releases](https://github.com/KRFOSS/opencode/releases)에 배포합니다.
Linux(`opencode-linux-*.tar.gz`), Windows(`opencode-windows-*.zip`)용 압축 파일을
직접 다운로드할 수도 있습니다. macOS 릴리스 빌드는 일시적으로 중단했습니다.

특정 릴리스를 설치하려면 다음과 같이 실행하세요.

```bash
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash -s -- --version v2.3.0-krfoss.1
```

#### 설치 디렉터리

설치 스크립트는 OpenCode를 `$HOME/.opencode/bin`에 설치합니다. `--dir <path>`로 경로를 변경할 수 있습니다.

### 데스크톱 앱

이 포크의 릴리스 워크플로는 현재 CLI만 배포합니다. 데스크톱 앱은 소스에서 빌드할 수 있습니다.

```bash
nix build github:KRFOSS/opencode/dev#opencode-desktop
```

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
