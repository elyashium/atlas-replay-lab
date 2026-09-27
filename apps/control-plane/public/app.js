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
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
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
      try { await api(`/v1/targets/${target.id}/runs`, { method: "POST", body: "{}" }); await loadProject(selectedProject); }
      catch (error) { window.alert(error.message); }
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
  const label = document.createElement("label"); label.textContent = "Versioned target contract (JSON)";
  const textarea = document.createElement("textarea"); textarea.name = "contract"; textarea.spellcheck = false; textarea.setAttribute("aria-label", label.textContent);
  textarea.value = JSON.stringify(contractTemplate(), null, 2); label.append(textarea);
  const note = document.createElement("small"); note.textContent = "Use the contract from your app's test environment; query tokens and credentials are rejected.";
  const submit = document.createElement("button"); submit.className = "primary"; submit.type = "submit"; submit.textContent = "Register target";
  form.append(label, note, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const contract = JSON.parse(textarea.value);
      await api(`/v1/projects/${selectedProject}/targets`, { method: "POST", body: JSON.stringify({ contract }) });
      await loadProject(selectedProject);
    } catch (error) { window.alert(error instanceof SyntaxError ? "Contract must be valid JSON." : error.message); }
  });
  projectDetail.append(form);
}

function contractTemplate() {
  return {
    schemaVersion: 1, id: "studio-staging", name: "Owned Web3D staging", environment: "staging",
    authorization: { authorized: true, note: "I am authorized to test this staging hostname" },
    target: { url: "https://staging.example.com/", allowedOrigins: ["https://staging.example.com"], buildId: "replace-with-deployment-id" },
    journey: { steps: [{ type: "waitForVisible", selector: "[data-experience-ready]", timeoutMs: 15000 }], success: { selector: "[data-experience-ready]" }, fallback: { selector: "[data-static-fallback]", requiredOn: ["webgl-unavailable"] } },
    profiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"], budgets: { journeyTimeoutMs: 45000, stepTimeoutMs: 12000 }, mediaConsent: false,
    policy: { version: "1", criticalProfiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"], minimumScore: 50 },
    screenshots: { consent: false, redactSelectors: [] },
  };
}

api("/v1/me").then(({ organizations: list }) => {
  organizations = list;
  if (!organizations.length) return;
  if (!organizations.some((org) => org.id === selectedOrg)) selectedOrg = organizations[0].id;
  localStorage.setItem("atlas.org", selectedOrg);
  showWorkspace().catch((error) => { authSection.hidden = false; workspace.hidden = true; document.querySelector("#auth-message").textContent = error.message; });
}).catch(() => {});
