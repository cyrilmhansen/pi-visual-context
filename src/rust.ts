import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { getVisualProfile, type VisualProfile } from "./profile.ts";
import { collectGitProvenance, type GitProvenance } from "./git.ts";
import { extractAllSymbols, mapSymbolsToTablets, SYMBOL_INDEX_VERSION, type SymbolAnchor, type SymbolDiagnostic, type SymbolInput } from "./symbols.ts";
import { loadProjectContext, reserveTabletIds } from "./project.ts";

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
  language: "Rust" | "C" | "Python" | "Text" | "Mixed";
  codec?: "rust" | "c" | "python" | "text";
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
    fontsUsed?: string[];
  }[];
  tablets?: GroupTablet[];
  fontsUsed?: string[];
  git?: GitProvenance;
  gitRepository?: number | null;
  cache?: { schemaVersion: number; key: string; hit: boolean };
  symbols?: SymbolAnchor[];
  symbolDiagnostics?: SymbolDiagnostic[];
  symbolExtractorVersion?: string;
};

export function parseVisualInput(text: string): { source: string; sources: string[]; question: string; profile: string; render: boolean; open: boolean; visualPrompt: boolean; tablet?: string; symbol?: string } {
  if (!text.startsWith("@v ")) throw new Error("not a visual-context input");
  const rest = text.slice(3);
  const spacedSeparator = rest.indexOf(" -- ");
  const endSeparator = spacedSeparator < 0 && /\s--$/.test(rest.trim()) ? rest.lastIndexOf(" --") : -1;
  const separator = spacedSeparator >= 0 ? spacedSeparator : endSeparator;
  const separatorLength = spacedSeparator >= 0 ? 4 : 3;
  const sourceText = separator < 0 ? rest.trim() : rest.slice(0, separator).trim();
  const sourceArgs = sourceText.split(/\s+/).filter(Boolean);
  const question = separator < 0 ? "" : rest.slice(separator + separatorLength).trim();
  let profile = "normal";
  let render = false;
  let open = false;
  let visualPrompt = false;
  let tablet: string | undefined;
  let symbol: string | undefined;
  let profileSpecified = false;
  const sources: string[] = [];
  for (let index = 0; index < sourceArgs.length; index++) {
    const argument = sourceArgs[index];
    if (argument === "--render") render = true;
    else if (argument === "--open") open = true;
    else if (argument === "--visual-prompt") visualPrompt = true;
    else if (argument === "--profile") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v profile syntax; use: --profile <name>");
      profile = value;
      profileSpecified = true;
    } else if (argument === "--tablet") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v tablet syntax; use: --tablet <id>");
      tablet = value;
    } else if (argument === "--symbol") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v symbol syntax; use: --symbol <name>");
      symbol = value;
    } else sources.push(argument);
  }
  if (open) render = true;
  if (tablet && symbol) throw new Error("--tablet and --symbol cannot be used together");
  if (tablet || symbol) {
    if (sources.length) throw new Error("navigation targets cannot be combined with source paths");
    if (visualPrompt) throw new Error("navigation cannot be combined with --visual-prompt");
    if (render || open) throw new Error("navigation cannot be combined with --render or --open");
    if (profileSpecified) throw new Error("navigation cannot be combined with --profile");
    if (!question) throw new Error("navigation requires a non-empty question");
  }
  if (!sources.length && (!visualPrompt || !question) && !tablet && !symbol) throw new Error(visualPrompt ? "visual prompt without sources requires a non-empty prompt" : "malformed @v syntax; source paths and question are required");
  if (!question && !render && !tablet && !symbol) throw new Error("malformed @v syntax; source paths and question are required");
  return { source: sources[0], sources, question, profile, render, open, visualPrompt, ...(tablet ? { tablet } : {}), ...(symbol ? { symbol } : {}) };
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
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent, codec: "c" };
}

async function addHeader(path: string, page: number, total: number, profile: VisualProfile, language: "Rust" | "C" | "Python" | "Text" | "Mixed", headerPrefix?: string | ((page: number, total: number, globalPage: number) => string), globalPage = page) {
  const text = typeof headerPrefix === "function" ? headerPrefix(page, total, globalPage) : headerPrefix ? `${headerPrefix} | ${page}/${total}` : `${language} | visual-context | ${page}/${total} | ${profile.name}`;
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  const output = `${path}.header.png`;
  await run("magick", [path, "-gravity", "NorthWest", "-background", "white", "-splice", `0x${HEADER_HEIGHT}`, "-font", font, "-fill", "black", "-pointsize", "10", "-annotate", "+12+4", text, output]);
  await rm(path);
  await run("mv", [output, path]);
}

type Compacted = { output: string; sourceBytes: number; sourceChars: number; encodedChars: number; removedChars: number; reductionPercent: number; codec: "rust" | "c" | "python" | "text" };

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
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent, codec: "python" };
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
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent, codec: "rust" };
}

async function compactText(sourcePath: string, outDir: string, status: (text: string) => void): Promise<Compacted> {
  const bytes = await readFile(sourcePath);
  if (bytes.includes(0)) throw new Error(`source is not supported as text/binary input: ${sourcePath}`);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`generic text fallback requires UTF-8: ${sourcePath}`); }
  const normalized = source.replace(/\r\n?/g, "\n").replaceAll("\t", "    ");
  const output = resolve(outDir, "source.txt");
  await writeFile(output, normalized, "utf8");
  const sourceChars = source.length;
  const encodedChars = normalized.length;
  const removedChars = sourceChars - encodedChars;
  const reductionPercent = sourceChars ? removedChars / sourceChars * 100 : 0;
  status(`reading text ${sourceChars} -> ${encodedChars} chars`);
  return { output, sourceBytes: bytes.length, sourceChars, encodedChars, removedChars, reductionPercent, codec: "text" };
}

export const FILE_BANNER_PREFIX = "__PI_VISUAL_CONTEXT_FILE__:";
export function formatFileBanner(displayPath: string): string { return `${FILE_BANNER_PREFIX}${displayPath}`; }
export type RenderInput = { path: string; displayPath: string; language: "Rust" | "C" | "Python" | "Text" };
export class RenderCancelled extends Error { constructor() { super("render cancelled"); } }
export type RenderOptions = {
  beforeRasterize?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  onCacheHit?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  cacheDirectory?: string;
  projectRoot?: string;
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

const CACHE_SCHEMA_VERSION = 4;
const PIPELINE_VERSION = "0.4.0-persistent-vc-1";
const cacheEnabled = () => !["0", "false", "no", "off"].includes((process.env.PI_VISUAL_CONTEXT_CACHE ?? "1").toLowerCase());
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const elapsedMs = (started: number) => Math.round((performance.now() - started) * 100) / 100;

type CacheRecord = {
  cache: { schemaVersion: number; key: string; projectPrefix?: string };
  manifest: RenderManifest;
  sourceManifests: { path: string; manifest: RenderManifest }[];
  pages: { file: string; sha256: string }[];
};

async function cacheKey(inputs: RenderInput[], profile: VisualProfile, prefix: string): Promise<{ key: string; sourceBytes: number; sourceChars: number }> {
  const sources = [];
  let sourceBytes = 0;
  let sourceChars = 0;
  for (const input of inputs) {
    const bytes = await readFile(input.path);
    sourceBytes += bytes.length;
    sourceChars += bytes.toString("utf8").length;
    sources.push({ displayPath: input.displayPath, language: input.language, codec: input.language === "Text" ? "text" : input.language.toLowerCase(), bytesSha256: sha256(bytes) });
  }
  const template = await readFile(resolve(root, "typst/source.typ"));
  const font = await readFile(resolve(root, "assets/fonts/romulus/Romulus.ttf"));
  const identity = { cacheSchemaVersion: CACHE_SCHEMA_VERSION, pipelineVersion: PIPELINE_VERSION, projectPrefix: prefix, sources, profile, renderer: { typstTemplateSha256: sha256(template), fontSha256: sha256(font), rasterDpi: 1152, outputSize: "1056x960", headerHeight: HEADER_HEIGHT } };
  return { key: sha256(JSON.stringify(identity)), sourceBytes, sourceChars };
}

async function loadCache(directory: string, key: string, prefix: string): Promise<{ images: Buffer[]; manifest: RenderManifest; sourceManifests: { path: string; manifest: RenderManifest }[] } | undefined> {
  const entry = resolve(directory, key);
  const invalid = async () => { await rm(entry, { recursive: true, force: true }); return undefined; };
  try {
    const record = JSON.parse(await readFile(resolve(entry, "cache-manifest.json"), "utf8")) as CacheRecord;
    if (record.cache?.schemaVersion !== CACHE_SCHEMA_VERSION || record.cache.key !== key || record.cache.projectPrefix !== prefix || !Array.isArray(record.pages) || !record.manifest || !record.sourceManifests) return invalid();
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

async function publishCache(directory: string, key: string, prefix: string, manifest: RenderManifest, sourceManifests: { path: string; manifest: RenderManifest }[], images: Buffer[]): Promise<void> {
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
    await writeFile(resolve(temporary, "cache-manifest.json"), `${JSON.stringify({ cache: { schemaVersion: CACHE_SCHEMA_VERSION, key, projectPrefix: prefix }, manifest, sourceManifests: cachedSources, pages }, null, 2)}\n`);
    try { await rename(temporary, resolve(directory, key)); } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function readPdfFonts(pdf: string): Promise<string[]> {
  try {
    const { stdout } = await run("pdffonts", [pdf]);
    const names = stdout.split("\n").slice(2).map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && name !== "name").map((name) => name.replace(/^[A-Z]{6}\+/, ""));
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

async function compactFile(input: RenderInput, outDir: string, status: (text: string) => void): Promise<Compacted> {
  if (input.language === "Rust") return compactRust(input.path, outDir, status);
  if (input.language === "C") return compactC(input.path, outDir, status);
  if (input.language === "Python") return compactPython(input.path, outDir, status);
  return compactText(input.path, outDir, status);
}

export type ProvenanceSpan = { sourceIndex: number; sourcePath: string; visualName: string; startLine: number | null; endLine: number | null; bannerOnly?: boolean };
type ProvenanceMarker = { contentIndex: number; start: number; end: number; startMarker: string; endMarker: string; span: ProvenanceSpan };
export type GroupTablet = { id?: string; pageIndex: number; profile: VisualProfile["name"]; width: number; height: number; spans: ProvenanceSpan[] };

function sourceLineCount(source: string): number {
  if (source.length === 0) return 0;
  const normalized = source.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized.split("\n").length - 1 : normalized.split("\n").length;
}

function structuralSegments(content: string): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  let previousVisible = "";
  let byteOffset = 0;
  let segmentStartByte = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character);
    if (character !== "\u200b") {
      if (character === "¶" && previousVisible !== "¤") {
        segments.push({ start: segmentStartByte, end: byteOffset + characterBytes });
        segmentStartByte = byteOffset + characterBytes;
      }
      previousVisible = character;
    }
    byteOffset += characterBytes;
  }
  if (segmentStartByte < byteOffset) segments.push({ start: segmentStartByte, end: byteOffset });
  return segments;
}

async function buildProvenanceMapping(input: RenderInput, value: Compacted, sourceIndex: number, contentIndex: number, markerPrefix: string, markers: ProvenanceMarker[], mappingLines: string[], outputChunks: Buffer[]): Promise<number> {
  const source = await readFile(input.path, "utf8");
  const normalized = source.replace(/\r\n?/g, "\n");
  const lineCount = sourceLineCount(source);
  const banner = formatFileBanner(input.displayPath);
  const bannerStart = `${markerPrefix}-banner-start`;
  const bannerEnd = `${markerPrefix}-banner-end`;
  const bannerSpan: ProvenanceSpan = { sourceIndex, sourcePath: input.path, visualName: input.displayPath, startLine: null, endLine: null, bannerOnly: true };
  markers.push({ contentIndex, start: 0, end: Buffer.byteLength(banner), startMarker: bannerStart, endMarker: bannerEnd, span: bannerSpan });
  mappingLines.push(`${contentIndex}|0|${Buffer.byteLength(banner)}|${bannerStart}|${bannerEnd}`);
  outputChunks.push(Buffer.from(`${banner}\n`));
  let nextContentIndex = contentIndex + 1;
  const makeRecord = (start: number, end: number, startLine: number | null, endLine: number | null, suffix: string) => {
    const span: ProvenanceSpan = { sourceIndex, sourcePath: input.path, visualName: input.displayPath, startLine, endLine };
    const startMarker = `${markerPrefix}-${suffix}-start`;
    const endMarker = `${markerPrefix}-${suffix}-end`;
    markers.push({ contentIndex: nextContentIndex, start, end, startMarker, endMarker, span });
    return `${nextContentIndex}|${start}|${end}|${startMarker}|${endMarker}`;
  };
  if (value.codec === "text") {
    const lines = normalized.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (lineIndex < lineCount) mappingLines.push(makeRecord(0, Buffer.byteLength(lines[lineIndex]), lineIndex + 1, lineIndex + 1, `line-${lineIndex}`));
      nextContentIndex++;
    }
    outputChunks.push(Buffer.from(normalized, "utf8"), Buffer.from("\n"));
    return contentIndex + 1 + lines.length;
  }
  const content = await readFile(value.output, "utf8");
  const segments = structuralSegments(content);
  const lines = normalized.split("\n");
  let originalLine = 1;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    if (originalLine > lineCount) break;
    let endLine = originalLine;
    if (input.language === "Python") while (endLine < lineCount && /\\\s*$/.test(lines[endLine - 1])) endLine++;
    mappingLines.push(makeRecord(segments[segmentIndex].start, segments[segmentIndex].end, originalLine, endLine, `segment-${segmentIndex}`));
    originalLine = endLine + 1;
  }
  outputChunks.push(content ? Buffer.from(content) : await readFile(value.output), Buffer.from("\n"));
  return contentIndex + 2;
}

async function queryProvenance(typstFile: string, sourceFile: string, mappingFile: string, fontDir: string, profile: VisualProfile): Promise<Map<string, number>> {
  const args = ["query", typstFile, "metadata", "--root", root, "--font-path", fontDir, "--input", `source=../${sourceFile.slice(root.length + 1)}`, "--input", `mapping=../${mappingFile.slice(root.length + 1)}`,  "--input", `font=${profile.font}`, "--input", `cols=${profile.columns}`, "--input", `scale=${profile.scale}`, "--input", `size=${profile.fontSize}`, "--input", `leading=${profile.leading}`, "--input", `margin=${profile.sideMargin}`, "--input", `gutter=${profile.gutter}`];
  const { stdout } = await run("typst", args);
  const values = JSON.parse(stdout) as { value?: string }[];
  const pages = new Map<string, number>();
  for (const item of values) {
    const parts = item.value?.split("|") ?? [];
    if (parts.length === 2 && Number.isInteger(Number(parts[1]))) pages.set(parts[0], Number(parts[1]));
  }
  return pages;
}

function buildGroupTablets(markers: ProvenanceMarker[], pages: Map<string, number>, pageCount: number, profile: VisualProfile["name"], dimensions: { width: number; height: number }[]): GroupTablet[] {
  const tablets = Array.from({ length: pageCount }, (_, index) => ({ pageIndex: index + 1, profile, width: dimensions[index]?.width ?? 1056, height: dimensions[index]?.height ?? 980, spans: [] as ProvenanceSpan[] }));
  for (const marker of markers) {
    const startPage = pages.get(marker.startMarker);
    const endPage = pages.get(marker.endMarker);
    if (!startPage || !endPage) continue;
    for (let page = Math.max(1, startPage); page <= Math.min(pageCount, endPage); page++) {
      const tablet = tablets[page - 1];
      const previous = tablet.spans.at(-1);
      if (previous && previous.sourceIndex === marker.span.sourceIndex && previous.startLine !== null && marker.span.startLine !== null && previous.endLine !== null && marker.span.endLine !== null && marker.span.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, marker.span.endLine);
      } else if (!tablet.spans.some((span) => span.sourceIndex === marker.span.sourceIndex && span.bannerOnly === marker.span.bannerOnly)) {
        tablet.spans.push({ ...marker.span });
      }
    }
  }
  for (const tablet of tablets) {
    if (tablet.spans.some((span) => !span.bannerOnly)) tablet.spans = tablet.spans.filter((span) => !span.bannerOnly);
  }
  return tablets;
}

export type PdfRenderResult = {
  images: Buffer[];
  pageDimensions: { width: number; height: number }[];
  finalPage: { width: number; height: number; columnsUsed: number; croppedRightPixels: number; croppedBottomPixels: number };
  workers: number;
};

export async function renderPdfPages(
  pdf: string,
  work: string,
  pageCount: number,
  profile: VisualProfile,
  language: "Rust" | "C" | "Python" | "Text" | "Mixed",
  status: (text: string) => void,
  progressStart = 0,
  progressTotal = pageCount,
  headerPrefix?: string | ((page: number, total: number, globalPage: number) => string),
): Promise<PdfRenderResult> {
  const configuredWorkers = rasterWorkerCount(pageCount);
  let completed = progressStart;
  const groupWorkers = configuredWorkers;
  const pageResults = await mapPages(pageCount, groupWorkers, async (pageIndex) => {
    const pageWork = resolve(work, `page-${String(pageIndex + 1).padStart(3, "0")}`);
    await mkdir(pageWork, { recursive: true });
    const rasterPrefix = resolve(pageWork, "raster");
    await run("pdftocairo", ["-png", "-r", "1152", "-f", String(pageIndex + 1), "-l", String(pageIndex + 1), pdf, rasterPrefix]);
    const rasterPages = (await readdir(pageWork)).filter((name) => name.endsWith(".png"));
    if (rasterPages.length !== 1) throw new Error(`renderer produced ${rasterPages.length} raster pages for page ${pageIndex + 1}`);
    const input = resolve(pageWork, rasterPages[0]);
    const output = resolve(pageWork, "final.png");
    await run("magick", [input, "-filter", "Box", "-resize", "6.25%", output]);
    await rm(input);
    const { stdout: size } = await run("identify", ["-format", "%wx%h", output]);
    if (size.trim() !== "1056x960") throw new Error(`renderer produced ${size.trim()}, expected 1056x960`);
    await addHeader(output, pageIndex + 1, pageCount, profile, language, headerPrefix, progressStart + pageIndex + 1);
    let finalPage = { width: 1056, height: HEADER_HEIGHT + 960, columnsUsed: 3, croppedRightPixels: 0, croppedBottomPixels: 0 };
    if (pageIndex === pageCount - 1) finalPage = await cropFinalPage(output, profile);
    const normalized = `${output}.normalized.png`;
    await run("magick", [output, "-strip", "-define", "png:exclude-chunk=tIME", normalized]);
    await rm(output);
    await rename(normalized, output);
    return { image: await readFile(output), dimensions: { width: finalPage.width, height: finalPage.height }, finalPage };
  }, () => { completed++; status(`rasterizing ${completed}/${progressTotal}`); });
  return { images: pageResults.map((page) => page.image), pageDimensions: pageResults.map((page) => page.dimensions), finalPage: pageResults[pageResults.length - 1].finalPage, workers: groupWorkers };
}

async function extractAndMapSymbols(inputs: RenderInput[], tablets: GroupTablet[]): Promise<{ symbols: SymbolAnchor[]; diagnostics: SymbolDiagnostic[]; version: string }> {
  const extracted = await extractAllSymbols(inputs as SymbolInput[]);
  return { ...extracted, symbols: mapSymbolsToTablets(extracted.symbols, tablets) };
}

export async function renderSources(inputs: RenderInput[], status: (text: string) => void, profile: VisualProfile, options: RenderOptions = {}): Promise<{ images: Buffer[]; manifest: RenderManifest; sourceManifests: { path: string; manifest: RenderManifest }[] }> {
  const totalStarted = performance.now();
  const readStarted = performance.now();
  const gitState = options.git ? { provenance: options.git, repositoryIds: options.gitRepositoryIds ?? inputs.map(() => null) } : await collectGitProvenance(inputs.map((input) => input.path));
  const fallbackProjectRoot = options.projectRoot;
  const projectRoot = gitState.provenance.repositories.length === 1 ? gitState.provenance.repositories[0].root : fallbackProjectRoot;
  const cacheDirectory = options.cacheDirectory ?? resolve(projectRoot ?? root, ".pi", "visual-context", "cache");
  const projectContext = await loadProjectContext({ projectRoot, cacheDirectory });
  const identity = await cacheKey(inputs, profile, projectContext.state.prefix);
  const timings: Record<string, number> = { read: Math.round(((options.readMs ?? 0) + elapsedMs(readStarted)) * 100) / 100 };
  const key = identity.key;
  if (cacheEnabled()) {
    const lookupStarted = performance.now();
    const cached = await loadCache(cacheDirectory, key, projectContext.state.prefix);
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
      cached.manifest.tablets = cached.manifest.tablets?.map((tablet) => ({ ...tablet, spans: tablet.spans.map((span) => ({ ...span, sourcePath: inputs[span.sourceIndex]?.path ?? span.sourcePath, visualName: inputs[span.sourceIndex]?.displayPath ?? span.visualName })) }));
      if (cached.manifest.symbolExtractorVersion !== SYMBOL_INDEX_VERSION || !Array.isArray(cached.manifest.symbols)) {
        const symbolStarted = performance.now();
        const symbolData = await extractAndMapSymbols(inputs, cached.manifest.tablets ?? []);
        cached.manifest.symbols = symbolData.symbols;
        cached.manifest.symbolDiagnostics = symbolData.diagnostics;
        cached.manifest.symbolExtractorVersion = symbolData.version;
        timings.symbols = elapsedMs(symbolStarted);
      }
      timings.total = elapsedMs(totalStarted);
      cached.manifest.timingsMs = timings;
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
    const prepared = [] as { group: typeof groups[number]; work: string; pdf: string; pageCount: number; language: "Rust" | "C" | "Python" | "Text" | "Mixed"; fontsUsed: string[]; markers: ProvenanceMarker[]; provenancePages: Map<string, number> }[];
    let typstMs = 0;
    let pdfinfoMs = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const groupWork = resolve(work, `group-${groupIndex}`);
      await mkdir(groupWork, { recursive: true });
      const combinedOutput = resolve(groupWork, "source.txt");
      const mappingFile = resolve(groupWork, "mapping.txt");
      const chunks: Buffer[] = [];
      const mappingLines: string[] = [];
      const markers: ProvenanceMarker[] = [];
      let contentIndex = 0;
      for (const item of group.items) {
        const sourceIndex = inputs.indexOf(item.input);
        contentIndex = await buildProvenanceMapping(item.input, item.value, sourceIndex, contentIndex, `VCM-${groupIndex}-${sourceIndex}`, markers, mappingLines, chunks);
      }
      await writeFile(combinedOutput, Buffer.concat(chunks));
      await writeFile(mappingFile, `${mappingLines.join("\n")}\n`);
      const pdf = resolve(groupWork, "source.pdf");
      status(`laying out ${group.items.length} files · ${group.profile.name}`);
      const typstStarted = performance.now();
      await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${combinedOutput.slice(root.length + 1)}`, "--input", `mapping=../${mappingFile.slice(root.length + 1)}`, "--input", `font=${group.profile.font}`, "--input", `cols=${group.profile.columns}`, "--input", `scale=${group.profile.scale}`, "--input", `size=${group.profile.fontSize}`, "--input", `leading=${group.profile.leading}`, "--input", `margin=${group.profile.sideMargin}`, "--input", `gutter=${group.profile.gutter}`, resolve(root, "typst/source.typ"), pdf]);
      typstMs += elapsedMs(typstStarted);
      const pdfInfoStarted = performance.now();
      const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
      pdfinfoMs += elapsedMs(pdfInfoStarted);
      const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      if (!pageCount) throw new Error(`renderer produced no PDF pages for ${group.profile.name}`);
      const fontsUsed = await readPdfFonts(pdf);
      const provenanceStarted = performance.now();
      const provenancePages = await queryProvenance(resolve(root, "typst/source.typ"), combinedOutput, mappingFile, fontDir, group.profile);
      const provenanceMs = elapsedMs(provenanceStarted);
      timings.provenance = (timings.provenance ?? 0) + provenanceMs;
      prepared.push({ group, work: groupWork, pdf, pageCount, language: group.items.length === 1 ? group.items[0].input.language : language, fontsUsed, markers, provenancePages });
    }
    timings.typst = typstMs;
    timings.pdfinfo = pdfinfoMs;
    const totalPageCount = prepared.reduce((sum, group) => sum + group.pageCount, 0);
    status(`PDF ready: ${totalPageCount} tablets`);
    if (options.beforeRasterize && !await options.beforeRasterize(totalPageCount, sourceChars)) throw new RenderCancelled();
    const reservation = await reserveTabletIds(projectContext, totalPageCount);
    const assignedTabletIds = reservation.ids;
    const configuredWorkers = rasterWorkerCount(totalPageCount);
    const rasterStarted = performance.now();
    const renderedGroups: PdfRenderResult[] = [];
    let completed = 0;
    for (const preparedGroup of prepared) {
      const groupStart = completed;
      const result = await renderPdfPages(preparedGroup.pdf, preparedGroup.work, preparedGroup.pageCount, preparedGroup.group.profile, preparedGroup.language, status, groupStart, totalPageCount, (_page, _groupTotal, globalPage) => `${assignedTabletIds[globalPage - 1]} | ${preparedGroup.language} | ${globalPage}/${totalPageCount} | ${preparedGroup.group.profile.name}`);
      completed += result.images.length;
      renderedGroups.push(result);
    }
    timings.rasterAndPostprocess = elapsedMs(rasterStarted);
    timings.workers = configuredWorkers;
    timings.total = elapsedMs(totalStarted);
    const images = renderedGroups.flatMap((group) => group.images);
    const pageDimensions = renderedGroups.flatMap((group) => group.pageDimensions);
    const lastPage = renderedGroups.at(-1)!.finalPage;
    const renderGroups = prepared.map((group, index) => ({ profile: group.group.profile.name, reason: group.group.reason, sources: group.group.items.map((item) => item.input.displayPath), pageCount: group.pageCount, pageDimensions: renderedGroups[index].pageDimensions, workers: renderedGroups[index].workers, fontsUsed: group.fontsUsed }));
    const tablets = prepared.flatMap((group, index) => buildGroupTablets(group.markers, group.provenancePages, group.pageCount, group.group.profile.name, renderedGroups[index].pageDimensions)).map((tablet, index) => ({ ...tablet, id: assignedTabletIds[index], pageIndex: index + 1 }));
    const fontsUsed = [...new Set(prepared.flatMap((group) => group.fontsUsed))].sort();
    const symbolStarted = performance.now();
    const symbolData = await extractAndMapSymbols(inputs, tablets);
    timings.symbols = elapsedMs(symbolStarted);
    timings.total = elapsedMs(totalStarted);
    const manifest: RenderManifest = { sourceBytes, sourceChars, encodedChars, removedChars, reductionPercent, profile, requestedProfile: profile.name, renderGroups, tablets, symbols: symbolData.symbols, symbolDiagnostics: symbolData.diagnostics, symbolExtractorVersion: symbolData.version, fontsUsed, codec: new Set(compacted.map((item) => item.value.codec)).size === 1 ? compacted[0].value.codec : undefined, language, git: gitState.provenance, pageCount: images.length, pageDimensions, finalPage: { originalDimensions: { width: 1056, height: HEADER_HEIGHT + 960 }, croppedDimensions: { width: lastPage.width, height: lastPage.height }, columnsUsed: lastPage.columnsUsed, croppedRightPixels: lastPage.croppedRightPixels, croppedBottomPixels: lastPage.croppedBottomPixels }, timingsMs: timings, workers: configuredWorkers, cache: { schemaVersion: CACHE_SCHEMA_VERSION, key, hit: false } };
    const sourceManifests = compacted.map((item, index) => ({ path: item.input.path, manifest: { ...item.value, profile: (profile.name === "conservative" || classified.find((source) => source.input.path === item.input.path)?.classification.fallbackRequired) ? getVisualProfile("conservative") : getVisualProfile("normal"), language: item.input.language, codec: item.value.codec, gitRepository: gitState.repositoryIds[index] ?? null, pageCount: 0, pageDimensions: [], finalPage: manifest.finalPage } }));
    if (cacheEnabled()) await publishCache(cacheDirectory, key, projectContext.state.prefix, manifest, sourceManifests, images);
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
