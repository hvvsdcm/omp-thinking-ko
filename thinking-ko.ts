// thinking-ko: OMP 화면에 뜨는 thinking 블록과 답변(text 블록)을 Gemini(google-antigravity)로
// 번역해 원문 대신 그린다. 생각·답변 모두 반말·구어체(ㅆ→ㅅ)는 프롬프트로 맞추고 코드·마크다운을 보존한다.
//
// 표시 방식: OMP 확장 API에는 본문을 바꿔 그리는 훅이 없어서, 위젯 팩토리로 얻은 TUI 루트에서
// 어시스턴트 메시지 컴포넌트 클래스를 찾아 updateContent를 감싸 표시용 사본만 번역문으로 바꾼다
// (아래 "화면 패치"). 모델 문맥·세션 파일의 원문과 서명은 그대로다. 패치를 못 하면
// registerAssistantThinkingRenderer로 원문 밑에 번역을 덧붙이는 방식으로 돌아간다
// (config.yml hideThinkingBlock: false 필요). 번역문은 pi.appendEntry로 세션 파일에 캐시해
// (모델 문맥에는 안 들어감) 재개·화면 재구성 때 다시 그린다.
//
// 설치: README.md 참고. 수동 설치 위치: ~/.omp/agent/extensions/thinking-ko.ts
// 순수 함수·클래스는 thinking-ko.test.mjs에서 node --test로 검사한다.
// pi-ai는 OMP 안에서만 풀리므로 번역 호출 시점에 동적 import한다(노드 테스트에서 import 가능하게).
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 설정 --------------------------------------------------------------------
/** 번역 모델(속도 우선). config.yml enabledModels에 있어야 한다. */
export const MODEL = "google-antigravity/gemini-3.8-flash";
/** 켬/끔. 환경변수 THINKING_KO=0 으로도 끌 수 있다. */
export const ENABLED = true;
/**
 * 번역 한 건 타임아웃(ms). 넘으면 원문을 그대로 둔다.
 * 사양 초안은 5초였지만 실측(2026-09-24, 같은 160자 블록 10회)에서 응답이 1.9~8.7초로 흔들려
 * 5초면 셋 중 하나꼴로 영어 원문이 떴다. 그래서 12초로 두고 아래 HEDGE_AFTER_MS로 꼬리를 줄인다.
 */
export const TIMEOUT_MS = 12000;
/** 첫 요청이 이 시간(ms) 안에 안 끝나면 같은 요청을 하나 더 보내 먼저 온 답을 쓴다. */
export const HEDGE_AFTER_MS = 3000;
/** 긴 블록은 출력이 길어 5초 안에 못 끝나므로 1000자를 넘을 때마다 이만큼 더 기다린다. */
export const TIMEOUT_EXTRA_MS_PER_1K_CHARS = 2500;
/** 동시에 보내는 번역 요청 수. 표시는 항상 블록 순서대로 한다. */
export const CONCURRENCY = 2;
/** 생각 번역 풀의 HTTP 요청 동시 상한(헤징 포함). */
export const MAX_INFLIGHT_REQUESTS = 2;
/** 답변 번역 풀의 HTTP 요청 동시 상한. 생각 풀과 따로라서 답변이 생각 번역을 굶기지 않는다(전체 ≤ 3). */
export const ANSWER_INFLIGHT_REQUESTS = 1;
/** 실패한 블록을 다시 시도하기까지 기다리는 최대 시간(ms). 다른 번역이 먼저 성공하면 그때 바로 시도한다. */
export const RETRY_DELAY_MS = 60_000;
/** 블록당 최대 시도 횟수(처음 1 + 재시도 1). */
export const MAX_ATTEMPTS = 2;
/** 번역을 기다리는 블록 상한. 넘치면 가장 오래된 블록을 원문으로 확정한다. */
export const MAX_PENDING_BLOCKS = 8;
/** 로그에 남기는 번역문 앞부분 글자 수. */
export const LOG_KO_CHARS = 160;
/** 번역 출력 토큰 상한의 최댓값. */
export const MAX_OUTPUT_TOKENS = 16384;
/** 번역 줄 오른쪽에 비워 둘 칸 수(한글 폭 계산 차이로 줄이 넘치지 않게). */
export const RIGHT_GAP = 4;
/** 세션 파일에 남기는 번역 캐시 항목 이름(pi.appendEntry customType). */
export const ENTRY_TYPE = "thinking-ko";
const WIDGET_KEY = "thinking-ko";
/**
 * 기록 재발행(스크롤백 지우고 다시 내보내기) 빈도 제어. 재발행은 화면 전체를 다시 쓰고 한 번 깜빡이므로
 * 번역이 연달아 도착하면 모아서 한 번만 한다.
 * - QUIET: 마지막 요청 뒤 이만큼 조용하면 실행(트레일링 디바운스)
 * - MAX_WAIT: 첫 요청부터 이만큼 지나면 계속 도착 중이어도 한 번 실행(영어가 너무 오래 남지 않게)
 * - MIN_GAP: 실행 뒤 최소 간격(그 사이 도착분은 다음 한 번으로 합친다)
 * 어시스턴트 메시지가 스트리밍 중이면 그 메시지가 끝날 때까지 미루고 끝나면 한 번 실행한다.
 */
export const STABLE_RESET_QUIET_MS = 1500;
export const STABLE_RESET_MAX_WAIT_MS = 6000;
export const STABLE_RESET_MIN_GAP_MS = 3000;
/** 스트리밍 때문에 미룬 재발행이 이만큼(첫 요청부터) 넘으면 스트리밍 중이어도 한 번 실행하고 로그를 남긴다. */
export const STABLE_RESET_MAX_DEFER_MS = 60_000;
/** 세션 시작 뒤 화면 패치를 다시 시도하는 시점(ms). */
const PATCH_RETRY_MS = [300, 1000, 3000];
const LOG_PATH = join(homedir(), ".omp", "agent", "thinking-ko.log");
const LOG_MAX_BYTES = 1_000_000;

// ---- 번역 프롬프트 ------------------------------------------------------------
/** 말투 규칙. 생각·답변 프롬프트가 이 줄들을 그대로 같이 쓴다(사용자 요구: 답변 말투 = 생각 말투). */
export const TONE_RULES: ReadonlyArray<string> = [
	"- 짧고 단순한 반말·구어체로 써. 친구한테 중얼거리듯이. 감탄사(아!!, 오, 음..)와 말줄임(..)을 자연스럽게 써도 돼. 가끔 가벼운 욕(시발 같은)도 괜찮아.",
	"- 격식체 금지: '~합니다', '~했습니다', '~입니다', '~하겠습니다', '~해요' 쓰지 마.",
	"- 종결어미의 쌍시옷(ㅆ)은 시옷(ㅅ)으로 써: 있어→잇어, 했어→햇어, 됐어→됏어, 썼어→썻어, 찾았어→찾앗어, 하겠다→하겟다.",
];

export const SYSTEM_PROMPT = [
	"너는 코딩 에이전트가 속으로 하는 생각(영어)을 한국어 혼잣말로 옮기는 번역기야.",
	"규칙:",
	...TONE_RULES,
	"- 파일명·코드 식별자·명령어·URL·숫자는 원문 그대로 둬.",
	"- 뜻은 빼거나 보태지 말고, 문장은 더 짧게 끊어. 마크다운 굵은 제목(**...**)이 있으면 제목도 짧게 번역해서 그대로 굵게 둬.",
	"- 입력이 이미 한국어면 뜻은 그대로 두고 말투만 이 규칙대로 바꿔(존댓말·격식체 → 반말).",
	"- 번역문만 출력해. 설명, 따옴표, 머리말 붙이지 마.",
].join("\n");

export const FEW_SHOT: ReadonlyArray<{ en: string; ko: string }> = [
	{
		en: "An error occurred while running the build. I found the cause, let me fix it.",
		ko: "아!! 시발 오류를 찾앗어.. 고쳐볼게.",
	},
	{
		en: "The test is failing because the date parser expects ISO format. I need to check the implementation first.",
		ko: "테스트 터진 거 날짜 파서가 ISO 형식만 받아서 그런 거엿어. 일단 구현부터 봐야겟다.",
	},
	{
		en: "**Checking the config**\n\nThe user wants dark mode enabled. I've already updated settings.json, so now I'll verify the build passes.",
		ko: "**설정 확인**\n\n다크 모드 켜달래. settings.json은 벌써 고쳣으니까 이제 빌드 되는지 볼게.",
	},
	{
		en: "`is_even`이 홀수일 때 True를 반환하는 버그를 찾았습니다. 먼저 이것부터 고치겠습니다.",
		ko: "`is_even`이 홀수일 때 True 뱉는 버그 찾앗어. 이거부터 고칠게.",
	},
];

/**
 * 답변(text 블록)용 번역 프롬프트. 말투 규칙은 생각 프롬프트와 같은 TONE_RULES를 그대로 쓰고, 예시도 생각 예시를
 * 그대로 앞에 둔다. 답변은 사용자가 읽는 결과물이라 코드·경로·마크다운 구조를 지키고 내용은 빠짐없이 옮기는 규칙만
 * 더 둔다. 생각·답변 모두 코드 보호를 위해 ㅆ→ㅅ 후처리는 하지 않고 프롬프트로만 맞춘다.
 */
export const ANSWER_SYSTEM_PROMPT = [
	"너는 코딩 에이전트가 사용자에게 보내는 답변을 한국어 혼잣말 말투로 옮기는 번역기야. 말투는 에이전트가 속으로 하는 생각을 옮길 때와 똑같이 해.",
	"규칙:",
	...TONE_RULES,
	"- ㅆ→ㅅ은 네가 직접 해야 해(뒤에서 고쳐 주지 않아). 단 코드 블록·인라인 코드·경로·파일명 안의 글자는 절대 바꾸지 마.",
	"- 코드 블록(```...```), 인라인 코드(`...`), 파일 경로, 파일명, 명령어, 식별자, URL, 숫자는 한 글자도 바꾸지 마.",
	"- 마크다운 구조(제목, 목록 기호, 굵게, 표, 줄바꿈, 들여쓰기)는 그대로 유지해.",
	"- 내용은 하나도 빼거나 보태지 말고 전부 옮겨. 말투만 바꿔. 입력이 이미 한국어면 뜻은 그대로 두고 말투만 이 규칙대로 바꿔.",
	"- 번역문만 출력해. 설명, 따옴표, 머리말 붙이지 마.",
].join("\n");

/** 답변 예시: 생각 예시 전부 + 코드·마크다운 보존을 보여 주는 예시(말투는 생각 예시와 같은 결). */
export const ANSWER_FEW_SHOT: ReadonlyArray<{ en: string; ko: string }> = [
	...FEW_SHOT,
	{
		en: "세 파일 모두 한 줄씩 고쳤고, 다시 실행하니 기대값과 똑같이 나옵니다.\n\n- **b.py**: `y % 300`을 `y % 400`으로 바꿨습니다.\n- `msg = \"저장했습니다\"` 줄은 그대로 두었습니다.\n\n확인하려면:\n\n```bash\npython util.py\n```",
		ko: "세 파일 다 한 줄씩 고쳣고 다시 돌려보니까 기댓값이랑 똑같이 나오네.\n\n- **b.py**: `y % 300`을 `y % 400`으로 바꿧어.\n- `msg = \"저장했습니다\"` 줄은 그대로 둿어.\n\n확인하려면:\n\n```bash\npython util.py\n```",
	},
];

export type TranslationKind = "thinking" | "answer";

// ---- 순수 함수 ----------------------------------------------------------------

/** 블록 길이에 따른 타임아웃. 1000자까지는 TIMEOUT_MS, 그 뒤로 1000자마다 추가. */
export function timeoutFor(text: string): number {
	const extraBlocks = Math.max(0, Math.ceil(text.length / 1000) - 1);
	return TIMEOUT_MS + extraBlocks * TIMEOUT_EXTRA_MS_PER_1K_CHARS;
}

export function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 터미널 칸 폭. 한글·CJK·전각 문자는 2칸, 나머지는 1칸으로 센다. */
export function cellWidth(ch: string): number {
	const c = ch.codePointAt(0) ?? 0;
	if (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) ||
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe4f) ||
		(c >= 0xff00 && c <= 0xff60) ||
		(c >= 0xffe0 && c <= 0xffe6) ||
		(c >= 0x1f300 && c <= 0x1faff) ||
		(c >= 0x20000 && c <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/**
 * 글을 maxCols 칸 안에 들어가게 줄바꿈한다. 가능하면 공백에서 끊고, 한 단어가 너무 길면
 * 글자 단위로 자른다. 위젯 줄이 터미널 오른쪽 끝에 닿지 않게 하려고 직접 감싼다.
 */
export function wrapDisplay(text: string, maxCols: number): string[] {
	const cols = Math.max(4, Math.floor(maxCols));
	const out: string[] = [];
	for (const para of text.replace(/\r/g, "").split("\n")) {
		let line = "";
		let lineW = 0;
		for (const word of para.split(/(?<= )/)) {
			const chars = Array.from(word);
			const w = chars.reduce((n, ch) => n + cellWidth(ch), 0);
			if (lineW + w <= cols) {
				line += word;
				lineW += w;
				continue;
			}
			if (line.trim() && w <= cols) {
				out.push(line.trimEnd());
				line = word;
				lineW = w;
				continue;
			}
			for (const ch of chars) {
				const cw = cellWidth(ch);
				if (lineW + cw > cols) {
					out.push(line.trimEnd());
					line = "";
					lineW = 0;
				}
				line += ch;
				lineW += cw;
			}
		}
		out.push(line.trimEnd());
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}

/** 로그에 쓰기 전에 토큰처럼 생긴 문자열을 가린다. */
export function redact(text: string): string {
	return text
		.replace(/Bearer\s+[^\s"'`]+/gi, "Bearer [redacted]")
		.replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]")
		.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}

// ---- 동시 요청 제한·타임아웃·헤징 ---------------------------------------------

/** 전체 HTTP 요청 수를 묶는 세마포어. release는 여러 번 불러도 한 번만 반영된다. */
export class Slots {
	readonly #max: number;
	#used = 0;
	#peak = 0;
	readonly #waiters: Array<{ grant: (release: () => void) => void }> = [];

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}
	get used(): number {
		return this.#used;
	}
	get peak(): number {
		return this.#peak;
	}
	get waiting(): number {
		return this.#waiters.length;
	}

	#take(): () => void {
		this.#used++;
		this.#peak = Math.max(this.#peak, this.#used);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#used--;
			const next = this.#waiters.shift();
			if (next) next.grant(this.#take());
		};
	}

	/** 빈 슬롯이 있으면 바로 잡고 release 함수를, 없으면 undefined를 준다. */
	tryAcquire(): (() => void) | undefined {
		if (this.#used >= this.#max || this.#waiters.length > 0) return undefined;
		return this.#take();
	}

	/** 슬롯이 날 때까지 기다린다. signal이 끊기면 대기에서 빠지고 거부된다. */
	acquire(signal?: AbortSignal): Promise<() => void> {
		const now = this.tryAcquire();
		if (now) return Promise.resolve(now);
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError(signal));
				return;
			}
			const waiter = {
				grant: (release: () => void) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(release);
				},
			};
			const onAbort = (): void => {
				const i = this.#waiters.indexOf(waiter);
				if (i >= 0) this.#waiters.splice(i, 1);
				reject(abortError(signal!));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push(waiter);
		});
	}
}

/** 타이머가 OMP(노드) 프로세스 종료를 붙잡지 않게 한다. */
export function unrefTimer<T>(timer: T): T {
	(timer as { unref?: () => void } | undefined)?.unref?.();
	return timer;
}

function abortError(signal: AbortSignal): Error {
	const r = signal.reason;
	return r instanceof Error ? r : new Error("aborted");
}

/**
 * fn 전체(인증 조회·모듈 로드·요청)를 ms 안에 끝내게 한다. 시간이 넘거나 parent가 끊기면
 * fn에 준 signal을 abort하고 거부한다.
 */
export function withDeadline<T>(ms: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const onParent = (): void => controller.abort(abortError(parent!));
	if (parent?.aborted) onParent();
	else parent?.addEventListener("abort", onParent, { once: true });
	return new Promise<T>((resolve, reject) => {
		const timer = unrefTimer(setTimeout(() => controller.abort(new Error(`timeout ${ms}ms`)), ms));
		const cleanup = (): void => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParent);
		};
		if (controller.signal.aborted) {
			cleanup();
			reject(abortError(controller.signal));
			return;
		}
		controller.signal.addEventListener(
			"abort",
			() => {
				cleanup();
				reject(abortError(controller.signal));
			},
			{ once: true },
		);
		let p: Promise<T>;
		try {
			p = Promise.resolve(fn(controller.signal));
		} catch (e) {
			p = Promise.reject(e);
		}
		p.then(
			(v) => {
				cleanup();
				resolve(v);
			},
			(e: unknown) => {
				cleanup();
				reject(e);
			},
		);
	});
}

/**
 * 요청 헤징. 슬롯을 하나 잡아 run을 부르고, hedgeAfterMs 안에 안 끝나면 빈 슬롯이 있을 때만
 * 같은 요청을 하나 더 보내 먼저 성공한 결과를 쓴다. 첫 요청이 실패하면 슬롯을 다시 잡아 한 번 더
 * 보낸다(총 2회). 끝나면 남은 요청은 abort한다. 전체 시간 제한은 signal(withDeadline)이 맡는다.
 * 슬롯은 각 요청 프로미스가 settle될 때만 돌려주므로 실제 진행 중 요청 수는 slots 상한을 넘지 않는다.
 */
export function hedged<T>(
	run: (signal: AbortSignal) => Promise<T>,
	hedgeAfterMs: number,
	slots: Slots,
	signal?: AbortSignal,
): Promise<{ value: T; attempt: number }> {
	return new Promise((resolve, reject) => {
		const controllers: AbortController[] = [];
		let attempts = 0;
		let failures = 0;
		let settled = false;
		let lastError: unknown;
		let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => finish(() => reject(abortError(signal!)));
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(hedgeTimer);
			signal?.removeEventListener("abort", onAbort);
			for (const c of controllers) c.abort(new Error("hedge finished"));
			fn();
		};
		const launch = (release: () => void): void => {
			if (settled || attempts >= 2) {
				release();
				return;
			}
			attempts++;
			const attempt = attempts;
			const c = new AbortController();
			controllers.push(c);
			let p: Promise<T>;
			try {
				p = Promise.resolve(run(c.signal));
			} catch (e) {
				p = Promise.reject(e);
			}
			// 슬롯은 이 요청의 프로미스가 실제로 끝날 때(성공·실패·abort 거부) 한 번만 돌려준다.
			// abort를 늦게 존중하는 요청은 끝날 때까지 슬롯을 쥐고 있는다(동시 요청 상한 우선).
			p.finally(release).then(
				(value) => {
					finish(() => resolve({ value, attempt }));
				},
				(e: unknown) => {
					failures++;
					lastError = e;
					if (settled) return;
					if (attempts < 2) {
						slots.acquire(signal).then(launch, (err: unknown) => finish(() => reject(err)));
					} else if (failures >= attempts) {
						finish(() => reject(lastError));
					}
				},
			);
		};
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		hedgeTimer = unrefTimer(
			setTimeout(() => {
				if (settled || attempts >= 2) return;
				const release = slots.tryAcquire();
				if (release) launch(release);
			}, hedgeAfterMs),
		);
		slots.acquire(signal).then(launch, (err: unknown) => finish(() => reject(err)));
	});
}

// ---- 순서 보장 큐 -------------------------------------------------------------
export interface TranslatedItem {
	id: string;
	source: string;
	text: string;
	ok: boolean;
	error?: string;
}

interface QueueItem {
	id: string;
	source: string;
	started: boolean;
	controller?: AbortController;
	done?: TranslatedItem;
}

/**
 * 순서 보장 번역 큐. push한 순서대로 onResult가 불린다. 번역은 최대 concurrency개까지
 * 동시에 돌고, 앞 블록이 끝나기 전에는 뒤 블록 결과를 내보내지 않는다.
 * 번역이 실패하면 원문을 ok=false로 내보낸다. 대기가 maxPending을 넘으면 가장 오래된 미처리
 * 블록을 실패 확정(원문)하고 onDrop으로 알린다.
 */
export class OrderedTranslator {
	readonly #translate: (text: string, signal: AbortSignal, id: string) => Promise<string>;
	readonly #onResult: (item: TranslatedItem) => void;
	readonly #onDrop?: (item: TranslatedItem) => void;
	readonly #concurrency: number;
	readonly #maxPending: number;
	readonly #items: QueueItem[] = [];
	readonly #seen = new Set<string>();
	#running = 0;
	#generation = 0;

	constructor(opts: {
		translate: (text: string, signal: AbortSignal, id: string) => Promise<string>;
		onResult: (item: TranslatedItem) => void;
		onDrop?: (item: TranslatedItem) => void;
		concurrency?: number;
		maxPending?: number;
	}) {
		this.#translate = opts.translate;
		this.#onResult = opts.onResult;
		this.#onDrop = opts.onDrop;
		this.#concurrency = Math.max(1, opts.concurrency ?? 1);
		this.#maxPending = Math.max(1, opts.maxPending ?? Number.POSITIVE_INFINITY);
	}

	/** 같은 id는 한 번만 받는다. 새로 받았으면 true. */
	push(id: string, source: string): boolean {
		if (this.#seen.has(id)) return false;
		this.#seen.add(id);
		this.#items.push({ id, source, started: false });
		this.#enforceCap();
		this.#pump();
		return true;
	}

	/** 아직 onResult로 나가지 않은 블록 수. */
	get pending(): number {
		return this.#items.length;
	}

	get running(): number {
		return this.#running;
	}

	/** 대기·진행 중인 항목을 버리고 진행 중 요청을 abort한다(세션 전환 등). */
	reset(): void {
		this.#generation++;
		for (const item of this.#items) item.controller?.abort(new Error("reset"));
		this.#items.length = 0;
		this.#seen.clear();
		this.#running = 0;
	}

	#enforceCap(): void {
		while (this.#items.filter((i) => !i.done).length > this.#maxPending) {
			const oldest = this.#items.find((i) => !i.done)!;
			oldest.controller?.abort(new Error("queue overflow"));
			oldest.done = { id: oldest.id, source: oldest.source, text: oldest.source, ok: false, error: "queue overflow" };
			try {
				this.#onDrop?.(oldest.done);
			} catch {
				// 알림 실패는 무시
			}
		}
		this.#flush();
	}

	#pump(): void {
		for (const item of this.#items) {
			if (this.#running >= this.#concurrency) break;
			if (item.started || item.done) continue;
			item.started = true;
			item.controller = new AbortController();
			this.#running++;
			const gen = this.#generation;
			const finish = (done: TranslatedItem): void => {
				if (gen !== this.#generation) return;
				this.#running--;
				if (!item.done) item.done = done;
				this.#flush();
				this.#pump();
			};
			let run: Promise<string>;
			try {
				run = Promise.resolve(this.#translate(item.source, item.controller.signal, item.id));
			} catch (e) {
				run = Promise.reject(e);
			}
			run.then(
				(text) => finish({ id: item.id, source: item.source, text, ok: true }),
				(e: unknown) =>
					finish({
						id: item.id,
						source: item.source,
						text: item.source,
						ok: false,
						error: e instanceof Error ? e.message : String(e),
					}),
			);
		}
	}

	#flush(): void {
		while (this.#items.length > 0 && this.#items[0]!.done) {
			const head = this.#items.shift()!;
			try {
				this.#onResult(head.done!);
			} catch {
				// 표시 실패가 큐를 멈추게 하지 않는다.
			}
		}
	}
}

// ---- 번역 저장소(렌더러 조회용) ------------------------------------------------

/**
 * thinking 원문과 화면 표시용 텍스트를 같은 키로 맞춘다. OMP는 표시할 때 코드 블록을 "..."로
 * 접고 빈 HTML 주석을 지우므로(proseOnlyThinking), 둘 다 걷어 낸 뒤 글자·숫자만 남긴 **전체**를
 * 해시한다(앞부분만 쓰면 끝만 다른 두 블록이 섞인다). 코드만 있는 블록은 모두 같은 "빈" 키가 되며,
 * 이때는 블록 위치(contentIndex)로만 구분한다.
 */
export function thinkingKey(text: string): string {
	const stripped = text
		.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1")
		.replace(/<!--[\s\S]*?-->/g, "");
	const letters = stripped.match(/[A-Za-z0-9가-힣]/g) ?? [];
	return shortHash(`k:${letters.join("")}`);
}

/** 짧은 해시(세션 파일에 서명 전체 대신 남긴다). */
export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 블록 식별자: 서명 해시 우선, 없으면 원문 전체 해시. 번역·캐시는 이 단위로 따로 한다. */
export function blockId(source: string, signature?: string): string {
	return signature ? `s:${shortHash(signature)}` : `t:${shortHash(source)}`;
}

/**
 * pending: 번역 중, done: 번역 있음, failed: 번역 실패 또는 번역 기록이 없는 과거 블록(원문만 둔다).
 * failed도 저장소에 남겨 후보 집계에 넣는다. 지우면 같은 (표시 키, 위치)의 다른 블록 번역이 잘못 붙는다.
 */
export type StoreState = { status: "pending"; retry?: boolean } | { status: "done"; ko: string } | { status: "failed" };

/** 세션 파일에 남기는 번역 캐시 항목(`pi.appendEntry(ENTRY_TYPE, data)`). 모델 문맥에는 안 들어간다. */
export interface CacheEntryData {
	/** 2: 생각만(초기 형식), 3: kind로 생각·답변 구분 */
	v: 2 | 3;
	kind?: TranslationKind;
	/** blockId(서명 해시 또는 원문 해시) */
	id: string;
	/** thinkingKey(원문) — 렌더러가 화면 텍스트로 블록을 찾을 때 쓴다 */
	k: string;
	/** 메시지 안에서의 content 위치(렌더러가 넘겨주는 contentIndex와 같다) */
	ci: number;
	ko: string;
}

interface BlockRecord {
	id: string;
	key: string;
	ci: number;
	state: StoreState;
}

/**
 * 블록 id → 번역 상태. 렌더러는 (화면 텍스트 키, contentIndex)로 후보를 찾는다. 후보가 하나면 그
 * 상태를, 여럿이면 번역이 모두 같을 때만 그 번역을 쓰고 아니면 아무것도 안 그린다(잘못된 번역을
 * 붙이느니 원문만 둔다). version은 바뀔 때마다 올라가 렌더 캐시를 깬다.
 */
export class TranslationStore {
	readonly #blocks = new Map<string, BlockRecord>();
	#version = 0;

	get version(): number {
		return this.#version;
	}
	get size(): number {
		return this.#blocks.size;
	}
	has(id: string): boolean {
		return this.#blocks.has(id);
	}
	/** ci를 주면 그 위치로 기록된 항목일 때만 돌려준다(답변: 다른 위치 블록의 번역이 붙지 않게). */
	get(id: string, ci?: number): StoreState | undefined {
		const b = this.#blocks.get(id);
		if (!b || (ci !== undefined && b.ci !== ci)) return undefined;
		return b.state;
	}

	setPending(id: string, key: string, ci: number, retry = false): void {
		if (this.#blocks.get(id)?.state.status === "done") return;
		this.#blocks.set(id, { id, key, ci, state: retry ? { status: "pending", retry: true } : { status: "pending" } });
		this.#version++;
	}
	setDone(id: string, key: string, ci: number, ko: string): void {
		this.#blocks.set(id, { id, key, ci, state: { status: "done", ko } });
		this.#version++;
	}
	setFailed(id: string, key: string, ci: number): void {
		this.#blocks.set(id, { id, key, ci, state: { status: "failed" } });
		this.#version++;
	}
	remove(id: string): void {
		if (this.#blocks.delete(id)) this.#version++;
	}
	clear(): void {
		this.#blocks.clear();
		this.#version++;
	}

	/** 세션 파일의 custom 항목들에서 번역 캐시를 다시 채운다(v2만). 불러온 개수를 돌려준다. */
	load(entries: ReadonlyArray<unknown>): number {
		let n = 0;
		for (const e of entries) {
			const entry = e as { type?: string; customType?: string; data?: Partial<CacheEntryData> };
			if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const d = entry.data;
			if (!d || (d.v !== 2 && d.v !== 3) || typeof d.id !== "string" || typeof d.k !== "string") continue;
			if (typeof d.ci !== "number" || typeof d.ko !== "string") continue;
			this.#blocks.set(d.id, { id: d.id, key: d.k, ci: d.ci, state: { status: "done", ko: d.ko } });
			n++;
		}
		if (n) this.#version++;
		return n;
	}

	/**
	 * 세션에 있는 어시스턴트 thinking 블록 중 캐시가 없는 것을 failed(원문만)로 등록한다. 번역 실패는
	 * 캐시에 안 남기므로, 재개했을 때 그런 블록이 후보에서 빠져 다른 블록 번역이 잘못 붙는 걸 막는다.
	 * 등록한 개수를 돌려준다.
	 */
	registerUntranslated(entries: ReadonlyArray<unknown>): number {
		let n = 0;
		for (const e of entries) {
			const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const content = entry.message.content;
			if (!Array.isArray(content)) continue;
			content.forEach((b: { type?: string; thinking?: string; thinkingSignature?: string }, ci: number) => {
				if (b?.type !== "thinking" || typeof b.thinking !== "string") return;
				const source = b.thinking.trim();
				if (!source) return;
				const id = blockId(source, b.thinkingSignature);
				if (this.#blocks.has(id)) return;
				this.#blocks.set(id, { id, key: thinkingKey(source), ci, state: { status: "failed" } });
				n++;
			});
		}
		if (n) this.#version++;
		return n;
	}

	lookup(displayText: string, contentIndex: number): StoreState | undefined {
		const key = thinkingKey(displayText);
		const cands: BlockRecord[] = [];
		for (const b of this.#blocks.values()) if (b.key === key && b.ci === contentIndex) cands.push(b);
		if (cands.length === 0) return undefined;
		// 실패(또는 번역 없는) 후보가 하나라도 있으면 어느 블록인지 확정할 수 없으니 그리지 않는다.
		if (cands.some((c) => c.state.status === "failed")) return undefined;
		if (cands.length === 1) return cands[0]!.state;
		const first = cands[0]!.state;
		const same = cands.every((c) =>
			first.status === "done"
				? c.state.status === "done" && c.state.ko === first.ko
				: c.state.status === "pending",
		);
		return same ? first : undefined;
	}
}

/**
 * thinking 블록 밑에 붙는 컴포넌트. 매 프레임 저장소를 다시 조회하므로 번역이 나중에 도착해도
 * requestRender 한 번이면 바뀐다. 바뀐 게 없으면 같은 배열을 돌려준다(Container 메모 규약).
 */
export function createThinkingKoComponent(
	store: TranslationStore,
	displayText: string,
	contentIndex: number,
	theme: { fg(color: string, text: string): string },
): { render(width: number): string[]; invalidate(): void } {
	let cacheKey = "";
	let cache: string[] = [];
	return {
		render(width: number): string[] {
			const state = store.lookup(displayText, contentIndex);
			const retry = state?.status === "pending" && state.retry === true;
			const key = `${width}|${store.version}|${state?.status ?? "none"}|${retry}`;
			if (key === cacheKey) return cache;
			let rows: string[] = [];
			if (state?.status === "pending") {
				rows = [` ${theme.fg("muted", retry ? PENDING_THINKING_RETRY : PENDING_THINKING)}`];
			} else if (state?.status === "done") {
				rows = wrapDisplay(state.ko, width - RIGHT_GAP - 1).map((row) => (row ? ` ${theme.fg("text", row)}` : ""));
			}
			cacheKey = key;
			cache = rows;
			return rows;
		},
		invalidate(): void {
			cacheKey = "";
		},
	};
}

// ---- 화면 패치: 원문 대신 번역을 그린다 ----------------------------------------
//
// OMP 확장 API(18.2.11~18.3.0)에는 thinking·답변 본문을 바꿔 그리는 훅이 없다. 대신 확장이 받는
// 위젯 팩토리 인자(TUI 루트)에서 어시스턴트 메시지 컴포넌트를 찾아 그 클래스의
// `updateContent(message)`를 감싼다. 감싼 함수는 **표시용 사본**만 바꾼다(모델 문맥·세션 파일에
// 들어가는 메시지는 건드리지 않는다). 클래스 이름은 번들에서 줄여져 있어서 메서드 모양으로 찾는다.
// 패치를 못 하면(구조가 바뀐 OMP) thinking 렌더러 방식(원문 + 밑에 번역)으로 돌아간다.

/** 생각 번역을 기다리는 동안 원문 대신 보일 줄. */
export const PENDING_THINKING = "생각 옮기는 중..";
/** 아직 스트리밍 중인 생각(끝나기 전) 대신 보일 줄. */
export const STREAMING_THINKING = "생각 중..";
/** 답변 번역을 기다리는 동안 원문 끝에 붙는 줄. */
export const PENDING_ANSWER = "_옮기는 중.._";
/** 실패 뒤 재시도를 기다리는 동안(오래 걸릴 수 있음) 보일 줄. */
export const PENDING_THINKING_RETRY = "생각 옮기는 중.. (재시도)";
export const PENDING_ANSWER_RETRY = "_옮기는 중.. (재시도)_";

/**
 * 답변(text 블록) 식별자: 메시지 시각 + **원본 메시지 전체**에서의 content 위치 + 원문 해시.
 * 같은 메시지의 동일한 text 블록 둘도 따로 번역·캐시된다. 재개해도 같은 값이 나온다.
 * 화면은 도구 호출 앞뒤로 메시지를 잘라(조각) 그리므로, 조각 안 위치가 아니라 원본 위치를 써야 한다
 * (아래 `AnswerLocator`).
 */
export function answerId(timestamp: unknown, text: string, contentIndex = 0): string {
	return `a:${shortHash(`${String(timestamp ?? "")}|${contentIndex}|${text}`)}`;
}

/**
 * 표시 조각의 text 블록이 원본 메시지에서 몇 번째 content인지 찾는다. 찾을 수 없으면(모호하면)
 * undefined — 그 블록에는 번역을 붙이지 않는다(잘못된 번역보다 원문이 낫다).
 */
export class AnswerLocator {
	/** 원본 블록 객체 → {시각, 위치}. 같은 객체로 그려지는 경우(재개 등) 정확히 찾는다. */
	readonly #byRef = new WeakMap<object, { ts: unknown; ci: number }>();
	/** 시각 → 원본 메시지의 content 길이와 text 블록 목록 */
	readonly #byTs = new Map<string, { len: number; texts: Array<{ ci: number; text: string }> }>();

	record(message: any): void {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		const texts: Array<{ ci: number; text: string }> = [];
		message.content.forEach((b: any, ci: number) => {
			if (!b || typeof b !== "object") return;
			this.#byRef.set(b, { ts: message.timestamp, ci });
			if (b.type === "text" && typeof b.text === "string") texts.push({ ci, text: b.text });
		});
		this.#byTs.set(String(message.timestamp ?? ""), { len: message.content.length, texts });
	}

	clear(): void {
		this.#byTs.clear();
	}

	/** segIndex: 조각 content 안의 위치, segLen: 조각 content 길이 */
	locate(message: any, block: object, segIndex: number, segLen: number): number | undefined {
		const ref = this.#byRef.get(block);
		if (ref && ref.ts === message?.timestamp) return ref.ci;
		const full = this.#byTs.get(String(message?.timestamp ?? ""));
		if (!full) return undefined;
		// 조각이 아니라 메시지 전체를 그리는 경우: 위치가 같다.
		if (segLen === full.len) return segIndex;
		const text = (block as { text?: unknown }).text;
		const matches = full.texts.filter((t) => t.text === text);
		return matches.length === 1 ? matches[0]!.ci : undefined;
	}

	/**
	 * 원본 메시지 ci 위치의 text가 같은 원문 중 몇 번째인지(0부터). 7차 빌드 캐시(id에 이 순번을 썼다)를
	 * 재개 때 찾는 데만 쓴다. 원본을 모르면 undefined.
	 */
	occurrence(message: any, ci: number): number | undefined {
		const full = this.#byTs.get(String(message?.timestamp ?? ""));
		const text = full?.texts.find((t) => t.ci === ci)?.text;
		if (!full || text === undefined) return undefined;
		return full.texts.filter((t) => t.ci < ci && t.text === text).length;
	}
}

/** 앞뒤의 빈 줄만 떼어 낸다. 첫 줄 들여쓰기·줄 끝이 아닌 공백은 그대로 둔다(코드 답변 보존). */
export function trimBlankLines(text: string): string {
	return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

const SRC = "__thinkingKoSrc";

type AnyBlock = { type?: string; thinking?: string; rawThinking?: string; thinkingSignature?: string; text?: string; [SRC]?: AnyBlock };

/**
 * 표시용 메시지 사본을 만든다. 원 블록은 `__thinkingKoSrc`에 붙여 두어 여러 번 불려도(재렌더)
 * 항상 원문에서 다시 계산한다. 바꿀 게 없으면 받은 메시지를 그대로 돌려준다.
 * ids에는 이 메시지에서 본 블록 id를 모은다(번역 도착 시 어느 컴포넌트를 다시 그릴지 고른다).
 */
export function transformForDisplay(
	message: any,
	lookup: (id: string, ci?: number) => StoreState | undefined,
	/** 스트리밍 중인 메시지 timestamp(하나) 또는 그 집합 */
	streamingTimestamp: unknown,
	ids?: Set<string>,
	locator?: AnswerLocator,
): any {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const segLen = message.content.length;
	const content = message.content.map((raw: AnyBlock, segIndex: number) => {
		if (!raw || typeof raw !== "object") return raw;
		const base: AnyBlock = raw[SRC] ?? raw;
		if (base !== raw) changed = true;
		if (base.type === "thinking") {
			const src = String(base.rawThinking ?? base.thinking ?? "").trim();
			if (!src) return base;
			const id = blockId(src, base.thinkingSignature);
			ids?.add(id);
			const st = lookup(id);
			let repl: string | undefined;
			if (st?.status === "done") repl = st.ko;
			else if (st?.status === "pending") repl = st.retry ? PENDING_THINKING_RETRY : PENDING_THINKING;
			else if (!st && isStreaming(streamingTimestamp, message.timestamp)) repl = STREAMING_THINKING;
			if (repl === undefined) return base;
			changed = true;
			return { ...base, thinking: repl, rawThinking: base.rawThinking === undefined ? undefined : repl, [SRC]: base };
		}
		if (base.type === "text") {
			const src = String(base.text ?? "");
			if (!src.trim()) return base;
			// 원본 메시지에서의 위치. 조각으로 잘려 그려져도 원본 기준으로 찾고, 못 찾으면 원문 그대로.
			const ci = locator ? locator.locate(message, base, segIndex, segLen) : segIndex;
			if (ci === undefined) return base;
			const id = answerId(message.timestamp, src, ci);
			ids?.add(id);
			let st = lookup(id, ci);
			if (!st && locator) {
				// 7차 빌드가 남긴 캐시는 id에 content 위치 대신 "같은 원문 순번"을 썼다. 번역 완료 항목만 쓴다.
				const occ = locator.occurrence(message, ci);
				const legacy = occ !== undefined && occ !== ci ? lookup(answerId(message.timestamp, src, occ), ci) : undefined;
				if (legacy?.status === "done") st = legacy;
			}
			if (st?.status === "done") {
				changed = true;
				return { ...base, text: st.ko, [SRC]: base };
			}
			if (st?.status === "pending") {
				changed = true;
				return { ...base, text: `${src.trimEnd()}\n\n${st.retry ? PENDING_ANSWER_RETRY : PENDING_ANSWER}`, [SRC]: base };
			}
			return base;
		}
		return base;
	});
	return changed ? { ...message, content } : message;
}

function isStreaming(streaming: unknown, ts: unknown): boolean {
	if (streaming instanceof Set) return streaming.has(ts);
	return streaming !== undefined && ts === streaming;
}

/** 어시스턴트 메시지 컴포넌트인지(메서드 모양으로 판정). */
export function isAssistantComponent(o: any): boolean {
	return (
		!!o &&
		typeof o === "object" &&
		typeof o.updateContent === "function" &&
		typeof o.setHideThinkingBlock === "function" &&
		typeof o.setMidStreamPublication === "function" &&
		typeof o.invalidate === "function"
	);
}

/** 대화 기록 컨테이너(메서드 모양으로 찾는다). 없으면 undefined. */
export function findTranscriptContainer(root: any, seen = new Set<any>(), depth = 0): any {
	if (!root || typeof root !== "object" || seen.has(root) || depth > 60) return undefined;
	seen.add(root);
	if (
		typeof root.resetStableEmission === "function" &&
		typeof root.canRemoveBlock === "function" &&
		Array.isArray(root.children)
	) {
		return root;
	}
	const kids = root.children;
	if (Array.isArray(kids)) {
		for (const k of kids) {
			const found = findTranscriptContainer(k, seen, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

/** 컴포넌트 트리(children 배열)를 훑어 어시스턴트 메시지 컴포넌트를 모은다. */
export function findAssistantComponents(root: any, out: any[] = [], seen = new Set<any>(), depth = 0): any[] {
	if (!root || typeof root !== "object" || seen.has(root) || depth > 60) return out;
	seen.add(root);
	if (isAssistantComponent(root)) out.push(root);
	const kids = root.children;
	if (Array.isArray(kids)) for (const k of kids) findAssistantComponents(k, out, seen, depth + 1);
	return out;
}

/** 프로세스 전역 훅 자리. 패치는 클래스당 한 번만 하고, 확장 인스턴스는 이 함수만 바꿔 끼운다. */
const HOOK_KEY = "__thinkingKoDisplayHook";
const PATCHED_KEY = "__thinkingKoPatched";
type DisplayHook = (component: any, message: any) => any;

/** 컴포넌트 클래스의 updateContent를 감싼다. 이미 감쌌으면 그대로 둔다. 감쌌으면(또는 이미 감싸져 있으면) true. */
export function patchAssistantClass(component: any): boolean {
	const proto = Object.getPrototypeOf(component);
	if (!proto || typeof proto.updateContent !== "function") return false;
	if (proto[PATCHED_KEY]) return true;
	const original = proto.updateContent;
	proto.updateContent = function patchedUpdateContent(this: any, message: any, opts: any) {
		const hook = (globalThis as any)[HOOK_KEY] as DisplayHook | undefined;
		let shown = message;
		if (hook) {
			try {
				shown = hook(this, message);
			} catch {
				shown = message; // 번역 표시 실패가 화면을 깨뜨리지 않게
			}
		}
		return original.call(this, shown, opts);
	};
	Object.defineProperty(proto, PATCHED_KEY, { value: original, configurable: true });
	return true;
}

export function setDisplayHook(hook: DisplayHook | undefined): void {
	(globalThis as any)[HOOK_KEY] = hook;
}

// ---- 기록 재발행 스케줄러 ----------------------------------------------------------

export interface StableResetOptions {
	quietMs?: number;
	maxWaitMs?: number;
	minGapMs?: number;
	/** busy로 미룬 요청을 첫 요청부터 이만큼 넘기면 busy여도 실행한다(run(true)). */
	maxDeferMs?: number;
	now?: () => number;
	/** true면(메시지 스트리밍 중) 실행하지 않고 idle()까지 미룬다. */
	busy?: () => boolean;
	/** forced: busy 상한(maxDeferMs)에 걸려 스트리밍 중에 실행했으면 true */
	run: (forced: boolean) => void;
	schedule?: (fn: () => void, ms: number) => unknown;
	unschedule?: (handle: unknown) => void;
}

/**
 * 기록 재발행 요청을 모아 드물게 실행한다. request()는 여러 번 불러도 되고, 실행은
 * min(마지막 요청 + quiet, 첫 요청 + maxWait)을 기본으로 하되 직전 실행 + minGap보다 이르지 않다.
 * busy() 동안에는 실행하지 않고 idle()에서 한 번 실행한다(단 첫 요청부터 maxDeferMs가 지나면 강제 1회). cancel()은 대기 중인 요청을 버리고
 * 이미 예약된 타이머 콜백도 무효로 만든다(세션 전환·종료).
 */
export class StableResetScheduler {
	readonly #quiet: number;
	readonly #maxWait: number;
	readonly #minGap: number;
	readonly #maxDefer: number;
	readonly #now: () => number;
	readonly #busy: () => boolean;
	readonly #run: (forced: boolean) => void;
	readonly #schedule: (fn: () => void, ms: number) => unknown;
	readonly #unschedule: (handle: unknown) => void;
	#firstAt: number | undefined;
	#lastAt = 0;
	#lastRunAt = Number.NEGATIVE_INFINITY;
	#timer: unknown;
	#generation = 0;
	#runs = 0;

	constructor(o: StableResetOptions) {
		this.#quiet = o.quietMs ?? STABLE_RESET_QUIET_MS;
		this.#maxWait = o.maxWaitMs ?? STABLE_RESET_MAX_WAIT_MS;
		this.#minGap = o.minGapMs ?? STABLE_RESET_MIN_GAP_MS;
		this.#maxDefer = o.maxDeferMs ?? STABLE_RESET_MAX_DEFER_MS;
		this.#now = o.now ?? Date.now;
		this.#busy = o.busy ?? (() => false);
		this.#run = o.run;
		this.#schedule = o.schedule ?? ((fn, ms) => unrefTimer(setTimeout(fn, ms)));
		this.#unschedule = o.unschedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	get pending(): boolean {
		return this.#firstAt !== undefined;
	}
	get runs(): number {
		return this.#runs;
	}

	request(): void {
		const t = this.#now();
		if (this.#firstAt === undefined) this.#firstAt = t;
		this.#lastAt = t;
		this.#arm(false);
	}

	/** 스트리밍이 끝났을 때: 미뤄 둔 요청이 있으면 (최소 간격만 지켜) 바로 한 번 실행한다. */
	idle(): void {
		if (this.#firstAt !== undefined) this.#arm(true);
	}

	cancel(): void {
		this.#generation++;
		this.#clear();
		this.#firstAt = undefined;
	}

	#clear(): void {
		if (this.#timer !== undefined) this.#unschedule(this.#timer);
		this.#timer = undefined;
	}

	#arm(now: boolean): void {
		this.#clear();
		if (this.#firstAt === undefined) return;
		const t = this.#now();
		// 스트리밍 중이면 idle()을 기다리되, 영구 보류를 막으려고 maxDefer 시점에 한 번 깨어난다.
		let due = this.#busy()
			? this.#firstAt + this.#maxDefer
			: now
				? t
				: Math.min(this.#lastAt + this.#quiet, this.#firstAt + this.#maxWait);
		due = Math.max(due, this.#lastRunAt + this.#minGap);
		const gen = this.#generation;
		this.#timer = this.#schedule(() => this.#fire(gen), Math.max(0, due - t));
	}

	#fire(gen: number): void {
		if (gen !== this.#generation) return; // 세션이 바뀐 뒤 늦게 온 콜백
		this.#timer = undefined;
		if (this.#firstAt === undefined) return;
		let forced = false;
		if (this.#busy()) {
			if (this.#now() < this.#firstAt + this.#maxDefer) {
				this.#arm(false); // 아직 상한 전: 상한 시점으로 다시 예약(그 전에 idle()이 오면 그때 실행)
				return;
			}
			forced = true;
		}
		this.#firstAt = undefined;
		this.#lastRunAt = this.#now();
		this.#runs++;
		this.#run(forced);
	}
}

// ---- 로그 ---------------------------------------------------------------------
function defaultLog(line: string): void {
	try {
		try {
			if (statSync(LOG_PATH).size > LOG_MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.old`);
		} catch {
			// 로그 파일이 아직 없음
		}
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${redact(line)}\n`);
	} catch {
		// 로그 실패는 무시한다.
	}
}

// ---- 확장 본체 ----------------------------------------------------------------
type AnyModel = { provider: string; id: string; api?: string };
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 모델 호출 결과(테스트에서는 가짜로 바꿔 끼운다). */
export interface ModelReply {
	raw: string;
	provider: string;
	model: string;
}

/** 테스트용 주입점. OMP는 두 번째 인자 없이 부른다. */
export interface ThinkingKoDeps {
	/** 인증·모듈 준비(타임아웃 안에서 불린다). */
	prepare?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<unknown>;
	/** 번역 요청 한 번. 슬롯·헤징 안에서 불린다. */
	call?: (prepared: unknown, source: string, signal: AbortSignal, kind: TranslationKind) => Promise<ModelReply>;
	log?: (line: string) => void;
	now?: () => number;
	slots?: Slots;
	/** 답변 풀 슬롯(기본 ANSWER_INFLIGHT_REQUESTS) */
	answerSlots?: Slots;
	/** 실패 뒤 재시도 대기(ms, 기본 RETRY_DELAY_MS) */
	retryDelayMs?: number;
	timeoutMs?: (source: string) => number;
	hedgeAfterMs?: number;
	/** 기록 재발행 빈도(기본 STABLE_RESET_* 상수) */
	stableReset?: { quietMs?: number; maxWaitMs?: number; minGapMs?: number; maxDeferMs?: number };
}

interface RealPrepared {
	model: AnyModel;
	apiKey: unknown;
	ai: { completeSimple(model: unknown, context: unknown, options: unknown): Promise<any> };
}

export function buildMessages(model: AnyModel, source: string, kind: TranslationKind = "thinking"): unknown[] {
	const t = Date.now();
	const messages: unknown[] = [];
	for (const shot of kind === "answer" ? ANSWER_FEW_SHOT : FEW_SHOT) {
		messages.push({ role: "user", content: shot.en, timestamp: t });
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: shot.ko }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: t,
		});
	}
	messages.push({ role: "user", content: source, timestamp: t });
	return messages;
}

async function realPrepare(ctx: ExtensionContext, signal: AbortSignal): Promise<RealPrepared> {
	const model = ctx.models.resolve(MODEL) as unknown as AnyModel | undefined;
	if (!model) throw new Error(`model ${MODEL} not available`);
	const ai = (await import("@oh-my-pi/pi-ai")) as unknown as RealPrepared["ai"];
	signal.throwIfAborted();
	const apiKey = await ctx.modelRegistry.getApiKey(model as never, undefined, { signal });
	if (apiKey === undefined) throw new Error(`no credentials for ${model.provider}`);
	return { model, apiKey, ai };
}

/** 번역 출력 토큰 상한: 원문 토큰 추정(글자 수/2, 넉넉히) ×2 + 512, 최소 2048·최대 16384. */
export function maxTokensFor(source: string): number {
	const est = Math.ceil(source.length / 2);
	return Math.min(MAX_OUTPUT_TOKENS, Math.max(2048, est * 2 + 512));
}

/**
 * 모델 결과를 번역문으로 바꾼다. 정상 종료(stop/end_turn)가 아니면 실패로 던진다. 특히 출력
 * 상한에 걸려 잘린 번역(length/max_tokens)을 성공으로 캐시·표시하지 않기 위해서다(재시도 대상).
 */
export function replyFromResult(r: any, model: AnyModel): ModelReply {
	const stop = String(r?.stopReason ?? "");
	if (stop !== "stop" && stop !== "end_turn") {
		const why = stop === "length" || stop === "max_tokens" ? "truncated" : stop || "unknown";
		throw new Error(`bad stop reason: ${why}${r?.errorMessage ? ` (${r.errorMessage})` : ""}`);
	}
	const raw = (r?.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("");
	return { raw, provider: r?.provider ?? model.provider, model: r?.model ?? model.id };
}

async function realCall(prepared: unknown, source: string, signal: AbortSignal, kind: TranslationKind): Promise<ModelReply> {
	const { model, apiKey, ai } = prepared as RealPrepared;
	const r = await ai.completeSimple(
		model,
		{ systemPrompt: [kind === "answer" ? ANSWER_SYSTEM_PROMPT : SYSTEM_PROMPT], messages: buildMessages(model, source, kind) },
		{ apiKey, maxTokens: maxTokensFor(source), disableReasoning: true, signal },
	);
	return replyFromResult(r, model);
}

const ANSWER_HEADER_LINE = /^(번역|Translation)[ \t]*[:：][ \t]*$/i;
const ANSWER_HEADER_BEFORE_HANGUL = /^(번역|Translation)[ \t]*[:：][ \t]+(?=[가-힣])/i;

/**
 * 생각·답변 번역 결과 정리: 앞뒤 빈 줄을 떼고, 모델이 붙인 "번역:" 머리말은 확실할 때만 뗀다.
 * - 들여쓰기 없는 첫 줄이 머리말뿐이면("번역:") 그 줄을 뗀다.
 * - 들여쓰기 없는 첫 줄이 "번역: " 뒤에 한글로 이어지면 그 접두만 뗀다.
 * 첫 줄이 공백·탭으로 시작하거나 펜스이거나, 머리말 뒤가 한글이 아니면(`Translation: string;` 같은 코드)
 * 건드리지 않는다. 들여쓰기·코드는 그대로 둔다.
 */
export function cleanAnswer(raw: string): string {
	const text = trimBlankLines(raw);
	const nl = text.indexOf("\n");
	const first = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, "");
	if (ANSWER_HEADER_LINE.test(first)) return nl < 0 ? "" : trimBlankLines(text.slice(nl + 1));
	const prefix = first.match(ANSWER_HEADER_BEFORE_HANGUL)?.[0];
	return prefix ? text.slice(prefix.length) : text;
}

export default function thinkingKo(pi: ExtensionAPI, deps: ThinkingKoDeps = {}): void {
	if (!ENABLED || process.env.THINKING_KO === "0") return;
	// 비대화(print) 모드 실측용. 평소엔 UI가 있는 세션(메인 TUI)에서만 번역한다.
	const force = process.env.THINKING_KO_FORCE === "1";
	const log = deps.log ?? defaultLog;
	const now = deps.now ?? Date.now;
	const prepare = deps.prepare ?? realPrepare;
	const call = deps.call ?? realCall;
	const pools: Record<TranslationKind, Slots> = {
		thinking: deps.slots ?? new Slots(MAX_INFLIGHT_REQUESTS),
		answer: deps.answerSlots ?? new Slots(ANSWER_INFLIGHT_REQUESTS),
	};
	const retryDelay = deps.retryDelayMs ?? RETRY_DELAY_MS;
	const deadlineFor = deps.timeoutMs ?? timeoutFor;
	const hedgeAfter = deps.hedgeAfterMs ?? HEDGE_AFTER_MS;

	const store = new TranslationStore();
	let uiCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	/** 큐 항목 id → {블록 id, 종류, 표시 키, contentIndex, 원문, 몇 번째 시도} */
	type Job = { block: string; kind: TranslationKind; key: string; ci: number; source: string; attempt: number };
	const meta = new Map<string, Job>();
	/** 재시도를 기다리는 블록 id → {작업, 타이머} */
	const waitingRetry = new Map<string, { job: Job; timer: ReturnType<typeof setTimeout> }>();

	// ---- 화면 패치 상태 ----
	let tui: any;
	let patched = false;
	/** 스트리밍 중인 어시스턴트 메시지(timestamp). 여럿이 겹칠 수 있다(병렬 세션·하위 에이전트 등). */
	const streaming = new Set<unknown>();
	/** 컴포넌트 → 그 컴포넌트가 마지막으로 그린 블록 id들 */
	const seenIds = new WeakMap<object, Set<string>>();
	const liveComponents = new Set<WeakRef<object>>();
	const locator = new AnswerLocator();
	/** 대화 기록 컨테이너(이미 터미널 기록으로 내보낸 블록을 다시 내보내게 할 때 쓴다) */
	let transcript: any;
	const stableReset = new StableResetScheduler({
		...deps.stableReset,
		now,
		// 어시스턴트 메시지가 스트리밍 중이면 재발행을 그 메시지가 끝날 때까지 미룬다.
		busy: () => streaming.size > 0,
		run: (forced) => {
			if (!transcript) return;
			if (forced) log(`stable-reset forced streaming=${streaming.size} after>=${deps.stableReset?.maxDeferMs ?? STABLE_RESET_MAX_DEFER_MS}ms`);
			try {
				const t0 = now();
				transcript.resetStableEmission();
				tui?.resetDisplay?.();
				log(`stable-reset count=${stableReset.runs} ms=${now() - t0}`);
			} catch (e) {
				log(`stable-reset failed err=${JSON.stringify(String(e).slice(0, 200))}`);
			}
		},
	});

	function displayHook(component: any, message: any): any {
		const ids = new Set<string>();
		const shown = transformForDisplay(message, (id, ci) => store.get(id, ci), streaming, ids, locator);
		if (!seenIds.has(component)) liveComponents.add(new WeakRef(component));
		seenIds.set(component, ids);
		return shown;
	}

	function ensurePatched(): boolean {
		if (patched) return true;
		if (!tui) return false;
		try {
			const comps = findAssistantComponents(tui);
			if (comps.length === 0) return false;
			if (!patchAssistantClass(comps[0])) return false;
			setDisplayHook(displayHook);
			patched = true;
			transcript = findTranscriptContainer(tui);
			log(`display-patch installed components=${comps.length}`);
			if (!transcript) log("stable-reset unavailable");
			for (const c of comps) c.invalidate();
			tui.requestRender?.();
			return true;
		} catch (e) {
			log(`display-patch failed err=${JSON.stringify(String(e).slice(0, 200))}`);
			return false;
		}
	}

	let patchTimer: ReturnType<typeof setTimeout> | undefined;
	/** 패치 재시도를 예약한다(여러 번 불려도 한 번만 돈다). */
	function schedulePatch(ms: number): void {
		if (patched || patchTimer) return;
		patchTimer = unrefTimer(
			setTimeout(() => {
				patchTimer = undefined;
				ensurePatched();
			}, ms),
		);
	}

	/** 번역이 바뀐 블록을 그린 컴포넌트만 다시 그린다. */
	function refresh(id?: string): void {
		try {
			if (patched) {
				for (const ref of liveComponents) {
					const comp = ref.deref() as any;
					if (!comp) {
						liveComponents.delete(ref);
						continue;
					}
					if (id === undefined || seenIds.get(comp)?.has(id)) {
						comp.invalidate();
						// 이미 터미널 기록(native scrollback)으로 나간 블록은 invalidate로 안 바뀐다.
						// 그런 블록의 번역이 도착했을 때만 기록을 지우고 다시 내보낸다.
						if (id !== undefined && isPublished(comp)) scheduleStableReset();
					}
				}
				tui?.requestRender?.();
				return;
			}
			if (requestRender) requestRender();
			else if (uiCtx?.hasUI) uiCtx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// 화면 갱신 실패는 무시
		}
	}

	/** 컴포넌트가 이미 터미널 기록으로 나갔는지(대화 컨테이너가 더는 지울 수 없는 블록인지). */
	function isPublished(comp: any): boolean {
		try {
			return !!transcript && transcript.canRemoveBlock(comp) === false && transcript.children?.includes?.(comp) === true;
		} catch {
			return false;
		}
	}

	/** 기록 재발행은 비싸니(화면 전체 다시 그림) 모아서 드물게 한다(StableResetScheduler). */
	function scheduleStableReset(): void {
		if (transcript) stableReset.request();
	}

	// 패치를 못 했을 때만 쓰는 대체 표시: 원문 밑에 번역을 덧붙인다.
	pi.registerAssistantThinkingRenderer((rc, theme) => {
		requestRender = rc.requestRender;
		if (patched) return undefined;
		// 재개 직후처럼 메시지 이벤트 없이 기록이 그려질 때: 컴포넌트가 생긴 지금 패치를 다시 시도한다.
		schedulePatch(0);
		return createThinkingKoComponent(store, rc.text, rc.contentIndex, theme as never);
	});

	async function translate(source: string, signal: AbortSignal, id?: string): Promise<string> {
		const ctx = uiCtx;
		if (!ctx) throw new Error("no context");
		const job = id ? meta.get(id) : undefined;
		const kind: TranslationKind = job?.kind ?? "thinking";
		const started = now();
		try {
			const { reply, attempt } = await withDeadline(deadlineFor(source), signal, async (dl) => {
				const prepared = await prepare(ctx, dl);
				const { value, attempt } = await hedged((s) => call(prepared, source, s, kind), hedgeAfter, pools[kind], dl);
				return { reply: value, attempt };
			});
			// 생각·답변 모두 코드·마크다운을 보존한다. 말투·ㅆ→ㅅ은 공통 프롬프트에서만 맞춘다.
			const text = cleanAnswer(reply.raw);
			if (!text) throw new Error("empty translation");
			log(
				`ok kind=${kind} try=${job?.attempt ?? 1} provider=${reply.provider} model=${reply.model} ms=${now() - started} attempt=${attempt} in=${source.length} out=${text.length} ko=${JSON.stringify(clip(text, LOG_KO_CHARS))}`,
			);
			return text;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`fail kind=${kind} try=${job?.attempt ?? 1} model=${MODEL} ms=${now() - started} in=${source.length} err=${JSON.stringify(msg.slice(0, 200))}`);
			throw e;
		}
	}

	function onResult(item: TranslatedItem): void {
		const job = meta.get(item.id);
		meta.delete(item.id);
		if (!job) return;
		if (item.ok) {
			store.setDone(job.block, job.key, job.ci, item.text);
			try {
				const data: CacheEntryData = { v: 3, kind: job.kind, id: job.block, k: job.key, ci: job.ci, ko: item.text };
				pi.appendEntry(ENTRY_TYPE, data);
			} catch (e) {
				log(`fail cache-append err=${JSON.stringify(String(e).slice(0, 200))}`);
			}
			refresh(job.block);
			// 번역이 하나 성공했으면 재시도를 기다리던 블록을 바로 다시 보낸다.
			fireAllRetries("after-success");
			return;
		}
		if (item.error !== "queue overflow" && job.attempt < MAX_ATTEMPTS) {
			// 실패: 한 번 더 시도한다. 기다리는 동안은 "옮기는 중.. (재시도)"를 보인다.
			store.setPending(job.block, job.key, job.ci, true);
			const next: Job = { ...job, attempt: job.attempt + 1 };
			const timer = unrefTimer(setTimeout(() => fireRetry(job.block, "timer"), retryDelay));
			waitingRetry.set(job.block, { job: next, timer });
			log(`retry scheduled kind=${job.kind} in=${job.source.length} after<=${retryDelay}ms err=${JSON.stringify(String(item.error ?? "").slice(0, 120))}`);
			refresh(job.block);
			return;
		}
		// 마지막 시도까지 실패: 원문을 그대로 보인다. 저장소에는 failed로 남긴다(다른 블록 번역이 잘못 붙지 않게).
		store.setFailed(job.block, job.key, job.ci);
		refresh(job.block);
	}

	function makeQueue(kind: TranslationKind): OrderedTranslator {
		return new OrderedTranslator({
			translate,
			concurrency: kind === "answer" ? ANSWER_INFLIGHT_REQUESTS : CONCURRENCY,
			maxPending: MAX_PENDING_BLOCKS,
			onDrop: (item) => log(`drop reason=queue-overflow kind=${kind} max=${MAX_PENDING_BLOCKS} in=${item.source.length}`),
			onResult,
		});
	}
	const queues: Record<TranslationKind, OrderedTranslator> = { thinking: makeQueue("thinking"), answer: makeQueue("answer") };

	function submit(job: Job): boolean {
		const qid = job.attempt > 1 ? `${job.block}#${job.attempt}` : job.block;
		meta.set(qid, job);
		if (!queues[job.kind].push(qid, job.source)) {
			meta.delete(qid);
			return false;
		}
		return true;
	}

	function fireRetry(block: string, why: string): void {
		const w = waitingRetry.get(block);
		if (!w) return;
		clearTimeout(w.timer);
		waitingRetry.delete(block);
		log(`retry start kind=${w.job.kind} why=${why} in=${w.job.source.length}`);
		if (!submit(w.job)) {
			store.setFailed(block, w.job.key, w.job.ci);
			refresh(block);
		}
	}

	function fireAllRetries(why: string): void {
		for (const block of [...waitingRetry.keys()]) fireRetry(block, why);
	}

	function enqueue(id: string, kind: TranslationKind, key: string, ci: number, source: string): void {
		if (store.has(id)) return;
		store.setPending(id, key, ci);
		if (!submit({ block: id, kind, key, ci, source, attempt: 1 })) return;
		refresh(id);
	}

	function resetAll(ctx: ExtensionContext): void {
		// 이전 세션 화면에 대한 재발행 예약은 버린다(늦게 온 타이머 콜백도 무효).
		stableReset.cancel();
		queues.thinking.reset();
		queues.answer.reset();
		for (const w of waitingRetry.values()) clearTimeout(w.timer);
		waitingRetry.clear();
		meta.clear();
		store.clear();
		locator.clear();
		streaming.clear();
		uiCtx = ctx;
		try {
			const entries = ctx.sessionManager.getEntries() as unknown[];
			for (const e of entries as Array<{ type?: string; message?: unknown }>) {
				if (e?.type === "message") locator.record(e.message);
			}
			const n = store.load(entries);
			store.registerUntranslated(entries);
			if (n) log(`cache-load entries=${n}`);
		} catch {
			// 세션 항목을 못 읽으면 캐시 없이 간다.
		}
		if (ctx.hasUI) {
			try {
				// 위젯 팩토리가 받는 첫 인자가 TUI 루트다. 빈 위젯(편집기 아래, 0줄)으로 그 참조만 얻는다.
				ctx.ui.setWidget(
					WIDGET_KEY,
					(t: unknown) => {
						tui = t;
						return { render: () => [], invalidate() {} };
					},
					{ placement: "belowEditor" },
				);
			} catch {
				// 위젯을 못 달면 렌더러 대체 표시로 간다.
			}
		}
		// 재개 때는 기록 컴포넌트가 session_start 뒤에 그려지므로 몇 번 더 시도한다.
		if (!ensurePatched()) for (const ms of PATCH_RETRY_MS) unrefTimer(setTimeout(() => ensurePatched(), ms));
		refresh();
	}

	pi.on("session_start", (_e, ctx) => resetAll(ctx));
	pi.on("session_switch", (_e, ctx) => resetAll(ctx));
	// 중단·오류로 message_end 없이 끝나도 스트리밍 표시·미룬 재발행이 남지 않게 한다.
	pi.on("agent_end", () => {
		streaming.clear();
		stableReset.idle();
	});
	pi.on("session_shutdown", () => {
		streaming.clear();
		stableReset.cancel();
		transcript = undefined;
	});

	pi.on("message_start", (event) => {
		const msg = event.message as { role?: string; timestamp?: unknown };
		if (msg?.role === "assistant") streaming.add(msg.timestamp);
		ensurePatched();
	});

	pi.on("message_update", (event, ctx) => {
		ensurePatched();
		const ev = event.assistantMessageEvent as { type?: string; contentIndex?: number; content?: string } | undefined;
		if (ev?.type !== "thinking_end") return;
		if (!ctx.hasUI && !force) return;
		const source = (ev.content ?? "").trim();
		if (!source) return;
		uiCtx = ctx;
		const ci = ev.contentIndex ?? 0;
		const block = (event.message as { content?: Array<{ thinkingSignature?: string }> }).content?.[ci];
		// 블록마다 따로 번역·캐시한다(서명 해시 우선, 없으면 원문 전체 해시). 코드만 있는 블록도 번역한다.
		enqueue(blockId(source, block?.thinkingSignature), "thinking", thinkingKey(source), ci, source);
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message as { role?: string; timestamp?: unknown; content?: Array<{ type?: string; text?: string }> };
		if (msg?.role !== "assistant") return;
		streaming.delete(msg.timestamp);
		// 스트리밍 중이라 미룬 재발행이 있으면, 남은 스트리밍 메시지가 없을 때 한 번
		if (streaming.size === 0) stableReset.idle();
		ensurePatched();
		if (!ctx.hasUI && !force) return;
		uiCtx = ctx;
		locator.record(msg);
		(msg.content ?? []).forEach((b, ci) => {
			if (b?.type !== "text" || typeof b.text !== "string" || !b.text.trim()) return;
			// 답변은 들여쓰기를 지키려고 앞뒤 빈 줄만 뗀다(trim 안 함).
			enqueue(answerId(msg.timestamp, b.text, ci), "answer", "", ci, trimBlankLines(b.text));
		});
		refresh();
	});
}
