const authSection = document.querySelector("#auth");
const workspace = document.querySelector("#workspace");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const orgNameRow = document.querySelector("#org-name-row");
const toggleAuth = document.querySelector("#toggle-auth");
const orgPicker = document.querySelector("#org-picker");
const projectList = document.querySelector("#project-list");
const projectDetail = document.querySelector("#project-detail");
let isRegister = false;
let organizations = [];
let selectedOrg = localStorage.getItem("atlas.org") ?? "";
let selectedProject = "";

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (selectedOrg) headers.set("x-atlas-organization", selectedOrg);
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error([payload.error ?? `Request failed (${response.status})`, ...(payload.issues ?? [])].join(" · "));
  return payload;
}

toggleAuth.addEventListener("click", () => {
  isRegister = !isRegister;
  authTitle.textContent = isRegister ? "Create your workspace" : "Sign in";
  toggleAuth.textContent = isRegister ? "I already have an account" : "Create an account";
  orgNameRow.hidden = !isRegister;
  authForm.elements.password.autocomplete = isRegister ? "new-password" : "current-password";
  authForm.elements.organizationName.required = isRegister;
  document.querySelector("#auth-message").textContent = "";
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#auth-message");
  message.textContent = "";
  const values = Object.fromEntries(new FormData(authForm));
  try {
    const result = await api(isRegister ? "/v1/auth/register" : "/v1/auth/login", { method: "POST", body: JSON.stringify(values) });
    organizations = isRegister ? [result.organization] : result.organizations;
    if (!organizations.length) throw new Error("This account has no organization yet.");
    if (!organizations.some((item) => item.id === selectedOrg)) selectedOrg = organizations[0].id;
    localStorage.setItem("atlas.org", selectedOrg);
    showWorkspace();
  } catch (error) { message.textContent = error.message; }
});

orgPicker.addEventListener("change", async () => {
  selectedOrg = orgPicker.value;
  localStorage.setItem("atlas.org", selectedOrg);
  selectedProject = "";
  await loadProjects();
  showProjectPlaceholder();
});

document.querySelector("#logout").addEventListener("click", async () => {
  try { await api("/v1/auth/logout", { method: "POST", body: "{}" }); } catch {}
  organizations = [];
  selectedOrg = "";
  selectedProject = "";
  authSection.hidden = false;
  workspace.hidden = true;
  localStorage.removeItem("atlas.org");
  authForm.reset();
});

document.querySelector("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/v1/projects", { method: "POST", body: JSON.stringify({ name: form.elements.name.value }) });
    form.reset();
    await loadProjects();
    await loadProject(result.project.id);
  } catch (error) { window.alert(error.message); }
  finally { button.disabled = false; }
});

async function showWorkspace() {
  authSection.hidden = true;
  workspace.hidden = false;
  orgPicker.replaceChildren(...organizations.map((org) => {
    const option = document.createElement("option");
    option.value = org.id;
    option.textContent = `${org.name} · ${org.role}`;
    option.selected = org.id === selectedOrg;
    return option;
  }));
  await loadProjects();
}

async function loadProjects() {
  const { projects } = await api("/v1/projects");
  document.querySelector("#project-count").textContent = String(projects.length);
  if (!projects.length) {
    projectList.innerHTML = '<p class="empty">No projects yet. Create one to register a staging target.</p>';
    return;
  }
  projectList.replaceChildren(...projects.map((project) => {
    const button = document.createElement("button");
    button.className = "project-item";
    button.type = "button";
    button.setAttribute("aria-current", project.id === selectedProject ? "true" : "false");
    const name = document.createElement("span"); name.textContent = project.name;
    const action = document.createElement("span"); action.textContent = "OPEN →";
    button.append(name, action);
    button.addEventListener("click", () => loadProject(project.id));
    return button;
  }));
}

function showProjectPlaceholder() {
  projectDetail.innerHTML = '<p class="eyebrow">SELECT A PROJECT</p><h3>Start with your staging app</h3><p class="muted">Target registration requires HTTPS and a DNS TXT proof that you control the hostname. Queue records remain disabled until isolated browser workers are available.</p><div class="coverage-note"><span class="status-dot"></span><div><strong>Current lane</strong><p>Chromium emulation is planned here. No handset, Safari, real radio, GPU, thermal, or camera result is represented.</p></div></div>';
}

async function loadProject(projectId) {
  selectedProject = projectId;
  const data = await api(`/v1/projects/${encodeURIComponent(projectId)}`);
  await loadProjects();
  projectDetail.replaceChildren();
  const header = document.createElement("div"); header.className = "panel-heading";
  const h = document.createElement("div"); h.innerHTML = '<p class="eyebrow">PROJECT</p>';
  const title = document.createElement("h3"); title.textContent = data.project.name; h.append(title); header.append(h);
  projectDetail.append(header);

  const targetTitle = document.createElement("p"); targetTitle.className = "section-title"; targetTitle.textContent = "OWNED STAGING TARGET"; projectDetail.append(targetTitle);
  for (const target of data.targets) renderTarget(target);
  renderTargetForm();

  const runsTitle = document.createElement("p"); runsTitle.className = "section-title"; runsTitle.textContent = "RUN QUEUE · NO WORKERS CONNECTED"; projectDetail.append(runsTitle);
  if (!data.runs.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No run records yet."; projectDetail.append(empty); }
  for (const run of data.runs) {
    const card = document.createElement("div"); card.className = "run-card";
    const strong = document.createElement("strong"); strong.textContent = `Run ${run.id.slice(0, 8)}`;
    const pill = document.createElement("span"); pill.className = "pill pending"; pill.textContent = run.status.toUpperCase();
    const note = document.createElement("p"); note.textContent = "No browser evidence has been produced. A queued record is not a passing check.";
    card.append(strong, pill, note); projectDetail.append(card);
  }
  renderVisualReviewForm();
  renderVisualReviewHistory(data.visualReviews ?? []);
}

function renderVisualReviewForm() {
  const section = document.createElement("section"); section.className = "visual-review-tool";
  const heading = document.createElement("div"); heading.className = "panel-heading";
  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "COMPONENT VISUAL QA";
  const title = document.createElement("h3"); title.textContent = "Review a rendered component";
  titleGroup.append(eyebrow, title); heading.append(titleGroup);
  const advisory = document.createElement("span"); advisory.className = "pill pending"; advisory.textContent = "ADVISORY"; heading.append(advisory);
  section.append(heading);
  const explainer = document.createElement("p"); explainer.className = "visual-review-explainer";
  explainer.textContent = "Upload a screenshot you are authorized to share. Add an approved reference and written criteria to review visual-language fit. After consent, Atlas sends only these PNG images and criteria to Groq; it does not crawl a URL or store image bytes. The report is retained for 30 days. This server must be configured with GROQ_API_KEY; the key never reaches your browser.";
  section.append(explainer);

  const form = document.createElement("form"); form.className = "visual-review-form";
  const currentLabel = document.createElement("label"); currentLabel.textContent = "Current component screenshot (PNG, up to 10 MiB)";
  const current = document.createElement("input"); current.name = "image"; current.type = "file"; current.accept = "image/png,.png"; current.required = true; currentLabel.append(current);
  const referenceLabel = document.createElement("label"); referenceLabel.textContent = "Approved reference screenshot (optional, same dimensions)";
  const reference = document.createElement("input"); reference.name = "reference"; reference.type = "file"; reference.accept = "image/png,.png"; referenceLabel.append(reference);
  const criteriaLabel = document.createElement("label"); criteriaLabel.textContent = "Team visual criteria (required with a reference)";
  const criteria = document.createElement("textarea"); criteria.name = "criteria"; criteria.maxLength = 1200; criteria.rows = 3; criteria.placeholder = "For example: preserve the approved type scale and keep the primary action visually dominant."; criteriaLabel.append(criteria);
  const preview = document.createElement("div"); preview.className = "visual-previews"; preview.setAttribute("aria-live", "polite");
  const status = document.createElement("p"); status.className = "notice visual-review-status"; status.setAttribute("role", "status");
  const consentLabel = document.createElement("label"); consentLabel.className = "check-option";
  const consent = document.createElement("input"); consent.type = "checkbox"; consent.name = "consent"; consent.required = true;
  const consentText = document.createElement("span"); consentText.textContent = "I am authorized to share these images and criteria with Groq for this analysis. This review is AI-generated advice; it does not change the release verdict.";
  consentLabel.append(consent, consentText);
  const submit = document.createElement("button"); submit.className = "primary"; submit.type = "submit"; submit.textContent = "Review with Groq";
  form.append(currentLabel, referenceLabel, criteriaLabel, preview, consentLabel, submit, status);
  section.append(form);
  form.addEventListener("change", () => previewVisualInputs(current.files[0], reference.files[0], preview));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    submit.disabled = true;
    try {
      const currentFile = current.files[0];
      const referenceFile = reference.files[0];
      if (!currentFile || currentFile.size > 10 * 1024 * 1024 || (referenceFile && referenceFile.size > 10 * 1024 * 1024)) throw new Error("Choose PNG files no larger than 10 MiB each.");
      if (currentFile.type !== "image/png" || (referenceFile && referenceFile.type !== "image/png")) throw new Error("Only PNG screenshots are supported.");
      if (referenceFile && !criteria.value.trim()) throw new Error("Add the team's visual criteria when using a reference image.");
      const payload = {
        imageBase64: await fileToBase64(currentFile),
        ...(referenceFile ? { referenceImageBase64: await fileToBase64(referenceFile), criteria: criteria.value.trim() } : {}),
        providerConsent: consent.checked,
      };
      const idempotencyKey = await visualRequestKey(payload);
      const result = await api(`/v1/projects/${encodeURIComponent(selectedProject)}/visual-reviews`, {
        method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload),
      });
      form.reset();
      preview.replaceChildren();
      status.textContent = result.review.status === "complete"
        ? "Review recorded. Suggestions are advisory; an empty issue list is not a design pass."
        : "Review is inconclusive. No image passed or failed; see the safe error details below.";
      renderReviewResult(result.review, section);
      await refreshSelectedProject();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  projectDetail.append(section);
}

function previewVisualInputs(current, reference, container) {
  container.replaceChildren();
  for (const [label, file] of [["Current screenshot", current], ["Approved reference", reference]]) {
    if (!file) continue;
    const figure = document.createElement("figure");
    const caption = document.createElement("figcaption"); caption.textContent = `${label} · ${formatBytes(file.size)}`;
    const image = document.createElement("img"); image.alt = label; image.src = URL.createObjectURL(file);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    image.addEventListener("error", () => URL.revokeObjectURL(image.src), { once: true });
    figure.append(caption, image); container.append(figure);
  }
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function visualRequestKey(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `visual-${[...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

async function refreshSelectedProject() {
  if (selectedProject) await loadProject(selectedProject);
}

function renderVisualReviewHistory(reviews) {
  const section = document.createElement("section"); section.className = "visual-review-history";
  const title = document.createElement("p"); title.className = "section-title"; title.textContent = "RECENT VISUAL REVIEWS · REPORTS RETAINED FOR 30 DAYS"; section.append(title);
  if (!reviews.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No component visual reviews yet."; section.append(empty);
  }
  for (const review of reviews) renderReviewResult(review, section, true);
  projectDetail.append(section);
}

function renderReviewResult(review, container, compact = false) {
  const card = document.createElement("article"); card.className = "visual-review-result";
  const heading = document.createElement("div"); heading.className = "panel-heading";
  const title = document.createElement("strong"); title.textContent = `${review.result?.requestedModel ?? review.requestedModel ?? "Groq visual review"} · ${review.createdAt ? new Date(review.createdAt).toLocaleString() : "just now"}`;
  const result = review.result ?? {};
  const pill = document.createElement("span"); pill.className = `pill${review.status === "complete" ? "" : " pending"}`; pill.textContent = review.status.toUpperCase(); heading.append(title, pill);
  if (result.source === "synthetic-fixture") { const fixture = document.createElement("span"); fixture.className = "pill pending"; fixture.textContent = "SYNTHETIC FIXTURE"; heading.append(fixture); }
  card.append(heading);
  if (!compact && result.criteria) { const criteria = document.createElement("p"); criteria.className = "review-criteria"; criteria.textContent = `Criteria: ${result.criteria}`; card.append(criteria); }
  const issues = result.issues ?? [];
  if (!issues.length) {
    const note = document.createElement("p"); note.className = "review-note"; note.textContent = review.status === "complete" ? "No suggestions were returned. This is not a visual pass." : "No visual finding is available. This result is inconclusive."; card.append(note);
  }
  for (const issue of issues) {
    const item = document.createElement("div"); item.className = "visual-issue";
    const label = document.createElement("strong"); label.textContent = `${issue.severity} · ${issue.category} · ${issue.kind}`;
    const observation = document.createElement("p"); observation.textContent = issue.observation;
    const suggestion = document.createElement("p"); suggestion.textContent = `Suggestion: ${issue.recommendation}`;
    const confidence = document.createElement("small"); confidence.textContent = `Model confidence: ${issue.confidence} (self-reported, not calibrated)${issue.region ? ` · region ${issue.region.x}, ${issue.region.y}, ${issue.region.width}, ${issue.region.height} / 1000` : " · no region supplied"}`;
    item.append(label, observation, suggestion, confidence); card.append(item);
  }
  if (review.error) { const error = document.createElement("p"); error.className = "review-note"; error.textContent = review.error; card.append(error); }
  const hashes = document.createElement("small"); hashes.className = "review-hashes"; hashes.textContent = `Screenshot SHA-256 ${review.screenshotSha256 ?? review.result?.imageSha256 ?? "unavailable"}${review.referenceSha256 ?? review.result?.referenceSha256 ? ` · reference SHA-256 ${review.referenceSha256 ?? review.result.referenceSha256}` : ""} · verdict effect none`;
  card.append(hashes); container.append(card);
}

function formatBytes(value) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`; }

function renderTarget(target) {
  const card = document.createElement("div"); card.className = "target-card";
  const heading = document.createElement("div");
  const strong = document.createElement("strong"); strong.textContent = target.name ?? "Staging target";
  const pill = document.createElement("span"); pill.className = `pill${target.verified ? "" : " pending"}`; pill.textContent = target.verified ? "OWNERSHIP VERIFIED" : "VERIFY OWNERSHIP";
  heading.append(strong, pill); card.append(heading);
  const url = document.createElement("p"); url.className = "mono"; url.textContent = target.baseUrl; card.append(url);
  if (!target.verified && target.verificationToken && target.hostname) {
    const details = document.createElement("details"); details.className = "verification-record";
    const summary = document.createElement("summary"); summary.textContent = "Publish DNS TXT ownership record";
    const instructions = document.createElement("p"); instructions.textContent = "Add this TXT record at your DNS provider, wait for it to propagate, then check verification.";
    const record = document.createElement("dl");
    for (const [label, value] of [["Name", `_atlas-verify.${target.hostname}`], ["Type", "TXT"], ["Value", target.verificationToken]]) {
      const term = document.createElement("dt"); term.textContent = label;
      const data = document.createElement("dd");
      const code = document.createElement("code"); code.textContent = value; data.append(code);
      record.append(term, data);
    }
    details.append(summary, instructions, record); card.append(details);
  }
  if (target.verified) {
    const run = document.createElement("button"); run.type = "button"; run.className = "primary"; run.textContent = "Queue run record";
    run.addEventListener("click", async () => {
      const keyName = `atlas.run-idem.${target.id}`;
      const idempotencyKey = sessionStorage.getItem(keyName) ?? crypto.randomUUID();
      sessionStorage.setItem(keyName, idempotencyKey);
      run.disabled = true;
      try {
        await api(`/v1/targets/${target.id}/runs`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: "{}" });
        sessionStorage.removeItem(keyName);
        await loadProject(selectedProject);
      } catch (error) { window.alert(error.message); }
      finally { run.disabled = false; }
    }); card.append(run);
  } else {
    const verify = document.createElement("button"); verify.type = "button"; verify.className = "text-button"; verify.textContent = "Check DNS verification";
    verify.addEventListener("click", async () => {
      try { await api(`/v1/targets/${target.id}/verify`, { method: "POST", body: "{}" }); await loadProject(selectedProject); }
      catch (error) { window.alert(error.message); }
    }); card.append(verify);
  }
  projectDetail.append(card);
}

function renderTargetForm() {
  const form = document.createElement("form"); form.className = "target-form";
  form.innerHTML = `
    <p class="section-title">DEFINE THE RELEASE CHECK</p>
    <label>Experience name<input name="targetName" value="Owned Web3D staging" maxlength="120" required></label>
    <label>Owned staging URL<input name="targetUrl" type="url" value="https://staging.example.com/" autocomplete="url" required><small>HTTPS only. No credentials, query tokens, or fragments.</small></label>
    <label>Immutable build or deployment ID<input name="buildId" value="" maxlength="128" placeholder="Commit SHA, release version, or build number" required><small>Release runs require an immutable identifier; branch names such as main/latest are refused.</small></label>
    <label>Success selector<input name="successSelector" value="[data-experience-ready]" required><small>Visible evidence that the declared experience is ready.</small></label>
    <label>Safe fallback selector<input name="fallbackSelector" value="[data-static-fallback]" required><small>Checked on the selected WebGL-unavailable profile.</small></label>
    <label class="check-option"><input type="checkbox" name="authorizationConsent" required> I own this staging target or have permission to test it</label>
    <fieldset class="profile-options"><legend>Critical emulation profiles</legend>
      <label><input type="checkbox" name="profiles" value="high-wifi" checked> Desktop-class / Wi-Fi</label>
      <label><input type="checkbox" name="profiles" value="low-cpu-3g" checked> Low-CPU / constrained 3G</label>
      <label><input type="checkbox" name="profiles" value="webgl-unavailable" checked> WebGL unavailable / fallback</label>
    </fieldset>
    <label class="check-option"><input type="checkbox" name="screenshotConsent"> Allow page screenshots for this target</label>
    <label>Selectors to redact in screenshots<input name="redactSelectors" value="[data-private]" placeholder="[data-private], #email"><small>Required if screenshot capture is enabled. Review still applies.</small></label>
    <details class="advanced-contract"><summary>Advanced · edit the versioned target contract</summary><label>Contract JSON<textarea name="contract" spellcheck="false" aria-label="Advanced target contract JSON"></textarea></label></details>
  `;
  const textarea = form.elements.contract;
  let advancedEdited = false;
  const buildContract = () => {
    const values = new FormData(form);
    const targetUrl = new URL(String(values.get("targetUrl")));
    const profiles = values.getAll("profiles").map(String);
    const name = String(values.get("targetName")).trim();
    const slug = `studio-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "staging"}`;
    const screenshots = values.get("screenshotConsent") === "on";
    const redactSelectors = String(values.get("redactSelectors") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    return {
      schemaVersion: 1,
      id: slug,
      name,
      environment: "staging",
      authorization: { authorized: values.get("authorizationConsent") === "on", note: "I confirm that I am authorized to test this staging hostname" },
      target: { url: targetUrl.href, allowedOrigins: [targetUrl.origin], buildId: String(values.get("buildId")).trim() },
      journey: {
        steps: [{ type: "waitForVisible", selector: String(values.get("successSelector")).trim(), timeoutMs: 15000 }],
        success: { selector: String(values.get("successSelector")).trim() },
        fallback: { selector: String(values.get("fallbackSelector")).trim(), requiredOn: profiles.includes("webgl-unavailable") ? ["webgl-unavailable"] : [] },
      },
      profiles,
      budgets: { journeyTimeoutMs: 45000, stepTimeoutMs: 12000 },
      mediaConsent: false,
      policy: { version: "1", criticalProfiles: profiles, minimumScore: 50 },
      screenshots: { consent: screenshots, redactSelectors: screenshots ? redactSelectors : [] },
    };
  };
  const refreshContract = () => {
    if (advancedEdited) return;
    try { textarea.value = JSON.stringify(buildContract(), null, 2); } catch { /* keep editing incomplete fields */ }
  };
  form.addEventListener("input", (event) => {
    if (event.target === textarea) advancedEdited = true;
    else { advancedEdited = false; refreshContract(); }
  });
  form.addEventListener("change", (event) => {
    if (event.target !== textarea) { advancedEdited = false; refreshContract(); }
  });
  refreshContract();
  const submit = document.createElement("button"); submit.className = "primary"; submit.type = "submit"; submit.textContent = "Register target";
  const helper = document.createElement("small"); helper.textContent = "Domain ownership is checked through a DNS TXT challenge. This confirms control of the hostname; it does not mean a browser run has happened.";
  form.append(helper, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const contract = advancedEdited ? JSON.parse(textarea.value) : buildContract();
      await api(`/v1/projects/${selectedProject}/targets`, { method: "POST", body: JSON.stringify({ contract }) });
      await loadProject(selectedProject);
    } catch (error) { window.alert(error instanceof SyntaxError ? "Contract must be valid JSON." : error.message); }
  });
  projectDetail.append(form);
}

api("/v1/me").then(({ organizations: list }) => {
  organizations = list;
  if (!organizations.length) return;
  if (!organizations.some((org) => org.id === selectedOrg)) selectedOrg = organizations[0].id;
  localStorage.setItem("atlas.org", selectedOrg);
  showWorkspace().catch((error) => { authSection.hidden = false; workspace.hidden = true; document.querySelector("#auth-message").textContent = error.message; });
}).catch(() => {});
