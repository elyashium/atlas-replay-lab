/**
 * Canonical preflight inputs — static asset measurements `atlas preflight`
 * would produce, frozen for fixtures.
 *
 * One input only, and deliberately mid-weight: against the generic manifest's
 * 12MB transfer budget it lands at an effective ratio of ~0.27, where the
 * rule-based assessment says "mid" and a reasonable model could say "high".
 * A canonical page that every engine trivially agrees on would prove nothing;
 * a borderline one exercises the guard's richness override in both directions
 * depending on which answer the fixture author wrote (see answers.js).
 *
 * URLs are already in scrubbed form (origin + pathname, no query/fragment) —
 * fixtures must contain exactly what the wire would carry, never raw input.
 */

/**
 * @type {Array<{ id: string; label: string; stats: import("../../../types/atlas.js").PreflightState }>}
 */
export const PREFLIGHT_STATES = [
  {
    id: "canonical-midweight",
    label: "A mid-weight marketing page: one hero video poster, a WebGL bundle, images",
    stats: {
      url: "https://example.com/showcase",
      totalBytes: 3_200_000,
      unknownBytes: 150_000,
      assetCount: 27,
      byType: {
        script: { count: 6, bytes: 890_000 },
        style: { count: 3, bytes: 120_000 },
        image: { count: 14, bytes: 1_850_000 },
        video: { count: 1, bytes: 250_000 },
        font: { count: 2, bytes: 90_000 },
        model: { count: 0, bytes: 0 },
        other: { count: 1, bytes: 0 },
      },
      largest: [
        { hostHash: "9f2c…(illustrative)", type: "image", bytes: 1_100_000 },
        { hostHash: "41ab…(illustrative)", type: "script", bytes: 620_000 },
        { hostHash: "77e0…(illustrative)", type: "video", bytes: 250_000 },
      ],
    },
  },
];
