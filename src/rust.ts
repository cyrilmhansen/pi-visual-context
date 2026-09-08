import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { getVisualProfile, type VisualProfile } from "./profile.ts";
import { collectGitProvenance, type GitProvenance } from "./git.ts";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type RenderManifest = {
  sourceBytes: number;
  sourceChars: number;
  encodedChars: number;
  removedChars: number;
  reductionPercent: number;
  pageCount: number;
  profile: VisualProfile;
  language: "Rust" | "C" | "Python" | "Mixed";
  pageDimensions: { width: number; height: number }[];
  finalPage: {
    originalDimensions: { width: number; height: number };
    croppedDimensions: { width: number; height: number };
    columnsUsed: number;
    croppedRightPixels: number;
    croppedBottomPixels: number;
  };
  timingsMs?: Record<string, number>;
  workers?: number;
  requestedProfile?: VisualProfile["name"];
  renderGroups?: {
    profile: VisualProfile["name"];
    reason: string;
    sources: string[];
    pageCount: number;
    pageDimensions: { width: number; height: number }[];
    workers: number;
  }[];
  git?: GitProvenance;
  gitRepository?: number | null;
  cache?: { schemaVersion: number; key: string; hit: boolean };
};

export function parseVisualInput(text: string): { source: string; sources: string[]; question: string; profile: string; render: boolean; open: boolean } {
  if (!text.startsWith("@v ")) throw new Error("not a visual-context input");
  const rest = text.slice(3);
  const separator = rest.indexOf(" -- ");
  const sourceText = separator < 0 ? rest.trim() : rest.slice(0, separator).trim();
  const sourceArgs = sourceText.split(/\s+/).filter(Boolean);
  const question = separator < 0 ? "" : rest.slice(separator + 4).trim();
  let profile = "normal";
  let render = false;
  let open = false;
  const sources: string[] = [];
  for (let index = 0; index < sourceArgs.length; index++) {
    const argument = sourceArgs[index];
    if (argument === "--render") render = true;
    else if (argument === "--open") open = true;
    else if (argument === "--profile") {
      const value = sourceArgs[++index];
      if (!value) throw new Error("malformed @v profile syntax; use: --profile <name>");
      profile = value;
    } else sources.push(argument);
  }
  if (open) render = true;
  if (!sources.length || (!question && !render)) throw new Error("malformed @v syntax; source paths and question are required");
  for (const source of sources) {
    if (!/[*?\[]/.test(source) && !/\.(rs|c|h|cc|cpp|cxx|hpp|py)$/.test(source)) throw new Error(`unsupported source extension for "${source}"; supported extensions are .rs, .c, .h, and .py`);
  }
  return { source: sources[0], sources, question, profile, render, open };
}

async function trimGeometry(path: string, crop: string) {
  const { stdout: mean } = await run("magick", [path, "-crop", crop, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"]);
  const { stdout: geometry } = await run("magick", [path, "-crop", crop, "-trim", "-format", "%@", "info:"]);
  return { nonWhite: Number(mean.trim()) < 1, geometry: geometry.trim() };
}

const HEADER_HEIGHT = 20;
const PARTIAL_BOTTOM_PADDING = 8;

export async function cropFinalPage(path: string, profile: VisualProfile) {
  const columnWidth = (1056 - 2 * profile.sideMargin - (profile.columns - 1) * profile.gutter) / profile.columns;
  const columns = await Promise.all(Array.from({ length: profile.columns }, (_, index) => trimGeometry(path, `${columnWidth}x960+${profile.sideMargin + index * (columnWidth + profile.gutter)}+${HEADER_HEIGHT}`)));
  const columnsUsed = columns[2].nonWhite ? 3 : columns[1].nonWhite ? 2 : 1;
  const width = 2 * profile.sideMargin + columnsUsed * columnWidth + (columnsUsed - 1) * profile.gutter;
  let height = HEADER_HEIGHT + 960;
  if (columnsUsed === 1 && columns[0].nonWhite) {
    const match = columns[0].geometry.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    if (match) height = Math.min(HEADER_HEIGHT + 960, HEADER_HEIGHT + Number(match[4]) + Number(match[2]) + PARTIAL_BOTTOM_PADDING);
  }
  const cropped = `${path}.cropped.png`;
  if (width !== 1056 || height !== HEADER_HEIGHT + 960) {
    await run("magick", [path, "-crop", `${width}x${height}+0+0`, "+repage", cropped]);
    await rm(path);
    await run("mv", [cropped, path]);
  }
  return { width, height, columnsUsed, croppedRightPixels: 1056 - width, croppedBottomPixels: HEADER_HEIGHT + 960 - height };
}

async function compactC(sourcePath: string, outDir: string, status: (text: string) => void): Promise<Compacted> {
  const source = await readFile(sourcePath, "utf8");
  const output = resolve(outDir, "source.txt");
  status(`compacting ${source.length} -> ... chars`);
  const binary = resolve(root, "tools/c-strip-lex/target/release/c-strip-lex");
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  try { await access(binary); } catch { throw new Error(`C helper is unavailable at ${binary}; run: npm run build:c`); }
  const { stdout } = await run(binary, [sourcePath, output, font], { cwd: root });
  const match = stdout.match(/encoded visible chars=(\d+)/);
  if (!match) throw new Error("C strip-lex did not report its encoded character count");
  const encodedChars = Number(match[1]);
  const removedChars = source.length - encodedChars;
  const reductionPercent = source.length ? (removedChars / source.length) * 100 : 0;
  status(`compacting ${source.length} -> ${encodedChars} chars (-${reductionPercent.toFixed(1)}%)`);
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent };
}

async function addHeader(path: string, page: number, total: number, profile: VisualProfile, language: "Rust" | "C" | "Python" | "Mixed") {
  const text = `${language} | visual-context | ${page}/${total} | ${profile.name}`;
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  const output = `${path}.header.png`;
  await run("magick", [path, "-gravity", "NorthWest", "-background", "white", "-splice", `0x${HEADER_HEIGHT}`, "-font", font, "-fill", "black", "-pointsize", "10", "-annotate", "+12+4", text, output]);
  await rm(path);
  await run("mv", [output, path]);
}

type Compacted = { output: string; sourceBytes: number; sourceChars: number; encodedChars: number; removedChars: number; reductionPercent: number };

async function compactPython(sourcePath: string, outDir: string, status: (text: string) => void): Promise<Compacted> {
  const source = await readFile(sourcePath, "utf8");
  const output = resolve(outDir, "source.txt");
  status(`compacting ${source.length} -> ... chars`);
  const binary = resolve(root, "tools/python-strip-lex/target/release/python-strip-lex");
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  try { await access(binary); } catch { throw new Error(`Python helper is unavailable at ${binary}; run: cargo build --release --manifest-path tools/python-strip-lex/Cargo.toml`); }
  const { stdout } = await run(binary, [sourcePath, output, font], { cwd: root });
  const match = stdout.match(/encoded visible chars=(\d+)/);
  if (!match) throw new Error("Python strip-lex did not report its encoded character count");
  const encodedChars = Number(match[1]);
  const removedChars = source.length - encodedChars;
  const reductionPercent = source.length ? (removedChars / source.length) * 100 : 0;
  status(`compacting ${source.length} -> ${encodedChars} chars (-${reductionPercent.toFixed(1)}%)`);
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent };
}

async function compactRust(sourcePath: string, outDir: string, status: (text: string) => void): Promise<Compacted> {
  const source = await readFile(sourcePath, "utf8");
  const output = resolve(outDir, "source.txt");
  status(`compacting ${source.length} -> ... chars`);
  const tool = resolve(root, "tools/rust-strip-lex");
  const binary = resolve(tool, "target/release/rust-strip-lex");
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  try {
    await access(binary);
  } catch {
    throw new Error(`Rust helper is unavailable at ${binary}; run: npm run build:rust`);
  }
  const { stdout } = await run(binary, [sourcePath, output, font], { cwd: root });
  const match = stdout.match(/encoded visible chars=(\d+)/);
  if (!match) throw new Error("strip-lex did not report its encoded character count");
  const encodedChars = Number(match[1]);
  const removedChars = source.length - encodedChars;
  const reductionPercent = source.length ? (removedChars / source.length) * 100 : 0;
  status(`compacting ${source.length} -> ${encodedChars} chars (-${reductionPercent.toFixed(1)}%)`);
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent };
}

export const FILE_BANNER_PREFIX = "__PI_VISUAL_CONTEXT_FILE__:";
export function formatFileBanner(displayPath: string): string { return `${FILE_BANNER_PREFIX}${displayPath}`; }
export type RenderInput = { path: string; displayPath: string; language: "Rust" | "C" | "Python" };
export class RenderCancelled extends Error { constructor() { super("render cancelled"); } }
export type RenderOptions = {
  beforeRasterize?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  onCacheHit?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  cacheDirectory?: string;
  readMs?: number;
  git?: GitProvenance;
  gitRepositoryIds?: (number | null)[];
};

export function rasterWorkerCount(pageCount: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
  const requested = raw === undefined || raw.trim() === "" ? 4 : Number(raw);
  if (!Number.isInteger(requested) || requested < 1) throw new Error("PI_VISUAL_CONTEXT_RASTER_WORKERS must be an integer >= 1");
  return Math.min(requested, availableParallelism(), pageCount);
}

export async function mapPages<T>(pageCount: number, workers: number, worker: (page: number) => Promise<T>, onComplete: (completed: number, page: number) => void = () => {}): Promise<T[]> {
  if (!Number.isInteger(workers) || workers < 1) throw new Error("page worker count must be an integer >= 1");
  const results: T[] = new Array(pageCount);
  let nextPage = 0;
  let completed = 0;
  let failed = false;
  const runWorker = async () => {
    while (!failed) {
      const page = nextPage++;
      if (page >= pageCount) return;
      try {
        results[page] = await worker(page);
        completed++;
        onComplete(completed, page);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, pageCount) }, runWorker));
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

const NON_RENDERED_CODEPOINTS = new Set([0x09, 0x0a, 0x0d, 0x200b]);
export type GlyphClassification = { fallbackRequired: boolean; missingCodepoints: number[] };

export function classifyRenderedText(compacted: string, displayPath: string, romulusCodepoints: Set<number>): GlyphClassification {
  const missing = new Set<number>();
  for (const character of `${formatFileBanner(displayPath)}\n${compacted}`) {
    const codepoint = character.codePointAt(0)!;
    if (!NON_RENDERED_CODEPOINTS.has(codepoint) && !romulusCodepoints.has(codepoint)) missing.add(codepoint);
  }
  return { fallbackRequired: missing.size > 0, missingCodepoints: [...missing].sort((a, b) => a - b) };
}

function parseFontCharset(charset: string): Set<number> {
  const result = new Set<number>();
  for (const range of charset.trim().split(/\s+/).filter(Boolean)) {
    const [startText, endText = startText] = range.split("-");
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    if (Number.isFinite(start) && Number.isFinite(end)) for (let codepoint = start; codepoint <= end; codepoint++) result.add(codepoint);
  }
  return result;
}

async function loadRomulusCodepoints(): Promise<Set<number>> {
  const { stdout } = await run("fc-query", ["--format=%{charset}", resolve(root, "assets/fonts/romulus/Romulus.ttf")]);
  return parseFontCharset(stdout);
}

const CACHE_SCHEMA_VERSION = 1;
const PIPELINE_VERSION = "0.3.0-unicode-groups-1";
const cacheEnabled = () => !["0", "false", "no", "off"].includes((process.env.PI_VISUAL_CONTEXT_CACHE ?? "1").toLowerCase());
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const elapsedMs = (started: number) => Math.round((performance.now() - started) * 100) / 100;

type CacheRecord = {
  cache: { schemaVersion: number; key: string };
  manifest: RenderManifest;
  sourceManifests: { path: string; manifest: RenderManifest }[];
  pages: { file: string; sha256: string }[];
};

async function cacheKey(inputs: RenderInput[], profile: VisualProfile): Promise<{ key: string; sourceBytes: number; sourceChars: number }> {
  const sources = [];
  let sourceBytes = 0;
  let sourceChars = 0;
  for (const input of inputs) {
    const bytes = await readFile(input.path);
    sourceBytes += bytes.length;
    sourceChars += bytes.toString("utf8").length;
    sources.push({ displayPath: input.displayPath, language: input.language, bytesSha256: sha256(bytes) });
  }
  const template = await readFile(resolve(root, "typst/source.typ"));
  const font = await readFile(resolve(root, "assets/fonts/romulus/Romulus.ttf"));
  const identity = { cacheSchemaVersion: CACHE_SCHEMA_VERSION, pipelineVersion: PIPELINE_VERSION, sources, profile, renderer: { typstTemplateSha256: sha256(template), fontSha256: sha256(font), rasterDpi: 1152, outputSize: "1056x960", headerHeight: HEADER_HEIGHT } };
  return { key: sha256(JSON.stringify(identity)), sourceBytes, sourceChars };
}

async function loadCache(directory: string, key: string): Promise<{ images: Buffer[]; manifest: RenderManifest; sourceManifests: { path: string; manifest: RenderManifest }[] } | undefined> {
  const entry = resolve(directory, key);
  const invalid = async () => { await rm(entry, { recursive: true, force: true }); return undefined; };
  try {
    const record = JSON.parse(await readFile(resolve(entry, "cache-manifest.json"), "utf8")) as CacheRecord;
    if (record.cache?.schemaVersion !== CACHE_SCHEMA_VERSION || record.cache.key !== key || !Array.isArray(record.pages) || !record.manifest || !record.sourceManifests) return invalid();
    const images: Buffer[] = [];
    for (const page of record.pages) {
      if (typeof page.file !== "string" || !/^page-\d{3}\.png$/.test(page.file) || typeof page.sha256 !== "string") return invalid();
      const image = await readFile(resolve(entry, page.file));
      if (sha256(image) !== page.sha256) return invalid();
      images.push(image);
    }
    if (images.length !== record.manifest.pageCount) return invalid();
    return { images, manifest: record.manifest, sourceManifests: record.sourceManifests };
  } catch {
    return invalid();
  }
}

async function publishCache(directory: string, key: string, manifest: RenderManifest, sourceManifests: { path: string; manifest: RenderManifest }[], images: Buffer[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(resolve(directory, `.tmp-${key.slice(0, 12)}-`));
  try {
    const pages = [];
    for (let index = 0; index < images.length; index++) {
      const file = `page-${String(index + 1).padStart(3, "0")}.png`;
      await writeFile(resolve(temporary, file), images[index]);
      pages.push({ file, sha256: sha256(images[index]) });
    }
    const cachedSources = sourceManifests.map((item) => ({ ...item, path: "" }));
    await writeFile(resolve(temporary, "cache-manifest.json"), `${JSON.stringify({ cache: { schemaVersion: CACHE_SCHEMA_VERSION, key }, manifest, sourceManifests: cachedSources, pages }, null, 2)}\n`);
    try { await rename(temporary, resolve(directory, key)); } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function compactFile(input: RenderInput, outDir: string, status: (text: string) => void): Promise<Compacted> {
  if (input.language === "Rust") return compactRust(input.path, outDir, status);
  if (input.language === "C") return compactC(input.path, outDir, status);
  return compactPython(input.path, outDir, status);
}

export async function renderSources(inputs: RenderInput[], status: (text: string) => void, profile: VisualProfile, options: RenderOptions = {}): Promise<{ images: Buffer[]; manifest: RenderManifest; sourceManifests: { path: string; manifest: RenderManifest }[] }> {
  const totalStarted = performance.now();
  const readStarted = performance.now();
  const gitState = options.git ? { provenance: options.git, repositoryIds: options.gitRepositoryIds ?? inputs.map(() => null) } : await collectGitProvenance(inputs.map((input) => input.path));
  const identity = await cacheKey(inputs, profile);
  const timings: Record<string, number> = { read: Math.round(((options.readMs ?? 0) + elapsedMs(readStarted)) * 100) / 100 };
  const cacheDirectory = options.cacheDirectory ?? resolve(root, ".pi", "visual-context", "cache");
  const key = identity.key;
  if (cacheEnabled()) {
    const lookupStarted = performance.now();
    const cached = await loadCache(cacheDirectory, key);
    timings.cacheLookup = elapsedMs(lookupStarted);
    if (cached) {
      if (options.onCacheHit && !await options.onCacheHit(cached.manifest.pageCount, identity.sourceChars)) throw new RenderCancelled();
      timings.total = elapsedMs(totalStarted);
      timings.workers = 0;
      cached.manifest.timingsMs = timings;
      cached.manifest.workers = 0;
      cached.manifest.cache = { schemaVersion: CACHE_SCHEMA_VERSION, key, hit: true };
      cached.manifest.git = gitState.provenance;
      cached.sourceManifests = cached.sourceManifests.map((item, index) => ({ ...item, path: inputs[index]?.path ?? item.path, manifest: { ...item.manifest, gitRepository: gitState.repositoryIds[index] ?? null } }));
      status(`cache hit · ${cached.images.length} tablets`);
      return cached;
    }
  }
  const work = await mkdtemp(resolve(root, ".pi-visual-context-"));
  try {
    const compactStarted = performance.now();
    const compacted: { input: RenderInput; value: Compacted }[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const fileWork = resolve(work, `source-${index}`);
      await mkdir(fileWork, { recursive: true });
      status(`compacting ${index + 1}/${inputs.length} · ${basename(input.path)}`);
      const value = await compactFile(input, fileWork, () => {});
      status(`compacting ${index + 1}/${inputs.length} · ${basename(input.path)} · ${value.encodedChars} chars`);
      compacted.push({ input, value });
    }
    const romulus = await loadRomulusCodepoints();
    const classified = await Promise.all(compacted.map(async (item) => ({ ...item, classification: classifyRenderedText(await readFile(item.value.output, "utf8"), item.input.displayPath, romulus) })));
    const normalItems = profile.name === "conservative" ? [] : classified.filter((item) => !item.classification.fallbackRequired);
    const fallbackItems = profile.name === "conservative" ? classified : classified.filter((item) => item.classification.fallbackRequired);
    const groups = [
      ...(normalItems.length ? [{ profile: getVisualProfile("normal"), reason: "romulus-compatible", items: normalItems }] : []),
      ...(fallbackItems.length ? [{ profile: getVisualProfile("conservative"), reason: profile.name === "conservative" ? "explicit-profile" : "font-fallback", items: fallbackItems }] : []),
    ];
    if (!groups.length) throw new Error("no source files to render");
    const sourceBytes = compacted.reduce((sum, item) => sum + item.value.sourceBytes, 0);
    const sourceChars = compacted.reduce((sum, item) => sum + item.value.sourceChars, 0);
    const encodedChars = compacted.reduce((sum, item) => sum + item.value.encodedChars, 0);
    const removedChars = compacted.reduce((sum, item) => sum + item.value.removedChars, 0);
    const reductionPercent = sourceChars ? removedChars / sourceChars * 100 : 0;
    timings.compact = elapsedMs(compactStarted);
    const languages = [...new Set(inputs.map((input) => input.language))];
    const language = languages.length === 1 ? languages[0] : "Mixed";
    const fontDir = resolve(root, "assets/fonts/romulus");
    const prepared = [] as { group: typeof groups[number]; work: string; pdf: string; pageCount: number; language: "Rust" | "C" | "Python" | "Mixed" }[];
    let typstMs = 0;
    let pdfinfoMs = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const groupWork = resolve(work, `group-${groupIndex}`);
      await mkdir(groupWork, { recursive: true });
      const combinedOutput = resolve(groupWork, "source.txt");
      const chunks: Buffer[] = [];
      for (const item of group.items) {
        chunks.push(Buffer.from(`${formatFileBanner(item.input.displayPath)}\n`));
        chunks.push(await readFile(item.value.output));
        chunks.push(Buffer.from("\n"));
      }
      await writeFile(combinedOutput, Buffer.concat(chunks));
      const pdf = resolve(groupWork, "source.pdf");
      status(`laying out ${group.items.length} files · ${group.profile.name}`);
      const typstStarted = performance.now();
      await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${combinedOutput.slice(root.length + 1)}`, "--input", `font=${group.profile.font}`, "--input", `cols=${group.profile.columns}`, "--input", `scale=${group.profile.scale}`, "--input", `size=${group.profile.fontSize}`, "--input", `leading=${group.profile.leading}`, "--input", `margin=${group.profile.sideMargin}`, "--input", `gutter=${group.profile.gutter}`, resolve(root, "typst/source.typ"), pdf]);
      typstMs += elapsedMs(typstStarted);
      const pdfInfoStarted = performance.now();
      const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
      pdfinfoMs += elapsedMs(pdfInfoStarted);
      const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      if (!pageCount) throw new Error(`renderer produced no PDF pages for ${group.profile.name}`);
      prepared.push({ group, work: groupWork, pdf, pageCount, language: group.items.length === 1 ? group.items[0].input.language : language });
    }
    timings.typst = typstMs;
    timings.pdfinfo = pdfinfoMs;
    const totalPageCount = prepared.reduce((sum, group) => sum + group.pageCount, 0);
    status(`PDF ready: ${totalPageCount} tablets`);
    if (options.beforeRasterize && !await options.beforeRasterize(totalPageCount, sourceChars)) throw new RenderCancelled();
    const configuredWorkers = rasterWorkerCount(totalPageCount);
    const rasterStarted = performance.now();
    let completed = 0;
    const renderedGroups: { images: Buffer[]; pageDimensions: { width: number; height: number }[]; finalPage: { width: number; height: number; columnsUsed: number; croppedRightPixels: number; croppedBottomPixels: number }; workers: number }[] = [];
    for (const preparedGroup of prepared) {
      const groupWorkers = Math.min(configuredWorkers, preparedGroup.pageCount);
      const pageResults = await mapPages(preparedGroup.pageCount, groupWorkers, async (pageIndex) => {
        const pageWork = resolve(preparedGroup.work, `page-${String(pageIndex + 1).padStart(3, "0")}`);
        await mkdir(pageWork, { recursive: true });
        const rasterPrefix = resolve(pageWork, "raster");
        await run("pdftocairo", ["-png", "-r", "1152", "-f", String(pageIndex + 1), "-l", String(pageIndex + 1), preparedGroup.pdf, rasterPrefix]);
        const rasterPages = (await readdir(pageWork)).filter((name) => name.endsWith(".png"));
        if (rasterPages.length !== 1) throw new Error(`renderer produced ${rasterPages.length} raster pages for page ${pageIndex + 1}`);
        const input = resolve(pageWork, rasterPages[0]);
        const output = resolve(pageWork, "final.png");
        await run("magick", [input, "-filter", "Box", "-resize", "6.25%", output]);
        await rm(input);
        const { stdout: size } = await run("identify", ["-format", "%wx%h", output]);
        if (size.trim() !== "1056x960") throw new Error(`renderer produced ${size.trim()}, expected 1056x960`);
        await addHeader(output, pageIndex + 1, preparedGroup.pageCount, preparedGroup.group.profile, preparedGroup.language);
        let finalPage = { width: 1056, height: HEADER_HEIGHT + 960, columnsUsed: 3, croppedRightPixels: 0, croppedBottomPixels: 0 };
        if (pageIndex === preparedGroup.pageCount - 1) finalPage = await cropFinalPage(output, preparedGroup.group.profile);
        const normalized = `${output}.normalized.png`;
        await run("magick", [output, "-strip", "-define", "png:exclude-chunk=tIME", normalized]);
        await rm(output);
        await rename(normalized, output);
        return { image: await readFile(output), dimensions: { width: finalPage.width, height: finalPage.height }, finalPage };
      }, () => { completed++; status(`rasterizing ${completed}/${totalPageCount}`); });
      renderedGroups.push({ images: pageResults.map((page) => page.image), pageDimensions: pageResults.map((page) => page.dimensions), finalPage: pageResults[pageResults.length - 1].finalPage, workers: groupWorkers });
    }
    timings.rasterAndPostprocess = elapsedMs(rasterStarted);
    timings.workers = configuredWorkers;
    timings.total = elapsedMs(totalStarted);
    const images = renderedGroups.flatMap((group) => group.images);
    const pageDimensions = renderedGroups.flatMap((group) => group.pageDimensions);
    const lastPage = renderedGroups.at(-1)!.finalPage;
    const renderGroups = prepared.map((group, index) => ({ profile: group.group.profile.name, reason: group.group.reason, sources: group.group.items.map((item) => item.input.displayPath), pageCount: group.pageCount, pageDimensions: renderedGroups[index].pageDimensions, workers: renderedGroups[index].workers }));
    const manifest: RenderManifest = { sourceBytes, sourceChars, encodedChars, removedChars, reductionPercent, profile, requestedProfile: profile.name, renderGroups, language, git: gitState.provenance, pageCount: images.length, pageDimensions, finalPage: { originalDimensions: { width: 1056, height: HEADER_HEIGHT + 960 }, croppedDimensions: { width: lastPage.width, height: lastPage.height }, columnsUsed: lastPage.columnsUsed, croppedRightPixels: lastPage.croppedRightPixels, croppedBottomPixels: lastPage.croppedBottomPixels }, timingsMs: timings, workers: configuredWorkers, cache: { schemaVersion: CACHE_SCHEMA_VERSION, key, hit: false } };
    const sourceManifests = compacted.map((item, index) => ({ path: item.input.path, manifest: { ...item.value, profile: (profile.name === "conservative" || classified.find((source) => source.input.path === item.input.path)?.classification.fallbackRequired) ? getVisualProfile("conservative") : getVisualProfile("normal"), language: item.input.language, gitRepository: gitState.repositoryIds[index] ?? null, pageCount: 0, pageDimensions: [], finalPage: manifest.finalPage } }));
    if (cacheEnabled()) await publishCache(cacheDirectory, key, manifest, sourceManifests, images);
    return { images, manifest, sourceManifests };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function renderRust(sourcePath: string, status: (text: string) => void, profile: VisualProfile) {
  return renderSources([{ path: sourcePath, displayPath: basename(sourcePath), language: "Rust" }], status, profile);
}
export function renderC(sourcePath: string, status: (text: string) => void, profile: VisualProfile) {
  return renderSources([{ path: sourcePath, displayPath: basename(sourcePath), language: "C" }], status, profile);
}
export function renderPython(sourcePath: string, status: (text: string) => void, profile: VisualProfile) {
  return renderSources([{ path: sourcePath, displayPath: basename(sourcePath), language: "Python" }], status, profile);
}
