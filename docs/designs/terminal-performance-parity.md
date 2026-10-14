# Terminal engine performance: can it reach kitty's level?

Status: **plan-only (assessment + option ranking)** — no implementation in this change.
Date: 2026-10-14. Machine: this workstation (Intel Arc Pro iGPU, Hyprland/Wayland, 16 cores).
Ask: 「terminal 优化过吗，可以和 kitty 保持同样的水准吗」

## Answer in one paragraph

The terminal output path has been optimized hard and deliberately — coalescing, flow control,
pressure-aware degradation, WebGL lifecycle, hibernation, and a live Electron perf gate that
compares against `origin/main` on every run (all cited in §1). What it has **not** reached is
kitty's raw byte throughput, and it cannot by tuning: measured on the same machine with the same
64 MiB payload, kitty consumes **54–62 MiB/s** while xterm.js 6.1 + WebGL inside Electron reaches
**6.9–7.9 MiB/s with the viewport painting at 60 fps** and **16.7–27.9 MiB/s when painting is
starved**. That is a **7–9x gap while painting, 2–4x gap on the parser itself**. Interactive
latency (echo, TUI repaint) is much closer than throughput — the repo's own field evidence is
~30 ms p95 echo with two background writers — because echo is not throughput-bound. Feature
parity is essentially complete: kitty keyboard protocol, kitten/SIXEL/iTerm graphics, ligatures,
grapheme clustering, true color, OSC 7, hyperlinks. So: **parity in feel and features is
achievable and mostly shipped; parity in sustained throughput is not achievable inside this
architecture, only a ~1.5–2x improvement by moving parsing off the renderer main thread.**

## 1. What is already optimized

Output path (the part that governs throughput):

| Piece | Where | Effect |
| --- | --- | --- |
| Write coalescer (raf / microtask / burst, 16 ms burst window, 50 ms fallback drain) | `components/terminal/runtime/writeCoalescer.ts:31,36` | one `term.write()` per schedule tick instead of one per IPC chunk; kills TUI frame tearing |
| Write queue with a 10 ms event-loop turn budget, 512 KiB / 32-item cap | `components/terminal/runtime/terminalWriteQueue.ts:5,6,13` | long drains yield so Ctrl-C and input keep running |
| Flow control (1 MiB high water / 8 KiB low, 4 KiB acks, 128 KiB chunks) | `infrastructure/config/terminalFlowConstants.json` | back-pressures the remote pty instead of dropping bytes |
| Pressure detection and degradation (large-output / long-line / background) | `components/terminal/runtime/terminalOutputPressure.ts:52,54,60` | under flood the *side* work (keyword catch-up, timestamp markers) degrades first, display keeps the product rule |
| Keyword highlight: sliced recolor (32 lines / 4 ms), single catch-up rebuild when output goes quiet | `components/terminal/keywordHighlight.ts:73,74` | dense decorations no longer stall repaint (upstream decoration index fix: 20 000 decorations 6385 ms → 1.80 ms) |
| WebGL deferred until the pane is visible; per-pane painting skipped for inactive panes | `components/terminal/runtime/webglRendererPolicy.ts`, #3283 | N batch-connected hosts no longer create N contexts on the main thread |
| Unfocused/background repaint debounce (16 ms / 67 ms) | `components/terminal/runtime/terminalUnfocusedRepaint.ts:18,19` | a hidden tab's output stops competing with the visible one |
| Renderer/option tuning (no cursor blink, no transparency, customGlyphs, scrollback profiles 3000/1000/500, `resolveXTermScrollback` cap 50 000) | `infrastructure/config/xtermPerformance.ts:13,21,34,42` | fewer render calls, smaller per-terminal buffer |
| Memory lifecycle: hidden-tab hibernation (snapshot + release xterm runtime), ended-session release, two soft-hidden renderer slots | `components/terminal/terminalHibernateRuntime.ts`, `useTerminalHibernateEffect.ts`, `docs/research/terminal-lag-issues-2578-2251.md` | the 2.4 GiB renderer report's confirmed lifecycle gap was closed |
| Renderer-parity work: kitty keyboard protocol, kitten/SIXEL/iTerm inline images, ligatures, unicode graphemes, OSC 7 cwd | `components/terminal/runtime/kittyKeyboardProtocol.ts`, `createXTermRuntime.ts:725`, addon set in `package.json` | feature parity with kitty's protocol surface |
| Pinned-bundle patches that fail closed on version drift | `scripts/patch-xterm-{webgl-atlas,foreground-intense,macos-column-selection}.cjs`, `patches/` | atlas/mipmap/capacity fixes plus app-specific color and macOS selection behaviour |
| React-side thrash removal around the terminal | #2790, #2809, #2810, #2628, #2630 | hot props isolated, subscriptions scoped per pane/session |
| Live Electron perf gates (not unit tests) | `scripts/xterm-keyword-highlight-{performance,throughput}.live.test.cjs`, `scripts/terminal-output-stall.live.test.cjs` | thresholds: Enter write < 150 ms, 10 k-line rule rebuild < 1 s, split mosh repaint < 500 ms, event-loop stall ≤ 350 ms, sustained throughput within 25 % of raw xterm, 8 MiB in 12 s stress floor |

So the honest answer to 「优化过吗」 is yes, with receipts: **31 `perf(...)`-scoped commits touched
`components/terminal` since 2026-06** (592 commits touched the directory overall since July), and a
perf gate that runs the real WebGL renderer in Electron.

## 2. Measurement (this session, same machine, same payload)

Payload: 64 MiB of plain log lines (`2026-08-13T14:45:09.123Z INFO worker=07 …`, 500 813 lines,
no escape sequences). 256 MiB repeat run used to confirm linearity.

| Engine | Configuration | Time for 64 MiB | Rate |
| --- | --- | --- | --- |
| **kitty 0.49** | real Wayland window, real GPU, `--config NONE`, `time cat payload` | 1.03 / 1.13 / 1.18 s | **~57 MiB/s** (256 MiB: 4.10 / 4.43 s → ~62 MiB/s) |
| **kitty 0.49**, SGR-colored payload | same, 64 MiB with `\x1b[32m…\x1b[0m` | 1.59 / 1.69 / 2.25 s | ~28–40 MiB/s |
| **xterm.js 6.1 + WebGL in Electron** (the app's engine) | 120×40, scrollback 50 000, pipelined ~512 KiB in flight, painting at 58.8 fps | 9.27 s | **6.90 MiB/s** |
| same, scrollback 3 000, painting at 60 fps | | 8.13 s | **7.88 MiB/s** |
| same, scrollback 50 000, painting starved (1 fps) → parser only | | 3.83 s | **16.73 MiB/s** |
| same, scrollback 3 000, painting starved → parser only | | 2.29 s | **27.94 MiB/s** |

Method notes:

- Our number is the **engine ceiling**: raw `term.write()` into a real xterm + WebglAddon instance
  in an Electron renderer with the real GPU — no pty, no IPC, no coalescer, no decorations, no
  logging. The app path on top of it is lower (the repo's gate only promises "within 25 % of raw
  xterm sustained throughput for the highlight path"). The mapped-window harness run (below)
  confirms the highlight path costs nothing measurable against raw xterm in sustained throughput:
  0.94–1.03 MiB/s (`new`) vs 0.95–0.98 MiB/s (`raw`), the absolute rate there being
  DOM-renderer-bound (WebGL is blocklisted under Xvfb+x11) and therefore not comparable with the
  table above.
- Sequential `await write(64 KiB)` is *not* the app's pattern; it measures 6.9 MiB/s but is
  pipeline-stalled. The flood variant (≤ 512 KiB in flight, mirroring the app's
  `MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES`) is the figure to compare with kitty. Writing > 1 MiB in
  flight makes xterm throw `write data discarded, use flow control to avoid losing data` — the
  reason the 1 MiB high-water mark exists.
- Two scrollback settings are listed because at 50 000 lines the JS buffer churn is visible
  (6.90 vs 7.88 MiB/s at the same paint rate).
- Payload differences that would move kitty's number: SGR colors cost it ~35 %; our payload had
  none. Both engines stream through a trimmed scrollback (xterm: 50 040 retained lines; kitty:
  its own 2 000-line default).

Reproduction:

```bash
# kitty
kitty --config NONE -o confirm_os_window_close=0 sh -c '{ time cat plain64MiB.txt; } 2> /tmp/kitty-time.txt'
# xterm.js (throwaway probe, not in-repo)
xvfb-run -a ./node_modules/.bin/electron --no-sandbox <probe>/xterm-plaintext-bench.cjs
```

## 3. Where the 7–9x goes

Subtracting the paint-starved and the painting rows gives the decomposition (64 MiB):

- **Parser + buffer ~2.3–3.8 s (17–28 MiB/s)** — xterm.js is JavaScript: table-driven DCS/CSI
  handling, per-line `Uint32Array` cells, GC pressure from 500 k line allocations. This is the
  part a native terminal does in C with SIMD; kitty's whole 64 MiB run (1.0 s) is shorter than our
  parse-only time.
- **Paint ~5.5 s at 60 fps (~11.6 MiB/s of screen updates, ~190 KiB/frame)** — Chromium WebGL2 via
  the glyph atlas, over a renderer main thread that is also running React 19, the AI stream, the
  vault/side panels and every decoration. kitty draws from its own render thread straight to GL.
- **Process hops (not measured here, additive in the app)** — pty in the terminal worker
  (`electron/terminalWorker/process.cjs`) → `terminalDataPipeline` MessagePort with transferable
  buffers → renderer. Latency-tolerant, but it means the renderer only ever sees text after a
  copy, and it is the same thread that must parse it.

Input latency is a different axis and is much closer: measured field evidence in
`docs/research/terminal-lag-issues-2578-2251.md` is ~30 ms p95 echo with two background writers
(>100 ms with fourteen, which is what the renderer-slot policy fixed). kitty's ceiling is one
vsync interval. Neither number is perceptible for typing; the difference is in dumps.

## 4. Axis-by-axis verdict

| Axis | kitty | Netcatty today | Reachable? |
| --- | --- | --- | --- |
| Typing / echo latency | ~1 vsync (~16 ms) | ~30 ms p95 under load | **Yes, already there.** Keep the gate; no architecture change needed. |
| TUI repaint integrity (no tearing, no dropped frames) | n/a (never blocks) | coalescer + pressure modes; gated by `xterm-keyword-highlight-performance` | **Yes.** Already the design. |
| Sustained dump throughput (foreground, painting) | ~57 MiB/s | 6.9–7.9 MiB/s | **No (7–9x).** Would need the VT core + renderer out of the JS main thread. |
| Sustained dump throughput (parser only) | ~57 MiB/s | 17–28 MiB/s | **Partly.** A WASM parser is the only credible lever, ~2–3x. |
| Multi-terminal fairness | per-OS-window multiprocess/threads | one renderer thread, hibernation + renderer slots + inactive-pane skip | **Mostly.** Fixed cost stays; policies already bound the damage. |
| Memory per terminal | ~few MB/window | 50 k-line plain buffer ≈ **+11 MiB JS heap** (50 040 retained lines, after two forced GCs); the current highlight path adds **~+2 MiB** per 9.7 MB of output where the previous implementation added **~+29 MiB** | **Mostly.** Idle terminals are released by hibernation; live ones are bounded by the scrollback setting, which is why the profiles are 3000/1000/500 and the "unlimited" sentinel maps to 50 000 (`resolveXTermScrollback`) |
| Protocol/feature surface | kitty keyboard, graphics, ligatures, graphemes, true color, OSC 7/8 | all of the above implemented | **Yes.** Shipped. |
| Never dropping output | always keeps up | throttles the pty, and drops side work (timestamps, highlight catch-up) under flood; teardown can drop pending bytes | **Philosophy differs.** Acceptable, but should be user-visible rather than silent. |

## 5. Options, ranked by value ÷ cost

**A. Stay the course; add the gates that matter (recommended).** Keep xterm.js. Spend on
(a) the flood UX instead of raw speed — make degradation visible ("跳过 3 行时间戳" style notice)
and keep the pty throttle, (b) first-paint/first-output latency for local + restored sessions,
(c) memory per live terminal. Cost: days. Buys: the complaints users actually file.

**B. Move parsing off the renderer main thread (WASM VT core).** Compile a proven core
(`libvterm`, Ghostty's `libghostty-vt`) and feed xterm only the deltas, or replace xterm's state
machine wholesale. Cost: months, and it invalidates the addon ecosystem the product leans on
(search, selection, serialize, decorations, inline images, ligature remeasure, `osc7Setup`) — each
one is written against xterm internals. Realistic gain: 2–3x on parse-bound cases, i.e. ~20 MiB/s
foreground at best, still ~3x behind kitty, and *no* gain for paint-bound frames unless the
renderer moves too. Verdict: **only worth it if a customer-visible requirement names a throughput
number** (e.g. "1 GB log in under 30 s").

**C. Replace the renderer under xterm's state machine** (native/WebGPU/offscreen canvas). Attacks
the ~5.5 s paint share. Cost: months, high visual-regression risk across five platforms, and it
does nothing for the parse share. Verdict: **not worth it alone**; only as part of B.

**D. Delegate to a native terminal emulator.** Not viable: it discards the in-app surface the
product is built on (decorations, timestamps, AI context, SFTP cwd tracking, session logging) and
kills cross-platform packaging.

**E. Dual-mode display for floods.** When pressure is "large-output"/flood, switch the pane to a
sampled/compacted view (N-line sampling, no per-line decorations, "已折叠 M 行" banner), keeping
the full transcript in the session log. Cost: ~1 week. Buys: the *felt* difference for
`cat bigfile` / `docker logs` — the visible outcome is bounded work per frame, and the user gets
an explicit indicator instead of a silently slow pane. This is the closest thing to "kitty-like
behaviour" that does not require rebuilding the engine.

## 6. Milestones with measurable acceptance criteria

- **M1 — throughput truth in CI.** Add the 64 MiB plain-payload rate (paint + paint-starved, both
  scrollbacks) to `scripts/xterm-keyword-highlight-throughput.live.test.cjs` output and record the
  baseline in this doc. Gate: no more than 10 % regression vs `origin/main`. *(No new architecture.)*
- **M2 — flood UX.** Flood state visible in the pane; timestamps/highlight degradation announced;
  no silent byte drop except on teardown. Gate: `terminal-output-stall` plus a new assertion that
  a flood leaves the transcript complete.
- **M3 — multi-terminal fairness.** With 8 concurrent writers, active-pane echo p95 ≤ 50 ms and
  event-loop stalls ≤ 100 ms. Gate: extend the existing heartbeat assertions to an 8-session fixture.
- **M4 — memory per live terminal.** Keep a 50 k-line plain buffer at ≤ 15 MiB and the highlight
  path's incremental retention at ≤ 5 MiB per 10 MB of output (measured baseline: 11 MiB / ~2 MiB;
  the previous implementation was ~29 MiB). Gate: heap assertions in the throughput harness.
- **M5 (only if a number is required) — WASM VT core spike.** Time-boxed spike behind a flag,
  measuring parse-only rate and addon compatibility, with an explicit go/no-go.

## 7. Open decisions

1. **Is there a throughput number we must meet?** — **Resolved 2026-10-14: no.** No optimization work
   is to be done on the terminal output path for rate; the terminal is used log-capture-first, where
   keeping output in files (transcript/log surfaces) is both more efficient and safer than pushing it
   through the pane. The 7–9x gap against kitty is accepted.
2. **May floods degrade the display?** — Moot while (1) stands; if rate work is ever reopened, the
   default stays "yes, announce it in the pane".
3. **Keep funding parity on feel rather than rate?** — **Resolved: yes**, and only as ordinary bug
   fixes; no investment plan is attached to this document.

Reopening this needs a named, customer-visible throughput number — otherwise read §1 (what is already
optimized) and route the complaint to the flood-UX/log-capture surfaces instead.

## 8. Borrowing kitty instead of matching it (settled direction, 2026-10-14)

Because the rate gap is accepted, the practical answer to "I need kitty's speed/handling" is to
**lend kitty the connection rather than rebuild the engine**. Direction chosen in discussion: the
local-forward route (cheap, zero code, credentials stay inside Netcatty).

- **SSH:** create a *local* forward on the **same host** as the live session, listening on
  `127.0.0.1:<port>` with remote target `127.0.0.1:22`, then
  `kitty ssh -p <port> user@127.0.0.1`. This works because port forwarding borrows an
  already-authenticated transport matched by endpoint (`portForwardingBridge.cjs:1256`, `:1301`,
  reuse on by default via `:1177` `reuseTransport !== false`), and leases keep that transport alive
  independently of the pane (`sshConnectionPool.cjs:991`, `:1063`). Costs to state up front: the
  inner session authenticates again (fine with agent forwarding, 2FA lands in kitty), it consumes an
  sshd `MaxSessions` slot, kitty needs its own known_hosts entry for `[127.0.0.1]:<port>`, and the
  tunnel dies with Netcatty — that coupling is the definition of proxying.
- **Serial:** needs a relay because there is no protocol to re-enter. The port is owned by the
  utility process (`terminalBridge.cjs:23` `serialport`, `startSerialSession` ~1308–1347, registered
  in `electron/terminalWorker/process.cjs:289,315,327`), so the relay belongs at the worker, tapping
  **before** xterm and before the app's flow-control/degradation — otherwise kitty inherits what we
  drop. Netcatty stays the single reader (serial bytes are not replayable) and fans out; handoff is
  a special case that must be revocable. Line parameters stay Netcatty's (a socket client cannot set
  baud/parity/DTR), and local echo must have exactly one owner (`serialLocalEcho.ts`).
  Safety, which is the real argument here: proxying reuses the already-open fd instead of letting a
  second process open the device (split reads, and DTR/RTS on open can reset the board).
- **Not a performance measure:** 115200 baud is ~11.5 KB/s (921600 ≈ 92 KB/s), two orders of
  magnitude under xterm's 7 MiB/s ceiling. If the goal is only to keep logs, transcript + `tee` is
  enough; the relay is about letting the user's existing kitty tooling join the same stream.

Open questions (unanswered — the discussion ended here):

1. Serial: fan-out (both surfaces see it) or exclusive handoff (Netcatty yields the display)?
2. Confirm the tap point is the worker's source (kitty gets the undegraded stream)?
3. Unix socket with `0600`, opt-in per session — accepted?
4. Build the relay as a generic **stream export** (reusable later for handing off a live SSH shell
   without re-authenticating), or serial-only?

## Verification record

- Read the current output path: `writeCoalescer.ts`, `terminalWriteQueue.ts`,
  `terminalWriteCoalescer.ts`, `terminalOutputPipeline.ts`, `terminalOutputPressure.ts`,
  `terminalSessionAttachment.ts`, `terminalUnfocusedRepaint.ts`, `webglRendererPolicy.ts`,
  `keywordHighlight.ts`, `xtermPerformance.ts`, `terminalFlowConstants.json`.
- Ran the repo's own live harness twice. Hidden window
  (`xvfb-run -a electron scripts/xterm-keyword-highlight-throughput.live.test.cjs`): WebGL active,
  throughput assertions held, paint-atomicity assertions failed with `paintTimedOut: true` and 8
  renders in 8.9 s — the documented hidden-window display-clock throttle under Xvfb, not a product
  regression. **Mapped window** (`NETCATTY_TERMINAL_PERF_SHOW_WINDOW=1 ... --ozone-platform=x11`):
  every assertion passed, `paintTimedOut: false`, ≤ 1 render after settle, and per round
  `heapDeltaMiB` was +2.0/+2.1 MiB for the current highlight path against +29.3/+29.5 MiB for the
  previous implementation on the same 9.7 MB payload (that run rendered through the DOM renderer
  because WebGL2 is blocklisted under Xvfb+x11).
- Measured the plain buffer's own retention separately (50 040 lines retained): **+11 MiB JS heap**
  after two forced GCs; the 3 000/1 000-line runs came out at −9.2/−0.3 MiB, i.e. below the noise
  floor of a post-dispose heap baseline, so only the 50 k figure is quoted.
- Separately measured a real WebGL pane in Electron with the display clock letting it paint:
  545–534 renders during a 9.1 s stream (58.8 fps), so the 6.90 MiB/s figure above is
  paint-inclusive, not a starved-render artifact.
- Measured kitty 0.49 on this machine: 64 MiB plain 1.03/1.13/1.18 s, 256 MiB 4.10/4.43 s,
  64 MiB SGR 1.59/1.69/2.25 s.
- Measured xterm.js 6.1 + WebglAddon in Electron (64 MiB plain): 6.90 MiB/s painting 58.8 fps
  (scrollback 50 k), 7.88 MiB/s (3 k), 16.73 / 27.94 MiB/s paint-starved.
- Confirmed the 1 MiB in-flight limit empirically: writing > 1 MiB ahead of the write callback
  throws `write data discarded, use flow control to avoid losing data` from xterm.
