import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cropFinalPage, FILE_BANNER_PREFIX, formatFileBanner, parseVisualInput, RenderCancelled, renderSources } from "../src/rust.ts";
import { buildContinuousRequestManifest, buildRequestManifest } from "../src/manifest.ts";
import { getVisualProfile } from "../src/profile.ts";
import { displaySourcePaths, expandSourcePatterns } from "../src/sources.ts";
import { confirmFileBudget, confirmTabletBudget, fileConfirmationMessage, maxTabletsFromEnvironment, tabletConfirmationMessage } from "../src/policy.ts";
import { openPreview } from "../src/preview.ts";
import { VISUAL_CONTEXT_HELP } from "../src/help.ts";
import { registerVisualContextCommand } from "../src/command.ts";

const root = new URL("..", import.meta.url).pathname;
const cHelper = join(root, "tools/c-strip-lex/target/release/c-strip-lex");
const pythonHelper = join(root, "tools/python-strip-lex/target/release/python-strip-lex");
const font = join(root, "assets/fonts/romulus/Romulus.ttf");

test("registers a local /visual-context help command without model work", async () => {
  const commands = [];
  const pi = { on() {}, registerCommand(name, options) { commands.push({ name, options }); } };
  registerVisualContextCommand(pi);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "visual-context");
  assert.equal(commands[0].options.description, "Show pi-visual-context usage and options");
  const widgets = [];
  await commands[0].options.handler("", { ui: { setWidget(key, content) { widgets.push({ key, content }); } } });
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].key, "visual-context-help");
  assert.deepEqual(widgets[0].content, VISUAL_CONTEXT_HELP.split("\n"));
  assert.match(VISUAL_CONTEXT_HELP, /@v/);
  assert.match(VISUAL_CONTEXT_HELP, /--render/);
  assert.match(VISUAL_CONTEXT_HELP, /--open/);
  assert.match(VISUAL_CONTEXT_HELP, /--profile/);
  for (const text of [".rs", ".c", ".h", ".py", "**/*.py", "PI_VISUAL_CONTEXT_MAX_TABLETS"]) assert.match(VISUAL_CONTEXT_HELP, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("bundled Romulus contains all Python structural glyphs", () => {
  const charset = execFileSync("fc-query", ["--format=%{charset}", font], { encoding: "utf8" });
  const ranges = charset.trim().split(/\s+/).map((range) => {
    const [start, end = start] = range.split("-");
    return [parseInt(start, 16), parseInt(end, 16)];
  });
  for (const glyph of ["¤", "¶", "»"]) {
    const codepoint = glyph.codePointAt(0);
    assert.ok(ranges.some(([start, end]) => codepoint >= start && codepoint <= end), `${glyph} missing from Romulus cmap`);
  }
});

test("parses mono-file input and preserves question separator", () => {
  assert.deepEqual(parseVisualInput("@v src/foo.rs -- Explain -- this."), {
    source: "src/foo.rs", sources: ["src/foo.rs"], question: "Explain -- this.", profile: "normal", render: false, open: false,
  });
});

test("parses ordered multi-file input with an explicit profile", () => {
  const parsed = parseVisualInput("@v --profile conservative foo.h foo.c bar.rs sample.py -- How do these interact?");
  assert.deepEqual(parsed.sources, ["foo.h", "foo.c", "bar.rs", "sample.py"]);
  assert.equal(parsed.profile, "conservative");
  assert.equal(parsed.question, "How do these interact?");
});

test("parses render mode, optional opening, and profile without a question", () => {
  assert.deepEqual(parseVisualInput("@v --render --open --profile conservative src/**/*.py"), {
    source: "src/**/*.py", sources: ["src/**/*.py"], question: "", profile: "conservative", render: true, open: true,
  });
  assert.equal(parseVisualInput("@v --render --profile conservative src/**/*.py -- Review this").render, true);
});

test("expands globs in argument order, sorts matches, and deduplicates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-glob-test-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "b.py"), "");
  writeFileSync(join(dir, "a.py"), "");
  writeFileSync(join(dir, "nested", "c.py"), "");
  const files = await expandSourcePatterns(["b.py", "*.py", "**/*.py", "nested/c.py"], dir);
  assert.deepEqual(files.map((file) => file.slice(dir.length + 1)), ["b.py", "a.py", "nested/c.py"]);
  await assert.rejects(() => expandSourcePatterns(["missing/**/*.py"], dir), /source glob matched no regular files/);
  assert.deepEqual(displaySourcePaths([join(dir, "a.py"), join(dir, "nested", "c.py")], dir), ["a.py", "c.py"]);
  assert.deepEqual(displaySourcePaths([join(dir, "auth", "policy.py"), join(dir, "security", "policy.py")], dir), ["auth/policy.py", "security/policy.py"]);
});

test("preview confirms large rasterizations and launcher failures are non-fatal", async () => {
  assert.equal(parseVisualInput("@v --render src/foo.py").render, true);
  let confirmations = 0;
  const previewUi = { confirm: async () => { confirmations++; return false; } };
  assert.equal(await confirmTabletBudget(previewUi, 1, 10, 0, 10, "preview"), true);
  assert.equal(confirmations, 0);
  assert.equal(await confirmTabletBudget(previewUi, 1, 11, 0, 10, "preview"), false);
  assert.equal(confirmations, 1);
  let launched = false;
  await openPreview("/tmp/preview", "linux", async () => { launched = true; throw new Error("headless"); });
  assert.equal(launched, true);
});

test("glob policy confirms only above the configurable tablet threshold", async () => {
  assert.equal(maxTabletsFromEnvironment({ PI_VISUAL_CONTEXT_MAX_TABLETS: "12" }), 12);
  assert.equal(maxTabletsFromEnvironment({ PI_VISUAL_CONTEXT_MAX_TABLETS: "invalid" }), 10);
  assert.equal(tabletConfirmationMessage(37, 14, 182000), "visual-context: 37 files · 14 tablets · 182k chars\nSend 14 images to the model?");
  assert.equal(tabletConfirmationMessage(17, 18, 0, "preview"), "visual-context: 17 files · 18 tablets\nRasterize 18 preview tablets?");
  let calls = 0;
  const ui = { confirm: async () => { calls++; return false; } };
  assert.equal(await confirmTabletBudget(ui, 2, 10, 1000, 10), true);
  assert.equal(calls, 0);
  assert.equal(await confirmTabletBudget(ui, 2, 11, 1000, 10), false);
  assert.equal(calls, 1);
  assert.equal(await confirmTabletBudget({ confirm: async () => true }, 2, 11, 1000, 10), true);
  assert.equal(await confirmFileBudget({ confirm: async () => true }, 3, 3), true);
  assert.equal(await confirmFileBudget({ confirm: async () => false }, 21, 20), false);
  assert.equal(fileConfirmationMessage(21), "visual-context: glob matched 21 files.\nRender them?");
});

test("rejects malformed, unsupported, and unknown-profile input", () => {
  assert.throws(() => parseVisualInput("@v foo.rs"), /malformed/);
  assert.throws(() => parseVisualInput("@v foo.java -- question"), /unsupported source extension/);
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
  const continuous = buildContinuousRequestManifest([
    { path: "foo.py", manifest: fakeManifest(10, [], "Python") },
    { path: "bar.rs", manifest: fakeManifest(20, [], "Rust") },
  ], ["page-001.png"], fakeManifest(30, [{ width: 1056, height: 960 }], "Mixed"), {});
  assert.equal(continuous.tabletSourcesKnown, false);
  assert.equal(continuous.sources[0].pages, undefined);
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

test("Python codec handles the bundled fixture and is deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-python-test-"));
  const source = join(root, "tests/fixtures/sample.py");
  const one = join(dir, "one.txt");
  const two = join(dir, "two.txt");
  execFileSync(pythonHelper, [source, one, font]);
  execFileSync(pythonHelper, [source, two, font]);
  assert.deepEqual(readFileSync(one), readFileSync(two));
  assert.match(readFileSync(one, "utf8"), /\u200b/);
});

test("Python codec densely encodes logical depth, blank lines, and continuations", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-python-dense-test-"));
  const source = join(dir, "dense.py");
  const nested = Array.from({ length: 12 }, (_, index) => `${"    ".repeat(index)}if level${index}:`);
  const lines = [...nested, `${"    ".repeat(12)}value = "line\\n¶\\t"`, "", "", "foo(", "    a,", "    b,", ")", "if a and \\", "    b:", "    match café:", "        case _:", "            return f\"{a=}\""];
  writeFileSync(source, `${lines.join("\n")}\n`);
  const output = join(dir, "dense.txt");
  execFileSync(pythonHelper, [source, output, font]);
  const encoded = readFileSync(output, "utf8").replaceAll("\u200b", "");
  assert.match(encoded, /1»/);
  assert.match(encoded, /12»/);
  assert.match(encoded, /¶¶/);
  assert.match(encoded, /¤¶/);
  assert.match(encoded, /foo\(¶/);
});

test("Python multiline strings use visual LF markers without changing literals", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-python-strings-test-"));
  const source = join(dir, "strings.py");
  const text = [
    'double = """first line',
    '',
    'second line"""',
    "single = '''one",
    "two'''",
    'raw = r"""raw\\n¶»',
    'line"""',
    'binary = b"""bytes',
    'line"""',
    'value = 3',
    'formatted = f"""value {value}',
    'next"""',
    'markers = "contains ¤ ¤¶ ¤» ¶ »"',
    '',
  ].join("\n");
  writeFileSync(source, text);
  const output = join(dir, "strings.txt");
  execFileSync(pythonHelper, [source, output, font]);
  const encoded = readFileSync(output, "utf8").replaceAll("\u200b", "");
  assert.equal(encoded.includes("\n"), false);
  assert.ok(encoded.includes("first line¶¶second line"));
  assert.ok(encoded.includes("raw\\n¤¶¤»"));
  assert.ok(encoded.includes("contains ¤¤ ¤¤¤¶ ¤¤¤» ¤¶ ¤»"));
  const second = join(dir, "strings-2.txt");
  execFileSync(pythonHelper, [source, second, font]);
  assert.deepEqual(readFileSync(output), readFileSync(second));
});

test("tablet confirmation can cancel after PDF layout before rasterization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-cancel-test-"));
  const source = join(dir, "small.py");
  writeFileSync(source, "value = 1\n");
  const statuses = [];
  await assert.rejects(() => renderSources([{ path: source, displayPath: "small.py", language: "Python" }], (status) => statuses.push(status), getVisualProfile("normal"), { beforeRasterize: async () => false }), RenderCancelled);
  assert.ok(statuses.some((status) => status === "PDF ready: 1 tablets"));
  assert.equal(statuses.some((status) => status.startsWith("rasterizing")), false);
});

test("file transitions are renderer banners, not codec text separators", () => {
  assert.equal(formatFileBanner("policy.py"), `${FILE_BANNER_PREFIX}policy.py`);
  assert.doesNotMatch(formatFileBanner("policy.py"), /=====/);
  assert.match(formatFileBanner("auth/policy.py"), /auth\/policy\.py/);
});

test("continuous renderer combines files and reports global progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-continuous-test-"));
  const first = join(dir, "first.py");
  const second = join(dir, "second.c");
  writeFileSync(first, "def first():\n    return 1\n");
  writeFileSync(second, "int second(void) { return 2; }\n");
  const statuses = [];
  const rendered = await renderSources([
    { path: first, displayPath: "first.py", language: "Python" },
    { path: second, displayPath: "second.c", language: "C" },
  ], (status) => statuses.push(status), getVisualProfile("normal"));
  assert.equal(rendered.manifest.language, "Mixed");
  assert.equal(rendered.sourceManifests.length, 2);
  assert.equal(rendered.manifest.pageCount, rendered.images.length);
  assert.ok(statuses.includes("laying out 2 files"));
  assert.ok(statuses.some((status) => status.startsWith("rasterizing 1/")));
  const preview = await renderSources([
    { path: first, displayPath: "first.py", language: "Python" },
    { path: second, displayPath: "second.c", language: "C" },
  ], () => {}, getVisualProfile("normal"));
  assert.deepEqual(preview.images, rendered.images);
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
