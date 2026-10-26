// The hub: one HTTP server per machine that every sharing pi process links to over loopback.
// Phones talk only to the hub, through an end-to-end encrypted API; the hub routes requests
// to the right pi process and fans its events out with a replay buffer for flaky connections.
//
// Election: whichever process binds the configured port hosts the hub. When it exits, the other
// processes' links drop, and one of them binds the port and takes over (see bridge.ts).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Channel } from "./channel.ts";
import { b64u, open, randomId, randomKey, ReplayGuard, seal, unb64u } from "./crypto.ts";
import { type Endpoint, LOOPBACK_LABEL, type ServeResult } from "./expose.ts";
import { type AgentEvent, type AgentInfo, type HubEvent, PROTOCOL } from "./protocol.ts";
import { type Config, type Device, DeviceStore, type MachineIdentity, machineIdentity, type Offer, OfferStore, PushStore, type Role } from "./store.ts";
import { type PushSubscriptionJSON, sendPush, type Vapid } from "./webpush.ts";
import { ApnsClient, apnsConfigured, isApnsToken } from "./apns.ts";
import { isRelayTarget, RelayClient, relayUrl } from "./relay.ts";
import { actionKey } from "./once.ts";

export const LINK_PROTOCOL = "pi-mobile-link";
const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const NACL_JS = createRequire(import.meta.url).resolve("tweetnacl/nacl-fast.min.js");

/** URL path (`/app.js`) → file contents. */
export type WebSnapshot = ReadonlyMap<string, Buffer>;

/**
 * Everything the hub serves, read into memory once. `pi update` overwrites the package's files while
 * an older pi keeps running the old hub code; serving from disk would hand phones an app that doesn't
 * match that hub (issue #2; pi-actors design D12). A restarted hub loads the new code and a new snapshot.
 */
export function snapshotWeb(dir = WEB_DIR, extra: Record<string, string> = { "/nacl.js": NACL_JS }): WebSnapshot {
	const files = new Map<string, Buffer>();
	const walk = (d: string, prefix: string) => {
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
			else files.set(`${prefix}${name}`, readFileSync(full));
		}
	};
	walk(dir, "/");
	for (const [path, file] of Object.entries(extra)) files.set(path, readFileSync(file));
	return files;
}

/** Taken when this module loads: the app that matches the hub code in this process. */
let moduleSnapshot: WebSnapshot | undefined;
try {
	moduleSnapshot = snapshotWeb();
} catch {}
// Shared by all sessions; at ten busy agents this still covers a few minutes of reconnect gap.
const RING = 20_000;
/** No lock-screen pushes while someone typed into a pi terminal on this machine this recently. */
const PRESENCE_MS = 2 * 60_000;
/** Events every phone gets about every session; the rest only for the session it is looking at. */
const GLOBAL_EVENTS = new Set(["info", "gone", "prompt", "prompt_end"]);
/**
 * The largest request: a 20 MB recording (pi-speech's limit for `transcribe` and a draft's last piece)
 * goes as base64 in the JSON (4/3), sealed and base64url'd again (4/3), about 35.6 MB, plus room.
 */
export const MAX_BODY = 40 * 1024 * 1024;
const PAIRING_TTL = 10 * 60_000;
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

interface AgentConn {
	ch: Channel;
	info: AgentInfo;
}

interface StreamClient {
	id: string;
	/** The session this phone is looking at; its detailed events are sent only for that one. */
	focus?: string;
	device: Device;
	/** Offers already sent on this stream. */
	offered: Set<string>;
	res: ServerResponse;
	queue: unknown[];
	flush?: NodeJS.Timeout;
}

interface Pairing {
	id: string;
	key: Uint8Array;
	role: Role;
	expiresAt: number;
}

export interface HubOptions {
	config: Config;
	secret: string;
	devices?: DeviceStore;
	push?: PushStore;
	/** Replaceable in tests; defaults to the real Web Push sender. */
	sendPush?: typeof sendPush;
	/** Replaceable in tests; defaults to a client built from `config.apns`. */
	apns?: ApnsClient;
	/** Replaceable in tests; defaults to a relay client over global fetch. */
	relay?: RelayClient;
	/** The files served to phones; defaults to the snapshot taken when this code loaded. */
	web?: WebSnapshot;
	offers?: OfferStore;
	/** This machine (default: `machine.json`). */
	machine?: MachineIdentity;
	/** Called when a linked pi asks the hub to restart, e.g. after a port or exposure change. */
	onRestart?: () => void;
	/** Called once the hub has been without linked agents for `idleMs`. */
	onIdle?: () => void;
	idleMs?: number;
	/** Finds or sets up an HTTPS address in front of the hub (Tailscale Serve); off when absent. */
	serve?: (port: number) => Promise<ServeResult>;
}

export class Hub {
	readonly id = randomId();
	readonly config: Config;
	/**
	 * The only listener, on loopback: also the election lock. Phones arrive through Tailscale Serve
	 * (or your own HTTPS proxy), which forwards to it; there is no plain-HTTP listener on the network.
	 */
	private server: Server;
	private readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
	private agents = new Map<string, AgentConn>();
	private clients = new Set<StreamClient>();
	private ring: HubEvent[] = [];
	private seq = 0;
	private pairings = new Map<string, Pairing>();
	private replay: ReplayGuard;
	private devices: DeviceStore;
	private push: PushStore;
	private offers: OfferStore;
	/** Offers already announced by a lock-screen notification in this process. */
	private notified = new Set<string>();
	private offerTimer?: NodeJS.Timeout;
	private me?: MachineIdentity;
	private secret: Buffer;
	/** HTTPS address from Tailscale Serve, used when no `publicUrl` is configured. */
	private served?: string;
	/** One-click link that enables Serve on the tailnet, while pi waits for it. */
	private serveEnable?: string;
	private serveRun?: Promise<void>;
	private serveAt = 0;
	private heartbeat?: NodeJS.Timeout;
	private idleTimer?: NodeJS.Timeout;
	private closed = false;
	private lastPresence = 0;
	private readonly opts: HubOptions;

	constructor(opts: HubOptions) {
		this.opts = opts;
		this.config = opts.config;
		this.secret = Buffer.from(opts.secret);
		this.devices = opts.devices ?? new DeviceStore();
		// Seen requests are on disk, so a captured request can't be replayed to the next hub (another pi process).
		this.replay = new ReplayGuard(undefined, join(this.devices.dir, "seen.json"));
		this.push = opts.push ?? new PushStore();
		this.offers = opts.offers ?? new OfferStore();
		this.handler = (req, res) => {
			this.handle(req, res).catch((e) => {
				if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
				else res.destroy();
			});
		};
		this.server = createServer(this.handler);
		this.server.on("upgrade", (req, socket) => this.upgrade(req, socket));
	}

	/** Binds the port; rejects with EADDRINUSE when another process already hosts the hub. */
	async listen(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (e: Error) => reject(e);
			this.server.once("error", onError);
			this.server.listen(this.config.port, "127.0.0.1", () => {
				this.server.off("error", onError);
				resolve();
			});
		});
		this.server.unref();
		this.heartbeat = setInterval(() => this.ping(), 15_000);
		this.heartbeat.unref();
		// `pi-mobile add` and `remove` run outside the hub; pick their offers up within seconds.
		this.offerTimer = setInterval(() => this.deliverOffers(), 3000);
		this.offerTimer.unref();
		this.armIdle();
		void this.syncServe();
	}

	/**
	 * Looks up (or sets up) the Tailscale Serve address. Runs at start and before pairing or status,
	 * at most every 15 s; while the tailnet still has to enable Serve, it waits on that instead.
	 */
	syncServe(): Promise<void> {
		const serve = this.opts.serve;
		if (!serve || this.config.publicUrl || this.closed) return Promise.resolve();
		if (this.serveRun) return this.serveRun;
		if (this.serveEnable || Date.now() - this.serveAt < 15_000) return Promise.resolve();
		this.serveRun = serve(this.port)
			.then(
				(r) => {
					this.serveEnable = r.enable;
					this.setServed(r.url);
					r.pending?.then((url) => {
						this.serveEnable = undefined;
						this.serveAt = 0;
						if (url) this.setServed(url);
					});
				},
				() => {},
			)
			.finally(() => {
				this.serveRun = undefined;
				this.serveAt = Date.now();
			});
		return this.serveRun;
	}

	private setServed(url: string | undefined): void {
		if (url === this.served || this.closed) return;
		this.served = url;
		this.broadcastToAgents({ t: "endpoints", endpoints: this.endpoints() });
	}

	get machine(): MachineIdentity {
		return (this.me ??= this.opts.machine ?? machineIdentity());
	}

	get port(): number {
		const a = this.server.address();
		return typeof a === "object" && a ? a.port : this.config.port;
	}

	/** HTTPS first (configured address, else Tailscale Serve), then loopback for this computer only. */
	endpoints(): Endpoint[] {
		const local = { label: LOOPBACK_LABEL, url: `http://127.0.0.1:${this.port}` };
		const pub = this.config.publicUrl
			? [{ label: "https", url: this.config.publicUrl.replace(/\/+$/, "") }]
			: this.served
				? [{ label: "tailscale https", url: this.served }]
				: [];
		return [...pub, local];
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.heartbeat);
		clearInterval(this.offerTimer);
		clearTimeout(this.idleTimer);
		this.apns?.close();
		for (const c of this.clients) c.res.end();
		this.clients.clear();
		for (const a of this.agents.values()) a.ch.close();
		this.agents.clear();
		this.server.close();
		this.server.closeAllConnections?.();
	}

	// ── agent links ────────────────────────────────────────────────────────────────

	private upgrade(req: IncomingMessage, socket: Duplex): void {
		const given = Buffer.from(String(req.headers["x-pi-mobile-secret"] ?? ""));
		const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
		const ok =
			req.headers.upgrade === LINK_PROTOCOL &&
			loopback &&
			given.length === this.secret.length &&
			timingSafeEqual(given, this.secret);
		if (!ok) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${LINK_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
		const ch = new Channel(socket);
		let agentId: string | undefined;
		ch.onMessage = (msg) => {
			if (msg.t === "hello") {
				if (msg.protocol !== PROTOCOL) {
					ch.send({ t: "rejected", reason: `protocol ${msg.protocol} ≠ hub protocol ${PROTOCOL}; update pi-mobile everywhere` });
					ch.close();
					return;
				}
				agentId = msg.info.agent as string;
				const prev = this.agents.get(agentId);
				if (prev && prev.ch !== ch) prev.ch.close();
				this.agents.set(agentId, { ch, info: msg.info });
				clearTimeout(this.idleTimer);
				ch.send({ t: "welcome", hubId: this.id, pid: process.pid, endpoints: this.endpoints(), clients: this.clientSummary() });
				this.publish(agentId, { type: "info", info: msg.info });
			} else if (msg.t === "presence") {
				this.lastPresence = Date.now();
			} else if (msg.t === "attention" && agentId) {
				void this.attention(agentId, msg);
			} else if (msg.t === "ev" && agentId) {
				const ev = msg.ev as AgentEvent;
				const conn = this.agents.get(agentId);
				if (conn && ev.type === "info") conn.info = ev.info;
				this.publish(agentId, ev);
			}
		};
		ch.onRequest = (m, p) => this.agentRequest(m, p);
		ch.onClose = () => {
			if (!agentId || this.agents.get(agentId)?.ch !== ch) return;
			this.agents.delete(agentId);
			this.publish(agentId, { type: "gone" });
			this.armIdle();
		};
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.agents.size || !this.opts.onIdle) return;
		this.idleTimer = setTimeout(() => {
			if (!this.agents.size && !this.closed) this.opts.onIdle?.();
		}, this.opts.idleMs ?? 15_000);
		this.idleTimer.unref();
	}

	private agentRequest(m: string, p: any): unknown {
		switch (m) {
			case "pair":
				return this.syncServe().then(() => ({ ...this.createPairing(), serveEnable: this.serveEnable }));
			case "status":
				return this.syncServe().then(() => ({
					hubId: this.id,
					pid: process.pid,
					endpoints: this.endpoints(),
					serveEnable: this.serveEnable,
					agents: [...this.agents.values()].map((a) => a.info),
					clients: this.clientSummary(),
					devices: this.devices.list().map(publicDevice),
				}));
			case "restart":
				setTimeout(() => this.opts.onRestart?.(), 50);
				return { ok: true };
			case "revoke": {
				const ids: string[] = Array.isArray(p?.ids) ? p.ids : [];
				const removed = this.devices.remove(ids);
				for (const id of ids) this.push.set(id, undefined), this.push.setApns(id, undefined), this.push.setRelay(id, undefined);
				this.dropStreams(ids);
				return removed.map(publicDevice);
			}
			default:
				throw new Error(`unknown hub request ${m}`);
		}
	}

	private broadcastToAgents(msg: unknown): void {
		for (const a of this.agents.values()) a.ch.send(msg);
	}

	createPairing(role: Role = "control"): { links: Endpoint[]; expiresAt: number; role: Role } {
		const now = Date.now();
		for (const [id, p] of this.pairings) if (p.expiresAt < now) this.pairings.delete(id);
		const pairing: Pairing = { id: randomId(), key: randomKey(), role, expiresAt: now + PAIRING_TTL };
		this.pairings.set(pairing.id, pairing);
		const fragment = `#p=${pairing.id}.${b64u(pairing.key)}`;
		return { links: this.endpoints().map((e) => ({ label: e.label, url: `${e.url}/${fragment}` })), expiresAt: pairing.expiresAt, role };
	}

	/**
	 * Lock-screen notification to every subscribed device. The payload is encrypted to each browser
	 * (RFC 8291), so the push service sees neither the session name nor the text.
	 */
	private async attention(agent: string, msg: { title?: string; body?: string; urgent?: boolean }): Promise<void> {
		if (Date.now() - this.lastPresence < PRESENCE_MS) return; // you are at a terminal here
		const payload = { title: String(msg.title ?? "pi"), body: String(msg.body ?? ""), agent, machine: this.machine.id };
		await Promise.all<unknown>([
			...this.push.entries().map(async ([id, sub]) => {
				if (!this.devices.get(id)) return this.push.set(id, undefined);
				const send = this.opts.sendPush ?? sendPush;
				if ((await send(sub, payload, this.push.vapid, msg.urgent ? "high" : "normal")) === "gone") this.push.set(id, undefined);
			}),
			// iPhone app: Apple sees a generic alert; the text is sealed to the device key (each machine sends its own).
			...this.push.apnsEntries().map(async ([id, token]) => {
				const device = this.devices.get(id);
				if (!device) return this.push.setApns(id, undefined);
				const apns = this.apnsClient();
				if (!apns) return;
				const sealed = seal(unb64u(device.key), payload);
				if ((await apns.send(token, { sealed, urgent: msg.urgent })) === "gone") this.push.setApns(id, undefined);
			}),
			// App Store app: the same sealed payload through the push relay; 410 means the cap is dead.
			...(this.relayOff() ? [] : this.push.relayEntries()).map(async ([id, target]) => {
				const device = this.devices.get(id);
				if (!device) return this.push.setRelay(id, undefined);
				const sealed = seal(unb64u(device.key), payload);
				if ((await this.relayClient.send(target, { sealed, urgent: msg.urgent })) === "gone") this.push.setRelay(id, undefined);
			}),
		]);
	}

	/** The computer's owner turned the push relay off (`"relay": false` or PI_MOBILE_RELAY=off). */
	private relayOff(): boolean {
		return this.config.relay === false || process.env.PI_MOBILE_RELAY === "off";
	}

	private relayClientInstance?: RelayClient;
	private get relayClient(): RelayClient {
		return this.opts.relay ?? (this.relayClientInstance ??= new RelayClient());
	}

	private apns?: ApnsClient;
	private apnsClient(): ApnsClient | undefined {
		if (this.opts.apns) return this.opts.apns;
		if (!apnsConfigured(this.config.apns)) return undefined;
		return (this.apns ??= new ApnsClient(this.config.apns));
	}

	// ── machines offered to phones ─────────────────────────────────────────────────

	/** Sends each phone its pending offers: on its open streams, and once as a notification. */
	private deliverOffers(): void {
		for (const o of this.offers.list()) {
			for (const c of this.clients) if (c.device.id === o.device && !c.offered.has(o.id)) this.offerTo(c, o);
			if (this.notified.has(o.id)) continue;
			this.notified.add(o.id);
			const sub = this.push.entries().find(([id]) => id === o.device)?.[1];
			if (!sub || !this.devices.get(o.device)) continue;
			// What the phone needs to decide from the lock screen: which computer, where, and who asked.
			const where = o.origin ? ` (${hostOf(o.origin)})` : "";
			const body = o.kind === "add" ? `Add ${o.machine.name}${where} to your sessions? Asked on ${o.from}.` : `${o.machine.name} was removed`;
			const payload = { title: "pi", body, machine: this.machine.id, offer: o.id, kind: o.kind };
			void (this.opts.sendPush ?? sendPush)(sub, payload, this.push.vapid).catch(() => {});
		}
	}

	private offerTo(c: StreamClient, o: Offer): void {
		c.offered.add(o.id);
		const { device: _device, ...offer } = o;
		this.enqueue(c, { type: o.kind === "add" ? "machine_offer" : "machine_removed", offer });
	}

	// ── events ─────────────────────────────────────────────────────────────────────

	private publish(agent: string, ev: AgentEvent): void {
		const stamped = { ...ev, agent, seq: ++this.seq } as HubEvent;
		this.ring.push(stamped);
		if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
		for (const c of this.clients) if (wants(c, stamped)) this.enqueue(c, stamped);
	}

	private enqueue(c: StreamClient, ev: unknown): void {
		c.queue.push(ev);
		// Batch to keep per-message crypto and SSE framing overhead low during token streaming.
		c.flush ??= setTimeout(() => this.flush(c), 40);
	}

	private flush(c: StreamClient): void {
		c.flush = undefined;
		if (!c.queue.length) return;
		const batch = c.queue;
		c.queue = [];
		c.res.write(`data: ${seal(unb64u(c.device.key), batch)}\n\n`);
	}

	private ping(): void {
		for (const c of this.clients) c.res.write(": ping\n\n");
	}

	private clientSummary(): { count: number; names: string[] } {
		const names = [...new Set([...this.clients].map((c) => c.device.name))];
		return { count: this.clients.size, names };
	}

	private clientsChanged(): void {
		this.broadcastToAgents({ t: "clients", clients: this.clientSummary() });
	}

	private dropStreams(deviceIds: string[]): void {
		for (const c of [...this.clients]) {
			if (deviceIds.includes(c.device.id)) {
				c.res.end();
				this.clients.delete(c);
			}
		}
		this.clientsChanged();
	}

	// ── HTTP ───────────────────────────────────────────────────────────────────────

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://hub");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		if (url.pathname.startsWith("/api/")) {
			// The phone's app may be served by another of your machines. Bodies are sealed and nothing
			// rides on cookies, so any origin may call; the device key is the only credential.
			res.setHeader("access-control-allow-origin", "*");
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"access-control-allow-methods": "GET, POST",
					"access-control-allow-headers": "content-type",
					"access-control-max-age": "600",
					...(req.headers["access-control-request-private-network"] ? { "access-control-allow-private-network": "true" } : {}),
				});
				return void res.end();
			}
		}
		if (url.pathname === "/api/pair" && req.method === "POST") return this.pair(req, res);
		if (url.pathname === "/api/rpc" && req.method === "POST") return this.rpc(req, res);
		if (url.pathname === "/api/stream" && req.method === "GET") return this.stream(url, req, res);
		if (req.method === "GET" || req.method === "HEAD") return this.serveStatic(url.pathname, res);
		send(res, 404, { error: "not found" });
	}

	private serveStatic(path: string, res: ServerResponse): void {
		const file = path === "/" ? "/index.html" : normalize(path).replace(/\\/g, "/");
		const body = (this.opts.web ?? moduleSnapshot)?.get(file);
		if (!body) return send(res, 404, { error: "not found" });
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": "no-cache",
			"content-security-policy":
				// media-src blob: lets voice mode keep a silent media session (headset button) alive.
				`default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src ${this.connectSources()}; frame-ancestors 'none'`,
		});
		res.end(body);
	}

	/** The app talks to this machine and to your other machines (Tailscale HTTPS, or HTTPS addresses you set). */
	private connectSources(): string {
		const extra = [this.config.publicUrl, ...(this.config.machineOrigins ?? [])].flatMap((u) => {
			try {
				return u ? [new URL(u).origin] : [];
			} catch {
				return [];
			}
		});
		return ["'self'", "https://*.ts.net:*", ...new Set(extra)].join(" ");
	}

	private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const pairing = this.pairings.get(String(body?.p ?? ""));
		if (!pairing || pairing.expiresAt < Date.now()) return send(res, 410, { error: "pairing code expired or already used; run /remote again" });
		const hello = open<{ t: number; name?: string }>(pairing.key, String(body?.b ?? ""));
		if (!hello || !this.replay.accept(hello.nonce, hello.value.t)) return send(res, 401, { error: "bad pairing" });
		this.pairings.delete(pairing.id);
		const key = randomKey();
		const device: Device = {
			id: randomId(),
			name: String(hello.value.name || "phone").slice(0, 60),
			key: b64u(key),
			role: pairing.role,
			createdAt: Date.now(),
		};
		this.devices.add(device);
		this.broadcastToAgents({ t: "paired", device: publicDevice(device) });
		send(res, 200, { b: seal(pairing.key, { d: device.id, k: device.key, role: device.role, host: this.machine.name, machine: this.machine }) });
	}

	private authenticate(d: unknown, b: unknown): { device: Device; value: any } | undefined {
		const device = this.devices.get(String(d ?? ""));
		if (!device) return undefined;
		const opened = open<any>(unb64u(device.key), String(b ?? ""));
		if (!opened || !this.replay.accept(opened.nonce, opened.value?.t)) return undefined;
		this.devices.touch(device.id);
		return { device, value: opened.value };
	}

	private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const auth = this.authenticate(body?.d, body?.b);
		if (!auth) return send(res, 401, { error: "unauthorized" });
		const key = unb64u(auth.device.key);
		try {
			const result = await this.deviceCall(auth.device, String(auth.value.m), auth.value.p ?? {});
			send(res, 200, { b: seal(key, { r: result ?? null }) });
		} catch (e: any) {
			send(res, 200, { b: seal(key, { e: String(e?.message ?? e) }) });
		}
	}

	private async deviceCall(device: Device, m: string, p: any): Promise<unknown> {
		switch (m) {
			case "hub":
				return {
					hubId: this.id,
					host: this.machine.name,
					machine: this.machine,
					protocol: PROTOCOL,
					// What this hub can do, so a native app can refuse an incompatible hub with a clear message.
					features: ["voice", "voiceSession", "speak", "voices", "learn", "machines"],
					seq: this.seq,
					agents: [...this.agents.values()].map((a) => a.info),
					device: publicDevice(device),
					pushKey: this.push.vapid.publicKey,
					pushOn: this.push.entries().some(([id]) => id === device.id),
					// iPhone push needs this machine's APNs key (/remote settings); `apnsOn`: this device's token is stored.
					apns: !!this.apnsClient(),
					apnsOn: this.push.apnsEntries().some(([id]) => id === device.id),
					// App Store app: this hub forwards to a push relay; `relayOn`: this device's relay cap is stored.
					relay: !this.relayOff(),
					relayOn: !this.relayOff() && this.push.relayEntries().some(([id]) => id === device.id),
				};
			case "focus": {
				for (const c of this.clients) if (c.id === p.client && c.device.id === device.id) c.focus = String(p.agent ?? "") || undefined;
				return { ok: true };
			}
			case "push": {
				// iPhone app: `{ apns: { token, sandbox } }` (own-team builds) and/or `{ relay: { url, cap } }`
				// (App Store app); null turns either off. Stored beside Web Push.
				if ("relay" in p && p.relay !== null && this.relayOff()) throw new Error("push relay is turned off on this computer");
				if ("relay" in p && p.relay !== null && !isRelayTarget(p.relay)) throw new Error("invalid push relay");
				if ("apns" in p) {
					if (p.apns !== null && !isApnsToken(p.apns)) throw new Error("invalid APNs token");
					this.push.setApns(device.id, p.apns ? { token: p.apns.token, ...(p.apns.sandbox === undefined ? {} : { sandbox: p.apns.sandbox }) } : undefined);
				}
				if ("relay" in p) this.push.setRelay(device.id, p.relay ? { url: relayUrl(p.relay.url)!, cap: p.relay.cap } : undefined);
				if (("apns" in p || "relay" in p) && !("subscription" in p))
					return { ok: true, apns: !!this.apnsClient(), relay: !this.relayOff(), relayOn: !this.relayOff() && this.push.relayEntries().some(([id]) => id === device.id) };
				const sub = p.subscription as PushSubscriptionJSON | null;
				if (sub && !(typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") && sub.keys?.p256dh && sub.keys?.auth))
					throw new Error("invalid push subscription");
				// The phone moved all its machines to a new signing key (after removing one).
				const v = p.vapid as Vapid | undefined;
				if (v) {
					if (!(typeof v.publicKey === "string" && v.publicKey.length > 80 && typeof v.privateKey === "string" && v.privateKey.length > 30))
						throw new Error("invalid push key");
					this.push.setVapid({ publicKey: v.publicKey, privateKey: v.privateKey });
				}
				this.push.set(device.id, sub ?? undefined);
				return { ok: true, pushKey: this.push.vapid.publicKey };
			}
			case "vapid":
				// The key every machine signs notifications with; the phone hands it to a machine that has another.
				return this.push.vapid;
			case "offerDone": {
				const o = this.offers.forDevice(device.id).find((x) => x.id === String(p.id));
				if (o) this.offers.remove(o.id);
				return { ok: !!o };
			}
			case "devices":
				return this.devices.list().map(publicDevice);
			case "revoke": {
				const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : [];
				const removed = this.devices.remove(ids);
				for (const id of ids) this.push.set(id, undefined), this.push.setApns(id, undefined), this.push.setRelay(id, undefined);
				setImmediate(() => this.dropStreams(ids));
				return removed.map(publicDevice);
			}
			case "pair":
				await this.syncServe();
				return { ...this.createPairing(), serveEnable: this.serveEnable };
			case "agent": {
				const conn = this.agents.get(String(p.agent));
				if (!conn) throw new Error("that pi session is no longer connected");
				const method = String(p.m);
				// `k`: the phone's idempotency key for an action; the session runs each key once (issue #1).
				const k = actionKey(p.k);
				return conn.ch.request(method, { ...(p.p ?? {}), _device: { id: device.id, name: device.name }, _k: k }, 10 * 60_000);
			}
			default:
				throw new Error(`unknown method ${m}`);
		}
	}

	private stream(url: URL, req: IncomingMessage, res: ServerResponse): void {
		const auth = this.authenticate(url.searchParams.get("d"), url.searchParams.get("b"));
		if (!auth) return send(res, 401, { error: "unauthorized" });
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
			connection: "keep-alive",
		});
		res.flushHeaders();
		req.socket.setNoDelay(true);
		const { hub, since, focus } = auth.value as { hub?: string; since?: number; focus?: string };
		const client: StreamClient = { id: randomId(), focus, device: auth.device, res, queue: [], offered: new Set() };
		const first = this.ring[0]?.seq ?? this.seq + 1;
		const canReplay = hub === this.id && typeof since === "number" && since >= first - 1 && since <= this.seq;
		client.queue.push({ type: "hello", hubId: this.id, seq: this.seq, resync: !canReplay, client: client.id });
		if (canReplay) for (const ev of this.ring) if (ev.seq > since && wants(client, ev)) client.queue.push(ev);
		for (const o of this.offers.forDevice(auth.device.id)) this.offerTo(client, o);
		this.flush(client);
		this.clients.add(client);
		this.clientsChanged();
		const done = () => {
			if (!this.clients.delete(client)) return;
			clearTimeout(client.flush);
			this.clientsChanged();
		};
		req.on("close", done);
		res.on("close", done);
	}
}


function wants(c: StreamClient, ev: HubEvent): boolean {
	return GLOBAL_EVENTS.has(ev.type) || ev.agent === c.focus;
}

function publicDevice(d: Device): Omit<Device, "key"> {
	const { key: _key, ...rest } = d;
	return rest;
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new Error("request too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
