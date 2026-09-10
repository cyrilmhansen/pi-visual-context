import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyRenderedText, cropFinalPage, FILE_BANNER_PREFIX, formatFileBanner, mapPages, parseVisualInput, rasterWorkerCount, RenderCancelled, renderSources } from "../src/rust.ts";
import { prepareSourceContext } from "../src/core.ts";
import { buildContinuousRequestManifest, buildRequestManifest, buildVisualPromptRequestManifest } from "../src/manifest.ts";
import { getVisualProfile } from "../src/profile.ts";
import { displaySourcePaths, expandSourcePatterns } from "../src/sources.ts";
import { confirmFileBudget, confirmTabletBudget, fileConfirmationMessage, maxTabletsFromEnvironment, tabletConfirmationMessage } from "../src/policy.ts";
import { openPreview } from "../src/preview.ts";
import { VISUAL_CONTEXT_HELP } from "../src/help.ts";
import { registerVisualContextCommand } from "../src/command.ts";
import { collectGitProvenance } from "../src/git.ts";
import { renderTask } from "../src/task.ts";
import { buildHistoricalSourcePrompt, buildSourceTabletIndex, buildVisualSourcePrompt } from "../src/tablet-index.ts";
import { extractAllSymbols, mapSymbolsToTablets } from "../src/symbols.ts";
import { loadProjectContext, reserveTabletIds } from "../src/project.ts";
import { activeSourceContextFromManifest, buildSymbolNavigationPrompt, buildTabletNavigationPrompt, formatSymbolList, resolveActiveSymbol, resolveNavigation } from "../src/navigation.ts";

const root = new URL("..", import.meta.url).pathname;
const cHelper = join(root, "tools/c-strip-lex/target/release/c-strip-lex");
const pythonHelper = join(root, "tools/python-strip-lex/target/release/python-strip-lex");
const font = join(root, "assets/fonts/romulus/Romulus.ttf");

test("core prepares a source context without loading the Pi extension", async () => {
  const cache = mkdtempSync(join(tmpdir(), "pvc-core-"));
  const result = await prepareSourceContext({ cwd: root, sources: ["tests/fixtures/sample.py"], profile: "normal", cacheDirectory: cache });
  assert.ok(result);
  assert.equal(result.inputs[0].language, "Python");
  assert.equal(result.images.length, result.manifest.tablets?.length);
  assert.ok(result.manifest.tablets?.length);
  assert.ok(result.manifest.tablets?.every((tablet) => tablet.spans.length > 0));
  assert.ok(result.tabletIndex.includes("VC-"));
  assert.ok(result.manifest.symbols?.some((symbol) => symbol.name === "compute"));
  assert.ok(result.images.every((image) => image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
  rmSync(cache, { recursive: true, force: true });
});

test("core and direct renderer preserve essential SOURCE data", async () => {
  const cache = mkdtempSync(join(tmpdir(), "pvc-parity-"));
  const core = await prepareSourceContext({ cwd: root, sources: ["tests/fixtures/sample.py"], profile: "normal", cacheDirectory: cache });
  const direct = await renderSources(core.inputs, () => {}, getVisualProfile("normal"), { cacheDirectory: cache, projectRoot: root });
  assert.ok(core);
  assert.deepEqual(core.images, direct.images);
  assert.deepEqual(core.manifest.tablets, direct.manifest.tablets);
  assert.deepEqual(core.manifest.symbols, direct.manifest.symbols);
  assert.deepEqual(core.manifest.pageDimensions, direct.manifest.pageDimensions);
  assert.equal(core.tabletIndex, buildSourceTabletIndex(direct.manifest.tablets ?? []));
  rmSync(cache, { recursive: true, force: true });
});

test("builds the compact source tablet index from canonical tablets", () => {
  const tablets = [
    { id: "VC-001", pageIndex: 1, profile: "normal", width: 1, height: 1, spans: [{ sourceIndex: 0, sourcePath: "/tmp/foo.py", visualName: "foo.py", startLine: 1, endLine: 184 }] },
    { id: "VC-002", pageIndex: 2, profile: "normal", width: 1, height: 1, spans: [
      { sourceIndex: 0, sourcePath: "/tmp/foo.py", visualName: "foo.py", startLine: 184, endLine: 320 },
      { sourceIndex: 1, sourcePath: "/tmp/bar.py", visualName: "bar.py", startLine: 1, endLine: 37 },
    ] },
    { id: "VC-003", pageIndex: 3, profile: "conservative", width: 1, height: 1, spans: [
      { sourceIndex: 2, sourcePath: "/tmp/empty.py", visualName: "empty.py", startLine: null, endLine: null, bannerOnly: true },
      { sourceIndex: 3, sourcePath: "/tmp/a b|c:d.py", visualName: "a b|c:d.py", startLine: 2, endLine: 4 },
      { sourceIndex: 4, sourcePath: "/tmp/line\nname.py", visualName: "line\nname.py", startLine: 5, endLine: 6 },
    ] },
  ];
  const index = "VC-001 foo.py:1-184\nVC-002 foo.py:184-320 | bar.py:1-37\nVC-003 empty.py:empty | a b\\|c\\:d.py:2-4 | line\\nname.py:5-6";
  assert.equal(buildSourceTabletIndex(tablets), index);
  assert.equal(buildHistoricalSourcePrompt("original  question", tablets), `Use the attached visual source context to answer the question.\n\nSource tablet index:\n${index}\n\noriginal  question`);
  assert.equal(buildVisualSourcePrompt(tablets), `Use the attached visual task and source context to answer.\n\nSource tablet index:\n${index}`);
  assert.equal(buildVisualSourcePrompt([]), "Use the attached visual task and source context to answer.");
});

test("parses explicit tablet and symbol navigation without source paths", () => {
  assert.deepEqual(parseVisualInput("@v --tablet AA-VC-000123 -- Why?"), {
    source: undefined, sources: [], question: "Why?", profile: "normal", render: false, open: false, visualPrompt: false, tablet: "AA-VC-000123",
  });
  assert.deepEqual(parseVisualInput("@v --symbol Executor.run -- Explain."), {
    source: undefined, sources: [], question: "Explain.", profile: "normal", render: false, open: false, visualPrompt: false, symbol: "Executor.run",
  });
  assert.deepEqual(parseVisualInput("@v --symbols"), {
    source: undefined, sources: [], question: "", profile: "normal", render: false, open: false, visualPrompt: false, symbols: "",
  });
  assert.deepEqual(parseVisualInput("@v --symbols Executor.run"), {
    source: undefined, sources: [], question: "", profile: "normal", render: false, open: false, visualPrompt: false, symbols: "Executor.run",
  });
  assert.throws(() => parseVisualInput("@v --tablet AA-VC-000123 foo.py -- question"), /source paths/);
  assert.throws(() => parseVisualInput("@v --tablet AA-VC-000123 --symbol Foo -- question"), /cannot be used together/);
  assert.throws(() => parseVisualInput("@v --symbol Foo --render -- question"), /--render/);
  assert.throws(() => parseVisualInput("@v --tablet AA-VC-000123 --"), /non-empty question/);
  assert.throws(() => parseVisualInput("@v --symbols query extra.py"), /source paths/);
  assert.throws(() => parseVisualInput("@v --symbols -- question"), /does not accept a question/);
  assert.throws(() => parseVisualInput("@v --symbols --profile conservative"), /--profile/);
});

test("resolves navigation only against an immutable active source context", () => {
  const manifest = {
    cache: { key: "snapshot-a" },
    tablets: [
      { id: "AA-VC-000123", pageIndex: 0, profile: "normal", width: 1056, height: 500, spans: [{ sourceIndex: 0, sourcePath: "/tmp/executor.py", visualName: "executor.py", startLine: 1, endLine: 20 }] },
      { id: "AA-VC-000124", pageIndex: 1, profile: "normal", width: 1056, height: 500, spans: [{ sourceIndex: 0, sourcePath: "/tmp/executor.py", visualName: "executor.py", startLine: 20, endLine: 40 }] },
    ],
    symbols: [
      { sourceIndex: 0, name: "run", qualifiedName: "Executor.run", kind: "method", line: 20, tabletIds: ["AA-VC-000123", "AA-VC-000124"] },
      { sourceIndex: 0, name: "init", qualifiedName: "Executor.init", kind: "method", line: 5, tabletIds: ["AA-VC-000123"] },
      { sourceIndex: 0, name: "init", qualifiedName: "Other.init", kind: "method", line: 30, tabletIds: ["AA-VC-000124"] },
    ],
  };
  const context = activeSourceContextFromManifest(manifest);
  assert.ok(context);
  assert.equal(context.sourceCacheKey, "snapshot-a");
  manifest.tablets[0].spans[0].startLine = 999;
  manifest.symbols[0].line = 999;
  assert.match(resolveNavigation(context, { tablet: "AA-VC-000123" }, "Why?").text, /AA-VC-000123 executor\.py:1-20/);
  assert.match(resolveNavigation(context, { symbol: "Executor.run" }, "Explain.").text, /Declaration: executor\.py:20/);
  assert.match(resolveNavigation(context, { symbol: "init" }, "Explain.").error, /ambiguous/);
  assert.match(resolveNavigation(context, { tablet: "AA-VC-000999" }, "Why?").error, /not active/);
  assert.match(resolveNavigation(undefined, { tablet: "AA-VC-000123" }, "Why?").error, /no active source context/);
  assert.equal(resolveActiveSymbol(context, "missing").resolved, undefined);
  assert.equal(resolveActiveSymbol(context, "missing").error.includes("not found"), true);
  assert.match(buildTabletNavigationPrompt(context.tablets[0], "Why?"), /Why\?$/);
  assert.match(buildSymbolNavigationPrompt(resolveActiveSymbol(context, "Executor.run").resolved, "Explain."), /Source tablets: AA-VC-000123, AA-VC-000124/);
});

test("formats bounded local symbol inspection deterministically", () => {
  const context = activeSourceContextFromManifest({
    tablets: [{ id: "AA-VC-000123", pageIndex: 0, profile: "normal", width: 1, height: 1, spans: [{ sourceIndex: 0, sourcePath: "/tmp/a.py", visualName: "a.py", startLine: 1, endLine: 20 }] }],
    symbols: [
      { sourceIndex: 0, name: "run", qualifiedName: "Executor.run", kind: "method", line: 2, tabletIds: ["AA-VC-000123"] },
      { sourceIndex: 0, name: "init", qualifiedName: "Executor.init", kind: "method", line: 3, tabletIds: ["AA-VC-000123"] },
      { sourceIndex: 0, name: "runaway", qualifiedName: "runaway", kind: "function", line: 4, tabletIds: ["AA-VC-000123"] },
    ],
  });
  assert.ok(context);
  const all = formatSymbolList(context);
  assert.equal(all.total, 3);
  assert.equal(all.shown, 3);
  assert.deepEqual(all.text.split("\n").map((line) => line.trim().split(/\s{2,}/)[0]), ["Executor.run", "Executor.init", "runaway"]);
  assert.match(formatSymbolList(context, "Executor.run").text, /^Executor\.run/);
  assert.equal(formatSymbolList(context, "init").shown, 1);
  assert.equal(formatSymbolList(context, "EXECUTOR").shown, 2);
  const many = activeSourceContextFromManifest({
    tablets: context.tablets,
    symbols: Array.from({ length: 105 }, (_, index) => ({ sourceIndex: 0, name: `symbol${index}`, qualifiedName: `symbol${index}`, kind: "function", line: 1, tabletIds: ["AA-VC-000123"] })),
  });
  const bounded = formatSymbolList(many);
  assert.equal(bounded.total, 105);
  assert.equal(bounded.shown, 100);
  assert.match(bounded.text, /showing 100 of 105 symbols/);
  assert.deepEqual(formatSymbolList({ ...context, symbols: [] }).text, "no symbol anchors are available in the active source context");
  assert.match(formatSymbolList(undefined).error, /no active source context/);
});

test("extracts conservative navigation symbols without confusing comments or strings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-symbols-test-"));
  const python = join(dir, "symbols.py");
  const rust = join(dir, "symbols.rs");
  const c = join(dir, "symbols.c");
  const text = join(dir, "notes.txt");
  writeFileSync(python, "@decorator\nclass Foo:\n    def bar(self):\n        def inner():\n            pass\n        return inner\n\nasync def top():\n    pass\n# def fake():\nvalue = 'class Fake:'\ndef café():\n    pass\n".replaceAll("\n", "\r\n"));
  writeFileSync(rust, "struct Foo {}\nimpl Foo {\n    fn run(&self) {}\n}\n// fn fake() {}\n/* outer /* fn hidden() {} */ still hidden */\nconst VALUE: i32 = 1;\nmacro_rules! make_it { () => {} }\nmod nested {}\n");
  writeFileSync(c, "#define MAX 4\nstruct Foo { int x; };\ntypedef int Alias;\nint run(int x) { return x; }\n// int fake(void) { return 0; }\nconst char *s = \\\"int fake() { }\\\";\nint (*fp)(int);\n");
  writeFileSync(text, "# def fake():\nclass Fake\n");
  const extracted = await extractAllSymbols([
    { path: python, displayPath: "symbols.py", language: "Python" },
    { path: rust, displayPath: "symbols.rs", language: "Rust" },
    { path: c, displayPath: "symbols.c", language: "C" },
    { path: text, displayPath: "notes.txt", language: "Text" },
  ]);
  assert.deepEqual(extracted.diagnostics, []);
  assert.deepEqual(extracted.symbols.filter((symbol) => symbol.sourceIndex === 0).map(({ name, qualifiedName, kind, line }) => ({ name, qualifiedName, kind, line })), [
    { name: "Foo", qualifiedName: "Foo", kind: "type", line: 2 },
    { name: "bar", qualifiedName: "Foo.bar", kind: "method", line: 3 },
    { name: "inner", qualifiedName: "Foo.bar.inner", kind: "function", line: 4 },
    { name: "top", qualifiedName: "top", kind: "function", line: 8 },
    { name: "café", qualifiedName: "café", kind: "function", line: 12 },
  ]);
  assert.deepEqual(extracted.symbols.filter((symbol) => symbol.sourceIndex === 1).map((symbol) => symbol.name), ["Foo", "run", "VALUE", "make_it", "nested"]);
  assert.deepEqual(extracted.symbols.filter((symbol) => symbol.sourceIndex === 2).map((symbol) => symbol.name), ["MAX", "Foo", "Alias", "run"]);
  assert.deepEqual(extracted.symbols.filter((symbol) => symbol.sourceIndex === 3), []);
  const mapped = mapSymbolsToTablets([{ sourceIndex: 0, name: "wrapped", qualifiedName: "wrapped", kind: "function", line: 184 }], [
    { id: "VC-003", spans: [{ sourceIndex: 0, startLine: 1, endLine: 184 }] },
    { id: "VC-004", spans: [{ sourceIndex: 0, startLine: 184, endLine: 250 }] },
  ]);
  assert.deepEqual(mapped[0].tabletIds, ["VC-003", "VC-004"]);
  assert.deepEqual(mapSymbolsToTablets([{ sourceIndex: 1, name: "empty", qualifiedName: "empty", kind: "function", line: 1 }], [{ id: "VC-005", spans: [{ sourceIndex: 1, startLine: null, endLine: null, bannerOnly: true }] }])[0].tabletIds, []);
});

test("symbol extraction failure is non-fatal for visual rendering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-symbols-invalid-test-"));
  const source = join(dir, "broken.py");
  writeFileSync(source, "if True\n");
  const rendered = await renderSources([{ path: source, displayPath: "broken.py", language: "Python" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "cache") });
  assert.ok(rendered.images.length >= 1);
  assert.deepEqual(rendered.manifest.symbols, []);
  assert.ok(Array.isArray(rendered.manifest.symbolDiagnostics));
});

test("project VC allocation is persistent, monotone, atomic, and cache-safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-project-state-test-"));
  const projectRoot = join(dir, "my-project");
  const cache = join(projectRoot, ".pi", "visual-context", "cache");
  const context = await loadProjectContext({ projectRoot, cacheDirectory: cache });
  const [first, second] = await Promise.all([reserveTabletIds(context, 2), reserveTabletIds(context, 3)]);
  assert.equal(new Set([...first.ids, ...second.ids]).size, 5);
  assert.deepEqual([...first.ids, ...second.ids].sort(), ["MP-VC-000001", "MP-VC-000002", "MP-VC-000003", "MP-VC-000004", "MP-VC-000005"]);
  assert.equal((await loadProjectContext({ projectRoot, cacheDirectory: cache })).state.nextTabletId, 6);
  const failed = await reserveTabletIds(context, 2);
  const afterFailure = await reserveTabletIds(context, 1);
  assert.deepEqual(failed.ids, ["MP-VC-000006", "MP-VC-000007"]);
  assert.deepEqual(afterFailure.ids, ["MP-VC-000008"]);
  mkdirSync(join(cache, "old-cache"), { recursive: true });
  mkdirSync(join(cache, "task"), { recursive: true });
  writeFileSync(join(cache, "old-cache", "ignored.txt"), "old");
  writeFileSync(join(cache, "task", "kept.txt"), "task");
  rmSync(join(projectRoot, ".pi", "visual-context", "project.json"));
  await loadProjectContext({ projectRoot, cacheDirectory: cache });
  assert.equal(existsSync(join(cache, "old-cache")), false);
  assert.equal(existsSync(join(cache, "task", "kept.txt")), true);
});

test("extension navigation returns text only and blocks a second source context before rendering", async () => {
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    appendEntry() { throw new Error("navigation should not append state"); },
  };
  const extension = (await import("../src/index.ts")).default;
  extension(pi);
  const tablets = [{ id: "AA-VC-000123", pageIndex: 0, profile: "normal", width: 1, height: 1, spans: [{ sourceIndex: 0, sourcePath: "/tmp/a.py", visualName: "a.py", startLine: 1, endLine: 4 }] }];
  const symbols = [{ sourceIndex: 0, name: "run", qualifiedName: "Executor.run", kind: "method", line: 2, tabletIds: ["AA-VC-000123"] }];
  await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "visual-context-source-context", data: { sourceCacheKey: "a", projectPrefix: "AA", tablets, tabletIndex: "AA-VC-000123 a.py:1-4", symbols } }] } });
  const statuses = [];
  const notifications = [];
  const ctx = { cwd: "/tmp", ui: { setWidget() {}, setStatus(_name, text) { statuses.push(text); }, notify(text) { notifications.push(text); } } };
  const tablet = await handlers.get("input")({ source: "interactive", text: "@v --tablet AA-VC-000123 -- Why?" }, ctx);
  assert.equal(tablet.action, "transform");
  assert.equal(tablet.images, undefined);
  assert.match(tablet.text, /AA-VC-000123 a\.py:1-4/);
  const symbol = await handlers.get("input")({ source: "interactive", text: "@v --symbol Executor.run -- Explain." }, ctx);
  assert.equal(symbol.action, "transform");
  assert.equal(symbol.images, undefined);
  assert.match(symbol.text, /Source tablets: AA-VC-000123/);
  const symbolsList = await handlers.get("input")({ source: "interactive", text: "@v --symbols" }, ctx);
  assert.equal(symbolsList.action, "handled");
  assert.equal(symbolsList.images, undefined);
  assert.match(notifications.at(-1), /Executor\.run/);
  const symbolsQuery = await handlers.get("input")({ source: "interactive", text: "@v --symbols executor" }, ctx);
  assert.equal(symbolsQuery.action, "handled");
  assert.equal(symbolsQuery.images, undefined);
  const second = await handlers.get("input")({ source: "interactive", text: "@v other.py -- question" }, ctx);
  assert.equal(second.action, "handled");
  assert.match(notifications.at(-1), /already has a source context/);
  assert.equal(statuses.includes("laying out"), false);
});

test("keeps two extension session contexts isolated and handles local navigation errors", async () => {
  const extension = (await import("../src/index.ts")).default;
  const makeSession = (id, symbolName) => {
    const handlers = new Map();
    const pi = { on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, appendEntry() {} };
    extension(pi);
    const tablets = [{ id, pageIndex: 0, profile: "normal", width: 1, height: 1, spans: [{ sourceIndex: 0, sourcePath: `/${id}.py`, visualName: `${id}.py`, startLine: 1, endLine: 4 }] }];
    const symbols = [{ sourceIndex: 0, name: symbolName, qualifiedName: `Owner.${symbolName}`, kind: "method", line: 2, tabletIds: [id] }];
    return { handlers, data: { tablets, tabletIndex: `${id} ${id}.py:1-4`, symbols } };
  };
  const a = makeSession("AA-VC-000001", "run");
  const b = makeSession("BB-VC-000001", "start");
  await a.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "visual-context-source-context", data: a.data }] } });
  await b.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
  const errors = [];
  const ctx = { cwd: "/tmp", ui: { setWidget() {}, setStatus() {}, notify(text) { errors.push(text); } } };
  const aTablet = await a.handlers.get("input")({ source: "interactive", text: "@v --tablet AA-VC-000001 -- A" }, ctx);
  assert.equal(aTablet.action, "transform");
  const bForeign = await b.handlers.get("input")({ source: "interactive", text: "@v --tablet AA-VC-000001 -- B" }, ctx);
  assert.equal(bForeign.action, "handled");
  assert.match(errors.at(-1), /no active source context/);
  const bSymbols = await b.handlers.get("input")({ source: "interactive", text: "@v --symbols run" }, ctx);
  assert.equal(bSymbols.action, "handled");
  assert.match(errors.at(-1), /no active source context/);
  const bSource = await b.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "visual-context-source-context", data: b.data }] } });
  assert.equal(bSource, undefined);
  const bTablet = await b.handlers.get("input")({ source: "interactive", text: "@v --tablet BB-VC-000001 -- B" }, ctx);
  assert.equal(bTablet.action, "transform");
  const absent = await a.handlers.get("input")({ source: "interactive", text: "@v --symbol Missing -- A" }, ctx);
  assert.equal(absent.action, "handled");
  const ambiguousData = { ...a.data, symbols: [...a.data.symbols, { ...a.data.symbols[0], qualifiedName: "Other.run" }] };
  await a.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "visual-context-source-context", data: ambiguousData }] } });
  const ambiguous = await a.handlers.get("input")({ source: "interactive", text: "@v --symbol run -- A" }, ctx);
  assert.equal(ambiguous.action, "handled");
  assert.match(errors.at(-1), /ambiguous/);
  assert.equal(aTablet.images, undefined);
  assert.equal(bTablet.images, undefined);
});

test("establishes SOURCE only after a successful assistant message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-source-lifecycle-test-"));
  const source = join(dir, "sample.py");
  writeFileSync(source, "def run():\n    return 1\n");
  const handlers = new Map();
  const appended = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    appendEntry(type, data) { appended.push({ type, data }); },
  };
  const extension = (await import("../src/index.ts")).default;
  extension(pi);
  await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
  const errors = [];
  const statuses = [];
  const ctx = { cwd: dir, ui: { setWidget() {}, setStatus(_name, text) { statuses.push(text); }, notify(text) { errors.push(text); } } };
  const initial = await handlers.get("input")({ source: "interactive", text: `@v ${source} -- Explain.` }, ctx);
  assert.equal(initial.action, "transform", errors.join("\n"));
  assert.ok(initial.images.length > 0);

  await handlers.get("message_start")({ message: { role: "user", content: initial.images } }, ctx);
  await handlers.get("message_end")({ message: { role: "user", content: initial.images } }, ctx);
  assert.equal(appended.length, 0);
  const rejected = await handlers.get("input")({ source: "interactive", text: "@v --tablet XX-VC-000001 -- Why?" }, ctx);
  assert.equal(rejected.action, "handled");
  const failedSecondSource = await handlers.get("input")({ source: "interactive", text: `@v ${source} -- retry` }, ctx);
  assert.equal(failedSecondSource.action, "handled");
  await handlers.get("agent_end")({ messages: [] }, ctx);
  const afterCleanup = await handlers.get("input")({ source: "interactive", text: "@v --tablet XX-VC-000001 -- still absent" }, ctx);
  assert.equal(afterCleanup.action, "handled");

  const replacement = join(dir, "replacement.py");
  writeFileSync(replacement, "def run():\n    return 2\n");
  const secondSource = await handlers.get("input")({ source: "interactive", text: `@v ${replacement} -- Explain.` }, ctx);
  assert.equal(secondSource.action, "transform");
  await handlers.get("message_start")({ message: { role: "user", content: secondSource.images } }, ctx);
  await handlers.get("message_end")({ message: { role: "user", content: secondSource.images } }, ctx);
  await handlers.get("message_start")({ message: { role: "assistant", content: [], stopReason: "stop" } }, ctx);
  await handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop" } }, ctx);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "visual-context-source-context");
  const tabletId = appended[0].data.tablets[0].id;
  rmSync(source);
  rmSync(replacement);
  rmSync(join(dir, ".pi", "visual-context", "cache"), { recursive: true, force: true });
  const navigation = await handlers.get("input")({ source: "interactive", text: `@v --tablet ${tabletId} -- Why?` }, ctx);
  assert.equal(navigation.action, "transform");
  assert.equal(navigation.images, undefined);
  assert.ok(!navigation.images || navigation.images.filter((item) => item.type === "image").length === 0);

  const symbol = await handlers.get("input")({ source: "interactive", text: "@v --symbol run -- Explain." }, ctx);
  assert.equal(symbol.action, "transform");
  assert.equal(symbol.images, undefined);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: symbol.text }] } }, ctx);
  await handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: symbol.text }] } }, ctx);
  assert.equal(appended.length, 1);

  const task = await handlers.get("input")({ source: "interactive", text: "@v --visual-prompt -- Summarize." }, ctx);
  assert.equal(task.action, "transform");
  assert.ok(task.images.length > 0);
  await handlers.get("message_start")({ message: { role: "user", content: task.images } }, ctx);
  await handlers.get("message_end")({ message: { role: "user", content: task.images } }, ctx);
  assert.equal(appended.length, 1);

  const statusCount = statuses.length;
  const second = await handlers.get("input")({ source: "interactive", text: "@v does-not-exist.py -- second source" }, ctx);
  assert.equal(second.action, "handled");
  assert.match(errors.at(-1), /already has a source context/);
  assert.equal(statuses.slice(statusCount).some((status) => /reading|laying out|rasterizing|encoding/i.test(status ?? "")), false);
});

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
  for (const text of [".rs", ".c", ".h", ".py", "**/*.py", "--visual-prompt", "PI_VISUAL_CONTEXT_CONFIRM_FILES", "PI_VISUAL_CONTEXT_MAX_TABLETS", "PI_VISUAL_CONTEXT_SHOW_USAGE", "PI_VISUAL_CONTEXT_CACHE", "PI_VISUAL_CONTEXT_RASTER_WORKERS"]) assert.match(VISUAL_CONTEXT_HELP, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Typst produces a PDF without a diagnostic for an unavailable glyph", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-missing-glyph-test-"));
  const source = join(dir, "missing.txt");
  const template = join(dir, "missing.typ");
  const pdf = join(dir, "missing.pdf");
  writeFileSync(source, "😀\n");
  writeFileSync(template, `#set text(font: "Romulus", fallback: true)\n#text(read("missing.txt"))\n`);
  const result = spawnSync("typst", ["compile", "--ignore-system-fonts", "--font-path", join(root, "assets/fonts/romulus"), template, pdf], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.ok(existsSync(pdf));
  assert.match(execFileSync("pdffonts", [pdf], { encoding: "utf8" }), /Romulus/);
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

test("classifies rendered glyphs from the Romulus cmap", () => {
  const charset = execFileSync("fc-query", ["--format=%{charset}", font], { encoding: "utf8" });
  const codepoints = new Set();
  for (const range of charset.trim().split(/\s+/)) {
    const [startText, endText = startText] = range.split("-");
    for (let codepoint = parseInt(startText, 16); codepoint <= parseInt(endText, 16); codepoint++) codepoints.add(codepoint);
  }
  assert.equal(classifyRenderedText("français é è à ç œ ¶ ¤ »", "latin.py", codepoints).fallbackRequired, false);
  for (const text of ["α β Δ λ", "Ж Д Я", "日本語のテスト", "😀 🚀 ✅ ⚠️ 🔒 🧪", "≠ ≤ ≥ ≈ ∞ ∑ √", "→ ← ↑ ↓ ⇒ ⇥ ␉ ␍ ␊"]) {
    assert.equal(classifyRenderedText(text, "source.py", codepoints).fallbackRequired, true, text);
  }
  assert.equal(classifyRenderedText(String.fromCharCode(9, 13, 10) + "¶ ¤ »", "source.py", codepoints).fallbackRequired, false);
  assert.equal(classifyRenderedText("ASCII", "日本.py", codepoints).fallbackRequired, true);
});

test("parses mono-file input and preserves question separator", () => {
  assert.deepEqual(parseVisualInput("@v src/foo.rs -- Explain -- this."), {
    source: "src/foo.rs", sources: ["src/foo.rs"], question: "Explain -- this.", profile: "normal", render: false, open: false, visualPrompt: false,
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
    source: "src/**/*.py", sources: ["src/**/*.py"], question: "", profile: "conservative", render: true, open: true, visualPrompt: false,
  });
  assert.equal(parseVisualInput("@v --render --profile conservative src/**/*.py -- Review this").render, true);
});

test("parses opt-in visual prompt mode without changing the question", () => {
  const parsed = parseVisualInput("@v --visual-prompt --profile conservative src/a.py -- Explain the architecture.");
  assert.equal(parsed.visualPrompt, true);
  assert.equal(parsed.question, "Explain the architecture.");
  assert.equal(parsed.profile, "conservative");
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

test("rejects malformed and unknown-profile input while accepting generic paths", () => {
  assert.throws(() => parseVisualInput("@v foo.rs"), /malformed/);
  assert.deepEqual(parseVisualInput("@v ROADMAP_fr.md -- question").sources, ["ROADMAP_fr.md"]);
  assert.throws(() => getVisualProfile("dense"), /unknown visual profile/);
});

test("parses TASK-only prompts and rejects empty ones", () => {
  assert.deepEqual(parseVisualInput("@v --visual-prompt -- long question"), {
    source: undefined, sources: [], question: "long question", profile: "normal", render: false, open: false, visualPrompt: true,
  });
  assert.deepEqual(parseVisualInput("@v --visual-prompt --render --open -- long question").sources, []);
  assert.throws(() => parseVisualInput("@v --visual-prompt --"), /non-empty prompt/);
  assert.throws(() => parseVisualInput("@v --"), /required/);
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
  assert.equal(continuous.tabletSourcesKnown, true);
  assert.deepEqual(continuous.tablets, []);
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

test("generic UTF-8 text fallback accepts text, rejects binary, and keeps specialized priority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-generic-text-test-"));
  const markdown = join(dir, "ROADMAP_fr.md");
  const noExtension = join(dir, "LICENSE");
  const unknown = join(dir, "notes.unknown");
  const unicode = join(dir, "unicode.data");
  writeFileSync(markdown, "# Étape\n\n日本語 😀\n");
  writeFileSync(noExtension, "License\r\n\tCopyright\r\n");
  writeFileSync(unknown, "key: value\rline\n");
  writeFileSync(unicode, "日本語 😀\n");
  const rendered = await renderSources([
    { path: markdown, displayPath: "ROADMAP_fr.md", language: "Text" },
    { path: noExtension, displayPath: "LICENSE", language: "Text" },
    { path: unknown, displayPath: "notes.unknown", language: "Text" },
    { path: unicode, displayPath: "unicode.data", language: "Text" },
  ], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "cache") });
  assert.ok(rendered.sourceManifests.every((item) => item.manifest.codec === "text"));
  assert.ok(rendered.manifest.renderGroups.some((group) => group.profile === "normal"));
  assert.ok(rendered.manifest.renderGroups.some((group) => group.profile === "conservative"));
  assert.deepEqual(rendered.manifest.symbols, []);
  assert.ok(rendered.manifest.tablets.some((tablet) => new Set(tablet.spans.map((span) => span.sourceIndex)).size >= 2));
  const specialized = await renderSources([{ path: join(root, "tests/fixtures/sample.py"), displayPath: "sample.py", language: "Python" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "specialized-cache") });
  assert.equal(specialized.sourceManifests[0].manifest.codec, "python");
  const lf = join(dir, "lf.txt");
  const crlf = join(dir, "crlf.txt");
  writeFileSync(lf, "one\ntwo\tthree\n");
  writeFileSync(crlf, "one\r\ntwo\tthree\r\n");
  const lfRender = await renderSources([{ path: lf, displayPath: "same.txt", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "lf-cache") });
  const crlfRender = await renderSources([{ path: crlf, displayPath: "same.txt", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "crlf-cache") });
  const stripHeader = (image) => execFileSync("magick", ["png:-", "-crop", "1056x960+0+20", "+repage", "png:-"], { input: image });
  assert.deepEqual(stripHeader(crlfRender.images[0]), stripHeader(lfRender.images[0]));
  const binary = join(dir, "binary.bin");
  writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(() => renderSources([{ path: binary, displayPath: "binary.bin", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "binary-cache") }), /text\/binary input/);
  const invalid = join(dir, "invalid.bin");
  writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
  await assert.rejects(() => renderSources([{ path: invalid, displayPath: "invalid.bin", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "invalid-cache") }), /requires UTF-8/);
  const longLine = join(dir, "long-line.txt");
  writeFileSync(longLine, `${"long-content ".repeat(4000)}\n`);
  const longRender = await renderSources([{ path: longLine, displayPath: "long-line.txt", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "long-line-cache") });
  assert.ok(longRender.manifest.pageCount > 1);
  assert.ok(longRender.manifest.tablets.every((tablet) => tablet.spans.some((span) => span.startLine === 1 && span.endLine === 1)));
  const longIds = longRender.manifest.tablets.map((tablet) => tablet.id);
  writeFileSync(longLine, `${"changed-content ".repeat(4000)}\n`);
  const changedLong = await renderSources([{ path: longLine, displayPath: "long-line.txt", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "long-line-cache") });
  assert.equal(changedLong.manifest.cache.hit, false);
  assert.equal(longIds.some((id) => changedLong.manifest.tablets.some((tablet) => tablet.id === id)), false);
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "");
  const emptyRender = await renderSources([{ path: empty, displayPath: "empty.txt", language: "Text" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "empty-cache") });
  assert.ok(emptyRender.manifest.tablets.some((tablet) => tablet.spans.some((span) => span.bannerOnly && span.startLine === null && span.endLine === null)));
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

test("Unicode fixture retains fallback text and real line controls", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-unicode-codec-test-"));
  const source = join(root, "tests/fixtures/unicode.py");
  const output = join(dir, "unicode.txt");
  execFileSync(pythonHelper, [source, output, font]);
  const encoded = readFileSync(output, "utf8").replaceAll("\u200b", "");
  assert.match(encoded, /français/);
  assert.match(encoded, /日本語のテスト/);
  assert.match(encoded, /😀 🚀 ✅/);
  assert.match(encoded, /≠ ≤ ≥/);
  assert.equal(encoded.includes("\r"), false);
  assert.equal(encoded.includes("\n"), false);
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
  await assert.rejects(() => renderSources([{ path: source, displayPath: "small.py", language: "Python" }], (status) => statuses.push(status), getVisualProfile("normal"), { cacheDirectory: join(dir, "cache"), beforeRasterize: async () => false }), RenderCancelled);
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
  const cacheDirectory = join(dir, "cache");
  const rendered = await renderSources([
    { path: first, displayPath: "first.py", language: "Python" },
    { path: second, displayPath: "second.c", language: "C" },
  ], (status) => statuses.push(status), getVisualProfile("normal"), { cacheDirectory });
  assert.equal(rendered.manifest.language, "Mixed");
  assert.equal(rendered.sourceManifests.length, 2);
  assert.equal(rendered.manifest.pageCount, rendered.images.length);
  const mixedSpans = rendered.manifest.tablets.flatMap((tablet) => tablet.spans);
  assert.ok(mixedSpans.some((span) => span.sourceIndex === 0 && span.startLine === 1 && span.endLine === 2));
  assert.ok(mixedSpans.some((span) => span.sourceIndex === 1 && span.startLine === 1 && span.endLine === 1));
  assert.deepEqual(rendered.manifest.symbols.map((symbol) => [symbol.name, symbol.sourceIndex, symbol.line]), [["first", 0, 1], ["second", 1, 1]]);
  const requestManifest = buildContinuousRequestManifest(rendered.sourceManifests, ["page-001.png"], rendered.manifest, {});
  assert.deepEqual(requestManifest.symbols, rendered.manifest.symbols);
  assert.ok(statuses.some((status) => status.startsWith("laying out 2 files")));
  assert.ok(statuses.some((status) => status.startsWith("rasterizing 1/")));
  const preview = await renderSources([
    { path: first, displayPath: "first.py", language: "Python" },
    { path: second, displayPath: "second.c", language: "C" },
  ], () => {}, getVisualProfile("normal"), { cacheDirectory });
  assert.deepEqual(preview.images, rendered.images);
});

test("mixed Unicode sources render normal before conservative groups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-unicode-groups-test-"));
  const ascii = join(dir, "ascii.py");
  const latin = join(dir, "latin.py");
  const japanese = join(dir, "japanese.py");
  writeFileSync(ascii, "message = 'plain ASCII'\n");
  writeFileSync(latin, "message = 'français é è à ç œ'\n");
  writeFileSync(japanese, "message = '日本語のテスト 😀 🚀'\n");
  const inputs = [
    { path: ascii, displayPath: "ascii.py", language: "Python" },
    { path: latin, displayPath: "latin.py", language: "Python" },
    { path: japanese, displayPath: "japanese.py", language: "Python" },
  ];
  const first = await renderSources(inputs, () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "cache") });
  assert.equal(first.manifest.requestedProfile, "normal");
  assert.deepEqual(first.manifest.renderGroups.map((group) => [group.profile, group.reason, group.sources]), [
    ["normal", "romulus-compatible", ["ascii.py", "latin.py"]],
    ["conservative", "font-fallback", ["japanese.py"]],
  ]);
  assert.equal(first.manifest.renderGroups[0].pageCount >= 1, true);
  assert.equal(first.manifest.renderGroups[1].pageCount >= 1, true);
  assert.equal(first.manifest.renderGroups[0].profile, "normal");
  assert.equal(first.manifest.renderGroups[1].profile, "conservative");
  assert.equal(first.manifest.tablets.length, first.manifest.pageCount);
  assert.ok(first.manifest.tablets.every((tablet) => /^[A-Z0-9]{1,4}-VC-\d{6}$/.test(tablet.id)));
  assert.equal(new Set(first.manifest.tablets.map((tablet) => tablet.id)).size, first.manifest.tablets.length);
  assert.ok(first.manifest.tablets.every((tablet) => tablet.spans.every((span) => span.startLine === null || (span.startLine >= 1 && span.endLine >= span.startLine))));
  assert.ok(first.manifest.tablets.some((tablet) => tablet.spans.some((span) => span.sourceIndex === 0)));
  assert.ok(first.manifest.tablets.some((tablet) => tablet.spans.some((span) => span.sourceIndex === 2)));
  const normalTabletCount = first.manifest.renderGroups[0].pageCount;
  assert.ok(first.manifest.tablets.slice(0, normalTabletCount).every((tablet) => tablet.profile === "normal"));
  assert.ok(first.manifest.tablets.slice(normalTabletCount).every((tablet) => tablet.profile === "conservative"));
  assert.ok(first.manifest.renderGroups.every((group) => Array.isArray(group.fontsUsed)));
  assert.ok(first.manifest.renderGroups.every((group) => group.fontsUsed.includes("Romulus")));
  assert.deepEqual(first.manifest.fontsUsed, [...new Set(first.manifest.fontsUsed)].sort((a, b) => a.localeCompare(b)));
  for (const [index, dimensions] of first.manifest.pageDimensions.entries()) {
    const imagePath = join(dir, `group-${index}.png`);
    writeFileSync(imagePath, first.images[index]);
    const geometry = `${dimensions.width}x3+0+${dimensions.height - 3}`;
    const mean = execFileSync("magick", [imagePath, "-crop", geometry, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"], { encoding: "utf8" });
    assert.ok(Number(mean) > 0.999, `page ${index + 1} has non-white pixels in its bottom safety margin`);
  }
  const second = await renderSources(inputs, () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "cache") });
  assert.equal(second.manifest.cache.hit, true);
  assert.deepEqual(second.manifest.fontsUsed, first.manifest.fontsUsed);
  assert.deepEqual(second.manifest.renderGroups.map((group) => group.fontsUsed), first.manifest.renderGroups.map((group) => group.fontsUsed));
  assert.deepEqual(second.manifest.tablets, first.manifest.tablets);
  assert.deepEqual(second.images, first.images);
  const conservative = await renderSources(inputs, () => {}, getVisualProfile("conservative"), { cacheDirectory: join(dir, "conservative-cache") });
  assert.equal(conservative.manifest.renderGroups.length, 1);
  assert.equal(conservative.manifest.renderGroups[0].profile, "conservative");
  assert.equal(conservative.manifest.renderGroups[0].reason, "explicit-profile");
});

test("final PNG cache hits without invoking layout or rasterization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-cache-test-"));
  const cache = join(dir, "cache");
  const source = join(dir, "cache.py");
  writeFileSync(source, "value = 1\n");
  const input = [{ path: source, displayPath: "cache.py", language: "Python" }];
  const firstStatuses = [];
  const first = await renderSources(input, (status) => firstStatuses.push(status), getVisualProfile("normal"), { cacheDirectory: cache });
  assert.equal(first.manifest.cache.hit, false);
  assert.deepEqual(first.manifest.fontsUsed, ["Romulus"]);
  assert.ok(first.manifest.timingsMs.compact >= 0);
  assert.ok(first.manifest.timingsMs.typst >= 0);
  assert.ok(first.manifest.timingsMs.pdfinfo >= 0);
  assert.ok(first.manifest.timingsMs.rasterAndPostprocess >= 0);
  assert.ok(first.manifest.timingsMs.workers >= 1);
  assert.ok(first.manifest.timingsMs.total >= 0);
  assert.ok(firstStatuses.some((status) => status.startsWith("laying out")));
  const secondStatuses = [];
  const second = await renderSources(input, (status) => secondStatuses.push(status), getVisualProfile("normal"), { cacheDirectory: cache });
  assert.equal(second.manifest.cache.hit, true);
  assert.deepEqual(second.images, first.images);
  assert.deepEqual(second.manifest.symbols, first.manifest.symbols);
  assert.ok(secondStatuses.includes(`cache hit · ${first.images.length} tablets`));
  assert.equal(secondStatuses.some((status) => status.startsWith("laying out")), false);
  assert.equal(secondStatuses.some((status) => status.startsWith("rasterizing")), false);
  assert.ok(second.manifest.timingsMs.cacheLookup >= 0);
  await assert.rejects(() => renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory: cache, onCacheHit: async () => false }), RenderCancelled);

  const key = first.manifest.cache.key;
  rmSync(join(cache, key, "page-001.png"));
  const repaired = await renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory: cache });
  assert.equal(repaired.manifest.cache.hit, false);
  assert.notDeepEqual(repaired.images, first.images);
  assert.notDeepEqual(repaired.manifest.tablets.map((tablet) => tablet.id), first.manifest.tablets.map((tablet) => tablet.id));
  writeFileSync(source, "value = 2\n");
  const changed = await renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory: cache });
  assert.equal(changed.manifest.cache.hit, false);

  writeFileSync(join(cache, changed.manifest.cache.key, "cache-manifest.json"), "not json");
  const regenerated = await renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory: cache });
  assert.equal(regenerated.manifest.cache.hit, false);
  assert.ok(existsSync(join(cache, regenerated.manifest.cache.key, "cache-manifest.json")));
});

test("cache identity includes order, visual names, and profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-cache-identity-test-"));
  const cache = join(dir, "cache");
  const a = join(dir, "a.py");
  const b = join(dir, "b.py");
  writeFileSync(a, "a = 1\n");
  writeFileSync(b, "b = 2\n");
  const render = (inputs, profile = "normal") => renderSources(inputs, () => {}, getVisualProfile(profile), { cacheDirectory: cache });
  const one = await render([{ path: a, displayPath: "a.py", language: "Python" }, { path: b, displayPath: "b.py", language: "Python" }]);
  const reordered = await render([{ path: b, displayPath: "b.py", language: "Python" }, { path: a, displayPath: "a.py", language: "Python" }]);
  const renamed = await render([{ path: a, displayPath: "renamed.py", language: "Python" }, { path: b, displayPath: "b.py", language: "Python" }]);
  const conservative = await render([{ path: a, displayPath: "a.py", language: "Python" }, { path: b, displayPath: "b.py", language: "Python" }], "conservative");
  assert.equal(one.manifest.cache.hit, false);
  assert.equal(reordered.manifest.cache.hit, false);
  assert.equal(renamed.manifest.cache.hit, false);
  assert.equal(conservative.manifest.cache.hit, false);
  const hit = await render([{ path: a, displayPath: "a.py", language: "Python" }, { path: b, displayPath: "b.py", language: "Python" }]);
  assert.equal(hit.manifest.cache.hit, true);
});

test("persistent VC IDs version complete source snapshots and restore cached history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-persistent-vc-test-"));
  const projectRoot = join(dir, "project");
  const cacheDirectory = join(projectRoot, ".pi", "visual-context", "cache");
  mkdirSync(projectRoot, { recursive: true });
  const a = join(projectRoot, "a.py");
  const b = join(projectRoot, "b.py");
  writeFileSync(a, "a = 1\n");
  writeFileSync(b, "b = 1\n");
  const inputs = [{ path: a, displayPath: "a.py", language: "Python" }, { path: b, displayPath: "b.py", language: "Python" }];
  const render = () => renderSources(inputs, () => {}, getVisualProfile("normal"), { cacheDirectory, projectRoot });
  const snapshotA = await render();
  const idsA = snapshotA.manifest.tablets.map((tablet) => tablet.id);
  const hitA = await render();
  assert.equal(hitA.manifest.cache.hit, true);
  assert.deepEqual(hitA.manifest.tablets.map((tablet) => tablet.id), idsA);
  writeFileSync(a, "a = 2\n");
  const snapshotB = await render();
  const idsB = snapshotB.manifest.tablets.map((tablet) => tablet.id);
  assert.equal(snapshotB.manifest.cache.hit, false);
  assert.equal(idsA.some((id) => idsB.includes(id)), false);
  writeFileSync(a, "a = 1\n");
  const restoredA = await render();
  assert.equal(restoredA.manifest.cache.hit, true);
  assert.deepEqual(restoredA.manifest.tablets.map((tablet) => tablet.id), idsA);
  const statePath = join(projectRoot, ".pi", "visual-context", "project.json");
  rmSync(statePath);
  const recoveredA = await render();
  assert.equal(recoveredA.manifest.cache.hit, true);
  assert.deepEqual(recoveredA.manifest.tablets.map((tablet) => tablet.id), idsA);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).nextTabletId, Math.max(...idsB.map((id) => Number(id.match(/(\d+)$/)[1]))) + 1);
  const previousCache = process.env.PI_VISUAL_CONTEXT_CACHE;
  process.env.PI_VISUAL_CONTEXT_CACHE = "0";
  try {
    const disabledOne = await render();
    const disabledTwo = await render();
    assert.equal(disabledOne.manifest.cache.hit, false);
    assert.equal(disabledTwo.manifest.cache.hit, false);
    assert.equal(new Set([...idsA, ...idsB, ...disabledOne.manifest.tablets.map((tablet) => tablet.id), ...disabledTwo.manifest.tablets.map((tablet) => tablet.id)]).size, idsA.length + idsB.length + disabledOne.manifest.tablets.length + disabledTwo.manifest.tablets.length);
  } finally {
    if (previousCache === undefined) delete process.env.PI_VISUAL_CONTEXT_CACHE;
    else process.env.PI_VISUAL_CONTEXT_CACHE = previousCache;
  }
  writeFileSync(a, "a = 3\n");
  const previousWorkers = process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
  process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = "0";
  try {
    await assert.rejects(() => render(), /integer >= 1/);
  } finally {
    if (previousWorkers === undefined) delete process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
    else process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = previousWorkers;
  }
  const afterFailure = await render();
  const failedSeriesId = Number(afterFailure.manifest.tablets[0].id.match(/(\d+)$/)[1]);
  const previousSeriesId = Number(idsA[0].match(/(\d+)$/)[1]);
  assert.ok(failedSeriesId > previousSeriesId + 1);
});

test("Git provenance handles clean, dirty, detached, outside, and multiple repositories", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-visual-git-test-"));
  const source = join(repo, "source.py");
  writeFileSync(source, "value = 1\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Visual Context Test"], { cwd: repo });
  execFileSync("git", ["add", "source.py"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  const clean = await collectGitProvenance([source, source]);
  assert.equal(clean.provenance.repositories.length, 1);
  assert.equal(clean.repositoryIds[0], 0);
  assert.equal(clean.repositoryIds[1], 0);
  assert.equal(clean.provenance.repositories[0].root, repo);
  assert.match(clean.provenance.repositories[0].head, /^[0-9a-f]{40}$/);
  assert.ok(clean.provenance.repositories[0].branch);
  assert.equal(clean.provenance.repositories[0].dirty, false);
  writeFileSync(join(repo, "untracked.py"), "value = 2\n");
  const dirty = await collectGitProvenance([source]);
  assert.equal(dirty.provenance.repositories[0].dirty, true);
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: repo });
  const detached = await collectGitProvenance([source]);
  assert.equal(detached.provenance.repositories[0].head, clean.provenance.repositories[0].head);
  assert.equal(detached.provenance.repositories[0].branch, null);
  const outside = await collectGitProvenance([join(tmpdir(), "not-a-source.py")]);
  assert.deepEqual(outside, { provenance: { repositories: [] }, repositoryIds: [null] });
  const repo2 = mkdtempSync(join(tmpdir(), "pi-visual-git-test-2-"));
  const source2 = join(repo2, "other.py");
  writeFileSync(source2, "value = 3\n");
  execFileSync("git", ["init", "-q"], { cwd: repo2 });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo2 });
  execFileSync("git", ["config", "user.name", "Visual Context Test"], { cwd: repo2 });
  execFileSync("git", ["add", "other.py"], { cwd: repo2 });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo2 });
  const multiple = await collectGitProvenance([source, source2]);
  assert.equal(multiple.provenance.repositories.length, 2);
  assert.deepEqual(multiple.repositoryIds, [0, 1]);
});

test("Git metadata changes do not invalidate the render cache", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-visual-git-cache-test-"));
  const source = join(repo, "source.py");
  writeFileSync(source, "value = 1\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Visual Context Test"], { cwd: repo });
  execFileSync("git", ["add", "source.py"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  const cacheDirectory = mkdtempSync(join(tmpdir(), "pi-visual-git-cache-entries-"));
  const input = [{ path: source, displayPath: "source.py", language: "Python" }];
  const first = await renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory });
  assert.equal(first.manifest.cache.hit, false);
  assert.equal(first.manifest.git.repositories[0].dirty, false);
  writeFileSync(join(repo, "untracked.py"), "unrelated = true\n");
  const second = await renderSources(input, () => {}, getVisualProfile("normal"), { cacheDirectory });
  assert.equal(second.manifest.cache.hit, true);
  assert.equal(second.manifest.cache.key, first.manifest.cache.key);
  assert.equal(second.manifest.git.repositories[0].dirty, true);
  assert.deepEqual(second.images, first.images);
});

test("visual task renderer paginates, caches, and preserves Unicode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-task-test-"));
  const cache = join(dir, "task-cache");
  const short = "Explain français 日本語 😀 and the source invariants.";
  const first = await renderTask(short, () => {}, { cacheDirectory: cache });
  assert.equal(first.manifest.cache.hit, false);
  assert.equal(first.manifest.pageCount, 1);
  assert.equal(first.manifest.bytes, Buffer.byteLength(short));
  assert.ok(first.manifest.fontsUsed.includes("Romulus"));
  assert.deepEqual(first.manifest.fontsUsed, [...new Set(first.manifest.fontsUsed)].sort((a, b) => a.localeCompare(b)));
  assert.ok(first.manifest.timingsMs.layout >= 0);
  const hit = await renderTask(short, () => {}, { cacheDirectory: cache });
  assert.equal(hit.manifest.cache.hit, true);
  assert.deepEqual(hit.manifest.fontsUsed, first.manifest.fontsUsed);
  assert.deepEqual(hit.images, first.images);
  await assert.rejects(() => renderTask(short, () => {}, { cacheDirectory: cache, onCacheHit: async () => false }), RenderCancelled);
  const previousCache = process.env.PI_VISUAL_CONTEXT_CACHE;
  process.env.PI_VISUAL_CONTEXT_CACHE = "0";
  const disabled = await renderTask(short, () => {}, { cacheDirectory: join(dir, "disabled-cache") });
  const disabledAgain = await renderTask(short, () => {}, { cacheDirectory: join(dir, "disabled-cache") });
  if (previousCache === undefined) delete process.env.PI_VISUAL_CONTEXT_CACHE;
  else process.env.PI_VISUAL_CONTEXT_CACHE = previousCache;
  assert.equal(disabled.manifest.cache.hit, false);
  assert.equal(disabledAgain.manifest.cache.hit, false);
  rmSync(join(cache, first.manifest.cache.key, "task-001.png"));
  const repaired = await renderTask(short, () => {}, { cacheDirectory: cache });
  assert.equal(repaired.manifest.cache.hit, false);
  const long = Array.from({ length: 160 }, (_, index) => `${index + 1}. Explain the invariant and the relationship between module ${index}.`).join("\n");
  const paged = await renderTask(long, () => {}, { cacheDirectory: join(dir, "long-cache") });
  assert.ok(paged.manifest.pageCount > 1);
  await assert.rejects(() => renderTask(long, () => {}, { cacheDirectory: join(dir, "declined-cache"), beforeRasterize: async () => false }), RenderCancelled);
  const previousWorkers = process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
  try {
    process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = "1";
    const one = await renderTask(long, () => {}, { cacheDirectory: join(dir, "workers-1") });
    process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = "4";
    const four = await renderTask(long, () => {}, { cacheDirectory: join(dir, "workers-4") });
    assert.deepEqual(four.images, one.images);
  } finally {
    if (previousWorkers === undefined) delete process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
    else process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = previousWorkers;
  }
});

test("visual task manifest keeps task pages before source pages and supports TASK-only", async () => {
  const task = { pages: ["task-001.png", "task-002.png"] };
  const source = { pages: ["source-001.png", "source-002.png"] };
  assert.deepEqual([...task.pages, ...source.pages], ["task-001.png", "task-002.png", "source-001.png", "source-002.png"]);
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-task-only-manifest-"));
  const result = await renderTask("A long task-only prompt.", () => {}, { cacheDirectory: join(dir, "cache") });
  const manifest = buildVisualPromptRequestManifest(result.manifest, ["task-001.png"], null, [], [], {});
  assert.equal(manifest.source, null);
  assert.equal(manifest.totalTablets, result.manifest.pageCount);
  assert.equal(manifest.pageCount, result.manifest.pageCount);
  const sourceManifest = buildVisualPromptRequestManifest(result.manifest, ["task-001.png"], { tablets: [{ id: "VC-001", pageIndex: 1, profile: "normal", width: 1, height: 1, spans: [{ sourceIndex: 0, sourcePath: "/tmp/a.py", visualName: "a.py", startLine: 1, endLine: 2 }] }], symbols: [{ sourceIndex: 0, name: "a", qualifiedName: "a", kind: "function", line: 1, tabletIds: ["VC-001"] }] }, [], ["source-001.png"], {});
  assert.equal(sourceManifest.source.tabletIndex, "VC-001 a.py:1-2");
  assert.equal(sourceManifest.source.symbols[0].qualifiedName, "a");
});

test("raster worker policy is bounded and page mapping preserves order", async () => {
  assert.ok(rasterWorkerCount(2, {}) >= 1 && rasterWorkerCount(2, {}) <= 2);
  assert.equal(rasterWorkerCount(18, { PI_VISUAL_CONTEXT_RASTER_WORKERS: "1" }), 1);
  assert.ok(rasterWorkerCount(18, { PI_VISUAL_CONTEXT_RASTER_WORKERS: "4" }) >= 1 && rasterWorkerCount(18, { PI_VISUAL_CONTEXT_RASTER_WORKERS: "4" }) <= 4);
  assert.throws(() => rasterWorkerCount(18, { PI_VISUAL_CONTEXT_RASTER_WORKERS: "0" }), /integer >= 1/);
  assert.throws(() => rasterWorkerCount(18, { PI_VISUAL_CONTEXT_RASTER_WORKERS: "nope" }), /integer >= 1/);
  const progress = [];
  const pages = await mapPages(4, 4, async (page) => {
    await new Promise((resolve) => setTimeout(resolve, (3 - page) * 2));
    return `page-${page + 1}`;
  }, (completed) => progress.push(completed));
  assert.deepEqual(pages, ["page-1", "page-2", "page-3", "page-4"]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  await assert.rejects(() => mapPages(4, 4, async (page) => { if (page === 2) throw new Error("page failed"); return page; }), /page failed/);
});

test("source provenance is deterministic across raster worker counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visual-provenance-workers-test-"));
  const source = join(dir, "source.py");
  writeFileSync(source, Array.from({ length: 80 }, (_, index) => `value_${index} = ${index}`).join("\n") + "\n");
  const previous = process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
  try {
    process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = "1";
    const one = await renderSources([{ path: source, displayPath: "source.py", language: "Python" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "one") });
    process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = "4";
    const four = await renderSources([{ path: source, displayPath: "source.py", language: "Python" }], () => {}, getVisualProfile("normal"), { cacheDirectory: join(dir, "four") });
    const stripHeader = (image) => execFileSync("magick", ["png:-", "-crop", "1056x960+0+20", "+repage", "png:-"], { input: image });
    assert.deepEqual(stripHeader(four.images[0]), stripHeader(one.images[0]));
    assert.deepEqual(four.manifest.tablets.map(({ id, ...tablet }) => tablet), one.manifest.tablets.map(({ id, ...tablet }) => tablet));
  } finally {
    if (previous === undefined) delete process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS;
    else process.env.PI_VISUAL_CONTEXT_RASTER_WORKERS = previous;
  }
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
