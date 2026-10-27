// The bridge runs inside one pi session: it publishes the session's activity to the hub,
// serves snapshots, executes remote commands, and lets a phone answer extension dialogs.

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomId } from "./crypto.ts";
import { actionKey, Once } from "./once.ts";

/** Phone requests that change the session: run at most once per idempotency key. */
const ACTIONS = new Set(["send", "answer", "abort", "setModel", "setThinking", "compact", "spawn"]);
import { HubLink, type LinkState } from "./link.ts";
import {
	type AgentEvent,
	type AgentInfo,
	branchToItems,
	clip,
	contentText,
	findImage,
	findToolOutput,
	type Item,
	messageToItem,
	PHONE_BASH,
	type PhoneBashDetails,
	type Prompt,
	type Status,
	toolTitle,
} from "./protocol.ts";
import type { Config } from "./store.ts";
import { inHerdr, spawnPi } from "./herdr.ts";
import type { VoiceHost } from "pi-speech/host";
import { countWord, describeActivity, firstSentences, speakable } from "pi-speech/speech";

const AGENT_KEY = Symbol.for("pi-mobile.agent");
const COUNTER_KEY = Symbol.for("pi-mobile.counter");
const BRIDGE_KEY = Symbol.for("pi-mobile.bridge");
const PATCHED = Symbol.for("pi-mobile.patched");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** A `!command` from a phone stops after this; the phone has no Esc. */
const PHONE_BASH_TIMEOUT_MS = 60_000;
/** Output kept for the model and the session file (the tail, like tool output). */
const PHONE_BASH_OUTPUT_LIMIT = 30_000;

type G = typeof globalThis & { [AGENT_KEY]?: string; [BRIDGE_KEY]?: Bridge; [COUNTER_KEY]?: number };

/**
 * Per-process event counter, monotonic across bridges. A snapshot reports the last value, so a
 * phone merging a snapshot with live events drops exactly those already reflected in it.
 */
function eventCounter(next: boolean): number {
	const g = globalThis as G;
	g[COUNTER_KEY] = (g[COUNTER_KEY] ?? 0) + (next ? 1 : 0);
	return g[COUNTER_KEY];
}

/** Stable per process, so a phone keeps following this terminal across /new and /resume. */
export function agentId(): string {
	const g = globalThis as G;
	g[AGENT_KEY] ??= randomId(6);
	return g[AGENT_KEY];
}

function activeBridge(): Bridge | undefined {
	const b = (globalThis as G)[BRIDGE_KEY];
	return b?.isLinked ? b : undefined;
}

interface OpenPrompt {
	prompt: Prompt;
	answer: (value: unknown) => void;
}

interface RunningTool {
	id: string;
	name: string;
	title: string;
	output: string;
	lastSent: number;
	timer?: NodeJS.Timeout;
}

export class Bridge {
	private link: HubLink;
	private ctx: ExtensionContext;
	private status: Status = "idle";
	private prompts = new Map<string, OpenPrompt>();
	private terminalPrompt = 0;
	private streamKey?: string;
	private partial: unknown;
	private streamBuf = new Map<string, { i: number; kind: "text" | "thinking" | "tool"; delta: string; name?: string }>();
	private streamTimer?: NodeJS.Timeout;
	private tools = new Map<string, RunningTool>();
	private runStartedAt = 0;
	private infoTimer?: NodeJS.Timeout;
	private keyCounter = 0;
	private readonly pi: ExtensionAPI;
	voice?: VoiceHost;
	onState: (s: LinkState) => void = () => {};
	onMessage: (msg: any) => void = () => {};

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, config: () => Config, secret: string) {
		this.pi = pi;
		this.ctx = ctx;
		this.link = new HubLink({
			config,
			secret,
			info: () => this.info(),
			onRequest: (m, p) => this.handle(m, p),
			onMessage: (msg) => this.onMessage(msg),
			onState: (s) => {
				if (s.kind === "linked" && this.presencePending) {
					this.presencePending = false;
					this.presence();
				}
				this.onState(s);
			},
		});
	}

	get isLinked(): boolean {
		return this.link.linked;
	}

	get linkState(): LinkState {
		return this.link.state;
	}

	hubRequest<T = any>(m: string, p?: unknown): Promise<T> {
		return this.link.request<T>(m, p);
	}

	start(): void {
		(globalThis as G)[BRIDGE_KEY] = this;
		patchUI(this.ctx);
		this.link.start();
	}

	stop(): void {
		const g = globalThis as G;
		if (g[BRIDGE_KEY] === this) g[BRIDGE_KEY] = undefined;
		clearTimeout(this.streamTimer);
		clearTimeout(this.infoTimer);
		for (const t of this.tools.values()) clearTimeout(t.timer);
		this.link.stop();
	}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
		patchUI(ctx);
	}

	/** Asks the hub to notify subscribed phones, including locked ones. */
	private attention(event: string, body: string, urgent: boolean): void {
		const name = this.info().name;
		const short = name.length > 40 ? `${name.slice(0, 39)}…` : name;
		this.link.send({ t: "attention", title: `${short} ${event}`, body, urgent });
	}

	private lastPresence = 0;

	/** You typed in this terminal: the hub holds phone notifications while you are at the computer. */
	presence(): void {
		const now = Date.now();
		if (now - this.lastPresence < 15_000) return;
		// Not linked yet (startup, hub restart): send it as soon as the link is up.
		if (!this.link.linked) {
			this.presencePending = true;
			return;
		}
		this.lastPresence = now;
		this.link.send({ t: "presence" });
	}

	private presencePending = false;

	private emit(ev: AgentEvent): void {
		this.link.send({ t: "ev", ev: { ...ev, n: eventCounter(true) } });
	}

	// ── session info ───────────────────────────────────────────────────────────────

	info(): AgentInfo {
		const ctx = this.ctx;
		const sm = ctx.sessionManager;
		const model = ctx.model;
		let cost = 0;
		let firstUser = "";
		let last = "";
		try {
			for (const e of sm.getBranch() as any[]) {
				if (e.type !== "message") continue;
				if (e.message.role === "assistant") {
					cost += e.message.usage?.cost?.total ?? 0;
					const text = contentText(e.message.content).trim();
					if (text) last = text.split("\n")[0].slice(0, 120);
				} else if (!firstUser && e.message.role === "user") firstUser = contentText(e.message.content);
			}
		} catch {}
		const usage = safe(() => ctx.getContextUsage());
		return {
			agent: agentId(),
			pid: process.pid,
			sessionId: safe(() => sm.getSessionId()) ?? "",
			name: safe(() => this.pi.getSessionName()) || basename(ctx.cwd) || ctx.cwd,
			task: firstUser.split("\n")[0].slice(0, 100) || undefined,
			cwd: ctx.cwd,
			model: model ? { provider: model.provider, id: model.id, name: model.name, reasoning: !!model.reasoning } : undefined,
			thinking: safe(() => this.pi.getThinkingLevel()),
			status: this.prompts.size || this.terminalPrompt ? "waiting" : this.status,
			context: usage ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } : undefined,
			cost: Math.round(cost * 10000) / 10000,
			queued: safe(() => ctx.hasPendingMessages()) ?? false,
			last,
			herdr: inHerdr() || undefined,
			spawn: process.env.PI_MOBILE_SPAWN || undefined,
			since: this.status === "working" && this.runStartedAt ? this.runStartedAt : undefined,
		};
	}

	/** Coalesces info updates: several pi events usually fire together. */
	pushInfo(): void {
		if (this.infoTimer) return;
		this.infoTimer = setTimeout(() => {
			this.infoTimer = undefined;
			this.emit({ type: "info", info: this.info() });
		}, 30);
	}

	reset(): void {
		this.streamKey = undefined;
		this.partial = undefined;
		this.tools.clear();
		this.emit({ type: "reset" });
		this.pushInfo();
	}

	// ── pi lifecycle → events ──────────────────────────────────────────────────────

	agentStart(): void {
		this.status = "working";
		this.runStartedAt = Date.now();
		this.pushInfo();
	}

	agentSettled(aborted: boolean): void {
		this.status = "idle";
		this.flushStream();
		this.pushInfo();
		const took = Date.now() - this.runStartedAt;
		if (!aborted && this.runStartedAt && took > 20_000) {
			const last = this.lastAssistantText();
			this.attention("finished", last || "pi is idle.", false);
		}
		this.runStartedAt = 0;
	}

	private lastAssistantText(): string {
		try {
			const branch = this.ctx.sessionManager.getBranch() as any[];
			for (let i = branch.length - 1; i >= 0; i--) {
				const m = branch[i].type === "message" ? branch[i].message : undefined;
				if (m?.role === "assistant") {
					const text = contentText(m.content).trim();
					if (text) return text.slice(0, 300);
				}
			}
		} catch {}
		return "";
	}

	messageStart(message: any): void {
		if (message?.role !== "assistant") return;
		this.streamKey = `s${Date.now().toString(36)}${++this.keyCounter}`;
		this.partial = message;
		this.emit({ type: "stream_start", key: this.streamKey, ts: Date.now() });
	}

	messageUpdate(message: any, ev: any): void {
		if (!this.streamKey) return;
		this.partial = message;
		const kind =
			ev?.type === "text_delta" ? "text" : ev?.type === "thinking_delta" ? "thinking" : ev?.type === "toolcall_delta" ? "tool" : undefined;
		if (!kind || typeof ev.delta !== "string") return;
		const k = `${ev.contentIndex}:${kind}`;
		const cur = this.streamBuf.get(k);
		if (cur) cur.delta += ev.delta;
		else {
			const block = message?.content?.[ev.contentIndex];
			this.streamBuf.set(k, { i: ev.contentIndex, kind, delta: ev.delta, name: kind === "tool" ? block?.name : undefined });
		}
		this.streamTimer ??= setTimeout(() => this.flushStream(), 60);
	}

	private flushStream(): void {
		clearTimeout(this.streamTimer);
		this.streamTimer = undefined;
		if (!this.streamKey) return this.streamBuf.clear();
		for (const b of this.streamBuf.values()) this.emit({ type: "stream", key: this.streamKey, ...b });
		this.streamBuf.clear();
	}

	messageEnd(message: any): void {
		if (message?.role === "assistant") {
			this.flushStream();
			const key = this.streamKey ?? `a${Date.now().toString(36)}${++this.keyCounter}`;
			const item = messageToItem(message, key);
			this.streamKey = undefined;
			this.partial = undefined;
			if (item) this.emit({ type: "item", item, replaces: key });
		} else {
			const item = messageToItem(message, `m${Date.now().toString(36)}${++this.keyCounter}`);
			if (item) this.emit({ type: "item", item });
		}
		if (message?.role === "user") this.pushInfo();
	}

	toolStart(id: string, name: string, args: unknown): void {
		const title = toolTitle(name, args);
		this.tools.set(id, { id, name, title, output: "", lastSent: 0 });
		this.emit({ type: "tool_start", id, name, title });
	}

	toolUpdate(id: string, partial: any): void {
		const t = this.tools.get(id);
		if (!t) return;
		t.output = clip(contentText(partial?.content), 4000).text;
		if (t.timer) return;
		const wait = Math.max(0, 250 - (Date.now() - t.lastSent));
		t.timer = setTimeout(() => {
			t.timer = undefined;
			t.lastSent = Date.now();
			if (this.tools.has(id)) this.emit({ type: "tool_update", id, output: t.output });
		}, wait);
	}

	toolEnd(id: string, isError: boolean): void {
		const t = this.tools.get(id);
		if (t) clearTimeout(t.timer);
		this.tools.delete(id);
		this.emit({ type: "tool_end", id, isError });
	}

	terminalPromptChanged(delta: 1 | -1, kind: string, title?: string): void {
		// select/confirm/input are mirrored as answerable prompts; others only mark the session as waiting.
		if (kind === "select" || kind === "confirm" || kind === "input") return;
		this.terminalPrompt = Math.max(0, this.terminalPrompt + delta);
		if (delta > 0) {
			this.emit({ type: "notice", level: "warning", text: `Waiting for input in the terminal${title ? `: ${title}` : ""}` });
			this.attention("needs you", title ? `In the terminal: ${title}` : "Input needed in the terminal", true);
		}
		this.pushInfo();
	}

	mirrorNotice(text: string, level: "info" | "warning" | "error"): void {
		this.emit({ type: "notice", level, text });
	}

	// ── remote dialogs ─────────────────────────────────────────────────────────────

	openPrompt(prompt: Prompt, answer: (value: unknown) => void): void {
		this.prompts.set(prompt.id, { prompt, answer });
		this.emit({ type: "prompt", prompt });
		this.attention("asks", prompt.title, true);
		this.pushInfo();
	}

	closePrompt(id: string, by: "terminal" | "remote" | "timeout", value?: unknown): void {
		if (!this.prompts.delete(id)) return;
		this.emit({ type: "prompt_end", id, by, value });
		this.pushInfo();
	}

	private answer(id: string, value: unknown): { ok: true } {
		const open = this.prompts.get(id);
		if (!open) throw new Error("that question was already answered");
		const p = open.prompt;
		if (p.kind === "select" && value !== undefined && !(typeof value === "string" && p.options?.includes(value)))
			throw new Error("not one of the options");
		if (p.kind === "confirm" && typeof value !== "boolean") throw new Error("expected yes or no");
		if (p.kind === "input" && value !== undefined && typeof value !== "string") throw new Error("expected text");
		open.answer(value);
		return { ok: true };
	}

	// ── remote requests ────────────────────────────────────────────────────────────

	private async handle(m: string, p: any): Promise<unknown> {
		const device = p?._device as { id: string; name: string } | undefined;
		const k = actionKey(p?._k);
		// A repeated phone action (same key) runs once; repeats get the first outcome (issue #1).
		if (k && device && ACTIONS.has(m)) return this.once.run(`${device.id}:${m}:${k}`, () => this.dispatch(m, p, device));
		return this.dispatch(m, p, device);
	}

	private readonly once = new Once();

	private async dispatch(m: string, p: any, device: { id: string; name: string } | undefined): Promise<unknown> {
		switch (m) {
			case "snapshot":
				return this.snapshot(Number(p.limit) || 120, p.before === undefined ? undefined : Number(p.before));
			case "toolOutput":
				return { output: findToolOutput(this.ctx.sessionManager.getBranch(), String(p.id)) ?? "" };
			case "image": {
				const ts = typeof p.ts === "number" ? p.ts : undefined;
				const img = findImage(this.ctx.sessionManager.getBranch(), String(p.id), Number(p.i) || 0, ts);
				if (!img) throw new Error("that image is no longer in this session");
				return img;
			}
			case "send":
				return this.send(p, device?.name ?? "remote");
			case "abort":
				this.ctx.abort();
				return { ok: true };
			case "answer":
				return this.answer(String(p.id), p.value);
			case "models":
				return this.models();
			case "setModel": {
				const model = this.ctx.modelRegistry.find(String(p.provider), String(p.id));
				if (!model) throw new Error("unknown model");
				if (!(await this.pi.setModel(model))) throw new Error(`no credentials for ${model.provider}`);
				this.pushInfo();
				return { ok: true };
			}
			case "setThinking":
				if (!THINKING_LEVELS.includes(String(p.level))) throw new Error("unknown thinking level");
				this.pi.setThinkingLevel(p.level);
				this.pushInfo();
				return { ok: true, level: this.pi.getThinkingLevel() };
			case "compact":
				this.ctx.compact(p.instructions ? { customInstructions: String(p.instructions) } : undefined);
				return { ok: true };
			case "spawn":
				return spawnPi({ cwd: String(p.cwd ?? ""), prompt: typeof p.prompt === "string" ? p.prompt : undefined, spawnId: String(p.spawnId ?? "") });
			case "commands":
				return this.pi
					.getCommands()
					.map((c: any) => ({ name: c.name, description: c.description ?? "", source: c.source ?? "" }))
					.concat([{ name: "compact", description: "Compact the conversation context", source: "remote" }]);
			case "voiceStatus":
				return this.voiceStatus();
			case "transcribe":
			case "distill":
			case "brief":
			case "details":
			case "voiceSession":
			case "speak":
			case "voices":
			case "learn":
			case "voiceState":
			case "draftStart":
			case "draftChunk":
			case "draftState":
			case "draftFinish":
			case "draftEdit":
			case "draftClose": {
				const v = this.voice;
				if (!v) throw new Error("voice is not available in this pi");
				if (m === "transcribe") return v.transcribe(p);
				// Long dictation as a draft: chunks of the recording (each at most MAX_CHUNK, checked by the host).
				if (m === "draftStart") return v.drafts.start(p);
				if (m === "draftChunk") return v.drafts.chunk(p);
				if (m === "draftState") return v.drafts.state(p);
				if (m === "draftFinish") return v.drafts.finish(p);
				if (m === "draftEdit") return v.drafts.edit(p);
				if (m === "draftClose") return v.drafts.close(p);
				if (m === "distill") return v.distill(p);
				if (m === "brief") return v.brief(p);
				if (m === "details") return v.details(p);
				if (m === "voiceSession") return v.voiceSession(p);
				if (m === "speak") return v.speak(p);
				if (m === "voices") return v.voices();
				if (m === "learn") return v.learn(p);
				return v.setListening(p);
			}
			default:
				throw new Error(`unknown request ${m}`);
		}
	}

	/** "What is it doing?" in one spoken sentence, from local state: no model, instant. */
	voiceStatus() {
		const info = this.info();
		const prompts = [...this.prompts.values()].map((o) => o.prompt);
		const tools = [...this.tools.values()];
		const elapsed = this.runStartedAt ? Date.now() - this.runStartedAt : 0;
		let speech: string;
		if (prompts.length) speech = `Pi is waiting for your answer: ${prompts[0].title}`;
		else if (this.terminalPrompt) speech = "Pi is waiting for input in the terminal.";
		else if (info.status === "working") {
			const mins = Math.round(elapsed / 60_000);
			const took = mins >= 1 ? `for ${mins === 1 ? "a minute" : countWord(mins, "minute")}` : "for a few seconds";
			const last = tools[tools.length - 1];
			const now = last ? `, now ${describeActivity(last.name, last.title)}` : "";
			// What pi last said it is doing tells more than which tool is running.
			const said = firstSentences(speakable(this.narration()), 1);
			speech = `Working ${took}${now}.${said && said.split(" ").length <= 30 ? ` It last said: ${said}` : ""}`;
		} else speech = "Pi is idle.";
		return {
			speech,
			status: info.status,
			elapsedMs: elapsed,
			tools: tools.map((t) => ({ name: t.name, title: t.title })),
			prompts,
			queued: info.queued,
			name: info.name,
		};
	}

	/** The latest thing pi wrote in this run (streaming text first), for status by voice. */
	private narration(): string {
		const partial = contentText((this.partial as any)?.content).trim();
		if (partial) return partial.split("\n").filter(Boolean).pop() ?? "";
		const last = this.lastAssistantText();
		return last.split("\n").filter(Boolean).pop() ?? "";
	}

	snapshot(limit: number, before?: number) {
		const items = branchToItems(this.ctx.sessionManager.getBranch());
		const end = before === undefined ? items.length : Math.max(0, Math.min(before, items.length));
		const start = Math.max(0, end - limit);
		const streaming = this.streamKey && this.partial ? messageToItem(this.partial, this.streamKey) : undefined;
		return {
			n: eventCounter(false),
			info: this.info(),
			items: items.slice(start, end),
			start,
			total: items.length,
			streaming,
			tools: [...this.tools.values()].map((t) => ({ id: t.id, name: t.name, title: t.title, output: t.output })),
			prompts: [...this.prompts.values()].map((o) => o.prompt),
		};
	}

	private async send(p: any, from: string): Promise<{ ok: true; delivered: "prompt" | "steer" | "followUp" | "command" | "bash" }> {
		const text = typeof p.text === "string" ? p.text : "";
		const images = Array.isArray(p.images)
			? p.images
					.filter((i: any) => typeof i?.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i?.mimeType))
					.map((i: any) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))
			: [];
		if (!text.trim() && !images.length) throw new Error("empty message");
		const bang = /^!(!?)([\s\S]*)$/.exec(text.trim());
		if (bang && bang[2].trim() && !images.length) {
			await this.bash(bang[2].trim(), bang[1] === "!", from);
			return { ok: true, delivered: "bash" };
		}
		const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (compact && !images.length) {
			this.ctx.compact(compact[1] ? { customInstructions: compact[1] } : undefined);
			return { ok: true, delivered: "command" };
		}
		const content = images.length ? [{ type: "text" as const, text }, ...images] : text;
		const snippet = text.trim().split("\n")[0].slice(0, 60) || `${images.length} image(s)`;
		originalNotify(this.ctx)?.(`From ${from}: ${snippet}`, "info");
		if (this.ctx.isIdle()) {
			this.pi.sendUserMessage(content, { expandPromptTemplates: true });
			return { ok: true, delivered: "prompt" };
		}
		const deliverAs = p.mode === "followUp" ? "followUp" : "steer";
		this.pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: true });
		this.pushInfo();
		return { ok: true, delivered: deliverAs };
	}

	/**
	 * `!command` from a phone, as pi does for terminal input: run it in the session's folder and
	 * record command and output, for the model with the next prompt (`!`) or only for the user
	 * (`!!`). Like the terminal's, it starts no turn; while pi works, pi adds it after the turn.
	 * A phone can't press Esc, so a command stops after PHONE_BASH_TIMEOUT_MS.
	 */
	private async bash(command: string, excluded: boolean, from: string): Promise<void> {
		originalNotify(this.ctx)?.(`From ${from}: !${excluded ? "!" : ""}${command.split("\n")[0].slice(0, 60)}`, "info");
		const r = await this.pi.exec("bash", ["-c", command], { cwd: this.ctx.cwd, timeout: PHONE_BASH_TIMEOUT_MS });
		const output = clip([r.stdout, r.stderr].map((s) => s.replace(/\n+$/, "")).filter(Boolean).join("\n"), PHONE_BASH_OUTPUT_LIMIT).text;
		const exitCode = r.killed ? undefined : r.code;
		let content = `Ran \`${command}\`\n${output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)"}`;
		if (r.killed) content += `\n\n(stopped after ${PHONE_BASH_TIMEOUT_MS / 1000} s)`;
		else if (exitCode !== 0) content += `\n\nCommand exited with code ${exitCode}`;
		const details: PhoneBashDetails = { command, output, exitCode, excluded };
		this.pi.sendMessage({ customType: PHONE_BASH, content, display: true, details });
		// pi tells only its own screen about a sendMessage (no message_end reaches extensions), so
		// phones get the item from here; without it they saw it only on their next snapshot.
		const message = { role: "custom", customType: PHONE_BASH, content, display: true, details, timestamp: Date.now() };
		const item = messageToItem(message, `m${Date.now().toString(36)}${++this.keyCounter}`);
		if (item) this.emit({ type: "item", item });
	}

	private models() {
		const scoped = this.ctx.scopedModels?.map((s: any) => s.model).filter(Boolean) ?? [];
		const list = scoped.length ? scoped : safe(() => this.ctx.modelRegistry.getAvailable()) ?? [];
		return {
			current: this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : undefined,
			thinking: safe(() => this.pi.getThinkingLevel()),
			levels: THINKING_LEVELS,
			models: list.map((m: any) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning })),
		};
	}
}

function safe<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

// ── dialog bridging ──────────────────────────────────────────────────────────────
//
// ctx.ui is one object shared by every extension in the runtime, so wrapping its dialog methods
// lets a phone answer any extension's select/confirm/input (permission gates included).
// The terminal dialog stays open; whichever side answers first wins and the other is dismissed.

type UI = ExtensionContext["ui"] & { [PATCHED]?: Record<string, (...a: any[]) => any> };

function originalNotify(ctx: ExtensionContext): ((m: string, t?: "info" | "warning" | "error") => void) | undefined {
	const ui = ctx.ui as UI;
	const orig = ui[PATCHED]?.notify;
	return orig ? (m, t) => orig.call(ui, m, t) : (m, t) => ui.notify(m, t);
}

function patchUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as UI;
	if (ui[PATCHED]) return;
	const orig = { select: ui.select, confirm: ui.confirm, input: ui.input, notify: ui.notify };
	ui[PATCHED] = orig;

	ui.select = (title, options, opts) =>
		race({ kind: "select", title, options: [...options] }, (signal) => orig.select.call(ui, title, options, { ...opts, signal }), opts);
	ui.confirm = (title, message, opts) =>
		race({ kind: "confirm", title, message }, (signal) => orig.confirm.call(ui, title, message, { ...opts, signal }), opts);
	ui.input = (title, placeholder, opts) =>
		race({ kind: "input", title, placeholder }, (signal) => orig.input.call(ui, title, placeholder, { ...opts, signal }), opts);
	ui.notify = (message, type) => {
		orig.notify.call(ui, message, type);
		activeBridge()?.mirrorNotice(String(message), type ?? "info");
	};
}

async function race<T>(
	spec: Omit<Prompt, "id">,
	local: (signal: AbortSignal | undefined) => Promise<T>,
	opts: { signal?: AbortSignal; timeout?: number } | undefined,
): Promise<T> {
	const bridge = activeBridge();
	if (!bridge || opts?.signal?.aborted) return local(opts?.signal);
	const ctrl = new AbortController();
	const signal = opts?.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
	const id = randomId();
	let remote!: (v: unknown) => void;
	const remoteAnswer = new Promise<{ by: "remote"; v: T }>((resolve) => {
		remote = (v) => resolve({ by: "remote", v: v as T });
	});
	bridge.openPrompt({ id, ...spec, ...(opts?.timeout ? { expiresAt: Date.now() + opts.timeout } : {}) }, remote);
	try {
		const terminal = local(signal).then((v) => ({ by: "terminal" as const, v }));
		terminal.catch(() => {}); // a dialog dismissed after the phone answered may reject; nobody awaits it then
		const winner = await Promise.race([terminal, remoteAnswer]);
		if (winner.by === "remote") ctrl.abort();
		bridge.closePrompt(id, winner.by, winner.v);
		return winner.v;
	} catch (e) {
		bridge.closePrompt(id, "terminal");
		throw e;
	}
}
