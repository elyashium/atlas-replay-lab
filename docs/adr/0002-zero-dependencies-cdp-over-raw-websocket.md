# ADR-0002 — No runtime dependencies; drive Chrome directly over CDP

**Status:** Accepted
**Date:** 2026-01

## Context

The build brief asks for a Playwright/CDP runner across six device profiles. The
obvious implementation is `npm i playwright`, and for a product team that is
almost always the right call.

This is not a product team. It is a proof-of-work artifact whose entire value is
that a reader can clone it and run it, and whose secondary value is that the
reader can *see* how the measurement works. Two things follow.

First, a `node_modules` tree of several hundred megabytes and a browser download
step is a real barrier between "I saw the repo" and "I ran the repo". Every step
between those two loses readers.

Second — and this is the larger reason — the interesting claims of this project
are all measurement claims: *the first frame was non-blank at 812ms*, *this
session reproduces*, *the diff is perceptual, not pixel-exact*. When a test
harness is a dependency, the reader has to take the measurement on faith or go
read someone else's library. When the harness is 350 lines of RFC 6455 and a
hand-written PNG codec in the same repo, the measurement is auditable in an
afternoon.

There is a cost to this and it is not small. It is discussed honestly below.

## Decision

**Zero runtime dependencies and zero dev dependencies.** `package.json` has empty
`dependencies` and `devDependencies` objects and they stay empty.

The stack is Node's standard library on Node ≥ 18.17:

| Need | Implementation | Instead of |
|------|----------------|-----------|
| Browser automation | CDP over a WebSocket, [`src/runner/cdp.js`](../../src/runner/cdp.js) | Playwright / Puppeteer |
| WebSocket client | RFC 6455 on `node:net`, [`src/runner/ws.js`](../../src/runner/ws.js) | `ws` |
| Screenshot encode/decode | `node:zlib` + PNG chunks, [`src/image/png.js`](../../src/image/png.js) | `pngjs`, `sharp` |
| Image comparison | [`src/image/diff.js`](../../src/image/diff.js) | `pixelmatch`, `odiff` |
| Test runner | `node:test` | Jest, Vitest |
| Types | JSDoc + [`types/atlas.d.ts`](../../types/atlas.d.ts), checked by `tsc --checkJs` | a TypeScript build step |
| Hashing | `node:crypto` | — |
| HTTP for the experience | `node:http`, [`src/runner/server.js`](../../src/runner/server.js) | Express, Vite |

Chrome itself is not vendored. The runner discovers an already-installed Chrome
or Edge and launches it with `--remote-debugging-port`; `node bin/atlas.js doctor`
reports what it found before anything else is attempted.

Device emulation uses the CDP domains directly —
`Emulation.setDeviceMetricsOverride`, `Emulation.setCPUThrottlingRate`,
`Network.emulateNetworkConditions` — which is what the higher-level libraries
call underneath anyway.

## Consequences

**Good.** `git clone && node bin/atlas.js doctor` works on a machine with nothing
but Node and a Chrome install. The test suite runs in seconds with no install
step. There is no supply chain: nothing in this repo can be compromised by a
transitive package update, which matters more than usual for an artifact whose
whole job is to be handed to strangers and run.

**Good, and load-bearing.** Because the harness is readable, the measurement
claims are checkable. `tests/image.test.js` exists precisely because the usual
argument for not testing a codec — *it's a well-known library* — does not apply
here.

**Costly.** Several things Playwright does well are simply absent:

- No auto-waiting, no actionability checks, no retry-on-flake. Driving the page
  ([`src/runner/drive.js`](../../src/runner/drive.js)) is explicit polling
  against the experience's own state machine.
- No cross-browser support. This is Chrome/Edge only, and the profiles are
  **emulated**, not real devices. That limitation is stated in the README and is
  not fixable without a device lab — see the README's "What was emulated" section,
  which is deliberately specific about what this does and does not prove.
- No trace viewer, no video, no network HAR. What exists instead is the flight
  recorder, which records less but records it in a schema this project controls.
- Hand-written protocol code is where bugs live. `tests/ws.test.js` connects the
  client to a real socket and tests handshake, fragmentation, masking, control
  frames, chunk boundaries and the payload cap, because a subtle framing bug here
  would surface three layers up as "Chrome didn't respond".

**Reversible.** If this ever became a product harness, adopting Playwright would
be a contained change: it would replace `src/runner/{ws,cdp,session}.js` and
nothing else. The manifest, the decision layer, the trace schema, the replay
check and the gate never touch CDP.

## Alternatives considered

**Playwright.** The right answer for a team that ships this. Rejected here purely
on the clone-and-run and auditability grounds above — not because of any
technical deficiency.

**Puppeteer.** Same trade, smaller dependency tree, still a browser download.

**`ws` as the single exception.** Tempting, and it would have removed the riskiest
file in the repo. Rejected because "zero dependencies" is a property that stops
being true the first time it is violated, and because a dependency boundary at
exactly one package is the least defensible place to draw the line.

**Deno or Bun**, which bundle more of this. Rejected because Node is what a
reviewer already has.
