// Web Push without dependencies: RFC 8291 message encryption (aes128gcm) and RFC 8292 VAPID.
// Payloads are encrypted to the subscribing browser, so the push service never reads them.

import { createECDH, createHmac, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { b64u, unb64u } from "./crypto.ts";

export interface PushSubscriptionJSON {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface Vapid {
	/** Uncompressed P-256 public key, base64url (the browser's applicationServerKey). */
	publicKey: string;
	/** Private key as JWK `d`, base64url. */
	privateKey: string;
}

export function generateVapid(): Vapid {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pub = publicKey.export({ format: "jwk" });
	const priv = privateKey.export({ format: "jwk" });
	const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
	return { publicKey: b64u(raw), privateKey: priv.d! };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
	const prk = createHmac("sha256", salt).update(ikm).digest();
	return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** RFC 8291 aes128gcm body. `salt` and `asPrivate` are injectable for the RFC test vector. */
export function encryptPayload(
	plaintext: Buffer,
	sub: PushSubscriptionJSON,
	opts: { salt?: Buffer; asPrivate?: Buffer } = {},
): Buffer {
	const uaPublic = Buffer.from(unb64u(sub.keys.p256dh));
	const auth = Buffer.from(unb64u(sub.keys.auth));
	const salt = opts.salt ?? randomBytes(16);
	const ecdh = createECDH("prime256v1");
	if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = hkdf(auth, shared, keyInfo, 32);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(4096, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 VAPID JWT (ES256) for the push service's origin. */
export function vapidAuthorization(endpoint: string, vapid: Vapid, subject: string, now = Date.now()): string {
	const raw = Buffer.from(unb64u(vapid.publicKey));
	const key = createPrivateKey({
		format: "jwk",
		key: { kty: "EC", crv: "P-256", d: vapid.privateKey, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
	});
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
	const sig = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${unsigned}.${sig.toString("base64url")}, k=${vapid.publicKey}`;
}

/**
 * VAPID `sub` claim: a contact for the push service. Apple's (web.push.apple.com) rejects an
 * unreachable one such as `mailto:…@localhost` with 403 BadJwtToken, so every iPhone push failed.
 */
export const VAPID_SUBJECT = "https://github.com/jkeskikangas/pi-mobile";

export type PushResult = "sent" | "gone" | "failed";

export async function sendPush(sub: PushSubscriptionJSON, payload: unknown, vapid: Vapid, urgency: "normal" | "high" = "normal"): Promise<PushResult> {
	try {
		const res = await fetch(sub.endpoint, {
			method: "POST",
			headers: {
				Authorization: vapidAuthorization(sub.endpoint, vapid, VAPID_SUBJECT),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: urgency === "high" ? "600" : "3600",
				Urgency: urgency,
			},
			body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(payload)), sub)),
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 404 || res.status === 410) return "gone";
		return res.ok ? "sent" : "failed";
	} catch {
		return "failed";
	}
}
