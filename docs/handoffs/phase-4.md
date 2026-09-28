# Handoff: Phase 4 — real devices and production monitoring

**Status: not implemented; deliberately later than the browser control plane.**
Current profiles are Chrome/CDP emulations. No physical Android, iPhone Safari,
device farm, production probe, or field telemetry lane has been measured.

## Device lane

1. Establish customer demand and supported-browser questions before selecting
   a farm/vendor or buying hardware. Obtain explicit approval before opening
   accounts, spending, or starting subscriptions.
2. Specify a bounded first matrix: named low/mid Android devices and iPhones,
   exact hardware model, OS, browser/version, farm provenance, viewport, and
   available camera/XR/network APIs. Distinguish browser-based WebAR from
   installed native AR/VR apps.
3. Execute cold/warm repeats with run counts chosen to estimate variance. Record
   failures, confidence intervals, device/farm provenance, network source,
   permission state, and the exact build/contract. Compare against Chromium
   emulation and report lab/device drift rather than merging the lanes.
4. Only claim physical camera, XR, radio, thermal, battery, or GPU behavior if
   that exact feature was exercised on the named device and the artifact
   collection supports the claim. Raw media remains opt-in and is not stored by
   default.

## Production monitoring lane

Design separately as an opt-in, privacy-bounded probe. Define consent, coarse
device buckets, event schema, sampling/budget or explicitly costed coverage,
aggregation and incident clustering, retention/purge, regional processing,
alerts, access controls, and lab-vs-field comparison before collection. Avoid
UA/IP/device IDs, fingerprints, raw camera/audio, customer credentials, and
query-string tokens in telemetry. Provide opt-out and deletion paths and get
qualified legal/privacy review before promises about jurisdiction or region.

## Acceptance and evidence

For device coverage, publish the precise supported device/OS/browser matrix and
measured repeats, including failures and confidence intervals; do not promise
universal coverage. For field monitoring, demonstrate a real authorized pilot
failure that the lab missed, with sanitized evidence and a regression test. If
no field failure is observed, state that no such proof exists. Production
monitoring is not complete when only a schema or dashboard exists.

## Current repo entry points and constraints

- Emulated profiles and synthetic WebXR: `src/runner/profiles.js` and
  `src/runner/xr-stub.js`.
- Browser evidence/trace privacy: `PRIVACY.md`, `src/trace/`,
  `src/runner/`.
- Phase 2 is not hosted-safe yet; do not add device-farm credentials to the
  current local API or queue. Complete Phase 2 isolation, storage, tenancy,
  consent, and retention gates first.
- No device farm, monitoring vendor, field user study, or performance evidence
  exists in this repository at handoff.
