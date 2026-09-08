import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cropFinalPage, parseVisualInput } from "../src/rust.ts";
import { buildRequestManifest } from "../src/manifest.ts";
import { getVisualProfile } from "../src/profile.ts";

const root = new URL("..", import.meta.url).pathname;
const cHelper = join(root, "tools/c-strip-lex/target/release/c-strip-lex");
const font = join(root, "assets/fonts/romulus/Romulus.ttf");

test("parses mono-file input and preserves question separator", () => {
  assert.deepEqual(parseVisualInput("@v src/foo.rs -- Explain -- this."), {
    source: "src/foo.rs", sources: ["src/foo.rs"], question: "Explain -- this.", profile: "normal",
  });
});

test("parses ordered multi-file input with an explicit profile", () => {
  const parsed = parseVisualInput("@v --profile conservative foo.h foo.c bar.rs -- How do these interact?");
  assert.deepEqual(parsed.sources, ["foo.h", "foo.c", "bar.rs"]);
  assert.equal(parsed.profile, "conservative");
  assert.equal(parsed.question, "How do these interact?");
});

test("rejects malformed, unsupported, and unknown-profile input", () => {
  assert.throws(() => parseVisualInput("@v foo.rs"), /malformed/);
  assert.throws(() => parseVisualInput("@v foo.py -- question"), /unsupported source extension/);
  assert.throws(() => getVisualProfile("dense"), /unknown visual profile/);
});

const fakeManifest = (sourceBytes, pageDimensions, language = "Rust") => ({ sourceBytes, sourceChars: sourceBytes, encodedChars: sourceBytes - 1, removedChars: 1, reductionPercent: 1, profile: { name: "normal", font: "Romulus", columns: 3, scale: 1, fontSize: 10.753, leading: 2.151, sideMargin: 12, gutter: 24 }, language, pageCount: pageDimensions.length, pageDimensions, finalPage: { originalDimensions: { width: 1056, height: 980 }, croppedDimensions: pageDimensions.at(-1), columnsUsed: 1, croppedRightPixels: 704, croppedBottomPixels: 0 } });

test("builds unambiguous mono and multi-file manifest page ownership", () => {
  const a = { path: "foo.h", manifest: fakeManifest(10, [{ width: 352, height: 500 }], "C") };
  const b = { path: "foo.c", manifest: fakeManifest(20, [{ width: 1056, height: 980 }, { width: 352, height: 500 }], "C") };
  const multi = buildRequestManifest([a, b], [["page-001.png"], ["page-002.png", "page-003.png"]], a.manifest.profile, {});
  assert.deepEqual(multi.sources.map((source) => [source.sourcePath, source.pages]), [["foo.h", ["page-001.png"]], ["foo.c", ["page-002.png", "page-003.png"]]]);
  const mono = buildRequestManifest([a], [["page-001.png"]], a.manifest.profile, {});
  assert.deepEqual(mono.pages, ["page-001.png"]);
});

test("final-page crop keeps the 20px header and removes unused height", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-crop-test-"));
  const image = join(dir, "page.png");
  execFileSync("magick", ["-size", "1056x980", "xc:white", "-fill", "black", "-draw", "rectangle 12,5 100,10 rectangle 12,40 340,100", image]);
  const cropped = await cropFinalPage(image, getVisualProfile("normal"));
  assert.equal(cropped.width, 352);
  assert.ok(cropped.height < 980);
  assert.equal(cropped.croppedRightPixels, 704);
  assert.ok(cropped.croppedBottomPixels > 0);
  assert.equal(cropped.height + cropped.croppedBottomPixels, 980);
  const dimensions = execFileSync("identify", ["-format", "%wx%h", image], { encoding: "utf8" }).trim();
  assert.equal(dimensions, `${cropped.width}x${cropped.height}`);
  const headerPixel = execFileSync("magick", [image, "-format", "%[pixel:p{20,5}]", "info:"], { encoding: "utf8" }).trim();
  assert.ok(!/white/i.test(headerPixel));

  const twoColumnImage = join(dir, "two-columns.png");
  execFileSync("magick", ["-size", "1056x980", "xc:white", "-fill", "black", "-draw", "rectangle 12,40 340,100 rectangle 364,40 692,100", twoColumnImage]);
  const twoColumns = await cropFinalPage(twoColumnImage, getVisualProfile("normal"));
  assert.equal(twoColumns.width, 704);
  assert.equal(twoColumns.height, 980);
  assert.equal(twoColumns.croppedBottomPixels, 0);
});

test("C codec handles the bundled header/source fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-c-test-"));
  const header = join(root, "tests/fixtures/sample.h");
  const implementation = join(root, "tests/fixtures/sample.c");
  const headerOut = join(dir, "header.txt");
  const implementationOut = join(dir, "implementation.txt");
  execFileSync(cHelper, [header, headerOut, font]);
  execFileSync(cHelper, [implementation, implementationOut, font]);
  assert.ok(readFileSync(headerOut).length > 0);
  assert.ok(readFileSync(implementationOut).length > 0);
});

test("C codec is deterministic on a focused fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-c-test-"));
  const source = join(dir, "fixture.c");
  const fixture = `#include <x.h>\n#define F(x) do { \\\n  /* keep */ x++; \\\n} while (0)\nint *p; char *s = "a b\\\\c"; // comment\n`;
  writeFileSync(source, fixture);
  const one = join(dir, "one.txt");
  const two = join(dir, "two.txt");
  execFileSync(cHelper, [source, one, font]);
  execFileSync(cHelper, [source, two, font]);
  assert.deepEqual(readFileSync(one), readFileSync(two));
});
