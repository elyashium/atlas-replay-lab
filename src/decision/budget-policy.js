/** Timing overruns beyond twice their target are severe. */
export const SEVERE_TIMING_BUDGET_MULTIPLIER = 2;

/**
 * @typedef {import("../../types/atlas.js").Budgets} Budgets
 * @typedef {import("../../types/atlas.js").TraceMetrics} TraceMetrics
 * @typedef {{ metric: string; actual: number; budget: number }} TimingBudgetBreach
 */

/**
 * Return the declared timing budgets exceeded by more than the severe factor.
 * The caller may supply the strict interaction invariant as its p95 limit.
 * @param {TraceMetrics} metrics
 * @param {Budgets} budgets
 * @param {number} [p95Budget]
 * @returns {TimingBudgetBreach[]}
 */
export function severeTimingBudgetBreaches(metrics, budgets, p95Budget = budgets.p95InteractionMs) {
  /** @type {TimingBudgetBreach[]} */
  const breaches = [];
  /** @type {Array<[string, number | null, number]>} */
  const checks = [
    ["firstFrameMs", metrics.firstFrameMs, budgets.firstFrameMs],
    ["timeToInteractiveMs", metrics.timeToInteractiveMs, budgets.timeToInteractiveMs],
    ["p95InteractionMs", metrics.p95InteractionMs, p95Budget],
  ];
  for (const [metric, actual, budget] of checks) {
    if (actual === null || actual === undefined || typeof actual !== "number") continue;
    if (actual > budget * SEVERE_TIMING_BUDGET_MULTIPLIER) {
      breaches.push({ metric, actual, budget });
    }
  }
  return breaches;
}
