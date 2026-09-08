import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VisualProfile } from "./profile";

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

export async function cropFinalPage(path: string, profile: VisualProfile) {
  const columnWidth = (1056 - 2 * profile.sideMargin - (profile.columns - 1) * profile.gutter) / profile.columns;
  const columns = await Promise.all(Array.from({ length: profile.columns }, (_, index) => trimGeometry(path, `${columnWidth}x960+${profile.sideMargin + index * (columnWidth + profile.gutter)}+${HEADER_HEIGHT}`)));
  const columnsUsed = columns[2].nonWhite ? 3 : columns[1].nonWhite ? 2 : 1;
  const width = 2 * profile.sideMargin + columnsUsed * columnWidth + (columnsUsed - 1) * profile.gutter;
  let height = HEADER_HEIGHT + 960;
  if (columnsUsed === 1 && columns[0].nonWhite) {
    const match = columns[0].geometry.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    if (match) height = Math.min(HEADER_HEIGHT + 960, HEADER_HEIGHT + Number(match[4]) + Number(match[2]) + 2);
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
export type RenderOptions = { beforeRasterize?: (pageCount: number, sourceChars: number) => Promise<boolean> };

async function compactFile(input: RenderInput, outDir: string, status: (text: string) => void): Promise<Compacted> {
  if (input.language === "Rust") return compactRust(input.path, outDir, status);
  if (input.language === "C") return compactC(input.path, outDir, status);
  return compactPython(input.path, outDir, status);
}

export async function renderSources(inputs: RenderInput[], status: (text: string) => void, profile: VisualProfile, options: RenderOptions = {}): Promise<{ images: Buffer[]; manifest: RenderManifest; sourceManifests: { path: string; manifest: RenderManifest }[] }> {
  const work = await mkdtemp(resolve(root, ".pi-visual-context-"));
  try {
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
    const combinedOutput = resolve(work, "source.txt");
    const chunks: Buffer[] = [];
    for (const item of compacted) {
      chunks.push(Buffer.from(`${formatFileBanner(item.input.displayPath)}\n`));
      chunks.push(await readFile(item.value.output));
      chunks.push(Buffer.from("\n"));
    }
    await writeFile(combinedOutput, Buffer.concat(chunks));
    const sourceBytes = compacted.reduce((sum, item) => sum + item.value.sourceBytes, 0);
    const sourceChars = compacted.reduce((sum, item) => sum + item.value.sourceChars, 0);
    const encodedChars = compacted.reduce((sum, item) => sum + item.value.encodedChars, 0);
    const removedChars = compacted.reduce((sum, item) => sum + item.value.removedChars, 0);
    const reductionPercent = sourceChars ? removedChars / sourceChars * 100 : 0;
    const languages = [...new Set(inputs.map((input) => input.language))];
    const language = languages.length === 1 ? languages[0] : "Mixed";
    const pdf = resolve(work, "source.pdf");
    const pngPrefix = resolve(work, "page");
    const fontDir = resolve(root, "assets/fonts/romulus");
    status(`laying out ${inputs.length} files`);
    await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${combinedOutput.slice(root.length + 1)}`, "--input", `font=${profile.font}`, "--input", `cols=${profile.columns}`, "--input", `scale=${profile.scale}`, "--input", `size=${profile.fontSize}`, "--input", `leading=${profile.leading}`, "--input", `margin=${profile.sideMargin}`, "--input", `gutter=${profile.gutter}`, resolve(root, "typst/source.typ"), pdf]);
    const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pageCount) throw new Error("renderer produced no PDF pages");
    status(`PDF ready: ${pageCount} tablets`);
    if (options.beforeRasterize && !await options.beforeRasterize(pageCount, sourceChars)) throw new RenderCancelled();
    await run("pdftocairo", ["-png", "-r", "1152", pdf, pngPrefix]);
    const rasterPages = (await readdir(work)).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const images: Buffer[] = [];
    const pageDimensions: { width: number; height: number }[] = [];
    let finalPage = { width: 1056, height: HEADER_HEIGHT + 960, columnsUsed: 3, croppedRightPixels: 0, croppedBottomPixels: 0 };
    for (let index = 0; index < rasterPages.length; index++) {
      status(`rasterizing ${index + 1}/${rasterPages.length}`);
      const input = resolve(work, rasterPages[index]);
      const output = input.replace(/\.png$/, "-final.png");
      await run("magick", [input, "-filter", "Box", "-resize", "6.25%", output]);
      await rm(input);
      const { stdout: size } = await run("identify", ["-format", "%wx%h", output]);
      if (size.trim() !== "1056x960") throw new Error(`renderer produced ${size.trim()}, expected 1056x960`);
      await addHeader(output, index + 1, rasterPages.length, profile, language);
      if (index === rasterPages.length - 1) finalPage = await cropFinalPage(output, profile);
      const normalized = `${output}.normalized.png`;
      await run("magick", [output, "-strip", normalized]);
      await rm(output);
      await run("mv", [normalized, output]);
      pageDimensions.push({ width: index === rasterPages.length - 1 ? finalPage.width : 1056, height: index === rasterPages.length - 1 ? finalPage.height : HEADER_HEIGHT + 960 });
      images.push(await readFile(output));
    }
    if (images.length !== pageCount) throw new Error(`rasterized ${images.length} pages, expected ${pageCount}`);
    const manifest: RenderManifest = { sourceBytes, sourceChars, encodedChars, removedChars, reductionPercent, profile, language, pageCount, pageDimensions, finalPage: { originalDimensions: { width: 1056, height: HEADER_HEIGHT + 960 }, croppedDimensions: { width: finalPage.width, height: finalPage.height }, columnsUsed: finalPage.columnsUsed, croppedRightPixels: finalPage.croppedRightPixels, croppedBottomPixels: finalPage.croppedBottomPixels } };
    return { images, manifest, sourceManifests: compacted.map((item) => ({ path: item.input.path, manifest: { ...item.value, profile, language: item.input.language, pageCount: 0, pageDimensions: [], finalPage: manifest.finalPage } })) };
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
