import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const PROJECT_SCHEMA_VERSION = 1;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;

export type ProjectState = { schemaVersion: number; prefix: string; nextTabletId: number };
export type ProjectContext = { statePath: string; cacheDirectory: string; state: ProjectState };

function validState(value: unknown): value is ProjectState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ProjectState>;
  return state.schemaVersion === PROJECT_SCHEMA_VERSION && typeof state.prefix === "string" && /^[A-Z0-9]{1,4}$/.test(state.prefix) && Number.isInteger(state.nextTabletId) && state.nextTabletId >= 1;
}

function derivePrefix(projectRoot: string): string {
  const parts = basename(resolve(projectRoot)).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const initials = parts.map((part) => part[0]).join("");
  const candidate = (initials.length >= 2 ? initials : parts.join("").slice(0, 4) || "VC").slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return candidate || "VC";
}

async function readState(path: string): Promise<ProjectState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return validState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx");
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(path, { force: true });
      } catch { /* Another allocator may be replacing the lock. */ }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}

async function writeState(path: string, state: ProjectState): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function clearSourceCache(cacheDirectory: string): Promise<void> {
  try {
    const entries = await readdir(cacheDirectory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.name !== "task").map((entry) => rm(resolve(cacheDirectory, entry.name), { recursive: true, force: true })));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function recoverStateFromCache(cacheDirectory: string): Promise<ProjectState | undefined> {
  const prefixes = new Set<string>();
  let nextTabletId = 1;
  try {
    const entries = await readdir(cacheDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "task" || !entry.isDirectory()) continue;
      try {
        const record = JSON.parse(await readFile(resolve(cacheDirectory, entry.name, "cache-manifest.json"), "utf8")) as { cache?: { schemaVersion?: number; projectPrefix?: string }; manifest?: { tablets?: { id?: string }[] } };
        if (record.cache?.schemaVersion !== 4 || typeof record.cache.projectPrefix !== "string" || !validState({ schemaVersion: 1, prefix: record.cache.projectPrefix, nextTabletId: 1 })) continue;
        prefixes.add(record.cache.projectPrefix);
        for (const tablet of record.manifest?.tablets ?? []) {
          const match = tablet.id?.match(new RegExp(`^${record.cache.projectPrefix}-VC-(\\d+)$`));
          if (match) nextTabletId = Math.max(nextTabletId, Number(match[1]) + 1);
        }
      } catch { /* Ignore incomplete or obsolete source cache entries. */ }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (prefixes.size !== 1) return undefined;
  return { schemaVersion: PROJECT_SCHEMA_VERSION, prefix: [...prefixes][0], nextTabletId };
}

function projectRootFromCache(cacheDirectory: string): string {
  const absolute = resolve(cacheDirectory);
  const parent = dirname(absolute);
  if (basename(parent) === "visual-context" && basename(dirname(parent)) === ".pi") return dirname(dirname(parent));
  return parent;
}

export async function loadProjectContext(options: { projectRoot?: string; cacheDirectory: string; stateRoot?: string }): Promise<ProjectContext> {
  const projectRoot = resolve(options.projectRoot ?? projectRootFromCache(options.cacheDirectory));
  const stateRoot = resolve(options.stateRoot ?? resolve(projectRoot, ".pi", "visual-context"));
  const statePath = resolve(stateRoot, "project.json");
  const lockPath = `${statePath}.lock`;
  const existing = await readState(statePath);
  if (existing) return { statePath, cacheDirectory: options.cacheDirectory, state: existing };
  return withLock(lockPath, async () => {
    const afterWait = await readState(statePath);
    if (afterWait) return { statePath, cacheDirectory: options.cacheDirectory, state: afterWait };
    const recovered = await recoverStateFromCache(options.cacheDirectory);
    const state = recovered ?? { schemaVersion: PROJECT_SCHEMA_VERSION, prefix: derivePrefix(projectRoot), nextTabletId: 1 };
    if (!recovered) await clearSourceCache(options.cacheDirectory);
    await writeState(statePath, state);
    return { statePath, cacheDirectory: options.cacheDirectory, state };
  });
}

export async function reserveTabletIds(context: ProjectContext, count: number): Promise<{ ids: string[]; state: ProjectState }> {
  if (!Number.isInteger(count) || count < 0) throw new Error("tablet reservation count must be a non-negative integer");
  return withLock(`${context.statePath}.lock`, async () => {
    const state = await readState(context.statePath);
    if (!state) throw new Error(`project state is invalid or missing: ${context.statePath}`);
    const first = state.nextTabletId;
    const ids = Array.from({ length: count }, (_, index) => `${state.prefix}-VC-${String(first + index).padStart(6, "0")}`);
    const nextState = { ...state, nextTabletId: first + count };
    await writeState(context.statePath, nextState);
    context.state = nextState;
    return { ids, state: nextState };
  });
}

export { PROJECT_SCHEMA_VERSION };
