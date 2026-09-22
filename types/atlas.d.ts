/**
 * Atlas Replay Lab — shared type contracts.
 *
 * These declarations are the authoritative schema for the manifest, the
 * capability snapshot, the decision layer and the flight-recorder trace.
 * Runtime code is ESM JavaScript annotated with JSDoc that imports from here,
 * so `tsc --checkJs` type-checks the whole project against this file without
 * the project needing a build step or any runtime dependency.
 *
 * See docs/adr/0002-zero-dependency-runtime.md for why it is shaped this way.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Capability                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export type GpuTier = "unknown" | "none" | "low" | "mid" | "high";
export type CameraPermission = "granted" | "denied" | "prompt" | "unavailable";
export type EffectiveConnectionType = "slow-2g" | "2g" | "3g" | "4g" | "unknown";

/**
 * The exact state object handed to the decision layer. Produced by the
 * on-device capability probe. Contains no identifiers, no user agent string,
 * no canvas/font/audio fingerprint, and no raw sensor data — see PRIVACY.md.
 */
export interface CapabilitySnapshot {
  deviceMemoryGB: number | null;
  hardwareConcurrency: number | null;
  gpuTier: GpuTier;
  webglVersion: 0 | 1 | 2;
  webgpuAvailable: boolean;
  webcodecsAvailable: boolean;
  cameraPermission: CameraPermission;
  effectiveConnectionType: EffectiveConnectionType;
  downlinkMbps: number | null;
  rttMs: number | null;
  reducedMotionPreferred: boolean;
  viewport: { width: number; height: number };
  /** p95 frame time observed so far this session; null before first frames. */
  recentFrameTimeMsP95: number | null;
}

/**
 * Coarse, non-identifying bucket derived from a snapshot. Every report and
 * dashboard aggregates by this, never by the raw snapshot.
 */
export interface CapabilityBucket {
  compute: "weak" | "moderate" | "strong";
  network: "poor" | "fair" | "good";
  graphics: "none" | "basic" | "accelerated";
  camera: "usable" | "blocked";
  /** Stable string form, e.g. "weak/poor/basic/usable". */
  id: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Manifest                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export type TierId = "high" | "mid" | "low";
export type ServeTier = TierId | "static-fallback";
export type PathId = "camera-xr" | "interactive-2d" | "static-safe";

export type CapabilityRequirement =
  | "webgl1"
  | "webgl2"
  | "webgpu"
  | "webcodecs"
  | "camera"
  | "motion";

export interface VisualInvariant {
  id: string;
  description: string;
  /** Fraction of the viewport the focal product layer must occupy, minimum. */
  minFocalCoverage: number;
  /** Max mean alpha-edge instability across checkpoints, 0..1. */
  maxAlphaEdgeDrift: number;
  /** A blank/near-blank first frame is always a visual invariant failure. */
  forbidBlankFirstFrame: true;
}

export interface InteractionInvariant {
  id: string;
  description: string;
  p95TapResponseMs: number;
  maxDroppedFrameRatio: number;
  /** Legal state transitions of the experience state machine. */
  allowedTransitions: Array<[ExperienceState, ExperienceState]>;
}

export interface BusinessInvariant {
  id: string;
  description: string;
  /** Terminal state the session must be able to reach. */
  endState: ExperienceState;
  maxStepsToEndState: number;
}

export interface Budgets {
  firstFrameMs: number;
  timeToInteractiveMs: number;
  p95InteractionMs: number;
  maxDroppedFrameRatio: number;
  maxTransferBytes: number;
  maxJsHeapMB: number;
}

export interface TierSpec {
  id: TierId;
  label: string;
  /** Renderer knobs consumed by the experience runtime. */
  params: {
    particleCount: number;
    textureSize: 256 | 512 | 1024;
    shaderPasses: number;
    targetFps: 30 | 60;
    /** Synthetic per-frame CPU work (ms) representing real shading cost. */
    perFrameWorkMs: number;
  };
  assets: AssetSpec[];
  requires: CapabilityRequirement[];
}

export interface AssetSpec {
  id: string;
  url: string;
  /**
   * `"document"` is the generic-ingestion case: a `--url` run does not know
   * the visitor's files, so each tier declares one payload envelope instead of
   * a file list, and the real per-asset events come from the probe's resource
   * timing. See `src/manifest/generic.manifest.js`.
   */
  kind: "texture" | "geometry" | "audio" | "poster" | "document";
  /** Declared size; verified against the real file by `atlas assets --verify`. */
  approxBytes: number;
  critical: boolean;
}

export interface FallbackPath {
  id: PathId;
  label: string;
  requires: CapabilityRequirement[];
  /** Ordered: first path whose requirements are satisfied wins. */
  priority: number;
  description: string;
}

export interface PrivacyRule {
  collect: string[];
  neverCollect: string[];
  retentionDays: number;
  /** Named redaction strategies applied by the recorder before a trace leaves the page. */
  redaction: string[];
  /** Default posture for sending traces to any third party (including Jev). */
  thirdPartyTraceEgress: "off-by-default" | "opt-in" | "on";
}

export interface ExperienceManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  title: string;
  /** Filled in by `hashManifest()`; content-addresses everything above. */
  contentHash: string;
  invariants: {
    visual: VisualInvariant;
    interaction: InteractionInvariant;
    business: BusinessInvariant;
  };
  budgets: Budgets;
  tiers: TierSpec[];
  fallbackPaths: FallbackPath[];
  checkpoints: CheckpointSpec[];
  privacy: PrivacyRule;
}

export interface CheckpointSpec {
  id: string;
  /** State whose entry triggers the checkpoint screenshot. */
  onState: ExperienceState;
  description: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Experience state machine                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every state either manifest's transition graph can name.
 *
 * The first block is Orbital's flow. The second is the generic spine a `--url`
 * run walks (`docs/showcase-roadmap.md` Slice 1): a third-party app has no
 * cart and no checkout, so `session-complete` is what stands in for the
 * business end state. Note that generic runs never enter `routing` — Atlas
 * routes Orbital and only observes everyone else.
 */
export type ExperienceState =
  | "boot"
  | "probing"
  | "routing"
  | "loading"
  | "first-frame"
  | "interactive"
  | "product-detail"
  | "cart"
  | "checkout-complete"
  | "degraded"
  | "error"
  /* generic ingestion */
  | "looking"
  | "xr-session"
  | "session-complete";

/* ────────────────────────────────────────────────────────────────────────── */
/* Decision layer                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export type RootCause =
  | "network"
  | "memory"
  | "permission-denied"
  | "codec-unsupported"
  | "render-stall"
  | "manifest-bug"
  | "unknown";

export type TraceOutcome = "pass" | "degraded-but-acceptable" | "fail" | "inconclusive";

/** Mirrors a Jev `choice` answer: the pick plus the full distribution. */
export interface ChoiceAnswer<T extends string = string> {
  value: T;
  distribution: Record<string, number>;
}

/** Mirrors a Jev `score` answer: fractional score plus the level distribution. */
export interface ScoreAnswer {
  /** Fractional position on the rubric, 0..levels.length-1. */
  score: number;
  levels: string[];
  distribution: Record<string, number>;
}

/** Mirrors a Jev `noul` answer: a single P(true). */
export interface NoulAnswer {
  pTrue: number;
}

export interface TierDecision {
  tier: ServeTier;
  tierAnswer: ChoiceAnswer<ServeTier>;
  cameraPathSafe: NoulAnswer;
  firstFrameRisk: ScoreAnswer;
  /** Resolved fallback path, derived from tier + capability, not asked of the model. */
  path: PathId;
  /** Engine-reported confidence in [0,1]; the guard thresholds on this. */
  confidence: number;
  engine: string;
  /**
   * Human-readable reasons. Always empty for the Jev engine: Jev emits typed
   * answers only and cannot produce text (see docs/adr/0006).
   */
  rationale: string[];
  /** Set by GuardedDecisionEngine when it overrode a low-confidence answer. */
  guard?: GuardReport;
}

export interface TraceVerdict {
  outcome: ChoiceAnswer<TraceOutcome>;
  rootCause: ChoiceAnswer<RootCause>;
  releaseBlocking: ScoreAnswer;
  visualInvariantHeld: NoulAnswer;
  interactionInvariantHeld: NoulAnswer;
  businessInvariantHeld: NoulAnswer;
  confidence: number;
  engine: string;
  rationale: string[];
  guard?: GuardReport;
}

export interface GuardReport {
  primaryEngine: string;
  primaryConfidence: number;
  threshold: number;
  overridden: boolean;
  reason: string;
  /** What the primary engine answered before the override, for the report. */
  primaryAnswer?: unknown;
  error?: string;
}

export interface DecisionContext {
  manifest: ExperienceManifest;
  /** Where this state came from — identical code path either way (see §4.1). */
  origin: "ci-matrix" | "production";
  profileId?: string;
}

/** The single interface the rest of Atlas programs against. */
export interface DecisionEngine {
  readonly name: string;
  readonly kind: "deterministic" | "model" | "guarded";
  routeTier(state: CapabilitySnapshot, ctx: DecisionContext): Promise<TierDecision>;
  judgeTrace(trace: Trace, ctx: DecisionContext): Promise<TraceVerdict>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Flight recorder trace (OTel-shaped)                                         */
/* ────────────────────────────────────────────────────────────────────────── */

export type TraceEventKind =
  | "lifecycle"
  | "asset"
  | "state"
  | "interaction"
  | "frame"
  | "decision"
  | "error";

export interface TraceEvent {
  /** Monotonic offset from trace start, ms, quantized. Never a wall clock. */
  tOffsetMs: number;
  name: string;
  kind: TraceEventKind;
  attributes: Record<string, string | number | boolean | null>;
}

export interface TraceMetrics {
  firstFrameMs: number | null;
  timeToInteractiveMs: number | null;
  p50InteractionMs: number | null;
  p95InteractionMs: number | null;
  interactionCount: number;
  framesRendered: number;
  framesDropped: number;
  droppedFrameRatio: number | null;
  transferBytes: number;
  assetFailures: number;
  jsHeapUsedMB: number | null;
  reachedEndState: boolean;
  stepsToEndState: number | null;
  firstFrameNonBlank: boolean | null;
}

export interface TraceCheckpoint {
  id: string;
  tOffsetMs: number;
  state: ExperienceState;
  /** Repo-relative path of the captured PNG, if the runner captured one. */
  screenshotPath: string | null;
  /**
   * Coverage of the focal product layer at this checkpoint, 0..1. Measured on
   * the Node side from the decoded screenshot — never in the page. Null when no
   * screenshot was captured or it could not be decoded.
   */
  focalCoverage: number | null;
  /** Mean alpha-edge instability vs. the previous checkpoint, 0..1. Null at the first. */
  alphaEdgeDrift: number | null;
}

export interface Trace {
  schemaVersion: 1;
  traceId: string;
  /** OTel-style resource attributes: what produced this trace. */
  resource: {
    "service.name": string;
    "service.version": string;
    "atlas.manifest.id": string;
    "atlas.manifest.version": string;
    "atlas.manifest.hash": string;
    "atlas.profile.id": string;
    "atlas.run.kind": "baseline" | "adaptive" | "replay" | "production";
    /** True when device characteristics were emulated rather than real hardware. */
    "atlas.emulated": boolean;
    /**
     * The RNG seed the session ran under. Replay determinism is conditional on
     * this matching; it is deliberately NOT part of the determinism hash,
     * because it is a precondition of the comparison rather than a result of it.
     */
    "atlas.seed": number;
  };
  capability: CapabilitySnapshot;
  capabilityBucket: CapabilityBucket;
  decision: TierDecision | null;
  servedTier: ServeTier | null;
  servedPath: PathId | null;
  states: ExperienceState[];
  events: TraceEvent[];
  checkpoints: TraceCheckpoint[];
  metrics: TraceMetrics;
  /** Redacted, class-only record of input. Never raw text/camera/audio. */
  inputClasses: string[];
  /** sha256 over the normalized trace; the determinism assertion. */
  determinismHash: string;
  startedAtIso: string;
  durationMs: number;
  notes: string[];

  /* ── additive, generic-ingestion only (Slice 1) ─────────────────────────
   *
   * All three are optional, and all three are invisible to `normalizeTrace`,
   * which reads a closed set of top-level fields with a per-kind attribute
   * allow-list. That is deliberate and load-bearing: a trace captured before
   * these existed still validates, and adding them cannot perturb
   * `determinismHash` or `causalHash`. The causal *structure* of what they
   * describe is already in the hash as lifecycle and error events; these carry
   * the detail that legitimately differs run to run.
   */

  /**
   * Per-frame durations in ms, in order, from the page's `requestAnimationFrame`
   * loop. Capped at 3600 samples with a note when truncated. Never sent to a
   * model as a series — `summariseTraceForJev` compresses it to histogram
   * buckets first.
   */
  frameTimes?: number[];
  /** XR session lifecycle as the probe observed it, oldest first. */
  xrSessionEvents?: Array<{
    tOffsetMs: number;
    phase: "request" | "session-start" | "session-refused" | "session-end" | "unavailable";
    mode: string;
    error: string | null;
  }>;
  /**
   * Console errors, uncaught exceptions, rejections and context loss.
   * `message` is truncated and scrubbed of URLs and token-shaped runs; only
   * `code` is ever summarised for a model.
   */
  consoleErrors?: Array<{ tOffsetMs: number; code: string; message: string }>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Runner / gate / report                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export interface Profile {
  id: string;
  label: string;
  description: string;
  viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  cpuThrottleRate: number;
  network: {
    offline: boolean;
    downloadThroughputBps: number;
    uploadThroughputBps: number;
    latencyMs: number;
    packetLoss?: number;
    packetQueueLength?: number;
  } | null;
  /** Values injected into the page so the probe reports emulated hardware. */
  probeOverrides: {
    deviceMemoryGB?: number;
    hardwareConcurrency?: number;
    effectiveConnectionType?: EffectiveConnectionType;
    downlinkMbps?: number;
    rttMs?: number;
    gpuTier?: GpuTier;
  };
  cameraPermission: "granted" | "denied";
  /** Disable WebGL entirely to exercise the static-safe path. */
  disableWebgl: boolean;
  prefersReducedMotion: boolean;
  /** Profiles in this set must pass for the release gate to go green. */
  critical: boolean;
  /**
   * Inject Atlas's own synthetic `navigator.xr` (`src/runner/xr-stub.js`).
   *
   * Absent on the six original profiles, which is why they behave exactly as
   * before. `"granted"` resolves `requestSession`, `"denied"` rejects it with
   * a real `NotAllowedError` so the app's refusal path runs. Every run that
   * sets this records the stub's limits as a trace note — it is a lifecycle
   * and pose harness, not a headset.
   */
  xr?: "granted" | "denied";
}

export interface GateRule {
  id: string;
  description: string;
}

export interface GateFinding {
  ruleId: string;
  profileId: string;
  runKind: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  observed?: string | number | null;
  expected?: string | number | null;
}

export interface GateReport {
  ok: boolean;
  generatedAtIso: string;
  rules: GateRule[];
  findings: GateFinding[];
  summary: { pass: number; fail: number; skip: number };
}

export interface DiffResult {
  width: number;
  height: number;
  /** Fraction of pixels differing beyond the per-channel tolerance. */
  pixelDiffRatio: number;
  /** 1 = identical, 0 = maximally different. Coarse structural comparison. */
  perceptualScore: number;
  /** Bounding box of the largest differing region, or null if identical. */
  firstDivergenceBox: { x: number; y: number; w: number; h: number } | null;
  identical: boolean;
}

export interface EngineComparisonRow {
  subjectId: string;
  subjectKind: "capability-state" | "trace";
  ruleAnswer: string;
  modelAnswer: string | null;
  agree: boolean | null;
  modelConfidence: number | null;
  groundTruth: string | null;
  ruleCorrect: boolean | null;
  modelCorrect: boolean | null;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  observedAccuracy: number | null;
  observedAgreement: number | null;
}

export interface EngineComparisonReport {
  generatedAtIso: string;
  liveJev: boolean;
  jevStatus: string;
  rows: EngineComparisonRow[];
  agreementRate: number | null;
  ruleAccuracy: number | null;
  modelAccuracy: number | null;
  brierScore: number | null;
  calibration: CalibrationBin[];
  notes: string[];
}
