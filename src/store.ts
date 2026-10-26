// Machine-wide state shared by every pi process: config, paired devices, and the local link secret.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { httpsUrl } from "../bin/https-url.mjs";
import { b64u, randomKey } from "./crypto.ts";
import type { ApnsConfig, ApnsToken } from "./apns.ts";
import type { RelayTarget } from "./relay.ts";
import { generateVapid, type PushSubscriptionJSON, type Vapid } from "./webpush.ts";

/** Every paired device has full control. (A view-only role existed until 0.1.3.) */
export type Role = "control";

export interface Config {
	/**
	 * Loopback port of the hub's HTTP server; phones reach it only through HTTPS in front (Tailscale
	 * Serve or `publicUrl`). Also the election lock: whichever pi binds it hosts the hub.
	 */
	port: number;
	/**
	 * This machine is connected to your phone: every pi session on it is shared (unless hidden with
	 * /remote off). Running pi processes watch this flag and join or leave within seconds.
	 */
	enabled: boolean;
	/**
	 * HTTPS address that proxies to the hub (Tailscale Serve, a reverse proxy). Listed first in the
	 * QR code. Lock-screen notifications need an HTTPS origin.
	 */
	publicUrl?: string;
	/**
	 * Without a `publicUrl`, put the hub behind Tailscale Serve (tailnet-only HTTPS) when Tailscale
	 * runs here: an existing serve for the port is reused, else one is added. Default on; false skips.
	 */
	tailscale?: boolean;
	/**
	 * Notifications through a push relay (the App Store app's path). Default on; false (or
	 * PI_MOBILE_RELAY=off) means this computer never sends to one, whatever a paired phone registers.
	 */
	relay?: boolean;
	/** HTTPS addresses of your other machines that aren't on Tailscale (`*.ts.net` is always allowed). */
	machineOrigins?: string[];
	/** iPhone push through Apple (APNs) with your own `.p8` key; set with /remote settings. */
	apns?: ApnsConfig;
}

export interface Device {
	id: string;
	name: string;
	key: string;
	role: Role;
	createdAt: number;
	lastSeenAt?: number;
}

export const DEFAULT_CONFIG: Config = { port: 7878, enabled: false };

export function stateDir(): string {
	const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const dir = join(base, "pi-mobile");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writePrivate(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function configPath(dir = stateDir()): string {
	return join(dir, "config.json");
}

export function loadConfig(dir = stateDir()): Config {
	const raw = readJson<Partial<Config>>(configPath(dir), {});
	const config: Config = { ...DEFAULT_CONFIG, ...raw };
	// HTTPS only: a plain-HTTP address would never be offered to a phone.
	if (config.publicUrl !== undefined) config.publicUrl = httpsUrl(config.publicUrl);
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
	return config;
}

export function saveConfig(config: Config, dir = stateDir()): void {
	writePrivate(configPath(dir), `${JSON.stringify(config, null, 2)}\n`);
}

/** Devices are re-read when the file changes, so a revoke in any process takes effect in the hub. */
export class DeviceStore {
	private cache: Device[] = [];
	private mtime = -1;
	private readonly path: string;
	/** The state directory this store lives in (the hub keeps its seen-request record beside it). */
	readonly dir: string;

	constructor(dir = stateDir()) {
		this.dir = dir;
		this.path = join(dir, "devices.json");
	}

	list(): Device[] {
		let m = 0;
		try {
			m = statSync(this.path).mtimeMs;
		} catch {
			m = 0;
		}
		if (m !== this.mtime) {
			this.mtime = m;
			// Devices paired with the removed view-only role are no longer recognised.
			this.cache = m ? readJson<Device[]>(this.path, []).filter((d) => d.role === "control") : [];
		}
		return this.cache;
	}

	get(id: string): Device | undefined {
		return this.list().find((d) => d.id === id);
	}

	private save(devices: Device[]): void {
		writePrivate(this.path, `${JSON.stringify(devices, null, 2)}\n`);
		this.cache = devices;
		this.mtime = statSync(this.path).mtimeMs;
	}

	add(device: Device): void {
		this.save([...this.list().filter((d) => d.id !== device.id), device]);
	}

	remove(ids: string[]): Device[] {
		const all = this.list();
		const removed = all.filter((d) => ids.includes(d.id));
		if (removed.length) this.save(all.filter((d) => !ids.includes(d.id)));
		return removed;
	}

	touch(id: string, now = Date.now()): void {
		const all = this.list();
		const d = all.find((x) => x.id === id);
		// Throttled: last-seen only needs minute resolution.
		if (!d || (d.lastSeenAt && now - d.lastSeenAt < 60_000)) return;
		this.save(all.map((x) => (x.id === id ? { ...x, lastSeenAt: now } : x)));
	}
}

/** Secret that authenticates pi processes to the hub over loopback; readable only by this user. */
export function linkSecret(dir = stateDir()): string {
	const path = join(dir, "link.secret");
	try {
		const s = readFileSync(path, "utf8").trim();
		if (s.length >= 32) return s;
	} catch {}
	try {
		writeFileSync(path, b64u(randomKey()), { mode: 0o600, flag: "wx" });
	} catch {}
	return readFileSync(path, "utf8").trim();
}

/** A name people recognise: macOS's Computer Name rather than a generated host name. */
export function machineName(): string {
	if (process.platform === "darwin") {
		try {
			const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
			if (name) return name;
		} catch {}
	}
	return hostname().replace(/\.local$/, "");
}

export interface MachineIdentity {
	id: string;
	name: string;
}
/** This machine's stable id (created once) and name (`machine.json`; bin/pi-mobile.mjs writes the same file). */
export function machineIdentity(dir = stateDir()): MachineIdentity {
	const path = join(dir, "machine.json");
	const m = readJson<{ id?: string; name?: string }>(path, {});
	if (!m.id) {
		m.id = b64u(randomKey()).slice(0, 12);
		writePrivate(path, `${JSON.stringify(m, null, 2)}\n`);
	}
	return { id: m.id, name: m.name || machineName() };
}

/**
 * "Add this machine" or "remove that one", waiting for one phone. `pi-mobile add`/`remove` write them
 * (one file each, so nothing races), the hub delivers them and deletes them once the phone has acted.
 */
export interface Offer {
	id: string;
	/** The phone's device id on this machine. */
	device: string;
	kind: "add" | "remove";
	machine: MachineIdentity;
	origin?: string;
	d?: string;
	k?: string;
	/** Name of the machine that made the offer. */
	from: string;
	createdAt: number;
}
const OFFER_TTL = 7 * 24 * 3600_000;
export class OfferStore {
	private readonly dir: string;
	constructor(dir = stateDir()) {
		this.dir = join(dir, "offers");
	}
	list(now = Date.now()): Offer[] {
		let files: string[] = [];
		try {
			files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		const out: Offer[] = [];
		for (const f of files) {
			const o = readJson<Offer | null>(join(this.dir, f), null);
			if (o && now - o.createdAt < OFFER_TTL) out.push(o);
			else this.remove(f.replace(/\.json$/, ""));
		}
		return out.sort((a, b) => a.createdAt - b.createdAt);
	}
	forDevice(device: string): Offer[] {
		return this.list().filter((o) => o.device === device);
	}
	remove(id: string): void {
		if (!/^[\w-]+$/.test(id)) return;
		try {
			unlinkSync(join(this.dir, `${id}.json`));
		} catch {}
	}
}

/** VAPID keys and each device's push subscription. Only the hub writes it. */
export class PushStore {
	private readonly path: string;
	private state: { vapid: Vapid; subs: Record<string, PushSubscriptionJSON>; apns?: Record<string, ApnsToken>; relay?: Record<string, RelayTarget> };

	constructor(dir = stateDir()) {
		this.path = join(dir, "push.json");
		const raw = readJson<{ vapid?: Vapid; subs?: Record<string, PushSubscriptionJSON>; apns?: Record<string, ApnsToken>; relay?: Record<string, RelayTarget> }>(this.path, {});
		this.state = { vapid: raw.vapid ?? generateVapid(), subs: raw.subs ?? {}, apns: raw.apns ?? {}, relay: raw.relay ?? {} };
		if (!raw.vapid) this.save();
	}

	get vapid(): Vapid {
		return this.state.vapid;
	}

	entries(): [string, PushSubscriptionJSON][] {
		return Object.entries(this.state.subs);
	}

	/** A phone moved every machine to a new key (after removing one); its subscription comes with it. */
	setVapid(vapid: Vapid): void {
		this.state.vapid = vapid;
		this.save();
	}

	set(deviceId: string, sub: PushSubscriptionJSON | undefined): void {
		if (sub) this.state.subs[deviceId] = sub;
		else delete this.state.subs[deviceId];
		this.save();
	}

	/** iPhone app device tokens (APNs), beside the Web Push subscriptions. */
	apnsEntries(): [string, ApnsToken][] {
		return Object.entries(this.state.apns ?? {});
	}

	setApns(deviceId: string, token: ApnsToken | undefined): void {
		const all = (this.state.apns ??= {});
		if (token) all[deviceId] = token;
		else delete all[deviceId];
		this.save();
	}

	/** App Store app: a push relay URL and its capability for this device (the token stays with the relay). */
	relayEntries(): [string, RelayTarget][] {
		return Object.entries(this.state.relay ?? {});
	}

	setRelay(deviceId: string, target: RelayTarget | undefined): void {
		const all = (this.state.relay ??= {});
		if (target) all[deviceId] = target;
		else delete all[deviceId];
		this.save();
	}

	private save(): void {
		writePrivate(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
	}
}
