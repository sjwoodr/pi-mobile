# pi-mobile

Your [pi](https://github.com/earendil-works/pi) sessions, on your phone. Run `/remote` once, scan the QR code, and every pi session on your computer is in your pocket: follow the work live, answer pi's questions from the lock screen, steer it, or just talk to it when your hands are busy.

No server to install, no account, no third-party relay, no app store. It all runs inside pi, and everything between your phone and pi is end-to-end encrypted.

<p align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/img/04-transcript-dark.webp"><img src="docs/img/04-transcript-light.webp" width="250" alt="A pi session on the phone: tool steps as quiet rows, the reply in readable markdown, another session's question as a bar at the top"></picture>&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/img/08-confirm-dark.webp"><img src="docs/img/08-confirm-light.webp" width="250" alt="pi asks permission to change a file; large Yes and No buttons above the composer"></picture>&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/img/15-voice-dark.webp"><img src="docs/img/15-voice-light.webp" width="250" alt="Voice mode while pi needs you: an amber orb, the question card with big answer buttons, and Mute and End below"></picture>
</p>

## What you get

- **Answer pi from your pocket.** When pi asks something, any extension's question included (permission gates, pickers, text input), your locked phone buzzes. Tap, answer, and pi carries on. The question stays open in the terminal too; whichever side answers first wins.
- **Every session, every computer.** `/remote` shares every pi on the machine, running or started later; `/remote add box` puts a cloud box's sessions in the same list, with one tap on the phone. The list puts the session that needs you first, and a bar at the top tells you when another one is waiting.
- **Talk to it when you can't look.** Voice mode is a spoken conversation about the work: what pi did, why something failed, what's next. It speaks about behaviour and decisions, never file names or diffs, reads pi's questions aloud, and makes you name an irreversible action ("yes, push") before it happens.
- **Dictate prompts, get what you meant.** Speak in the terminal or on the phone; what lands in the editor is a clean prompt, with your self-corrections applied and spoken names matched to real ones in the repository.
- **Steer without breaking flow.** Follow streaming output and tool steps live, steer pi mid-run or queue a follow-up, stop it, switch model or thinking level, compact, attach a photo, or run a shell command with `!command` (`!!command` keeps the output from the model), as in the terminal.
- **Quiet while you're at the desk.** If you've typed in any pi terminal on that machine in the last two minutes, the phone stays silent.
- **Nothing to run, nothing to trust.** No relay, server or account. A paired phone talks to pi directly over HTTPS on your Tailscale network (or your own HTTPS address), and every request and event is encrypted for that phone alone.

## Install

```bash
pi install npm:pi-mobile
```

From a checkout: `pi install /path/to/pi-mobile` (after `npm install`), or try it once with `pi -e ./src/index.ts --remote`.

## Use

In any pi session on your computer:

```
/remote
```

That's the setup. The first time it shows a QR code: scan it, the panel closes by itself, and the phone stays paired. From then on `/remote` shows which sessions are shared and the address to open on your phone. Add that page to your Home Screen.

```
/remote pair          pair another device
/remote off           stop sharing this session, or every session on the machine
/remote devices       paired devices; pick one to revoke
/remote settings      HTTPS address (automatic with Tailscale), port
```

`pi --remote` shares a single session without sharing the whole machine.

On the phone:

- Sessions are sorted by who needs you: asking a question, then working, then idle, each with its task and latest reply.
- The header says what the open session is doing ("Working · 0:42", "Needs you · Allow file change?").
- Tool calls are single rows (Read, Ran, Edited…); tap one for its output. Failures open with their error; edits show a diff.
- Only the session on screen streams its output, so ten busy sessions cost little battery or data.
- What you send from the phone is echoed in the terminal as `From <device>: …`.

### HTTPS and lock-screen notifications

Phones reach pi-mobile only over HTTPS: the hub listens on this computer's loopback address alone, never on Wi-Fi or a tailnet IP, and the QR code never carries a plain-HTTP address. Install [Tailscale](https://tailscale.com) on the computer and the phone, and `/remote` does the rest: it puts pi-mobile behind `tailscale serve` (private to your tailnet, with a real certificate) and puts that address in the QR code. It reuses a serve you already have for the port, never changes other serve settings, and skips port 443 when another program holds it (then the address ends in `:8443`). If your tailnet hasn't enabled HTTPS yet, `/remote` shows Tailscale's one-click link instead of a QR code and finishes by itself once you click it; without Tailscale it says to install it.

The app offers to turn notifications on (also under **⋯**). On iPhone, add the page to the Home Screen first (iOS 16.4+). To use your own HTTPS address instead (a reverse proxy, or a public one such as Tailscale Funnel), set it in `/remote settings` (`publicUrl` in `config.json`; it must start with `https://`); `"tailscale": false` turns the automatic setup off.

### iPhone app

An optional native iPhone app (`native/ios`) shows the same web UI and adds what a web page can't: scan to pair, voice mode that keeps going with the screen locked, native dictation, a Live Activity, starting voice from the Action button or Siri, and push notifications. It isn't on the App Store: build it with Xcode on a Mac (`native/ios/README.md` has the setup; a free Apple account works, push needs a paid one). It is checked in the simulator only so far; the device checklist is in that README. The app connects over HTTPS only, so set up the secure address above first.

### iPhone push (native app)

**App Store app:** nothing to set up on your computers. When you turn on notifications, the app registers with the open-source [push relay](relay/README.md) and gives each paired computer the relay URL and an opaque capability. The computer seals the session name and text to your phone's device key and sends only that ciphertext. The relay and Apple see a generic "pi / New activity" alert and your device token, never what pi said. If the relay reports the capability dead (`410`), the computer forgets it and the app registers again. To keep a computer from ever contacting a relay, turn it off in `/remote settings` (`"relay": false` in `config.json`, or `PI_MOBILE_RELAY=off`): it refuses relay registration and sends nothing to one, while Web Push and your own APNs key still work.

**Self-built app (your own bundle ID and team):** use your own APNs key on each computer instead, or [deploy your own relay](relay/README.md#self-hosting). Direct APNs needs a paid Apple developer account:

1. In [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list) → Keys, create a key with **Apple Push Notifications service (APNs)** enabled and download `AuthKey_<KEYID>.p8` (Apple lets you download it once; keep it private: `chmod 600 AuthKey_<KEYID>.p8`).
2. On every computer that should notify: `/remote settings` → **iPhone push** → the `.p8` path, the key ID, your team ID (Membership details), the app's bundle ID, and *production* (TestFlight/App Store) or *sandbox* (run from Xcode). This writes `apns: { keyFile, keyId, teamId, topic, sandbox }` to `config.json`.

Either way, Apple sees only a generic "pi" alert; the session name and text travel encrypted to your phone's device key and are opened on the phone.

### Android app

An optional native Android app (`native/android`) does what the iPhone app does: the same web UI, scan to pair, voice mode that keeps going with the screen off (a foreground service whose ongoing notification has Mute and End; on a locked phone the voice screen offers only those until you unlock), native dictation, Take photo in attachments, a Quick Settings tile and a launcher shortcut to start voice hands-free, and notifications through the same [push relay](relay/README.md) via Firebase Cloud Messaging, sealed to your phone's device key and opened on the phone, with **Answer by voice** when pi asks. It isn't on Google Play yet: build it with Gradle (`native/android/README.md` has the setup; push needs a Firebase project). It is checked on the emulator only so far (debug and the minified release build); the device checklist is in that README. Like the iPhone app it connects over HTTPS only.

## Voice

Design notes, research and verification: [docs/voice.md](docs/voice.md).

### Dictation: speak instead of typing

In the terminal press **alt+m** (or `/dictate`), talk, then press **Enter**. On the phone, **hold the mic** in the composer and let go, or tap to start and tap ✓.

What lands in the editor is the message you meant, not a transcript: corrections applied ("null, no wait, undefined" → `undefined`), fillers gone, several asks turned into a list, and spoken names matched to real ones ("get user by ID in off dot ts" → `getUserById` in `src/auth.ts`). Anything ambiguous is listed as *Unclear* instead of guessed. You review it and send.

- **Edit by voice.** With text in the editor, "make that a list" or "drop the second point" edits it. Names you correct are remembered.
- **On-device recognition on a Mac.** On macOS 26 it uses Apple's SpeechAnalyzer: free, private, with live text while you talk (a small Swift helper compiles on first use; needs the Xcode command-line tools). Elsewhere, set `OPENAI_API_KEY` for `gpt-4o-transcribe`.
- **Talk it through, get a draft.** In the terminal, a long dictation (about 30 seconds, or sooner when you describe rather than ask) becomes a draft that forms on a full screen while you talk: points appear and change at each pause, changes glow, corrections keep the later version, asides go under *Also mentioned* and ambiguities under *Open questions*. Pauses don't end it; Enter finishes, then the draft is checked once against everything you said. Refine it by voice (alt+m) or by typing; Enter sends it, Esc puts it in the editor. What you said is kept on disk until the draft is sent (7 days at most). **On the phone** the same happens in the composer: the recording is sent to your computer in chunks while you talk, the composer grows into the draft (rendered, changes glowing), ✓ finishes and checks it; then dictate a change, **Edit as text**, **Send**, or **Keep as text** (✕ while you talk keeps it as text too). The iPhone app checks a long recording for a draft once, at the end.
- `/dictate raw` (verbatim), `/dictate undo`, `/dictate send` (send right after), `/dictate status`.
- Terminal dictation without the phone: install just [pi-speech](packages/pi-speech/README.md) (`pi install npm:pi-speech`). pi-mobile includes it.

### Voice mode: a conversation when you can't look

Tap the **voice-mode button** (the blue waveform circle at the right of the composer, where Send appears once you type) or choose **Voice mode** in the menu. Talk; pi answers out loud. On the computer itself, open `http://127.0.0.1:7878` and use its microphone and speakers.

- **About intent, not code.** It talks like an engineer on a walk: behaviour, decisions, risks, what's left. The full written answer stays in the transcript for later.
- **Sounds for state, words for news.** A tone when it hears you, a soft tick while pi works, a chime when it's done or needs you. It speaks up for outcomes, questions, and significant actions that failed (deploys, pushes, deletes, production data).
- **Ask anything, any time.** "What's it doing?", "why did that fail?", "switch to the api session", "say that again". Talk over pi and it quiets at once; an "mm-hmm" or a cough doesn't cut it off. "Stop" stops the voice, never pi's work; "stop pi" or "cancel that" stops pi.
- **Answer pi's questions by voice or with a tap.** Irreversible actions need the action named: "yes, push", not "yeah". If you just asked for exactly that, it says "Deploying to production, say stop to cancel" and goes ahead after four seconds unless you stop it.
- **pi knows you're listening.** While voice mode is on, the agent is told you can't read: outcome first, one clear question when it needs you.
- **Pick its voice.** Four voices (Marin, Coral, Cedar, Ash: two feminine, two masculine), each with its own delivery and pace and a sample to hear first. The voice changes how pi sounds, never what it says. It is set per phone, from the menu or voice mode.
- **Built for busy hands.** A screen-sized circle for push to talk in wind or traffic (hold while you talk, or tap to start and stop), the headset play/pause button as a tap where the phone allows it, and just two buttons, Mute and End. **Eyes-free / Can glance**, push to talk and the voice are in voice settings, or say "push to talk" or "I can glance".

**In the terminal too:** `/voice` (or alt+v) talks with pi through headphones while its answers stay on screen. The voice says how it went and when you're needed, in one sentence, shown above pi's answer as a *said* line; everything else is text. It waits while you type, plays a sound at once for a question or a failure, and "go quiet" or "I can't look" (or `/voice quiet|eyes-free|normal`) switch to sounds only or longer briefs. Say "rename it to the following" and the words wait in the editor for you to type the rest; Enter or "send" sends one message. Talking over the voice stops the voice, never pi; "stop pi" stops pi.

It uses a realtime speech model (`gpt-realtime-2`) over WebRTC straight from the phone, opened by pi with your ChatGPT sign-in or `OPENAI_API_KEY`; no token or audio passes through your computer. Without realtime it falls back to basic voice: recognition on your computer, a spoken brief, and the phone's speech (or any OpenAI-compatible speech endpoint via `voice.ttsUrl`, such as a local Kokoro).

Limits in the browser: on the phone, voice needs the HTTPS address. On iPhone the microphone stops when the screen locks, so voice mode keeps the screen awake. The [iPhone app](#iphone-app) lifts both. Web apps can't use CarPlay; audio plays through the car as usual. Settings are in `~/.pi/agent/pi-speech/config.json` (copied once from the older `"voice"` section of pi-mobile's `config.json`): `stt` (`auto`/`apple`/`openai`), `locale` (e.g. `"fi-FI"`), `model` (`provider/id` for dictation and spoken briefs), `realtime` (`auto`/`off`), `realtimeModel`, `realtimeVoice` (used until a phone picks a voice), `turnDetection` (`semantic`/`server`), `tts` (`auto`/`off`), `ttsUrl`, `ttsModel`, `ttsVoice` (likewise; kept for local servers other than Kokoro), `ttsKey`, `afterDictation` (`review`/`send`), `reducedMotion` (draft changes get a margin mark instead of a fading glow), `voiceSwitch` (terminal voice mode: `normal`/`quiet`/`eyes-free`). `PI_SPEECH_MIC` picks the terminal's microphone; `PI_SPEECH_PLAYER=file:<wav>` records terminal voice mode instead of playing it.

## herdr (optional)

If you run pi inside [herdr](https://herdr.dev), pi-mobile adds two things; outside herdr they switch off:

- **herdr's sidebar shows pi's questions.** Any pi dialog marks the pane *blocked*, so herdr and your phone agree on who needs you.
- **Start sessions from the phone.** Sessions → **New session**: pick a folder and an optional first prompt. herdr opens a tab there, starts pi, and the phone opens the new session.

## Several computers: a laptop and cloud boxes

Every session on every computer, in one list on the phone, each labelled with its computer. A cloud box keeps working while your laptop sleeps, so it suits sessions you steer from the phone.

1. **Once:** run `/remote` on your laptop and scan the QR code.
2. **For each new box:** in pi on the laptop, run `/remote add <ssh-host>` (or ask pi to; scripts can run `npx pi-mobile add <ssh-host>`). Your phone asks "Add box?"; tap **Add** and its sessions join the list. No QR code, no keys to copy.
3. **When a box goes:** `/remote remove box`, or remove it on the phone under **⋯ → Computers**.
4. **Every day:** one list. While the laptop sleeps it shows as "Offline since 14:02"; the boxes keep working and keep sending notifications, and the app still opens. Voice mode can switch between computers ("the api session on the box"), and **New session** asks which computer to start pi on.

No computer you already use can reach the new one? Run `/remote pair` on it, then on the phone **⋯ → Computers → Add a computer** and scan its QR code or paste its link.

`add` sets pi-mobile up on the box over SSH and needs Tailscale there, with HTTPS turned on for your tailnet (it tells you the exact fix if not). Your phone needs Tailscale too. Machine names appear in public certificate logs as `box.<tailnet>.ts.net`, so name machines accordingly. Run pi on the box inside herdr or tmux so it survives your SSH disconnects. pi-mobile only listens on loopback; phones reach it through Tailscale HTTPS. Design: [designs/multi-machine.md](designs/multi-machine.md).

## Security

- **Pairing.** `/remote` creates a single-use key valid for 10 minutes, carried in the QR URL's `#fragment`, which browsers never send to a server. The phone uses it to receive its own long-lived device key.
- **Transport.** Every request and event is sealed with the device's key (NaCl secretbox). Requests carry a timestamp and nonce, and replays are rejected. There are no bearer tokens or cookies to steal; Tailscale or a proxy sees only ciphertext.
- **Devices.** Every paired device has full control, so pair only your own. Each can be revoked on its own (`/remote devices`, or from the phone).
- **Several computers.** Your phone talks to each computer directly, with its own key on each; no computer relays another's sessions or can drive them. A new computer joins only when a computer you already use adds it over SSH and you tap Add on the phone (in the app, or on the notification on Android). Keys travel over SSH and the existing encrypted channel, never on a command line. All your computers sign notifications with one key, which changes whenever you remove one.
- **Notifications.** Encrypted to your browser (RFC 8291), so the push service can't read them.
- **Local link.** pi processes join over loopback with a secret in `~/.pi/agent/pi-mobile/` (mode 0600).
- **Caveat.** A paired full-control device can do anything pi can, so revoke lost phones.

## How it works

```
 phone ──sealed HTTP + SSE──▶ hub (inside one pi) ◀──loopback link── other pi processes
       └─sealed HTTP + SSE──▶ hub on another computer (one connection per computer)
```

- **One hub per machine.** Whichever pi binds the port hosts it; the others link to it. If that pi exits, another takes over within a second and the phone reconnects to the same address.
- **Nothing lost on reconnect.** Events carry sequence numbers and a replay buffer, so a phone that drops off catches up exactly.
- **Dialogs from any extension.** pi gives every extension the same `ctx.ui`, so wrapping `select`, `confirm` and `input` covers them all; whichever side loses is dismissed.

## Compared with other pi remotes (October 2026)

| | pi-mobile | [remote-pi](https://www.npmjs.com/package/@hk_net/remote-pi) | [@mipsel64/pi-remote-control](https://www.npmjs.com/package/@mipsel64/pi-remote-control) | [@pixu1980/pi-remote](https://www.npmjs.com/package/@pixu1980/pi-remote) | [pi-remote-control](https://www.npmjs.com/package/pi-remote-control) (Pi Relay) |
|---|---|---|---|---|---|
| Extra infrastructure | none | relay + native app | `prc` server binary + password | relay (third-party by default) + hosted PWA | daemon + iOS app + push gateway |
| Content visible to the relay or server operator | no (end-to-end encrypted) | yes, per its docs | runs on your machine | relay, unless self-hosted | not stated |
| Answer any extension's dialogs from the phone | **yes** | no | notifies only | pi-ask questions | not stated |
| Every pi on the machine, one pairing | yes | yes (agent mesh) | yes (central server) | per-directory room | per session toggle |
| Lock-screen notifications | Web Push (HTTPS) | native app | Web Push (HTTPS) | Web Push | APNs via a gateway |
| Several computers in one list | yes, phone to each computer, no relay; add one from pi or by QR | yes (agent mesh, via its relay) | not stated | not stated | not stated |

The others have things this doesn't: native apps in the app stores (remote-pi, Pi Relay; pi-mobile's [iPhone](#iphone-app) and [Android](#android-app) apps you build yourself), an agent-to-agent mesh across machines (remote-pi), and transcripts of sessions that have since closed (mipsel64).

## Development

```bash
npm install
npm test            # crypto, Web Push, hub, voice and the extension against a fake pi
npm run typecheck
npm run ui          # a hub with scripted sessions for working on the phone app
```

Before changing the phone app, read [docs/ui.md](docs/ui.md) and [docs/design-principles.md](docs/design-principles.md).

## License

[MIT](LICENSE)
