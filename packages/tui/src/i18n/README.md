# TUI 다국어(i18n)

TUI(`packages/tui`)의 인터페이스 문구를 영어 외 언어로 표시한다. 한국어(`ko`)가 기본 제공된다.

목표는 번역 기능 자체보다 **업스트림 커밋을 그대로 받아들이기 쉬운 구조**다. 그래서

- 번역 코드는 `src/i18n/` 안에만 있고,
- 기존 컴포넌트 수정은 "문자열을 `t()`로 감싼다" 수준으로 끝나며,
- 번역이 없으면 **영어가 그대로 보인다**(오류·빈칸·키 노출 없음).

## 파일

| 파일 | 역할 | 업스트림 충돌 |
| :--- | :--- | :--- |
| `language.ts` | 지원 언어 목록, 로케일 태그 정규화(`ko-KR` → `ko`), 설정·환경변수에서 언어 결정 | 없음(신규) |
| `translate.ts` | 사전 조회, `{{name}}` 보간. 순수 함수만 | 없음(신규) |
| `ko.ts` | 한국어 사전. **영어 원문이 키** | 없음(신규) |
| `index.ts` | 활성 언어 신호, `t()`, `useI18n()` | 없음(신규) |
| `provider.tsx` | 설정(`language`)과 활성 언어를 동기화 | 없음(신규) |
| `script/i18n-coverage.ts` | 번역 누락 점검 | 없음(신규) |
| `test/i18n.test.ts` | 언어 결정·보간·사전 무결성 테스트 | 없음(신규) |
| `test/i18n-render.test.tsx` | 영어로 적힌 다이얼로그·토스트가 한국어 프레임으로 나오는지 렌더 검증 | 없음(신규) |

기존 파일 수정은 두 종류뿐이다. **공용 렌더 지점**(좁고 재사용됨)과, 렌더 지점을 지나지 않는 **한 줄짜리 문구 감싸기**(`"문구"` → `t("문구")`)다.

| 파일 | 수정 내용 |
| :--- | :--- |
| `config/index.tsx` | `language` 설정 필드 추가(기본값은 시스템 로케일) |
| `app.tsx` | 트리에 `<I18nProvider>` 한 겹 추가 |
| `ui/dialog.tsx` | 다이얼로그 제목·버튼·푸터 액션 문구 |
| `ui/dialog-select.tsx` | 목록 행 제목·설명·푸터, 카테고리 헤더, 검색 placeholder, 빈 목록 문구, 한국어 검색 보정 |
| `ui/toast.tsx` | 알림 제목·본문·액션 라벨 |
| `ui/dialog-help.tsx` | 도움말 문장, 닫기 커맨드 제목 |
| `component/prompt/index.tsx` | 입력창 placeholder |
| `component/dialog-config.tsx` | 설정 목록에 `Language` 항목 |
| `routes/session/permission.tsx`, `util/permission.ts` | 권한 승인·거부 화면 문구, 선택 버튼 라벨(안전 문구) |
| 그 밖의 화면 컴포넌트 26개 | `<text>영어</text>` → `<text>{t("영어")}</text>` — 파일당 import 1줄 + 문구당 1토큰 |

## 동작 방식

### 영어 원문이 키다

```ts
// 컴포넌트
<text>{t("New session")}</text>

// 사전(src/i18n/ko.ts)
export const dict = { "New session": "새 세션" }
```

의미 키(`command.session.new`)가 아니라 **화면에 나오는 영어 문장 자체**를 키로 쓴다. 그 이유는 병합 비용이다.

- 컴포넌트 수정이 `"New session"` → `t("New session")` 한 조각이라 diff가 작고, 기계적으로 검토할 수 있다.
- 업스트림이 문구를 고치면 사전 조회가 빗나가 **영어가 그대로 표시**된다. 키 유실로 앱이 깨지거나 `missing.key`가 노출되지 않는다.
- 사전 키와 코드가 1:1로 눈에 보이므로 `script/i18n-coverage.ts`로 누락을 바로 찾을 수 있다.

### 렌더 지점에서 번역한다

모델명·세션 제목·파일 경로도 같은 렌더러를 지나간다. 공용 렌더러(`DialogHeader`, `DialogSelectRow`, `ToastSurface`)에서 마지막 순간에 `t()`를 적용하면

- 다이얼로그·선택 목록·토스트를 쓰는 **모든 화면이 한 번에 번역**되고(정의부 100여 곳을 고칠 필요가 없다),
- 사전에 없는 값(모델명, 경로, 사용자·모델이 만든 텍스트)은 **그대로 통과**한다.

이 셋이 합쳐져 수정 파일 42개, 번역 항목 613개로 TUI 자체 문구 대부분이 한국어가 된다. 업스트림 테스트 1694개도 그대로 통과한다(영어 사전은 항등이라 바뀌는 것이 없다).

### 언어 결정 순서

1. 설정 `language` (예: `"ko"`)
2. 환경변수 `OPENCODE_TUI_LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`
3. 영어(`en`)

`/settings` → Appearance → **Language** 에서 바꾸면 재시작 없이 즉시 반영된다(설정 파일을 직접 고쳐도 watcher가 반영한다).

## 문자열을 추가로 번역하는 방법

1. 화면에 영어가 보이면 그 문자열을 정확히 복사한다.
2. 해당 렌더 경로가 이미 공용 렌더러를 지나면 **사전에만** 추가하면 된다.
   ```ts
   export const dict = { "Confirm delete": "삭제 확인" }
   ```
3. 공용 렌더러를 지나지 않으면 호출부를 `t()`로 감싼다. 보간이 필요하면 `{{name}}`을 쓴다.
   ```tsx
   <text>{t("Delete {{count}} files?", { count })}</text>
   ```
   사전 값에도 같은 이름의 placeholder를 둔다. `"Delete {{count}} files?": "파일 {{count}}개를 삭제할까요?"`
4. 같은 모양의 문구가 여러 파일에 흘어져 있으면 기계적으로 한 번에 감싼다. `<text>영어</text>` 처럼 **텍스트 노드만** 대상으로 하고(한 줄짜리와 여러 줄로 나뉜 것 모두), 모델명·경로·태그가 섞인 줄은 건드리지 않는다. 2차 적용(26개 파일·55개 문구)과 3차 적용(16개 파일·20개 문구)이 이 방식이었고, 결과 diff는 파일당 import 1줄 + 문구당 1토큰이다.
5. `bun packages/tui/script/i18n-coverage.ts --details` 로 누락을 확인한다. `--strict` 는 `t()`로 감쌌지만 사전에 없는 키가 있으면 실패한다.

### 새 언어 추가

1. `language.ts` 의 `LANGUAGES` 에 `{ code: "ja", label: "日本語" }` 추가
2. `src/i18n/ja.ts` 에 `export const dict = {...}` 작성
3. `index.ts` 의 `dictionaries` 에 `ja` 등록 — **이 한 줄이 전부다**

언어 이름(`English`, `한국어`, `日本語`)은 그 언어로 표기하며 절대 사전에 넣지 않는다(`test/i18n.test.ts`가 검사한다).

## 업스트림 병합 절차

```bash
git remote add upstream https://github.com/KROFOSS/opencode   # 최초 1회
git fetch upstream && git merge upstream/main
```

충돌은 거의 항상 같은 모양이다. **업스트림 쪽 문구를 살리고 `t()`로 다시 감싼다.**

```tsx
// 충돌 예시
<<<<<<< HEAD
  <text>{t("New session")}</text>
=======
  <text>Start a new session</text>
>>>>>>> upstream/main
```

해결:

```tsx
  <text>{t("Start a new session")}</text>
```

그다음 사전을 갱신한다.

```bash
bun packages/tui/script/i18n-coverage.ts --details
# "Start a new session" 이 missing keys 에 나오면 ko.ts 에 추가
```

`language.ts` / `translate.ts` / `index.ts` / `provider.tsx` / `ko.ts` 는 신규 파일이라 업스트림이 건드리지 않는다. 충돌은 위 예시처럼 "문자열을 감싼 줄"에서만 발생하고, 해결 규칙이 하나뿐이라 기계적이다.

업스트림이 새로 만든 화면은 자동으로 영어로 동작한다. 번역이 급하지 않다면 사전에 넣지 않아도 앱은 정상 동작한다.

## 알려진 한계

- **잔여 영어가 있다.** `mini/` 상태줄 힌트, `config/` 스키마 주석(개발자 문서), 홈 화면의 예시 프롬프트는 아직 영어다. 모두 화면이 깨지지 않는 범위이고, `script/i18n-coverage.ts` 가 백로그로 보여 준다.
- **데이터와 문구를 구분하지 못한다.** 사전은 정확히 일치하는 문자열만 바꾸므로, 세션 제목이 우연히 `"auto"` 처럼 사전 키와 같으면 번역되어 보인다. 짧은 설정값 키(`on`/`off`/`auto` 등)에서만 생길 수 있는 드문 경우다.
- **검색은 영어 기준이 기본**이다. `DialogSelect` 는 한국어 입력을 위해 번역된 제목과의 부분 일치를 추가로 붙이지만(퍼지 순위는 영어 그대로), 명령 id·키워드로는 여전히 영어가 유리하다.
- **조사 처리 없음.** `{{name}}` 뒤의 은/는·이/가·을/를은 앞 단어에 따라 달라지므로, 번역문은 조사를 피하는 문장으로 쓴다.
- **폭 계산.** 목록 행 제목은 `Locale.truncateWidth` 로 잘라 한국어 2칸 폭 문자를 처리한다. 그 밖의 레이아웃은 기존 고정 폭을 그대로 쓰므로, 아주 긴 한국어 라벨은 잘려 보일 수 있다.
- **세션 본문은 번역하지 않는다.** 모델·사용자가 만든 텍스트는 사전에 없으므로 그대로 표시된다(의도된 동작).
- **모델에게 보내는 프롬프트는 번역하지 않는다.** UI 문구만 대상이다.
