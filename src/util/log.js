const LEVELS = /** @type {Record<string, number>} */ ({ debug: 10, info: 20, warn: 30, error: 40 });

const ESC = String.fromCharCode(27);
const COLOR = process.env.NO_COLOR
  ? null
  : {
      debug: `${ESC}[90m`,
      info: `${ESC}[36m`,
      warn: `${ESC}[33m`,
      error: `${ESC}[31m`,
      reset: `${ESC}[0m`,
      dim: `${ESC}[2m`,
    };

/** @type {number} */
let threshold = LEVELS[process.env.ATLAS_LOG_LEVEL ?? "info"] ?? 20;

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} scope
 * @param {unknown[]} args
 */
function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const tag = COLOR ? `${COLOR[level]}${level.padEnd(5)}${COLOR.reset}` : level.padEnd(5);
  const scopeTag = COLOR ? `${COLOR.dim}[${scope}]${COLOR.reset}` : `[${scope}]`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${tag} ${scopeTag} ${args.map(fmt).join(" ")}\n`);
}

/** @param {unknown} v */
function fmt(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** @param {string} scope */
export function logger(scope) {
  return {
    /** @param {...unknown} args */ debug: (...args) => emit("debug", scope, args),
    /** @param {...unknown} args */ info: (...args) => emit("info", scope, args),
    /** @param {...unknown} args */ warn: (...args) => emit("warn", scope, args),
    /** @param {...unknown} args */ error: (...args) => emit("error", scope, args),
  };
}

/** @param {"debug"|"info"|"warn"|"error"} level */
export function setLogLevel(level) {
  threshold = LEVELS[level] ?? threshold;
}

/** @param {string} title */
export function banner(title) {
  const line = "-".repeat(Math.max(0, 68 - title.length));
  const dim = COLOR ? COLOR.dim : "";
  const reset = COLOR ? COLOR.reset : "";
  process.stdout.write(`\n${dim}-- ${title} ${line}${reset}\n`);
}
