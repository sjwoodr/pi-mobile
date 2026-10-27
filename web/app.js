// pi mobile — phone client. Every API payload is sealed with NaCl secretbox under a per-device key
// that arrived in the pairing QR's URL fragment (never sent to any server in clear).
"use strict";

(() => {
	const nacl = window.nacl;
	const $ = (id) => document.getElementById(id);
	const DEVICE_KEY = "pi-mobile-device";
	const AGENT_KEY = "pi-mobile-agent";
	const MODE_KEY = "pi-mobile-mode";

	// ── storage ────────────────────────────────────────────────────────────────────
	const store = {
		get(k) {
			try {
				return JSON.parse(localStorage.getItem(k) || "null");
			} catch {
				return null;
			}
		},
		set(k, v) {
			try {
				if (v === null || v === undefined) localStorage.removeItem(k);
				else localStorage.setItem(k, JSON.stringify(v));
			} catch {}
		},
	};

	// ── crypto ─────────────────────────────────────────────────────────────────────
	function b64u(bytes) {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}
	function unb64u(text) {
		const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
		const out = new Uint8Array(s.length);
		for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
		return out;
	}
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	function seal(key, value) {
		const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
		const box = nacl.secretbox(enc.encode(JSON.stringify(value)), nonce, key);
		const out = new Uint8Array(nonce.length + box.length);
		out.set(nonce);
		out.set(box, nonce.length);
		return b64u(out);
	}
	function open(key, sealed) {
		const raw = unb64u(sealed);
		const n = nacl.secretbox.nonceLength;
		const plain = nacl.secretbox.open(raw.subarray(n), raw.subarray(0, n), key);
		if (!plain) throw new Error("could not decrypt (wrong key?)");
		return JSON.parse(dec.decode(plain));
	}

	// ── state ──────────────────────────────────────────────────────────────────────
	const S = {
		agents: new Map(), // agent -> info, from every machine
		prompts: new Map(), // agent -> Map(id -> prompt)
		current: null,
		view: null, // transcript state of the current agent
		mode: store.get(MODE_KEY) || "steer",
		commands: null,
		attachments: [],
		models: null,
		push: { key: null, on: false },
		offers: [], // machines offered by another of your computers, waiting for "Add"
		accepted: undefined, // an offer already accepted from its notification
		pushKeys: new Map(), // machine -> the push key it signs with
		notifyOn: new Map(), // machine -> it holds this browser's push subscription (hub `pushOn`)
		notifyWhy: new Map(), // machine -> why sharing the subscription with it failed
	};
	const Unauthorized = window.PiFleet.Unauthorized;
	const PROTOCOL = 1; // src/protocol.ts

	// Every machine this phone uses, each with its own key and connection (web/fleet.js).
	const fleet = window.PiFleet.createFleet({
		seal,
		open,
		unb64u,
		fetch: (...a) => fetch(...a),
		origin: location.origin,
		// The native app keeps the machines in its Keychain (native/ios/BRIDGE.md, `machines`).
		storage: {
			get: (k) => store.get(k),
			set(k, v) {
				store.set(k, v);
				if (k === "pi-mobile-machines") toNative({ type: "machines", machines: v || [] });
			},
		},
		onHello: (id) => resync(id),
		onEvent: (id, ev) => onMachineEvent(id, ev),
		onState: (id) => machineStateChanged(id),
		onRevoked: (id, reason) => machineRevoked(id, reason),
	});
	/** The computer that serves this app (the first one paired), as the single-machine code knew it. */
	Object.defineProperty(S, "device", {
		get() {
			const m = fleet.primary() || fleet.machines[0];
			return m ? { d: m.d, k: m.k, role: "control", host: m.name, id: m.id } : null;
		},
	});
	/** Whether the machine of the session on screen is reachable (any machine, without a session). */
	Object.defineProperty(S, "online", {
		get() {
			const id = S.current && fleet.machineOf(S.current);
			return id ? fleet.state(id) === "online" : fleet.anyOnline();
		},
	});
	const several = () => fleet.machines.length > 1;
	const machineName = (agent) => fleet.get(fleet.machineOf(agent))?.name || "";

	/** Calls the computer that serves this app (devices, pairing, unpairing). */
	async function rpc(m, p) {
		const primary = fleet.primary();
		if (!primary) throw new Unauthorized("not paired");
		return fleet.rpc(primary.id, m, p);
	}
	const call = (m, p, agent = S.current) => fleet.call(agent, m, p || {});

	// ── pairing ────────────────────────────────────────────────────────────────────
	function deviceName() {
		const ua = navigator.userAgent;
		const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
		const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "";
		return browser ? `${kind} · ${browser}` : kind;
	}

	async function pairFromHash() {
		const m = /[#&]p=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(location.hash);
		if (!m) return false;
		history.replaceState(null, "", location.pathname + location.search);
		showEmpty("<h2>Pairing…</h2>");
		const key = unb64u(m[2]);
		try {
			const res = await fetch("api/pair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ p: m[1], b: seal(key, { t: Date.now(), name: deviceName() }) }),
			});
			const body = await res.json();
			if (!res.ok || !body.b) throw new Error(body.error || `HTTP ${res.status}`);
			const out = open(key, body.b);
			const old = fleet.primary();
			if (old) fleet.remove(old.id);
			fleet.add({ d: out.d, k: out.k, machine: out.machine?.id, name: out.host, primary: true });
			toast(`Paired with ${out.host}`);
			return true;
		} catch (e) {
			if (S.device) {
				toast(`Pairing failed: ${e.message}`, "error");
				return true;
			}
			showEmpty(`<h2>Pairing failed</h2><p>${esc(e.message)}</p><p>Run <code>/remote</code> in pi again and scan the new code.</p>`);
			return "failed";
		}
	}

	/** Tells the native app (only inside it) about a change; the reply does not matter. */
	function toNative(msg) {
		if (!window.PiNative) return;
		try {
			Promise.resolve(window.webkit?.messageHandlers?.piNative?.postMessage(msg)).catch(() => {});
		} catch {}
	}

	/** A native call whose reply matters (inside the app only); rejects with the app's sentence. */
	function callNative(msg) {
		return Promise.resolve(window.webkit?.messageHandlers?.piNative?.postMessage(msg));
	}

	function unpaired(reason) {
		// In the native app, a real unpair (always with a reason) also clears its Keychain (native/ios/BRIDGE.md).
		if (reason) toNative({ type: "unpaired" });
		fleet.stop();
		for (const m of fleet.machines) fleet.remove(m.id);
		store.set(DEVICE_KEY, null);
		$("composer").hidden = true;
		$("modelBtn").hidden = true;
		$("transcript").replaceChildren();
		$("prompts").replaceChildren();
		$("olderBtn").hidden = true;
		setHeader();
		showEmpty(
			`<img class="logo" src="icon.svg" alt=""><h2>Connect to pi</h2>${reason ? `<p>${esc(reason)}.</p>` : "<p>Use your pi sessions from this phone.</p>"}${
				installed()
					? "<ol><li><span>In pi on your computer, run <code>/remote pair</code></span></li><li><span>In the Camera app, touch and hold the QR code, then tap Copy Link</span></li><li><span>Paste the link here</span></li></ol>"
					: "<ol><li><span>In pi on your computer, run <code>/remote</code></span></li><li><span>Scan the QR code with this phone's camera</span></li><li><span>Add this page to your Home Screen</span></li></ol>"
			}`,
		);
		if (installed()) pairLinkForm();
	}

	/** Opened from the Home Screen: an installed web app, with no address bar and storage of its own. */
	const installed = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

	/**
	 * Pairs an installed app from a pasted `/remote pair` link (#6). On iPhone it doesn't share Safari's
	 * storage, so a pairing made in Safari never reaches it, and scanning a code opens Safari, not the app.
	 */
	function pairLinkForm() {
		const form = el("div", "pair-form");
		const input = el("input");
		input.type = "url";
		input.placeholder = "https://….ts.net/#p=…";
		input.autocomplete = "off";
		const f = el("label", "field");
		f.append(el("span", "", "Pairing link"), input);
		const err = el("p", "err-line");
		err.setAttribute("role", "alert");
		err.hidden = true;
		const fail = (text) => {
			err.textContent = text;
			err.hidden = false;
		};
		const go = el("button", "btn primary", "Pair");
		go.onclick = () => {
			let url;
			try {
				url = new URL(input.value.trim());
			} catch {}
			if (!url || !/[#&]p=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(url.hash)) return fail("That isn't a pairing link. Run /remote pair in pi and copy its link.");
			if (url.origin !== location.origin) return fail(`That link is for ${url.host}. Run /remote pair on the computer this app opens.`);
			// The page pairs from its address on load, as after a scan: this app's own device, revocable on its own.
			location.hash = url.hash;
			location.reload();
		};
		form.append(f, err);
		if (navigator.clipboard?.readText) {
			const paste = el("button", "btn");
			paste.append(icon("copy"), "Paste");
			paste.onclick = async () => {
				try {
					input.value = (await navigator.clipboard.readText()).trim();
				} catch {}
			};
			form.append(paste);
		}
		form.append(go);
		$("empty").append(form);
	}

	function showEmpty(html) {
		const el = $("empty");
		if (html) {
			el.innerHTML = html;
			el.hidden = false;
		} else el.hidden = true;
	}

	// ── machines and their events ──────────────────────────────────────────────────
	// Mobile browsers silently freeze sockets in the background; the hubs ping every 15 s.
	setInterval(() => fleet.watch(), 5000);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") fleet.watch(Date.now(), true);
		if (document.visibilityState === "visible") refreshNativePush();
	});

	function onMachineEvent(id, ev) {
		if (ev.type === "machine_offer") return offerMachine(id, ev.offer);
		if (ev.type === "machine_removed") return machineRemovedElsewhere(id, ev.offer);
		handleEvent(ev);
	}

	const wasOffline = new Set();
	function machineStateChanged(id) {
		// Voice mode says it once when the computer it's following goes away, and when it's back.
		const st = fleet.state(id);
		const name = fleet.get(id)?.name || "The computer";
		if (st === "offline" && !wasOffline.has(id)) {
			wasOffline.add(id);
			window.PiVoice?.onMachine?.(id, name, false);
		} else if (st === "online" && wasOffline.delete(id)) window.PiVoice?.onMachine?.(id, name, true);
		const b = $("banner");
		if (S.online || !S.device) b.hidden = true;
		else {
			const name = fleet.get(fleet.machineOf(S.current) || id)?.name;
			b.innerHTML = `<span class="spinner" aria-hidden="true"></span>${several() && name ? `Reconnecting to ${esc(name)}…` : "Reconnecting…"}`;
			b.className = "banner";
			b.hidden = false;
		}
		updateComposer();
		if (!$("sheet").hidden) window.dispatchEvent(new Event("pi-machines"));
	}

	function machineRevoked(id, reason) {
		const m = fleet.get(id);
		if (!m) return;
		const gone = fleet.remove(id);
		for (const a of gone) {
			S.agents.delete(a);
			S.prompts.delete(a);
		}
		if (!fleet.machines.length) return unpaired(reason);
		toast(`${m.name || "A computer"} removed this phone`, "warning");
		if (!S.agents.has(S.current)) {
			S.current = pickAgent();
			loadCurrent();
		} else setHeader();
	}

	/** A machine said hello (first connect, or after a gap it couldn't replay): take its sessions fresh. */
	async function resync(id) {
		try {
			const hub = await fleet.rpc(id, "hub");
			fleet.identify(id, hub.machine);
			if (hub.protocol !== undefined && hub.protocol !== PROTOCOL) {
				toast(`${hub.host} runs a different pi-mobile version; update it to use it here`, "warning");
				return;
			}
			const mine = new Set(hub.agents.map((a) => a.agent));
			for (const a of fleet.agentsOf(id)) {
				if (mine.has(a)) continue;
				S.agents.delete(a);
				S.prompts.delete(a);
			}
			fleet.adopt(id, [...mine]);
			for (const a of hub.agents) S.agents.set(a.agent, a);
			// The subscription's own key wins; without one, the computer serving the app decides.
			if (!S.push.fromSub && (fleet.get(id)?.primary || !S.push.key)) S.push.key = hub.pushKey;
			S.push.on = S.push.on || !!hub.pushOn;
			S.notifyOn.set(id, !!hub.pushOn);
			// iPhone app: a computer can send APNs once its key is set (/remote settings).
			S.push.apns = S.push.apns || !!hub.apns;
			// Every machine notifies on its own: give one that doesn't know this phone's subscription.
			S.pushKeys.set(id, hub.pushKey);
			if (S.push.on && (!hub.pushOn || hub.pushKey !== S.push.key)) shareSubscription(id);
			if (!S.agents.has(S.current)) S.current = pickAgent();
			maybeOnboard();
			if (!S.current || fleet.machineOf(S.current) === id || !S.view) await loadCurrent();
			else {
				setHeader();
				updateTitle();
				renderAttention();
			}
		} catch (e) {
			if (e instanceof Unauthorized) return;
			toast(`Sync failed: ${e.message}`, "error");
		}
	}

	function pickAgent() {
		const saved = store.get(AGENT_KEY);
		if (saved && S.agents.has(saved)) return saved;
		return sortedAgents()[0]?.agent || null;
	}

	// ── transcript model ───────────────────────────────────────────────────────────
	function newView(agent) {
		return { agent, loading: true, pending: [], n: 0, start: 0, total: 0, stream: null, tools: new Map() };
	}

	async function loadCurrent() {
		const agent = S.current;
		S.commands = null;
		S.models = null;
		$("transcript").replaceChildren();
		$("liveTools").replaceChildren();
		$("olderBtn").hidden = true;
		setHeader();
		renderPrompts();
		renderAttention();
		if (!agent) {
			showEmpty(`<img class="logo" src="icon.svg" alt=""><h2>No sessions yet</h2><p>Run <code>/remote</code> in pi on your computer and its sessions appear here.</p>`);
			updateComposer();
			return;
		}
		showEmpty("");
		store.set(AGENT_KEY, agent);
		// Inside the app: "Start voice" from Siri or Control Center opens this session next.
		toNative({ type: "focus", agent, machine: fleet.machineOf(agent) || "", name: S.agents.get(agent)?.name || "" });
		const view = newView(agent);
		S.view = view;
		try {
			// Detailed events (token stream, tool output) flow only for the session on screen.
			await fleet.focus(agent);
			const snap = await call("snapshot", { limit: 120 }, agent);
			if (S.view !== view) return;
			view.n = snap.n || 0;
			view.start = snap.start;
			view.total = snap.total;
			S.agents.set(agent, snap.info);
			S.prompts.set(agent, new Map(snap.prompts.map((p) => [p.id, p])));
			const frag = document.createDocumentFragment();
			for (const item of snap.items) frag.appendChild(renderItem(item));
			$("transcript").replaceChildren(frag);
			linkToolResults();
			if (snap.streaming) {
				view.stream = { key: snap.streaming.id, blocks: snap.streaming.blocks.map((b) => ({ t: b.t === "tool" ? "tool" : b.t, text: b.t === "tool" ? b.args : b.text, name: b.name })) };
				renderStream();
			}
			for (const t of snap.tools) toolStart(t.id, t.name, t.title, t.output);
			$("olderBtn").hidden = view.start === 0;
			view.loading = false;
			for (const ev of view.pending) if (ev.n === undefined || ev.n > view.n) applyAgentEvent(ev);
			view.pending = [];
			setHeader();
			renderPrompts();
			updateComposer();
			scrollToBottom(true);
			if (!snap.items.length && !snap.streaming) showEmpty(`<h2>Nothing here yet</h2><p>Tell pi what to do in ${esc(snap.info?.name || "this session")}.</p>`);
		} catch (e) {
			if (e instanceof Unauthorized) return; // machineRevoked() handles it
			if (S.view === view) showEmpty(`<p>Could not load the session: ${esc(e.message)}</p>`);
		}
	}

	async function loadOlder() {
		const view = S.view;
		if (!view || view.start === 0) return;
		$("olderBtn").disabled = true;
		try {
			const snap = await call("snapshot", { limit: 120, before: view.start });
			if (S.view !== view) return;
			const sc = $("scroller");
			const fromBottom = sc.scrollHeight - sc.scrollTop;
			const frag = document.createDocumentFragment();
			for (const item of snap.items) frag.appendChild(renderItem(item));
			$("transcript").prepend(frag);
			linkToolResults();
			view.start = snap.start;
			$("olderBtn").hidden = view.start === 0;
			sc.scrollTop = sc.scrollHeight - fromBottom;
		} catch (e) {
			toast(e.message, "error");
		} finally {
			$("olderBtn").disabled = false;
		}
	}

	function handleEvent(ev) {
		const agent = ev.agent;
		window.PiVoice?.onEvent(ev);
		if (ev.type === "info") {
			S.agents.set(agent, ev.info);
			// A session this phone asked herdr to start has arrived: open it.
			if (S.spawning && ev.info.spawn === S.spawning) {
				S.spawning = null;
				openAgent(agent);
			}
			if (!S.current) {
				S.current = agent;
				loadCurrent();
			}
			if (agent === S.current) setHeader();
			updateTitle();
			renderAttention();
			return;
		}
		if (ev.type === "gone") {
			S.agents.delete(agent);
			S.prompts.delete(agent);
			if (agent === S.current) {
				toast("That pi session stopped sharing", "warning");
				S.current = pickAgent();
				loadCurrent();
			}
			updateTitle();
			return;
		}
		if (ev.type === "prompt" || ev.type === "prompt_end") {
			const map = S.prompts.get(agent) || new Map();
			S.prompts.set(agent, map);
			if (ev.type === "prompt") {
				map.set(ev.prompt.id, ev.prompt);
				navigator.vibrate?.(200);
			} else map.delete(ev.id);
			if (agent === S.current) {
				renderPrompts(ev.type === "prompt_end" ? ev : undefined);
				setHeader();
			}
			updateTitle();
			renderAttention();
			return;
		}
		if (agent !== S.current || !S.view) {
			if (ev.type === "notice" && ev.level !== "info") toast(`${agentName(agent)}: ${ev.text}`, ev.level);
			return;
		}
		if (S.view.loading) {
			S.view.pending.push(ev);
			return;
		}
		if (ev.n !== undefined && ev.n <= S.view.n) return;
		applyAgentEvent(ev);
	}

	function applyAgentEvent(ev) {
		const view = S.view;
		const stick = nearBottom();
		switch (ev.type) {
			case "reset":
				loadCurrent();
				return;
			case "notice":
				toast(ev.text, ev.level);
				return;
			case "stream_start":
				showEmpty("");
				view.stream = { key: ev.key, blocks: [] };
				renderStream();
				break;
			case "stream": {
				if (!view.stream || view.stream.key !== ev.key) view.stream = { key: ev.key, blocks: [] };
				const b = (view.stream.blocks[ev.i] ||= { t: ev.kind, text: "", name: ev.name });
				b.text += ev.delta;
				if (ev.name) b.name = ev.name;
				scheduleStreamRender();
				break;
			}
			case "item": {
				showEmpty("");
				const el = renderItem(ev.item);
				const old = ev.replaces && document.getElementById(`i-${ev.replaces}`);
				if (old) old.replaceWith(el);
				else if (ev.item.k === "tool" && attachToolResult(ev.item)) {
					/* merged into its call card */
				} else $("transcript").appendChild(el);
				if (ev.replaces && view.stream && view.stream.key === ev.replaces) view.stream = null;
				if (ev.item.k === "assistant") linkToolResults();
				break;
			}
			case "tool_start":
				toolStart(ev.id, ev.name, ev.title, "");
				break;
			case "tool_update":
				toolUpdate(ev.id, ev.output);
				break;
			case "tool_end":
				toolEnd(ev.id, ev.isError);
				break;
		}
		refreshWork();
		if (stick) scrollToBottom();
		else $("jumpBtn").hidden = false;
	}

	/** What pi is doing right now, in one word, for the work bar: the running step, else writing or thinking. */
	function phase() {
		const run = document.querySelector("#liveTools .tstate.run, #transcript .tstate.run")?.closest(".tool")?.querySelector(".tname");
		if (run) return run.dataset.doing || "Working";
		const blocks = S.view?.stream?.blocks.filter(Boolean) ?? [];
		return blocks.at(-1)?.t === "text" ? "Writing" : "Thinking";
	}
	function refreshWork() {
		const info = S.agents.get(S.current);
		if (info && !$("workBar").hidden) $("workText").textContent = workLine(info);
	}

	// ── rendering ──────────────────────────────────────────────────────────────────
	function esc(s) {
		return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	}
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}
	/** An icon from the sprite in index.html. */
	function icon(name, cls = "") {
		const NS = "http://www.w3.org/2000/svg";
		const s = document.createElementNS(NS, "svg");
		s.setAttribute("class", `i ${cls}`.trim());
		s.setAttribute("aria-hidden", "true");
		const u = document.createElementNS(NS, "use");
		u.setAttribute("href", `#i-${name}`);
		s.appendChild(u);
		return s;
	}
	/** Scrollable regions must be reachable by keyboard. */
	function scrollBox(node) {
		node.tabIndex = 0;
		return node;
	}
	function iconHTML(name, cls = "") {
		return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
	}
	function elapsed(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const ss = String(s % 60).padStart(2, "0");
		return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
	}

	function renderItem(item) {
		let node;
		switch (item.k) {
			case "user": {
				node = el("div", "msg user");
				node.textContent = item.text;
				if (item.images) {
					const strip = thumbs({ id: item.id, ts: item.ts }, item.images);
					if (item.text) strip.classList.add("after-text");
					node.appendChild(strip);
				}
				break;
			}
			case "assistant":
				node = el("div", "msg assistant");
				for (const b of item.blocks) node.appendChild(renderBlock(b));
				if (item.error && item.stop !== "aborted") {
					const e = el("div", "err-line");
					e.append(icon("alert", "md"), el("span", "", item.error));
					node.appendChild(e);
				} else if (item.stop === "aborted") {
					const e = el("div", "err-line stopped");
					e.append(icon("stop", "md"), el("span", "", "Stopped"));
					node.appendChild(e);
				}
				break;
			case "tool":
				node = toolCard(item.id, item.name, "", "");
				fillToolResult(node, item);
				break;
			case "bash": {
				node = el("details", "tool msg");
				const s = el("summary");
				const ti = el("span", "ticon");
				ti.appendChild(icon("terminal"));
				const st = el("span", "tstate");
				s.append(ti, el("span", "tname", item.excluded ? "You ran (not sent to pi)" : "You ran"), el("span", "ttitle", item.command), st);
				const body = el("div", "tbody");
				body.appendChild(scrollBox(el("pre", "out", item.output || "(no output)")));
				node.append(s, body);
				setState(node, item.exitCode === 0 ? "ok" : "err");
				break;
			}
			case "custom":
				node = customNode(item);
				break;
			case "summary":
				node = el("details", "msg summary");
				{
					const s = el("summary", "tag");
					s.append(icon("compact", "sm"), item.kind === "compaction" ? "Context compacted · summary" : "Branch summary");
					node.append(s, mdNode(item.text));
				}
				break;
			default:
				node = el("div");
		}
		node.id = `i-${item.id}`;
		return node;
	}

	/**
	 * An extension's message (pi-actors deliveries, notes from other extensions): collapsed like pi's
	 * terminal shows it (its source, then the start of the text, two lines at most), expanded on tap.
	 * A message that fits on one short line has nothing to hide and stays plain.
	 */
	function customNode(item) {
		const text = String(item.text || "").trim();
		if (!text.includes("\n") && text.length <= 120) {
			const node = el("div", "msg custom");
			node.append(el("div", "tag", item.customType), mdNode(text));
			return node;
		}
		const node = el("details", "msg custom");
		const s = el("summary");
		const tag = el("span", "tag");
		tag.append(el("span", "grow", item.customType), icon("chev-down", "chev"));
		// The start of the text, as plain words: no Markdown markers, lines run together.
		const preview = text
			.split("\n")
			.map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+|```\S*)/, "").replace(/[*_`]/g, "").trim())
			.filter(Boolean)
			.join(" ")
			.slice(0, 400);
		s.append(tag, el("span", "preview", preview));
		node.append(s, mdNode(text));
		return node;
	}

	function renderBlock(b) {
		if (b.t === "text") return mdNode(b.text);
		if (b.t === "thinking") return thinkingNode(b.text, false);
		return toolCard(b.id, b.name, b.title, b.args);
	}

	function thinkingNode(text, live) {
		const d = el("details", "thinking");
		const s = el("summary");
		s.append(icon("sparkle", "sm"), el("span", "", live ? "Thinking" : "Thought"), icon("chev-right", "chev"));
		d.appendChild(s);
		if (text) d.appendChild(mdNode(text));
		return d;
	}

	// How a tool call reads in the transcript: an icon and a verb (present while it runs), then its target.
	const TOOL_LOOK = [
		[/^read$/, "file", "Read", "Reading"],
		[/^(write)$/, "pencil", "Wrote", "Writing"],
		[/edit|patch/, "pencil", "Edited", "Editing"],
		[/^(bash|shell|exec|powershell)$/, "terminal", "Ran", "Running"],
		[/^ls$/, "folder", "Listed", "Listing"],
		[/grep|find|glob|search/, "search", "Searched", "Searching"],
		[/web|fetch|url|browse/, "globe", "Fetched", "Fetching"],
	];
	function toolLook(name) {
		const hit = TOOL_LOOK.find(([re]) => re.test(name || ""));
		if (hit) return { icon: hit[1], verb: hit[2], doing: hit[3], known: true };
		const pretty = String(name || "tool").replace(/^mcp__/, "").replace(/[_-]+/g, " ");
		const verb = pretty.charAt(0).toUpperCase() + pretty.slice(1);
		return { icon: "bolt", verb, doing: verb, known: false };
	}
	function setState(card, state) {
		const st = card.querySelector(".tstate");
		st.className = `tstate ${state}`;
		st.replaceChildren();
		if (state === "ok") st.appendChild(icon("check"));
		else if (state === "err") st.appendChild(icon("x"));
		st.setAttribute("aria-label", state === "run" ? "running" : state === "err" ? "failed" : state === "ok" ? "done" : "");
		card.classList.toggle("running", state === "run");
		card.classList.toggle("err", state === "err");
		const name = card.querySelector(".tname");
		if (name?.dataset.doing) {
			name.textContent = state === "run" ? name.dataset.doing : name.dataset.done;
		}
	}
	function stateOf(card) {
		const c = card.querySelector(".tstate")?.classList;
		return c?.contains("run") ? "run" : c?.contains("err") ? "err" : c?.contains("ok") ? "ok" : "";
	}

	function toolCard(id, name, title, args) {
		const existing = id && document.getElementById(`t-${id}`);
		if (existing && !existing.closest("#transcript")) existing.remove();
		const d = el("details", "tool");
		d.id = `t-${id}`;
		const look = toolLook(name);
		const s = el("summary");
		const ti = el("span", "ticon");
		ti.appendChild(icon(look.icon));
		const tname = el("span", "tname", look.verb);
		tname.dataset.done = look.verb;
		tname.dataset.doing = look.doing;
		s.append(ti, tname, el("span", "ttitle", title || ""), el("span", "tstate"));
		const body = el("div", "tbody");
		// Known tools say everything in their title; show raw arguments only for the others.
		if (args && !(look.known && title)) {
			const more = el("details", "args");
			more.append(el("summary", "", "Arguments"), scrollBox(el("pre", "out", args)));
			body.appendChild(more);
		}
		d.append(s, body);
		return d;
	}

	function fillToolResult(card, item) {
		setState(card, item.isError ? "err" : "ok");
		const body = card.querySelector(".tbody");
		body.querySelectorAll(".result").forEach((n) => n.remove());
		const box = el("div", "result");
		if (item.diff) {
			box.appendChild(el("div", "label", "Changes"));
			box.appendChild(diffNode(item.diff));
		} else {
			box.appendChild(el("div", "label", item.isError ? "Error" : "Output"));
			box.appendChild(scrollBox(el("pre", "out", item.output || "(no output)")));
			if (item.truncated) {
				const more = el("button", "more", "Show full output");
				more.onclick = async () => {
					more.disabled = true;
					try {
						const r = await call("toolOutput", { id: item.id });
						box.querySelector("pre").textContent = r.output;
						more.remove();
					} catch (e) {
						toast(e.message, "error");
						more.disabled = false;
					}
				};
				box.appendChild(more);
			}
		}
		if (item.images) box.appendChild(thumbs({ id: item.id }, item.images));
		body.appendChild(box);
		if (item.isError) card.open = true;
	}

	// ── images in the transcript ───────────────────────────────────────────────────
	// Transcript items carry only an image count; the phone fetches each image when it is shown.
	const images = new Map();
	function loadImage(ref) {
		const key = `${ref.agent}|${ref.id}|${ref.ts ?? ""}|${ref.i}`;
		if (!images.has(key)) {
			const p = call("image", { id: ref.id, ts: ref.ts, i: ref.i }, ref.agent).then((r) => {
				if (!/^image\/[\w.+-]+$/.test(r?.mimeType || "") || typeof r.data !== "string") throw new Error("not an image");
				return `data:${r.mimeType};base64,${r.data}`;
			});
			p.catch(() => images.delete(key));
			images.set(key, p);
		}
		return images.get(key);
	}

	function thumbs(ref, count) {
		const strip = el("div", count === 1 ? "thumbs one" : "thumbs");
		const at = { ...ref, agent: S.current };
		for (let i = 0; i < count; i++) {
			const b = el("button", "thumb");
			b.type = "button";
			b.setAttribute("aria-label", count === 1 ? "Open image" : `Open image ${i + 1} of ${count}`);
			b.appendChild(icon("image"));
			loadImage({ ...at, i }).then(
				(src) => {
					const img = el("img");
					img.alt = "";
					img.src = src;
					// A single image takes its own shape once decoded; keep the transcript pinned to the bottom.
					img.decode().then(
						() => {
							const stick = b.isConnected && nearBottom();
							b.replaceChildren(img);
							if (stick) scrollToBottom();
						},
						() => b.classList.add("missing"),
					);
				},
				() => b.classList.add("missing"),
			);
			b.onclick = () => openViewer(at, i, count);
			strip.appendChild(b);
		}
		return strip;
	}

	let viewer = null;
	function openViewer(ref, index, count) {
		closeViewer();
		const v = el("div", "viewer");
		v.setAttribute("role", "dialog");
		v.setAttribute("aria-modal", "true");
		const stage = el("div", "viewer-stage");
		const img = el("img");
		img.alt = "";
		const note = el("p", "viewer-note");
		stage.append(img, note);
		const btn = (cls, name, label, onclick) => {
			const b = el("button", `viewer-btn ${cls}`);
			b.type = "button";
			b.setAttribute("aria-label", label);
			b.appendChild(icon(name));
			b.onclick = (e) => {
				e.stopPropagation();
				onclick();
			};
			return b;
		};
		const close = btn("close", "x", "Close", closeViewer);
		const prev = btn("prev", "chev-right", "Previous image", () => show(index - 1));
		const next = btn("next", "chev-right", "Next image", () => show(index + 1));
		const counter = el("div", "viewer-count");
		counter.setAttribute("aria-hidden", "true");
		const show = (i) => {
			index = (i + count) % count;
			v.classList.remove("zoomed");
			v.setAttribute("aria-label", count === 1 ? "Image" : `Image ${index + 1} of ${count}`);
			counter.textContent = `${index + 1} of ${count}`;
			img.removeAttribute("src");
			img.hidden = true;
			note.textContent = "Loading image…";
			note.hidden = false;
			const want = index;
			loadImage({ ...ref, i: index }).then(
				(src) => {
					if (want !== index || viewer?.node !== v) return;
					img.src = src;
					img.hidden = false;
					note.hidden = true;
				},
				(e) => {
					if (want === index) note.textContent = `Couldn't load the image: ${e.message}`;
				},
			);
		};
		// Tap the picture to see it at full size (scroll to pan); tap again to fit. Tap outside to close.
		img.onclick = (e) => {
			e.stopPropagation();
			v.classList.toggle("zoomed");
		};
		v.onclick = () => {
			if (!v.classList.contains("zoomed")) closeViewer();
		};
		// Swipe sideways for the next image, down to close; the picture follows the finger.
		let touch = null;
		const drag = (dx, dy) => {
			img.style.transform = dx || dy ? `translate(${dx}px, ${Math.max(0, dy)}px)` : "";
			v.style.setProperty("--pull", String(Math.min(1, Math.max(0, dy) / 300)));
		};
		v.addEventListener("touchstart", (e) => {
			touch = e.touches.length === 1 && !v.classList.contains("zoomed") ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, dy: 0 } : null;
			if (touch) img.classList.add("dragging");
		}, { passive: true });
		v.addEventListener("touchmove", (e) => {
			if (!touch || e.touches.length !== 1) return;
			touch.dx = e.touches[0].clientX - touch.x;
			touch.dy = e.touches[0].clientY - touch.y;
			const sideways = Math.abs(touch.dx) > Math.abs(touch.dy);
			drag(sideways && count > 1 ? touch.dx : 0, sideways ? 0 : touch.dy);
		}, { passive: true });
		const release = () => {
			if (!touch) return;
			const { dx, dy } = touch;
			touch = null;
			img.classList.remove("dragging");
			drag(0, 0);
			if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && count > 1) show(index + (dx < 0 ? 1 : -1));
			else if (dy > 90 && dy > Math.abs(dx)) closeViewer();
		};
		v.addEventListener("touchend", release);
		v.addEventListener("touchcancel", release);
		v.append(stage, close);
		if (count > 1) v.append(counter, prev, next);
		viewer = { node: v, opener: document.activeElement, step: (d) => count > 1 && show(index + d) };
		document.body.appendChild(v);
		show(index);
		close.focus({ preventScroll: true });
	}
	function closeViewer() {
		if (!viewer) return;
		const { node, opener } = viewer;
		viewer = null;
		node.remove();
		opener?.focus?.({ preventScroll: true });
	}

	function attachToolResult(item) {
		const card = document.getElementById(`t-${item.id}`);
		if (!card || !card.closest("#transcript")) return false;
		fillToolResult(card, item);
		return true;
	}

	/** Moves standalone tool-result items into their call cards (snapshot renders them as separate items). */
	function linkToolResults() {
		for (const res of [...document.querySelectorAll("#transcript > .tool[id^='i-']")]) {
			const id = res.id.slice(2);
			const card = document.getElementById(`t-${id}`);
			if (!card || card === res || !card.closest("#transcript")) continue;
			setState(card, stateOf(res));
			const result = res.querySelector(".result");
			if (result) {
				card.querySelectorAll(".result").forEach((n) => n.remove());
				card.querySelector(".tbody").appendChild(result);
			}
			res.remove();
		}
	}

	function diffNode(text) {
		const pre = scrollBox(el("pre", "out diff"));
		for (const line of text.split("\n")) {
			const c = line[0];
			const span = el("span", c === "+" ? "a" : c === "-" ? "d" : c === "@" ? "h" : "", line || " ");
			if (!span.className) {
				pre.append(document.createTextNode(`${line}\n`));
				continue;
			}
			pre.appendChild(span);
		}
		return pre;
	}

	// Live tool state (between tool_start and the result item).
	function toolStart(id, name, title, output) {
		let card = document.getElementById(`t-${id}`);
		if (!card) {
			card = toolCard(id, name, title, "");
			$("liveTools").appendChild(card);
		}
		setState(card, "run");
		if (output) toolUpdate(id, output);
	}
	function toolUpdate(id, output) {
		const card = document.getElementById(`t-${id}`);
		if (!card) return;
		let live = card.querySelector(".live");
		if (!live) {
			live = scrollBox(el("pre", "out live"));
			card.querySelector(".tbody").appendChild(live);
			card.open = true;
		}
		live.textContent = output;
		live.scrollTop = live.scrollHeight;
	}
	function toolEnd(id, isError) {
		const card = document.getElementById(`t-${id}`);
		if (!card) return;
		setState(card, isError ? "err" : "ok");
		card.querySelector(".live")?.remove();
		card.open = isError;
		if (card.parentElement === $("liveTools")) $("transcript").appendChild(card);
	}

	let streamRaf = 0;
	function scheduleStreamRender() {
		if (streamRaf) return;
		streamRaf = setTimeout(() => {
			streamRaf = 0;
			const stick = nearBottom();
			renderStream();
			if (stick) scrollToBottom();
		}, 80);
	}
	function renderStream() {
		const s = S.view?.stream;
		if (!s) return;
		const node = el("div", "msg assistant");
		node.id = `i-${s.key}`;
		for (const [i, b] of s.blocks.entries()) {
			if (!b) continue;
			if (b.t === "text") node.appendChild(mdNode(b.text));
			else if (b.t === "thinking") node.appendChild(thinkingNode("", true));
			else {
				const card = toolCard(`stream-${s.key}-${i}`, b.name || "tool", "", b.text.slice(-1500));
				setState(card, "run");
				node.appendChild(card);
			}
		}
		const old = document.getElementById(node.id);
		if (old) {
			const openThinking = old.querySelector("details.thinking[open]");
			if (openThinking) node.querySelector("details.thinking")?.setAttribute("open", "");
			old.replaceWith(node);
		} else $("transcript").appendChild(node);
	}

	// Minimal, escape-first Markdown: fenced code, headings, lists, quotes, tables, inline code/bold/italic/links.
	function mdNode(text) {
		const div = el("div", "md");
		div.innerHTML = md(String(text || ""));
		for (const p of div.querySelectorAll("pre, table")) p.tabIndex = 0;
		return div;
	}
	function inline(s) {
		const codes = [];
		s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
		s = esc(s)
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
			.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
			.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
			.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
	}
	function md(src) {
		const out = [];
		const lines = src.replace(/\r\n/g, "\n").split("\n");
		let i = 0;
		let para = [];
		const flush = () => {
			if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
			para = [];
		};
		while (i < lines.length) {
			const line = lines[i];
			const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
			if (fence) {
				flush();
				const close = fence[1];
				const body = [];
				i++;
				while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
				i++;
				out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
				continue;
			}
			const h = /^(#{1,4})\s+(.*)$/.exec(line);
			if (h) {
				flush();
				out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
				i++;
				continue;
			}
			if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
				flush();
				out.push("<hr>");
				i++;
				continue;
			}
			if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
				flush();
				const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
				const head = row(line);
				i += 2;
				const rows = [];
				while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(row(lines[i++]));
				out.push(
					`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
						.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
						.join("")}</tbody></table>`,
				);
				continue;
			}
			const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
			if (list) {
				flush();
				const ordered = /\d/.test(list[1]);
				const items = [];
				while (i < lines.length) {
					const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
					if (m) items.push(m[2]);
					else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
					else break;
					i++;
				}
				const tag = ordered ? "ol" : "ul";
				out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
				continue;
			}
			if (/^\s*>/.test(line)) {
				flush();
				const q = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
				out.push(`<blockquote>${md(q.join("\n"))}</blockquote>`);
				continue;
			}
			if (!line.trim()) {
				flush();
				i++;
				continue;
			}
			para.push(line);
			i++;
		}
		flush();
		return out.join("");
	}

	// ── header, prompts, composer ──────────────────────────────────────────────────
	/** A session's name, with its computer when there are several ("api on hetzner-box"). */
	function sessionLabel(agent) {
		const name = agentName(agent);
		return several() && machineName(agent) ? `${name} on ${machineName(agent)}` : name;
	}

	/**
	 * Speech (realtime calls, speech, recognition, voices) runs where the credentials are: the
	 * session's own computer first, then any other online computer that can, through one of its sessions.
	 */
	async function speechCall(m, p, agent = S.current) {
		const home = fleet.machineOf(agent);
		const others = fleet.machines.filter((x) => x.id !== home && x.state === "online").map((x) => fleet.agentsOf(x.id)[0]).filter(Boolean);
		const tries = [agent, ...others].filter(Boolean);
		let last;
		for (const a of tries) {
			try {
				return await fleet.call(a, m, p || {});
			} catch (e) {
				last = e;
				// Only "this computer can't do speech" moves on; anything else is a real answer.
				if (!/unavailable|not set up|no speech|no recogni|api key|sign.?in/i.test(String(e?.message))) throw e;
			}
		}
		throw last || new Error("no computer can do speech");
	}

	function agentName(agent) {
		return S.agents.get(agent)?.name || "pi";
	}

	function shortPath(p) {
		const parts = String(p || "").split("/").filter(Boolean);
		return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p || "";
	}

	/** One line under the session name that says what is going on. */
	function statusLine(info) {
		const ask = [...(S.prompts.get(info.agent)?.values() || [])][0];
		if (ask) return { text: `Needs you · ${ask.title}`, cls: "waiting" };
		if (info.status === "waiting") return { text: "Needs you in the terminal", cls: "waiting" };
		if (info.status === "working") return { text: `Working${info.since ? ` · ${elapsed(Date.now() - info.since)}` : ""}${info.queued ? " · message queued" : ""}`, cls: "working" };
		const bits = [info.task || shortPath(info.cwd)];
		if (info.context?.percent != null) bits.push(`${Math.round(info.context.percent)}% context`);
		if (info.cost) bits.push(`$${info.cost.toFixed(2)}`);
		return { text: bits.filter(Boolean).join(" · "), cls: "" };
	}

	function workLine(info) {
		return `${phase()}${info.since ? ` · ${elapsed(Date.now() - info.since)}` : ""}${info.queued ? " · message queued" : ""}`;
	}

	function setHeader() {
		const info = S.agents.get(S.current);
		const dot = $("statusDot");
		$("menuBtn").hidden = !S.device;
		const others = sortedAgents().filter((a) => a.agent !== S.current && urgency(a) === 0).length;
		$("top").classList.toggle("bare", !S.device);
		if (!info) {
			$("sessionName").textContent = S.device ? (S.agents.size ? "Choose a session" : "pi mobile") : "pi mobile";
			const sub = $("sessionSub");
			sub.textContent = several() ? `${fleet.machines.length} computers` : S.device?.host || "";
			sub.className = "session-sub";
			dot.className = "dot gone";
			$("modelBtn").hidden = true;
			$("sessionBtn").setAttribute("aria-label", "Sessions");
			updateTitle();
			return;
		}
		$("sessionName").textContent = info.name;
		const line = statusLine(info);
		const sub = $("sessionSub");
		// With several computers, say which one this session runs on.
		const where = several() ? machineName(S.current) : "";
		sub.textContent = where ? `${where} · ${line.text}` : line.text;
		sub.className = `session-sub ${line.cls}`;
		dot.className = `dot ${line.cls === "waiting" ? "waiting" : info.status}`;
		$("sessionBtn").setAttribute("aria-label", `${info.name}${where ? ` on ${where}` : ""}: ${line.text}. Switch session${others ? `, ${others} other${others > 1 ? "s" : ""} need you` : ""}`);
		const mb = $("modelBtn");
		if (info.model) {
			mb.innerHTML = `<span class="label">${esc(shortModel(info.model.name || info.model.id))}</span>`;
			mb.setAttribute("aria-label", `Model ${info.model.name || info.model.id}${info.thinking ? `, thinking ${info.thinking}` : ""}. Change`);
			mb.hidden = false;
		} else mb.hidden = true;
		updateComposer();
		updateTitle();
	}

	function shortModel(name) {
		return String(name).replace(/\s*\(.*\)\s*$/, "").replace(/^Claude\s+/, "");
	}

	// Elapsed times tick while something runs.
	setInterval(() => {
		const info = S.agents.get(S.current);
		if (info?.status === "working") {
			const line = statusLine(info);
			$("sessionSub").textContent = line.text;
			$("workText").textContent = workLine(info);
		}
	}, 1000);

	function updateTitle() {
		let waiting = 0;
		for (const m of S.prompts.values()) waiting += m.size;
		const info = S.agents.get(S.current);
		document.title = `${waiting ? `(${waiting}) ` : ""}${info ? info.name : "pi mobile"}`;
	}

	const answered = new Map();
	function renderPrompts(endEv) {
		const box = $("prompts");
		const map = S.prompts.get(S.current) || new Map();
		if (endEv && answered.has(endEv.id)) answered.delete(endEv.id);
		else if (endEv && endEv.by === "terminal") toast("Answered in the terminal");
		box.replaceChildren(...[...map.values()].map(promptNode));
		updateComposer();
	}

	function promptNode(p) {
		const card = el("div", "prompt");
		card.setAttribute("role", "group");
		card.setAttribute("aria-label", `pi asks: ${p.title}`);
		const eyebrow = el("div", "eyebrow");
		eyebrow.append(icon("alert"), "pi asks");
		card.append(eyebrow, el("div", "ptitle", p.title));
		if (p.message) card.appendChild(el("div", "pmsg", p.message));
		const answer = async (value, btn) => {
			card.querySelectorAll("button,input").forEach((b) => (b.disabled = true));
			answered.set(p.id, true);
			try {
				await call("answer", { id: p.id, value });
			} catch (e) {
				answered.delete(p.id);
				toast(e.message, "error");
				card.querySelectorAll("button,input").forEach((b) => (b.disabled = false));
			}
		};
		const act = el("div", "pact");
		if (p.kind === "confirm") {
			// Irreversible actions are red and say so, the same as in voice mode.
			const destructive = !!window.PiVoiceCore?.isDestructive?.(p);
			const yes = el("button", destructive ? "danger" : "primary", destructive ? "Yes, do it" : "Yes");
			const no = el("button", "", "No");
			yes.onclick = () => answer(true);
			no.onclick = () => answer(false);
			act.append(yes, no);
		} else if (p.kind === "select") {
			act.classList.add("col");
			for (const o of p.options || []) {
				const b = el("button");
				b.append(el("span", "", o), icon("chev-right"));
				b.onclick = () => answer(o);
				act.appendChild(b);
			}
			const cancel = el("button", "ghost", "Cancel");
			cancel.onclick = () => answer(undefined);
			act.appendChild(cancel);
		} else {
			const input = el("input");
			input.placeholder = p.placeholder || "";
			input.enterKeyHint = "send";
			card.appendChild(input);
			const ok = el("button", "primary", "Submit");
			const cancel = el("button", "", "Cancel");
			ok.onclick = () => answer(input.value);
			cancel.onclick = () => answer(undefined);
			input.onkeydown = (e) => {
				if (e.key === "Enter") ok.click();
			};
			act.append(ok, cancel);
		}
		card.appendChild(act);
		const foot = el("div", "pfoot");
		const footText = el("span", "", "Also open in the terminal · first answer wins");
		foot.append(icon("terminal"), footText);
		if (p.expiresAt) {
			const tick = () => {
				const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
				footText.textContent = `First answer wins · times out in ${s}s`;
				if (s > 0 && card.isConnected) setTimeout(tick, 1000);
			};
			tick();
		}
		card.appendChild(foot);
		return card;
	}

	function updateComposer() {
		const info = S.agents.get(S.current);
		$("composer").hidden = !S.device || !info;
		const working = info?.status === "working" && !(S.prompts.get(S.current)?.size > 0);
		$("workBar").hidden = !working;
		if (working) $("workText").textContent = workLine(info);
		$("modeSteer").setAttribute("aria-pressed", String(S.mode !== "followUp"));
		$("modeQueue").setAttribute("aria-pressed", String(S.mode === "followUp"));
		$("input").placeholder = working ? (S.mode === "followUp" ? "Queue a follow-up" : "Steer pi") : info ? `Message ${info.name}` : "Message pi";
		$("sendBtn").disabled = !S.online;
		updateSend();
	}

	/**
	 * The composer's last button: voice mode while there's nothing to send, Send once there is (text,
	 * an image, a draft), in the same spot, so the two never show together and each is the one primary.
	 */
	function updateSend() {
		const send = $("sendBtn");
		const voice = $("voiceBtn");
		const draft = !!window.PiDraft?.open();
		const something = draft || !!($("input").value.trim() || S.attachments.length);
		// While a draft is open in the composer, Send sends the draft (web/draft.js).
		send.classList.toggle("ready", draft ? window.PiDraft.canSend() : something);
		const had = document.activeElement;
		send.hidden = !something;
		voice.hidden = something || !S.device || !S.agents.get(S.current);
		// Keyboard focus follows the swap instead of falling back to the page.
		if (had === send && send.hidden) (voice.hidden ? $("input") : voice).focus({ preventScroll: true });
		else if (had === voice && voice.hidden) send.focus({ preventScroll: true });
	}

	/** After any change to the composer text, including dictation filling it in. */
	function autosize() {
		const t = $("input");
		t.style.height = "auto";
		t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
		updateSend();
	}

	async function send() {
		if (window.PiDraft?.open()) return window.PiDraft.send();
		const input = $("input");
		const text = input.value;
		if (!text.trim() && !S.attachments.length) return;
		if (!(await sendText(text, composerImages()))) return;
		input.value = "";
		clearAttachments();
		autosize();
		hideSuggest();
	}

	/** The images attached in the composer, as pi takes them (a draft sends them too). */
	const composerImages = () => S.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
	function clearAttachments() {
		S.attachments = [];
		renderAttachments();
		updateSend();
	}

	/** Sends a message to pi (the composer's text, or a draft); true once pi has it, else an error toast. */
	async function sendText(text, images = [], agent = S.current) {
		$("sendBtn").disabled = true;
		try {
			const r = await call("send", { text, images, mode: S.mode }, agent);
			if (r.delivered === "steer") toast("Steering message queued");
			else if (r.delivered === "followUp") toast("Follow-up queued");
			else if (r.delivered === "command") toast("Command sent");
			return true;
		} catch (e) {
			toast(e.message, "error");
			return false;
		} finally {
			$("sendBtn").disabled = !S.online;
		}
	}

	// ── attachments ────────────────────────────────────────────────────────────────
	async function addFiles(files) {
		for (const f of files) {
			if (!f.type.startsWith("image/")) continue;
			try {
				S.attachments.push(await downscale(f));
			} catch (e) {
				toast(`Could not read image: ${e.message}`, "error");
			}
		}
		renderAttachments();
	}

	function downscale(file, max = 1600) {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				const scale = Math.min(1, max / Math.max(img.width, img.height));
				const c = document.createElement("canvas");
				c.width = Math.round(img.width * scale);
				c.height = Math.round(img.height * scale);
				c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
				URL.revokeObjectURL(url);
				const dataUrl = c.toDataURL("image/jpeg", 0.85);
				resolve({ preview: dataUrl, data: dataUrl.split(",")[1], mimeType: "image/jpeg" });
			};
			img.onerror = () => reject(new Error("unsupported image"));
			img.src = url;
		});
	}

	function renderAttachments() {
		const box = $("attachments");
		box.replaceChildren(
			...S.attachments.map((a, i) => {
				const w = el("div", "att");
				const img = el("img");
				img.src = a.preview;
				img.alt = S.attachments.length > 1 ? `Attached image ${i + 1}` : "Attached image";
				// A 44 px target over the thumbnail's corner; the visible 24 px disc sits in its top-right.
				const x = el("button", "att-x");
				const face = el("span", "att-x-face");
				face.appendChild(icon("x"));
				x.appendChild(face);
				x.setAttribute("aria-label", S.attachments.length > 1 ? `Remove image ${i + 1}` : "Remove image");
				x.onclick = () => {
					S.attachments.splice(i, 1);
					renderAttachments();
				};
				w.append(img, x);
				return w;
			}),
		);
		box.hidden = !S.attachments.length;
		updateSend();
	}

	// ── slash command suggestions ──────────────────────────────────────────────────
	async function suggest() {
		const v = $("input").value;
		const m = /^\/(\S*)$/.exec(v);
		if (!m) return hideSuggest();
		if (!S.commands) {
			S.commands = [];
			try {
				S.commands = await call("commands");
			} catch {}
		}
		const q = m[1].toLowerCase();
		const hits = S.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 30);
		const box = $("suggest");
		if (!hits.length) return hideSuggest();
		box.replaceChildren(
			...hits.map((c) => {
				const b = el("button");
				b.setAttribute("role", "option");
				b.append(el("span", "cmd", `/${c.name}`), el("span", "desc", c.description));
				b.onclick = () => {
					$("input").value = `/${c.name} `;
					hideSuggest();
					$("input").focus();
				};
				return b;
			}),
		);
		box.hidden = false;
	}
	function hideSuggest() {
		$("suggest").hidden = true;
	}

	// ── sheets ─────────────────────────────────────────────────────────────────────
	let sheetOpener = null;
	/** Runs when the current sheet goes away (closed or replaced), e.g. to turn the camera off. */
	let sheetGone = null;
	function endSheet() {
		const f = sheetGone;
		sheetGone = null;
		f?.();
	}
	/** Bottom sheet. `head` gives it a title (and subtitle) with a close button. */
	function openSheet(build, head) {
		endSheet();
		const body = $("sheetBody");
		body.replaceChildren();
		if (head) {
			const h = el("div", "sheet-head");
			const g = el("div", "grow");
			const t = el("h2", "", head.title);
			t.id = "sheetTitle";
			t.tabIndex = -1;
			g.appendChild(t);
			if (head.subtitle) g.appendChild(el("div", "subtitle", head.subtitle));
			const x = el("button", "sheet-close");
			x.setAttribute("aria-label", "Close");
			x.appendChild(icon("x"));
			x.onclick = closeSheet;
			h.append(g, x);
			body.appendChild(h);
		}
		build(body);
		const panel = $("sheet").querySelector(".sheet-panel");
		if (head) panel.setAttribute("aria-labelledby", "sheetTitle");
		else panel.removeAttribute("aria-labelledby");
		if ($("sheet").hidden) sheetOpener = document.activeElement;
		$("sheet").hidden = false;
		panel.scrollTop = 0;
		// A sheet that opened by itself (an offer from another computer) starts at its title, so nothing
		// looks pre-selected; one you opened starts at its first control.
		const first = head?.unprompted ? $("sheetTitle") : panel.querySelector(".row, .btn, input, button:not(.sheet-close)") || panel.querySelector("button");
		first?.focus({ preventScroll: true });
	}
	function closeSheet() {
		if ($("sheet").hidden) return;
		endSheet();
		$("sheet").hidden = true;
		sheetOpener?.focus?.({ preventScroll: true });
		sheetOpener = null;
	}
	function group(parent) {
		const g = el("div", "group");
		parent.appendChild(g);
		return g;
	}
	function section(parent, text, count) {
		const s = el("div", "section", text);
		if (count) s.appendChild(el("span", "count", `· ${count}`));
		parent.appendChild(s);
	}
	/** A list row: leading icon, title, optional subtitle, trailing element. */
	function row(g, { lead, title, sub, extra, trail, cls = "", onclick, label }) {
		const r = el("button", `row ${cls}`.trim());
		if (lead) r.appendChild(typeof lead === "string" ? icon(lead) : lead);
		const t = el("span", "grow");
		t.appendChild(el("span", "title", title));
		if (sub) t.appendChild(el("span", "sub", sub));
		if (extra) t.appendChild(extra);
		r.appendChild(t);
		if (trail) r.appendChild(trail);
		if (label) r.setAttribute("aria-label", label);
		r.onclick = onclick;
		g.appendChild(r);
		return r;
	}

	function sessionsSheet() {
		const all = sortedAgents();
		openSheet(
			(body) => {
				if (!all.length) body.appendChild(el("p", "note", "No pi session is shared right now. Run /remote in pi on your computer."));
				const buckets = [
					["Needs you", all.filter((a) => urgency(a) === 0)],
					["Working", all.filter((a) => urgency(a) === 1)],
					["Idle", all.filter((a) => urgency(a) === 2)],
				];
				for (const [name, list] of buckets) {
					if (!list.length) continue;
					section(body, name, list.length);
					const g = group(body);
					for (const a of list) {
						const asks = [...(S.prompts.get(a.agent)?.values() || [])];
						let extra;
						if (asks.length) extra = el("span", "ask", asks[0].title);
						else if (a.status === "waiting") extra = el("span", "ask", "Waiting for input in the terminal");
						else if (a.last) extra = el("span", "last", a.last);
						const trail = el("span", "");
						trail.style.display = "contents";
						if (asks.length) trail.appendChild(el("span", "badge", String(asks.length)));
						trail.appendChild(a.agent === S.current ? icon("check", "check") : icon("chev-right", "trail"));
						const where = several() ? machineName(a.agent) : "";
						row(g, {
							lead: el("span", `lead dot ${a.status}`),
							title: a.name,
							sub: [where, a.task || shortPath(a.cwd)].filter(Boolean).join(" · "),
							extra,
							trail,
							cls: a.agent === S.current ? "current" : "",
							label: `${a.name}${where ? ` on ${where}` : ""}, ${name.toLowerCase()}${a.task ? `: ${a.task}` : ""}`,
							onclick: () => {
								closeSheet();
								openAgent(a.agent);
							},
						});
					}
				}
				// A computer that can't be reached says so, instead of its sessions silently vanishing.
				const away = fleet.machines.filter((m) => m.state !== "online" && m.state !== "connecting");
				if (away.length) {
					section(body, "Offline", away.length);
					const g = group(body);
					for (const m of away) row(g, { lead: el("span", "lead dot gone"), title: m.name || "Computer", sub: awayLine(m), cls: "plain", onclick: () => machineSheet(m.id) });
				}
				if (all.some((a) => a.herdr)) {
					const add = el("button", "btn");
					add.append(icon("plus"), "New session");
					add.onclick = () => newSessionSheet();
					body.appendChild(add);
				}
			},
			{ title: "Sessions", subtitle: several() ? `On ${fleet.machines.length} computers` : `On ${S.device?.host || "your computer"}` },
		);
	}

	/** Starts pi in a herdr tab on a computer: pick it (if several run herdr), a folder, and maybe a first prompt. */
	function newSessionSheet(machineId) {
		// One session per computer that runs herdr carries the request there.
		const starters = new Map();
		for (const a of S.agents.values()) if (a.herdr && !starters.has(fleet.machineOf(a.agent))) starters.set(fleet.machineOf(a.agent), a.agent);
		const target = machineId && starters.has(machineId) ? machineId : starters.has(fleet.machineOf(S.current)) ? fleet.machineOf(S.current) : [...starters.keys()][0];
		const starter = starters.get(target);
		const folders = [...new Set([...S.agents.values()].filter((a) => fleet.machineOf(a.agent) === target).map((a) => a.cwd))].sort();
		const where = fleet.get(target)?.name || "your computer";
		openSheet((body) => {
			if (starters.size > 1) {
				section(body, "Computer");
				const seg = el("div", "seg wide");
				seg.setAttribute("role", "group");
				seg.setAttribute("aria-label", "Computer");
				if (starters.size > 2) seg.style.gridTemplateColumns = `repeat(${starters.size}, 1fr)`;
				for (const id of starters.keys()) {
					const b = el("button", "", fleet.get(id)?.name || "Computer");
					b.setAttribute("aria-pressed", String(id === target));
					b.onclick = () => id !== target && newSessionSheet(id);
					seg.appendChild(b);
				}
				body.appendChild(seg);
			}
			const folder = el("input");
			folder.value = (fleet.machineOf(S.current) === target && S.agents.get(S.current)?.cwd) || folders[0] || "";
			folder.placeholder = "/path/to/project";
			folder.setAttribute("list", "folders");
			const list = el("datalist");
			list.id = "folders";
			for (const f of folders) {
				const o = el("option");
				o.value = f;
				list.appendChild(o);
			}
			const prompt = el("textarea");
			prompt.rows = 3;
			prompt.placeholder = "What should pi do? (optional)";
			const go = el("button", "btn primary", "Start pi");
			go.onclick = async () => {
				go.disabled = true;
				const spawnId = Math.random().toString(36).slice(2, 10);
				try {
					S.spawning = spawnId;
					await call("spawn", { cwd: folder.value.trim(), prompt: prompt.value, spawnId }, starter);
					closeSheet();
					toast("Starting pi…");
				} catch (e) {
					S.spawning = null;
					go.disabled = false;
					toast(e.message, "error");
				}
			};
			const f1 = el("label", "field");
			f1.append(el("span", "", "Folder"), folder, list);
			const f2 = el("label", "field");
			f2.append(el("span", "", "First prompt"), prompt);
			body.append(f1, f2, go);
		}, { title: "New session", subtitle: `Starts pi in a new herdr tab on ${where}` });
	}

	async function modelSheet() {
		openSheet((body) => body.appendChild(el("p", "note", "Loading models…")), { title: "Model" });
		try {
			S.models = await call("models");
		} catch (e) {
			closeSheet();
			return toast(e.message, "error");
		}
		const m = S.models;
		const info = S.agents.get(S.current);
		openSheet((body) => {
			if (info?.model?.reasoning) {
				section(body, "Thinking");
				const lv = el("div", "chips");
				lv.setAttribute("role", "group");
				lv.setAttribute("aria-label", "Thinking level");
				for (const l of m.levels) {
					const b = el("button", "", l);
					b.setAttribute("aria-pressed", String(l === m.thinking));
					b.onclick = async () => {
						try {
							await call("setThinking", { level: l });
							closeSheet();
						} catch (e) {
							toast(e.message, "error");
						}
					};
					lv.appendChild(b);
				}
				body.appendChild(lv);
			}
			section(body, "Model");
			const g = group(body);
			for (const x of m.models) {
				const active = m.current && x.provider === m.current.provider && x.id === m.current.id;
				row(g, {
					title: x.name,
					sub: `${x.provider} · ${x.id}`,
					cls: `plain${active ? " current" : ""}`,
					trail: active ? icon("check", "check") : undefined,
					label: `${x.name}${active ? ", current" : ""}`,
					onclick: async () => {
						try {
							await call("setModel", { provider: x.provider, id: x.id });
							closeSheet();
							toast(`Switched to ${x.name}`);
						} catch (e) {
							toast(e.message, "error");
						}
					},
				});
			}
		}, { title: "Model", subtitle: info?.name });
	}

	function menuSheet() {
		openSheet((body) => {
			let g;
			const add = (label, fn, cls = "", lead = "chev-right", sub) => row(g, { lead, title: label, sub, cls, onclick: fn });
			const info = S.agents.get(S.current);
			section(body, info ? `Session · ${info.name}` : "Session");
			g = group(body);
			// Narrow screens hide the header's model chip (app.css), so the menu offers it.
			if (info?.model && getComputedStyle($("modelBtn")).display === "none")
				add("Model", modelSheet, "", "chip", `${shortModel(info.model.name || info.model.id)}${info.thinking ? ` · thinking ${info.thinking}` : ""}`);
			if (S.current) {
				add("Compact context", async () => {
					closeSheet();
					try {
						await call("compact", {});
						toast("Compacting…");
					} catch (e) {
						toast(e.message, "error");
					}
				}, "", "compact", "Summarise older messages to free context");
			}
			add(
				"Reload transcript",
				() => {
					closeSheet();
					loadCurrent();
				},
				"",
				"refresh",
			);
			section(body, "Notifications");
			if (window.PiNative) {
				// The app's own notifications (APNs, native/ios/BRIDGE.md `push.*`): the permission is asked on this tap.
				g = group(body);
				const n = S.push.native;
				if (n?.available === false) body.appendChild(el("p", "note", "Notifications aren't available in this build of the app."));
				else if (n?.on) add("Turn off notifications", () => setNativePush(false), "", "bell", "You get one when pi finishes or asks");
				else add("Turn on notifications", () => setNativePush(true), "", "bell", n?.permission === "denied" ? `Allow them for pi in ${window.PiNative.platform === "android" ? "Android" : "iPhone"} Settings first` : "When pi finishes or needs you");
				if (n?.available !== false) notifyLines(body);
			} else if (!pushSupported()) {
				body.appendChild(el("p", "note", "On iPhone, add this page to your Home Screen (Share → Add to Home Screen) and open pi from there to get lock-screen notifications."));
			} else {
				g = group(body);
				if (pushOn()) add("Turn off notifications", () => setPush(false), "", "bell", "You get one when pi finishes or asks");
				else add("Turn on notifications", () => setPush(true), "", "bell", Notification.permission === "denied" ? "Allow notifications for this site in the browser settings first" : "When pi finishes or needs you");
				notifyLines(body);
			}
			if (window.PiVoice?.sheet) {
				section(body, "Voice");
				g = group(body);
				// The same as the composer's voice button, for when there's text in the composer.
				if (S.agents.get(S.current))
					add(
						"Voice mode",
						() => {
							closeSheet();
							$("voiceBtn").click();
						},
						"",
						"wave",
						`Talk with ${agentName(S.current)} hands-free`,
					);
				const p = window.PiVoice.persona();
				add(p ? p.name : "Choose a voice", window.PiVoice.sheet, "", "voice", p ? `${p.blurb} · how pi sounds in voice mode` : "How pi sounds in voice mode");
			}
			if (window.PiNative?.consent) {
				// The app's OK to send your voice (native/ios/BRIDGE.md `consent.*`); the app asks for it itself.
				if (!window.PiVoice?.sheet) {
					section(body, "Voice");
					g = group(body);
				}
				if (S.consent) add("Stop sharing my voice", revokeConsent, "danger", "voice", "Voice goes to OpenAI and your computer; pi asks again next time");
				else body.appendChild(el("p", "note", "pi asks before voice mode or dictation sends your voice anywhere."));
			}
			section(body, "Computers");
			g = group(body);
			for (const m of fleet.machines) {
				const on = m.state === "online";
				row(g, {
					lead: el("span", `lead dot ${on ? "idle" : "gone"}`),
					title: m.name || "Computer",
					sub: on ? `${fleet.agentsOf(m.id).length} session${fleet.agentsOf(m.id).length === 1 ? "" : "s"}` : awayLine(m),
					trail: icon("chev-right", "trail"),
					onclick: () => machineSheet(m.id),
				});
			}
			add("Add a computer", addComputerSheet, "", "plus", "Or run /remote add <host> in pi");
			section(body, several() ? `Devices on ${S.device?.host || "this computer"}` : "Devices");
			g = group(body);
			add("Pair another device", pairSheet, "", "qr");
			add("Manage devices", devicesSheet, "", "phone");
			add(
				"Unpair this device",
				async () => {
					closeSheet();
					try {
						await rpc("revoke", { ids: [S.device.d] });
					} catch {}
					unpaired("You unpaired this device");
				},
				"danger",
				"logout",
			);
			const note = el("p", "note");
			note.append(icon("lock"), "End-to-end encrypted");
			body.appendChild(note);
		}, { title: "pi mobile", subtitle: several() ? `Connected to ${fleet.machines.length} computers` : `Connected to ${S.device?.host || "your computer"}` });
	}

	async function pairSheet() {
		try {
			const r = await rpc("pair", {});
			// Only a secure link: the page's own origin first, else any https one, never a plain-http loopback fallback.
			const secure = r.links.filter((l) => l.url.startsWith("https://"));
			const here = secure.find((l) => l.url.startsWith(`${location.origin}/`)) || secure[0];
			if (!here) return toast("This computer has no secure address yet. Run /remote on it to set one up.", "error");
			openSheet(
				(body) => {
					body.appendChild(el("p", "note", "Single use, valid for 10 minutes. Whoever opens it gets full control of your pi sessions, so send it only to your own devices."));
					body.appendChild(el("div", "linkbox", here.url));
					if (navigator.share) {
						const b = el("button", "btn primary");
						b.append(icon("share"), "Share link");
						b.onclick = () => navigator.share({ url: here.url }).catch(() => {});
						body.appendChild(b);
					}
					if (navigator.clipboard) {
						const b = el("button", "btn");
						b.append(icon("copy"), "Copy link");
						b.onclick = () => navigator.clipboard.writeText(here.url).then(() => toast("Link copied"));
						body.appendChild(b);
					}
				},
				{ title: "Pair another device" },
			);
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function devicesSheet() {
		try {
			const list = await rpc("devices");
			openSheet(
				(body) => {
					const g = group(body);
					for (const d of list) {
						const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never";
						const trail = el("span", "ask", "Revoke");
						trail.style.color = "var(--err)";
						row(g, {
							lead: "phone",
							title: `${d.name}${d.id === S.device.d ? " · this device" : ""}`,
							sub: `Last seen ${seen}`,
							trail,
							label: `Revoke ${d.name}`,
							onclick: async () => {
								if (!confirm(`Revoke ${d.name}? It loses access immediately.`)) return;
								await rpc("revoke", { ids: [d.id] }).catch((e) => toast(e.message, "error"));
								if (d.id === S.device.d) return unpaired("You revoked this device");
								devicesSheet();
							},
						});
					}
				},
				{ title: "Devices", subtitle: `Paired with ${S.device?.host || "your computer"}` },
			);
		} catch (e) {
			toast(e.message, "error");
		}
	}

	// ── several sessions ───────────────────────────────────────────────────────────
	function urgency(a) {
		return S.prompts.get(a.agent)?.size || a.status === "waiting" ? 0 : a.status === "working" ? 1 : 2;
	}
	function reachable(agent) {
		const id = fleet.machineOf(agent);
		return !id || fleet.state(id) === "online" || fleet.state(id) === "connecting";
	}
	function sortedAgents() {
		// A computer that can't be reached is one "Offline" row, not a list of sessions that won't answer.
		return [...S.agents.values()].filter((a) => reachable(a.agent)).sort((a, b) => urgency(a) - urgency(b));
	}

	/** A pill for other sessions that are waiting on you; tap to go there. */
	function renderAttention() {
		const others = sortedAgents().filter((a) => a.agent !== S.current && urgency(a) === 0);
		const pill = $("attention");
		$("onboard").classList.toggle("deferred", others.length > 0);
		if (!others.length) {
			pill.hidden = true;
			return;
		}
		const first = others[0];
		const ask = [...(S.prompts.get(first.agent)?.values() || [])][0];
		const what = ask ? `asks: ${ask.title}` : "needs you";
		const text = el("span", "grow");
		const b = el("b", "", first.name);
		const where = several() ? `${machineName(first.agent)} · ` : "";
		text.append(others.length > 1 ? `${others.length} sessions need you · ` : where, b, ` ${what}`);
		pill.replaceChildren(icon("alert"), text, icon("chev-right", "chev"));
		pill.setAttribute("aria-label", others.length === 1 ? `${first.name} ${what}. Open` : `${others.length} sessions need you. Show them`);
		pill.onclick = () => (others.length === 1 ? openAgent(first.agent) : sessionsSheet());
		pill.hidden = false;
	}

	/** Notifications reach this phone from at least one computer (never "on" with nothing registered). */
	function pushOn() {
		if (window.PiNative) return !!S.push.native?.on;
		return S.push.on && [...S.notifyOn.values()].some(Boolean);
	}

	/** Per computer: will it notify this phone, and if not, why (issue #4). */
	function notifyLines(body) {
		if (!fleet.machines.length) return;
		const native = window.PiNative ? S.push.native?.computers || [] : null;
		const on = window.PiNative ? !!S.push.native?.on || native.length > 0 : S.push.on;
		for (const m of fleet.machines) {
			const name = m.name || "Your computer";
			let line;
			if (!on) line = `${name} won't notify this phone: notifications are off.`;
			else if (native) {
				const c = native.find((x) => x.machine === m.id);
				line = c?.notify ? `${name} notifies this phone.` : `${name} won't notify this phone${c?.why ? `: it ${c.why}` : " yet"}.`;
			} else if (S.notifyOn.get(m.id)) line = `${name} notifies this phone.`;
			else line = `${name} won't notify this phone: ${m.state !== "online" ? "it isn't reachable right now" : S.notifyWhy.get(m.id) || "it doesn't have this phone's subscription yet"}.`;
			body.appendChild(el("p", "note notify-line", line));
		}
	}

	/** What the one-time offer should say, or null: only where notifications can work, or how to get there. */
	function onboardKind() {
		if (store.get("pi-mobile-onboarded") || !S.device) return null;
		if (window.PiNative) {
			const n = S.push.native;
			return n && n.available !== false && !n.on && n.permission !== "denied" ? "native" : null;
		}
		if (pushSupported()) return !pushOn() && Notification.permission !== "denied" ? "web" : null;
		// iPhone Safari offers Web Push only to Home Screen apps: lead the user there.
		return /iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone ? "homescreen" : null;
	}

	/** One-time offer, only where notifications can actually work (or the step that makes them work). */
	function maybeOnboard() {
		const box = $("onboard");
		const kind = onboardKind();
		box.hidden = !kind;
		if (!kind) return;
		const text = box.querySelector(".onboard-text");
		if (kind === "homescreen") text.replaceChildren(el("b", "", "Get notified on this iPhone"), el("span", "", "Add pi to your Home Screen first"));
		else text.replaceChildren(el("b", "", "Turn on notifications"), el("span", "", "When pi finishes or needs you"));
		$("onboardYes").onclick = () => {
			store.set("pi-mobile-onboarded", true);
			box.hidden = true;
			if (kind === "native") setNativePush(true);
			else if (kind === "web") setPush(true);
			else toast("In Safari tap Share → Add to Home Screen, open pi from there, then turn notifications on.");
		};
		$("onboardNo").onclick = () => {
			store.set("pi-mobile-onboarded", true);
			box.hidden = true;
		};
	}

	// ── lock-screen notifications ─────────────────────────────────────────────────
	function pushSupported() {
		return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	}

	/** The app's notification state; iOS Settings can change it any time (inside the app only). */
	function refreshNativePush() {
		if (!window.PiNative) return Promise.resolve();
		const consent = window.PiNative.consent
			? callNative({ type: "consent.status" })
					.then((s) => (S.consent = s?.granted === true))
					.catch(() => {})
			: null;
		return Promise.all([
			callNative({ type: "push.status" })
				.then((s) => {
					S.push.native = s;
					maybeOnboard();
				})
				.catch(() => {}),
			consent,
		]);
	}

	async function revokeConsent() {
		closeSheet();
		try {
			S.consent = (await callNative({ type: "consent.revoke" }))?.granted === true;
			toast("Voice sharing off. pi asks again before voice mode or dictation.");
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function setNativePush(on) {
		closeSheet();
		try {
			S.push.native = await callNative({ type: "push.enable", on });
			toast(on ? "Notifications on" : "Notifications off");
		} catch (e) {
			toast(`Notifications: ${e.message}`, "error");
			await refreshNativePush();
		}
	}

	async function setPush(on) {
		closeSheet();
		try {
			const reg = await navigator.serviceWorker.register("sw.js");
			await navigator.serviceWorker.ready;
			let sub = await reg.pushManager.getSubscription();
			if (on) {
				if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications are blocked for this site");
				sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(S.push.key) });
				S.push.key = b64u(new Uint8Array(sub.options.applicationServerKey));
				S.push.fromSub = true;
				const ok = await Promise.all(fleet.machines.map((m) => shareSubscription(m.id, sub)));
				// Never "on" with nothing registered: say which computer refused and why.
				if (!ok.some(Boolean)) {
					await sub.unsubscribe().catch(() => {});
					S.push.on = false;
					const why = fleet.machines.map((m) => `${m.name || "your computer"}: ${m.state !== "online" ? "not reachable" : S.notifyWhy.get(m.id) || "no answer"}`);
					throw new Error(`no computer accepted this phone (${why.join("; ")}). Try again when it is online.`);
				}
				S.push.on = true;
				const missed = ok.filter((x) => !x).length;
				toast(missed ? `Notifications on (${missed} computer${missed === 1 ? "" : "s"} not yet: see the menu)` : "Notifications on");
			} else {
				await Promise.all(fleet.machines.map((m) => fleet.rpc(m.id, "push", { subscription: null }).catch(() => {})));
				await sub?.unsubscribe();
				S.push.on = false;
				for (const m of fleet.machines) S.notifyOn.set(m.id, false);
				toast("Notifications off");
			}
		} catch (e) {
			toast(`Notifications: ${e.message}`, "error");
		}
	}

	/**
	 * Every machine sends its own notifications to this phone's one subscription, signing with the
	 * same key. A machine with a different key gets it from one that has the right one.
	 */
	async function shareSubscription(id, sub) {
		try {
			sub ||= await (await navigator.serviceWorker.ready).pushManager.getSubscription();
			if (!sub) return false;
			const hub = await fleet.rpc(id, "push", { subscription: sub.toJSON() });
			if (hub?.pushKey && S.push.key && hub.pushKey !== S.push.key) {
				const source = fleet.machines.find((m) => m.id !== id && m.state === "online" && S.pushKeys.get(m.id) === S.push.key);
				if (!source) {
					S.notifyWhy.set(id, "it signs notifications with another key; turn notifications off and on again");
					S.notifyOn.set(id, false);
					return false;
				}
				const vapid = await fleet.rpc(source.id, "vapid", {});
				await fleet.rpc(id, "push", { subscription: sub.toJSON(), vapid });
			}
			S.pushKeys.set(id, S.push.key);
			S.notifyOn.set(id, true);
			S.notifyWhy.delete(id);
			return true;
		} catch (e) {
			S.notifyOn.set(id, false);
			S.notifyWhy.set(id, e.message || "it refused the subscription");
			return false;
		}
	}

	/** Moves every machine to a new signing key, so a removed one can no longer notify this phone. */
	async function rotatePushKey() {
		if (!pushSupported() || !S.push.on) return;
		try {
			const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
			const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
			const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
			const vapid = { publicKey: b64u(raw), privateKey: jwk.d };
			const reg = await navigator.serviceWorker.ready;
			await (await reg.pushManager.getSubscription())?.unsubscribe();
			const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
			S.push.key = vapid.publicKey;
			S.push.fromSub = true;
			await Promise.all(
				fleet.machines.map((m) =>
					fleet
						.rpc(m.id, "push", { subscription: sub.toJSON(), vapid })
						.then(() => S.pushKeys.set(m.id, vapid.publicKey))
						.catch(() => {}),
				),
			);
		} catch {}
	}

	// ── computers ──────────────────────────────────────────────────────────────────
	function awayLine(m) {
		if (m.state === "revoked") return "Removed this phone";
		if (!m.lastSeen) return "Not reached yet";
		const t = new Date(m.lastSeen);
		const today = t.toDateString() === new Date().toDateString();
		return `Offline since ${today ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t.toLocaleDateString([], { month: "short", day: "numeric" })}`;
	}

	function forgetMachine(id) {
		for (const a of fleet.remove(id)) {
			S.agents.delete(a);
			S.prompts.delete(a);
		}
		if (!fleet.machines.length) return unpaired("You removed every computer");
		if (!S.agents.has(S.current)) {
			S.current = pickAgent();
			loadCurrent();
		} else setHeader();
		renderAttention();
		void rotatePushKey();
	}

	/** One computer: where it is, how it's doing, and Remove. */
	function machineSheet(id) {
		const m = fleet.machines.find((x) => x.id === id);
		if (!m) return;
		const sessions = fleet.agentsOf(id).map((a) => S.agents.get(a)).filter(Boolean);
		openSheet(
			(body) => {
				if (sessions.length) {
					section(body, "Sessions", sessions.length);
					const g = group(body);
					for (const a of sessions)
						row(g, {
							lead: el("span", `lead dot ${a.status}`),
							title: a.name,
							sub: statusLine(a).text,
							trail: icon("chev-right", "trail"),
							onclick: () => {
								closeSheet();
								openAgent(a.agent);
							},
						});
				}
				body.appendChild(el("div", "linkbox", m.primary ? location.origin : m.origin));
				if (m.primary) body.appendChild(el("p", "note", "This computer serves the app on this phone. To stop using it, unpair this device from the menu."));
				else {
					const b = el("button", "btn");
					b.append(icon("logout"), "Remove from this phone");
					b.style.color = "var(--err)";
					b.onclick = async () => {
						if (!confirm(`Remove ${m.name}? Its sessions leave your list and it can't reach this phone any more.`)) return;
						closeSheet();
						await fleet.rpc(id, "revoke", { ids: [m.d] }).catch(() => {});
						forgetMachine(id);
						toast(`${m.name} removed`);
					};
					body.appendChild(b);
				}
			},
			{ title: m.name || "Computer", subtitle: m.state === "online" ? "Online" : awayLine(m) },
		);
	}

	/** A computer offered by another of yours (`/remote add`): the phone decides. */
	function offerMachine(fromId, offer) {
		if (!offer?.id || S.offers.some((o) => o.offer.id === offer.id)) return;
		S.offers.push({ fromId, offer });
		if (S.offers.length === 1) showOffer();
	}
	/** "Add" on the offer's notification (Android): that tap was the consent, so add without asking again. */
	function acceptOffer(id) {
		S.accepted = id;
		if (S.offers[0]?.offer.id === id) showOffer(); // its sheet is open: finish it; otherwise it adds on its turn
	}
	function showOffer() {
		const next = S.offers[0];
		if (!next) return;
		const { fromId, offer } = next;
		const done = () => {
			fleet.rpc(fromId, "offerDone", { id: offer.id }).catch(() => {});
			S.offers.shift();
			closeSheet();
			if (S.offers.length) setTimeout(showOffer, 300);
		};
		const add = () => {
			fleet.add({ machine: offer.machine.id, name: offer.machine.name, origin: offer.origin, d: offer.d, k: offer.k });
			toast(`${offer.machine.name} added`);
			done();
		};
		if (S.accepted === offer.id) {
			S.accepted = undefined;
			return add();
		}
		let host = offer.origin;
		try {
			host = new URL(offer.origin).host;
		} catch {}
		openSheet(
			(body) => {
				body.appendChild(el("p", "note", `Its pi sessions join your list, next to the others. ${offer.from ? `You asked for this on ${offer.from}.` : ""}`.trim()));
				body.appendChild(el("div", "linkbox", host));
				const yes = el("button", "btn primary", "Add");
				yes.onclick = add;
				const no = el("button", "btn", "Not now");
				no.onclick = async () => {
					// Leave nothing behind there: this phone's key on that computer is revoked.
					await fleet.rpcTo({ origin: offer.origin, d: offer.d, k: offer.k }, "revoke", { ids: [offer.d] }).catch(() => {});
					done();
				};
				body.append(yes, no);
			},
			{ title: `Add ${offer.machine.name}?`, subtitle: offer.from ? `From ${offer.from}` : undefined, unprompted: true },
		);
	}

	/** Another of your computers says this one was removed (`/remote remove`). */
	async function machineRemovedElsewhere(fromId, offer) {
		const m = fleet.byMachine(offer?.machine?.id);
		if (m && !m.primary) {
			await fleet.rpc(m.id, "revoke", { ids: [m.d] }).catch(() => {});
			forgetMachine(m.id);
			toast(`${m.name} removed`);
		}
		fleet.rpc(fromId, "offerDone", { id: offer.id }).catch(() => {});
	}

	/**
	 * Adds a computer by its pairing link (from `/remote pair` there), when no computer of yours can add it.
	 * `link` comes from a scan: it is filled in and added at once, exactly as if pasted.
	 */
	function addComputerSheet(link) {
		openSheet(
			(body) => {
				body.appendChild(el("p", "note", "Easiest: in pi on a computer this phone already uses, run /remote add <host>. Otherwise run /remote pair on the new computer and scan its code or paste its link here."));
				if (canScan()) {
					const scan = el("button", "btn");
					scan.append(icon("qr"), "Scan QR code");
					scan.onclick = startScan;
					body.appendChild(scan);
				}
				const input = el("input");
				input.type = "url";
				input.placeholder = "https://….ts.net/#p=…";
				input.autocomplete = "off";
				const f = el("label", "field");
				f.append(el("span", "", "Pairing link"), input);
				const go = el("button", "btn primary", "Add computer");
				go.onclick = async () => {
					go.disabled = true;
					try {
						const name = await pairLink(input.value.trim());
						closeSheet();
						toast(`${name} added`);
					} catch (e) {
						toast(e.message, "error");
					} finally {
						go.disabled = false;
					}
				};
				body.append(f, go);
				if (navigator.clipboard?.readText) {
					const paste = el("button", "btn");
					paste.append(icon("copy"), "Paste");
					paste.onclick = async () => {
						try {
							input.value = (await navigator.clipboard.readText()).trim();
						} catch {}
					};
					body.insertBefore(paste, go);
				}
				if (typeof link === "string") {
					input.value = link;
					go.click();
				}
			},
			{ title: "Add a computer" },
		);
	}

	// ── scanning a pairing QR ──────────────────────────────────────────────────────
	// The iPhone app scans natively (VisionKit, bridge `scan`). A browser uses the camera, with
	// BarcodeDetector where it exists, else the vendored decoder `qr.js` (jsQR), loaded on first use.
	const canScan = () => !!window.PiNative?.scan || !!navigator.mediaDevices?.getUserMedia;

	async function startScan() {
		if (!window.PiNative?.scan) return scanSheet();
		try {
			const r = await callNative({ type: "scan" });
			if (r?.link) addComputerSheet(r.link);
		} catch (e) {
			if (e?.message !== "cancelled") toast(e?.message || "Couldn't scan", "error");
		}
	}

	const SCAN_STATES = {
		starting: { title: "Starting the camera…", spinner: true },
		denied: { icon: "lock", title: "Camera access is off", text: "Allow the camera for this site in your browser's settings, or paste the link instead." },
		none: { icon: "alert", title: "No camera found", text: "Paste the link that /remote pair shows instead." },
		failed: { icon: "alert", title: "The camera didn't start", text: "Another app may be using it. Try again, or paste the link instead." },
	};
	const SCAN_HINT = "Point the camera at the QR code that /remote pair shows on the new computer.";

	function scanSheet() {
		let stream = null;
		let alive = true;
		let timer = 0;
		openSheet(
			(body) => {
				const view = el("div", "scan-view");
				const video = el("video");
				video.muted = true;
				video.playsInline = true;
				video.setAttribute("playsinline", "");
				video.setAttribute("aria-hidden", "true");
				const frame = el("div", "scan-frame");
				frame.setAttribute("aria-hidden", "true");
				const over = el("div", "scan-state");
				view.append(video, frame, over);
				const hint = el("p", "scan-hint", SCAN_HINT);
				hint.setAttribute("role", "status");
				const paste = el("button", "btn");
				paste.append(icon("copy"), "Paste link instead");
				paste.onclick = () => {
					addComputerSheet();
					$("sheetBody").querySelector("input")?.focus();
				};
				const cancel = el("button", "btn", "Cancel");
				cancel.onclick = () => addComputerSheet();
				body.append(view, hint, paste, cancel);

				const show = (state) => {
					view.dataset.state = state;
					const s = SCAN_STATES[state];
					over.replaceChildren();
					hint.hidden = !!s && !s.spinner;
					// With no camera, pasting is the one thing left to do.
					paste.classList.toggle("primary", !!s && !s.spinner);
					if (!s) return;
					if (s.spinner) over.appendChild(el("span", "spinner"));
					else over.appendChild(icon(s.icon));
					over.appendChild(el("strong", "", s.title));
					if (s.text) over.appendChild(el("span", "", s.text));
					over.setAttribute("role", s.spinner ? "status" : "alert");
				};
				show("starting");

				(async () => {
					try {
						stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
					} catch (e) {
						if (alive) show(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "none" : "failed");
						return;
					}
					// Cancelled, closed or backgrounded while the camera was starting: turn it straight off.
					if (!alive) return stopStream(stream);
					// The camera can't help after all: turn it off and say so.
					const fail = () => {
						clearTimeout(timer);
						stopStream(stream);
						video.srcObject = null;
						if (alive) show("failed");
					};
					video.srcObject = stream;
					try {
						await video.play();
					} catch {
						return fail();
					}
					const read = await qrReader().catch(() => null);
					if (!alive) return;
					if (!read) return fail();
					show("live");
					let last = "";
					let errors = 0;
					const tick = async () => {
						if (!alive) return;
						let text = null;
						if (video.readyState >= 2)
							try {
								text = await read(video);
								errors = 0;
							} catch {
								// A decoder that keeps failing (about 5 s) won't recover.
								if (++errors >= 25) return fail();
							}
						if (!alive) return;
						if (text && PiFleet.pairingLink(text)) {
							return addComputerSheet(text.trim());
						}
						if (text && text !== last) {
							last = text;
							hint.textContent = "That code isn't from pi. Scan the one /remote pair shows.";
							view.dataset.wrong = "";
						}
						timer = setTimeout(tick, 200);
					};
					tick();
				})();
			},
			{ title: "Scan the code" },
		);
		// Leaving the app ends the scan: the camera never runs in the background.
		const hidden = () => document.visibilityState === "hidden" && addComputerSheet();
		document.addEventListener("visibilitychange", hidden);
		sheetGone = () => {
			alive = false;
			clearTimeout(timer);
			stopStream(stream);
			document.removeEventListener("visibilitychange", hidden);
		};
	}
	function stopStream(s) {
		for (const t of s?.getTracks?.() ?? []) t.stop();
	}

	/** A function reading the QR text in a video frame (or null): BarcodeDetector, else jsQR. */
	async function qrReader() {
		if ("BarcodeDetector" in window) {
			try {
				if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
					const d = new BarcodeDetector({ formats: ["qr_code"] });
					return async (video) => (await d.detect(video))[0]?.rawValue || null;
				}
			} catch {}
		}
		if (!window.jsQR)
			await new Promise((resolve, reject) => {
				const s = el("script");
				s.src = "qr.js";
				s.onload = resolve;
				s.onerror = reject;
				document.head.appendChild(s);
			});
		const canvas = el("canvas");
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		return async (video) => {
			const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
			const w = Math.round(video.videoWidth * scale);
			const h = Math.round(video.videoHeight * scale);
			if (!w || !h) return null;
			canvas.width = w;
			canvas.height = h;
			ctx.drawImage(video, 0, 0, w, h);
			return window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
		};
	}

	async function pairLink(text) {
		let url;
		try {
			url = new URL(text);
		} catch {
			throw new Error("That isn't a pairing link");
		}
		const m = /[#&]p=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(url.hash);
		if (!m) throw new Error("That link has no pairing code; run /remote pair on the computer");
		if (url.origin === location.origin) throw new Error("That's the computer this app runs on");
		if (url.protocol !== "https:") throw new Error("Only HTTPS addresses work here (for example its Tailscale address)");
		const key = unb64u(m[2]);
		let res;
		try {
			res = await fetch(`${url.origin}/api/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ p: m[1], b: seal(key, { t: Date.now(), name: deviceName() }) }),
			});
		} catch {
			throw new Error(`Couldn't reach ${url.host}. Is it on your tailnet, with pi running?`);
		}
		const body = await res.json();
		if (!res.ok || !body.b) throw new Error(body.error || `HTTP ${res.status}`);
		const out = open(key, body.b);
		fleet.add({ machine: out.machine?.id, name: out.host, origin: url.origin, d: out.d, k: out.k });
		return out.host;
	}

	function openAgent(agent) {
		if (!agent || agent === S.current) return;
		S.current = agent;
		store.set(AGENT_KEY, agent);
		if (S.agents.has(agent)) loadCurrent();
	}

	// ── misc ───────────────────────────────────────────────────────────────────────
	function toast(text, level = "info") {
		const t = el("div", `toast ${level}`);
		if (level !== "info") t.appendChild(icon(level === "error" ? "alert" : "alert"));
		t.appendChild(el("span", "", text));
		t.setAttribute("role", level === "error" ? "alert" : "status");
		$("toasts").appendChild(t);
		setTimeout(() => t.remove(), level === "error" ? 6000 : 3000);
	}
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	function nearBottom() {
		const s = $("scroller");
		return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
	}
	function scrollToBottom() {
		const s = $("scroller");
		s.scrollTop = s.scrollHeight;
		$("jumpBtn").hidden = true;
	}

	// ── wiring ─────────────────────────────────────────────────────────────────────
	function wire() {
		// The composer grows and shrinks (working bar, dictation, attachments); floating controls follow it.
		const composer = $("composer");
		new ResizeObserver(() => document.documentElement.style.setProperty("--composer-h", `${composer.offsetHeight || 0}px`)).observe(composer);
		$("sessionBtn").onclick = () => S.device && sessionsSheet();
		$("modelBtn").onclick = modelSheet;
		$("menuBtn").onclick = () => {
			if (!S.device) return;
			const before = JSON.stringify([S.push.native, S.consent]);
			menuSheet();
			// Redraw once if the permission changed in Settings since the last look (still the same sheet).
			const title = $("sheetTitle")?.textContent;
			refreshNativePush().then(() => {
				if (JSON.stringify([S.push.native, S.consent]) !== before && !$("sheet").hidden && $("sheetTitle")?.textContent === title) menuSheet();
			});
		};
		$("olderBtn").onclick = loadOlder;
		$("jumpBtn").onclick = () => scrollToBottom(true);
		$("scroller").addEventListener("scroll", () => {
			if (nearBottom()) $("jumpBtn").hidden = true;
		});
		$("sheet").addEventListener("click", (e) => {
			if (e.target.hasAttribute("data-close")) closeSheet();
		});
		$("sendBtn").onclick = send;
		$("stopBtn").onclick = async () => {
			try {
				await call("abort");
			} catch (e) {
				toast(e.message, "error");
			}
		};
		for (const [id, mode] of [
			["modeSteer", "steer"],
			["modeQueue", "followUp"],
		]) {
			$(id).onclick = () => {
				S.mode = mode;
				store.set(MODE_KEY, S.mode);
				updateComposer();
			};
		}
		document.addEventListener("keydown", (e) => {
			if (viewer) {
				if (e.key === "Escape") closeViewer();
				else if (e.key === "ArrowLeft") viewer.step(-1);
				else if (e.key === "ArrowRight") viewer.step(1);
				else if (e.key === "Tab") {
					const f = [...viewer.node.querySelectorAll("button")];
					const i = f.indexOf(document.activeElement);
					e.preventDefault();
					f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
				}
				return;
			}
			if (e.key === "Escape" && !$("sheet").hidden) closeSheet();
		});
		const input = $("input");
		input.addEventListener("input", () => {
			autosize();
			updateSend();
			suggest();
		});
		input.addEventListener("keydown", (e) => {
			// Enter sends on a hardware keyboard; on touch keyboards Enter inserts a newline.
			const touch = matchMedia("(pointer: coarse)").matches;
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (!touch || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				send();
			}
		});
		input.addEventListener("paste", (e) => {
			const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
			if (files.length) {
				e.preventDefault();
				addFiles(files);
			}
		});
		$("attachBtn").onclick = () => $("fileInput").click();
		$("fileInput").onchange = (e) => {
			addFiles([...e.target.files]);
			e.target.value = "";
		};
	}

	// ── the on-screen keyboard ─────────────────────────────────────────────────────
	// iOS doesn't shrink the layout viewport for the keyboard and keeps env(safe-area-inset-bottom) at 34 px
	// while it is up, so the composer's bottom padding left a gap above the keyboard (its accessory bar) and
	// the page scrolled the header away. While the keyboard is open the app takes the visible height and the
	// composer drops the inset (`html.kb`, `--kb`). Heights come from the iPhone app as the keyboard starts to
	// move (native/ios/BRIDGE.md `keyboard`), else from visualViewport (Safari, Home Screen app).
	let nativeKeyboard = false;
	function keyboard(height, ms = 0) {
		const open = height > 80;
		const root = document.documentElement;
		if (open === root.classList.contains("kb") && (!open || root.style.getPropertyValue("--kb") === `${Math.round(height)}px`)) return;
		root.style.setProperty("--kb", `${open ? Math.round(height) : 0}px`);
		root.style.setProperty("--kb-ms", `${Math.max(0, ms)}ms`);
		root.classList.toggle("kb", open);
		// iOS scrolled the page to show the field; the app now fits above the keyboard, so put it back.
		if (open) {
			requestAnimationFrame(() => window.scrollTo(0, 0));
			// WebKit may reveal the field again once the keyboard has settled.
			setTimeout(() => document.documentElement.classList.contains("kb") && window.scrollTo(0, 0), Math.max(0, ms) + 60);
		}
	}
	function watchKeyboard() {
		// Putting the keyboard away without the accessory bar's Done (the iPhone app hides that bar): a swipe down on
		// the transcript, as in Messages. The page fits above the keyboard and doesn't scroll as a whole, so the
		// web view's own swipe-to-dismiss never fires; the transcript's scroller does it instead.
		let startY = null;
		const scroller = $("scroller");
		scroller.addEventListener("touchstart", (e) => (startY = e.touches.length === 1 ? e.touches[0].clientY : null), { passive: true });
		scroller.addEventListener(
			"touchmove",
			(e) => {
				if (startY === null || !document.documentElement.classList.contains("kb")) return;
				if (e.touches[0].clientY - startY > 24) {
					startY = null;
					document.activeElement?.blur?.();
				}
			},
			{ passive: true },
		);
		const vv = window.visualViewport;
		if (!vv) return;
		const editing = () => document.activeElement?.matches?.("input, textarea, [contenteditable]") ?? false;
		const update = () => {
			if (nativeKeyboard) return;
			// Pinch zoom also shrinks the visual viewport: only a keyboard over a field counts.
			const covered = vv.scale > 1.01 || !editing() ? 0 : window.innerHeight - vv.height;
			keyboard(covered);
		};
		vv.addEventListener("resize", update);
		document.addEventListener("focusout", () => setTimeout(update, 50));
	}

	async function main() {
		wire();
		watchKeyboard();
		if (window.PiNative) {
			// A tapped notification: show that session (native/ios/BRIDGE.md `focus`).
			window.PiNative.focus = (machine, agent) => {
				closeSheet();
				openAgent(String(agent || ""));
			};
			// The keyboard's covered height, as it starts to move (BRIDGE.md `keyboard`).
			window.PiNative.keyboard = ({ height, duration } = {}) => {
				nativeKeyboard = true;
				keyboard(Number(height) || 0, Number(duration) || 0);
			};
			refreshNativePush();
		}
		// Opened from a notification: jump to that session.
		const query = new URLSearchParams(location.search);
		const fromPush = query.get("agent");
		if (fromPush) store.set(AGENT_KEY, fromPush);
		// "Add" on an offer's notification: accepted as soon as the offer arrives on the stream.
		if (query.get("accept")) S.accepted = query.get("accept");
		if (location.search) history.replaceState(null, "", location.pathname + location.hash);
		// The service worker keeps a copy of the app (it opens while this computer sleeps) and shows notifications.
		if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
		if (pushSupported()) {
			// The key this phone's subscription was made with is the one every machine must sign with.
			navigator.serviceWorker.ready
				.then((reg) => reg.pushManager.getSubscription())
				.then((sub) => {
					const k = sub?.options?.applicationServerKey;
					if (!k) return;
					S.push.key = b64u(new Uint8Array(k));
					S.push.fromSub = true;
					S.push.on = true;
				})
				.catch(() => {});
			navigator.serviceWorker.addEventListener("message", (e) => {
				if (e.data?.type === "open") openAgent(e.data.agent);
				else if (e.data?.type === "accept") acceptOffer(e.data.offer);
			});
		}
		const paired = await pairFromHash();
		if (paired === "failed") return;
		if (!S.device) return unpaired();
		showEmpty(`<span class="spinner" aria-hidden="true"></span><p>Connecting to ${esc(several() ? "your computers" : S.device.host || "your computer")}…</p>`);
		S.current = store.get(AGENT_KEY);
		setHeader();
		fleet.start();
	}

	// What voice.js needs from the app.
	window.PiMobile = {
		S,
		row,
		group,
		closeSheet,
		rpc,
		call,
		toast,
		agentName,
		sessionLabel,
		speechCall,
		machineLabel: (agent) => (several() ? machineName(agent) : ""),
		machineOf: (agent) => fleet.machineOf(agent),
		reachable,
		openAgent,
		autosize,
		updateSend,
		sendText,
		images: composerImages,
		clearAttachments,
		mdNode,
		openSheet,
		sessionsSheet,
		loadCurrent,
		statusLine,
		icon,
		input: () => $("input"),
	};

	main();
})();
