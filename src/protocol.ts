// Wire shapes shared by the bridge (inside each pi), the hub, and web/app.js, plus the
// normalization of pi session messages into compact transcript items for a phone.

export const PROTOCOL = 1;

export type Status = "idle" | "working" | "waiting";

export interface AgentInfo {
	/** Stable for the life of the pi process; survives /new, /resume and /reload. */
	agent: string;
	pid: number;
	sessionId: string;
	/** The session's explicit name, else its project folder. */
	name: string;
	/** First line of the first prompt: what this session is working on. */
	task?: string;
	cwd: string;
	model?: { provider: string; id: string; name?: string; reasoning?: boolean };
	thinking?: string;
	status: Status;
	context?: { tokens: number | null; window: number; percent: number | null };
	cost?: number;
	queued?: boolean;
	/** First line of the latest assistant text, for the phone's session list. */
	last?: string;
	/** This pi runs inside herdr, so it can start new sessions for the phone. */
	herdr?: boolean;
	/** Set on a session the phone asked herdr to start, so the phone can open it. */
	spawn?: string;
	/** When the current run started (ms epoch), for "Working · 0:42". */
	since?: number;
}

export type Block =
	| { t: "text"; text: string }
	| { t: "thinking"; text: string }
	| { t: "tool"; id: string; name: string; title: string; args: string };

export type Item =
	| { k: "user"; id: string; text: string; images: number; ts: number }
	| { k: "assistant"; id: string; blocks: Block[]; model?: string; stop?: string; error?: string; ts: number }
	| { k: "tool"; id: string; name: string; output: string; isError: boolean; truncated: boolean; diff?: string; images?: number; ts: number }
	| { k: "bash"; id: string; command: string; output: string; exitCode?: number; excluded?: boolean; ts: number }
	| { k: "custom"; id: string; customType: string; text: string; ts: number }
	| { k: "summary"; id: string; kind: "compaction" | "branch"; text: string; ts: number };

export type PromptKind = "select" | "confirm" | "input";

export interface Prompt {
	id: string;
	kind: PromptKind;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	expiresAt?: number;
}

/** Events a bridge publishes; the hub stamps them with `agent` and a hub-wide `seq`. */
export type AgentEvent =
	| { type: "info"; info: AgentInfo }
	| { type: "reset" }
	| { type: "gone" }
	| { type: "item"; item: Item; replaces?: string }
	| { type: "stream_start"; key: string; ts: number }
	| { type: "stream"; key: string; i: number; kind: "text" | "thinking" | "tool"; delta: string; name?: string }
	| { type: "tool_start"; id: string; name: string; title: string }
	| { type: "tool_update"; id: string; output: string }
	| { type: "tool_end"; id: string; isError: boolean }
	| { type: "prompt"; prompt: Prompt }
	| { type: "prompt_end"; id: string; by: "terminal" | "remote" | "timeout"; value?: unknown }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string };

/** `n`: the bridge's per-process event counter (absent on hub-generated events). */
export type HubEvent = AgentEvent & { agent: string; seq: number; n?: number };

export const TOOL_OUTPUT_LIMIT = 6000;
const ARGS_LIMIT = 2000;

export function clip(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	// Keep the tail: the end of command output is what tells you how it went.
	return { text: `…\n${text.slice(text.length - limit)}`, truncated: true };
}

type Content = string | ReadonlyArray<{ type: string; text?: string }> | undefined;

export function contentText(content: Content): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function imageCount(content: Content): number {
	return Array.isArray(content) ? content.filter((c) => c.type === "image").length : 0;
}

export function toolTitle(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((k) => a[k]).find((v) => typeof v === "string" && v) as string | undefined;
	const title = pick("command", "path", "file_path", "pattern", "query", "url", "description", "prompt", "name");
	if (title) return title.split("\n")[0].slice(0, 200);
	// Batched tools (e.g. a multi-file edit: { edits: [{ path }] }) name their targets inside arrays.
	const paths = new Set<string>();
	for (const v of Object.values(a)) {
		if (!Array.isArray(v)) continue;
		for (const el of v) {
			const p = el && typeof el === "object" ? (el.path ?? el.file_path ?? el.glob) : undefined;
			if (typeof p === "string" && p) paths.add(p);
		}
	}
	return [...paths].join(", ").slice(0, 200);
}

function argsText(args: unknown): string {
	try {
		const s = typeof args === "string" ? args : JSON.stringify(args, null, 1);
		return s.length > ARGS_LIMIT ? `${s.slice(0, ARGS_LIMIT)}…` : s;
	} catch {
		return "";
	}
}

// pi messages are an open union with custom roles; read them structurally.
type AnyMessage = any;

/**
 * A `!command` sent from a phone. pi runs `!` itself only for terminal input, so the bridge runs
 * the command and records it as a custom message of this type; `details` carries what a phone
 * shows, and `excluded` (`!!`) keeps it out of the model's context (the `context` hook).
 */
export const PHONE_BASH = "pi-mobile-bash";

export interface PhoneBashDetails {
	command: string;
	output: string;
	exitCode?: number;
	excluded: boolean;
}

function customItem(customType: string, content: Content, details: any, id: string, ts: number): Item {
	if (customType === PHONE_BASH && typeof details?.command === "string") {
		const out = clip(String(details.output ?? ""), TOOL_OUTPUT_LIMIT);
		return { k: "bash", id, command: details.command, output: out.text, exitCode: details.exitCode, excluded: !!details.excluded, ts };
	}
	return { k: "custom", id, customType, text: contentText(content), ts };
}

/** Converts one pi AgentMessage to a transcript item, or undefined for messages a phone need not show. */
export function messageToItem(message: AnyMessage, id: string): Item | undefined {
	const ts = typeof message?.timestamp === "number" ? message.timestamp : Date.now();
	switch (message?.role) {
		case "user":
			return { k: "user", id, text: contentText(message.content), images: imageCount(message.content), ts };
		case "assistant": {
			const blocks: Block[] = [];
			for (const c of message.content ?? []) {
				if (c.type === "text" && c.text) blocks.push({ t: "text", text: c.text });
				else if (c.type === "thinking" && c.thinking) blocks.push({ t: "thinking", text: c.thinking });
				else if (c.type === "toolCall")
					blocks.push({ t: "tool", id: c.id, name: c.name, title: toolTitle(c.name, c.arguments), args: argsText(c.arguments) });
			}
			return {
				k: "assistant",
				id,
				blocks,
				model: message.model,
				stop: message.stopReason,
				error: message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage || message.stopReason : undefined,
				ts,
			};
		}
		case "toolResult": {
			const out = clip(contentText(message.content), TOOL_OUTPUT_LIMIT);
			const diff = typeof message.details?.diff === "string" ? clip(message.details.diff, TOOL_OUTPUT_LIMIT * 2).text : undefined;
			const images = imageCount(message.content);
			return {
				k: "tool",
				id: message.toolCallId,
				name: message.toolName,
				output: out.text,
				isError: !!message.isError,
				truncated: out.truncated,
				...(diff ? { diff } : {}),
				...(images ? { images } : {}),
				ts,
			};
		}
		case "bashExecution": {
			const out = clip(String(message.output ?? ""), TOOL_OUTPUT_LIMIT);
			return { k: "bash", id, command: message.command, output: out.text, exitCode: message.exitCode, ts };
		}
		case "custom":
			if (message.display === false) return undefined;
			return customItem(message.customType, message.content, message.details, id, ts);
		case "compactionSummary":
			return { k: "summary", id, kind: "compaction", text: message.summary, ts };
		case "branchSummary":
			return { k: "summary", id, kind: "branch", text: message.summary, ts };
		default:
			return undefined;
	}
}

type AnyEntry = any;

/** Converts the active branch (root → leaf) to transcript items. */
export function branchToItems(entries: readonly AnyEntry[]): Item[] {
	const items: Item[] = [];
	for (const e of entries) {
		const ts = Date.parse(e.timestamp) || Date.now();
		if (e.type === "message") {
			const item = messageToItem(e.message, e.id);
			if (item) items.push(item);
		} else if (e.type === "custom_message" && e.display) {
			items.push(customItem(e.customType, e.content, e.details, e.id, ts));
		} else if (e.type === "compaction") {
			items.push({ k: "summary", id: e.id, kind: "compaction", text: e.summary, ts });
		} else if (e.type === "branch_summary") {
			items.push({ k: "summary", id: e.id, kind: "branch", text: e.summary, ts });
		}
	}
	return items;
}

/**
 * The `index`th image of a transcript item on the branch: a user message (by entry id, or by its
 * timestamp for live items, which carry a temporary id) or a tool result (by tool call id).
 */
export function findImage(
	entries: readonly AnyEntry[],
	id: string,
	index: number,
	ts?: number,
): { data: string; mimeType: string } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		const m = e?.type === "message" ? e.message : undefined;
		if (!m) continue;
		const hit =
			e.id === id || (m.role === "toolResult" && m.toolCallId === id) || (m.role === "user" && ts !== undefined && m.timestamp === ts);
		if (!hit || !Array.isArray(m.content)) continue;
		const img = m.content.filter((c: any) => c?.type === "image" && typeof c.data === "string")[index];
		if (img) return { data: img.data, mimeType: String(img.mimeType ?? "image/png") };
	}
	return undefined;
}

/** Full (untruncated, but bounded) output of one tool call on the branch. */
export function findToolOutput(entries: readonly AnyEntry[], toolCallId: string, limit = 200_000): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i]?.type === "message" ? entries[i].message : undefined;
		if (m?.role === "toolResult" && m.toolCallId === toolCallId) return clip(contentText(m.content), limit).text;
	}
	return undefined;
}
