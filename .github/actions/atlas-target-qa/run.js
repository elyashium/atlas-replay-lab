import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkRunConclusion, verdictFromEvidence } from "../../../src/github/target-check.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export async function runAction(env = process.env, dependencies = {}) {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) < 20) throw new Error("the Atlas GitHub Action requires Node.js 20 or later");
  const runCommand = dependencies.runCommand ?? runNode;
  const request = dependencies.request ?? githubRequest;
  const mode = env.ATLAS_ACTION_MODE ?? "advisory";
  if (!new Set(["advisory", "blocking"]).has(mode)) throw new Error("mode must be advisory or blocking");
  const token = env.ATLAS_ACTION_GITHUB_TOKEN;
  if (typeof token !== "string" || token.length < 20) throw new Error("a GITHUB_TOKEN with checks:write is required");
  const sha = env.GITHUB_SHA;
  const buildId = env.ATLAS_ACTION_TARGET_BUILD_ID;
  if (!SHA.test(sha ?? "") || !SHA.test(buildId ?? "")) throw new Error("GITHUB_SHA and target-build-id must be full 40- or 64-character commit SHAs");

  const workspace = path.resolve(required(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE"));
  const actionPath = path.resolve(required(env.GITHUB_ACTION_PATH, "GITHUB_ACTION_PATH"));
  const atlasRoot = path.resolve(actionPath, "../../..");
  const contractPath = path.resolve(workspace, required(env.ATLAS_ACTION_CONTRACT_PATH, "contract-path"));
  if (!inside(workspace, contractPath)) throw new Error("contract-path must stay inside the checked-out application repository");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  if (!contract.target || typeof contract.target !== "object") throw new Error("target contract must declare target");
  const targetUrl = new URL(contract.target.url);
  if (targetUrl.protocol !== "https:" || targetUrl.search || targetUrl.hash || targetUrl.username || targetUrl.password) throw new Error("target contract must use a clean HTTPS staging URL");
  if (!Array.isArray(contract.target.allowedOrigins) || !contract.target.allowedOrigins.includes(targetUrl.origin)) throw new Error("the exact staging origin must appear in target.allowedOrigins");
  if (contract.authorization?.authorized !== true) throw new Error("target contract must explicitly attest authorization to test this staging target");
  contract.target.buildId = buildId;

  const runLabel = `${safeRunId(env.GITHUB_RUN_ID)}-${safeRunId(env.GITHUB_RUN_ATTEMPT ?? "1")}`;
  const artifactDir = path.join(workspace, "artifacts", `atlas-target-qa-${runLabel}`);
  const matrixDir = path.join(artifactDir, "matrix");
  const gateDir = path.join(artifactDir, "gate");
  await mkdir(artifactDir, { recursive: true });
  const hydratedContractPath = path.join(artifactDir, "target-contract.json");
  await writeFile(hydratedContractPath, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });

  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY format is invalid");
  const serverUrl = new URL(required(env.GITHUB_SERVER_URL, "GITHUB_SERVER_URL"));
  if (serverUrl.protocol !== "https:") throw new Error("GITHUB_SERVER_URL must use HTTPS");
  const detailsUrl = new URL(`${repository}/actions/runs/${encodeURIComponent(required(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"))}`, serverUrl.href.endsWith("/") ? serverUrl : `${serverUrl.href}/`).href;
  const check = await createCheck(env, token, { repository, sha, detailsUrl }, request);

  let verdict = "INCONCLUSIVE";
  let gate = null;
  let matrixExitCode = 1;
  let reason;
  try {
    const childEnv = { ...env, ATLAS_BUILD_ID: env.GITHUB_ACTION_REF || "atlas-target-qa-unpinned" };
    delete childEnv.ATLAS_ACTION_GITHUB_TOKEN;
    const cli = path.join(atlasRoot, "bin", "atlas.js");
    matrixExitCode = await runCommand(childEnv, cli, ["matrix", "--target", hydratedContractPath, "--out", matrixDir]);
    const matrixReportPath = path.join(matrixDir, "report.json");
    try { await readFile(matrixReportPath); }
    catch { throw new Error("matrix did not produce a report; target evidence is unavailable"); }

    const gateExitCode = await runCommand(childEnv, cli, ["gate", "--matrix", matrixReportPath, "--replay", "none", "--out", gateDir]);
    try { gate = JSON.parse(await readFile(path.join(gateDir, "report.json"), "utf8")); }
    catch { throw new Error("gate report is missing or unreadable"); }
    if (gateExitCode > 1 || (gateExitCode === 1 && gate.decision === "ship")) gate = null;
    verdict = verdictFromEvidence({ gate, matrixExitCode, targetBuildId: buildId });
    if (matrixExitCode !== 0) reason = `matrix exited ${matrixExitCode}; harness failure is inconclusive`;
    else if (!gate) reason = "gate command failed or produced inconsistent evidence";
    else if (verdict === "INCONCLUSIVE") reason = "required target evidence was missing or incomplete";
  } catch (error) {
    verdict = "INCONCLUSIVE";
    reason = safeMessage(error);
  }

  const evidence = Array.isArray(gate?.targetDecision?.evidence) ? gate.targetDecision.evidence : [];
  const requiredProfiles = Array.isArray(gate?.targetDecision?.requiredProfiles) ? gate.targetDecision.requiredProfiles.length : evidence.length;
  const completedProfiles = evidence.filter((row) => row.runId && !row.error && row.journey !== null && row.score !== null).length;
  const result = checkRunConclusion({ verdict, mode, buildId, completedProfiles, requiredProfiles, ...(reason ? { reason } : {}) });
  await completeCheck(env, token, repository, check.id, result, request);
  await writeStepSummary(env.GITHUB_STEP_SUMMARY, result.summary);
  await writeOutputs(env.GITHUB_OUTPUT, { verdict, conclusion: result.conclusion, "artifact-dir": artifactDir });
  return { verdict, ...result, artifactDir };
}

async function createCheck(env, token, { repository, sha, detailsUrl }, request) {
  const result = await request(env, token, `/repos/${repository}/check-runs`, {
    method: "POST",
    body: {
      name: "Atlas target QA",
      head_sha: sha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: { title: "Atlas target QA is running", summary: "Running the declared authorized staging journey." },
    },
  });
  if (!Number.isInteger(result.id)) throw new Error("GitHub did not return a Check Run ID");
  return result;
}

async function completeCheck(env, token, repository, checkId, result, request) {
  await request(env, token, `/repos/${repository}/check-runs/${checkId}`, {
    method: "PATCH",
    body: {
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion: result.conclusion,
      output: { title: result.title, summary: result.summary },
    },
  });
}

async function githubRequest(env, token, route, init) {
  const base = new URL(required(env.GITHUB_API_URL ?? "https://api.github.com", "GITHUB_API_URL"));
  const url = new URL(route.replace(/^\//, ""), base.href.endsWith("/") ? base : `${base.href}/`);
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub Checks API returned HTTP ${response.status}`);
  return response.status === 204 ? {} : response.json();
}

function runNode(env, cli, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: path.resolve(path.dirname(cli), ".."), stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 1)));
  });
}

async function writeStepSummary(file, summary) {
  if (file) await appendFile(file, `${summary}\n`, "utf8");
}

async function writeOutputs(file, values) {
  if (!file) return;
  const safe = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}\n`).join("");
  await appendFile(file, safe, "utf8");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(value ?? ""))) throw new Error("GitHub run id contains unsupported characters");
  return String(value);
}

function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n]+/g, " ").slice(0, 300);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAction().then((result) => {
    if (result.conclusion === "failure") process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Atlas target QA action failed: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
