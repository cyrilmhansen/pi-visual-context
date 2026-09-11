import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { prepareSourceContext } from "./core.ts";
import { readSourceContextSnapshot, validateSourceContextSnapshot, type SourceContextArtifact, type SourceContextSnapshotV1 } from "./source-context.ts";
import { resolveSnapshotSymbol, resolveSnapshotTablet, searchSnapshotSymbols } from "./navigation.ts";

export type CliIO = { stdout: (text: string) => void; stderr: (text: string) => void };
class CliError extends Error {}
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_SYMBOL_LIMIT = 100;

function valueAfter(args: string[], option: string): string {
  const index = args.indexOf(option);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new CliError(`${option} requires a value`);
  return value;
}
function positional(args: string[], options: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (options.includes(args[index])) index++;
    else if (args[index].startsWith("--")) throw new CliError(`unknown option: ${args[index]}`);
    else values.push(args[index]);
  }
  return values;
}
function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function sourceFor(snapshot: SourceContextSnapshotV1, sourceIndex: number) {
  const source = snapshot.sources[sourceIndex];
  if (!source) throw new CliError(`snapshot references unknown sourceIndex ${sourceIndex}`);
  return source;
}
function artifactFor(snapshot: SourceContextSnapshotV1, artifactId: string): SourceContextArtifact {
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) throw new CliError(`snapshot references unknown artifact ${artifactId}`);
  return artifact;
}
function resolvedSymbolJson(snapshot: SourceContextSnapshotV1, query: string) {
  const result = resolveSnapshotSymbol(snapshot, query);
  if (result.error === "not-found") throw new CliError(`symbol not found: ${query}`);
  if (result.error === "ambiguous") throw new CliError(`symbol is ambiguous: ${query}\n${result.candidates!.map((symbol) => `${symbol.qualifiedName} (${sourceFor(snapshot, symbol.sourceIndex).displayPath}:${symbol.line})`).join("\n")}`);
  const resolved = result.resolved!;
  return { symbol: resolved.symbol, source: resolved.source, tablets: resolved.tablets, artifacts: resolved.artifacts };
}
function resolvedTabletJson(snapshot: SourceContextSnapshotV1, id: string) {
  const resolved = resolveSnapshotTablet(snapshot, id);
  if (!resolved) throw new CliError(`tablet not found: ${id}`);
  return { tablet: resolved.tablet, sources: resolved.sources, artifacts: resolved.artifacts };
}

async function ensureAbsent(path: string): Promise<void> {
  try { await access(path); throw new CliError(`output already exists: ${path}`); } catch (error) { if (error instanceof CliError) throw error; }
}
async function materializeBundle(output: string, snapshot: SourceContextSnapshotV1, payloads: { artifactId: string; data: Buffer }[]): Promise<SourceContextSnapshotV1> {
  const target = resolve(output);
  await ensureAbsent(target);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(resolve(parent, `.pvc-bundle-${process.pid}-`));
  try {
    const byId = new Map(payloads.map((payload) => [payload.artifactId, payload]));
    for (const payload of payloads) {
      const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === payload.artifactId);
      if (!artifact || artifact.mediaType !== "image/png" || !HASH.test(artifact.sha256) || sha256(payload.data) !== artifact.sha256 || (artifact.byteLength !== undefined && artifact.byteLength !== payload.data.byteLength)) throw new CliError(`artifact payload mismatch: ${payload.artifactId}`);
    }
    const artifacts = snapshot.artifacts.map((artifact) => {
      const payload = byId.get(artifact.artifactId);
      if (!payload || artifact.mediaType !== "image/png" || !HASH.test(artifact.sha256) || sha256(payload.data) !== artifact.sha256 || (artifact.byteLength !== undefined && artifact.byteLength !== payload.data.byteLength)) throw new CliError(`artifact payload mismatch: ${artifact.artifactId}`);
      return { ...artifact, relativePath: `artifacts/${artifact.artifactId}.png` };
    });
    const finalSnapshot = { ...snapshot, artifacts };
    validateSourceContextSnapshot(finalSnapshot);
    await mkdir(resolve(temporary, "artifacts"), { recursive: true });
    const written = new Set<string>();
    for (const artifact of artifacts) {
      if (written.has(artifact.artifactId)) continue;
      written.add(artifact.artifactId);
      await writeFile(resolve(temporary, artifact.relativePath!), byId.get(artifact.artifactId)!.data);
    }
    await writeFile(resolve(temporary, "snapshot.json"), json(finalSnapshot), "utf8");
    const persisted = await readSourceContextSnapshot(resolve(temporary, "snapshot.json"));
    await rename(temporary, target);
    return persisted;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function prepare(args: string[], io: CliIO): Promise<SourceContextSnapshotV1> {
  const cwd = resolve(valueAfter(args, "--cwd"));
  const output = valueAfter(args, "--output");
  const workRoot = args.includes("--work-root") ? resolve(cwd, valueAfter(args, "--work-root")) : undefined;
  const stateRoot = args.includes("--state-root") ? resolve(cwd, valueAfter(args, "--state-root")) : undefined;
  const profile = args.includes("--profile") ? valueAfter(args, "--profile") : "normal";
  if (!["normal", "conservative"].includes(profile)) throw new CliError(`unknown profile: ${profile}`);
  const sources = positional(args, ["--cwd", "--output", "--work-root", "--state-root", "--profile"]);
  if (!sources.length) throw new CliError("prepare requires at least one source");
  await ensureAbsent(output);
  const result = await prepareSourceContext({ cwd, sources, profile, workRoot, stateRoot, onProgress: (text) => io.stderr(`${text}\n`), confirmSources: async () => true });
  if (!result) throw new CliError("source preparation cancelled");
  const snapshot = await materializeBundle(output, result.snapshot, result.artifactPayloads);
  return snapshot;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (command === "probe") io.stdout(json({ schema: "pi-visual-context-probe/1", status: "ok" }));
    else if (command === "prepare") io.stdout(json(await prepare(args, io)));
    else if (command === "resolve-tablet") {
      const snapshot = await readSourceContextSnapshot(valueAfter(args, "--snapshot"));
      const id = positional(args, ["--snapshot"])[0];
      if (!id) throw new CliError("resolve-tablet requires a VC ID");
      io.stdout(json(resolvedTabletJson(snapshot, id)));
    } else if (command === "resolve-symbol") {
      const snapshot = await readSourceContextSnapshot(valueAfter(args, "--snapshot"));
      const query = positional(args, ["--snapshot"])[0];
      if (!query) throw new CliError("resolve-symbol requires a symbol query");
      io.stdout(json(resolvedSymbolJson(snapshot, query)));
    } else if (command === "symbols") {
      const snapshot = await readSourceContextSnapshot(valueAfter(args, "--snapshot"));
      const query = positional(args, ["--snapshot"])[0];
      const result = searchSnapshotSymbols(snapshot, query, DEFAULT_SYMBOL_LIMIT);
      io.stdout(json({ query: query ?? null, ...result }));
    } else throw new CliError("usage: pvc probe|prepare|resolve-tablet|resolve-symbol|symbols");
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
