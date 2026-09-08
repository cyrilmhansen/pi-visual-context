import { glob, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

const GLOB_MARKERS = /[*?\[]/;

export function displaySourcePaths(paths: string[], cwd: string): string[] {
  const relativePaths = paths.map((path) => relative(cwd, path).split("\\").join("/"));
  const parts = relativePaths.map((path) => path.split("/"));
  return parts.map((segments, index) => {
    const base = basename(relativePaths[index]);
    if (parts.filter((other) => other.at(-1) === base).length === 1) return base;
    for (let count = 2; count <= segments.length; count++) {
      const suffix = segments.slice(-count).join("/");
      if (parts.filter((other) => other.slice(-count).join("/") === suffix).length === 1) return suffix;
    }
    return relativePaths[index];
  });
}

export async function expandSourcePatterns(patterns: string[], cwd: string): Promise<string[]> {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const matches = GLOB_MARKERS.test(pattern)
      ? await expandGlob(pattern, cwd)
      : [await regularFile(resolve(cwd, pattern), pattern)];
    for (const match of matches) {
      if (!seen.has(match)) {
        seen.add(match);
        expanded.push(match);
      }
    }
  }
  return expanded;
}

async function regularFile(path: string, display: string): Promise<string> {
  let info;
  try { info = await stat(path); } catch { throw new Error(`source file does not exist: ${display}`); }
  if (!info.isFile()) throw new Error(`source is not a regular file: ${display}`);
  return path;
}

async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  let matches: string[] = [];
  try { for await (const match of glob(pattern, { cwd })) matches.push(match); } catch (error) {
    throw new Error(`invalid source glob "${pattern}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: string[] = [];
  for (const match of matches) {
    const path = resolve(cwd, match);
    try {
      const info = await stat(path);
      if (info.isFile()) files.push(path);
    } catch { /* A concurrent deletion simply removes the match. */ }
  }
  files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (!files.length) throw new Error(`source glob matched no regular files: ${pattern}`);
  return files;
}
