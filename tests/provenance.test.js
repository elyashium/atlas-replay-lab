import test from "node:test";
import assert from "node:assert/strict";
import {
  LANES,
  LANE_CLAIMS,
  PROFILE_FIDELITY,
  PROVENANCE_VERSION,
  assertDeviceClaim,
  provenanceFor,
  provenanceSummary,
} from "../src/runner/provenance.js";
import { PROFILES } from "../src/runner/profiles.js";

test("every profile in the runner lands in a lane, and none lands in device", () => {
  for (const profile of PROFILES) {
    const p = provenanceFor(profile);
    assert.ok(LANES.includes(p.lane), `${profile.id} produced lane ${p.lane}`);
    assert.equal(p.physicalDevice, false, `${profile.id} must not claim a physical device`);
    assert.equal(p.deviceModel, null);
    assert.equal(p.provenanceVersion, PROVENANCE_VERSION);
  }
});

test("the xr profiles are synthetic-xr and the rest are emulation", () => {
  const byLane = {};
  for (const profile of PROFILES) {
    const lane = provenanceFor(profile).lane;
    (byLane[lane] ??= []).push(profile.id);
  }
  assert.deepEqual(byLane["synthetic-xr"], ["xr-granted", "xr-denied"]);
  assert.ok(byLane.emulation.length >= 6);
  assert.ok(!byLane.emulation.some((id) => id.startsWith("xr-")));
});

test("a caller cannot pick the flattering lane", () => {
  // The lane comes from the profile. The only way to reach `device` is to name
  // a physical model, which is a thing a human does on purpose.
  // @ts-expect-error deliberately passing an unsupported option
  const forced = provenanceFor({ id: "mid-android-4g" }, { lane: "device", physicalDevice: true });
  assert.equal(forced.lane, "emulation");
  assert.equal(forced.physicalDevice, false);
});

test("naming a device model is the only route to the device lane", () => {
  const p = provenanceFor({ id: "mid-android-4g" }, { deviceModel: "Pixel 6a / Android 14" });
  assert.equal(p.lane, "device");
  assert.equal(p.physicalDevice, true);
  assert.equal(p.deviceModel, "Pixel 6a / Android 14");
  // Fidelity notes describe emulation; on a real device they would be a lie.
  assert.equal(p.fidelity, null);
});

test("emulated provenance separates what the browser enforces from what is injected", () => {
  const p = provenanceFor({ id: "low-cpu-3g" });
  assert.equal(p.fidelity, PROFILE_FIDELITY);
  // Flattening a profile to "simulated" would imply the CPU throttling is fake.
  assert.match(p.fidelity.applied.join(" "), /cpuThrottleRate/);
  assert.match(p.fidelity.injected.join(" "), /deviceMemory/);
  assert.match(p.fidelity.absent.join(" "), /[Tt]hermal/);
  // The three sets must not overlap, or the distinction carries no information.
  const applied = new Set(p.fidelity.applied.map((s) => s.split(" ")[0]));
  for (const line of p.fidelity.injected) assert.ok(!applied.has(line.split(" ")[0]), line);
});

test("the fidelity tables are frozen", () => {
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to test the freeze
    PROFILE_FIDELITY.absent.push("thermal throttling is modelled");
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to test the freeze
    LANE_CLAIMS.emulation.doesNotSupport = "nothing";
  }, TypeError);
});

/* ── the refusal ─────────────────────────────────────────────────────────── */

test("a device claim built from emulated runs throws", () => {
  const runs = PROFILES.slice(0, 3).map((p) => provenanceFor(p));
  assert.throws(
    () => assertDeviceClaim(runs, "sustains 52fps on mid-range Android"),
    (err) => {
      assert.match(err.message, /refusing to make the device claim/);
      assert.match(err.message, /sustains 52fps on mid-range Android/);
      assert.match(err.message, /3 of 3/);
      assert.match(err.message, /device lane is not implemented/);
      return true;
    },
  );
});

test("one emulated run poisons an otherwise-device set", () => {
  // The mixed case is the dangerous one: the device rows lend credibility to
  // the emulated row, and the aggregate reads as a device result.
  const set = [
    provenanceFor({ id: "high-wifi" }, { deviceModel: "Pixel 6a" }),
    provenanceFor({ id: "mid-android-4g" }),
  ];
  assert.throws(() => assertDeviceClaim(set, "works across the matrix"), /1 of 2/);
});

test("an all-device set is allowed", () => {
  const set = [
    provenanceFor({ id: "high-wifi" }, { deviceModel: "Pixel 6a" }),
    provenanceFor({ id: "mid-android-4g" }, { deviceModel: "Galaxy A14" }),
  ];
  assert.equal(assertDeviceClaim(set, "ran on two handsets"), true);
});

test("missing provenance is refused, not assumed benign", () => {
  assert.throws(() => assertDeviceClaim(null, "x"), /no provenance was recorded/);
  assert.throws(() => assertDeviceClaim([], "x"), /no provenance was recorded/);
});

test("a single provenance object is accepted without wrapping", () => {
  assert.throws(() => assertDeviceClaim(provenanceFor({ id: "high-wifi" }), "on device"), /1 of 1/);
});

/* ── the summary sentence ────────────────────────────────────────────────── */

test("a single-lane report gets a sentence naming the lane and its limit", () => {
  const s = provenanceSummary(PROFILES.filter((p) => !p.id.startsWith("xr-")).map((p) => provenanceFor(p)));
  assert.match(s, /^All results in this report are emulation/);
  assert.match(s, /physical handset/);
});

test("a mixed-lane report is warned about explicitly", () => {
  const s = provenanceSummary([
    provenanceFor({ id: "high-wifi" }),
    provenanceFor({ id: "xr-granted" }),
  ]);
  assert.match(s, /mixes emulation and synthetic-xr/);
  assert.match(s, /do not aggregate across lanes/);
});

test("no provenance at all says so rather than returning an empty string", () => {
  assert.equal(provenanceSummary([]), "No provenance was recorded for these results.");
  assert.match(provenanceSummary([null, undefined]), /No provenance was recorded/);
});
