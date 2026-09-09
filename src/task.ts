import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type VisualProfile } from "./profile.ts";
import { readPdfFonts, RenderCancelled, renderPdfPages } from "./rust.ts";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_SCHEMA_VERSION = 2;
const TASK_PIPELINE_VERSION = "0.3.0-visual-task-1";
const TASK_PROFILE: VisualProfile = { name: "normal", font: "Romulus", columns: 3, scale: 1, fontSize: 16, leading: 6, sideMargin: 64, gutter: 32 };

export type TaskManifest = {
  bytes: number;
  chars: number;
  pageCount: number;
  pageDimensions: { width: number; height: number }[];
  profile: VisualProfile;
  fontsUsed: string[];
  timingsMs: Record<string, number>;
  workers: number;
  cache: { schemaVersion: number; key: string; hit: boolean };
};

export type TaskRenderResult = { images: Buffer[]; manifest: TaskManifest };
export type TaskRenderOptions = {
  beforeRasterize?: (pageCount: number, chars: number) => Promise<boolean>;
  onCacheHit?: (pageCount: number, chars: number) => Promise<boolean>;
  cacheDirectory?: string;
};

type TaskCacheRecord = { cache: { schemaVersion: number; key: string }; manifest: TaskManifest; pages: { file: string; sha256: string }[] };
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const elapsedMs = (started: number) => Math.round((performance.now() - started) * 100) / 100;
const cacheEnabled = () => !["0", "false", "no", "off"].includes((process.env.PI_VISUAL_CONTEXT_CACHE ?? "1").toLowerCase());

async function taskKey(prompt: string): Promise<{ key: string; bytes: number; chars: number }> {
  const template = await readFile(resolve(root, "typst/task.typ"));
  const font = await readFile(resolve(root, "assets/fonts/romulus/Romulus.ttf"));
  const bytes = Buffer.byteLength(prompt, "utf8");
  const identity = {
    schemaVersion: TASK_SCHEMA_VERSION,
    pipelineVersion: TASK_PIPELINE_VERSION,
    promptSha256: sha256(Buffer.from(prompt, "utf8")),
    templateSha256: sha256(template),
    fontSha256: sha256(font),
    renderer: { profile: TASK_PROFILE, fallback: true, dpi: 1152, output: "1056x960", header: "TASK | page/total" },
  };
  return { key: sha256(JSON.stringify(identity)), bytes, chars: [...prompt].length };
}

async function loadTaskCache(directory: string, key: string): Promise<TaskRenderResult | undefined> {
  const entry = resolve(directory, key);
  const invalid = async () => { await rm(entry, { recursive: true, force: true }); return undefined; };
  try {
    const record = JSON.parse(await readFile(resolve(entry, "cache-manifest.json"), "utf8")) as TaskCacheRecord;
    if (record.cache?.schemaVersion !== TASK_SCHEMA_VERSION || record.cache.key !== key || !record.manifest || !Array.isArray(record.pages)) return invalid();
    const images: Buffer[] = [];
    for (const page of record.pages) {
      if (!/^task-\d{3}\.png$/.test(page.file) || typeof page.sha256 !== "string") return invalid();
      const image = await readFile(resolve(entry, page.file));
      if (sha256(image) !== page.sha256) return invalid();
      images.push(image);
    }
    if (images.length !== record.manifest.pageCount) return invalid();
    return { images, manifest: record.manifest };
  } catch {
    return invalid();
  }
}

async function publishTaskCache(directory: string, key: string, manifest: TaskManifest, images: Buffer[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(resolve(directory, `.tmp-${key.slice(0, 12)}-`));
  try {
    const pages = [];
    for (let index = 0; index < images.length; index++) {
      const file = `task-${String(index + 1).padStart(3, "0")}.png`;
      await writeFile(resolve(temporary, file), images[index]);
      pages.push({ file, sha256: sha256(images[index]) });
    }
    await writeFile(resolve(temporary, "cache-manifest.json"), `${JSON.stringify({ cache: { schemaVersion: TASK_SCHEMA_VERSION, key }, manifest, pages }, null, 2)}\n`);
    try { await rename(temporary, resolve(directory, key)); } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function renderTask(prompt: string, status: (text: string) => void, options: TaskRenderOptions = {}): Promise<TaskRenderResult> {
  const totalStarted = performance.now();
  const identity = await taskKey(prompt);
  const cacheDirectory = options.cacheDirectory ?? resolve(root, ".pi", "visual-context", "cache", "task");
  if (cacheEnabled()) {
    const lookupStarted = performance.now();
    const cached = await loadTaskCache(cacheDirectory, identity.key);
    const lookupMs = elapsedMs(lookupStarted);
    if (cached) {
      if (options.onCacheHit && !await options.onCacheHit(cached.images.length, cached.manifest.chars)) throw new RenderCancelled();
      cached.manifest.timingsMs = { cacheLookup: lookupMs, total: elapsedMs(totalStarted) };
      cached.manifest.workers = 0;
      cached.manifest.cache = { schemaVersion: TASK_SCHEMA_VERSION, key: identity.key, hit: true };
      status(`task cache hit · ${cached.images.length} tablets`);
      return cached;
    }
  }
  const work = await mkdtemp(resolve(root, ".pi-visual-context-task-"));
  try {
    const promptPath = resolve(work, "prompt.txt");
    await writeFile(promptPath, prompt, "utf8");
    const pdf = resolve(work, "task.pdf");
    const fontDir = resolve(root, "assets/fonts/romulus");
    status("laying out task");
    const layoutStarted = performance.now();
    await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${promptPath.slice(root.length + 1)}`, "--input", `font=${TASK_PROFILE.font}`, "--input", `cols=${TASK_PROFILE.columns}`, "--input", `size=${TASK_PROFILE.fontSize}`, "--input", `leading=${TASK_PROFILE.leading}`, "--input", `margin=${TASK_PROFILE.sideMargin}`, "--input", `gutter=${TASK_PROFILE.gutter}`, resolve(root, "typst/task.typ"), pdf]);
    const layoutMs = elapsedMs(layoutStarted);
    const pdfInfoStarted = performance.now();
    const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
    const pdfinfoMs = elapsedMs(pdfInfoStarted);
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pageCount) throw new Error("task renderer produced no PDF pages");
    status(`TASK PDF ready: ${pageCount} tablets`);
    if (options.beforeRasterize && !await options.beforeRasterize(pageCount, identity.chars)) throw new RenderCancelled();
    const rasterStarted = performance.now();
    const fontsUsed = await readPdfFonts(pdf);
    const rendered = await renderPdfPages(pdf, work, pageCount, TASK_PROFILE, "Mixed", status, 0, pageCount, "TASK");
    const timingsMs = { layout: layoutMs, pdfinfo: pdfinfoMs, rasterAndPostprocess: elapsedMs(rasterStarted), workers: rendered.workers, total: elapsedMs(totalStarted) };
    const manifest: TaskManifest = { bytes: identity.bytes, chars: identity.chars, pageCount, pageDimensions: rendered.pageDimensions, profile: TASK_PROFILE, fontsUsed, timingsMs, workers: rendered.workers, cache: { schemaVersion: TASK_SCHEMA_VERSION, key: identity.key, hit: false } };
    if (cacheEnabled()) await publishTaskCache(cacheDirectory, identity.key, manifest, rendered.images);
    return { images: rendered.images, manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export { TASK_PROFILE };
