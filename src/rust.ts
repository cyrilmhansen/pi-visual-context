import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type RenderManifest = {
  sourceBytes: number;
  sourceChars: number;
  encodedChars: number;
  removedChars: number;
  reductionPercent: number;
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
};

export function parseVisualInput(text: string): { source: string; question: string } {
  if (!text.startsWith("@v ")) throw new Error("not a visual-context input");
  const rest = text.slice(3);
  const separator = rest.indexOf(" -- ");
  if (separator < 0) throw new Error("malformed @v syntax; use: @v <rust-source-path> -- <question>");
  const source = rest.slice(0, separator).trim();
  const question = rest.slice(separator + 4).trim();
  if (!source || !question) throw new Error("malformed @v syntax; both source path and question are required");
  if (!source.endsWith(".rs")) throw new Error("@v currently accepts Rust .rs files only");
  return { source, question };
}

async function compactRust(sourcePath: string, outDir: string, status: (text: string) => void) {
  const source = await readFile(sourcePath, "utf8");
  const output = resolve(outDir, "source.txt");
  status(`compacting ${source.length} -> ... chars`);
  const tool = resolve(root, "tools/rust-strip-lex");
  const font = "/home/john/projects/poc/visual-code-context/fonts/bitmap/romulus/romulus.ttf";
  const { stdout } = await run("cargo", ["run", "--quiet", "--manifest-path", resolve(tool, "Cargo.toml"), "--", sourcePath, output, font], { cwd: root });
  const match = stdout.match(/encoded visible chars=(\d+)/);
  if (!match) throw new Error("strip-lex did not report its encoded character count");
  const encodedChars = Number(match[1]);
  const removedChars = source.length - encodedChars;
  const reductionPercent = source.length ? (removedChars / source.length) * 100 : 0;
  status(`compacting ${source.length} -> ${encodedChars} chars (-${reductionPercent.toFixed(1)}%)`);
  return { output, sourceBytes: Buffer.byteLength(source), sourceChars: source.length, encodedChars, removedChars, reductionPercent };
}

export async function renderRust(sourcePath: string, status: (text: string) => void): Promise<{ images: Buffer[]; manifest: RenderManifest }> {
  const work = await mkdtemp(resolve(root, ".pi-visual-context-"));
  try {
    const compacted = await compactRust(sourcePath, work, status);
    const pdf = resolve(work, "source.pdf");
    const pngPrefix = resolve(work, "page");
    const fontDir = "/home/john/projects/poc/visual-code-context/fonts/bitmap/romulus";
    status("rendering PDF");
    await run("typst", ["compile", "--root", root, "--font-path", fontDir, "--input", `source=../${compacted.output.slice(root.length + 1)}`, resolve(root, "typst/source.typ"), pdf]);
    const { stdout: pdfInfo } = await run("pdfinfo", [pdf]);
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pageCount) throw new Error("renderer produced no PDF pages");
    status(`PDF ready: ${pageCount} pages`);
    await run("pdftocairo", ["-png", "-r", "1152", pdf, pngPrefix]);
    const rasterPages = (await readdir(work)).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const images: Buffer[] = [];
    for (let i = 0; i < rasterPages.length; i++) {
      status(`rasterizing ${i + 1}/${rasterPages.length}`);
      const input = resolve(work, rasterPages[i]);
      const output = input.replace(/\.png$/, "-final.png");
      await run("magick", [input, "-filter", "Box", "-resize", "6.25%", output]);
      await rm(input);
      const { stdout: size } = await run("identify", ["-format", "%wx%h", output]);
      if (size.trim() !== "1056x960") throw new Error(`renderer produced ${size.trim()}, expected 1056x960`);
      images.push(await readFile(output));
    }
    if (images.length !== pageCount) throw new Error(`rasterized ${images.length} pages, expected ${pageCount}`);
    return { images, manifest: { ...compacted, pageCount, pageWidth: 1056, pageHeight: 960 } };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
