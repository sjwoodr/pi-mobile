// pi-mobile: continue pi sessions from a phone.
//
// One switch for the whole machine: `/remote` in any pi shares every pi session on this computer
// (running ones join within seconds, new ones on start) and shows a pairing QR code until a phone
// is paired.
//
//   /remote            connect this machine; QR if no phone is paired yet, otherwise status
//   /remote pair       pair another device
//   /remote off        stop sharing: this session only, or every session on the machine
//   /remote devices    paired devices; pick one to revoke
//   /remote settings   exposure, HTTPS address, port (the hub restarts by itself)
//   /remote add <host> add a machine you can ssh to; your phone approves it (also `pi-mobile add`)
//   /remote remove <m> remove a machine from your phone's list

import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { apnsKeyProblem } from "./apns.ts";
import { Bridge } from "./bridge.ts";
import { registerHerdrBlocked } from "./herdr.ts";
import { LOOPBACK_LABEL } from "./expose.ts";
import { closeProcessHub, type LinkState } from "./link.ts";
import type { AgentInfo } from "./protocol.ts";
import { qrLines } from "./qr.ts";
import { type Config, configPath, linkSecret, loadConfig, saveConfig, stateDir } from "./store.ts";
import { loadVoiceConfig, speechDir } from "pi-speech/config";
import { registerDictation } from "pi-speech/dictation";
import { registerVoiceMode } from "pi-speech/voice-mode";
import { VoiceHost } from "pi-speech/host";
import { registryComplete } from "pi-speech/model";
import { agentVoiceNote } from "pi-speech/speech";
import { httpsUrl } from "../bin/https-url.mjs";

/** Set by `/remote off` → "Only this session"; lives on globalThis so it survives /new and /reload. */
const HIDDEN = Symbol.for("pi-mobile.hidden");
/** Set by any `/remote off`, so a `--remote` flag does not re-share the session behind the user's back. */
const FLAG_OFF = Symbol.for("pi-mobile.flag-off");
type G = typeof globalThis & { [HIDDEN]?: boolean; [FLAG_OFF]?: boolean };
const SUBCOMMANDS = [
	{ value: "pair", label: "pair", description: "Pair another device" },
	{ value: "off", label: "off", description: "Stop sharing this session or the whole machine" },
	{ value: "devices", label: "devices", description: "Paired devices; revoke one" },
	{ value: "settings", label: "settings", description: "Exposure, HTTPS address, port, iPhone push" },
	{ value: "add", label: "add", description: "Add a machine you can ssh to (your phone approves it)" },
	{ value: "remove", label: "remove", description: "Remove a machine from your phone's list" },
];
/** Session state as a glyph and a theme colour; the glyph alone still reads without colour. */
const STATUS_ICON: Record<string, [string, "warning" | "accent" | "dim"]> = {
	waiting: ["◐", "warning"],
	working: ["●", "accent"],
	idle: ["○", "dim"],
};
/** Prose in a panel wraps at a readable measure; only the QR code may make a panel wider. */
const PANEL_MEASURE = 76;
/**
 * A line that sizes the panel instead of wrapping: an address (wraps only when the terminal is
 * narrower) or, with `narrow`, a centred graphic (the QR code) replaced by that text when it can't fit.
 */
interface Fixed {
	fixed: string;
	width: number;
	narrow?: string;
}
const unwrapped = (fixed: string): Fixed => ({ fixed, width: visibleWidth(fixed) });
type PanelLine = string | Fixed;

interface HubStatus {
	pid: number;
	endpoints: { label: string; url: string }[];
	serveEnable?: string;
	agents: AgentInfo[];
	clients: { count: number; names: string[] };
	devices: { id: string; name: string; role: string; createdAt: number; lastSeenAt?: number }[];
}

export default function piMobile(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	let ctx: ExtensionContext | undefined;
	let closePanel: (() => void) | undefined;
	let watching = false;
	let offInput: (() => void) | undefined;
	const g = globalThis as G;

	pi.registerFlag("remote", { type: "boolean", description: "Share this session with your phone (pi-mobile)" });
	registerHerdrBlocked(pi);

	// Voice (pi-speech): dictation and voice mode in this terminal (alt+m, /dictate; /voice, alt+v), and the
	// host side of the phone's voice mode.
	const complete = registryComplete(() => ctx!, () => loadVoiceConfig().model);
	const voice = new VoiceHost({ ctx: () => ctx!, config: () => loadVoiceConfig(), stateDir: speechDir, complete });
	registerDictation(pi, complete);
	registerVoiceMode(pi, complete);
	pi.on("before_agent_start", async (e) => {
		const mode = voice.listeningMode();
		if (!mode) return;
		return { systemPrompt: e.systemPrompt + agentVoiceNote(mode) };
	});

	// Like Claude Code's `/rc`: the command that controls it, in plain text, green while sharing. No
	// emoji (they ignore the theme colour and their width varies by terminal); the word carries the
	// state too, so it reads without colour.
	let everLinked = false;
	const footer = (s: LinkState | undefined) => {
		if (!ctx?.hasUI) return;
		const t = ctx.ui.theme;
		if (!s) {
			everLinked = false;
			return ctx.ui.setStatus("remote", undefined);
		}
		if (s.kind === "connecting")
			return ctx.ui.setStatus("remote", everLinked ? t.fg("warning", "/remote reconnecting") : t.fg("dim", "/remote connecting"));
		if (s.kind === "error") return ctx.ui.setStatus("remote", t.fg("error", "/remote failed"));
		everLinked = true;
		ctx.ui.setStatus("remote", t.fg("success", "/remote") + viewers(t, s.clients));
	};

	const start = (c: ExtensionContext) => {
		if (bridge) return bridge;
		let lastError = "";
		const b = new Bridge(pi, c, loadConfig, linkSecret());
		b.voice = voice;
		b.onState = (s) => {
			footer(s);
			if (s.kind === "error" && s.message !== lastError) {
				lastError = s.message;
				c.ui.notify(`pi-mobile: ${s.message}`, "error");
			}
			if (s.kind === "linked") lastError = "";
		};
		b.onMessage = (msg) => {
			if (msg.t === "paired" && closePanel) {
				closePanel();
				ctx?.ui.notify(`Paired ${msg.device.name}. Every pi session on this machine is on your phone.`, "info");
			}
		};
		bridge = b;
		b.start();
		return b;
	};

	const stop = () => {
		bridge?.stop();
		bridge = undefined;
		footer(undefined);
	};

	const shouldShare = () => !g[HIDDEN] && (loadConfig().enabled || (pi.getFlag("remote") === true && !g[FLAG_OFF]));
	const sync = () => {
		if (!ctx) return;
		if (shouldShare()) start(ctx);
		else stop();
	};

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		sync();
		// Keystrokes here mean you are at the computer; the hub holds phone notifications meanwhile.
		offInput?.();
		offInput =
			c.mode === "tui"
				? c.ui.onTerminalInput(() => {
						bridge?.presence();
						return undefined;
					})
				: undefined;
		if (!watching) {
			// `/remote` or `/remote off` in another terminal flips the machine switch; follow it.
			watching = true;
			watchFile(configPath(), { interval: 1500, persistent: false }, sync);
		}
	});
	pi.on("session_shutdown", async (e) => {
		stop();
		// Drafts dictated from the phone: their timers and in-flight updates end with the session.
		voice.drafts.dispose();
		offInput?.();
		offInput = undefined;
		if (watching) unwatchFile(configPath(), sync);
		watching = false;
		if (e.reason === "quit") closeProcessHub();
	});

	const withBridge =
		<E>(fn: (b: Bridge, e: E) => void) =>
		async (e: E, c: ExtensionContext) => {
			ctx = c;
			if (!bridge) return;
			bridge.setContext(c);
			fn(bridge, e);
		};
	pi.on("agent_start", withBridge((b) => b.agentStart()));
	pi.on("agent_settled", withBridge((b, e: any) => b.agentSettled(!!e.aborted)));
	pi.on("message_start", withBridge((b, e: any) => b.messageStart(e.message)));
	pi.on("message_update", withBridge((b, e: any) => b.messageUpdate(e.message, e.assistantMessageEvent)));
	pi.on("message_end", withBridge((b, e: any) => b.messageEnd(e.message)));
	pi.on("tool_execution_start", withBridge((b, e: any) => !e.parentToolCallId && b.toolStart(e.toolCallId, e.toolName, e.args)));
	pi.on("tool_execution_update", withBridge((b, e: any) => !e.parentToolCallId && b.toolUpdate(e.toolCallId, e.partialResult)));
	pi.on("tool_execution_end", withBridge((b, e: any) => !e.parentToolCallId && b.toolEnd(e.toolCallId, !!e.isError)));
	pi.on("turn_end", withBridge((b) => b.pushInfo()));
	pi.on("model_select", withBridge((b) => b.pushInfo()));
	pi.on("thinking_level_select", withBridge((b) => b.pushInfo()));
	pi.on("session_info_changed", withBridge((b) => b.pushInfo()));
	pi.on("session_compact", withBridge((b) => b.reset()));
	pi.on("session_tree", withBridge((b) => b.reset()));
	pi.on("ui_prompt_start", withBridge((b, e: any) => b.terminalPromptChanged(1, e.kind, e.title)));
	pi.on("ui_prompt_end", withBridge((b, e: any) => b.terminalPromptChanged(-1, e.kind, e.title)));

	pi.registerCommand("remote", {
		description: "Use every pi session on this machine from your phone (end-to-end encrypted)",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, c) => {
			ctx = c;
			const [sub = "", arg = ""] = args.trim().split(/\s+/);
			switch (sub.toLowerCase()) {
				case "add":
					return addMachine(c, arg);
				case "remove":
					return removeMachine(c, arg);
				case "":
					return connect(c);
				case "pair":
					return pair(c);
				case "off":
					return off(c);
				case "devices":
					return devices(c);
				case "settings":
					return settings(c);
				default:
					return c.ui.notify("Usage: /remote [pair | off | devices | settings | add <ssh-host> | remove <machine>]", "info");
			}
		},
	});

	/** The machine commands live in a dependency-free script that also runs as `npx pi-mobile` on a fresh box. */
	const machines = (): Promise<any> => import(new URL("../bin/pi-mobile.mjs", import.meta.url).href);

	async function addMachine(c: ExtensionCommandContext, host: string): Promise<void> {
		if (!host) return c.ui.notify("Usage: /remote add <ssh-host>: a machine you can ssh to, with Tailscale", "info");
		c.ui.notify(`Adding ${host}: setting up pi-mobile there over ssh…`, "info");
		try {
			const r = await (await machines()).add(host);
			c.ui.notify(`${r.machine.name} is ready (${r.origin}). Approve it on your phone: ${r.phones.join(", ")}.`, "info");
		} catch (e: any) {
			c.ui.notify(`pi-mobile: couldn't add ${host}: ${e?.message ?? e}`, "error");
		}
	}

	async function removeMachine(c: ExtensionCommandContext, name: string): Promise<void> {
		const m = await machines();
		if (!name) {
			const list = m.knownMachines();
			return c.ui.notify(list.length ? `Machines added from here: ${list.map((x: any) => x.name).join(", ")}. /remote remove <name>` : "No machines were added from this computer.", "info");
		}
		try {
			const r = m.remove(name);
			c.ui.notify(`Removing ${r.machine.name}: your phone forgets it the next time it connects.`, "info");
		} catch (e: any) {
			c.ui.notify(`pi-mobile: ${e?.message ?? e}`, "error");
		}
	}

	async function linked(c: ExtensionContext, timeoutMs = 8000): Promise<Bridge | undefined> {
		const b = start(c);
		const until = Date.now() + timeoutMs;
		while (!b.isLinked && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
		if (b.isLinked) return b;
		const s = b.linkState;
		c.ui.notify(`pi-mobile: ${s.kind === "error" ? s.message : "could not reach the hub"}`, "error");
		return undefined;
	}

	/** Turns the machine switch on and un-hides this session. */
	function enable(): void {
		g[HIDDEN] = false;
		const cfg = loadConfig();
		if (!cfg.enabled) saveConfig({ ...cfg, enabled: true });
	}

	/** `/remote`: connect the machine, then pair (first time) or show where things stand. */
	async function connect(c: ExtensionCommandContext): Promise<void> {
		enable();
		const b = await linked(c);
		if (!b) return;
		const s = await b.hubRequest<HubStatus>("status");
		if (!s.devices.length) return pair(c);
		await overview(c, s);
	}

	async function overview(c: ExtensionCommandContext, s: HubStatus): Promise<void> {
		const t = c.ui.theme;
		const [primary, ...others] = s.endpoints.filter((e) => e.label !== LOOPBACK_LABEL);
		const sessions = [...s.agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		const phones = s.clients.count ? `${s.clients.count} phone${s.clients.count === 1 ? "" : "s"} connected` : "no phone connected right now";
		await panel(c, "pi-mobile", "any key closes", [
			`${t.fg("success", "Sharing")} ${sessions.length} session${sessions.length === 1 ? "" : "s"} ${t.fg("dim", "·")} ${phones}`,
			"",
			...(primary
				? [
						unwrapped(`${t.fg("dim", "Open")} ${t.fg("accent", primary.url)} ${t.fg("dim", primary.label)}`),
						...others.map((o) => unwrapped(`${t.fg("dim", "or  ")} ${o.url} ${t.fg("dim", o.label)}`)),
					]
				: httpsFixLines(c, s.serveEnable)),
			"",
			...sessions.map((a) => {
				const [glyph, color] = STATUS_ICON[a.status] ?? STATUS_ICON.idle;
				const me = a.pid === process.pid ? t.fg("dim", " · this terminal") : "";
				return `${t.fg(color, glyph)} ${a.name}${me}${a.task ? `  ${t.fg("dim", a.task)}` : ""}`;
			}),
			"",
			t.fg("dim", "/remote pair  another device · /remote off  stop sharing · /remote settings"),
		]);
	}

	async function pair(c: ExtensionCommandContext): Promise<void> {
		enable();
		const b = await linked(c);
		if (!b) return;
		const pairing = await b.hubRequest<{ links: { label: string; url: string }[]; serveEnable?: string }>("pair", {});
		// Phones pair only over HTTPS: no secure address yet means the fix, never a plain-HTTP code.
		const [primary, ...others] = pairing.links.filter((l) => l.label !== LOOPBACK_LABEL);
		const header = "Scan with your phone to use every pi session on this machine";
		if (!primary) {
			if (c.mode !== "tui") return c.ui.notify(httpsFixText(pairing.serveEnable).join("\n"), "warning");
			await panel(c, "Pair a phone", "any key closes", httpsFixLines(c, pairing.serveEnable).slice(1));
			return;
		}
		if (c.mode !== "tui") {
			c.ui.notify(`${header}:\n${[primary, ...others].map((l) => `${l.label}: ${l.url}`).join("\n")}`, "info");
			return;
		}
		const t = c.ui.theme;
		const qr = qrLines(primary.url);
		const narrow = t.fg("warning", `Widen the terminal to ${qr.width + 6} columns to show the QR code, or open the address below on your phone.`);
		await panel(c, "Pair a phone", "closes when paired · any key closes", [
			header,
			"",
			...qr.lines.map((fixed) => ({ fixed, width: qr.width, narrow })),
			"",
			unwrapped(`${t.fg("accent", primary.url)} ${t.fg("dim", primary.label)}`),
			...others.map((o) => unwrapped(`${o.url} ${t.fg("dim", o.label)}`)),
			"",
			t.fg("dim", "Single-use code, valid 10 min. Traffic is end-to-end encrypted."),
		]);
	}

	/**
	 * No HTTPS address yet. Either the tailnet has not enabled Serve (one click, and pi finishes by
	 * itself) or Tailscale is not running here.
	 */
	function httpsFixText(link: string | undefined): string[] {
		return link
			? ["Your phone connects over HTTPS. Turn on HTTPS for your tailnet (one click):", link, "pi finishes the setup by itself; then run /remote again for the code."]
			: [
					"Your phone connects over HTTPS, and this computer has no HTTPS address yet.",
					"Install Tailscale here and on your phone (same account), then run /remote again.",
				];
	}

	function httpsFixLines(c: ExtensionCommandContext, link: string | undefined): PanelLine[] {
		const t = c.ui.theme;
		const [why, fix, after] = httpsFixText(link);
		return link ? ["", t.fg("warning", why), unwrapped(t.fg("accent", fix)), t.fg("dim", after)] : ["", t.fg("warning", why), t.fg("dim", fix)];
	}

	async function off(c: ExtensionCommandContext): Promise<void> {
		const choice = c.hasUI
			? await c.ui.select("Stop sharing with your phone", ["Only this session", "Every session on this machine", "Cancel"])
			: "Every session on this machine";
		if (choice === "Only this session" || choice === "Every session on this machine") g[FLAG_OFF] = true;
		if (choice === "Only this session") {
			g[HIDDEN] = true;
			stop();
			c.ui.notify("This session is hidden from your phone. /remote shares it again.", "info");
		} else if (choice === "Every session on this machine") {
			saveConfig({ ...loadConfig(), enabled: false });
			g[HIDDEN] = false;
			stop();
			c.ui.notify("No pi session on this machine is shared now. Paired phones stay paired; /remote turns sharing back on.", "info");
		}
	}

	async function devices(c: ExtensionCommandContext): Promise<void> {
		const b = await linked(c, 3000);
		if (!b) return;
		const s = await b.hubRequest<HubStatus>("status");
		if (!s.devices.length) return c.ui.notify("No paired devices. /remote pairs one.", "info");
		const label = (d: HubStatus["devices"][number]) =>
			`${d.name} · last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}`;
		const pick = await c.ui.select("Paired devices — choose one to revoke", [...s.devices.map(label), "Revoke all", "Done"]);
		if (!pick || pick === "Done") return;
		const ids = pick === "Revoke all" ? s.devices.map((d) => d.id) : s.devices.filter((d) => label(d) === pick).map((d) => d.id);
		const what = pick === "Revoke all" ? "every device" : pick.split(" · ")[0];
		if (!(await c.ui.confirm(`Revoke ${what}?`, "It loses access immediately and must be paired again."))) return;
		const removed = await b.hubRequest<{ name: string }[]>("revoke", { ids });
		c.ui.notify(`Revoked ${removed.map((d) => d.name).join(", ")}.`, "info");
	}

	async function settings(c: ExtensionCommandContext): Promise<void> {
		const cfg = loadConfig();
		const url = `HTTPS address (voice, lock-screen notifications): ${cfg.publicUrl ?? (cfg.tailscale === false ? "none" : "automatic with Tailscale")}`;
		const port = `Port: ${cfg.port}`;
		const apns = `iPhone push (APNs): ${cfg.apns?.keyFile ? `${cfg.apns.topic} · key ${cfg.apns.keyId}${cfg.apns.sandbox ? " · sandbox" : ""}` : "off"}`;
		const relay = `Push relay (App Store app): ${cfg.relay === false ? "off" : "on"}${process.env.PI_MOBILE_RELAY === "off" ? " · off by PI_MOBILE_RELAY" : ""}`;
		const pick = await c.ui.select("pi-mobile settings", [url, port, apns, relay, "Done"]);
		const next: Config = { ...cfg };
		if (pick === url) {
			const v = await c.ui.input(`HTTPS address that forwards to port ${cfg.port}; empty for automatic (Tailscale Serve)`, cfg.publicUrl ?? "https://");
			if (v === undefined) return;
			const trimmed = v.trim().replace(/\/+$/, "");
			const empty = !trimmed || trimmed === "https:" || trimmed === "https://";
			const url = httpsUrl(trimmed);
			if (!empty && !url) return c.ui.notify("That is not a plain https:// address (no user name, ? or #).", "warning");
			next.publicUrl = empty ? undefined : url;
		} else if (pick === port) {
			const v = await c.ui.input("Port (1024–65535)", String(cfg.port));
			if (v === undefined) return;
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1024 || n > 65535) return c.ui.notify("Port must be 1024–65535.", "warning");
			next.port = n;
		} else if (pick === apns) {
			const a = cfg.apns;
			const keyFile = await c.ui.input("Path to the AuthKey_….p8 file from developer.apple.com (Keys); empty turns iPhone push off", a?.keyFile ?? "");
			if (keyFile === undefined) return;
			if (!keyFile.trim()) next.apns = undefined;
			else {
				const file = keyFile.trim().replace(/^~(?=\/)/, homedir());
				let problem: string | undefined;
				try {
					problem = apnsKeyProblem(readFileSync(file, "utf8"));
				} catch {
					problem = "can't read the file";
				}
				if (problem) return c.ui.notify(`${file}: ${problem}.`, "warning");
				const keyId = await c.ui.input("Key ID (10 characters, also in the file name)", a?.keyId ?? /AuthKey_(\w{10})/.exec(file)?.[1] ?? "");
				if (!keyId?.trim()) return;
				const teamId = await c.ui.input("Team ID (Membership details)", a?.teamId ?? "");
				if (!teamId?.trim()) return;
				const topic = await c.ui.input("The app's bundle ID", a?.topic ?? "");
				if (!topic?.trim()) return;
				const env = await c.ui.select("Default APNs environment", ["production — TestFlight and App Store builds", "sandbox — builds run from Xcode"]);
				if (!env) return;
				next.apns = { keyFile: file, keyId: keyId.trim(), teamId: teamId.trim(), topic: topic.trim(), sandbox: env.startsWith("sandbox") };
			}
		} else if (pick === relay) {
			// Turning it off: this computer never sends to a relay, even for phones that registered one.
			next.relay = cfg.relay === false ? undefined : false;
		} else return;
		saveConfig(next);
		// Linked pi processes re-read the config when they reconnect, so restarting the hub applies it everywhere.
		if (bridge?.isLinked) await bridge.hubRequest("restart").catch(() => {});
		else closeProcessHub();
		c.ui.notify("Saved. The hub restarts with the new settings and phones reconnect by themselves (pair again if the address changed).", "info");
	}

	/** A bordered overlay: title in the top border, a key hint in the bottom one, prose wrapped to fit. */
	async function panel(c: ExtensionCommandContext, title: string, hint: string, lines: PanelLine[]): Promise<void> {
		if (c.mode !== "tui") {
			c.ui.notify(lines.filter((l) => typeof l === "string").join("\n"), "info");
			return;
		}
		const fixedWidth = Math.max(0, ...lines.map((l) => (typeof l === "string" ? 0 : l.width)));
		const proseWidth = Math.max(...lines.map((l) => (typeof l === "string" ? visibleWidth(l) : 0)));
		const content = Math.max(fixedWidth, Math.min(PANEL_MEASURE, proseWidth), visibleWidth(title) + visibleWidth(hint) + 6);
		await c.ui.custom<void>(
			(_tui, theme, _kb, done) => {
				closePanel = () => {
					closePanel = undefined;
					done();
				};
				return {
					render(width: number) {
						const inner = Math.max(10, width - 4);
						const border = (s: string) => theme.fg("borderAccent", s);
						const row = (s: string) => {
							const cut = truncateToWidth(s, inner);
							return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
						};
						const name = truncateToWidth(title, Math.max(1, inner - 2));
						const out = [border("╭─ ") + theme.fg("accent", theme.bold(name)) + border(` ${"─".repeat(Math.max(0, inner - visibleWidth(name) - 1))}╮`)];
						let narrowShown = false;
						for (const l of lines) {
							if (typeof l !== "string") {
								if (l.width <= inner) out.push(row(l.narrow ? " ".repeat((inner - l.width) >> 1) + l.fixed : l.fixed));
								else if (!l.narrow) for (const w of wrapTextWithAnsi(l.fixed, inner)) out.push(row(w));
								else if (!narrowShown) {
									narrowShown = true;
									for (const w of wrapTextWithAnsi(l.narrow, inner)) out.push(row(w));
								}
							} else if (!l) out.push(row(""));
							else for (const w of wrapTextWithAnsi(l, inner)) out.push(row(w));
						}
						const keys = visibleWidth(hint) + 4 <= inner ? hint : "";
						out.push(
							keys
								? border(`╰${"─".repeat(inner - visibleWidth(keys) - 1)} `) + theme.fg("dim", keys) + border(" ─╯")
								: border(`╰${"─".repeat(inner + 2)}╯`),
						);
						return out;
					},
					handleInput() {
						closePanel?.();
					},
					invalidate() {},
				};
			},
			{
				overlay: true,
				overlayOptions: () => {
					const cols = process.stdout.columns || 100;
					return { anchor: "center", width: Math.min(content + 4, cols - 2), maxHeight: "95%" };
				},
			},
		);
		closePanel = undefined;
	}
}

/** Who is looking right now, dimmed after the green `/remote`: one phone by name, several by count. */
function viewers(t: ExtensionContext["ui"]["theme"], clients: { count: number; names: string[] }): string {
	if (!clients.count) return "";
	const who = clients.names.length === 1 ? truncateToWidth(clients.names[0], 18, "…") : `${Math.max(clients.count, clients.names.length)} phones`;
	return t.fg("dim", ` · ${who}`);
}

function rank(a: AgentInfo): number {
	return a.status === "waiting" ? 0 : a.status === "working" ? 1 : 2;
}

