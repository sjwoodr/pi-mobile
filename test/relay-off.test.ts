import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { RelayClient } from "../src/relay.ts";
import { type Config, DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "pi-relay-off-"));
	dirs.push(d);
	return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CAP = "c".repeat(60);
const URL_ = "https://relay.example.dev";

/** A hub with one paired phone and one linked session; `calls` counts what reached the relay. */
async function setup(config: Partial<Config>) {
	const port = await freePort();
	const dir = tmp();
	const push = new PushStore(dir);
	const calls: string[] = [];
	const f = (async (url: string) => {
		calls.push(String(url));
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	const hub = new Hub({ config: { port, enabled: false, ...config }, secret: "s".repeat(43), devices: new DeviceStore(dir), push, relay: new RelayClient(f) });
	await hub.listen();
	const link = new HubLink({
		config: () => ({ port, enabled: false }),
		secret: "s".repeat(43),
		info: () => ({ agent: "A", pid: 1, sessionId: "sess", name: "session A", cwd: "/tmp", status: "idle" }),
		onRequest: () => null,
	});
	link.start();
	await until(() => link.linked);
	const phone = new Phone();
	await phone.pair(hub.createPairing().links[0].url, "iphone");
	const close = () => {
		link.stop();
		hub.close();
	};
	return { hub, link, phone, push, calls, close };
}

test("relay on (default): a registered cap gets the attention", async () => {
	const { link, phone, calls, close } = await setup({});
	try {
		assert.equal((await phone.rpc("hub")).relay, true);
		assert.equal((await phone.rpc("push", { relay: { url: URL_, cap: CAP } })).relayOn, true);
		link.send({ t: "attention", title: "proj asks", body: "Allow rm?" });
		await until(() => calls.length === 1);
	} finally {
		close();
	}
});

test('"relay": false: registration refused, and a cap stored before is never sent to', async () => {
	const { link, phone, push, calls, close } = await setup({ relay: false });
	try {
		const h = await phone.rpc("hub");
		assert.equal(h.relay, false);
		assert.equal(h.relayOn, false);
		await assert.rejects(phone.rpc("push", { relay: { url: URL_, cap: CAP } }), /push relay is turned off/);
		assert.equal(push.relayEntries().length, 0);
		push.setRelay(phone.d, { url: URL_, cap: CAP }); // registered while the relay was still on
		assert.equal((await phone.rpc("hub")).relayOn, false);
		link.send({ t: "attention", title: "proj asks", body: "Allow rm?" });
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(calls.length, 0, "nothing reaches the relay");
		assert.deepEqual(await phone.rpc("push", { relay: null }), { ok: true, apns: false, relay: false, relayOn: false });
	} finally {
		close();
	}
});

test("PI_MOBILE_RELAY=off turns it off too", async () => {
	process.env.PI_MOBILE_RELAY = "off";
	const { phone, close } = await setup({});
	try {
		assert.equal((await phone.rpc("hub")).relay, false);
		await assert.rejects(phone.rpc("push", { relay: { url: URL_, cap: CAP } }), /push relay is turned off/);
	} finally {
		delete process.env.PI_MOBILE_RELAY;
		close();
	}
});
