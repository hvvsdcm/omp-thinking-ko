# omp-thinking-ko

OMP에 표시되는 영어 생각과 답변을 한국어로 옮기는 비공식 확장입니다. Gemini를 번역기로 사용하고, 화면 표시만 바꿉니다. OMP 본체나 원래 메시지·thinking 서명은 수정하지 않습니다.

**English:** An unofficial [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) extension that translates visible thinking and assistant replies into informal Korean. Bring your own OMP and Google Antigravity authentication. This repository does not provide credentials, a shared account, or a hosted translation service.

> **설치 전 확인:** 생각과 최종 답변의 원문이 번역을 위해 Google Antigravity/Gemini로 전송됩니다. 원문에 코드·비밀값이 포함돼 있으면 함께 전송될 수 있습니다. 민감한 작업에는 사용하지 마세요. 각 사용자의 계정 한도·비용·서비스 약관이 적용됩니다.

## 어떤 기능인가요?

- 영어 생각을 한국어 혼잣말처럼 표시합니다. 아직 생성 중이면 `생각 중..`, 번역 대기 중이면 `생각 옮기는 중..`으로 보입니다.
- **최종 답변도 번역하거나 말투를 바꿉니다.** 생각 전용 확장이 아닙니다.
- 이미 한국어인 문장도 반말·구어체로 바꾸며, `했어 → 햇어`, `있어 → 잇어` 같은 말투를 사용합니다. 프롬프트에 가벼운 욕설 허용 규칙이 있습니다. 업무용 정중체 번역기가 아닙니다.
- **v1.0.1부터 생각·답변 모두 말투를 프롬프트로만 맞춥니다.** 코드 문자열까지 바꾸던 강제 `ㅆ→ㅅ` 치환과 코드펜스 제거는 하지 않습니다. 모델이 간혹 `했어`를 남겨도 코드 보호를 위해 그대로 표시합니다.
- 번역 결과를 세션에 캐시해 같은 세션을 재개할 때 재사용합니다. 번역 캐시는 모델 문맥에 넣지 않습니다.
- 타임아웃이나 번역 실패 후 한 번 재시도하고, 최종 실패 시 원문을 표시합니다.
- Claude 전용 필터는 없습니다. OMP에서 해당 thinking/text 이벤트를 내보내는 다른 모델의 메시지에도 적용될 수 있습니다.

예시(기능 설명용이며 실제 실행 캡처가 아닙니다):

```text
원문: I found the bug. I'll fix it.
표시: 오류를 찾앗어. 고쳐볼게.
```

## 준비물과 호환성

1. [OMP](https://github.com/can1357/oh-my-pi)가 설치돼 있어야 합니다. 확인: `omp --version`.
2. 본인의 **Google Antigravity 계정**으로 OMP에 로그인해야 합니다. OMP 안에서 `/login google-antigravity`를 실행합니다. 저장소에 토큰을 넣거나 개발자에게 전달하지 마세요.
3. OMP에서 `google-antigravity/gemini-3.8-flash` 모델을 사용할 수 있어야 합니다. 접근 권한·모델 제공 여부는 계정과 제공자에 따라 달라집니다. 계정만 있으면 무조건 사용 가능하거나 무료라는 뜻은 아닙니다.

이 릴리스의 기존 실사용 확인 환경은 **Windows + OMP 18.2.11**입니다. 자동 테스트는 Node.js 24에서 실행하며 Windows·Linux·macOS CI를 제공합니다. 다른 운영체제의 실제 TUI 표시와 다른 OMP 버전까지 보장하지는 않습니다.

번역기는 `thinking-ko.ts` 상단의 `MODEL` 상수로 고정돼 있습니다. 기본 모델을 사용할 수 없다면 본인 OMP에서 지원하는 모델로 이 값을 바꾸고 인증을 설정해야 합니다. 다른 모델의 번역 품질·호환성은 별도 검증 대상입니다.

## 설치 — 파일 복사 방식 (권장)

관리자 권한, Git, npm, Bun을 별도로 설치하지 않아도 됩니다. OMP 실행 파일은 필요합니다.

1. [v1.0.1 릴리스](https://github.com/hvvsdcm/omp-thinking-ko/releases/tag/v1.0.1)에서 `thinking-ko.ts`를 다운로드합니다. 또는 소스 ZIP을 내려받아 압축을 풉니다.
2. 다운로드한 `thinking-ko.ts`가 있는 폴더에서 아래 명령을 실행합니다. **기존 파일이 있으면 덮어쓰지 않고 중단**합니다. 업데이트하려면 기존 파일을 extensions 폴더 밖에 먼저 백업하세요.

### Windows PowerShell

```powershell
$dir = Join-Path $HOME '.omp/agent/extensions'
New-Item -ItemType Directory -Force $dir | Out-Null
$dest = Join-Path $dir 'thinking-ko.ts'
if (Test-Path $dest) { throw '기존 thinking-ko.ts를 extensions 폴더 밖에 백업한 뒤 다시 실행하세요.' }
Copy-Item -LiteralPath ./thinking-ko.ts -Destination $dest
```

### macOS / Linux

```sh
mkdir -p "$HOME/.omp/agent/extensions"
if [ -e "$HOME/.omp/agent/extensions/thinking-ko.ts" ]; then
  printf '%s\n' '기존 thinking-ko.ts를 extensions 폴더 밖에 백업한 뒤 다시 실행하세요.'
else
  cp ./thinking-ko.ts "$HOME/.omp/agent/extensions/thinking-ko.ts"
fi
```

3. 기본 프로필의 `~/.omp/agent/config.yml`에 다음 설정을 **병합**합니다. 파일 전체를 예제로 덮어쓰지 마세요. `enabledModels`가 이미 있으면 기존 목록에 Gemini 항목만 추가합니다.

```yaml
hideThinkingBlock: false
enabledModels:
  - google-antigravity/gemini-3.8-flash
```

`config.example.yml`에도 같은 예제가 있습니다. `disabledProviders`에 `google-antigravity`가 있다면 해당 항목을 제거해야 합니다.

4. OMP를 종료하고 다시 실행합니다. 새 thinking 블록이나 답변이 끝나면 잠시 뒤 한국어 표시로 바뀝니다. 번역 기록이 없는 과거 메시지는 자동으로 소급 번역하지 않습니다.

**프로필/사용자 지정 경로:** 위 명령은 기본 프로필용입니다. `omp --profile NAME`을 쓴다면 확장·설정 위치는 `~/.omp/profiles/NAME/agent/` 아래입니다. `PI_CODING_AGENT_DIR`을 사용 중이라면 그 경로의 `extensions/`와 `config.yml`을 사용하세요. 현재 확장의 로그 위치는 프로필과 무관하게 아래에 기재된 기본 경로입니다.

## 선택: OMP 플러그인 관리자로 설치

Git 소스 설치를 지원하는 OMP와 설치에 필요한 Bun 환경이 준비돼 있다면:

```sh
omp plugin install github:hvvsdcm/omp-thinking-ko#v1.0.1
```

로그인과 `hideThinkingBlock`/모델 설정은 파일 복사 방식과 같습니다. **파일 복사 설치와 플러그인 설치를 동시에 사용하지 마세요.** 중복 실행으로 번역 요청이 늘어날 수 있습니다. 로컬 `plugin link`는 Windows에서 심볼릭 링크 권한이 필요할 수 있습니다.

제거:

```sh
omp plugin uninstall omp-thinking-ko
```

## 업데이트 — 기존 사용자

먼저 새 릴리스의 `thinking-ko.ts`를 다운로드하고 OMP를 종료합니다. **개인 설정·인증 파일을 바꿀 필요는 없습니다.** 현재 사용 중인 설치 방식 하나만 업데이트하세요.

### 파일 복사 설치

다운로드한 새 `thinking-ko.ts`가 있는 폴더에서 실행합니다. 기존 확장은 `extensions` 바깥의 `backups`에 복사한 뒤 교체합니다.

Windows PowerShell (기본 프로필):

```powershell
$ErrorActionPreference = 'Stop'
$agent = Join-Path $HOME '.omp/agent'
$dest = Join-Path $agent 'extensions/thinking-ko.ts'
$backup = Join-Path $agent 'backups'
New-Item -ItemType Directory -Force $backup | Out-Null
if (Test-Path $dest) {
  Copy-Item -LiteralPath $dest -Destination (Join-Path $backup ("thinking-ko-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.ts'))
}
Copy-Item -LiteralPath ./thinking-ko.ts -Destination $dest -Force
```

macOS / Linux (기본 프로필):

```sh
(
  set -e
  agent="$HOME/.omp/agent"
  backup="$(mktemp -d "$agent/thinking-ko-backup.XXXXXX")"
  if [ -f "$agent/extensions/thinking-ko.ts" ]; then
    cp "$agent/extensions/thinking-ko.ts" "$backup/thinking-ko.ts"
  fi
  cp ./thinking-ko.ts "$agent/extensions/thinking-ko.ts"
)
```

이후 OMP를 다시 실행합니다. 프로필/사용자 지정 경로는 위 설치 절의 경로 안내에 맞춰 바꾸세요.

### 플러그인 설치

아래 명령으로 새 버전을 설치한 뒤 OMP를 재시작합니다.

```sh
omp plugin install github:hvvsdcm/omp-thinking-ko#v1.0.1
```

**기존 번역 캐시:** v1.0.0에서 이미 번역해 저장한 메시지는 다시 번역하지 않습니다. 그 메시지에 있던 표시 오류도 자동 복구되지 않습니다. 새 대화의 새 메시지로 수정 여부를 확인하세요. 과거 원문이 필요하면 확장을 끄고 해당 세션을 재개하세요.

## 끄기와 제거

일시 중지하려면 OMP 시작 전에 `THINKING_KO=0`을 설정합니다.

```powershell
# Windows PowerShell — 현재 터미널에만 적용
$env:THINKING_KO = '0'
omp
# 다시 켜기: Remove-Item Env:THINKING_KO
```

```sh
# macOS / Linux — 이 실행에만 적용
THINKING_KO=0 omp
```

파일 복사 설치를 제거하려면 설치한 `thinking-ko.ts`만 삭제하고 OMP를 재시작합니다. 다른 확장이나 설정·인증 파일을 삭제하지 마세요. 플러그인 설치는 위 uninstall 명령을 사용합니다.

제거해도 기존 세션의 번역 캐시와 로그는 자동 삭제되지 않습니다. 세션 파일을 직접 편집하면 기록을 손상할 수 있으므로 캐시를 지우려다 전체 세션을 삭제하지 마세요.

## 개인정보·보안·사용량

- 이 배포본에는 개발자의 API 키, OAuth 토큰, 개인 OMP 설정, 대화 기록, 로그, 인증 DB가 포함되지 않습니다.
- 인증은 OMP의 `ctx.modelRegistry.getApiKey()`로 **설치한 사용자의 인증 정보**를 받아 OMP의 모델 호출 API에 전달합니다. 별도의 개발자 서버에 보내지 않습니다.
- 생각·답변 원문은 로컬에서 비밀값을 제거한 뒤 보내는 것이 아닙니다. 번역 제공자에게 전달해도 되는 내용만 사용하세요.
- `~/.omp/agent/thinking-ko.log`에 상태·오류와 **번역문 앞부분 최대 160자**가 기록됩니다. 약 1MB를 넘으면 `.old`로 회전합니다. 토큰 형태 일부를 가리는 처리는 있지만 모든 민감정보를 제거하는 보장은 없습니다. 로그와 세션 파일을 공개 이슈에 첨부하지 마세요.
- 전체 번역은 OMP 세션의 `thinking-ko` 사용자 정의 항목에 저장됩니다. 원문과 함께 로컬에 남는 데이터입니다.
- 번역은 별도의 모델 요청입니다. 생각은 동시 최대 2개, 답변은 1개이며, 느린 요청에는 추가 요청을 보내 먼저 끝난 결과를 쓰기도 합니다. 실패 시 재시도도 있어 메시지 수보다 요청 수가 많을 수 있습니다.
- 최종 답변의 코드·경로·숫자를 보존하도록 지시하지만 **LLM 번역의 무손실성을 보장하지 않습니다.** 실행할 명령이나 중요한 수치는 원문과 대조하세요. 확장을 끈 뒤 세션을 재개하면 원문을 확인할 수 있습니다.

## 알려진 제한과 문제 해결

**원문 대신 표시하는 기능은 비공개 TUI 구조에 의존합니다.** 확장은 실행 중 화면 컴포넌트의 `updateContent()`를 감싸며 OMP 설치 파일을 수정하지 않습니다. OMP 업데이트가 내부 구조를 바꾸면 표시가 깨질 수 있습니다. 패치에 실패하면 가능한 경우 생각 원문 밑에 번역을 덧붙이는 방식으로 돌아갑니다. 이 대체 방식은 답변 번역 표시를 지원하지 않습니다.

이미 터미널 스크롤백으로 나간 메시지에 번역이 도착하면 화면 기록을 다시 내보낼 수 있습니다. 이때 화면이 깜빡이거나 **OMP 시작 전의 셸 출력이 스크롤백에서 사라질 수 있습니다.**

| 증상 | 확인할 것 |
| --- | --- |
| 아무 변화가 없음 | 재시작 여부, `THINKING_KO=0` 여부, 확장 설치 위치, `hideThinkingBlock: false` |
| 번역 실패/원문 유지 | 본인 계정의 로그인·한도, 모델 접근 권한, `enabledModels`와 `disabledProviders` |
| OMP 업데이트 뒤 이상함 | 확장을 끄고 재시작. OMP 버전과 민감 내용을 제거한 오류 설명만 이슈로 제출 |
| 요청이 두 번씩 발생하는 것 같음 | 파일 복사본과 플러그인 중복 설치 여부; 느린 요청의 추가 시도는 정상 동작 |

## 개발과 검증

Node.js **24 이상**에서 외부 패키지 설치 없이 실행합니다. `npm install`은 필요하지 않습니다.

```sh
npm test
```

테스트는 큐 순서·동시 요청 제한·타임아웃·재시도·캐시·표시용 사본·스크롤백 재발행을 검사합니다. 모델 호출과 TUI는 테스트용 호스트로 대체되므로 실제 Google 요청, 번역 품질, 실터미널 호환성까지 검증하는 것은 아닙니다. CI에 계정이나 API 키를 넣지 마세요.

v1.0.1 배포 전에는 별도로 실제 Gemini 시험 문장 8개(생각 4개·답변 4개)를 번역해 표시용 변환 함수까지 확인했습니다. 코드펜스·한국어 코드 문자열·지정 명령·URL·숫자와 원본 메시지가 보존됐고, 표본에서 기존 반말 말투도 확인했습니다. 이는 모든 입력의 번역 정확도나 모든 터미널에서의 시각 검증을 보장하는 결과는 아닙니다.

## 라이선스와 출처

이 확장은 [MIT License](LICENSE)로 배포합니다. OMP 자체를 포함하거나 재배포하지 않으며 OMP/Anthropic/Google의 공식 제품이 아닙니다. OMP와 그 API는 [oh-my-pi](https://github.com/can1357/oh-my-pi) 프로젝트에서 제공합니다. 각 제공자의 계정·서비스 이용 조건은 별도로 적용됩니다.
