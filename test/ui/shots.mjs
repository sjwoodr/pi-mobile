// Screenshots of every phone UI state, each scanned with axe (WCAG 2.2 AA), against the scripted hub
// in fixture.ts. This is the visual check for any change in web/ (docs/ui.md → Checks).
//
//   npm run shots                        light + dark at 390 and 320 px, into shots/
//   npm run shots -- --out /tmp/s --width 390 --theme dark --only voice
//   npm run shots -- --forced            forced colours (Windows high contrast)
//   npm run shots -- --reduced           reduced motion
//
// Flows: app (pairing, sessions, transcript, tools, questions, sheets, focus ring), voice (dictation and
// every voice-mode state, settings, push to talk), draft (a long dictation forming into a draft with
// the real drafting engine and scripted models: forming, a change glowing, the 9-minute warning, the
// check, refining by voice with and without motion, editing as text, sending, keeping as text, lost by
// the computer),
// picker (the voice picker from the menu and voice mode),
// machines (a second computer offered, added, listed, offline and back), scan (Add a computer's QR scan
// sheet: a live camera reading a code that isn't pi's, through BarcodeDetector and through the vendored
// jsQR, then camera access off and no camera).
// Needs Chrome or Chromium: CHROME=/path/to/chrome when it isn't in the usual place. Exits 1 on any axe
// violation, page error or failed step; report.json in the output folder lists them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { assertNoSound, NO_SOUND } from "./no-sound.mjs";

const { values: opt } = parseArgs({
	options: {
		out: { type: "string", default: "shots" },
		width: { type: "string", default: "390,320" },
		theme: { type: "string", default: "light,dark" },
		only: { type: "string", default: "app,voice,draft,picker,machines,scan" },
		port: { type: "string", default: "7979" },
		forced: { type: "boolean", default: false },
		reduced: { type: "boolean", default: false },
	},
});
const CHROME =
	process.env.CHROME ||
	["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!CHROME) throw new Error("no Chrome found: set CHROME=/path/to/chrome");
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const FIXTURE = new URL("./fixture.ts", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(opt.out, { recursive: true });

// A silent microphone, so basic voice hears nothing instead of Chrome's fake beep.
const silence = join(tmpdir(), "pi-mobile-silence.wav");
if (!existsSync(silence)) {
	const n = 16000 * 4;
	const b = Buffer.alloc(44 + n * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
	b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
	writeFileSync(silence, b);
}

// A fake camera showing a QR code that isn't pi's (Chrome loops the clip), for the scan flow.
const camera = join(tmpdir(), "pi-mobile-camera-qr.y4m");
{
	const { modules } = createRequire(import.meta.url)("qrcode").create("https://example.com/not-a-pi-code", { errorCorrectionLevel: "M" });
	const W = 640, H = 480, scale = 10, n = modules.size;
	const x0 = (W - n * scale) >> 1, y0 = (H - n * scale) >> 1;
	const y = Buffer.alloc(W * H, 200);
	for (let r = 0; r < n * scale; r++) for (let c = 0; c < n * scale; c++) y[(y0 + r) * W + x0 + c] = modules.get(Math.floor(r / scale), Math.floor(c / scale)) ? 20 : 245;
	const frame = Buffer.concat([Buffer.from("FRAME\n"), y, Buffer.alloc(W * H / 2, 128)]);
	writeFileSync(camera, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
}

const report = { errors: [], axe: {}, checks: {} };

async function session(theme, width, flow) {
	const fx = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FIXTURE, opt.port], { stdio: ["pipe", "pipe", "inherit"] });
	let buf = "";
	const link = await new Promise((resolve, reject) => {
		fx.on("exit", (c) => reject(new Error(`fixture exited (${c}); is port ${opt.port} in use?`)));
		fx.stdout.on("data", (d) => {
			buf += d;
			const m = /this computer: (\S+)/.exec(buf);
			if (m) resolve(m[1]);
		});
	});
	await sleep(1500); // let the scripted sessions link
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: [
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-audio-capture=${silence}`,
			...(flow === "scan" ? [`--use-file-for-fake-video-capture=${camera}`] : []),
			"--autoplay-policy=no-user-gesture-required",
			// Earcons and speech must never reach the speakers or headphones of whoever runs this.
			"--mute-audio",
		],
	});
	const page = await browser.newPage();
	// No speech or audio may reach whoever runs this: --mute-audio doesn't cover speechSynthesis on macOS.
	await page.evaluateOnNewDocument(NO_SOUND);
	await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	// Through CDP: puppeteer's emulateMediaFeatures refuses forced-colors.
	const cdp = await page.createCDPSession();
	const media = (reduce = opt.reduced) =>
		cdp.send("Emulation.setEmulatedMedia", {
			features: [
				{ name: "prefers-color-scheme", value: theme },
				...(opt.forced ? [{ name: "forced-colors", value: "active" }] : []),
				{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" },
			],
		});
	await media();
	const tag = `${theme}-${width}${opt.forced ? "-forced" : ""}${opt.reduced ? "-reduced" : ""}`;
	page.on("pageerror", (e) => report.errors.push(`${tag} ${flow}: ${e.message}`));
	// The machines flow switches a computer off on purpose; its refused connections are expected.
	page.on("console", (m) => m.type() === "error" && !(flow === "machines" && /ERR_CONNECTION_REFUSED/.test(m.text())) && report.errors.push(`${tag} ${flow} console: ${m.text()}`));

	const say = async (cmd) => {
		fx.stdin.write(`${cmd}\n`);
		await sleep(900);
	};
	const shot = async (name) => {
		await sleep(400);
		await page.screenshot({ path: join(opt.out, `${tag}-${name}.png`) });
		const found = await page.evaluate(async (src) => {
			if (!window.axe) (0, eval)(src);
			const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
			return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
		}, AXE);
		if (found.length) report.axe[`${tag}-${name}`] = found;
		// Nothing may scroll sideways: the page, or a sheet, card, composer, header or voice screen.
		const wide = await page.evaluate(() => {
			const out = [];
			if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth}px > ${innerWidth}px`);
			for (const e of document.querySelectorAll("header#top, .sheet-panel, .prompt, #composer, #voice, .attention, .dict-bar"))
				if (e.offsetParent !== null || getComputedStyle(e).position === "fixed")
					if (e.scrollWidth > e.clientWidth + 1) out.push(`${e.id ? `#${e.id}` : e.className} ${e.scrollWidth}px > ${e.clientWidth}px`);
			return out;
		});
		if (wide.length) report.errors.push(`${tag}-${name} overflows sideways: ${wide.join("; ")}`);
	};
	// Real taps, as a finger would: a scripted click() counts as keyboard use and shows focus rings.
	const tap = async (sel, text) => {
		const h = await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].find((x) => x.offsetParent && (!t || x.textContent.includes(t))) || null, { timeout: 10000 }, sel, text);
		const node = h.asElement();
		await node.evaluate((e) => e.scrollIntoView({ block: "center" }));
		await node.tap();
		await sleep(350);
	};
	const closeSheet = () => page.evaluate(() => document.querySelector(".sheet-backdrop")?.click()).then(() => sleep(300));
	const step = async (name, fn) => {
		try {
			await Promise.race([fn(), sleep(25000).then(() => Promise.reject(new Error("timeout")))]);
		} catch (e) {
			report.errors.push(`${tag} ${flow} ${name}: ${e.message}`);
		}
	};
	const ready = async () => {
		await page.goto(link);
		await assertNoSound(page);
		await page.waitForFunction(() => !document.querySelector("#composer").hidden, { timeout: 15000 });
		await sleep(800);
		await page.evaluate(() => {
			window.PiVoiceDebug = [];
			document.querySelector("#onboardNo")?.click();
		});
	};
	// A voice-like buzz made in the page as the microphone (into a stream, never to a speaker): Chrome's fake
	// audio file delivers only zeros (Chrome 154, macOS), which the recorder throws away as "too short".
	const buzzMic = (on = true) =>
		page.evaluate((on) => {
			const md = navigator.mediaDevices;
			md.realGUM ??= md.getUserMedia.bind(md);
			if (!on) return void (md.getUserMedia = md.realGUM);
			md.getUserMedia = async () => {
				const c = new AudioContext({ sinkId: { type: "none" } });
				const out = c.createMediaStreamDestination();
				const voice = c.createOscillator();
				voice.type = "sawtooth";
				voice.frequency.value = 140;
				const level = c.createGain();
				level.gain.value = 0.15;
				const syllables = c.createOscillator();
				syllables.frequency.value = 4;
				const depth = c.createGain();
				depth.gain.value = 0.15;
				syllables.connect(depth).connect(level.gain);
				voice.connect(level).connect(out);
				voice.start();
				syllables.start();
				return out.stream;
			};
		}, on);
	const openApi = async () => {
		await tap("#sessionBtn");
		await tap(".sheet-panel .row", "api");
		await sleep(500);
	};

	try {
		if (flow === "app") {
			await page.goto(link.split("#")[0]);
			await assertNoSound(page);
			await sleep(600);
			await shot("01-unpaired");
			await step("unpaired installed", async () => {
				// An iPhone Home Screen app: no Safari storage, no address bar; it pairs from a pasted link (#6).
				const standalone = await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, "standalone", { value: true }));
				try {
					await page.goto(link.split("#")[0]);
					await page.waitForSelector(".pair-form input");
					await sleep(400);
					await shot("01b-unpaired-installed");
					await page.type(".pair-form input", "https://other-box.example.ts.net/#p=abc.def");
					await tap(".pair-form .btn.primary");
					await page.waitForSelector(".pair-form .err-line:not([hidden])");
					await shot("01c-pair-link-error");
				} finally {
					await page.removeScriptToEvaluateOnNewDocument(standalone.identifier);
				}
			});
			await page.goto("about:blank");
			await ready();
			await shot("02-opens-on-waiting-session");
			await step("sessions", async () => {
				await tap("#sessionBtn");
				await shot("03-sessions");
				await tap(".sheet-panel .row", "api");
				await sleep(500);
				await shot("04-transcript");
			});
			await page.evaluate(() => {
				for (const d of document.querySelectorAll("#transcript details.tool")) d.open = true;
				document.querySelector("#scroller").scrollTop = 0;
			});
			await shot("05-tools-open-top");
			await page.evaluate(() => (document.querySelector("#scroller").scrollTop = 99999));
			await shot("06-tools-open-bottom");
			// An extension's long message is collapsed like pi's terminal shows it (source + two lines); a tap opens it.
			await step("extension message", async () => {
				const state = () =>
					page.evaluate(() => {
						const d = document.querySelector("#i-c1");
						return { tag: d.tagName, open: d.open, height: Math.round(d.getBoundingClientRect().height), short: document.querySelector("#i-c2").tagName };
					});
				await page.evaluate(() => document.querySelector("#i-c1").scrollIntoView({ block: "center" }));
				const collapsed = await state();
				await shot("06b-extension-message-collapsed");
				await tap("#i-c1 > summary");
				const expanded = await state();
				await page.evaluate(() => document.querySelector("#i-c1").scrollIntoView({ block: "center" }));
				await shot("06c-extension-message-expanded");
				report.checks[`${tag} extension message collapsed, then opened`] = { collapsed, expanded };
				if (collapsed.tag !== "DETAILS" || collapsed.open || collapsed.height > 110 || !expanded.open || expanded.height <= collapsed.height || collapsed.short !== "DIV")
					throw new Error(`extension message: ${JSON.stringify({ collapsed, expanded })}`);
				await tap("#i-c1 > summary");
			});
			await say("work");
			await shot("07-working");
			await say("ask");
			await shot("08-confirm");
			await step("answer", () => tap(".prompt .pact button", "Yes"));
			await say("pick");
			await shot("09-select");
			await step("pick", () => tap(".prompt .pact button"));
			await say("done");
			await step("menu", async () => {
				await tap("#menuBtn");
				await shot("10-menu");
				await closeSheet();
			});
			await step("models", async () => {
				// Below 300 px the header has no model chip; the menu's Model row opens the same sheet.
				if (width <= 300) {
					await tap("#menuBtn");
					await shot("11-menu-model");
					await tap(".sheet-panel .row", "Model");
				} else await tap("#modelBtn");
				await sleep(300);
				await shot("11-models");
				await closeSheet();
			});
			await step("new-session", async () => {
				await tap("#sessionBtn");
				await tap(".sheet-panel .btn", "New session");
				await shot("12-new-session");
				await closeSheet();
			});
			await step("slash", async () => {
				await page.type("#input", "/");
				await sleep(400);
				await shot("13-slash");
				await page.evaluate(() => {
					const i = document.querySelector("#input");
					i.value = "";
					i.dispatchEvent(new Event("input"));
					i.blur();
				});
			});
			// An attached image: its remove button is whole (not cut by the strip) and a 44 px target.
			await step("attachment", async () => {
				await page.evaluate(async () => {
					const c = document.createElement("canvas");
					c.width = 320;
					c.height = 480;
					const g = c.getContext("2d");
					g.fillStyle = "#2459d6";
					g.fillRect(0, 0, 320, 480);
					g.fillStyle = "#e9effd";
					for (let y = 40; y < 440; y += 48) g.fillRect(24, y, 272, 28);
					const blob = await new Promise((r) => c.toBlob(r, "image/png"));
					const dt = new DataTransfer();
					dt.items.add(new File([blob], "screen.png", { type: "image/png" }));
					const input = document.querySelector("#fileInput");
					input.files = dt.files;
					input.dispatchEvent(new Event("change"));
				});
				await page.waitForFunction(() => document.querySelector("#attachments .att-x"), { timeout: 5000 });
				await shot("13b-attachment");
				const x = await page.evaluate(() => {
					const strip = document.querySelector("#attachments").getBoundingClientRect();
					const face = document.querySelector("#attachments .att-x-face").getBoundingClientRect();
					const hit = document.querySelector("#attachments .att-x").getBoundingClientRect();
					return { faceInside: face.top >= strip.top && face.right <= strip.right && face.left >= strip.left, target: [Math.round(hit.width), Math.round(hit.height)] };
				});
				report.checks[`${tag} attachment remove button`] = x;
				if (!x.faceInside || x.target[0] < 44 || x.target[1] < 44) throw new Error(`remove button: ${JSON.stringify(x)}`);
				await tap("#attachments .att-x");
				if (!(await page.evaluate(() => document.querySelector("#attachments").hidden))) throw new Error("the image wasn't removed");
			});
			// The composer's last button: voice mode while empty, Send once there's text, never both.
			await step("voice or send", async () => {
				const buttons = () => page.evaluate(() => ({ voice: !document.querySelector("#voiceBtn").hidden, send: !document.querySelector("#sendBtn").hidden, header: !!document.querySelector("#top #voiceBtn") }));
				const empty = await buttons();
				await shot("13c-composer-voice");
				await page.type("#input", "Open the PR");
				const typed = await buttons();
				await page.evaluate(() => document.querySelector("#input").blur());
				await shot("13d-composer-send");
				await page.evaluate(() => {
					const i = document.querySelector("#input");
					i.value = "";
					i.dispatchEvent(new Event("input"));
				});
				const cleared = await buttons();
				report.checks[`${tag} voice or send`] = { empty, typed, cleared };
				if (!empty.voice || empty.send || typed.voice || !typed.send || !cleared.voice || cleared.send || empty.header) throw new Error(`voice/send: ${JSON.stringify({ empty, typed, cleared })}`);
			});
			// The on-screen keyboard, as iOS reports it: the visual viewport shrinks, the layout viewport doesn't,
			// and the bottom safe-area inset stays (34 px, emulated where Chrome can). The composer must sit on it.
			await step("keyboard", async () => {
				const insets = await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34 } }).then(() => true, () => false);
				const KB = 336;
				const measure = () =>
					page.evaluate((kb) => {
						const box = document.querySelector(".compose-box").getBoundingClientRect();
						return { gap: Math.round(innerHeight - kb - box.bottom), header: Math.round(document.querySelector("#top").getBoundingClientRect().top), scrollY };
					}, KB);
				const closed = await page.evaluate(() => Math.round(innerHeight - document.querySelector(".compose-box").getBoundingClientRect().bottom));
				await page.evaluate((kb) => {
					document.querySelector("#input").focus();
					const h = innerHeight - kb;
					Object.defineProperty(visualViewport, "height", { configurable: true, get: () => h });
					visualViewport.dispatchEvent(new Event("resize"));
					// A stand-in keyboard, only for the picture.
					const k = document.createElement("div");
					k.id = "fakeKeyboard";
					k.setAttribute("aria-hidden", "true");
					k.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${kb}px;z-index:99;background:${matchMedia("(prefers-color-scheme: dark)").matches ? "#2c2c2e" : "#d1d3d9"}`;
					document.body.appendChild(k);
				}, KB);
				await sleep(200);
				const open = await measure();
				await shot("13e-keyboard");
				report.checks[`${tag} composer on the keyboard`] = { safeAreaEmulated: insets, closedGapToScreenEdge: closed, open };
				if (open.gap < 0 || open.gap > 8 || open.header !== 0) throw new Error(`keyboard: ${JSON.stringify(open)}`);
				// No Done button above the keyboard in the iPhone app: a swipe down on the transcript puts it away.
				const sb = await (await page.$("#scroller")).boundingBox();
				await page.touchscreen.touchStart(sb.x + sb.width / 2, sb.y + 80);
				await page.touchscreen.touchMove(sb.x + sb.width / 2, sb.y + 140);
				await page.touchscreen.touchEnd();
				await sleep(200);
				const swiped = await page.evaluate(() => ({ focused: document.activeElement?.id === "input", kb: document.documentElement.classList.contains("kb") }));
				report.checks[`${tag} swipe down puts the keyboard away`] = swiped;
				if (swiped.focused || swiped.kb) throw new Error(`swipe down: ${JSON.stringify(swiped)}`);
				// A focus from code (after a dictation) with pi's question card on screen: the composer still sits on the keyboard.
				await tap("#sessionBtn");
				await tap(".sheet-panel .row", "infra");
				await sleep(500);
				await page.evaluate(() => {
					document.querySelector("#input").focus({ preventScroll: true });
					visualViewport.dispatchEvent(new Event("resize"));
				});
				await sleep(200);
				const asked = await measure();
				await shot("13f-keyboard-question");
				report.checks[`${tag} composer on the keyboard with a question`] = asked;
				if (asked.gap < 0 || asked.gap > 8 || asked.header !== 0) throw new Error(`keyboard with a question: ${JSON.stringify(asked)}`);
				await page.evaluate(() => {
					document.querySelector("#fakeKeyboard").remove();
					delete visualViewport.height;
					document.querySelector("#input").blur();
					visualViewport.dispatchEvent(new Event("resize"));
				});
				await sleep(150);
				if (await page.evaluate(() => document.documentElement.classList.contains("kb"))) throw new Error("keyboard stayed open");
				if (insets) await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
				await tap("#sessionBtn");
				await tap(".sheet-panel .row", "api");
				await sleep(400);
			});
			// Keyboard: the focus ring is visible, and whole inside a sheet's grouped rows.
			await step("keyboard", async () => {
				await page.keyboard.press("Tab");
				await page.keyboard.press("Tab");
				await shot("14-focus");
				await page.focus("#menuBtn");
				await page.keyboard.press("Enter");
				await sleep(400);
				await page.keyboard.press("Tab");
				report.checks[`${tag} focus ring in a sheet`] = await page.evaluate(() => {
					const a = document.activeElement;
					const s = getComputedStyle(a);
					return { focusVisible: a.matches(":focus-visible"), outline: `${s.outlineStyle} ${s.outlineWidth} offset ${s.outlineOffset}` };
				});
				await shot("15-focus-in-sheet");
				await page.keyboard.press("Escape");
			});
		}

		if (flow === "voice") {
			await ready();
			await openApi();
			await step("dictation", async () => {
				await buzzMic();
				await tap("#micBtn");
				await sleep(2000);
				await shot("d1-recording");
				await tap("#dictBar .rec-done");
				await shot("d2-distilling");
				await sleep(1600);
				await shot("d3-review");
				report.checks[`${tag} dictation landed in the composer`] = await page.evaluate(() => document.querySelector("#input").value);
				await buzzMic(false);
			});
			await say("done");
			await step("voice", async () => {
				// The dictation left text in the composer, so its last button is Send: voice mode from the menu.
				await tap("#menuBtn");
				await tap(".sheet-panel .row", "Voice mode");
				await sleep(2500);
				const pv = (s, o = {}) => page.evaluate((s, o) => window.PiVoice.preview(s, o), s, o);
				const heard = "Can you also round the totals to cents?";
				await pv("listening");
				await shot("v01-listening");
				await pv("hearing", { heard: heard.slice(0, -1) });
				await shot("v02-hearing");
				await pv("thinking", { heard });
				await shot("v03-thinking");
				await pv("working", { heard });
				await shot("v04-working");
				await pv("speaking", { heard, said: "Done. Totals are rounded to cents now, and the report tests pass." });
				await shot("v05-speaking");
				await say("ask");
				await pv("asking", { said: "pi wants to change the report file. Say yes, or no." });
				await shot("v06-asking");
				await tap("#vMute");
				await shot("v07-muted");
				await tap("#vMute");
				await pv("listening");
				await tap("#vSettings");
				await shot("v08-settings");
				await tap(".sheet-panel .seg button", "Push to talk");
				await shot("v09-settings-push-to-talk");
				await tap(".sheet-close");
				await shot("v10-push-to-talk");
				// Hold the circle: listening while held, ends on release; a short tap toggles.
				const box = await (await page.$("#vOrb")).boundingBox();
				const state = () => page.evaluate(() => ({ state: document.querySelector("#voice").dataset.state, hint: document.querySelector("#vHint").textContent }));
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.down();
				await sleep(900);
				const held = await state();
				await shot("v11-holding");
				await page.mouse.up();
				await sleep(400);
				report.checks[`${tag} push to talk`] = { held, released: await state() };
			});
		}

		if (flow === "draft") {
			await ready();
			await openApi();
			// Short chunks, so the scripted ramble arrives in seconds; the buzz as the microphone.
			await page.evaluate(() => (window.PiDraftDebug = { minMs: 1500, maxMs: 2500 }));
			await buzzMic();
			const glowing = () => page.waitForFunction(() => document.querySelector("#draftBody .draft-block.glow, #draftBody .draft-block.fade, #draftBody .draft-block.marked"), { timeout: 10000 });
			const blocks = () => page.evaluate(() => [...document.querySelectorAll("#draftBody .draft-block")].map((b) => `${b.className.replace("draft-block ", "")}: ${b.textContent}`));
			const setMotion = (reduce) => media(reduce || opt.reduced);
			await step("forming", async () => {
				await tap("#micBtn");
				await page.waitForFunction(() => !document.querySelector("#draftSheet").hidden, { timeout: 15000 });
				await glowing();
				await shot("dr1-forming");
				// The next part of the ramble lands: only what it changed glows.
				await page.waitForFunction(() => document.querySelectorAll("#draftBody .draft-block").length >= 6, { timeout: 15000 });
				await sleep(150);
				await shot("dr2-glow");
				report.checks[`${tag} draft while talking`] = await blocks();
				await page.evaluate(() => (window.PiDraftDebug.elapsedMs = 545_000));
				await page.waitForFunction(() => document.querySelector("#draftNote.warn"), { timeout: 5000 });
				await shot("dr3-limit-warning");
				report.checks[`${tag} draft limit warning`] = await page.evaluate(() => [document.querySelector("#draftNote").textContent, document.querySelector("#dictBar .rec-time").textContent]);
				await page.evaluate(() => (window.PiDraftDebug.elapsedMs = 0));
			});
			await step("finished", async () => {
				await tap("#dictBar .rec-done");
				await page.waitForFunction(() => document.querySelector("#draftSheet").dataset.ui === "checking", { timeout: 5000 });
				await shot("dr4-checking");
				await page.waitForFunction(() => document.querySelector("#draftSheet").dataset.ui === "ready", { timeout: 15000 });
				await shot("dr5-finished");
				report.checks[`${tag} draft after the check`] = { note: await page.evaluate(() => document.querySelector("#draftNote").textContent), blocks: await blocks() };
			});
			await step("refining by voice", async () => {
				await sleep(3200); // the check's glow has faded
				await tap("#micBtn");
				await sleep(2200); // long enough that the silent clip isn't "too short"
				await shot("dr6-dictating-a-change");
				await tap("#dictBar .rec-done");
				await page.waitForFunction(() => document.querySelector("#draftBody .draft-block.removed"), { timeout: 15000 });
				await sleep(100);
				await shot("dr7-changed");
				await sleep(3500);
				report.checks[`${tag} draft after a change by voice`] = await blocks();
			});
			await step("reduced motion", async () => {
				// Without motion the change is marked in the margin instead of glowing, until the draft is touched.
				await setMotion(true);
				await tap("#micBtn");
				await sleep(2500);
				await tap("#dictBar .rec-done");
				await page.waitForFunction(() => document.querySelector("#draftSheet").dataset.ui === "ready" && document.querySelector("#draftBody .draft-block.marked"), { timeout: 15000 });
				await shot("dr8-changed-reduced-motion");
				report.checks[`${tag} draft marks without motion`] = await page.evaluate(() => [...document.querySelectorAll("#draftBody .draft-block.marked")].map((b) => b.textContent));
				await setMotion(false);
			});
			await step("edit as text", async () => {
				await tap("#draftEdit");
				await page.evaluate(() => {
					const t = document.querySelector("#draftText");
					t.value += "\n- Retries pause while the phone is offline";
					t.dispatchEvent(new Event("input"));
					t.blur();
				});
				await shot("dr9-editing-as-text");
				await tap("#draftEdit");
				await page.waitForFunction(() => [...document.querySelectorAll("#draftBody .draft-block")].some((b) => b.textContent.includes("offline") && b.textContent.includes("pause")), { timeout: 5000 });
				await shot("dr10-refined");
			});
			await step("send", async () => {
				await tap("#sendBtn");
				await page.waitForFunction(() => document.querySelector("#draftSheet").hidden, { timeout: 5000 });
				await sleep(600);
				await shot("dr11-sent");
				report.checks[`${tag} draft sent as a message`] = await page.evaluate(() => [...document.querySelectorAll("#transcript .msg.user")].at(-1)?.textContent.slice(0, 160));
				// What was typed as text is sent as typed.
				const sent = await page.evaluate(() => [...document.querySelectorAll("#transcript .msg.user")].at(-1)?.textContent ?? "");
				if (!sent.includes("- Retries pause while the phone is offline")) throw new Error(`the typed line wasn't sent as typed: ${sent.slice(-200)}`);
			});
			await step("keep as text", async () => {
				// ✕ while a draft forms: it goes to the message box as text.
				await tap("#micBtn");
				await page.waitForFunction(() => !document.querySelector("#draftSheet").hidden, { timeout: 15000 });
				await tap("#dictBar .rec-x");
				await page.waitForFunction(() => document.querySelector("#draftSheet").hidden && document.querySelector("#input").value.includes("## Goal"), { timeout: 15000 });
				await sleep(300);
				await shot("dr12-kept-as-text");
				report.checks[`${tag} draft kept as text`] = await page.evaluate(() => document.querySelector("#input").value.split("\n").slice(0, 3));
			});
			await step("lost by the computer", async () => {
				// pi restarts while a draft forms: the sheet says so, and ✓ makes the whole recording an ordinary dictation.
				await page.evaluate(() => {
					document.querySelector("#input").value = "";
					window.PiMobile.autosize();
				});
				await tap("#micBtn");
				await page.waitForFunction(() => !document.querySelector("#draftSheet").hidden, { timeout: 15000 });
				await say("lose");
				await page.waitForFunction(() => /lost this draft/.test(document.querySelector("#draftNote").textContent), { timeout: 15000 });
				await shot("dr13-lost");
				await tap("#dictBar .rec-done");
				await page.waitForFunction(() => document.querySelector("#draftSheet").hidden && document.querySelector("#dictBar").dataset.kind === "done", { timeout: 15000 });
				await shot("dr14-lost-whole-recording");
				report.checks[`${tag} draft lost: the whole recording`] = await page.evaluate(() => [document.querySelector("#dictBar .grow").textContent, document.querySelector("#input").value]);
			});
		}

		if (flow === "machines") {
			await ready();
			await step("offer", async () => {
				await say("box");
				await page.waitForFunction(() => document.querySelector("#sheetTitle")?.textContent.startsWith("Add "), { timeout: 10000 });
				await shot("m1-offer");
				await tap(".sheet-panel .btn.primary", "Add");
				await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("added")), { timeout: 10000 });
				await sleep(1500);
			});
			await step("one list", async () => {
				await tap("#sessionBtn");
				await shot("m2-sessions");
				report.checks[`${tag} sessions from two computers`] = await page.evaluate(() => [...document.querySelectorAll(".sheet-panel .row .sub")].map((x) => x.textContent));
				await tap(".sheet-panel .row", "deploy");
				await sleep(600);
				await shot("m3-box-session");
				report.checks[`${tag} header names the computer`] = await page.evaluate(() => document.querySelector("#sessionSub").textContent);
			});
			await step("computers", async () => {
				await tap("#menuBtn");
				await page.evaluate(() => [...document.querySelectorAll(".sheet-panel .section")].find((x) => x.textContent.startsWith("Computers"))?.scrollIntoView());
				await shot("m4-menu-computers");
				await closeSheet();
			});
			await step("offline", async () => {
				await say("box off");
				await sleep(2500);
				await shot("m5-box-offline");
				await tap("#sessionBtn");
				await shot("m6-sessions-offline");
				await closeSheet();
				await say("box on");
				await page.waitForFunction(() => !document.querySelector("#banner") || document.querySelector("#banner").hidden, { timeout: 12000 });
				await shot("m7-box-back");
			});
			await step("add from the notification", async () => {
				// What the service worker opens after "Add" on an offer's notification: no sheet, just added.
				const phone = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-mobile-device")).d);
				await page.goto(`${new URL(link).origin}/?accept=fx2${phone}`);
				await assertNoSound(page);
				await page.waitForFunction(() => !document.querySelector("#composer").hidden, { timeout: 15000 });
				await say("box again");
				await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("added")), { timeout: 10000 });
				report.checks[`${tag} added from the notification without a sheet`] = await page.evaluate(() => !document.querySelector("#sheetTitle")?.textContent.startsWith("Add "));
				await shot("m8-added-from-notification");
			});
			await step("new session on the box", async () => {
				// herdr's New session with two computers: pick the box, see its folders, and it starts there.
				await tap("#sessionBtn");
				await tap(".sheet-panel .btn", "New session");
				await tap(".sheet-panel .seg button", "hetzner-box");
				await shot("m9-new-session-box");
				const offered = await page.evaluate(() => ({
					picked: document.querySelector('.sheet-panel .seg button[aria-pressed="true"]')?.textContent,
					folder: document.querySelector(".sheet-panel input").value,
					folders: [...document.querySelectorAll("#folders option")].map((o) => o.value),
				}));
				report.checks[`${tag} new session on the box offers its folders`] = offered;
				if (JSON.stringify(offered) !== JSON.stringify({ picked: "hetzner-box", folder: "/home/you/api", folders: ["/home/you/api"] })) throw new Error(`box folders: ${JSON.stringify(offered)}`);
				const before = buf.length;
				await tap(".sheet-panel .btn.primary", "Start pi");
				await page.waitForFunction(() => document.querySelector("#sessionSub")?.textContent.startsWith("hetzner-box") && document.querySelector("#sessionName")?.textContent === "api", { timeout: 10000 });
				const spawned = buf.slice(before).match(/spawn .*/g) ?? [];
				report.checks[`${tag} new session started on the box`] = spawned;
				if (spawned.length !== 1 || spawned[0] !== "spawn hetzner-box /home/you/api") throw new Error(`spawn log: ${JSON.stringify(spawned)}`);
				await shot("m10-started-on-box");
			});
		}

		if (flow === "scan") {
			await ready();
			const openScan = async () => {
				await tap("#menuBtn");
				await tap(".sheet-panel .row", "Add a computer");
				await tap(".sheet-panel .btn", "Scan QR code");
			};
			const wrongCode = () => page.waitForFunction(() => document.querySelector(".scan-hint")?.textContent.includes("isn't from pi"), { timeout: 10000 });
			// Keep every camera stream the app opens (optionally late), so the checks can see it was stopped.
			const trackStreams = (delay = 0) =>
				page.evaluate((ms) => {
					const md = navigator.mediaDevices;
					md.realGUM ??= md.getUserMedia.bind(md);
					window.scanStreams = [];
					md.getUserMedia = async (c) => {
						const s = await md.realGUM(c);
						window.scanStreams.push(s);
						await new Promise((r) => setTimeout(r, ms));
						return s;
					};
				}, delay);
			const cameraOff = async (when) => {
				await sleep(300);
				const s = await page.evaluate(() => window.scanStreams.map((x) => x.getTracks().map((t) => t.readyState)));
				report.checks[`${tag} camera off after ${when}`] = s;
				if (!s.length || s.flat().some((r) => r !== "ended")) throw new Error(`camera still on after ${when}: ${JSON.stringify(s)}`);
			};
			await step("add sheet", async () => {
				await tap("#menuBtn");
				await tap(".sheet-panel .row", "Add a computer");
				await shot("s1-add-computer");
				await closeSheet();
			});
			await step("live camera", async () => {
				await trackStreams();
				await openScan();
				await wrongCode();
				await shot("s2-scan-not-pi");
				report.checks[`${tag} scan reads a code (${await page.evaluate(() => ("BarcodeDetector" in window ? "BarcodeDetector" : "jsQR"))})`] = true;
				await tap(".sheet-panel .btn", "Cancel");
				if (!(await page.evaluate(() => document.querySelector("#sheetTitle")?.textContent === "Add a computer" && !document.querySelector(".scan-view")))) throw new Error("Cancel didn't go back to Add a computer");
				await cameraOff("Cancel");
				await closeSheet();
			});
			await step("vendored decoder", async () => {
				await page.evaluate(() => delete window.BarcodeDetector);
				await trackStreams();
				await openScan();
				await wrongCode();
				if (!(await page.evaluate(() => typeof window.jsQR === "function"))) throw new Error("jsQR not loaded");
				await closeSheet();
				await cameraOff("closing the sheet");
			});
			await step("backgrounded", async () => {
				await trackStreams();
				await openScan();
				await wrongCode();
				const setHidden = (h) =>
					page.evaluate((hide) => {
						if (hide) Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
						else delete document.visibilityState;
						document.dispatchEvent(new Event("visibilitychange"));
					}, h);
				await setHidden(true);
				await cameraOff("leaving the app");
				await setHidden(false);
				await closeSheet();
			});
			await step("camera arrives after cancel", async () => {
				await trackStreams(1500);
				await openScan();
				await tap(".sheet-panel .btn", "Cancel");
				await sleep(1800);
				await cameraOff("a late camera start");
				await closeSheet();
			});
			const failCamera = (name) => page.evaluate((n) => (navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no", n))), name);
			await step("camera off", async () => {
				await failCamera("NotAllowedError");
				await openScan();
				await page.waitForFunction(() => document.querySelector(".scan-view")?.dataset.state === "denied", { timeout: 5000 });
				await shot("s3-scan-denied");
				await closeSheet();
			});
			await step("no camera", async () => {
				await failCamera("NotFoundError");
				await openScan();
				await page.waitForFunction(() => document.querySelector(".scan-view")?.dataset.state === "none", { timeout: 5000 });
				await shot("s4-scan-no-camera");
				await tap(".sheet-panel .btn", "Paste link instead");
				report.checks[`${tag} paste link focuses the field`] = await page.evaluate(() => document.activeElement?.tagName === "INPUT");
				await closeSheet();
			});
			await step("starting", async () => {
				await page.evaluate(() => (navigator.mediaDevices.getUserMedia = () => new Promise(() => {})));
				await openScan();
				await shot("s5-scan-starting");
				await closeSheet();
			});
		}

		if (flow === "picker") {
			await ready();
			await openApi();
			await step("menu picker", async () => {
				await tap("#menuBtn");
				await tap(".sheet-panel .row", "voice mode");
				await sleep(500);
				await shot("p1-picker");
				await tap(".sheet-panel .row", "Cedar");
				await shot("p2-picked");
				report.checks[`${tag} persona stored`] = await page.evaluate(() => localStorage.getItem("pi-mobile-voice-persona"));
				await page.keyboard.press("Escape");
			});
			await step("voice-mode picker", async () => {
				await tap("#voiceBtn");
				await sleep(2500);
				await page.evaluate(() => window.PiVoice.preview("listening", {}));
				await tap("#vSettings");
				await tap(".sheet-panel .row", "Cedar");
				await sleep(500);
				await shot("p3-voice-mode-picker");
			});
		}
	} catch (e) {
		report.errors.push(`${tag} ${flow}: ${e.message}`);
	} finally {
		await browser.close();
		fx.kill();
		await new Promise((r) => fx.once("exit", r));
	}
}

for (const theme of opt.theme.split(","))
	for (const width of opt.width.split(",").map(Number))
		for (const flow of opt.only.split(",")) {
			process.stdout.write(`${theme} ${width} ${flow}… `);
			await session(theme, width, flow);
			console.log("done");
		}

writeFileSync(join(opt.out, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.errors.length || Object.keys(report.axe).length ? 1 : 0);
