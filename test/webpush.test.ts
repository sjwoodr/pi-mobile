import assert from "node:assert/strict";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { test } from "node:test";
import { encryptPayload, generateVapid, sendPush, VAPID_SUBJECT, vapidAuthorization } from "../src/webpush.ts";

const u = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

test("aes128gcm encryption matches the RFC 8291 example", () => {
	const body = encryptPayload(
		u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
		{ endpoint: "https://push.example.net", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } },
		{ salt: u("DGv6ra1nlYgDCS1FRnbzlw"), asPrivate: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
	);
	const header = u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8");
	const cipher = u("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ");
	assert.equal(body.toString("base64url"), Buffer.concat([header, cipher]).toString("base64url"));
});

test("VAPID authorization is a valid ES256 JWT for the endpoint's origin", () => {
	const vapid = generateVapid();
	const auth = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, "mailto:x@y", 1_000_000_000_000);
	const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
	assert.ok(m);
	assert.equal(m[4], vapid.publicKey);
	const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
	assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 43200, sub: "mailto:x@y" });
	const raw = u(vapid.publicKey);
	const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") } });
	assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, u(m[3])));
});

test("sendPush signs with a subject Apple accepts (not @localhost, which gets 403 BadJwtToken)", async () => {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const sub = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
	const real = globalThis.fetch;
	let auth = "";
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		auth = (init.headers as Record<string, string>).Authorization;
		return new Response(null, { status: 201 });
	}) as typeof fetch;
	try {
		assert.equal(await sendPush(sub, { title: "pi" }, generateVapid()), "sent");
	} finally {
		globalThis.fetch = real;
	}
	const claims = JSON.parse(Buffer.from(/^vapid t=[^.]+\.([^.]+)\./.exec(auth)![1], "base64url").toString());
	assert.equal(claims.sub, VAPID_SUBJECT);
	assert.match(claims.sub, /^(https:\/\/|mailto:)/);
	assert.doesNotMatch(claims.sub, /localhost/);
});
