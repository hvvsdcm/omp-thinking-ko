import test from "node:test";
import assert from "node:assert/strict";
import {
	softenEndings,
	cleanTranslation,
	timeoutFor,
	hedged,
	Slots,
	withDeadline,
	redact,
	TranslationStore,
	createThinkingKoComponent,
	thinkingKey,
	blockId,
	ENTRY_TYPE,
	MAX_INFLIGHT_REQUESTS,
	MAX_PENDING_BLOCKS,
	clip,
	wrapDisplay,
	cellWidth,
	OrderedTranslator,
	TIMEOUT_MS,
} from "./thinking-ko.ts";
import thinkingKo from "./thinking-ko.ts";

test("softenEndings: 사양 예시", () => {
	assert.equal(softenEndings("오류를 찾았어. 고쳐볼게."), "오류를 찾앗어. 고쳐볼게.");
	assert.equal(softenEndings("파일을 썼다"), "파일을 썻다");
	assert.equal(softenEndings("있는 파일"), "있는 파일");
});

test("softenEndings: 여러 종결·연결 어미", () => {
	assert.equal(softenEndings("거기 있어"), "거기 잇어");
	assert.equal(softenEndings("벌써 했어!!"), "벌써 햇어!!");
	assert.equal(softenEndings("빌드 됐네"), "빌드 됏네");
	assert.equal(softenEndings("고쳤지만 또 터졌거든"), "고쳣지만 또 터졋거든");
	assert.equal(softenEndings("봤는데 없었음"), "봣는데 없엇음");
	assert.equal(softenEndings("하겠다고"), "하겠다고", "어미 뒤에 더 붙으면 건드리지 않는다");
	assert.equal(softenEndings("해봐야겠다."), "해봐야겟다.");
	assert.equal(softenEndings("했었어"), "햇엇어");
	assert.equal(softenEndings("있고 없고"), "잇고 없고");
});

test("softenEndings: 어절 중간과 비한글은 그대로", () => {
	assert.equal(softenEndings("있으면 쓰자"), "있으면 쓰자");
	assert.equal(softenEndings("settings.json 고쳤어"), "settings.json 고쳣어");
	assert.equal(softenEndings("hello world"), "hello world");
	assert.equal(softenEndings("다"), "다");
	assert.equal(softenEndings("아!! 시발 오류를 찾앗어.. 고쳐볼게."), "아!! 시발 오류를 찾앗어.. 고쳐볼게.");
});

test("cleanTranslation", () => {
	assert.equal(cleanTranslation("```\n버그 찾앗어\n```"), "버그 찾앗어");
	assert.equal(cleanTranslation("번역: 버그 찾앗어"), "버그 찾앗어");
	assert.equal(cleanTranslation("\"버그 찾앗어\""), "버그 찾앗어");
	assert.equal(cleanTranslation("  **제목**\n\n본문  "), "**제목**\n\n본문");
});

test("timeoutFor / clip", () => {
	assert.equal(timeoutFor("a".repeat(10)), TIMEOUT_MS);
	assert.equal(timeoutFor("a".repeat(1000)), TIMEOUT_MS);
	assert.ok(timeoutFor("a".repeat(2500)) > TIMEOUT_MS);
	assert.equal(clip("가나다라", 2), "가나…");
	assert.equal(clip("가나", 2), "가나");
});


const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("OrderedTranslator: 늦게 끝난 앞 블록이 먼저 나온다", async () => {
	const out = [];
	const q = new OrderedTranslator({
		concurrency: 2,
		translate: async (t) => {
			await delay(t === "A" ? 60 : 5);
			return `ko:${t}`;
		},
		onResult: (i) => out.push(i.text),
	});
	q.push("1", "A");
	q.push("2", "B");
	q.push("3", "C");
	await delay(150);
	assert.deepEqual(out, ["ko:A", "ko:B", "ko:C"]);
	assert.equal(q.pending, 0);
});

test("OrderedTranslator: 실패하면 원문, 뒤 블록은 계속", async () => {
	const out = [];
	const q = new OrderedTranslator({
		concurrency: 1,
		translate: async (t) => {
			if (t === "bad") throw new Error("boom");
			return `ko:${t}`;
		},
		onResult: (i) => out.push([i.text, i.ok]),
	});
	q.push("1", "bad");
	q.push("2", "good");
	await delay(20);
	assert.deepEqual(out, [
		["bad", false],
		["ko:good", true],
	]);
});

test("OrderedTranslator: 동기 throw도 원문으로 처리", async () => {
	const out = [];
	const q = new OrderedTranslator({
		translate: () => {
			throw new Error("sync");
		},
		onResult: (i) => out.push(i.ok),
	});
	q.push("1", "x");
	await delay(5);
	assert.deepEqual(out, [false]);
});

test("OrderedTranslator: 동시 실행 수 제한과 중복 id 무시", async () => {
	let running = 0;
	let peak = 0;
	const q = new OrderedTranslator({
		concurrency: 2,
		translate: async (t) => {
			running++;
			peak = Math.max(peak, running);
			await delay(10);
			running--;
			return t;
		},
		onResult: () => {},
	});
	for (let i = 0; i < 6; i++) q.push(String(i), `t${i}`);
	assert.equal(q.push("0", "again"), false);
	await delay(80);
	assert.equal(peak, 2);
	assert.equal(q.pending, 0);
});

test("OrderedTranslator: reset 뒤 이전 결과는 버린다", async () => {
	const out = [];
	const q = new OrderedTranslator({
		translate: async (t) => {
			await delay(20);
			return t;
		},
		onResult: (i) => out.push(i.text),
	});
	q.push("1", "old");
	q.reset();
	q.push("1", "new");
	await delay(60);
	assert.deepEqual(out, ["new"]);
});

const widthOf = (s) => Array.from(s).reduce((n, ch) => n + cellWidth(ch), 0);

test("cellWidth: 한글 2칸, ASCII 1칸", () => {
	assert.equal(cellWidth("가"), 2);
	assert.equal(cellWidth("a"), 1);
	assert.equal(cellWidth("."), 1);
});

test("wrapDisplay: 폭을 넘지 않고 공백에서 끊는다", () => {
	const text = "버그 보엿어. is_even이 짝수 대신 홀수 검사하고 잇고, mean은 len 대신 len-1로 나눠서 틀렷네. 하나씩 고치고 매번 테스트해봐야겟다.";
	for (const cols of [20, 37, 60, 115]) {
		const rows = wrapDisplay(text, cols);
		for (const r of rows) assert.ok(widthOf(r) <= cols, `${cols}: ${r} (${widthOf(r)})`);
		assert.equal(rows.join(" ").replace(/ +/g, " "), text);
	}
});

test("wrapDisplay: 줄바꿈 유지, 긴 단어는 글자 단위로 자름", () => {
	assert.deepEqual(wrapDisplay("**제목**\n\n본문", 40), ["**제목**", "", "본문"]);
	const rows = wrapDisplay("a".repeat(25), 10);
	assert.deepEqual(rows, ["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
	const ko = wrapDisplay("가".repeat(9), 10);
	assert.deepEqual(ko, ["가가가가가", "가가가가"]);
});

// ---- 리뷰 지적 재현 테스트 -------------------------------------------------------

test("softenEndings: 파일명·식별자 조각은 그대로, 문장 끝 부호 뒤는 치환", () => {
	assert.equal(softenEndings("있어_flag"), "있어_flag");
	assert.equal(softenEndings("있어.txt"), "있어.txt");
	assert.equal(softenEndings("path/있어/x"), "path/있어/x");
	assert.equal(softenEndings("있어-flag"), "있어-flag");
	assert.equal(softenEndings("있어abc"), "있어abc");
	assert.equal(softenEndings("찾았어."), "찾앗어.");
	assert.equal(softenEndings("찾았어.."), "찾앗어..");
	assert.equal(softenEndings("찾았어!!"), "찾앗어!!");
	assert.equal(softenEndings("(파일 썼다)"), "(파일 썻다)");
	assert.equal(softenEndings("**고쳤어**"), "**고쳣어**");
	assert.equal(softenEndings("다 됐어\n다음"), "다 됏어\n다음");
});

test("redact: 토큰류 가림", () => {
	const line = `err="Authorization: Bearer abc.def-123 ya29.a0AfB_x-y sk-live_12345 AIzaSyD-xyz ${"q".repeat(40)} ok"`;
	const out = redact(line);
	for (const bad of ["abc.def-123", "ya29.", "sk-live", "AIzaSy", "q".repeat(40)]) {
		assert.ok(!out.includes(bad), `${bad} 남음: ${out}`);
	}
	assert.match(out, /Bearer \[redacted\]/);
	assert.equal(
		redact("provider=google-antigravity model=gemini-3.8-flash"),
		"provider=google-antigravity model=gemini-3.8-flash",
	);
});

test("Slots: 상한·대기·abort 시 대기열 이탈", async () => {
	const slots = new Slots(2);
	const r1 = slots.tryAcquire();
	const r2 = slots.tryAcquire();
	assert.ok(r1 && r2);
	assert.equal(slots.tryAcquire(), undefined);
	const c = new AbortController();
	const waiting = slots.acquire(c.signal);
	c.abort(new Error("stop"));
	await assert.rejects(waiting, /stop/);
	assert.equal(slots.waiting, 0);
	const later = slots.acquire();
	r1();
	r1(); // 두 번 불러도 한 번만 반영
	const r3 = await later;
	assert.equal(slots.used, 2);
	r2();
	r3();
	assert.equal(slots.used, 0);
});

test("withDeadline: 준비 단계(인증 조회 등)까지 시간 제한에 들어간다", async () => {
	let aborted = false;
	await assert.rejects(
		withDeadline(40, undefined, async (signal) => {
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			await delay(500); // 멈춘 getApiKey 흉내
			return "never";
		}),
		/timeout 40ms/,
	);
	assert.equal(aborted, true);
	assert.equal(await withDeadline(100, undefined, async () => "ok"), "ok");
	const parent = new AbortController();
	const p = withDeadline(1000, parent.signal, () => delay(500));
	parent.abort(new Error("reset"));
	await assert.rejects(p, /reset/);
});

test("hedged: 빈 슬롯이 있으면 헤징, 늦은 첫 요청은 abort", async () => {
	const slots = new Slots(2);
	let firstAborted = false;
	let n = 0;
	const r = await hedged(
		async (signal) => {
			if (++n === 1) {
				signal.addEventListener("abort", () => {
					firstAborted = true;
				});
				await delay(300);
				return "slow";
			}
			await delay(10);
			return "fast";
		},
		20,
		slots,
	);
	assert.deepEqual(r, { value: "fast", attempt: 2 });
	assert.equal(firstAborted, true);
});

test("hedged: 슬롯이 없으면 헤징하지 않는다", async () => {
	const slots = new Slots(1);
	let calls = 0;
	const r = await hedged(
		async () => {
			calls++;
			await delay(60);
			return "one";
		},
		10,
		slots,
	);
	assert.deepEqual(r, { value: "one", attempt: 1 });
	assert.equal(calls, 1);
});

test("hedged: 첫 요청 실패 시 재시도, 둘 다 실패하면 에러, signal abort면 거부", async () => {
	const slots = new Slots(2);
	let n = 0;
	const ok = await hedged(
		async () => {
			if (++n === 1) throw new Error("boom");
			return "ok";
		},
		1000,
		slots,
	);
	assert.equal(ok.value, "ok");
	await assert.rejects(
		hedged(
			async () => {
				throw new Error("nope");
			},
			10,
			slots,
		),
		/nope/,
	);
	const c = new AbortController();
	const p = hedged(() => delay(300).then(() => "x"), 1000, slots, c.signal);
	await delay(5); // 요청이 실제로 시작된 뒤에 끊는다
	c.abort(new Error("cut"));
	await assert.rejects(p, /cut/);
	assert.equal(slots.used, 1); // abort됐어도 요청이 끝나기 전에는 슬롯을 쥐고 있다
	await delay(350); // delay(300)이 끝나면 그때 돌려준다
	assert.equal(slots.used, 0);
});

test("P1 재현: 블록 3개 연속 투입 시 전체 요청 동시 수 ≤ 2 (헤징 포함)", async () => {
	const slots = new Slots(MAX_INFLIGHT_REQUESTS);
	let inflight = 0;
	let peak = 0;
	const call = async (signal) => {
		inflight++;
		peak = Math.max(peak, inflight);
		try {
			await new Promise((resolve, reject) => {
				const t = setTimeout(resolve, 80);
				signal.addEventListener("abort", () => {
					clearTimeout(t);
					reject(new Error("aborted"));
				});
			});
			return "ko";
		} finally {
			inflight--;
		}
	};
	const out = [];
	const q = new OrderedTranslator({
		concurrency: 2,
		translate: (src, signal) =>
			withDeadline(2000, signal, (dl) => hedged(call, 10, slots, dl)).then((r) => `${r.value}:${src}`),
		onResult: (i) => out.push(i.text),
	});
	q.push("1", "a");
	q.push("2", "b");
	q.push("3", "c");
	await delay(1600);
	assert.deepEqual(out, ["ko:a", "ko:b", "ko:c"]);
	assert.ok(peak <= 2, `peak=${peak}`);
	assert.ok(slots.peak <= 2, `slots.peak=${slots.peak}`);
	assert.equal(slots.used, 0);
});

test("reset: 진행 중 요청을 abort하고 카운터를 비운다", async () => {
	const slots = new Slots(2);
	let aborts = 0;
	const q = new OrderedTranslator({
		concurrency: 2,
		translate: (_src, signal) =>
			hedged(
				(s) =>
					new Promise((_, reject) =>
						s.addEventListener("abort", () => {
							aborts++;
							reject(new Error("aborted"));
						}),
					),
				5000,
				slots,
				signal,
			),
		onResult: () => {},
	});
	q.push("1", "a");
	q.push("2", "b");
	await delay(10);
	assert.equal(slots.used, 2);
	q.reset();
	await delay(10);
	assert.equal(aborts, 2);
	assert.equal(q.running, 0);
	assert.equal(q.pending, 0);
	assert.equal(slots.used, 0);
});

test("대기 상한: 넘치면 가장 오래된 미처리 블록을 원문으로 확정하고 알린다", async () => {
	const dropped = [];
	const out = [];
	const q = new OrderedTranslator({
		concurrency: 1,
		maxPending: 2,
		translate: (src, signal) =>
			new Promise((resolve, reject) => {
				const t = setTimeout(() => resolve(`ko:${src}`), 30);
				signal.addEventListener("abort", () => {
					clearTimeout(t);
					reject(new Error("aborted"));
				});
			}),
		onDrop: (i) => dropped.push(i.source),
		onResult: (i) => out.push([i.text, i.ok]),
	});
	for (const s of ["a", "b", "c", "d"]) q.push(s, s);
	await delay(150);
	assert.deepEqual(dropped, ["a", "b"]);
	assert.deepEqual(out, [
		["a", false],
		["b", false],
		["ko:c", true],
		["ko:d", true],
	]);
	assert.equal(MAX_PENDING_BLOCKS, 8);
});

test("thinkingKey: 코드 블록·주석을 걷어 낸 표시 텍스트와 원문이 같은 키, 끝만 달라도 다른 키", () => {
	const raw = "Let me check the file.\n\n```ts\nconst x = 1;\n```\n\nThen I'll fix it.<!-- -->";
	const display = "Let me check the file...\n\nThen I'll fix it.";
	assert.equal(thinkingKey(raw), thinkingKey(display));
	const head = "a".repeat(300);
	assert.notEqual(thinkingKey(`${head} Fix addition.`), thinkingKey(`${head} Fix subtraction.`));
	assert.equal(thinkingKey("```js\nconst value = 1;\n```"), thinkingKey("..."));
});

test("blockId: 서명 우선, 없으면 원문 전체 해시", () => {
	assert.equal(blockId("same text", "SIG-A"), blockId("other text", "SIG-A"));
	assert.notEqual(blockId("same text", "SIG-A"), blockId("same text", "SIG-B"));
	assert.notEqual(blockId("text one"), blockId("text two"));
	assert.match(blockId("x", "y"), /^s:[0-9a-f]{16}$/);
	assert.match(blockId("x"), /^t:[0-9a-f]{16}$/);
});

test("TranslationStore: 블록별 상태, 위치로 구분, 모호하면 안 그림, 세션 항목에서 불러오기", () => {
	const s = new TranslationStore();
	const text = "The user wants me to fix the failing parser test quickly.";
	const k = thinkingKey(text);
	s.setPending("s:1", k, 0);
	assert.equal(s.lookup(text, 0)?.status, "pending");
	assert.equal(s.lookup(text, 1), undefined, "다른 위치의 블록은 안 맞춘다");
	s.setDone("s:1", k, 0, "파서 테스트 고쳐달래.");
	assert.deepEqual(s.lookup(text, 0), { status: "done", ko: "파서 테스트 고쳐달래." });
	s.setPending("s:1", k, 0); // 완료된 건 대기로 되돌리지 않는다
	assert.equal(s.lookup(text, 0)?.status, "done");
	// 같은 텍스트·같은 위치의 다른 블록(다른 메시지)이 다른 번역이면 모호 → 안 그림
	s.setDone("s:2", k, 0, "다른 번역");
	assert.equal(s.lookup(text, 0), undefined);
	// 번역이 같으면 그린다
	s.setDone("s:2", k, 0, "파서 테스트 고쳐달래.");
	assert.equal(s.lookup(text, 0)?.status, "done");
	s.remove("s:1");
	s.remove("s:2");
	assert.equal(s.lookup(text, 0), undefined);

	const s2 = new TranslationStore();
	const n = s2.load([
		{ type: "message", message: {} },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 2, id: "s:9", k, ci: 0, ko: "복원됨" } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, k: "old", sig: "x", ko: "옛 형식" } },
		{ type: "custom", customType: "other", data: { v: 2, id: "s:8", k, ci: 0, ko: "x" } },
	]);
	assert.equal(n, 1);
	assert.deepEqual(s2.lookup(text, 0), { status: "done", ko: "복원됨" });
});

test("createThinkingKoComponent: 대기 줄 → 번역 줄, 바뀐 게 없으면 같은 배열", () => {
	const s = new TranslationStore();
	const theme = { fg: (c, t) => `<${c}>${t}` };
	const text = "I found the bug in the date parser, let me fix it now.";
	const comp = createThinkingKoComponent(s, text, 0, theme);
	assert.deepEqual(comp.render(80), []);
	s.setPending("s:1", thinkingKey(text), 0);
	assert.deepEqual(comp.render(80), [" <muted>생각 옮기는 중.."]);
	s.setDone("s:1", thinkingKey(text), 0, "날짜 파서 버그 찾앗어. 바로 고칠게.");
	const a = comp.render(80);
	assert.deepEqual(a, [" <text>날짜 파서 버그 찾앗어. 바로 고칠게."]);
	assert.equal(comp.render(80), a);
	for (const row of comp.render(20)) assert.ok(row.length < 40);
});

function fakeHost(entries = []) {
	const handlers = {};
	const appended = [];
	let renderer;
	let renderRequests = 0;
	const theme = { fg: (_c, t) => t, italic: (t) => t };
	const ctx = {
		hasUI: true,
		ui: { theme, setWidget() {} },
		sessionManager: { getEntries: () => entries },
		models: { resolve: () => ({ provider: "google-antigravity", id: "gemini-3.8-flash" }) },
		modelRegistry: { getApiKey: async () => "x" },
	};
	const pi = {
		on: (name, h) => (handlers[name] = h),
		registerAssistantThinkingRenderer: (r) => (renderer = r),
		appendEntry: (customType, data) => appended.push({ type: "custom", customType, data }),
	};
	const thinkingEnd = (i, content, signature = `sig-${i}`) =>
		handlers.message_update(
			{
				message: { timestamp: 1, content: [{ type: "thinking", thinking: content, thinkingSignature: signature }] },
				assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content },
			},
			ctx,
		);
	// 화면이 thinking 블록 하나를 그릴 때처럼 렌더러를 불러 줄을 받는다.
	const draw = (text, contentIndex = 0) =>
		renderer({ contentIndex, thinkingIndex: 0, text, requestRender: () => renderRequests++ }, theme)
			.render(120)
			.join("\n");
	return { handlers, appended, ctx, pi, thinkingEnd, draw, renderRequests: () => renderRequests };
}

const T1 = "This is a bug fix task, so I should read the skill first.";
const T2 = "I found two bugs: is_even is inverted and mean divides by n-1.";
const T3 = "Both fixes are in, let me run the script again to confirm.";

test("핸들러: thinking 3개가 각자 자기 블록 밑에 번역되고 세션 캐시에 남는다", async () => {
	const h = fakeHost();
	const logs = [];
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async (_p, source) => {
			await delay(source === T1 ? 120 : 10);
			return { raw: `번역(${source.slice(0, 4)}) 찾았어`, provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		hedgeAfterMs: 5000,
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, T1);
	h.thinkingEnd(1, T2);
	h.thinkingEnd(2, T3);
	assert.equal(h.draw(T1), " 생각 옮기는 중..");
	await delay(250);
	assert.equal(h.draw(T1), " 번역(This) 찾앗어");
	assert.equal(h.draw(T2), " 번역(I fo) 찾앗어");
	assert.equal(h.draw(T3), " 번역(Both) 찾앗어");
	assert.ok(h.renderRequests() >= 3);
	assert.equal(h.appended.length, 3);
	assert.deepEqual(
		h.appended.map((e) => e.data.ko),
		["번역(This) 찾앗어", "번역(I fo) 찾앗어", "번역(Both) 찾앗어"],
	);
	assert.ok(h.appended.every((e) => e.customType === ENTRY_TYPE && e.data.v === 3 && e.data.kind === "thinking" && /^s:[0-9a-f]{16}$/.test(e.data.id) && e.data.ci === 0));
	assert.equal(logs.filter((l) => /^ok kind=thinking try=1 provider=google-antigravity model=gemini-3\.8-flash/.test(l)).length, 3);
	// 모르는 블록(예: 설치 전 세션)은 아무것도 안 그린다
	assert.equal(h.draw("Some older thinking that was never translated."), "");
});

test("핸들러: 재개 시 세션 파일 캐시에서 번역을 다시 그린다(번역 호출 없음)", async () => {
	const first = fakeHost();
	thinkingKo(first.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: "스킬부터 읽어야겟어.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	first.handlers.session_start({}, first.ctx);
	first.thinkingEnd(0, T1);
	await delay(50);

	let calls = 0;
	const resumed = fakeHost(first.appended);
	const logs = [];
	thinkingKo(resumed.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async () => {
			calls++;
			return { raw: "x", provider: "p", model: "m" };
		},
	});
	resumed.handlers.session_start({}, resumed.ctx);
	assert.equal(resumed.draw(T1), " 스킬부터 읽어야겟어.");
	assert.equal(calls, 0);
	assert.ok(logs.includes("cache-load entries=1"));
});

test("핸들러: 번역이 실패하면 번역 줄 없이 원문만 남고 캐시도 안 쓴다", async () => {
	const h = fakeHost();
	const logs = [];
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: () => new Promise(() => {}),
		call: async () => ({ raw: "x", provider: "p", model: "m" }),
		timeoutMs: () => 40,
		retryDelayMs: 30,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, "I found the bug.");
	assert.equal(h.draw("I found the bug."), " 생각 옮기는 중..");
	await delay(55);
	assert.equal(h.draw("I found the bug."), " 생각 옮기는 중.. (재시도)", "첫 실패 뒤엔 재시도 대기 표시");
	await delay(150);
	assert.equal(h.draw("I found the bug."), "", "두 번 다 실패하면 원문만");
	assert.equal(h.appended.length, 0);
	assert.equal(logs.filter((l) => /^fail kind=thinking try=[12] .*timeout 40ms/.test(l)).length, 2);
	assert.ok(logs.some((l) => l.startsWith("retry scheduled kind=thinking")));
	assert.ok(logs.some((l) => l.startsWith("retry start kind=thinking why=timer")));
});

test("재리뷰 P1: abort를 무시하는 요청 2개를 reset해도 끝나기 전에는 새 요청이 시작되지 않는다", async () => {
	const slots = new Slots(MAX_INFLIGHT_REQUESTS);
	let inflight = 0;
	let peak = 0;
	let started = 0;
	let minUsed = 0;
	// abort 신호를 무시하고 150ms 뒤에야 끝나는 가짜 요청
	const call = async () => {
		started++;
		inflight++;
		peak = Math.max(peak, inflight);
		try {
			await delay(150);
			return "late";
		} finally {
			inflight--;
			minUsed = Math.min(minUsed, slots.used);
		}
	};
	const q = new OrderedTranslator({
		concurrency: 2,
		translate: (_src, signal) => hedged(call, 5000, slots, signal).then((r) => r.value),
		onResult: () => {},
	});
	q.push("1", "a");
	q.push("2", "b");
	await delay(20);
	assert.equal(started, 2);
	q.reset();
	q.push("3", "c");
	await delay(60);
	// 앞의 두 요청은 아직 안 끝났다 → 새 요청은 슬롯을 기다린다
	assert.equal(started, 2, "settle 전에 새 요청이 시작됨");
	assert.ok(inflight <= 2 && slots.used <= 2);
	await delay(150);
	assert.equal(started, 3, "settle 뒤에도 새 요청이 시작되지 않음");
	await delay(200);
	assert.ok(peak <= 2, `peak=${peak}`);
	assert.ok(minUsed >= 0 && slots.used >= 0, `used가 음수: ${minUsed}/${slots.used}`);
	assert.equal(slots.used, 0);
});

test("재리뷰 P2: 어절 앞부분이 한글이 아니면 불변", () => {
	for (const s of ["foo있어", "config.있어", "C:\\있어", "있어_flag", "있어.txt", "path/있어/x", "a:있었다", "x.썼다."]) {
		assert.equal(softenEndings(s), s, s);
	}
	assert.equal(softenEndings("찾았어."), "찾앗어.");
	assert.equal(softenEndings("버그 찾았어.."), "버그 찾앗어..");
	assert.equal(softenEndings("됐잖아"), "됏잖아");
	assert.equal(softenEndings("\"찾았어\""), "\"찾앗어\"");
	assert.equal(softenEndings("찾았어.고쳤어."), "찾앗어.고쳣어.");
});

test("재리뷰 P2: 이모지·여는 괄호·줄바꿈 뒤도 치환, 확장자는 불변", () => {
	assert.equal(softenEndings("찾았어🙂"), "찾앗어🙂");
	assert.equal(softenEndings("찾았어(확인)"), "찾앗어(확인)");
	assert.equal(softenEndings("찾았어\n"), "찾앗어\n");
	assert.equal(softenEndings("찾았어「다음」"), "찾앗어「다음」");
	assert.equal(softenEndings("있어.txt"), "있어.txt");
	assert.equal(softenEndings("있어.md 파일"), "있어.md 파일");
});

// ---- 4차 리뷰 재현 테스트 --------------------------------------------------------

test("4차 P2-1: 앞부분이 같고 끝만 다른 두 블록은 따로 번역·캐시되고 각자 다른 번역이 붙는다", async () => {
	const h = fakeHost();
	let calls = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source) => {
			calls++;
			return {
				raw: source.endsWith("Fix addition.") ? "덧셈을 고칠게." : "뺄셈을 고칠게.",
				provider: "google-antigravity",
				model: "gemini-3.8-flash",
			};
		},
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const head = "I traced the arithmetic helper and the unit tests for every operator in calc.py carefully. ".repeat(3);
	const A = `${head}Fix addition.`;
	const B = `${head}Fix subtraction.`;
	h.thinkingEnd(0, A, "SIG-ADD");
	h.thinkingEnd(0, B, "SIG-SUB");
	await delay(80);
	assert.equal(calls, 2);
	assert.equal(h.appended.length, 2);
	assert.deepEqual(h.appended.map((e) => e.data.ko).sort(), ["덧셈을 고칠게.", "뺄셈을 고칠게."]);
	assert.equal(h.draw(A), " 덧셈을 고칠게.");
	assert.equal(h.draw(B), " 뺄셈을 고칠게.");
});

test("4차 P2-1: 같은 텍스트·같은 위치인데 번역이 다르면 붙이지 않는다(원문만)", async () => {
	const h = fakeHost();
	let n = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: `번역 ${++n}`, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, "Let me check.", "SIG-1");
	h.thinkingEnd(0, "Let me check.", "SIG-2");
	await delay(60);
	assert.equal(h.appended.length, 2);
	assert.equal(h.draw("Let me check."), "");
});

test("4차 P2-2: 코드 블록만 있는 thinking도 번역·캐시되고 '...' 화면 텍스트에 짝지어 표시된다", async () => {
	const h = fakeHost();
	let calls = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => {
			calls++;
			return { raw: "값 1 넣는 코드 써봣어.", provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, "```js\nconst value = 1;\n```", "SIG-CODE");
	await delay(40);
	assert.equal(calls, 1);
	assert.equal(h.appended.length, 1);
	assert.equal(h.draw("..."), " 값 1 넣는 코드 써봣어.");
	// 다른 위치의 "..." 블록에는 안 붙는다
	assert.equal(h.draw("...", 2), "");
});

// ---- 5차 리뷰 재현 테스트 --------------------------------------------------------

const ADD = "```py\nadd(1, 2)\n```";
const SUB = "```py\nsubtract(1, 2)\n```";

function fakeCall(source) {
	if (source === SUB) throw new Error("gemini down");
	return { raw: "덧셈 코드야.", provider: "google-antigravity", model: "gemini-3.8-flash" };
}

test("5차 P2: 다른 메시지 같은 위치의 코드 전용 블록 중 하나가 실패하면 실패한 쪽에 남의 번역이 안 붙는다", async () => {
	const h = fakeHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source) => fakeCall(source),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, ADD, "SIG-ADD");
	h.thinkingEnd(0, SUB, "SIG-SUB");
	await delay(60);
	assert.equal(h.appended.length, 1, "실패는 캐시에 안 쓴다");
	assert.equal(h.appended[0].data.ko, "덧셈 코드야.");
	// 둘 다 화면 텍스트가 "..."라 표시 키가 같다 → 실패 후보가 섞여 있으니 둘 다 원문만
	assert.equal(h.draw("..."), "");
});

test("5차 P2: 표시 키가 다르면 성공한 블록에는 번역이 붙고 실패한 블록은 원문만", async () => {
	const h = fakeHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source) => {
			if (source.startsWith("Now subtract")) throw new Error("gemini down");
			return { raw: "덧셈 코드야.", provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		timeoutMs: () => 2000,
		retryDelayMs: 30,
	});
	h.handlers.session_start({}, h.ctx);
	h.thinkingEnd(0, "Now add the numbers.", "SIG-A");
	h.thinkingEnd(0, "Now subtract the numbers.", "SIG-S");
	await delay(150);
	assert.equal(h.draw("Now add the numbers."), " 덧셈 코드야.");
	assert.equal(h.draw("Now subtract the numbers."), "");
});

test("5차 P2: 재개 때 캐시 없는 과거 블록도 후보에 넣어 남의 번역이 안 붙는다", () => {
	const sessionEntries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: ADD, thinkingSignature: "SIG-ADD" }] } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 2, id: blockId(ADD, "SIG-ADD"), k: thinkingKey(ADD), ci: 0, ko: "덧셈 코드야." } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: SUB, thinkingSignature: "SIG-SUB" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: SUB, thinkingSignature: "SIG-SUB2" }] } },
	];
	const s = new TranslationStore();
	assert.equal(s.load(sessionEntries), 1);
	assert.equal(s.registerUntranslated(sessionEntries), 2);
	assert.equal(s.lookup("...", 0), undefined, "ci=0에 번역 있는 ADD와 번역 없는 SUB2가 섞임");
	assert.equal(s.lookup("...", 1), undefined, "ci=1은 번역 없는 SUB 하나뿐");

	const h = fakeHost(sessionEntries);
	thinkingKo(h.pi, { log: () => {}, prepare: async () => ({}), call: async () => ({ raw: "x", provider: "p", model: "m" }) });
	h.handlers.session_start({}, h.ctx);
	assert.equal(h.draw("..."), "");
});

// ---- 화면 패치(원문 대신 번역) 테스트 --------------------------------------------
import {
	transformForDisplay,
	answerId,
	findAssistantComponents,
	patchAssistantClass,
	setDisplayHook,
	PENDING_THINKING,
	STREAMING_THINKING,
	PENDING_ANSWER,
	PENDING_ANSWER_RETRY,
	PENDING_THINKING_RETRY,
	ANSWER_INFLIGHT_REQUESTS,
	cleanAnswer,
} from "./thinking-ko.ts";

test("transformForDisplay: 생각은 번역/대기/스트리밍 줄로, 답변은 번역/원문+대기 줄로, 원본은 안 건드림", () => {
	const th = { type: "thinking", thinking: "I found the bug.", thinkingSignature: "SIG" };
	const tx = { type: "text", text: "Fixed it." };
	const msg = { role: "assistant", timestamp: 42, content: [th, tx, { type: "toolCall", id: "t1" }] };
	const states = new Map();
	const look = (id) => states.get(id);
	// 기록 없음 + 스트리밍 아님 → 그대로(같은 객체)
	assert.equal(transformForDisplay(msg, look, undefined), msg);
	// 스트리밍 중 → 생각은 "생각 중.."
	assert.equal(transformForDisplay(msg, look, 42).content[0].thinking, STREAMING_THINKING);
	states.set(blockId("I found the bug.", "SIG"), { status: "pending" });
	states.set(answerId(42, "Fixed it.", 1), { status: "pending" });
	let shown = transformForDisplay(msg, look, undefined);
	assert.equal(shown.content[0].thinking, PENDING_THINKING);
	assert.equal(shown.content[1].text, `Fixed it.\n\n${PENDING_ANSWER}`);
	states.set(blockId("I found the bug.", "SIG"), { status: "done", ko: "버그 찾앗어." });
	states.set(answerId(42, "Fixed it.", 1), { status: "done", ko: "고쳤다." });
	const ids = new Set();
	shown = transformForDisplay(msg, look, undefined, ids);
	assert.equal(shown.content[0].thinking, "버그 찾앗어.");
	assert.equal(shown.content[0].thinkingSignature, "SIG");
	assert.equal(shown.content[1].text, "고쳤다.");
	assert.equal(ids.size, 2);
	// 이미 바꾼 사본을 다시 넣어도 원문에서 다시 계산(멱등), 실패로 바뀌면 원문 복귀
	assert.equal(transformForDisplay(shown, look, undefined).content[0].thinking, "버그 찾앗어.");
	states.set(blockId("I found the bug.", "SIG"), { status: "failed" });
	assert.equal(transformForDisplay(shown, look, undefined).content[0].thinking, "I found the bug.");
	// 원본 메시지·블록은 그대로
	assert.equal(th.thinking, "I found the bug.");
	assert.equal(tx.text, "Fixed it.");
	// 스트리밍 표시 사본(rawThinking 있음)도 원문 기준으로 식별
	const disp = { role: "assistant", timestamp: 42, content: [{ ...th, thinking: "I found the", rawThinking: "I found the bug." }] };
	states.set(blockId("I found the bug.", "SIG"), { status: "done", ko: "버그 찾앗어." });
	const d2 = transformForDisplay(disp, look, undefined).content[0];
	assert.equal(d2.thinking, "버그 찾앗어.");
	assert.equal(d2.rawThinking, "버그 찾앗어.");
});

/* 답변 프롬프트 테스트는 patchHost 정의 뒤(아래)에 있다 */

/** OMP 어시스턴트 컴포넌트 흉내: updateContent에 들어온 메시지를 그대로 기억한다. */
class FakeAssistant {
	constructor() {
		this.shown = undefined;
		this.last = undefined;
	}
	updateContent(message) {
		this.last = message;
		this.shown = message;
	}
	setHideThinkingBlock() {}
	setMidStreamPublication() {}
	invalidate() {
		if (this.last) this.updateContent(this.last);
	}
	text() {
		return (this.shown?.content ?? [])
			.map((b) => (b.type === "thinking" ? `T:${b.thinking}` : b.type === "text" ? `A:${b.text}` : ""))
			.filter(Boolean)
			.join(" | ");
	}
}

function patchHost(entries = []) {
	const handlers = {};
	const appended = [];
	const chat = { children: [] };
	const tui = { children: [{ children: [chat] }], renders: 0, requestRender() { this.renders++; } };
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_c, t) => t },
			setWidget(_key, content) {
				if (typeof content === "function") content(tui, {});
			},
		},
		sessionManager: { getEntries: () => entries },
	};
	const pi = {
		on: (name, h) => (handlers[name] = h),
		registerAssistantThinkingRenderer: () => {},
		appendEntry: (customType, data) => appended.push({ type: "custom", customType, data }),
	};
	const addComponent = (message) => {
		const c = new FakeAssistant();
		chat.children.push(c);
		c.updateContent(message);
		return c;
	};
	return { handlers, appended, ctx, pi, tui, addComponent };
}

test("화면 패치: 컴포넌트 클래스를 찾아 감싸고, 생각·답변을 원문 대신 번역으로 그린다", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source, _s, kind) => {
			await delay(20);
			return {
				raw: kind === "answer" ? `답: ${source} 고쳤다.` : `생각: ${source} 찾았어`,
				provider: "google-antigravity",
				model: "gemini-3.8-flash",
			};
		},
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const th = { type: "thinking", thinking: "I found it", thinkingSignature: "SIG-1" };
	const message = { role: "assistant", timestamp: 7, content: [th, { type: "text", text: "Done" }] };
	// 스트리밍 시작: 컴포넌트가 생기고 첫 이벤트에서 패치
	h.handlers.message_start({ message }, h.ctx);
	const comp = h.addComponent(message);
	h.handlers.message_update({ message, assistantMessageEvent: { type: "text_delta" } }, h.ctx);
	assert.ok(findAssistantComponents(h.tui).length === 1);
	comp.invalidate();
	assert.equal(comp.text(), `T:${STREAMING_THINKING} | A:Done`, "스트리밍 중 영어 생각은 안 보인다");
	h.handlers.message_update({ message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "I found it" } }, h.ctx);
	assert.equal(comp.text(), `T:${PENDING_THINKING} | A:Done`);
	h.handlers.message_end({ message }, h.ctx);
	assert.equal(comp.text(), `T:${PENDING_THINKING} | A:Done\n\n${PENDING_ANSWER}`);
	await delay(120);
	assert.equal(comp.text(), "T:생각: I found it 찾앗어 | A:답: Done 고쳤다."); // 답변은 후처리 없음
	// 원본 메시지는 그대로(모델 문맥·세션 저장용)
	assert.equal(message.content[0].thinking, "I found it");
	assert.equal(message.content[1].text, "Done");
	assert.deepEqual(h.appended.map((e) => e.data.kind).sort(), ["answer", "thinking"]);
	assert.ok(h.appended.every((e) => e.data.v === 3));
	setDisplayHook(undefined);
});

test("화면 패치: 재개하면 캐시에서 생각·답변 번역을 바로 다시 그린다(번역 호출 없음)", () => {
	setDisplayHook(undefined);
	const th = { type: "thinking", thinking: "I found it", thinkingSignature: "SIG-1" };
	const message = { role: "assistant", timestamp: 7, content: [th, { type: "text", text: "Done" }] };
	const entries = [
		{ type: "message", message },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 3, kind: "thinking", id: blockId("I found it", "SIG-1"), k: thinkingKey("I found it"), ci: 0, ko: "찾앗어." } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 3, kind: "answer", id: answerId(7, "Done", 1), k: "", ci: 1, ko: "끝났다." } },
	];
	const h = patchHost(entries);
	const comp = h.addComponent(message); // 재개 때 확장보다 먼저 그려진 컴포넌트
	assert.equal(comp.text(), "T:I found it | A:Done");
	let calls = 0;
	thinkingKo(h.pi, { log: () => {}, prepare: async () => ({}), call: async () => (calls++, { raw: "x", provider: "p", model: "m" }) });
	h.handlers.session_start({}, h.ctx);
	assert.equal(comp.text(), "T:찾앗어. | A:끝났다.");
	assert.equal(calls, 0);
	setDisplayHook(undefined);
});

test("화면 패치: 번역 실패면 원문, 패치는 클래스당 한 번", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => {
			throw new Error("down");
		},
		timeoutMs: () => 500,
		retryDelayMs: 20,
	});
	h.handlers.session_start({}, h.ctx);
	const message = { role: "assistant", timestamp: 9, content: [{ type: "text", text: "Hello there" }] };
	h.handlers.message_start({ message }, h.ctx);
	const comp = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(5);
	assert.equal(comp.text(), `A:Hello there\n\n${PENDING_ANSWER_RETRY}`, "첫 실패 뒤 재시도 대기 표시");
	await delay(80);
	assert.equal(comp.text(), "A:Hello there");
	assert.equal(patchAssistantClass(comp), true, "이미 감싼 클래스는 다시 감싸지 않는다");
	const proto = Object.getPrototypeOf(comp);
	const wrapped = proto.updateContent;
	patchAssistantClass(comp);
	assert.equal(proto.updateContent, wrapped);
	setDisplayHook(undefined);
});

// ---- 6차: 풀 분리·재시도 ----------------------------------------------------------

test("풀 분리: 생각 2개가 진행 중이어도 답변 1개가 바로 시작되고, 반대도 된다", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	const running = { thinking: 0, answer: 0 };
	let answerStartedWhileThinkingBusy = false;
	let thinkingStartedWhileAnswerBusy = false;
	const release = [];
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source, _s, kind) => {
			running[kind]++;
			if (kind === "answer" && running.thinking >= 2) answerStartedWhileThinkingBusy = true;
			if (kind === "thinking" && running.answer >= 1) thinkingStartedWhileAnswerBusy = true;
			await new Promise((r) => release.push(r));
			running[kind]--;
			return { raw: `ko:${source}`, provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		hedgeAfterMs: 5000,
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const t = (ts, text, sig) => ({ role: "assistant", timestamp: ts, content: [{ type: "thinking", thinking: text, thinkingSignature: sig }] });
	const m1 = t(1, "first thought here", "S1");
	const m2 = t(2, "second thought here", "S2");
	h.handlers.message_update({ message: m1, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "first thought here" } }, h.ctx);
	h.handlers.message_update({ message: m2, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "second thought here" } }, h.ctx);
	await delay(10);
	assert.equal(running.thinking, 2);
	h.handlers.message_end({ message: { role: "assistant", timestamp: 3, content: [{ type: "text", text: "An answer." }] } }, h.ctx);
	await delay(10);
	assert.equal(running.answer, ANSWER_INFLIGHT_REQUESTS);
	assert.equal(answerStartedWhileThinkingBusy, true);
	// 생각 하나를 끝내 슬롯을 비우면, 답변이 돌고 있어도 새 생각이 시작된다
	release.shift()();
	await delay(10);
	const m3 = t(4, "third thought here", "S3");
	h.handlers.message_update({ message: m3, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "third thought here" } }, h.ctx);
	await delay(10);
	assert.equal(thinkingStartedWhileAnswerBusy, true);
	assert.ok(running.thinking + running.answer <= 3);
	while (release.length) release.shift()();
	await delay(30);
	while (release.length) release.shift()();
	await delay(30);
	setDisplayHook(undefined);
});

test("재시도: 첫 번역이 실패해도 다음 성공 직후 재시도해서 번역을 그리고 캐시에 남긴다", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	const logs = [];
	let flakyFailures = 0; // 한 번의 번역 시도 안에서 헤징이 한 번 더 부르므로 2번 실패시킨다
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async (_p, source) => {
			await delay(10);
			if (source === "flaky thought" && flakyFailures < 2) {
				flakyFailures++;
				throw new Error("timeout 12000ms");
			}
			return { raw: `번역: ${source} 됐어`, provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		retryDelayMs: 60_000,
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const flaky = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "flaky thought", thinkingSignature: "SF" }] };
	const comp = h.addComponent(flaky);
	h.handlers.message_update({ message: flaky, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "flaky thought" } }, h.ctx);
	await delay(40);
	assert.equal(comp.text(), `T:${PENDING_THINKING_RETRY}`);
	assert.equal(h.appended.length, 0);
	// 다른 블록 번역이 성공하면 60초를 기다리지 않고 바로 재시도
	const ok = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "steady thought", thinkingSignature: "SS" }] };
	h.handlers.message_update({ message: ok, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "steady thought" } }, h.ctx);
	await delay(80);
	assert.equal(comp.text(), "T:flaky thought 됏어");
	assert.equal(h.appended.filter((e) => e.data.ko === "flaky thought 됏어").length, 1);
	assert.ok(logs.some((l) => l.startsWith("retry start kind=thinking why=after-success")));
	assert.ok(logs.some((l) => l.startsWith("ok kind=thinking try=2")));
	setDisplayHook(undefined);
});

test("재개 때 번역 없던 과거 블록은 재시도하지 않는다", async () => {
	setDisplayHook(undefined);
	const message = { role: "assistant", timestamp: 5, content: [{ type: "thinking", thinking: "old thought", thinkingSignature: "SO" }] };
	const h = patchHost([{ type: "message", message }]);
	const comp = h.addComponent(message);
	let calls = 0;
	thinkingKo(h.pi, { log: () => {}, prepare: async () => ({}), call: async () => (calls++, { raw: "x", provider: "p", model: "m" }), retryDelayMs: 10 });
	h.handlers.session_start({}, h.ctx);
	await delay(50);
	assert.equal(calls, 0);
	assert.equal(comp.text(), "T:old thought");
	setDisplayHook(undefined);
});

// ---- 7차 리뷰 재현 테스트 --------------------------------------------------------
import { trimBlankLines, maxTokensFor, replyFromResult, MAX_OUTPUT_TOKENS } from "./thinking-ko.ts";

test("7차 P2-2: 답변 경로는 첫 줄 들여쓰기를 지킨다(앞뒤 빈 줄만 제거)", async () => {
	assert.equal(trimBlankLines("\n\n    print(1)\n    print(2)\n\n"), "    print(1)\n    print(2)");
	assert.equal(cleanAnswer("    print(1)\n    print(2)"), "    print(1)\n    print(2)");
	assert.equal(cleanAnswer("\n  \n\tindented\n"), "\tindented");
	// 핸들러: 번역기로 가는 원문과 표시되는 번역 모두 들여쓰기 보존
	setDisplayHook(undefined);
	const h = patchHost();
	const seen = [];
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async (_p, source) => {
			seen.push(source);
			return { raw: source.replace("print", "출력"), provider: "google-antigravity", model: "gemini-3.8-flash" };
		},
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const text = "\n    print(1)\n    print(2)\n";
	const message = { role: "assistant", timestamp: 11, content: [{ type: "text", text }] };
	const comp = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(30);
	assert.deepEqual(seen, ["    print(1)\n    print(2)"]);
	assert.equal(comp.text(), "A:    출력(1)\n    print(2)");
	setDisplayHook(undefined);
});

test("7차 P2-3: 정상 종료가 아니면(잘림 등) 실패로 던지고, 출력 토큰은 원문 길이에 비례", () => {
	const m = { provider: "google-antigravity", id: "gemini-3.8-flash" };
	const ok = replyFromResult({ stopReason: "stop", content: [{ type: "text", text: "번역" }] }, m);
	assert.equal(ok.raw, "번역");
	assert.equal(replyFromResult({ stopReason: "end_turn", content: [] }, m).raw, "");
	assert.throws(() => replyFromResult({ stopReason: "length", content: [{ type: "text", text: "잘린" }] }, m), /truncated/);
	assert.throws(() => replyFromResult({ stopReason: "max_tokens", content: [] }, m), /truncated/);
	assert.throws(() => replyFromResult({ stopReason: "error", errorMessage: "boom", content: [] }, m), /error.*boom/);
	assert.throws(() => replyFromResult({ stopReason: "toolUse", content: [] }, m), /toolUse/);
	assert.equal(maxTokensFor("short"), 2048);
	assert.equal(maxTokensFor("x".repeat(6000)), 6512);
	assert.equal(maxTokensFor("x".repeat(100000)), MAX_OUTPUT_TOKENS);
});

test("7차 P2-3: 잘린 번역은 캐시·표시하지 않고 재시도, 끝내 잘리면 원문", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	let calls = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => {
			calls++;
			// 실제 경로처럼 replyFromResult가 잘린 결과를 실패로 바꾼다
			return replyFromResult({ stopReason: "length", content: [{ type: "text", text: "잘린 번역" }] }, { provider: "p", id: "m" });
		},
		retryDelayMs: 20,
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const message = { role: "assistant", timestamp: 12, content: [{ type: "text", text: "A very long answer." }] };
	const comp = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(120);
	assert.ok(calls >= 2);
	assert.equal(h.appended.length, 0);
	assert.equal(comp.text(), "A:A very long answer.");
	setDisplayHook(undefined);
});

test("7차 P2-4: 같은 메시지의 동일 text 블록 둘은 따로 번역·캐시된다", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	let n = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: `번역${++n}`, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const message = { role: "assistant", timestamp: 13, content: [{ type: "text", text: "Same." }, { type: "text", text: "Same." }] };
	const comp = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(40);
	assert.equal(n, 2);
	assert.deepEqual(h.appended.map((e) => e.data.ci), [0, 1]);
	assert.notEqual(h.appended[0].data.id, h.appended[1].data.id);
	assert.equal(comp.text(), "A:번역1 | A:번역2");
	assert.equal(answerId(13, "Same.", 0) === answerId(13, "Same.", 1), false);
	setDisplayHook(undefined);
});

// ---- 8차: 조각 위치·기록 재발행 ------------------------------------------------------
import { AnswerLocator, findTranscriptContainer } from "./thinking-ko.ts";

test("8차 P2: 도구 호출로 잘린 두 조각의 같은 text도 각자 자기 번역이 붙는다(원본 위치 기준)", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	let n = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: `번역${++n}`, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const t0 = { type: "text", text: "Same." };
	const tool = { type: "toolCall", id: "t1" };
	const t2 = { type: "text", text: "Same." };
	const message = { role: "assistant", timestamp: 21, content: [t0, tool, t2] };
	// 화면은 도구 호출 앞뒤로 조각을 따로 그린다(블록 객체는 원본과 같음)
	const seg1 = h.addComponent({ ...message, content: [t0] });
	const seg2 = h.addComponent({ ...message, content: [t2] });
	h.handlers.message_end({ message }, h.ctx);
	await delay(40);
	assert.equal(n, 2);
	assert.deepEqual(h.appended.map((e) => e.data.ci), [0, 2]);
	assert.equal(seg1.text(), "A:번역1");
	assert.equal(seg2.text(), "A:번역2");
	setDisplayHook(undefined);
});

test("8차 P2: 원본에 닿을 수 없고 같은 원문이 여럿이면 조각에는 번역을 안 붙인다", () => {
	const loc = new AnswerLocator();
	const full = { role: "assistant", timestamp: 22, content: [{ type: "text", text: "Same." }, { type: "toolCall" }, { type: "text", text: "Same." }, { type: "text", text: "Unique." }] };
	loc.record(structuredClone(full)); // 사본만 기록(객체가 다름)
	const segBlock = { type: "text", text: "Same." };
	assert.equal(loc.locate(full, segBlock, 0, 1), undefined, "모호하면 undefined");
	assert.equal(loc.locate(full, { type: "text", text: "Unique." }, 0, 1), 3, "유일하면 원본 위치");
	assert.equal(loc.locate(full, segBlock, 2, 4), 2, "메시지 전체를 그리면 같은 위치");
	assert.equal(loc.locate({ ...full, timestamp: 99 }, segBlock, 0, 1), undefined, "원본을 모르면 undefined");
	const shown = transformForDisplay({ ...full, content: [segBlock] }, () => ({ status: "done", ko: "틀린 번역" }), undefined, undefined, loc);
	assert.equal(shown.content[0].text, "Same.");
});

test("8차 P2: 조각 블록이 원본과 다른 객체면 같은 원문 조각에는 번역을 안 붙이고, 메시지 전체 컴포넌트는 각자 번역", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	let n = 0;
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: `번역${++n}`, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const message = { role: "assistant", timestamp: 23, content: [{ type: "text", text: "Same." }, { type: "toolCall", id: "t1" }, { type: "text", text: "Same." }] };
	// 스트리밍 중 만든 사본으로 그려진 조각(원본 블록 객체와 다름)
	const seg1 = h.addComponent({ ...message, content: [{ type: "text", text: "Same." }] });
	const seg2 = h.addComponent({ ...message, content: [{ type: "text", text: "Same." }] });
	const whole = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(40);
	assert.equal(n, 2);
	assert.equal(seg1.text(), "A:Same.", "어느 블록인지 모르면 원문");
	assert.equal(seg2.text(), "A:Same.");
	assert.equal(whole.text(), "A:번역1 | A:번역2");
	setDisplayHook(undefined);
});

test("8차 P2: 재개 때 7차 빌드 캐시(같은 원문 순번 id)도 찾아 그린다", () => {
	setDisplayHook(undefined);
	const t1 = { type: "text", text: "Same." };
	const t3 = { type: "text", text: "Same." };
	const message = { role: "assistant", timestamp: 24, content: [{ type: "thinking", thinking: "hm", thinkingSignature: "S24" }, t1, { type: "toolCall", id: "t" }, t3] };
	const entries = [
		{ type: "message", message },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 3, kind: "answer", id: answerId(24, "Same.", 0), k: "", ci: 1, ko: "첫째." } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 3, kind: "answer", id: answerId(24, "Same.", 1), k: "", ci: 3, ko: "둘째." } },
	];
	const h = patchHost(entries);
	const seg1 = h.addComponent({ ...message, content: message.content.slice(0, 2) });
	const seg2 = h.addComponent({ ...message, content: [t3] });
	thinkingKo(h.pi, { log: () => {}, prepare: async () => ({}), call: async () => ({ raw: "x", provider: "p", model: "m" }) });
	h.handlers.session_start({}, h.ctx);
	assert.equal(seg1.text(), "T:hm | A:첫째.");
	assert.equal(seg2.text(), "A:둘째.");
	setDisplayHook(undefined);
});

test("8차 잔여: 이미 기록으로 나간 블록의 번역이 오면 기록을 다시 내보낸다(모아서 1번)", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	// 대화 컨테이너 흉내: 안의 블록은 모두 이미 발행됨(canRemoveBlock=false)
	let resets = 0;
	const chat = h.tui.children[0].children[0];
	chat.canRemoveBlock = () => false;
	chat.resetStableEmission = () => resets++;
	let displayResets = 0;
	h.tui.resetDisplay = () => displayResets++;
	const logs = [];
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async () => ({ raw: "다 됐다.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
		stableReset: { quietMs: 100, maxWaitMs: 1000, minGapMs: 300 },
	});
	h.handlers.session_start({}, h.ctx);
	const m1 = { role: "assistant", timestamp: 31, content: [{ type: "text", text: "Done one." }] };
	const m2 = { role: "assistant", timestamp: 32, content: [{ type: "text", text: "Done two." }] };
	h.handlers.message_start({ message: m1 }, h.ctx);
	h.addComponent(m1);
	h.addComponent(m2);
	h.handlers.message_update({ message: m1, assistantMessageEvent: { type: "text_delta" } }, h.ctx);
	assert.ok(findTranscriptContainer(h.tui) === chat);
	h.handlers.message_end({ message: m1 }, h.ctx);
	h.handlers.message_end({ message: m2 }, h.ctx);
	await delay(700);
	assert.equal(resets, 1, "번역 두 개가 와도 한 번만");
	assert.equal(displayResets, 1);
	assert.ok(logs.some((l) => l.startsWith("stable-reset count=1 ms=")));
	assert.ok(!logs.includes("stable-reset unavailable"));
	setDisplayHook(undefined);
});

test("8차 잔여: 아직 기록으로 안 나간 블록의 번역이면 기록 재발행 없이 invalidate만", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	let resets = 0;
	const chat = h.tui.children[0].children[0];
	const published = new Set();
	chat.canRemoveBlock = (c) => !published.has(c);
	chat.resetStableEmission = () => resets++;
	h.tui.resetDisplay = () => {};
	const logs = [];
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async (_p, source) => ({ raw: `ko ${source}`, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const old = { role: "assistant", timestamp: 51, content: [{ type: "text", text: "Old." }] };
	const live = { role: "assistant", timestamp: 52, content: [{ type: "text", text: "Live." }] };
	published.add(h.addComponent(old)); // 이미 발행된 블록(이번 번역과 무관)
	const liveComp = h.addComponent(live);
	h.handlers.message_update({ message: live, assistantMessageEvent: { type: "text_delta" } }, h.ctx);
	h.handlers.message_end({ message: live }, h.ctx);
	await delay(700);
	assert.equal(liveComp.text(), "A:ko Live.");
	assert.equal(resets, 0, "발행되지 않은 블록만 바뀌면 재발행하지 않는다");
	assert.ok(!logs.some((l) => l.startsWith("stable-reset")));
	setDisplayHook(undefined);
});

test("8차 잔여: 대화 컨테이너를 못 찾으면 invalidate만 하고 로그에 한 줄", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	const logs = [];
	thinkingKo(h.pi, { log: (l) => logs.push(l), prepare: async () => ({}), call: async () => ({ raw: "x", provider: "p", model: "m" }) });
	h.handlers.session_start({}, h.ctx);
	const m = { role: "assistant", timestamp: 41, content: [{ type: "text", text: "Hi." }] };
	h.addComponent(m);
	h.handlers.message_update({ message: m, assistantMessageEvent: { type: "text_delta" } }, h.ctx);
	assert.ok(logs.includes("stable-reset unavailable"));
	setDisplayHook(undefined);
});

// ---- 9차: 기록 재발행 타이머(세션 전환 취소·빈도 제어) -------------------------------------
import { StableResetScheduler, STABLE_RESET_QUIET_MS, STABLE_RESET_MAX_WAIT_MS, STABLE_RESET_MIN_GAP_MS } from "./thinking-ko.ts";

/** 가짜 시계: schedule/unschedule/now를 주고 advance(ms)로 시간을 흘린다. */
function fakeClock() {
	let t = 0;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => t,
		schedule: (fn, ms) => {
			const id = ++seq;
			timers.set(id, { at: t + ms, fn });
			return id;
		},
		unschedule: (id) => timers.delete(id),
		advance(ms) {
			const end = t + ms;
			for (;;) {
				let next;
				for (const [id, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [id, v];
				if (!next) break;
				timers.delete(next[0]);
				t = next[1].at;
				next[1].fn();
			}
			t = end;
		},
		get size() {
			return timers.size;
		},
	};
}

function scheduler(clock, extra = {}) {
	const runs = [];
	const s = new StableResetScheduler({ now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule, run: () => runs.push(clock.now()), ...extra });
	return { s, runs };
}

test("9차 P2-2: 기본값 확인과 500ms 간격 5블록 도착 → 재발행 1회(마지막 도착 1.5초 뒤)", () => {
	assert.equal(STABLE_RESET_QUIET_MS, 1500);
	assert.equal(STABLE_RESET_MAX_WAIT_MS, 6000);
	assert.equal(STABLE_RESET_MIN_GAP_MS, 3000);
	const c = fakeClock();
	const { s, runs } = scheduler(c);
	for (let i = 0; i < 5; i++) {
		s.request();
		c.advance(500);
	}
	c.advance(10_000);
	assert.deepEqual(runs, [2000 + STABLE_RESET_QUIET_MS]);
});

test("9차 P2-2: 계속 도착해도 첫 요청부터 6초면 한 번 실행하고, 실행 뒤 최소 3초 간격", () => {
	const c = fakeClock();
	const { s, runs } = scheduler(c);
	// 1초마다 12초 동안 도착(1.5초 조용한 틈이 없음)
	for (let i = 0; i < 12; i++) {
		s.request();
		c.advance(1000);
	}
	c.advance(10_000);
	assert.equal(runs[0], STABLE_RESET_MAX_WAIT_MS, "첫 요청(0) + 6초 상한");
	assert.equal(runs.length, 2);
	assert.ok(runs[1] - runs[0] >= STABLE_RESET_MIN_GAP_MS);
	// 실행 직후 도착분은 최소 간격까지 미뤄 한 번으로 합친다
	const c2 = fakeClock();
	const x = scheduler(c2, { quietMs: 100 });
	x.s.request();
	c2.advance(200);
	assert.deepEqual(x.runs, [100]);
	x.s.request();
	c2.advance(50);
	x.s.request();
	c2.advance(5000);
	assert.deepEqual(x.runs, [100, 100 + STABLE_RESET_MIN_GAP_MS]);
});

test("9차 P2-2: 메시지 스트리밍 중이면 미루고, 끝나면(idle) 한 번 실행", () => {
	const c = fakeClock();
	let busy = true;
	const { s, runs } = scheduler(c, { busy: () => busy });
	s.request();
	c.advance(1000);
	s.request();
	c.advance(20_000);
	assert.deepEqual(runs, [], "스트리밍 중에는 상한이 지나도 실행하지 않는다");
	busy = false;
	s.idle();
	c.advance(0);
	assert.deepEqual(runs, [21_000]);
	s.idle();
	c.advance(10_000);
	assert.equal(runs.length, 1, "대기 중인 요청이 없으면 idle은 아무것도 안 한다");
});

test("9차 P2-1: cancel 뒤에는 예약돼 있던 콜백이 불려도 실행하지 않는다", () => {
	const c = fakeClock();
	let captured;
	const { s, runs } = scheduler(c, {
		schedule: (fn, ms) => ((captured = fn), c.schedule(fn, ms)),
	});
	s.request();
	s.cancel();
	assert.equal(c.size, 0);
	captured(); // 취소가 늦어 이미 큐에 들어간 콜백 흉내
	c.advance(10_000);
	assert.deepEqual(runs, []);
	assert.equal(s.pending, false);
});

function resetHost() {
	const h = patchHost();
	const chat = h.tui.children[0].children[0];
	const counts = { stable: 0, display: 0 };
	chat.canRemoveBlock = () => false;
	chat.resetStableEmission = () => counts.stable++;
	h.tui.resetDisplay = () => counts.display++;
	return { h, counts };
}

for (const [name, fire] of [
	["session_switch", (h) => h.handlers.session_switch({}, h.ctx)],
	["session_shutdown", (h) => h.handlers.session_shutdown({}, h.ctx)],
]) {
	test(`9차 P2-1: 번역 완료 50ms 뒤 ${name} → 이전 세션 기록 재발행 0회`, async () => {
		setDisplayHook(undefined);
		const { h, counts } = resetHost();
		const logs = [];
		thinkingKo(h.pi, {
			log: (l) => logs.push(l),
			prepare: async () => ({}),
			call: async () => ({ raw: "다 됐다.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
			timeoutMs: () => 2000,
			stableReset: { quietMs: 200, maxWaitMs: 1000, minGapMs: 300 },
		});
		h.handlers.session_start({}, h.ctx);
		const m = { role: "assistant", timestamp: 61, content: [{ type: "text", text: "Done." }] };
		h.handlers.message_start({ message: m }, h.ctx);
		h.addComponent(m);
		h.handlers.message_end({ message: m }, h.ctx);
		await delay(5); // 번역 완료 → 재발행 예약
		assert.ok(h.appended.length === 1);
		await delay(50);
		fire(h);
		await delay(600);
		assert.equal(counts.stable, 0);
		assert.equal(counts.display, 0);
		assert.ok(!logs.some((l) => l.startsWith("stable-reset count")));
		setDisplayHook(undefined);
	});
}

test("9차 P2-2: 핸들러 — 다음 메시지가 스트리밍 중이면 재발행을 그 메시지 끝까지 미룬다", async () => {
	setDisplayHook(undefined);
	const { h, counts } = resetHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: "다 됐다.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
		stableReset: { quietMs: 50, maxWaitMs: 200, minGapMs: 100 },
	});
	h.handlers.session_start({}, h.ctx);
	const m1 = { role: "assistant", timestamp: 71, content: [{ type: "text", text: "First." }] };
	const m2 = { role: "assistant", timestamp: 72, content: [{ type: "text", text: "Second." }] };
	h.addComponent(m1);
	h.handlers.message_end({ message: m1 }, h.ctx);
	h.handlers.message_start({ message: m2 }, h.ctx); // 다음 메시지 스트리밍 시작
	h.addComponent(m2);
	await delay(400);
	assert.equal(counts.stable, 0, "스트리밍 중에는 미룬다");
	h.handlers.message_end({ message: m2 }, h.ctx);
	await delay(400);
	assert.ok(counts.stable >= 1 && counts.stable <= 2, `끝난 뒤 실행(${counts.stable})`);
	setDisplayHook(undefined);
});

// ---- 10차: 겹친 스트리밍·보류 상한·타이머 unref ----------------------------------------------
import { STABLE_RESET_MAX_DEFER_MS } from "./thinking-ko.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("10차 P2-1: 스트리밍으로 미룬 재발행도 첫 요청부터 60초가 넘으면 강제 1회(run(true))", () => {
	assert.equal(STABLE_RESET_MAX_DEFER_MS, 60_000);
	const c = fakeClock();
	const forced = [];
	const s = new StableResetScheduler({ now: c.now, schedule: c.schedule, unschedule: c.unschedule, busy: () => true, run: (f) => forced.push([c.now(), f]) });
	s.request();
	c.advance(59_000);
	assert.deepEqual(forced, []);
	s.request(); // 보류 중 추가 도착은 상한을 늦추지 않는다
	c.advance(2_000);
	assert.deepEqual(forced, [[60_000, true]]);
	c.advance(120_000);
	assert.equal(forced.length, 1, "새 요청이 없으면 더 실행하지 않는다");
});

test("10차 P2-1: A 시작 → B 시작 → B 종료면 A가 아직 스트리밍 중이라 재발행 0회, A 종료 뒤 1회", async () => {
	setDisplayHook(undefined);
	const { h, counts } = resetHost();
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw: "다 됐다.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
		stableReset: { quietMs: 50, maxWaitMs: 200, minGapMs: 100 },
	});
	h.handlers.session_start({}, h.ctx);
	const a = { role: "assistant", timestamp: 81, content: [{ type: "text", text: "A." }] };
	const b = { role: "assistant", timestamp: 82, content: [{ type: "text", text: "B." }] };
	const done = { role: "assistant", timestamp: 80, content: [{ type: "text", text: "Done earlier." }] };
	h.handlers.message_start({ message: a }, h.ctx);
	h.handlers.message_start({ message: b }, h.ctx);
	h.addComponent(done);
	h.handlers.message_end({ message: done }, h.ctx); // 이미 발행된 블록의 번역 → 재발행 요청
	await delay(300);
	assert.equal(counts.stable, 0);
	h.handlers.message_end({ message: b }, h.ctx);
	await delay(300);
	assert.equal(counts.stable, 0, "B만 끝나고 A는 아직 스트리밍 중");
	h.handlers.message_end({ message: a }, h.ctx);
	await delay(300);
	assert.equal(counts.stable, 1);
	setDisplayHook(undefined);
});

test("10차 P2-1: 스트리밍이 안 끝나도 보류 상한이 지나면 강제 1회 + 로그, agent_end는 보류를 푼다", async () => {
	setDisplayHook(undefined);
	const { h, counts } = resetHost();
	const logs = [];
	thinkingKo(h.pi, {
		log: (l) => logs.push(l),
		prepare: async () => ({}),
		call: async () => ({ raw: "다 됐다.", provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
		stableReset: { quietMs: 50, maxWaitMs: 100, minGapMs: 50, maxDeferMs: 300 },
	});
	h.handlers.session_start({}, h.ctx);
	const stuck = { role: "assistant", timestamp: 91, content: [] };
	h.handlers.message_start({ message: stuck }, h.ctx); // message_end가 영영 안 오는 메시지
	const done = { role: "assistant", timestamp: 90, content: [{ type: "text", text: "Done." }] };
	h.addComponent(done);
	h.handlers.message_end({ message: done }, h.ctx);
	await delay(150);
	assert.equal(counts.stable, 0);
	await delay(350);
	assert.equal(counts.stable, 1);
	assert.ok(logs.some((l) => l.startsWith("stable-reset forced streaming=1 after>=300ms")));
	// agent_end가 스트리밍 집합을 비우므로 다음 요청은 평소대로 처리된다
	h.handlers.agent_end({}, h.ctx);
	const more = { role: "assistant", timestamp: 92, content: [{ type: "text", text: "More." }] };
	h.addComponent(more);
	h.handlers.message_end({ message: more }, h.ctx);
	await delay(200);
	assert.equal(counts.stable, 2);
	setDisplayHook(undefined);
});

test("10차 P2-2: 재발행·재시도 타이머가 남아 있어도 노드 프로세스는 바로 끝난다(unref)", async () => {
	const url = new URL("./thinking-ko.ts", import.meta.url).href;
	const script = `
const m = await import(${JSON.stringify(url)});
new m.StableResetScheduler({ run() {}, quietMs: 20000, maxWaitMs: 20000 }).request();
const handlers = {};
const pi = { on: (n, h) => (handlers[n] = h), registerAssistantThinkingRenderer() {}, appendEntry() {} };
let scheduled;
const retried = new Promise((r) => (scheduled = r));
m.default(pi, {
	log: (l) => { if (l.startsWith("retry scheduled")) scheduled(); },
	prepare: async () => ({}),
	call: async () => { throw new Error("down"); },
	timeoutMs: () => 30000,
	hedgeAfterMs: 20000,
});
const ctx = { hasUI: true, ui: { setWidget() {} }, sessionManager: { getEntries: () => [] } };
handlers.session_start({}, ctx);
handlers.message_end({ message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Hi." }] } }, ctx);
await retried; // 60초 재시도 타이머와 20초 재발행 타이머가 걸린 상태
process.stdout.write("done");
`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let doneAt;
	let err = "";
	child.stderr.on("data", (d) => (err += d));
	child.stdout.on("data", (d) => {
		if (String(d).includes("done")) doneAt = Date.now();
	});
	const code = await new Promise((r) => child.on("exit", r));
	const exitAt = Date.now();
	assert.equal(code, 0, err);
	assert.ok(doneAt, "스크립트 본문이 끝까지 돌았다");
	assert.ok(exitAt - doneAt < 500, `본문 종료 뒤 ${exitAt - doneAt}ms 만에 종료`);
});

// ---- 사용자 정정: 답변도 생각 말투(반말·구어체, ㅆ→ㅅ) — 프롬프트로만 맞춘다(후처리 없음) ----------------

test("cleanAnswer: fenced code is preserved and a translation heading is removed", () => {
	assert.equal(cleanAnswer("```bash\nls\n```\n\n끝났다."), "```bash\nls\n```\n\n끝났다.");
	assert.equal(cleanAnswer("번역: 고쳤다."), "고쳤다.");
});

test("답변 경로: 번역 결과를 후처리 없이(코드 영역 포함 바이트 그대로) 표시·캐시한다", async () => {
	setDisplayHook(undefined);
	const h = patchHost();
	// 모델이 ㅆ을 남긴 경우도 그대로 둔다(생각 경로와 달리 ㅆ→ㅅ 후처리 없음)
	const raw = [
		"다 고쳤어! 됐어~",
		"",
		"- ```text",
		"  있었다 `됐어`",
		"  ```",
		"> ```py",
		"> msg = \"했어\"",
		"> ```",
		"    - 있었다",
		"``a`b` 있었다 x`` 그리고 `a",
		"있었어",
		"b` 끝났어.",
		"<pre>됐어</pre>",
	].join("\n");
	thinkingKo(h.pi, {
		log: () => {},
		prepare: async () => ({}),
		call: async () => ({ raw, provider: "google-antigravity", model: "gemini-3.8-flash" }),
		timeoutMs: () => 2000,
	});
	h.handlers.session_start({}, h.ctx);
	const message = { role: "assistant", timestamp: 111, content: [{ type: "text", text: "Fixed everything." }] };
	const comp = h.addComponent(message);
	h.handlers.message_end({ message }, h.ctx);
	await delay(30);
	assert.equal(comp.text(), `A:${raw}`);
	assert.equal(h.appended[0].data.ko, raw);
	assert.equal(Buffer.compare(Buffer.from(h.appended[0].data.ko), Buffer.from(raw)), 0);
	setDisplayHook(undefined);
});

test("14차 P2: cleanAnswer는 들여쓴 줄·코드의 'Translation:'을 머리말로 먹지 않는다", () => {
	const same = [
		"    Translation: string;\n    value: number;",
		"\tTranslation: string;",
		"Translation: string;",
		"번역: string;",
		"```ts\nTranslation: string;\n```",
		"~~~\n번역: 아 고쳣어\n~~~",
		"번역:아 고쳣어",
	];
	for (const s of same) assert.equal(cleanAnswer(s), s, JSON.stringify(s));
	assert.equal(cleanAnswer("번역:\n아 고쳣어"), "아 고쳣어");
	assert.equal(cleanAnswer("번역: 아 고쳣어"), "아 고쳣어");
	assert.equal(cleanAnswer("Translation:\r\n\n아 고쳣어\n"), "아 고쳣어");
	assert.equal(cleanAnswer("\n\n번역: 다 됏어!\n\n```\nx\n```"), "다 됏어!\n\n```\nx\n```");
	assert.equal(cleanAnswer("번역:"), "");
});
