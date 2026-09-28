# Device matrix

**Status: empty. No physical device has ever run an Atlas session.**

This file exists so that the absence is a recorded fact rather than an omission a
reader has to notice. Everything in `artifacts/` was produced by Chromium
emulation on a developer or CI host. The lane is stamped on every run row as
`provenance.lane` (`src/runner/provenance.js`) and summarised per report under
`provenance.summary`.

## Tested lanes

| lane | runs to date | surface |
| --- | --- | --- |
| `emulation` | all non-`xr-*` profiles | Chromium with CDP CPU throttling and network shaping, plus injected hardware hints |
| `synthetic-xr` | `xr-granted`, `xr-denied` | the above plus Atlas's own `navigator.xr` (`src/runner/xr-stub.js`) |
| `device` | **none** | — |

## What the emulation lane genuinely applies

Chromium really enforces these; they are not pretend numbers.

- `cpuThrottleRate` — `Emulation.setCPUThrottlingRate`; the page really executes that much slower.
- network throughput and latency — `Network.emulateNetworkConditions`; the connection is really shaped.
- viewport and `deviceScaleFactor` — the page really lays out at that size.
- camera permission grant/denial — really granted or denied.
- WebGL availability — the context really is unavailable when disabled.
- `prefers-reduced-motion` — the media query really matches.

## What is injected, not enforced

Handed to the page so its capability probe sees a plausible device. A result that
depends on one of these depends on a value Atlas made up.

- `navigator.deviceMemory` — a number, not a memory limit.
- `navigator.hardwareConcurrency` — the real core count is the host's.
- `navigator.connection` — independent of the shaping above.
- GPU tier — the real GPU is the host's.

## What is absent entirely

No amount of care in the emulation lane produces these. They are the reason the
device lane is not optional for a claim about a handset.

- **Thermal throttling.** A real phone slows over minutes of AR use. Nothing here models that, so every Atlas frame-rate number is a cold-start number.
- **Real GPU drivers and their bugs.** The host GPU is not the handset GPU. Driver-specific shader failures — a large share of real AR breakage — cannot appear.
- **Memory pressure and OS eviction.** A backgrounded tab on a 4 GB Android device gets killed; here it does not.
- **Real radio behaviour.** Handover, congestion and loss patterns beyond the shaped profile.
- **Battery state** and its effect on clocks.
- **Tracking quality, pose latency, plane detection, lighting estimation.** The `xr-*` profiles run a scripted pose. A scripted pose is a scripted pose.

## Consequence for reporting

`assertDeviceClaim()` throws if any measurement in the set is not
`physicalDevice: true`. Because no run is, **any** device claim assembled from
current artifacts fails — by construction, not by convention. That is the
intended behaviour until this table has rows.

Phrases that are false about every artifact in this repository:

- "tested on mid-range Android"
- "runs at 52 fps on device"
- "verified across the device matrix"

Phrases that are true:

- "held its adaptive tier under 4× CPU throttling and a shaped 4G connection in Chromium"
- "the degrade ladder fired at the tier the policy predicted"
- "the app's XR refusal path executes and reaches its declared fallback"

## What standing this lane up would need

Not a plan, an inventory — none of it is authorized or budgeted, and per the
Phase 4 handoff none of it may be attached to the current local API or queue.

1. A funded device farm account, or physical handsets plus a host to drive them. **Requires the user's explicit authorization to open an account or spend money** (`docs/handoffs/README.md`, rule 5).
2. Per-device provenance: model, OS build, browser build, thermal state at session start, and whether the unit was plugged in — a warm plugged-in phone and a cold one on battery are different devices for this purpose.
3. A separate isolation and credential boundary. Device-farm credentials must not enter the current local control plane or job queue.
4. A statement of sample size per device. One run on one handset is an anecdote and must be reported as one.

Until items 1–4 exist, the honest number of devices tested is zero, and this
file says so.
