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
  <a href="README.en.md">English</a> |
  <a href="README.md">한국어</a>
</p>

[![OpenCode Terminal UI](.github/assets/screenshot.png)](https://opencode.ai)

---

### 설치

이 저장소의 CLI는 [GitHub Releases](https://github.com/KRFOSS/opencode/releases)에서 설치할 수 있습니다.

```bash
curl -fsSL https://github.com/KRFOSS/opencode/releases/latest/download/install.sh | bash
```

설치 스크립트는 플랫폼에 맞는 바이너리를 선택하고 기본적으로 `$HOME/.opencode/bin`에 설치합니다. Windows에서는 Git Bash 또는 MSYS2에서 실행하거나 릴리즈의 ZIP 파일을 직접 다운로드하여 압축을 푸세요.

| 플랫폼                      | 다운로드                                  |
| --------------------------- | ----------------------------------------- |
| Linux x64 (glibc)           | `opencode-linux-x64.tar.gz`               |
| Linux x64 (glibc, baseline) | `opencode-linux-x64-baseline.tar.gz`      |
| Linux x64 (musl)            | `opencode-linux-x64-musl.tar.gz`          |
| Linux x64 (musl, baseline)  | `opencode-linux-x64-baseline-musl.tar.gz` |
| Windows x64                 | `opencode-windows-x64.zip`                |
| Windows x64 (baseline)      | `opencode-windows-x64-baseline.zip`       |

`baseline`은 AVX2를 지원하지 않는 x64 CPU용이며, `musl`은 Alpine Linux 등 musl 기반 환경용입니다. 포크 릴리즈 워크플로는 Linux와 Windows x86_64 CLI를 배포합니다. ARM 빌드는 지원하지 않습니다.

```bash
# Nix로 실행
nix run github:KRFOSS/opencode/dev#opencode

# Nix 프로필에 설치
nix profile install github:KRFOSS/opencode/dev#opencode
```

Nix flake는 Linux x86_64를 대상으로 합니다.

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

### ROKFOSS AI(RAI) 대화방 연동

ROKFOSS AI(RAI) 웹 앱의 대화방을 OpenCode 세션으로 열어 이어서 작업할 수 있습니다. 먼저 `/connect` 에서 **ROKFOSS AI** 를 고르고 RAI API 키를 넣으세요. 키는 ROKFOSS AI 웹 앱의 **설정 > RAI API** 에서 만듭니다.

#### 방 열기

`/rooms` 를 입력하면 프로젝트별 방 목록이 나옵니다.

| 키      | 동작                                           |
| ------- | ---------------------------------------------- |
| `Enter` | 고른 방을 보통 OpenCode 세션으로 엽니다        |
| `n`     | 새 방을 만들어 같은 방법으로 엽니다            |
| `b`     | 지금 열린 세션을 고른 방에 기록합니다          |
| `v`     | 고른 방을 예전 대화방 화면으로 엽니다          |

방을 처음 열면 방에 저장된 대화(사용자 글, 답, 추론) 중 최근 300개까지 가져와 새 세션을 만들고 그 방에 묶습니다. 같은 방을 다시 열면 같은 세션이 열립니다. 가져온 대화는 세션과 함께 내 컴퓨터의 OpenCode 저장소에 저장됩니다. 읽기 전용 방은 예전 대화방 화면으로 열립니다.

#### 묶인 세션에서 대화하기

- 보낸 글의 답은 지금 고른 모델로 OpenCode 가 직접 만듭니다. ROKFOSS AI 모델이든 OpenCode 무료 모델이든 같습니다.
- 글과 답은 RAI 대화방에 기록되어 웹에서도 실시간으로 보입니다.
- 세션을 열어 둔 동안 웹에서 그 방에 올라온 글과 답은 몇 초 안에 세션에 나타납니다.

#### RAI 대화방 도구

RAI API 키에 「대화방 도구」 권한을 켜면 방 세션에서 `rai_` 로 시작하는 도구를 쓸 수 있습니다. 권한은 **설정 > RAI API** 에서 켜며, 켤 때 패스키로 확인합니다.

- 그 방의 상자에서 셸 명령, 파일, 뒤에서 도는 작업, 결과 파일을 다룹니다.
- 미리 허용해 둔 통합시스템 도구를 씁니다.
- 웹의 AI 와 같은 상자를 쓰므로 웹과 OpenCode 사이에 파일이 엇갈리지 않습니다.
- 허가가 필요한 도구는 OpenCode 안의 권한 창에서 묻습니다.

#### 내 컴퓨터 도구 끄고 켜기

세션 화면에서 `ctrl+x o` 를 누르면 내 컴퓨터의 셸과 파일 도구를 바로 끄거나 켤 수 있습니다. 명령 팔레트의 「로컬 도구 끄기/켜기」로도 할 수 있습니다. 방의 상자에서만 작업하게 하려면 내 컴퓨터 도구를 꺼 두세요.

#### 필요한 키 권한

| 권한        | 필요한 때                                                        |
| ----------- | ---------------------------------------------------------------- |
| 대화방 읽기 | 방 목록을 보고, 방의 대화를 가져오고, 웹에서 올라온 글을 받을 때 |
| 대화방 쓰기 | 새 방을 만들고, 세션의 글과 답을 방에 기록할 때                  |
| 대화방 도구 | 방 세션에서 `rai_` 도구를 쓸 때 (켤 때 패스키 확인)              |

### 문서

OpenCode 설정에 대한 자세한 내용은 [**문서**](https://opencode.ai/docs) 를 참고하세요.

### 기여하기

OpenCode 에 기여하고 싶다면, Pull Request 를 제출하기 전에 [contributing docs](./CONTRIBUTING.md) 를 읽어주세요.

### OpenCode 기반으로 만들기

OpenCode 와 관련된 프로젝트를 진행하면서 이름에 "opencode"(예: "opencode-dashboard" 또는 "opencode-mobile") 를 포함한다면, README 에 해당 프로젝트가 OpenCode 팀이 만든 것이 아니며 어떤 방식으로도 우리와 제휴되어 있지 않다는 점을 명시해 주세요.

---

**커뮤니티에 참여하기** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
