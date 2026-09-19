import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root, independent of cwd. */
export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** @param {...string} parts */
export function fromRoot(...parts) {
  return path.join(ROOT, ...parts);
}

/** @param {string} dir */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  return file;
}

/**
 * @template T
 * @param {string} file
 * @returns {Promise<T>}
 */
export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * @param {string} file
 * @param {string | Uint8Array} data
 */
export async function writeFileEnsured(file, data) {
  await ensureDir(path.dirname(file));
  await writeFile(file, data);
  return file;
}

/**
 * @param {string} dir
 * @param {string} ext
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** @param {string} dir */
export async function emptyDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export { existsSync };
