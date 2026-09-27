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
}

function renderTarget(target) {
  const card = document.createElement("div"); card.className = "target-card";
  const heading = document.createElement("div");
  const strong = document.createElement("strong"); strong.textContent = target.name ?? "Staging target";
  const pill = document.createElement("span"); pill.className = `pill${target.verified ? "" : " pending"}`; pill.textContent = target.verified ? "OWNERSHIP VERIFIED" : "VERIFY OWNERSHIP";
  heading.append(strong, pill); card.append(heading);
  const url = document.createElement("p"); url.className = "mono"; url.textContent = target.baseUrl; card.append(url);
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
    <label>Build or deployment ID<input name="buildId" value="replace-with-deployment-id" maxlength="128" required></label>
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
