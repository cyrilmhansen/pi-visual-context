import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  language: "Rust" | "C";
  pageDimensions: { width: number; height: number }[];
  finalPage: {
    originalDimensions: { width: number; height: number };
    croppedDimensions: { width: number; height: number };
    columnsUsed: number;
    croppedRightPixels: number;
    croppedBottomPixels: number;
  };
};

export function parseVisualInput(text: string): { source: string; sources: string[]; question: string; profile: string } {
  if (!text.startsWith("@v ")) throw new Error("not a visual-context input");
  let rest = text.slice(3);
  let profile = "normal";
  if (rest.startsWith("--profile ")) {
    const match = rest.match(/^--profile\s+(\S+)\s+/);
    if (!match) throw new Error("malformed @v profile syntax; use: @v --profile <name> <rust-source-path> -- <question>");
    profile = match[1];
    rest = rest.slice(match[0].length);
  }
  const separator = rest.indexOf(" -- ");
  if (separator < 0) throw new Error("malformed @v syntax; use: @v <rust-source-path> -- <question>");
  const sourceText = rest.slice(0, separator).trim();
  const question = rest.slice(separator + 4).trim();
  const sources = sourceText ? sourceText.split(/\s+/) : [];
  if (!sources.length || !question) throw new Error("malformed @v syntax; source paths and question are required");
  for (const source of sources) {
    if (!/\.(rs|c|h)$/.test(source)) throw new Error(`unsupported source extension for "${source}"; supported extensions are .rs, .c, and .h`);
  }
  return { source: sources[0], sources, question, profile };
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

async function addHeader(path: string, page: number, total: number, sourceName: string, profile: VisualProfile, language: "Rust" | "C") {
  const text = page === 1 ? `${language} | ${sourceName} | visual-context | ${page}/${total} | ${profile.name}` : `${sourceName} | ${page}/${total}`;
  const font = resolve(root, "assets/fonts/romulus/Romulus.ttf");
  const output = `${path}.header.png`;
  await run("magick", [path, "-gravity", "NorthWest", "-background", "white", "-splice", `0x${HEADER_HEIGHT}`, "-font", font, "-fill", "black", "-pointsize", "10", "-annotate", "+12+4", text, output]);
  await rm(path);
  await run("mv", [output, path]);
}

type Compacted = { output: string; sourceBytes: number; sourceChars: number; encodedChars: number; removedChars: number; reductionPercent: number };

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

async function renderSource(sourcePath: string, status: (text: string) => void, profile: VisualProfile, language: "Rust" | "C"): Promise<{ images: Buffer[]; manifest: RenderManifest }> {
  const work = await mkdtemp(resolve(root, ".pi-visual-context-"));
  try {
    const compacted = language === "Rust" ? await compactRust(sourcePath, work, status) : await compactC(sourcePath, work, status);
    const pdf = resolve(work, "source.pdf");
    const pngPrefix = resolve(work, "page");
    const fontDir = resolve(root, "assets/fonts/romulus");
    status("rendering PDF");
    await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${compacted.output.slice(root.length + 1)}`, "--input", `font=${profile.font}`, "--input", `cols=${profile.columns}`, "--input", `scale=${profile.scale}`, "--input", `size=${profile.fontSize}`, "--input", `leading=${profile.leading}`, "--input", `margin=${profile.sideMargin}`, "--input", `gutter=${profile.gutter}`, resolve(root, "typst/source.typ"), pdf]);
    const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pageCount) throw new Error("renderer produced no PDF pages");
    status(`PDF ready: ${pageCount} pages`);
    await run("pdftocairo", ["-png", "-r", "1152", pdf, pngPrefix]);
    const rasterPages = (await readdir(work)).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const images: Buffer[] = [];
    const pageDimensions: { width: number; height: number }[] = [];
    let finalPage = { width: 1056, height: HEADER_HEIGHT + 960, columnsUsed: 3, croppedRightPixels: 0, croppedBottomPixels: 0 };
    for (let i = 0; i < rasterPages.length; i++) {
      status(`rasterizing ${i + 1}/${rasterPages.length}`);
      const input = resolve(work, rasterPages[i]);
      const output = input.replace(/\.png$/, "-final.png");
      await run("magick", [input, "-filter", "Box", "-resize", "6.25%", output]);
      await rm(input);
      const { stdout: size } = await run("identify", ["-format", "%wx%h", output]);
      if (size.trim() !== "1056x960") throw new Error(`renderer produced ${size.trim()}, expected 1056x960`);
      await addHeader(output, i + 1, rasterPages.length, basename(sourcePath), profile, language);
      if (i === rasterPages.length - 1) finalPage = await cropFinalPage(output, profile);
      pageDimensions.push({ width: i === rasterPages.length - 1 ? finalPage.width : 1056, height: i === rasterPages.length - 1 ? finalPage.height : HEADER_HEIGHT + 960 });
      images.push(await readFile(output));
    }
    if (images.length !== pageCount) throw new Error(`rasterized ${images.length} pages, expected ${pageCount}`);
    return { images, manifest: { ...compacted, profile, language, pageCount, pageDimensions, finalPage: { originalDimensions: { width: 1056, height: HEADER_HEIGHT + 960 }, croppedDimensions: { width: finalPage.width, height: finalPage.height }, columnsUsed: finalPage.columnsUsed, croppedRightPixels: finalPage.croppedRightPixels, croppedBottomPixels: finalPage.croppedBottomPixels } } };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function renderRust(sourcePath: string, status: (text: string) => void, profile: VisualProfile) {
  return renderSource(sourcePath, status, profile, "Rust");
}

export function renderC(sourcePath: string, status: (text: string) => void, profile: VisualProfile) {
  return renderSource(sourcePath, status, profile, "C");
}
