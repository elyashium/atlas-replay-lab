import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "../src/image/png.js";
import {
  GROQ_VISION_ENDPOINT,
  GROQ_VISION_MODEL_DEFAULT,
  VISUAL_REVIEW_MAX_DIMENSION,
  reviewScreenshotWithGroq,
  validateVisualIssues,
} from "../src/visual/groq-review.js";
import { runVisualReview, VISUAL_REVIEW_MAX_IMAGES } from "../src/visual/run-review.js";
import { fromRoot } from "../src/util/fsx.js";

const png = encodePng({ width: 1, height: 1, data: Buffer.from([20, 30, 40, 255]) });
const issue = {
  category: "layout",
  kind: "objective",
  severity: "major",
  confidence: "medium",
  observation: "The primary action is clipped at the right edge.",
  recommendation: "Reduce the component width or allow the action to wrap.",
  region: { x: 850, y: 300, width: 150, height: 200 },
};

test("Groq visual review sends one explicitly supplied PNG and returns advisory, source-linked issues", async () => {
  let request;
  const result = await reviewScreenshotWithGroq({
    image: png,
    profileId: "mid-android-4g",
    checkpointId: "cp-final",
    apiKey: "unit-test-key",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ model: "qwen/qwen3.8-27b", choices: [{ message: { content: JSON.stringify({ issues: [issue] }) } }] }) };
    },
  });
  assert.equal(request.url, GROQ_VISION_ENDPOINT);
  assert.equal(request.body.model, GROQ_VISION_MODEL_DEFAULT);
  assert.equal(request.body.messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal(result.provider, "groq");
  assert.equal(result.returnedModel, "qwen/qwen3.8-27b");
  assert.equal(result.verdictEffect, "none");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].source, "model-suggested");
  assert.match(result.issues[0].id, /^[a-f0-9]{24}$/);
});

test("design-reference review sends labeled, same-size images and explicit team criteria", async () => {
  let request;
  const result = await reviewScreenshotWithGroq({
    image: png,
    referenceImage: png,
    criteria: "Keep the primary action visually dominant and preserve the teal accent.",
    profileId: "component-preview",
    checkpointId: "current",
    apiKey: "unit-test-key",
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ model: "qwen/qwen3.8-27b", choices: [{ message: { content: JSON.stringify({ issues: [issue] }) } }] }) };
    },
  });
  const content = request.messages[1].content;
  assert.match(content[0].text, /Image 1 is the user-approved design reference; image 2 is the current rendered component/);
  assert.match(content[0].text, /Keep the primary action visually dominant/);
  assert.equal(content.filter((part) => part.type === "image_url").length, 2);
  assert.equal(result.referenceSha256, result.imageSha256);
  assert.equal(result.criteria, "Keep the primary action visually dominant and preserve the teal accent.");
  await assert.rejects(reviewScreenshotWithGroq({
    image: png,
    referenceImage: encodePng({ width: 2, height: 1, data: Buffer.alloc(8, 255) }),
    criteria: "Compare these designs",
    profileId: "p", checkpointId: "c", apiKey: "key",
    fetchImpl: async () => { throw new Error("must not call"); },
  }), /matching dimensions/);
});

test("missing key and non-PNG data fail before a provider request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("must not call"); };
  await assert.rejects(reviewScreenshotWithGroq({ image: png, profileId: "p", checkpointId: "c", apiKey: "", fetchImpl }), /GROQ_API_KEY/);
  await assert.rejects(reviewScreenshotWithGroq({ image: Buffer.from("not png"), profileId: "p", checkpointId: "c", apiKey: "key", fetchImpl }), /PNG/);
  assert.equal(calls, 0);
});

test("PNG dimensions and review volume have explicit caps", async () => {
  assert.equal(VISUAL_REVIEW_MAX_IMAGES, 3);
  const oversized = Buffer.alloc(33);
  png.copy(oversized, 0, 0, 8);
  oversized.write("IHDR", 12, 4, "ascii");
  oversized.writeUInt32BE(VISUAL_REVIEW_MAX_DIMENSION + 1, 16);
  oversized.writeUInt32BE(1, 20);
  await assert.rejects(reviewScreenshotWithGroq({
    image: oversized,
    profileId: "p",
    checkpointId: "c",
    apiKey: "key",
    fetchImpl: async () => { throw new Error("must not call"); },
  }), /dimensions exceed/);
});

test("visual result schema rejects unknown labels, unbounded boxes, and too many suggestions", () => {
  assert.throws(() => validateVisualIssues({ issues: [{ ...issue, severity: "release-pass" }] }), /unknown severity/);
  assert.throws(() => validateVisualIssues({ issues: [{ ...issue, region: { x: 950, y: 0, width: 100, height: 1 } }] }), /fit inside/);
  assert.throws(() => validateVisualIssues({ issues: Array.from({ length: 6 }, () => issue) }), /at most five/);
});

test("visual review safely keeps an issue with no model-provided region unlocalized", () => {
  const [validated] = validateVisualIssues({ issues: [{ ...issue, region: undefined }] });
  assert.equal(validated.region, null);
});

test("malformed model output cannot become a review result", async () => {
  await assert.rejects(reviewScreenshotWithGroq({
    image: png,
    profileId: "p",
    checkpointId: "c",
    apiKey: "key",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }),
}), /not valid JSON/);
});

test("visual review requires capture consent and separate provider-egress consent before reading images", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-visual-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const matrixReportPath = path.join(directory, "matrix.json");
  const report = {
    kind: "atlas.matrix-report",
    runs: [],
    target: { mode: "owned-staging-contract", contract: { schemaVersion: 1, screenshotConsent: false } },
  };
  await writeFile(matrixReportPath, JSON.stringify(report));
  await assert.rejects(runVisualReview({ matrixReportPath, consentToSendImages: true }), /did not consent/);
  report.target.contract.screenshotConsent = true;
  await writeFile(matrixReportPath, JSON.stringify(report));
  await assert.rejects(runVisualReview({ matrixReportPath, consentToSendImages: false }), /provider egress is off/);
});

test("one supplied component screenshot can be reviewed only from artifacts with explicit provider consent", async (t) => {
  const directory = await mkdtemp(path.join(fromRoot("artifacts"), ".atlas-visual-review-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, "component.png");
  const referencePath = path.join(directory, "reference.png");
  await writeFile(imagePath, png);
  await writeFile(referencePath, png);
  const outFile = path.join(directory, "review.json");
  let calls = 0;
  let requestBody;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    requestBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ model: "qwen/qwen3.8-27b", choices: [{ message: { content: JSON.stringify({ issues: [issue] }) } }] }) };
  };
  await assert.rejects(runVisualReview({ imagePath, apiKey: "key", consentToSendImages: false, outFile, fetchImpl }), /provider egress is off/);
  const { result } = await runVisualReview({ imagePath, apiKey: "key", consentToSendImages: true, outFile, fetchImpl, quiet: true });
  assert.equal(calls, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.consent.screenshotCapture, "user-provided; capture was not performed by Atlas");
  assert.equal(result.consent.providerEgress, true);
  const withReference = await runVisualReview({
    imagePath, referencePath, criteria: "Keep the subject clear and the call to action visible.",
    apiKey: "key", consentToSendImages: true, outFile, fetchImpl, quiet: true,
  });
  assert.equal(calls, 2);
  assert.equal(requestBody.messages[1].content.filter((part) => part.type === "image_url").length, 2);
  assert.equal(withReference.result.screenshots[0].referenceArtifact.endsWith("reference.png"), true);
  assert.equal(withReference.result.screenshots[0].criteria, "Keep the subject clear and the call to action visible.");
  const outsideImage = path.join(tmpdir(), `atlas-outside-${Date.now()}.png`);
  t.after(() => rm(outsideImage, { force: true }));
  await writeFile(outsideImage, png);
  const outside = await runVisualReview({ imagePath: outsideImage, apiKey: "key", consentToSendImages: true, outFile, fetchImpl, quiet: true });
  assert.equal(outside.result.status, "inconclusive");
  assert.match(outside.result.screenshots[0].error, /inside the repository artifacts/);
  assert.equal(calls, 2, "outside artifact must never reach the provider");
});
