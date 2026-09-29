import { diffImages } from "/image-diff.js";

self.addEventListener("message", (event) => {
  try {
    const { baseline, actual } = event.data ?? {};
    const comparison = diffImages(
      { ...baseline, data: new Uint8Array(baseline.data) },
      { ...actual, data: new Uint8Array(actual.data) },
    );
    self.postMessage({ ok: true, comparison });
  } catch {
    self.postMessage({ ok: false, error: "Local screenshot comparison could not be completed." });
  }
});
