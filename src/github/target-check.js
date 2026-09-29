/** @typedef {"SHIP" | "HOLD" | "INCONCLUSIVE"} TargetVerdict */

/** @param {TargetVerdict} verdict @param {"advisory" | "blocking"} mode */
export function conclusionForTargetVerdict(verdict, mode) {
  if (verdict === "SHIP") return "success";
  if (verdict === "HOLD" && mode === "advisory") return "neutral";
  return "failure";
}

/** A missing result or harness failure is never advisory green. */
export function verdictFromEvidence({ gate, matrixExitCode }) {
  if (matrixExitCode !== 0 || !gate || typeof gate !== "object") return "INCONCLUSIVE";
  if (gate.decision === "ship" && gate.shipped === true) return "SHIP";
  if (gate.decision === "hold") return "HOLD";
  return "INCONCLUSIVE";
}

/** @param {{ verdict: TargetVerdict, mode: "advisory" | "blocking", buildId: string, completedProfiles: number, requiredProfiles: number, reason?: string }} input */
export function checkRunConclusion(input) {
  const { verdict, mode, buildId, completedProfiles, requiredProfiles, reason } = input;
  const conclusion = conclusionForTargetVerdict(verdict, mode);
  const title = verdict === "SHIP"
    ? "SHIP — declared target evidence passed"
    : verdict === "HOLD"
      ? (mode === "blocking" ? "HOLD — release policy blocks this build" : "HOLD — advisory finding; merge policy unchanged")
      : "INCONCLUSIVE — target evidence is incomplete";
  const summary = [
    `**Target verdict:** ${verdict}`,
    `**Policy mode:** ${mode}`,
    `**Target build:** \`${buildId}\``,
    `**Profile evidence:** ${completedProfiles}/${requiredProfiles} completed`,
    "",
    "This check covers only the declared owned-staging journey and Chromium emulation. It is not a real-device, Safari/iOS, radio, GPU, thermal, camera, conversion, or accessibility certification.",
    reason ? `\n**Detail:** ${reason}` : "",
    verdict === "HOLD" && mode === "advisory" ? "\nThis conclusion is neutral. GitHub accepts neutral required checks, so do not mark an advisory Atlas check as required for branch protection." : "",
  ].filter(Boolean).join("\n");
  return { conclusion, title, summary };
}
