import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runMatrix } from "../../../src/runner/run-matrix.js";
import { runGate } from "../../../src/gate/release-gate.js";
import { runFindings } from "../../../src/diagnose/run-findings.js";
import { renderReport } from "../../../src/report/html-report.js";

const contractPath = path.resolve(process.argv[2] ?? "");
const outputDir = path.resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3] || !contractPath.startsWith("/job/") || !outputDir.startsWith("/output/")) {
  throw new Error("usage: execute-job.js /job/contract.json /output/run (container paths only)");
}
const contract = JSON.parse(await readFile(contractPath, "utf8"));
await mkdir(outputDir, { recursive: true });
const matrixDir = path.join(outputDir, "matrix");
const gateDir = path.join(outputDir, "gate");
const findingsDir = path.join(outputDir, "findings");
const matrixPath = path.join(matrixDir, "report.json");
const gatePath = path.join(gateDir, "report.json");

const matrixResult = await runMatrix({ targetContract: contractPath, outDir: matrixDir });
if (matrixResult.report.summary.completed !== matrixResult.report.summary.total) {
  throw new Error("matrix harness lost one or more profiles; the run has no release verdict");
}
const gateResult = await runGate({ matrixReportPath: matrixPath, replayReportPath: null, outDir: gateDir });
await runFindings({ report: matrixPath, outDir: findingsDir });
const htmlPath = path.join(outputDir, "report.html");
await renderReport({ artifactsDir: outputDir, matrixReportPath: matrixPath, gateReportPath: gatePath, outFile: htmlPath });

const summary = {
  schemaVersion: 1,
  status: "completed",
  verdict: gateResult.shipped ? "SHIP" : "HOLD",
  decisionSource: "deterministic-release-gate",
  evidenceScope: "Chromium desktop emulation; not a physical handset or real radio test",
  targetContractId: contract.id,
  contractHash: matrixResult.report.target?.contractHash ?? null,
  policyVersion: gateResult.report.targetBinding?.contractPolicyVersion ?? contract.policy.version,
  profiles: matrixResult.report.summary,
  gateFindings: gateResult.findings.length,
  artifacts: ["report.html", "matrix/report.json", "gate/report.json", "findings/findings.json"],
};
await writeFile(path.join(outputDir, "job-result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`Atlas isolated job completed: ${summary.verdict} across ${summary.profiles.completed}/${summary.profiles.total} profiles\n`);
