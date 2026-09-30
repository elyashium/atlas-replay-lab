import { createSupabaseBrowserClient } from "./supabase-client.js";

const authConfigResponse = await fetch("/v1/auth/config", { headers: { accept: "application/json" }, credentials: "same-origin" });
const authConfig = authConfigResponse.ok ? await authConfigResponse.json() : { provider: "local" };
const supabase = createSupabaseBrowserClient(authConfig);
if (supabase) document.documentElement.dataset.authProvider = "supabase";

const authSection = document.querySelector("#auth");
const provisionSection = document.querySelector("#provision-workspace");
const landing = document.querySelector("#landing");
const workspace = document.querySelector("#workspace");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const orgNameRow = document.querySelector("#org-name-row");
const toggleAuth = document.querySelector("#toggle-auth");
const orgPicker = document.querySelector("#org-picker");
const projectList = document.querySelector("#project-list");
const projectDetail = document.querySelector("#project-detail");
const sharedReportSection = document.querySelector("#shared-report");
let isRegister = false;
let organizations = [];
let selectedOrg = localStorage.getItem("atlas.org") ?? "";
let selectedProject = "";
let runRefreshTimer;
let activeVisualPreview = null;

const sharedToken = new URLSearchParams(window.location.hash.slice(1)).get("share");
if (sharedToken) {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  void showSharedReport(sharedToken);
}

async function api(path, options = {}) {
  const headers = await authorizedHeaders(options.headers);
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error([payload.error ?? `Request failed (${response.status})`, ...(payload.issues ?? [])].join(" · "));
    error.status = response.status;
    error.retryAfter = payload.retryAfter;
    throw error;
  }
  return payload;
}

async function authorizedHeaders(initial = {}) {
  const headers = new Headers(initial);
  if (selectedOrg) headers.set("x-atlas-organization", selectedOrg);
  if (supabase && !headers.has("authorization")) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.set("authorization", `Bearer ${session.access_token}`);
  }
  return headers;
}

function setAuthMode(register) {
  isRegister = register;
  authTitle.textContent = register ? "Create your workspace" : "Sign in";
  toggleAuth.textContent = register ? "I already have an account" : "Create an account";
  orgNameRow.hidden = !register;
  authForm.elements.password.autocomplete = register ? "new-password" : "current-password";
  authForm.elements.organizationName.required = register;
  document.querySelector("#auth-message").textContent = "";
}

async function submitSupabaseAuth(values, message) {
  let response;
  if (isRegister) {
    localStorage.setItem("atlas.pending-org", values.organizationName.trim());
    response = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: { emailRedirectTo: `${location.origin}/` },
    });
  } else {
    response = await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
  }
  if (response.error) throw new Error(response.error.message || "Supabase authentication failed.");
  if (!response.data.session) {
    setAuthMode(false);
    message.textContent = "Check your email to confirm your account, then sign in to finish workspace setup.";
    return;
  }
  await finishSupabaseSession(localStorage.getItem("atlas.pending-org") ?? "");
}

async function finishSupabaseSession(organizationName = "") {
  try {
    const body = organizationName ? { organizationName } : {};
    const result = await api("/v1/auth/provision", { method: "POST", body: JSON.stringify(body) });
    organizations = result.organizations;
    localStorage.removeItem("atlas.pending-org");
    if (!organizations.length) throw new Error("This account has no organization yet.");
    if (!organizations.some((item) => item.id === selectedOrg)) selectedOrg = organizations[0].id;
    localStorage.setItem("atlas.org", selectedOrg);
    await showWorkspace();
  } catch (error) {
    if (error.status !== 400) throw error;
    landing.hidden = true;
    authSection.hidden = true;
    provisionSection.hidden = false;
    workspace.hidden = true;
    const pending = organizationName || localStorage.getItem("atlas.pending-org") || "";
    if (pending) document.querySelector("#provision-form").elements.organizationName.value = pending;
    document.querySelector("#provision-message").textContent = "Create the first workspace for this Supabase account.";
  }
}

toggleAuth.addEventListener("click", () => {
  setAuthMode(!isRegister);
});

document.querySelector("#start-workspace").addEventListener("click", () => {
  setAuthMode(true);
});

document.querySelector(".nav-cta").addEventListener("click", () => {
  setAuthMode(false);
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#auth-message");
  message.textContent = "";
  const values = Object.fromEntries(new FormData(authForm));
  try {
    if (supabase) await submitSupabaseAuth(values, message);
    else {
      const result = await api(isRegister ? "/v1/auth/register" : "/v1/auth/login", { method: "POST", body: JSON.stringify(values) });
      organizations = isRegister ? [result.organization] : result.organizations;
      if (!organizations.length) throw new Error("This account has no organization yet.");
      if (!organizations.some((item) => item.id === selectedOrg)) selectedOrg = organizations[0].id;
      localStorage.setItem("atlas.org", selectedOrg);
      await showWorkspace();
    }
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#provision-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#provision-message");
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "Creating your workspace…";
  try {
    const result = await api("/v1/auth/provision", { method: "POST", body: JSON.stringify({ organizationName: form.elements.organizationName.value }) });
    localStorage.removeItem("atlas.pending-org");
    organizations = result.organizations;
    if (!organizations.some((item) => item.id === selectedOrg)) selectedOrg = organizations[0].id;
    localStorage.setItem("atlas.org", selectedOrg);
    await showWorkspace();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

orgPicker.addEventListener("change", async () => {
  activeVisualPreview = null;
  selectedOrg = orgPicker.value;
  localStorage.setItem("atlas.org", selectedOrg);
  selectedProject = "";
  await loadProjects();
  showProjectPlaceholder();
});

document.querySelector("#logout").addEventListener("click", async () => {
  if (supabase) await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  else try { await api("/v1/auth/logout", { method: "POST", body: "{}" }); } catch {}
  organizations = [];
  selectedOrg = "";
  selectedProject = "";
  activeVisualPreview = null;
  landing.hidden = false;
  authSection.hidden = false;
  provisionSection.hidden = true;
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
  landing.hidden = true;
  authSection.hidden = true;
  provisionSection.hidden = true;
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

function renderVisualGateControls(run, projectRuns, evaluations, container) {
  const policy = run.contract?.policy?.visualGate;
  const componentSelectors = run.contract?.screenshots?.componentSelectors ?? [];
  if (!policy || !componentSelectors.length) return;
  const section = document.createElement("section"); section.className = "visual-gate-panel";
  const heading = document.createElement("p"); heading.className = "section-title"; heading.textContent = "COMPONENT VISUAL GATE · ONE CAPTURE"; section.append(heading);
  const note = document.createElement("p"); note.className = "review-note"; note.textContent = `Deterministic pixel gate: at most ${(policy.maxPixelDiffRatio * 100).toFixed(2)}% changed pixels. This result applies to one matching component/profile/checkpoint and remains separate from the run's target-wide verdict.`; section.append(note);
  for (const evaluation of evaluations.filter((item) => item.runId === run.id)) {
    const row = document.createElement("p"); row.className = "run-evidence";
    row.textContent = `${evaluation.verdict} · ${evaluation.evidence?.componentId ?? "component"} · ${(Number(evaluation.evidence?.pixelDiffRatio ?? 0) * 100).toFixed(2)}% changed · build ${evaluation.evidence?.referenceBuildId ?? "?"} → ${evaluation.evidence?.currentBuildId ?? "?"}`;
    section.append(row);
  }
  if (run.status !== "completed") { container.append(section); return; }

  const paths = (run.artifacts ?? []).filter((artifact) => artifact.mediaType === "image/png" && componentSelectors.some((item) => artifact.relativePath?.endsWith(`/screenshots/component-${item.id}.png`)));
  const candidates = projectRuns.filter((candidate) => candidate.id !== run.id && new Date(candidate.createdAt).getTime() < new Date(run.createdAt).getTime() && candidate.targetId === run.targetId && candidate.status === "completed" && candidate.verdict === "SHIP" && candidate.contract?.target?.buildId && run.contract?.target?.buildId !== candidate.contract.target.buildId && JSON.stringify(candidate.contract?.policy) === JSON.stringify(run.contract.policy) && JSON.stringify(candidate.contract?.screenshots?.componentSelectors) === JSON.stringify(componentSelectors) && paths.some((artifact) => candidate.artifacts?.some((reference) => reference.relativePath === artifact.relativePath && reference.mediaType === "image/png")));
  if (run.verdict !== "SHIP") { const reason = document.createElement("small"); reason.textContent = `Component comparison cannot produce SHIP because this run's target verdict is ${run.verdict ?? "inconclusive"}.`; section.append(reason); container.append(section); return; }
  if (!paths.length || !candidates.length) { const empty = document.createElement("small"); empty.textContent = "No matching component capture and prior SHIP run with a different immutable build are available."; section.append(empty); container.append(section); return; }

  const form = document.createElement("form"); form.className = "visual-gate-form";
  const referenceLabel = document.createElement("label"); referenceLabel.textContent = "Approved reference run";
  const referenceSelect = document.createElement("select"); referenceSelect.required = true;
  for (const candidate of candidates) {
    const option = document.createElement("option"); option.value = candidate.id; option.textContent = `Run ${candidate.id.slice(0, 8)} · ${candidate.contract.target.buildId} · SHIP`; referenceSelect.append(option);
  }
  referenceLabel.append(referenceSelect);
  const captureLabel = document.createElement("label"); captureLabel.textContent = "Component / profile capture";
  const captureSelect = document.createElement("select"); captureSelect.required = true;
  for (const artifact of paths) {
    const option = document.createElement("option"); option.value = artifact.id; option.dataset.relativePath = artifact.relativePath; option.textContent = artifact.relativePath.split("/").slice(-4).join(" /"); captureSelect.append(option);
  }
  captureLabel.append(captureSelect);
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "text-button"; submit.textContent = "Evaluate component gate";
  const status = document.createElement("small"); status.setAttribute("role", "status"); status.className = "visual-gate-status";
  form.append(referenceLabel, captureLabel, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); submit.disabled = true; status.textContent = "Checking stored hashes and comparing PNG pixels…";
    const baseline = candidates.find((candidate) => candidate.id === referenceSelect.value);
    const currentArtifact = paths.find((artifact) => artifact.id === captureSelect.value);
    const referenceArtifact = baseline?.artifacts?.find((artifact) => artifact.relativePath === currentArtifact?.relativePath && artifact.mediaType === "image/png");
    if (!baseline || !currentArtifact || !referenceArtifact) { status.textContent = "The selected run no longer has a matching capture. Refresh the project and try again."; submit.disabled = false; return; }
    try {
      const { evaluation } = await api(`/v1/runs/${encodeURIComponent(run.id)}/visual-gate-evaluations`, { method: "POST", body: JSON.stringify({ referenceRunId: baseline.id, artifactId: currentArtifact.id, referenceArtifactId: referenceArtifact.id }) });
      status.textContent = `${evaluation.verdict} · ${(evaluation.evidence.pixelDiffRatio * 100).toFixed(2)}% changed; threshold ${(evaluation.policy.maxPixelDiffRatio * 100).toFixed(2)}%. Scope: one component capture.`;
      await refreshSelectedProject();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  section.append(form); container.append(section);
}

function showProjectPlaceholder() {
  projectDetail.innerHTML = '<p class="eyebrow">SELECT A PROJECT</p><h3>Start with your staging app</h3><p class="muted">Register an owned HTTPS target and verify its DNS record. A local isolated Docker worker can execute queued runs when explicitly enabled.</p><div class="coverage-note"><span class="status-dot"></span><div><strong>Current lane</strong><p>Chromium emulation only. No handset, Safari, real radio, GPU, thermal, or camera result is represented.</p></div></div>';
}

async function loadProject(projectId) {
  if (selectedProject !== projectId) activeVisualPreview = null;
  selectedProject = projectId;
  const data = await api(`/v1/projects/${encodeURIComponent(projectId)}`);
  clearTimeout(runRefreshTimer);
  if (data.runs.some((run) => run.status === "queued" || run.status === "running")) {
    runRefreshTimer = setTimeout(() => { if (selectedProject === projectId) void loadProject(projectId); }, 3000);
  }
  await loadProjects();
  projectDetail.replaceChildren();
  const header = document.createElement("div"); header.className = "panel-heading";
  const h = document.createElement("div"); h.innerHTML = '<p class="eyebrow">PROJECT</p>';
  const title = document.createElement("h3"); title.textContent = data.project.name; h.append(title); header.append(h);
  projectDetail.append(header);

  const targetTitle = document.createElement("p"); targetTitle.className = "section-title"; targetTitle.textContent = "OWNED STAGING TARGET"; projectDetail.append(targetTitle);
  for (const target of data.targets) renderTarget(target);
  renderTargetForm();

  const runsTitle = document.createElement("p"); runsTitle.className = "section-title"; runsTitle.textContent = "RUNS · LOCAL WORKER"; projectDetail.append(runsTitle);
  if (!data.runs.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No run records yet."; projectDetail.append(empty); }
  for (const run of data.runs) {
    const card = document.createElement("div"); card.className = "run-card";
    const strong = document.createElement("strong"); strong.textContent = `Run ${run.id.slice(0, 8)}`;
    const pill = document.createElement("span"); pill.className = `pill${run.verdict === "SHIP" ? "" : run.verdict === "HOLD" ? " hold" : " pending"}`; pill.textContent = run.verdict ?? run.status.toUpperCase();
    const note = document.createElement("p"); note.textContent = run.result?.evidenceScope ?? (run.status === "queued" || run.status === "running" ? "Awaiting the explicitly configured local browser worker. A queued record is not a passing check." : run.errorCode ? `Harness failure: ${run.errorCode}. This run has no passing evidence.` : "No browser evidence is available.");
    card.append(strong, pill, note);
    if (run.result?.source === "synthetic-fixture") { const fixture = document.createElement("span"); fixture.className = "pill pending"; fixture.textContent = "ILLUSTRATIVE FIXTURE"; card.append(fixture); }
    if (run.verdict) { const verdict = document.createElement("p"); verdict.className = "run-verdict"; verdict.textContent = `Release decision: ${run.verdict}`; card.append(verdict); }
    for (const evidence of run.result?.targetDecision?.evidence ?? []) { const row = document.createElement("p"); row.className = "run-evidence"; row.textContent = `${evidence.profileId}: journey ${evidence.journey ?? "missing"} · score ${evidence.score ?? "missing"}${evidence.error ? ` · ${evidence.error}` : ""}`; card.append(row); }
    const artifacts = run.artifacts ?? [];
    if (artifacts.length) {
      const list = document.createElement("ul"); list.className = "artifact-list";
      for (const artifact of artifacts) {
        const item = document.createElement("li"); const link = document.createElement("a");
        link.href = `/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`;
        link.textContent = `${artifact.name} · ${formatBytes(Number(artifact.byteLength))}`;
        item.append(link); list.append(item);
      }
      card.append(list);
    }
    renderVisualGateControls(run, data.runs, data.visualGateEvaluations ?? [], card);
    if (run.result) renderShareManager(run, card);
    if (run.status === "queued" || run.status === "running") {
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "text-button"; cancel.textContent = run.status === "queued" ? "Cancel queued run" : "Request cancellation";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try { await api(`/v1/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: "{}" }); await loadProject(selectedProject); }
        catch (error) { window.alert(error.message); }
        finally { cancel.disabled = false; }
      });
      card.append(cancel);
    }
    projectDetail.append(card);
  }
  renderVisualReviewForm(data.runs ?? []);
  renderVisualReviewHistory(data.visualReviews ?? [], data.codeProposals ?? []);
}

function renderShareManager(run, container) {
  const section = document.createElement("section"); section.className = "share-manager";
  const title = document.createElement("p"); title.className = "section-title"; title.textContent = "CLIENT REPORT LINK";
  const note = document.createElement("p"); note.className = "share-note"; note.textContent = "Private by default. Explicitly choose the run summary and files to share. Anyone with the link can view them until expiry or revocation.";
  const form = document.createElement("form"); form.className = "share-create-form";
  const summaryLabel = document.createElement("label"); summaryLabel.className = "check-option";
  const summary = document.createElement("input"); summary.type = "checkbox"; summary.name = "includeSummary"; summary.required = true;
  const summaryText = document.createElement("span"); summaryText.textContent = "Share verdict, profile metrics, and run evidence summary";
  summaryLabel.append(summary, summaryText); form.append(summaryLabel);
  for (const artifact of run.artifacts ?? []) {
    const label = document.createElement("label"); label.className = "check-option";
    const input = document.createElement("input"); input.type = "checkbox"; input.name = "artifact"; input.value = artifact.id;
    const text = document.createElement("span"); text.textContent = `${artifact.name} · ${artifact.mediaType} · ${formatBytes(Number(artifact.byteLength))}`;
    label.append(input, text); form.append(label);
  }
  const expiryLabel = document.createElement("label"); expiryLabel.textContent = "Link expires after";
  const expiry = document.createElement("select"); expiry.name = "expiresInHours";
  for (const [value, label] of [[24, "1 day"], [168, "7 days"], [720, "30 days"]]) {
    const option = document.createElement("option"); option.value = String(value); option.textContent = label; option.selected = value === 168; expiry.append(option);
  }
  expiryLabel.append(expiry); form.append(expiryLabel);
  const status = document.createElement("p"); status.className = "notice share-status"; status.setAttribute("role", "status");
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "text-button"; submit.textContent = "Create expiring link";
  form.append(submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); submit.disabled = true; status.textContent = "";
    try {
      const created = await api(`/v1/runs/${encodeURIComponent(run.id)}/share-links`, {
        method: "POST", body: JSON.stringify({
          includeSummary: summary.checked,
          artifactIds: [...form.querySelectorAll('input[name="artifact"]:checked')].map((input) => input.value),
          expiresInHours: Number(expiry.value),
        }),
      });
      const next = { ...run, clientShares: [{ ...created.share, includeSummary: true, artifactIds: [...form.querySelectorAll('input[name="artifact"]:checked')].map((input) => input.value), accessCount: 0, oneTimeUrl: created.url }, ...(run.clientShares ?? [])] };
      section.replaceWith(renderShareManager(next, null));
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  section.append(title, note, form);
  for (const share of run.clientShares ?? []) {
    const row = document.createElement("div"); row.className = "share-row";
    const state = share.revokedAt ? "REVOKED" : new Date(share.expiresAt).getTime() <= Date.now() ? "EXPIRED" : "ACTIVE";
    const summaryLine = document.createElement("p"); summaryLine.textContent = `${state} · expires ${new Date(share.expiresAt).toLocaleString()} · ${share.accessCount} access${share.accessCount === 1 ? "" : "es"}`;
    const scopeLine = document.createElement("small");
    const selectedNames = (share.artifactIds ?? []).map((id) => (run.artifacts ?? []).find((artifact) => artifact.id === id)?.name ?? "selected file");
    scopeLine.textContent = `${share.includeSummary ? "Run summary" : "No summary"}${selectedNames.length ? ` · ${selectedNames.join(", ")}` : " · no files"}`;
    row.append(summaryLine, scopeLine);
    if (share.accessLog?.length) {
      const details = document.createElement("details"); details.className = "share-access-log";
      const summary = document.createElement("summary"); summary.textContent = `Recent access log (${share.accessLog.length})`; details.append(summary);
      for (const access of share.accessLog) {
        const line = document.createElement("small");
        const artifactName = (run.artifacts ?? []).find((artifact) => artifact.id === access.artifactId)?.name;
        line.textContent = `${new Date(access.createdAt).toLocaleString()} · ${access.action === "share-link.opened" ? "Report opened" : `Downloaded ${artifactName ?? "selected artifact"}`}`;
        details.append(line);
      }
      row.append(details);
    }
    if (share.oneTimeUrl && state === "ACTIVE") {
      const url = document.createElement("input"); url.type = "text"; url.readOnly = true; url.value = share.oneTimeUrl; url.setAttribute("aria-label", "New client share URL; copy and store it now");
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "text-button"; copy.textContent = "Copy link";
      const copyStatus = document.createElement("small"); copyStatus.setAttribute("role", "status");
      copy.addEventListener("click", async () => {
        url.select();
        try { await navigator.clipboard.writeText(url.value); copyStatus.textContent = "Copied. This token will not be shown after reload."; }
        catch { copyStatus.textContent = "Selected the link. Copy it now; the token will not be shown after reload."; }
      });
      row.append(url, copy, copyStatus);
    }
    if (state === "ACTIVE") {
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "text-button"; revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try { await api(`/v1/runs/${encodeURIComponent(run.id)}/share-links/${encodeURIComponent(share.id)}/revoke`, { method: "POST", body: "{}" }); await loadProject(selectedProject); }
        catch (error) { window.alert(error.message); }
        finally { revoke.disabled = false; }
      });
      row.append(revoke);
    }
    section.append(row);
  }
  if (container) container.append(section);
  return section;
}

async function showSharedReport(token) {
  landing.hidden = true; authSection.hidden = true; provisionSection.hidden = true; workspace.hidden = true; sharedReportSection.hidden = false;
  document.querySelector(".topbar .quiet-link").hidden = true;
  sharedReportSection.replaceChildren();
  const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "SHARED ATLAS QA REPORT";
  const heading = document.createElement("h2"); heading.textContent = "Loading shared evidence…";
  const status = document.createElement("p"); status.className = "notice"; status.setAttribute("role", "status");
  sharedReportSection.append(eyebrow, heading, status);
  try {
    const response = await fetch("/v1/shared-reports/open", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, credentials: "omit", body: JSON.stringify({ token }) });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error ?? "Shared report is unavailable.");
    const run = report.run;
    heading.textContent = `Run ${run.id.slice(0, 8)} · ${run.verdict ?? run.status.toUpperCase()}`;
    status.className = "share-note";
    status.textContent = `Link expires ${new Date(report.share.expiresAt).toLocaleString()}. Access is logged. Revoke the link to block future access.`;
    if (run.result?.evidenceScope) { const scope = document.createElement("p"); scope.className = "coverage-note"; scope.textContent = run.result.evidenceScope; sharedReportSection.append(scope); }
    const summary = document.createElement("div"); summary.className = "shared-run-summary";
    const summaryHeading = document.createElement("h3"); summaryHeading.textContent = "Release evidence"; summary.append(summaryHeading);
    for (const evidence of run.result?.targetDecision?.evidence ?? []) {
      const line = document.createElement("p"); line.textContent = `${evidence.profileId}: journey ${evidence.journey ?? "missing"} · score ${evidence.score ?? "missing"}${evidence.error ? ` · ${evidence.error}` : ""}`; summary.append(line);
    }
    const profileSummary = run.result?.profiles;
    if (profileSummary) { const line = document.createElement("p"); line.textContent = `Profiles completed: ${profileSummary.completed ?? 0}/${profileSummary.total ?? 0}.`; summary.append(line); }
    if (run.result?.gateFindings !== undefined) { const line = document.createElement("p"); line.textContent = `Release gate findings: ${run.result.gateFindings}.`; summary.append(line); }
    sharedReportSection.append(summary);
    if (report.artifacts.length) {
      const title = document.createElement("h3"); title.textContent = "Shared files"; sharedReportSection.append(title);
      const list = document.createElement("ul"); list.className = "artifact-list";
      for (const artifact of report.artifacts) {
        const item = document.createElement("li");
        const button = document.createElement("button"); button.type = "button"; button.className = "text-button"; button.textContent = `Download ${artifact.name} · ${formatBytes(Number(artifact.byteLength))}`;
        const message = document.createElement("small"); message.setAttribute("role", "status");
        button.addEventListener("click", async () => {
          button.disabled = true; message.textContent = "";
          try {
            const blob = await fetchSharedArtifact(token, artifact.id); const objectUrl = URL.createObjectURL(blob);
            const download = document.createElement("a"); download.href = objectUrl; download.download = artifact.name; download.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
          } catch (error) { message.textContent = error.message; }
          finally { button.disabled = false; }
        });
        item.append(button, message); list.append(item);
        if (artifact.mediaType === "image/png") {
          const preview = document.createElement("button"); preview.type = "button"; preview.className = "text-button"; preview.textContent = "Preview screenshot";
          let figure; let objectUrl;
          preview.addEventListener("click", async () => {
            if (figure) { URL.revokeObjectURL(objectUrl); figure.remove(); figure = null; objectUrl = null; preview.textContent = "Preview screenshot"; return; }
            preview.disabled = true; message.textContent = "";
            try {
              const blob = await fetchSharedArtifact(token, artifact.id); objectUrl = URL.createObjectURL(blob);
              figure = document.createElement("figure"); figure.className = "shared-artifact-preview";
              const image = document.createElement("img"); image.src = objectUrl; image.alt = `Shared screenshot ${artifact.name}`;
              const caption = document.createElement("figcaption"); caption.textContent = `${artifact.name} · ${formatBytes(Number(artifact.byteLength))}`;
              figure.append(image, caption); item.append(figure); preview.textContent = "Hide screenshot";
            } catch (error) { message.textContent = error.message; }
            finally { preview.disabled = false; }
          });
          item.append(preview);
        }
      }
      sharedReportSection.append(list);
    }
  } catch (error) {
    heading.textContent = "Shared report unavailable";
    status.textContent = error.message;
    status.dataset.state = "error";
  }
}

async function fetchSharedArtifact(token, artifactId) {
  const response = await fetch("/v1/shared-reports/artifact", {
    method: "POST",
    headers: { accept: "application/octet-stream", "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ token, artifactId }),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "This share was revoked or expired." : "The shared artifact could not be verified.");
  return response.blob();
}

function renderVisualReviewForm(runs) {
  const section = document.createElement("section"); section.className = "visual-review-tool";
  const heading = document.createElement("div"); heading.className = "panel-heading";
  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "COMPONENT VISUAL QA";
  const title = document.createElement("h3"); title.textContent = "Review a rendered component";
  titleGroup.append(eyebrow, title); heading.append(titleGroup);
  const advisory = document.createElement("span"); advisory.className = "pill pending"; advisory.textContent = "ADVISORY"; heading.append(advisory);
  section.append(heading);
  const explainer = document.createElement("p"); explainer.className = "visual-review-explainer";
  explainer.textContent = "Review a PNG you upload or a screenshot artifact from a completed staging run. Pair current and prior run captures only when the target, contract version, profile, checkpoint, and component match; Atlas verifies both artifact hashes and records their provenance. Inspect every image before separate Groq egress consent. Only the selected PNGs and criteria are sent. Findings are advisory and never change the release verdict. Reports are retained for 30 days. This server must be configured with GROQ_API_KEY; the key never reaches your browser.";
  section.append(explainer);

  const form = document.createElement("form"); form.className = "visual-review-form";
  const captureLabel = document.createElement("label"); captureLabel.textContent = "Or choose a captured screenshot from a completed staging run";
  const captured = document.createElement("select"); captured.name = "capturedScreenshot";
  const noCapture = document.createElement("option"); noCapture.value = ""; noCapture.textContent = "Choose a run screenshot"; captured.append(noCapture);
  let captureCount = 0;
  for (const run of runs) {
    if (run.status !== "completed") continue;
    for (const artifact of run.artifacts ?? []) {
      if (artifact.mediaType !== "image/png") continue;
      const option = document.createElement("option"); option.value = `${run.id}:${artifact.id}`;
      option.dataset.url = `/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`;
      option.dataset.name = artifact.name ?? "captured-screenshot.png";
      option.dataset.bytes = String(artifact.byteLength);
      option.textContent = `Run ${run.id.slice(0, 8)} | ${artifact.name ?? "screenshot.png"} | ${run.verdict ?? "no verdict"}`;
      if (Number(artifact.byteLength) > 10 * 1024 * 1024) { option.disabled = true; option.textContent += " (over 10 MiB)"; }
      captured.append(option); captureCount += 1;
    }
  }
  if (!captureCount) { noCapture.textContent = "No captured PNGs available; enable screenshot consent on a target"; noCapture.disabled = true; }
  captureLabel.append(captured);
  const baselineCaptureLabel = document.createElement("label"); baselineCaptureLabel.textContent = "Compare against a prior run of the same target, profile, checkpoint, and component";
  const baselineCaptured = document.createElement("select"); baselineCaptured.name = "baselineRunScreenshot"; baselineCaptured.disabled = true;
  const noBaselineCapture = document.createElement("option"); noBaselineCapture.value = ""; noBaselineCapture.textContent = "Choose a current run screenshot first"; baselineCaptured.append(noBaselineCapture);
  baselineCaptureLabel.append(baselineCaptured);
  const currentLabel = document.createElement("label"); currentLabel.textContent = "Or upload a current component screenshot (PNG, up to 10 MiB)";
  const current = document.createElement("input"); current.name = "image"; current.type = "file"; current.accept = "image/png,.png"; currentLabel.append(current);
  let capturedFile = null;
  let capturedSourceArtifact = null;
  const referenceLabel = document.createElement("label"); referenceLabel.textContent = "Approved reference screenshot (optional, same dimensions)";
  const reference = document.createElement("input"); reference.name = "reference"; reference.type = "file"; reference.accept = "image/png,.png"; referenceLabel.append(reference);
  const criteriaLabel = document.createElement("label"); criteriaLabel.textContent = "Team visual criteria (required with a reference)";
  const criteria = document.createElement("textarea"); criteria.name = "criteria"; criteria.maxLength = 1200; criteria.rows = 3; criteria.placeholder = "For example: preserve the approved type scale and keep the primary action visually dominant."; criteriaLabel.append(criteria);
  const preview = document.createElement("div"); preview.className = "visual-previews"; preview.setAttribute("aria-live", "polite");
  const localComparison = document.createElement("div"); localComparison.className = "local-pixel-comparison"; localComparison.setAttribute("aria-live", "polite");
  const status = document.createElement("p"); status.className = "notice visual-review-status"; status.setAttribute("role", "status");
  const consentLabel = document.createElement("label"); consentLabel.className = "check-option";
  const consent = document.createElement("input"); consent.type = "checkbox"; consent.name = "consent"; consent.required = true;
  const consentText = document.createElement("span"); consentText.textContent = "I am authorized to share these images and criteria with Groq for this analysis. This review is AI-generated advice; it does not change the release verdict.";
  consentLabel.append(consent, consentText);
  const compareLocally = document.createElement("button"); compareLocally.className = "text-button"; compareLocally.type = "button"; compareLocally.textContent = "Compare with reference locally"; compareLocally.disabled = true;
  const submit = document.createElement("button"); submit.className = "primary"; submit.type = "submit"; submit.textContent = "Review with Groq";
  form.append(captureLabel, baselineCaptureLabel, currentLabel, referenceLabel, criteriaLabel, preview, compareLocally, localComparison, consentLabel, submit, status);
  section.append(form);
  const selectedCurrent = () => current.files[0] ?? capturedFile;
  let capturedReferenceFile = null;
  let capturedReferenceArtifact = null;
  const selectedReference = () => reference.files[0] ?? capturedReferenceFile;
  const updateLocalCompareButton = () => { compareLocally.disabled = !selectedCurrent() || !selectedReference(); };
  const refreshBaselineOptions = () => {
    const previous = baselineCaptured.value;
    baselineCaptured.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = "";
    let currentRun = null;
    let currentArtifact = null;
    if (captured.value) {
      const [currentRunId, currentArtifactId] = captured.value.split(":");
      currentRun = runs.find((run) => run.id === currentRunId);
      currentArtifact = currentRun?.artifacts?.find((artifact) => artifact.id === currentArtifactId);
    }
    const candidates = currentRun && currentArtifact
      ? runs.filter((run) => run.status === "completed" && run.id !== currentRun.id && run.targetId === currentRun.targetId && run.contractVersion === currentRun.contractVersion)
        .flatMap((run) => (run.artifacts ?? []).filter((artifact) => artifact.mediaType === "image/png" && artifact.relativePath === currentArtifact.relativePath).map((artifact) => ({ run, artifact })))
      : [];
    if (!currentRun || !currentArtifact) placeholder.textContent = "Choose a current run screenshot first";
    else if (!candidates.length) placeholder.textContent = "No prior run has the same target, contract, profile, and component";
    else placeholder.textContent = "No prior run selected (optional)";
    baselineCaptured.append(placeholder);
    for (const { run, artifact } of candidates) {
      const option = document.createElement("option"); option.value = `${run.id}:${artifact.id}`;
      option.dataset.url = `/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`;
      option.dataset.name = artifact.name ?? "reference-screenshot.png";
      option.dataset.bytes = String(artifact.byteLength);
      option.textContent = `Run ${run.id.slice(0, 8)} · ${artifact.name} · ${run.verdict ?? "no verdict"}`;
      if (Number(artifact.byteLength) > 10 * 1024 * 1024) { option.disabled = true; option.textContent += " (over 10 MiB)"; }
      baselineCaptured.append(option);
    }
    baselineCaptured.disabled = !candidates.length;
    if (candidates.some(({ run, artifact }) => `${run.id}:${artifact.id}` === previous)) baselineCaptured.value = previous;
  };
  refreshBaselineOptions();
  captured.addEventListener("change", async () => {
    capturedFile = null;
    capturedSourceArtifact = null;
    capturedReferenceFile = null;
    capturedReferenceArtifact = null;
    baselineCaptured.value = "";
    current.value = "";
    reference.value = "";
    preview.replaceChildren();
    refreshBaselineOptions();
    if (!captured.value) { status.textContent = ""; return; }
    const option = captured.selectedOptions[0];
    const selectedValue = captured.value;
    if (Number(option.dataset.bytes) > 10 * 1024 * 1024) { status.textContent = "This screenshot is over the visual review size limit."; return; }
    status.dataset.state = "pending";
    status.textContent = "Loading the selected run artifact for preview…";
    captured.disabled = true;
    try {
      const response = await fetch(option.dataset.url, { credentials: "same-origin", headers: await authorizedHeaders() });
      if (!response.ok) throw new Error(response.status === 410 ? "The screenshot expired or failed its integrity check." : `Screenshot could not be loaded (${response.status}).`);
      const blob = await response.blob();
      if (captured.value !== selectedValue) return;
      if (blob.type !== "image/png" || blob.size > 10 * 1024 * 1024) throw new Error("The selected artifact is not a supported PNG under 10 MiB.");
      capturedFile = new File([blob], option.dataset.name, { type: "image/png" });
      const [runId, artifactId] = selectedValue.split(":");
      capturedSourceArtifact = { runId, artifactId };
      previewVisualInputs(capturedFile, selectedReference(), preview, "Run screenshot artifact");
      updateLocalCompareButton();
      status.dataset.state = "info";
      status.textContent = "Preview the run screenshot below. It will not be sent to Groq unless you check the separate consent box and submit.";
    } catch (error) { status.dataset.state = "error"; status.textContent = error.message; }
    finally { captured.disabled = false; }
  });
  baselineCaptured.addEventListener("change", async () => {
    capturedReferenceFile = null;
    capturedReferenceArtifact = null;
    reference.value = "";
    if (!baselineCaptured.value) {
      previewVisualInputs(selectedCurrent(), null, preview, "Run screenshot artifact");
      updateLocalCompareButton();
      return;
    }
    const option = baselineCaptured.selectedOptions[0];
    if (Number(option.dataset.bytes) > 10 * 1024 * 1024) { status.textContent = "The reference screenshot is over the 10 MiB review limit."; baselineCaptured.value = ""; return; }
    const selectedValue = baselineCaptured.value;
    status.dataset.state = "pending";
    status.textContent = "Loading the prior run screenshot for comparison…";
    baselineCaptured.disabled = true;
    try {
      const response = await fetch(option.dataset.url, { credentials: "same-origin", headers: await authorizedHeaders() });
      if (!response.ok) throw new Error(response.status === 410 ? "The reference screenshot expired or failed its integrity check." : `Reference screenshot could not be loaded (${response.status}).`);
      const blob = await response.blob();
      if (baselineCaptured.value !== selectedValue) return;
      if (blob.type !== "image/png" || blob.size > 10 * 1024 * 1024) throw new Error("The selected baseline is not a supported PNG under 10 MiB.");
      capturedReferenceFile = new File([blob], option.dataset.name, { type: "image/png" });
      const [runId, artifactId] = selectedValue.split(":");
      capturedReferenceArtifact = { runId, artifactId };
      previewVisualInputs(selectedCurrent(), capturedReferenceFile, preview, "Run screenshot artifact");
      updateLocalCompareButton();
      status.dataset.state = "info";
      status.textContent = "Prior run loaded. Compare locally, or include it in the separately consented Groq review.";
    } catch (error) { status.dataset.state = "error"; status.textContent = error.message; }
    finally { baselineCaptured.disabled = !baselineCaptured.options.length || baselineCaptured.options.length <= 1; }
  });
  form.addEventListener("change", (event) => {
    if (event.target === captured || event.target === baselineCaptured) return;
    if (event.target === current && current.files[0]) {
      captured.value = ""; capturedFile = null; capturedSourceArtifact = null;
      baselineCaptured.value = ""; capturedReferenceFile = null; capturedReferenceArtifact = null;
    }
    if (event.target === reference && reference.files[0]) { baselineCaptured.value = ""; capturedReferenceFile = null; capturedReferenceArtifact = null; }
    refreshBaselineOptions();
    previewVisualInputs(current.files[0] ?? capturedFile, selectedReference(), preview, capturedFile && !current.files[0] ? "Run screenshot artifact" : "Current screenshot");
    updateLocalCompareButton();
  });
  compareLocally.addEventListener("click", async () => {
    compareLocally.disabled = true;
    status.dataset.state = "pending";
    status.textContent = "Comparing these images locally in your browser…";
    try {
      const actual = selectedCurrent();
      const baseline = selectedReference();
      if (!actual || !baseline) throw new Error("Choose a current screenshot and an approved reference first.");
      const comparison = await compareImageFilesLocally(baseline, actual);
      localComparison.replaceChildren(renderPixelComparison(comparison, "LOCAL-ONLY PIXEL COMPARISON"));
      status.dataset.state = "success";
      status.textContent = "Pixel comparison completed in this browser. No images or comparison data were sent to Atlas or Groq.";
    } catch (error) { status.dataset.state = "error"; status.textContent = error.message; }
    finally { updateLocalCompareButton(); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    status.dataset.state = "";
    submit.disabled = true;
    try {
      const currentFile = current.files[0] ?? capturedFile;
      const referenceFile = selectedReference();
      if (!currentFile || currentFile.size > 10 * 1024 * 1024 || (referenceFile && referenceFile.size > 10 * 1024 * 1024)) throw new Error("Choose PNG files no larger than 10 MiB each.");
      if (currentFile.type !== "image/png" || (referenceFile && referenceFile.type !== "image/png")) throw new Error("Only PNG screenshots are supported.");
      if (referenceFile && !criteria.value.trim()) throw new Error("Add the team's visual criteria when using a reference image.");
      const payload = {
        imageBase64: await fileToBase64(currentFile),
        ...(capturedSourceArtifact && !current.files[0] ? { sourceArtifact: capturedSourceArtifact } : {}),
        ...(referenceFile ? { referenceImageBase64: await fileToBase64(referenceFile), criteria: criteria.value.trim() } : {}),
        ...(capturedReferenceArtifact && !reference.files[0] ? { referenceSourceArtifact: capturedReferenceArtifact } : {}),
        providerConsent: consent.checked,
      };
      const idempotencyKey = await visualRequestKey(payload);
      const result = await api(`/v1/projects/${encodeURIComponent(selectedProject)}/visual-reviews`, {
        method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload),
      });
      activeVisualPreview = { reviewId: result.review.id, file: currentFile };
      form.reset();
      capturedFile = null;
      capturedSourceArtifact = null;
      capturedReferenceFile = null;
      capturedReferenceArtifact = null;
      baselineCaptured.value = "";
      preview.replaceChildren();
      status.textContent = result.review.status === "complete"
        ? "Review recorded. Suggestions are advisory; an empty issue list is not a design pass."
        : "Review is inconclusive. No image passed or failed; see the safe error details below.";
      status.dataset.state = result.review.status === "complete" ? "success" : "warning";
      renderReviewResult(result.review, section);
      await refreshSelectedProject();
    } catch (error) { status.dataset.state = "error"; status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  projectDetail.append(section);
}

async function compareImageFilesLocally(baselineFile, actualFile) {
  const [baseline, actual] = await Promise.all([decodeLocalPng(baselineFile), decodeLocalPng(actualFile)]);
  if (baseline.width !== actual.width || baseline.height !== actual.height) throw new Error("Reference and current screenshots must have matching dimensions.");
  const worker = new Worker("/pixel-diff-worker.js", { type: "module" });
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); worker.terminate(); callback(value); };
    const timer = setTimeout(() => finish(reject, new Error("Local screenshot comparison timed out.")), 30_000);
    worker.onmessage = ({ data }) => data?.ok ? finish(resolve, data.comparison) : finish(reject, new Error(data?.error ?? "Local screenshot comparison failed."));
    worker.onerror = () => finish(reject, new Error("Local screenshot comparison worker failed."));
    const transfer = (image) => image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength);
    const baselineBuffer = transfer(baseline);
    const actualBuffer = transfer(actual);
    worker.postMessage({
      baseline: { width: baseline.width, height: baseline.height, data: baselineBuffer },
      actual: { width: actual.width, height: actual.height, data: actualBuffer },
    }, [baselineBuffer, actualBuffer]);
  });
}

async function decodeLocalPng(file) {
  if (file.type !== "image/png" || file.size > 10 * 1024 * 1024) throw new Error("Local comparison accepts PNG files up to 10 MiB each.");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 8_000_000) {
      throw new Error("PNG dimensions exceed the local comparison limits.");
    }
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot read image pixels for local comparison.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: pixels.data };
  } finally { bitmap.close(); }
}

function previewVisualInputs(current, reference, container, currentLabel = "Current screenshot") {
  container.replaceChildren();
  for (const [label, file] of [[currentLabel, current], ["Approved reference", reference]]) {
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

function renderVisualReviewHistory(reviews, proposals) {
  const section = document.createElement("section"); section.className = "visual-review-history";
  const title = document.createElement("p"); title.className = "section-title"; title.textContent = "RECENT VISUAL REVIEWS · REPORTS RETAINED FOR 30 DAYS"; section.append(title);
  if (!reviews.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No component visual reviews yet."; section.append(empty);
  }
  for (const review of reviews) {
    const card = renderReviewResult(review, section, true, proposals.filter((proposal) => proposal.visualReviewId === review.id));
    if (activeVisualPreview?.reviewId === review.id) renderFindingOverlay(activeVisualPreview.file, review.result?.issues ?? [], card);
  }
  projectDetail.append(section);
}

function renderReviewResult(review, container, compact = false, proposals = []) {
  const card = document.createElement("article"); card.className = "visual-review-result";
  if (review.id) card.dataset.reviewId = review.id;
  const heading = document.createElement("div"); heading.className = "panel-heading";
  const title = document.createElement("strong"); title.textContent = `${review.result?.requestedModel ?? review.requestedModel ?? "Groq visual review"} · ${review.createdAt ? new Date(review.createdAt).toLocaleString() : "just now"}`;
  const result = review.result ?? {};
  const pill = document.createElement("span"); pill.className = `pill${review.status === "complete" ? "" : " pending"}`; pill.textContent = review.status.toUpperCase(); heading.append(title, pill);
  if (result.source === "synthetic-fixture") { const fixture = document.createElement("span"); fixture.className = "pill pending"; fixture.textContent = "SYNTHETIC FIXTURE"; heading.append(fixture); }
  card.append(heading);
  if (review.sourceRunId && review.sourceArtifactId) {
    const provenance = document.createElement("p"); provenance.className = "review-note";
    provenance.textContent = `Source: run ${review.sourceRunId.slice(0, 8)} · ${review.sourceArtifactName ?? `artifact ${review.sourceArtifactId.slice(0, 8)}`} · exact PNG SHA-256 verified before provider egress.`;
    card.append(provenance);
  } else {
    const provenance = document.createElement("p"); provenance.className = "review-note"; provenance.textContent = "Source: user-uploaded PNG; no Atlas run artifact is linked."; card.append(provenance);
  }
  if (review.referenceRunId && review.referenceArtifactId) {
    const referenceProvenance = document.createElement("p"); referenceProvenance.className = "review-note";
    referenceProvenance.textContent = `Reference: prior run ${review.referenceRunId.slice(0, 8)} · ${review.referenceArtifactName ?? `artifact ${review.referenceArtifactId.slice(0, 8)}`} · same target/contract/profile/component verified.`;
    card.append(referenceProvenance);
  }
  if (!compact && result.criteria) { const criteria = document.createElement("p"); criteria.className = "review-criteria"; criteria.textContent = `Criteria: ${result.criteria}`; card.append(criteria); }
  if (result.pixelComparison) card.append(renderPixelComparison(result.pixelComparison, "DETERMINISTIC REFERENCE COMPARISON"));
  const issues = result.issues ?? [];
  if (!issues.length) {
    const note = document.createElement("p"); note.className = "review-note"; note.textContent = review.status === "complete" ? "No suggestions were returned. This is not a visual pass." : "No visual finding is available. This result is inconclusive."; card.append(note);
  }
  for (const [index, issue] of issues.entries()) {
    const item = document.createElement("div"); item.className = "visual-issue";
    const label = document.createElement("strong"); label.textContent = `Finding ${index + 1} · ${issue.severity} · ${issue.category} · ${issue.kind}`;
    const observation = document.createElement("p"); observation.textContent = issue.observation;
    const suggestion = document.createElement("p"); suggestion.textContent = `Suggestion: ${issue.recommendation}`;
    const confidence = document.createElement("small"); confidence.textContent = `Model confidence: ${issue.confidence} (self-reported, not calibrated)${issue.region ? ` · region ${issue.region.x}, ${issue.region.y}, ${issue.region.width}, ${issue.region.height} / 1000` : " · no region supplied"}`;
    item.append(label, observation, suggestion, confidence); card.append(item);
    if (review.status === "complete" && review.id) renderFindingDisposition(review, index, item);
  }
  if (review.status === "complete" && issues.length) renderCodeProposalForm(review, card, proposals);
  for (const proposal of proposals) renderCodeProposal(proposal, card);
  if (review.error) { const error = document.createElement("p"); error.className = "review-note"; error.textContent = review.error; card.append(error); }
  const hashes = document.createElement("small"); hashes.className = "review-hashes"; hashes.textContent = `Screenshot SHA-256 ${review.screenshotSha256 ?? review.result?.imageSha256 ?? "unavailable"}${review.referenceSha256 ?? review.result?.referenceSha256 ? ` · reference SHA-256 ${review.referenceSha256 ?? review.result.referenceSha256}` : ""} · verdict effect none`;
  card.append(hashes); container.append(card);
  return card;
}

function renderFindingDisposition(review, index, container) {
  const saved = (review.findingDispositions ?? []).find((item) => item.index === index)?.disposition ?? "";
  const form = document.createElement("form"); form.className = "finding-disposition";
  const label = document.createElement("label"); label.textContent = `Team review for finding ${index + 1}`;
  const select = document.createElement("select"); select.setAttribute("aria-label", `Team review for finding ${index + 1}`);
  const choices = [
    ["", "Not reviewed"],
    ["confirmed", "Confirmed"],
    ["accepted-risk", "Accepted risk"],
    ["false-positive", "False positive"],
    ["needs-follow-up", "Needs follow-up"],
  ];
  for (const [value, text] of choices) {
    const option = document.createElement("option"); option.value = value; option.textContent = text; option.selected = value === saved; select.append(option);
  }
  label.append(select);
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "text-button"; submit.textContent = "Save review";
  const note = document.createElement("small"); note.className = "disposition-note"; note.textContent = "Team evaluation label only; it does not change the release verdict.";
  const status = document.createElement("small"); status.setAttribute("role", "status"); status.className = "disposition-status";
  form.append(label, submit, note, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); submit.disabled = true; status.textContent = "Saving team disposition…";
    try {
      await api(`/v1/projects/${encodeURIComponent(selectedProject)}/visual-reviews/${encodeURIComponent(review.id)}/findings/${index}/disposition`, {
        method: "PUT", body: JSON.stringify({ disposition: select.value || null }),
      });
      status.textContent = "Saved. This label does not affect the release verdict.";
      await refreshSelectedProject();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  container.append(form);
}

function renderFindingOverlay(file, issues, card) {
  if (!file || !issues.length) return;
  const figure = document.createElement("figure"); figure.className = "visual-finding-preview";
  const caption = document.createElement("figcaption");
  const localizedCount = issues.filter((issue) => issue.region).length;
  const captionText = document.createElement("span");
  captionText.textContent = localizedCount
    ? `Current screenshot · ${localizedCount} model-supplied finding region${localizedCount === 1 ? "" : "s"} (illustrative coordinates, not pixel segmentation)`
    : "Current screenshot · model supplied no finding coordinates";
  const clearButton = document.createElement("button"); clearButton.type = "button"; clearButton.className = "text-button"; clearButton.textContent = "Clear"; clearButton.setAttribute("aria-label", "Clear local screenshot from this page");
  clearButton.addEventListener("click", () => { activeVisualPreview = null; figure.remove(); });
  caption.append(captionText, clearButton);
  const frame = document.createElement("div"); frame.className = "visual-finding-frame";
  const image = document.createElement("img"); image.alt = localizedCount ? "Current screenshot with numbered model-supplied finding regions" : "Current screenshot; the model supplied no finding regions";
  const objectUrl = URL.createObjectURL(file); image.src = objectUrl;
  image.addEventListener("load", () => {
    frame.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
    URL.revokeObjectURL(objectUrl);
  }, { once: true });
  image.addEventListener("error", () => URL.revokeObjectURL(objectUrl), { once: true });
  frame.append(image);
  issues.forEach((issue, index) => {
    if (!issue.region) return;
    const marker = document.createElement("span"); marker.className = "visual-finding-region";
    marker.setAttribute("aria-hidden", "true"); marker.textContent = String(index + 1);
    marker.style.left = `${issue.region.x / 10}%`;
    marker.style.top = `${issue.region.y / 10}%`;
    marker.style.width = `${issue.region.width / 10}%`;
    marker.style.height = `${issue.region.height / 10}%`;
    frame.append(marker);
  });
  figure.append(caption, frame);
  const firstIssue = card.querySelector(".visual-issue");
  if (firstIssue) card.insertBefore(figure, firstIssue);
  else card.append(figure);
}

function renderPixelComparison(comparison, titleText) {
  const section = document.createElement("section"); section.className = "pixel-comparison";
  const label = document.createElement("strong"); label.textContent = titleText;
  const changed = document.createElement("p"); changed.textContent = `${(comparison.pixelDiffRatio * 100).toFixed(2)}% of pixels differ beyond channel tolerance 6.`;
  const similarity = document.createElement("p"); similarity.textContent = `Coarse luminance similarity: ${(comparison.perceptualScore * 100).toFixed(2)}% across a 16 by 16 grid.`;
  const scope = document.createElement("small"); scope.textContent = `${comparison.width} by ${comparison.height} pixels. Measures visual change only; it does not rate design quality, accessibility, or release readiness.`;
  section.append(label, changed, similarity, scope);
  if (comparison.firstDivergenceBox) {
    const region = document.createElement("p"); const box = comparison.firstDivergenceBox;
    region.textContent = `Difference bounding box: x ${box.x}, y ${box.y}, w ${box.w}, h ${box.h}.`;
    section.append(region);
  }
  return section;
}

function renderCodeProposalForm(review, container) {
  const form = document.createElement("form"); form.className = "code-proposal-form";
  const heading = document.createElement("p"); heading.className = "section-title"; heading.textContent = "GUARDED CODE SUGGESTION";
  const sourceLabel = document.createElement("label"); sourceLabel.textContent = "One component source file (up to 64 KiB)";
  const source = document.createElement("input"); source.type = "file"; source.accept = ".css,.html,.js,.jsx,.mjs,.svelte,.ts,.tsx,.vue"; source.required = true; sourceLabel.append(source);
  const taskLabel = document.createElement("label"); taskLabel.textContent = "Bounded change request (optional, up to 1200 characters)";
  const task = document.createElement("textarea"); task.maxLength = 1200; task.rows = 2; task.placeholder = "Address this visual finding while preserving behavior."; taskLabel.append(task);
  const consentLabel = document.createElement("label"); consentLabel.className = "check-option";
  const consent = document.createElement("input"); consent.type = "checkbox"; consent.required = true;
  const consentText = document.createElement("span"); consentText.textContent = "I reviewed this file and authorize sending its source and these visual findings to Groq. Atlas checks for common secrets, but that scan is not complete. The proposal will not be applied or tested.";
  consentLabel.append(consent, consentText);
  const status = document.createElement("p"); status.className = "notice code-proposal-status"; status.setAttribute("role", "status");
  const submit = document.createElement("button"); submit.className = "text-button"; submit.type = "submit"; submit.textContent = "Suggest a code change";
  form.append(heading, sourceLabel, taskLabel, consentLabel, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    submit.disabled = true;
    try {
      const selected = source.files[0];
      if (!selected || selected.size > 64 * 1024) throw new Error("Choose one source file no larger than 64 KiB.");
      if (task.value.trim().length > 1200) throw new Error("Keep the change request under 1200 characters.");
      const sourceText = await selected.text();
      const payload = { fileName: selected.name, source: sourceText, sourceConsent: consent.checked, ...(task.value.trim() ? { task: task.value.trim() } : {}) };
      const idempotencyKey = await visualRequestKey(payload);
      await api(`/v1/projects/${encodeURIComponent(selectedProject)}/visual-reviews/${encodeURIComponent(review.id)}/code-proposals`, {
        method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload),
      });
      await refreshSelectedProject();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  container.append(form);
}

function renderCodeProposal(proposal, container) {
  const result = proposal.result ?? {};
  const article = document.createElement("section"); article.className = "code-proposal-result";
  const heading = document.createElement("div"); heading.className = "panel-heading";
  const label = document.createElement("strong"); label.textContent = `${proposal.fileName ?? result.fileName ?? "Source file"} · ${result.requestedModel ?? proposal.requestedModel ?? "Code model"}`;
  const status = document.createElement("span"); status.className = `pill${proposal.status === "proposal" ? "" : " pending"}`; status.textContent = proposal.status.toUpperCase();
  heading.append(label, status); article.append(heading);
  const summary = document.createElement("p"); summary.className = "review-note"; summary.textContent = result.summary ?? proposal.error ?? "No proposal was returned."; article.append(summary);
  if (result.unifiedDiff) { const diff = document.createElement("pre"); diff.className = "code-diff"; diff.textContent = result.unifiedDiff; article.append(diff); }
  const warning = document.createElement("p"); warning.className = "review-note"; warning.textContent = result.patchAppliesToSource === true
    ? "Proposal only: hunk context matched the supplied source, but Atlas did not write, run, or test the candidate. Review and verify it against the same component and target contract."
    : "Proposal only: Atlas did not apply, run, or test this change. Review and verify it against the same component and target contract."; article.append(warning);
  const hashes = [`Source SHA-256 ${proposal.sourceSha256 ?? result.sourceSha256 ?? "unavailable"}`];
  if (result.proposedSourceSha256) hashes.push(`proposed candidate SHA-256 ${result.proposedSourceSha256}`);
  hashes.push("source and candidate bytes are not retained");
  const hash = document.createElement("small"); hash.className = "review-hashes"; hash.textContent = hashes.join(" · "); article.append(hash);
  container.append(article);
}

function formatBytes(value) { return value < 1024 ? `${Math.max(0, Math.round(value))} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`; }

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
      } catch (error) { window.alert([error.message, error.retryAfter ? `Retry ${error.retryAfter}.` : ""].filter(Boolean).join(" ")); }
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
    <label>Component CSS selectors to crop at the final journey state<textarea name="componentSelectors" rows="2" placeholder="[data-product-viewer]&#10;.ar-product-card"></textarea><small>Optional; one selector per line, at most five. Each selector must match exactly one visible element inside the viewport.</small></label>
    <label>Maximum changed pixels for component release check (%)<input name="visualThresholdPercent" type="number" min="0" max="100" step="0.1" value="" placeholder="Disabled"><small>Optional deterministic threshold against a prior SHIP run. Requires screenshots and component selectors. Each evaluation checks one component/profile capture; it does not aggregate the whole release.</small></label>
    <details class="advanced-contract"><summary>Advanced · edit the versioned target contract</summary><label>Contract JSON<textarea name="contract" spellcheck="false" aria-label="Advanced target contract JSON"></textarea></label></details>
  `;
  const textarea = form.elements.contract;
  let validatedSnapshot = null;
  let advancedEdited = false;
  const buildContract = () => {
    const values = new FormData(form);
    const targetUrl = new URL(String(values.get("targetUrl")));
    const profiles = values.getAll("profiles").map(String);
    const name = String(values.get("targetName")).trim();
    const slug = `studio-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "staging"}`;
    const screenshots = values.get("screenshotConsent") === "on";
    const visualThresholdText = String(values.get("visualThresholdPercent") ?? "").trim();
    const redactSelectors = String(values.get("redactSelectors") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const componentSelectors = screenshots
      ? String(values.get("componentSelectors") ?? "").split(/\r?\n/).map((selector) => selector.trim()).filter(Boolean).map((selector, index) => ({ id: `component-${index + 1}`, selector }))
      : [];
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
      policy: { version: "1", criticalProfiles: profiles, minimumScore: 50, ...(visualThresholdText !== "" ? { visualGate: { version: "1", maxPixelDiffRatio: Number(visualThresholdText) / 100 } } : {}) },
      screenshots: { consent: screenshots, redactSelectors: screenshots ? redactSelectors : [], componentSelectors },
    };
  };
  const refreshContract = () => {
    if (advancedEdited) return;
    try { textarea.value = JSON.stringify(buildContract(), null, 2); } catch { /* keep editing incomplete fields */ }
  };
  const validationStatus = document.createElement("p"); validationStatus.className = "notice target-validation-status"; validationStatus.setAttribute("role", "status");
  const invalidateValidation = () => {
    if (!validatedSnapshot) return;
    validatedSnapshot = null;
    submit.disabled = true;
    validationStatus.dataset.state = "info";
    validationStatus.textContent = "Target settings changed. Run static validation again before registering.";
  };
  form.addEventListener("input", (event) => {
    invalidateValidation();
    if (event.target === textarea) advancedEdited = true;
    else { advancedEdited = false; refreshContract(); }
  });
  form.addEventListener("change", (event) => {
    invalidateValidation();
    if (event.target !== textarea) { advancedEdited = false; refreshContract(); }
  });
  refreshContract();
  const validate = document.createElement("button"); validate.className = "secondary"; validate.type = "button"; validate.textContent = "Validate target setup";
  validate.addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    validationStatus.dataset.state = "pending";
    validationStatus.textContent = "Checking the contract and current DNS answers. This does not open the target page.";
    validate.disabled = true;
    try {
      const contract = advancedEdited ? JSON.parse(textarea.value) : buildContract();
      const result = await api(`/v1/projects/${encodeURIComponent(selectedProject)}/targets/validate`, { method: "POST", body: JSON.stringify({ contract }) });
      validatedSnapshot = JSON.stringify(contract);
      submit.disabled = false;
      validationStatus.dataset.state = "success";
      validationStatus.textContent = `Static checks passed for ${result.target.url} (${result.target.profiles.join(", ")}). Ownership verification is still pending; the browser journey and selectors have not been tested.`;
    } catch (error) {
      validationStatus.dataset.state = "error";
      validationStatus.textContent = error instanceof SyntaxError ? "Contract JSON must be valid." : error.message;
    } finally { validate.disabled = false; }
  });
  const submit = document.createElement("button"); submit.className = "primary"; submit.type = "submit"; submit.textContent = "Register target";
  submit.disabled = true;
  const helper = document.createElement("small"); helper.textContent = "Domain ownership is checked through a DNS TXT challenge. This confirms control of the hostname; it does not mean a browser run has happened.";
  form.append(helper, validate, submit, validationStatus);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const contract = advancedEdited ? JSON.parse(textarea.value) : buildContract();
      if (!validatedSnapshot || validatedSnapshot !== JSON.stringify(contract)) {
        invalidateValidation();
        validationStatus.dataset.state = "warning";
        validationStatus.textContent = "Validate the current target settings before registering.";
        return;
      }
      await api(`/v1/projects/${selectedProject}/targets`, { method: "POST", body: JSON.stringify({ contract }) });
      await loadProject(selectedProject);
    } catch (error) { window.alert(error instanceof SyntaxError ? "Contract must be valid JSON." : error.message); }
  });
  projectDetail.append(form);
}

if (!sharedToken && supabase) {
  supabase.auth.getSession().then(async ({ data: { session } }) => {
    if (!session) return;
    await finishSupabaseSession(localStorage.getItem("atlas.pending-org") ?? "");
  }).catch((error) => { document.querySelector("#auth-message").textContent = error.message; });
} else if (!sharedToken) {
  api("/v1/me").then(({ organizations: list }) => {
    organizations = list;
    if (!organizations.length) return;
    if (!organizations.some((org) => org.id === selectedOrg)) selectedOrg = organizations[0].id;
    localStorage.setItem("atlas.org", selectedOrg);
    showWorkspace().catch((error) => { authSection.hidden = false; workspace.hidden = true; document.querySelector("#auth-message").textContent = error.message; });
  }).catch(() => {});
}
