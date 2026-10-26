# Phone UI: the design system

The phone app is plain HTML, CSS and JavaScript in `web/` (no build step, no framework, no dependencies). This page is the source of truth for **how it looks and how to change it**: foundations, components, patterns, the mistakes already made once, and the checks. [design-principles.md](design-principles.md) explains **why** (who holds the phone, the voice surfaces, motion, copy) and what "done" means. Read both before changing anything in `web/`.

The bar is a first-party iOS app: calm, legible at a glance, one obvious action per state, identical in light and dark, fully usable by keyboard and screen reader. A change that is correct but looks bolted on is not done.

## 1. Rules that keep it consistent

1. **Tokens only.** Every colour, radius, shadow, easing and font comes from `:root` in `web/app.css`. No raw values in components, except `#1b1203` (text on amber), `#fff` on red, and the forced-colours keywords.
2. **Both themes, always.** A new colour token gets a light value in `:root`, a dark value as `--d-<name>` beside the other `--d-*`, and a line mapping it in the `prefers-color-scheme: dark` block. Look at both themes before calling it done.
3. **Reuse before you add.** Build with the helpers and classes in §4. A new component is a design-system change: add it here, in the same commit.
4. **A colour means one thing everywhere** (§2.3). Never pick a colour because it looks nice next to another.
5. **Every state, every size.** Each new state goes into the fixture (`test/ui/fixture.ts`) and the screenshot harness (`test/ui/shots.mjs`), and passes §7.

## 2. Foundations

### 2.1 Type

System fonts (`--sans`, `--mono`); base 16 px / 1.5. A small, fixed scale; pick the role, not a size.

| Size | Weight | Role | Examples |
|---|---|---|---|
| clamp(24–30) | 650 | Voice-mode state | "Listening", "pi needs you" |
| 20–21 | 700 | Sheet and empty-state titles | `.sheet-head h2`, `.empty h2` |
| 19 | 500 | pi's voice caption | `.v-cap.pi` |
| 17 | 650 | Primary names and questions | `.session-name`, `.prompt .ptitle` |
| 16 | 400–650 | Body, row titles, inputs, buttons | `.md`, `.row .title`, `.btn` |
| 14–15 | 550–600 | Compact UI text | tool rows, toasts, chips, attention bar |
| 13 | 500–650 | Secondary lines, section labels, notes | `.session-sub`, `.row .sub`, `.section`, `.note` |
| 12 | 600–700 | Eyebrows and tiny labels | `.prompt .eyebrow` ("pi asks") |

Weights are 500/550/600/650/700. Titles get `letter-spacing: -.01em`. Numbers that tick (timers, counts) use `font-variant-numeric: tabular-nums`. Inputs are never below 16 px (iOS zooms the page). Code and paths are `--mono` at 13 px.

### 2.2 Space and size

- A 4 px grid. The usual steps are 4, 6, 8, 10, 12, 14, 16, 20 and 24.
- Gutters: 16 px on the transcript and in sheets, 12 px for cards and bars under the header. Reading width is capped at `--measure` (720 px). Sheets are capped at 640 px and voice mode at 560 px.
- Touch targets are at least 44 px:

  | Element | Height |
  |---|---|
  | Icon buttons | 44 |
  | List rows | 52 |
  | Answer buttons | 48 |
  | Full-width buttons | 50 |
  | Voice-mode buttons | 68–72 |

  Never shrink a target to fit a narrow screen; drop a label instead. For example, `.stop-btn` loses its text at 360 px. Below 300 px (the iOS app narrows the viewport to ~244 px at the largest text sizes) the header drops the model chip and the menu shows a **Model** row instead, so the session name keeps the room; nothing may scroll sideways (`shots` fails on it). Check narrow work with `npm run shots -- --width 244,275,320`.
- Every fixed edge adds `--safe-t` / `--safe-b`, except the composer while the on-screen keyboard is up (`html.kb`, set by `keyboard()` in `app.js` from the iPhone app's `keyboard` call or `visualViewport`): iOS keeps `safe-area-inset-bottom` at 34 px with the keyboard open, so the app shrinks to the visible height (`--kb`) and the composer sits 8 px above the keyboard, also when the field was focused from code (after a dictation), when WebKit wouldn't scroll it into view. The empty-session greeting steps aside meanwhile. Nothing relies on the keyboard's Done (the iPhone app hides that bar): a swipe down on the transcript puts the keyboard away, as do sending and the web blurring the field. `shots` checks all of it with an emulated 34 px inset and a simulated keyboard.

### 2.3 Colour

| Role | Tokens | Meaning |
|---|---|---|
| Surfaces | `--bg`, `--surface`, `--panel-2`, `--fill-2`, `--code-bg`, `--seg-on` | page, raised card, grouped fill, pressed fill, code, the selected segment |
| Text | `--text`, `--text-2`, `--muted` | primary, secondary, tertiary (`--muted` is ≥ 4.5:1 on `--panel-2`) |
| Lines | `--border`, `--border-strong` | hairlines, input borders |
| **You** | `--you` = `--accent`, `--accent-soft`, `--accent-ink`, `--accent-text`, `--user`, `--glow` | you and what you can tap: primary buttons, your messages, links, the recorder, listening; `--glow` (derived from `--you` and `--surface`, so it follows the theme) is the tint on what your dictation just changed in a draft |
| **pi working** | `--busy`, `--busy-2`, `--busy-soft` | violet: running steps, the working dot, distilling |
| **pi speaking** | `--speak`, `--speak-2`, `--speak-soft` | teal |
| **pi needs you** | `--needs` = `--warn-dot`, `--warn`, `--warn-soft`, `--warn-line`, `--needs-2` | amber: questions, badges, the attention bar |
| Done | `--ok`, `--ok-soft` | green ticks |
| Stop, failure, irreversible | `--err`, `--err-soft`, `--danger`, `--danger-text` | red: failed steps, errors, destructive answers, End |
| Off | `--off` | grey: idle voice, gone sessions |
| Diff | `--add`, `--add-ink`, `--del`, `--del-ink` | |
| Dark palette | `--d-*` | defined once; mapped in dark mode; the voice orb uses these vivid colours in both themes |

Colour never carries meaning alone: a word, an icon or a sound says the same thing.

### 2.4 Shape and elevation

| Token | Size | Used for |
|---|---|---|
| `--r-s` | 8 | Small inner pieces: tool icon tiles, code inside a card |
| `--r-m` | 12 | Buttons, rows, inputs, tool rows, the attention bar |
| `--r-l` | 18 | Cards and groups: `.prompt`, `.group`, `.suggest`, the dictation strip |
| `--r-xl` | 24 | Sheets and the composer |
| `999px` | full | Pills: `.pill`, `.seg`, `.chips`, `.model-btn`, toasts |

There are two levels of elevation:
- `--shadow-1` for things resting on the page: the composer, the selected segment, the onboarding card.
- `--shadow-2` for things floating above it: pi's question card, sheets, toasts, slash suggestions, the jump button.

Flat fills (`--panel-2`) group things; shadows are for what floats. Never use both on one element.

### 2.5 Icons

The sprite lives in `web/index.html` as `<symbol id="i-…">`. Each icon is drawn on a 24 px grid with round 1.9 px strokes and no fills. Use `icon(name, cls)` in `app.js`.

| Class | Size |
|---|---|
| `.i` | 22 px (default) |
| `.i.md` | 18 px |
| `.i.sm` | 16 px |

Current set: `chev-down chev-right more plus arrow-up arrow-down stop mic-off mic wave file pencil terminal search globe bolt check x alert bell compact refresh voice sliders phone link eye logout folder sparkle lock image chip copy share qr`. To add one, draw it in the same style, and give the icon an `aria-label` whenever it is the only content of a button.

### 2.6 Motion

- Timing: `--ease` at 120–300 ms. One exception: a draft's dictated change fades from `--glow` over 3 s with `--ease-fade` (it holds, then goes). Named keyframes:

  | Keyframe | Used for |
  |---|---|
  | `rise` | cards appear |
  | `up` | sheets slide in |
  | `drop` | toasts appear |
  | `fade` | backdrops |
  | `ring` | live status dots |
  | `spin` | spinners |

- Only live states loop.
- The global `prefers-reduced-motion` block cuts every animation. Anything drawn on a canvas (the orb, the dictation waveform) checks the preference itself.
- The rules are in design-principles.md §5.

## 3. Layout of the app

```
header#top      session button (dot · name · status line) · model pill · menu
.attention      another session's question (amber bar)        ← under the header
main#scroller   transcript (.msg.user bubbles, .msg.assistant flush, .tool rows)
#prompts        pi's question card(s) above the composer      ← what needs you, in the thumb zone
footer#composer work bar (state · Stop · Steer/Queue) · dictation strip · compose box (+ · text · mic · voice mode or Send)
.toasts         drop in under the header, never over controls
.sheet          bottom sheet over everything; voice mode (#voice) is a full-screen layer
```

Primary actions live at the bottom; status lives at the top; nothing important hides behind a scroll.

## 4. Components

The helpers are in `web/app.js`. `voice.js` gets them through `window.PiMobile`.

| Component | Build with | Rules |
|---|---|---|
| Element / icon | `el(tag, cls, text)`, `icon(name)` | No `innerHTML` with data; text goes in as text |
| Bottom sheet | `openSheet(build, { title, subtitle })`, `closeSheet()` | Focus moves to the first row or field on open and returns to the opener on close; Escape and the backdrop close it; titled sheets get `aria-labelledby`. One sheet at a time: opening another replaces its body |
| Grouped list | `section(body, text, count)`, `group(body)`, `row(g, { lead, title, sub, extra, trail, cls, onclick, label })` | Rows are buttons, 52 px tall, separated by an inset hairline. Selection is `aria-pressed` plus a trailing `check` icon (hidden when false). `.row.current` marks where you are; `.row.danger` is a destructive action |
| Two-way choice | `.seg` with `button[aria-pressed]`; `.seg.wide` in sheets | Exactly two or three short options; the selected one uses `--seg-on` + `--shadow-1` |
| Several choices | `.chips` | A short set of equal options, e.g. thinking levels |
| pi's question | `.prompt` (`.eyebrow` "pi asks", `.ptitle`, `.pmsg`, `.pact`, `.pfoot`) | The same card in the transcript and in voice mode. Two answers side by side; more go in a column (`.pact.col`). Primary is accent; irreversible is `.danger` and names the action ("Yes, do it") |
| Buttons | `.btn` / `.btn.primary` (full width), `.pill` / `.pill.primary`, `.icon-btn`, `.stop-btn`, `.send.ready` | At most one primary per view. Icon-only buttons need `aria-label` |
| Composer's last button | `#voiceBtn.send.voice-go` ("Voice mode", waveform) and `#sendBtn.send` ("Send") in one spot; `updateSend()` in `app.js` shows exactly one | Empty composer: voice mode, the primary (accent fill). Text, an image or a draft: Send. Focus moves with the swap. While dictating, voice mode hides and keeps its place (`visibility: hidden`): the recorder's ✓ and ✕ are the actions, and the mic doesn't move under the finger. Composer buttons are 40 px discs with a 44 px touch area. The menu's Voice section also has **Voice mode** |
| Status | `.dot.idle/.working/.waiting/.gone`, `.badge`, `.session-sub.waiting/.working` | Always next to words |
| Banners | `.attention` (another session asks), `.banner` (connection), `.onboard` (one-time offer) | Under the header, one line, the whole bar is the target |
| Tool step | `details.tool` > `summary` (`.ticon` · `.tname` · `.ttitle` · `.tstate`) | One quiet row; output on tap; failures open by themselves |
| Text | `.md` (markdown), `.msg.user`, `.err-line`, `details.thinking` | Assistant text flush on the page; tables and code scroll sideways inside themselves |
| Extension message | `.msg.custom` (`customNode` in `app.js`): a `details` card when the text is longer than one short line | Collapsed like pi's terminal shows it: the source (`.tag`, with a chevron) and the start of the text as plain words, two lines at most (`.preview`); the whole card is the 44 px tap target and opens the rendered Markdown. One short line stays a plain card |
| Feedback | `toast(text, "info"|"warning"|"error")`, `.note`, `.sheet .sub-note` | Prefer an inline line next to the cause; a toast for things that happened elsewhere; errors use `role="alert"` |
| Fields | `.field` (label span + input/textarea) | Label above, 48 px, 16 px text, focus turns the border accent |
| Dictation strip | `#dictBar[data-kind=rec/busy/done/error]` | Replaces itself in place; never rebuilds per frame. While a draft forms (`.drafting`) the time shows against the limit ("6:42 / 10:00", `--warn` from 9:00) and the hint gives way |
| Draft sheet | `#draftSheet.draft[data-ui=forming/checking/changing/ready/text]` in the composer, built by `web/draft.js` (`.draft-head` eyebrow "Draft", title, state; `.draft-body.md` of `.draft-block`s; `.draft-text`; `.draft-hearing`; `.draft-note`; `.draft-actions` pills); the composer gets `.drafting` and `#draftHint` replaces the text field | A long dictation as a rendered Markdown document that rests on the page like the composer (`--r-xl`, `--shadow-1`). Blocks are keyed by id and updated in place; a dictated change gets `.glow` then `.fade` (`--glow` to nothing over 3 s), removed text stays struck through for 3 s, typed text never glows. Without motion or in forced colours: `.marked`, a `--you` bar in the left margin until you touch the draft. The body scrolls (≤ 34dvh) and follows the latest change unless you scrolled it. States say themselves in words: Listening (live dot), Checking… / Changing… (violet spinner), Ready to send, Editing. Send (the composer's) is the one primary; Keep as text and Edit as text are 44 px pills |
| Voice mode | `#voice` with `.v-*` classes | design-principles.md §4; every voice class starts with `v-` |
| Computers | `fleet` (`web/fleet.js`), `machineSheet`, `addComputerSheet`, the offer sheet (`showOffer`), and **Add** on the offer's notification (`web/sw.js`; Android only, iPhone web notifications have no buttons) | Name a computer only when there are two or more (`several()`): as a prefix on session rows and the header line ("hetzner-box · Working · 0:42"), and in the attention bar. A computer that can't be reached is one row, "Offline since 14:02", never a list of dead sessions. An offer always names the computer, its address and where it was asked for, in the sheet and on the lock screen, because that tap is the consent |
| Pair by link | `pairLinkForm()` in `unpaired()` (`.pair-form`: `.field` · `.err-line` · Paste `.btn` · Pair `.btn.primary`) | Only in an installed app (`installed()`: iOS Home Screen or `display-mode: standalone`), which has no address bar and, on iPhone, none of Safari's storage. The steps say `/remote pair`, then touch and hold the code in the Camera app and Copy Link (a tap would open Safari). A link for another computer, or not a pairing link, is an inline error that says what to do; a good one pairs through the same address-hash path as a scan |
| Scan sheet | `scanSheet()` from **Scan QR code** in `addComputerSheet` (`.scan-view` · `.scan-frame` · `.scan-state` · `.scan-hint`); `qrReader()` | A camera viewfinder for a pairing QR. It is dark in both themes, like any camera, so it uses the `--d-*` palette. Every state says itself in words: Starting the camera… (spinner), live (frame plus hint), a code that isn't pi's (amber frame, the hint says so), Camera access is off, No camera found, The camera didn't start. **Paste link instead** is always there and becomes the primary button once the camera can't help; Cancel goes back to Add a computer. Closing or replacing the sheet stops the camera (`sheetGone`). A pi link goes straight into the paste flow (`addComputerSheet(link)`). Decoding: `BarcodeDetector` where it exists, else the vendored jsQR in `web/qr.js` (Apache-2.0, `web/qr.LICENSE`), loaded on first use. In the iPhone app (`window.PiNative.scan`) the native VisionKit scanner is used instead (`native/ios/BRIDGE.md`, `scan`) |

## 5. Patterns

- **What needs you comes first.** An open question is pi's question card above the composer, with nothing over it. Another session's question shows as the attention bar. The session list is grouped Needs you → Working → Idle.
- **Choosing.**
  - Two modes: `.seg`.
  - A short list where the choice applies at once: rows with a check.
  - A list that opens something: rows with a trailing chevron.
  - A form: `.field` plus one `.btn.primary` at the bottom.
- **Destructive actions** are red, say what they do, and sit after the safe option. In voice mode they also need the action named out loud.
- **Empty, loading and error states** are part of every view:
  - empty: `.empty`, a title and the exact command to run;
  - loading: a word plus `.spinner`, never a bare spinner;
  - error: what happened and what to do next.
- **Focus.**
  - Every control shows `:focus-visible` (2 px accent outline).
  - Inside a `.group`, which clips its corners, the ring is drawn inside the row (`outline-offset: -2px`).
  - Dialogs move focus in and give it back on close. The image viewer traps Tab.
- **Gestures** (the composer mic, the voice circle) use `touch-action: none`, no text selection and no callout. They also:
  - capture the pointer;
  - treat a press of 350 ms or longer as hold-to-talk, and a shorter one as a tap that toggles;
  - swallow the click that follows a press;
  - still work with Enter and Space as plain taps.
- **Several computers** never change the single-computer UI: no chips, sections or wording appear until a second computer is added. Requests go to the session's own computer (`fleet.call`); speech goes to whichever computer can do it (`speechCall`).
- **Sheets that open by themselves** (an offer from another computer) pass `unprompted: true` to `openSheet`, so focus lands on the title instead of a pre-selected button.
- **Haptics** happen only inside a user gesture: `navigator.vibrate` where it exists, otherwise the iOS switch trick (design-principles.md §7).

## 6. Mistakes already made once (don't repeat)

| Symptom | Cause | Rule |
|---|---|---|
| A focus ring looked like a blue underline under a row | `.group { overflow: hidden }` clipped the outline | Focus rings inside clipping containers use a negative offset |
| A voice-mode button rendered invisible | A new `.v-icon` collided with an existing class | `rg` the class name before adding one; prefix by surface |
| Mute was smaller than End | A size set on `.v-mute` in a media query outlived the refactor | Size lives on one element (`.v-btn-face`); media queries target that same selector |
| The selected segment vanished in dark mode | Selected = `--surface`, which equals the track in dark | Give selected states their own token (`--seg-on`) with a dark value |
| The orb covered its label while held | Canvas size ignored the text below | Canvas drawings clamp to the room they have |
| Screenshots showed focus rings nobody sees on a phone | Scripted `element.click()` counts as keyboard use | Drive screenshots with real taps (`tap()` in `shots.mjs`) |
| Dark screenshots merged on GitHub's dark page | No edge between screen and page | README images are phone-framed light/dark pairs (§8) |
| Dictation screenshots showed "Too short" instead of the review | Chrome's `--use-file-for-fake-audio-capture` delivers only zeros (Chrome 154, macOS) | Screenshots that need sound use the in-page buzz microphone (`buzzMic()` in `shots.mjs`, into a stream with no output device); the browser always runs with `--mute-audio` |
| An attachment's remove × was cut off at the top and was a 24 px target | `.attachments` scrolls sideways, which clips, and its padding was smaller than the button's overhang | The button is a 44 px target over the thumbnail's corner with a 24 px disc in it; the strip's padding fits the disc |
| A draft's glow and margin mark were cut off at the left | The scrolling `.draft-body` clips, and the blocks reached past it | Give a scrolling container the room its children's tint and marks need (`.draft-body` reaches 10px past the text) |

## 7. Checks

```bash
npm run ui                 # scripted hub on :7979; type work, ask, pick, done on its stdin to move states
npm run shots              # every state, light + dark, 390 and 320 px, axe on each → shots/
npm run shots -- --forced  # forced colours        npm run shots -- --reduced   # reduced motion
npm run shots -- --only voice --theme dark --width 390 --out /tmp/s
```

`shots` (`test/ui/shots.mjs`) uses `puppeteer-core` with the local Chrome; set `CHROME=/path` if it is not in the usual place. It covers six flows:
- **app:** pairing, sessions, transcript, open tools, working, confirm and select questions, menu, models, new session, slash commands, and focus rings, including inside a sheet;
- **voice:** dictation, every voice-mode state, mute, the settings sheet, push to talk with a real held press;
- **draft:** a long dictation forming into a draft with the real drafting engine and a scripted recogniser and models (`window.PiDraftDebug` shortens the chunks; the microphone is a buzz made in the page): forming, a change glowing, the 9-minute warning, the check, dictating a change, the change (struck through), the same without motion (margin marks), editing as text, sent, kept as text, and lost by the computer while forming (`lose` on the fixture's stdin): the sheet says so, then ✓ makes the whole recording a dictation;
- **picker:** the voice picker from the menu and from voice mode;
- **machines:** a second fixture computer offered and added, one list from both, the Computers menu, the box going offline and coming back then a second offer added from its notification without a sheet (`box`, `box again`, `box off`, `box on` on the fixture's stdin), and a herdr New session started on the box (its folders only; the fixture logs `spawn <computer> <folder>`);
- **scan:** Add a computer, then the scan sheet reading a fake camera that shows a code that isn't pi's (once through `BarcodeDetector`, once through jsQR), camera access off, no camera, and starting.

It exits 1 on any axe violation (WCAG 2.2 AA), page error or failed step, and writes `report.json` with the checks it measured.

**Look at the images.** axe catches contrast and names, not taste. With `window.PiVoiceDebug = []`, `PiVoice.preview(state, { heard, said })` puts voice mode in any state.

A UI change is done when:
- the states it touches look right in both themes at both widths;
- `shots` passes, including `--forced` and `--reduced` when the change has colour or motion;
- it works by keyboard alone;
- `npm test` and `npm run typecheck` pass;
- this page is updated if a token, component or pattern changed.

The checks a real phone has to cover are in design-principles.md §8.

## 8. README and gallery images

The README shows phone-framed WebP pairs, `docs/img/<name>-light.webp` and `-dark.webp`, inside a `<picture>` element, so GitHub picks the one matching its own theme. To refresh them:

1. Take 390 px shots with `npm run shots`.
2. Frame each one with `python3 test/ui/frame.py <shot.png> docs/img/<name>-<theme>.webp` (Pillow): rounded corners, a dark bezel with a grey hairline, a transparent outside.
3. Keep each image's alt text describing what the screen shows.
