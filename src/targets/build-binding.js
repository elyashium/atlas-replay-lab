/**
 * Target-build binding: which exact bits a verdict is about.
 *
 * Phase 3 item 2: "Define a target-build binding: repository/commit or immutable
 * build URL, allowed staging target, contract version, profiles, policy version,
 * and Atlas engine/browser build versions. Reject ambiguous/mutable build labels
 * where they cannot identify the tested bits."
 *
 * ## The problem this solves
 *
 * `validateTargetContract` accepts any `target.buildId` matching
 * `/^[a-z0-9._-]{1,128}$/i`. That happily accepts `latest`, `main`, `staging`
 * and `v2`. A stored `SHIP` against `buildId: "latest"` says a run passed
 * against whatever was deployed at some unrecorded moment — which is not a
 * statement about any particular build, and therefore not a release gate. It is
 * worse than no label, because it looks like one.
 *
 * The distinction is **mutable vs. immutable**, not long vs. short. A 40-char
 * commit SHA identifies bits forever. `main` identifies different bits every
 * time someone merges. A gate that cannot name the bits it tested cannot be
 * cited later, and citing it later is the entire point.
 *
 * ## What counts as immutable
 *
 * Accepted: git SHAs (7–40 hex), content hashes prefixed `sha256:`, semver with
 * a patch component (`1.4.2`, `1.4.2-rc.1` — a published release is immutable by
 * convention and by registry policy), and build numbers with a monotonic
 * component (`build-4821`, `2026-09-28.3`). Each of these, handed to a person
 * six months later, resolves to one artifact.
 *
 * Refused: bare branch and channel names, `latest`, `current`, `stable`, `prod`,
 * `HEAD`, semver without a patch (`v2`, `1.4`), and anything the classifier
 * cannot place. Unknown is refused, not accepted — the same fail-closed rule the
 * rest of this codebase uses, for the same reason: a label nobody can classify
 * is a label nobody can resolve.
 *
 * ## Deliberately advisory in one place
 *
 * `buildId` stays optional in `validateTargetContract`. A local operator running
 * their own dev server has no build id and should not be blocked from using the
 * tool. The rule is: **absent is allowed, mutable is refused.** A contract that
 * declares nothing makes no claim; a contract that declares `latest` makes a
 * false one. `requireImmutableBuild()` is the stricter mode for a submitted run
 * that will be archived as evidence.
 */

import { sha256 } from "../util/hash.js";

export const BUILD_BINDING_VERSION = 1;

/**
 * Labels that name a moving pointer rather than a build. Matched case-
 * insensitively against the whole id, so `main` is refused and `main-4821` —
 * which carries a monotonic component — is not.
 */
const MUTABLE_LABELS = new Set([
  "latest", "current", "stable", "edge", "canary", "nightly", "dev", "development",
  "prod", "production", "staging", "stage", "test", "qa", "preview", "next",
  "main", "master", "trunk", "head", "default", "release", "rolling", "live",
]);

/** 7–40 hex characters: a git object name, abbreviated or full. */
const GIT_SHA = /^[0-9a-f]{7,40}$/i;
/** An explicit content hash. */
const CONTENT_HASH = /^sha(?:1|256|512):[0-9a-f]{8,128}$/i;
/** Semver with a patch component; a `v` prefix is tolerated. */
const SEMVER_PATCH = /^v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i;
/** Something ending in a monotonic counter or a dated sequence. */
const MONOTONIC = /^[a-z0-9._-]*?[-._]\d{2,}(?:\.\d+)*$/i;
/** `2026-09-28`, `2026-09-28.3`, `20260928-1412`. */
const DATED = /^\d{4}-?\d{2}-?\d{2}([-._]\d+)*$/;

/**
 * @typedef {object} BuildLabelVerdict
 * @property {boolean} immutable   whether the label identifies one artifact forever
 * @property {string} kind         git-sha | content-hash | semver | monotonic | dated | mutable-label | unclassified | absent
 * @property {string} why          one sentence, suitable for an error message
 */

/**
 * Classify a build label without resolving it. Pure and offline: this asks
 * whether a label *could* identify fixed bits, never whether those bits exist.
 *
 * @param {unknown} buildId
 * @returns {BuildLabelVerdict}
 */
export function classifyBuildLabel(buildId) {
  if (buildId === undefined || buildId === null || buildId === "") {
    return { immutable: false, kind: "absent", why: "no build label was declared" };
  }
  if (typeof buildId !== "string") {
    return { immutable: false, kind: "unclassified", why: "build label must be a string" };
  }
  const id = buildId.trim();
  if (!id) return { immutable: false, kind: "absent", why: "no build label was declared" };

  if (MUTABLE_LABELS.has(id.toLowerCase())) {
    return {
      immutable: false,
      kind: "mutable-label",
      why: `"${id}" names a moving pointer, not a build — it resolves to different bits over time`,
    };
  }
  if (CONTENT_HASH.test(id)) {
    return { immutable: true, kind: "content-hash", why: "an explicit content hash identifies exact bytes" };
  }
  if (GIT_SHA.test(id)) {
    return { immutable: true, kind: "git-sha", why: "a git object name identifies one commit permanently" };
  }
  if (SEMVER_PATCH.test(id)) {
    return { immutable: true, kind: "semver", why: "a published semver release with a patch component is immutable by convention" };
  }
  // Checked before the monotonic rule, which would otherwise read the `.42` in
  // `1.42` as a build counter. Semver without a patch is the most common
  // near-miss and deserves its own sentence: `v2` looks like a version and
  // behaves like a branch.
  if (/^v?\d+(\.\d+)?$/.test(id)) {
    return {
      immutable: false,
      kind: "mutable-label",
      why: `"${id}" is a version series, not a version — v2 today and v2 next month are different bits`,
    };
  }
  if (DATED.test(id)) {
    return { immutable: true, kind: "dated", why: "a dated build sequence identifies one build" };
  }
  if (MONOTONIC.test(id)) {
    return { immutable: true, kind: "monotonic", why: "a monotonic build counter identifies one build" };
  }
  return {
    immutable: false,
    kind: "unclassified",
    why: `"${id}" cannot be recognised as a commit, content hash, release version or build number`,
  };
}

/**
 * The full binding for a submitted run: what was tested, against which bar,
 * with which engine.
 *
 * Every field is recorded even when it is null, because a null that is present
 * in the artifact is a statement ("no browser build was recorded") and a missing
 * key is an ambiguity. `bindingHash` covers the whole set so two runs can be
 * compared for identity in one equality check.
 *
 * @param {{
 *   contract: any;
 *   policy: { id: string; version: string; contentHash: string };
 *   engine?: { name?: string | null; version?: string | null } | null;
 *   browser?: { product?: string | null; revision?: string | null } | null;
 *   repository?: { url?: string | null; commit?: string | null } | null;
 * }} input
 */
export function buildBinding(input) {
  const contract = input.contract ?? {};
  const buildId = contract.target?.buildId ?? null;
  const label = classifyBuildLabel(buildId);

  const binding = {
    bindingVersion: BUILD_BINDING_VERSION,
    build: {
      id: buildId,
      immutable: label.immutable,
      kind: label.kind,
      why: label.why,
    },
    repository: {
      url: input.repository?.url ?? null,
      commit: input.repository?.commit ?? null,
    },
    target: {
      url: contract.target?.url ?? null,
      allowedOrigins: contract.target?.allowedOrigins ?? null,
      environment: contract.environment ?? null,
    },
    contract: {
      id: contract.id ?? null,
      schemaVersion: contract.schemaVersion ?? null,
      policyVersion: contract.policy?.version ?? null,
      profiles: contract.profiles ?? null,
      criticalProfiles: contract.policy?.criticalProfiles ?? null,
    },
    releasePolicy: {
      id: input.policy?.id ?? null,
      version: input.policy?.version ?? null,
      contentHash: input.policy?.contentHash ?? null,
    },
    atlas: {
      engine: input.engine?.name ?? null,
      engineVersion: input.engine?.version ?? null,
      browser: input.browser?.product ?? null,
      browserRevision: input.browser?.revision ?? null,
    },
  };

  return { ...binding, bindingHash: sha256(binding, 16) };
}

/**
 * Gate a submitted run on the binding being unambiguous.
 *
 * Returns issues rather than throwing, so a caller can report every problem at
 * once instead of one per attempt, and so a refusal can be written into a report
 * next to its reason.
 *
 * `allowAbsentBuildId` exists for the local case: an operator pointed at their
 * own dev server genuinely has no build to name, and refusing them would make
 * the tool unusable for the one workflow that is known-safe today. It defaults
 * to false because a run being archived as release evidence must name its bits.
 *
 * @param {ReturnType<typeof buildBinding>} binding
 * @param {{ allowAbsentBuildId?: boolean; requireRepository?: boolean; requireBrowser?: boolean }} [opts]
 * @returns {{ ok: boolean; issues: string[] }}
 */
export function requireImmutableBuild(binding, opts = {}) {
  /** @type {string[]} */
  const issues = [];
  const { build } = binding;

  if (build.kind === "absent") {
    if (!opts.allowAbsentBuildId) {
      issues.push(
        "target.buildId is required for a submitted run: a verdict that cannot name the bits it " +
          "tested cannot be cited later. Use a commit SHA, a content hash, a released version, or " +
          "a build number.",
      );
    }
  } else if (!build.immutable) {
    issues.push(`target.buildId is not immutable — ${build.why}`);
  }

  if (binding.target.environment && !["development", "staging"].includes(binding.target.environment)) {
    issues.push(`environment "${binding.target.environment}" is not an authorized staging target`);
  }
  if (!binding.contract.policyVersion) issues.push("contract policy.version is required in a submitted run");
  if (!binding.releasePolicy.version || !binding.releasePolicy.contentHash) {
    issues.push("the release policy version and content hash must be stamped into a submitted run");
  }
  if (!binding.contract.criticalProfiles?.length) {
    issues.push("contract policy.criticalProfiles must name the profiles the verdict depends on");
  }

  // Repository and browser identity are recorded always and required only when
  // the caller says this run is release evidence. The Atlas engine version is
  // always required: without it, a verdict cannot be reproduced even in
  // principle, because the rules that produced it are not identified.
  if (!binding.atlas.engine) issues.push("the Atlas engine identity must be recorded");
  if (opts.requireRepository && !(binding.repository.url && binding.repository.commit)) {
    issues.push("repository url and commit are required for this run");
  }
  if (opts.requireBrowser && !(binding.atlas.browser && binding.atlas.browserRevision)) {
    issues.push("browser product and revision are required for this run");
  }

  return { ok: issues.length === 0, issues };
}
