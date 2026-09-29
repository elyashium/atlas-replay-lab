/** Versioned, customer-owned staging target contract. */
export const TARGET_CONTRACT_VERSION = 1;

const STEP_TYPES = new Set(["waitForVisible", "waitForHidden", "click", "fill"]);

/**
 * Validate a JSON target contract without opening its URL.
 * @param {unknown} value
 * @returns {{ ok: boolean; issues: string[]; contract?: any }}
 */
export function validateTargetContract(value) {
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: ["contract must be a JSON object"] };
  }
  const c = /** @type {any} */ (value);
  if (c.schemaVersion !== TARGET_CONTRACT_VERSION) issues.push(`schemaVersion must be ${TARGET_CONTRACT_VERSION}`);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(c.id ?? "")) issues.push("id must be 2-64 letters, digits, dot, underscore or dash");
  if (typeof c.name !== "string" || !c.name.trim()) issues.push("name is required");
  if (!["development", "staging"].includes(c.environment)) issues.push("environment must be development or staging");
  if (c.authorization?.authorized !== true) issues.push("explicit staging authorization is required (authorization.authorized: true)");
  let target;
  try {
    target = new URL(c.target?.url);
    if (!["http:", "https:"].includes(target.protocol)) issues.push("target.url must use http or https");
    if (target.username || target.password) issues.push("credentials in target.url are forbidden; use environment-backed fill steps");
    if (target.search) issues.push("query strings are forbidden in target.url to prevent token leakage; use a non-secret staging route");
  } catch {
    issues.push("target.url must be an absolute http(s) URL");
  }
  if (!Array.isArray(c.target?.allowedOrigins) || !c.target.allowedOrigins.length) {
    issues.push("target.allowedOrigins must list the target origin and any required app/API/CDN origins");
  } else {
    const origins = new Set();
    for (const origin of c.target.allowedOrigins) {
      try {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) issues.push(`allowed origin must be an origin only: ${origin}`);
        origins.add(parsed.origin);
      } catch { issues.push(`invalid allowed origin: ${origin}`); }
    }
    if (target && !origins.has(target.origin)) issues.push("target.url origin must appear in target.allowedOrigins");
  }
  if (c.target?.buildId !== undefined && (typeof c.target.buildId !== "string" || !/^[a-z0-9._-]{1,128}$/i.test(c.target.buildId))) issues.push("target.buildId must be a short commit/deployment identifier using letters, digits, dot, underscore or dash");
  if (!Array.isArray(c.journey?.steps) || c.journey.steps.length === 0) issues.push("journey.steps must contain at least one meaningful step");
  else c.journey.steps.forEach((step, i) => {
    if (!step || !STEP_TYPES.has(step.type)) issues.push(`journey.steps[${i}].type must be one of ${[...STEP_TYPES].join(", ")}`);
    if (typeof step.selector !== "string" || !step.selector.trim()) issues.push(`journey.steps[${i}].selector is required`);
    if (step.type === "fill" && !/^ATLAS_[A-Z0-9_]+$/.test(step.valueFromEnv ?? "")) issues.push(`journey.steps[${i}].valueFromEnv must name an ATLAS_* environment variable`);
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 120000)) issues.push(`journey.steps[${i}].timeoutMs must be 100..120000`);
  });
  if (!Number.isInteger(c.budgets?.journeyTimeoutMs) || c.budgets.journeyTimeoutMs < 1000 || c.budgets.journeyTimeoutMs > 600000) issues.push("budgets.journeyTimeoutMs must be 1000..600000");
  if (!Number.isInteger(c.budgets?.stepTimeoutMs) || c.budgets.stepTimeoutMs < 100 || c.budgets.stepTimeoutMs > 120000) issues.push("budgets.stepTimeoutMs must be 100..120000");
  for (const name of ["success", "fallback"]) {
    if (typeof c.journey?.[name]?.selector !== "string" || !c.journey[name].selector.trim()) issues.push(`journey.${name}.selector is required`);
  }
  if (!Array.isArray(c.profiles) || !c.profiles.length || c.profiles.some((id) => typeof id !== "string")) issues.push("profiles must list one or more profile ids");
  if (typeof c.policy?.version !== "string" || !c.policy.version.trim() || c.policy.version.length > 64) issues.push("policy.version is required and must be at most 64 characters");
  if (!Array.isArray(c.policy?.criticalProfiles) || !c.policy.criticalProfiles.length) issues.push("policy.criticalProfiles must list at least one required profile");
  else if (Array.isArray(c.profiles) && c.policy.criticalProfiles.some((id) => !c.profiles.includes(id))) issues.push("every critical profile must also appear in profiles");
  if (Array.isArray(c.journey?.fallback?.requiredOn) && Array.isArray(c.policy?.criticalProfiles)) {
    for (const id of c.journey.fallback.requiredOn) {
      if (typeof id !== "string" || !c.profiles?.includes(id)) issues.push(`fallback profile ${id} must appear in profiles`);
      if (!c.policy.criticalProfiles.includes(id)) issues.push(`fallback profile ${id} must be critical so missing fallback evidence cannot ship`);
    }
  }
  if (!Number.isFinite(c.policy?.minimumScore) || c.policy.minimumScore < 0 || c.policy.minimumScore > 100) issues.push("policy.minimumScore must be 0..100");
  if (typeof c.mediaConsent !== "boolean") issues.push("mediaConsent must explicitly allow or deny page camera/microphone APIs");
  if (typeof c.screenshots?.consent !== "boolean") issues.push("screenshots.consent must be explicitly true or false");
  if (c.screenshots?.consent === true && (!Array.isArray(c.screenshots?.redactSelectors) || !c.screenshots.redactSelectors.length)) issues.push("screenshots.redactSelectors must include at least one selector when screenshot consent is enabled");
  if (c.screenshots?.componentSelectors !== undefined) {
    if (!Array.isArray(c.screenshots.componentSelectors) || c.screenshots.componentSelectors.length > 5) {
      issues.push("screenshots.componentSelectors must be an array of at most five selector objects");
    } else {
      if (c.screenshots.componentSelectors.length && c.screenshots.consent !== true) issues.push("component selector capture requires screenshot consent");
      const componentIds = new Set();
      for (const [index, item] of c.screenshots.componentSelectors.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`screenshots.componentSelectors[${index}] must be an object`); continue; }
        if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(item.id)) issues.push(`screenshots.componentSelectors[${index}].id must be a simple 1..32 character artifact label`);
        else if (componentIds.has(item.id)) issues.push(`screenshots.componentSelectors[${index}].id must be unique`);
        else componentIds.add(item.id);
        if (typeof item.selector !== "string" || !item.selector.trim() || item.selector.length > 256) issues.push(`screenshots.componentSelectors[${index}].selector must be 1..256 characters`);
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, issues, contract: c };
}

/** Remove query, fragment and credentials before writing a URL to artifacts. @param {URL} url */
export function safeTargetUrl(url) {
  const safe = new URL(url.href);
  safe.username = ""; safe.password = ""; safe.search = ""; safe.hash = "";
  return safe.href;
}
