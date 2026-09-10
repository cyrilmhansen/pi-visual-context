import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, posix } from "node:path";
import type { RenderManifest, RenderInput } from "./render-types.ts";
import type { SymbolAnchor, SymbolDiagnostic } from "./symbols.ts";

export type SourceSymbolExtraction = {
  support: "unsupported" | "best-effort";
  status?: "success" | "partial" | "failed";
  extractorVersion?: string;
};

export type SourceContextSource = {
  sourceIndex: number;
  displayPath: string;
  language: RenderInput["language"];
  contentSha256: string;
  byteLength?: number;
  codec?: string;
  symbolExtraction: SourceSymbolExtraction;
};

export type SourceContextSpan = {
  sourceIndex: number;
  startLine: number | null;
  endLine: number | null;
  bannerOnly?: boolean;
};

export type SourceContextArtifact = {
  artifactId: string;
  mediaType: string;
  sha256: string;
  byteLength?: number;
  relativePath?: string;
};

export type SourceContextTablet = {
  id: string;
  pageIndex: number;
  profile: string;
  width: number;
  height: number;
  spans: SourceContextSpan[];
  artifactId: string;
};

export type SourceContextSymbol = Pick<SymbolAnchor, "sourceIndex" | "name" | "qualifiedName" | "kind" | "line" | "tabletIds">;
export type SourceContextSymbolDiagnostic = SymbolDiagnostic;
export type SourceContextCapabilities = { lineProvenance: "complete"; symbolExtraction: "per-source" };
export type SourceContextMetrics = Pick<RenderManifest, "sourceBytes" | "sourceChars" | "encodedChars" | "removedChars" | "reductionPercent">;

export type SourceContextSnapshotV1 = {
  schemaVersion: 1;
  snapshotId: string;
  project?: { projectPrefix: string };
  sources: SourceContextSource[];
  tablets: SourceContextTablet[];
  symbols: SourceContextSymbol[];
  symbolDiagnostics?: SourceContextSymbolDiagnostic[];
  artifacts: SourceContextArtifact[];
  capabilities: SourceContextCapabilities;
  metrics?: SourceContextMetrics;
};

export type SourceContextArtifactPayload = { artifactId: string; data: Buffer };
export type SourceContextResult = { snapshot: SourceContextSnapshotV1; artifacts: SourceContextArtifactPayload[] };
export type SourceContextSourceInput = { input: RenderInput; contentSha256: string; byteLength: number; codec?: string };

const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^scs1-[a-f0-9]{64}$/;

function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function portablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(value) || posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw new Error(`source displayPath must be relative: ${value}`);
  return normalize(normalized).replaceAll("\\", "/");
}
function artifactId(hash: string): string { return `artifact-sha256-${hash}`; }

function identityProjection(snapshot: Omit<SourceContextSnapshotV1, "snapshotId">) {
  return {
    schemaVersion: snapshot.schemaVersion,
    sources: snapshot.sources.map((source) => ({ sourceIndex: source.sourceIndex, displayPath: source.displayPath, language: source.language, contentSha256: source.contentSha256, codec: source.codec, symbolExtraction: source.symbolExtraction })),
    tablets: snapshot.tablets.map((tablet) => ({ id: tablet.id, pageIndex: tablet.pageIndex, profile: tablet.profile, width: tablet.width, height: tablet.height, spans: tablet.spans.map((span) => ({ sourceIndex: span.sourceIndex, startLine: span.startLine, endLine: span.endLine, bannerOnly: span.bannerOnly })), artifactId: tablet.artifactId })),
    symbols: snapshot.symbols.map((symbol) => ({ sourceIndex: symbol.sourceIndex, name: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind, line: symbol.line, tabletIds: symbol.tabletIds })),
    symbolDiagnostics: snapshot.symbolDiagnostics,
    artifacts: snapshot.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, mediaType: artifact.mediaType, sha256: artifact.sha256 })),
    capabilities: snapshot.capabilities,
  };
}

export function snapshotIdFor(snapshot: Omit<SourceContextSnapshotV1, "snapshotId">): string {
  return `scs1-${sha256(Buffer.from(JSON.stringify(identityProjection(snapshot)), "utf8"))}`;
}

export function buildSourceContextSnapshot(manifest: RenderManifest, inputs: readonly SourceContextSourceInput[], images: readonly Buffer[], projectPrefix?: string): SourceContextResult {
  if (inputs.length === 0) throw new Error("cannot build a source context snapshot without sources");
  const sourceCount = inputs.length;
  const sources: SourceContextSource[] = inputs.map((item, sourceIndex) => ({
    sourceIndex,
    displayPath: portablePath(item.input.displayPath),
    language: item.input.language,
    contentSha256: item.contentSha256,
    ...(item.byteLength === undefined ? {} : { byteLength: item.byteLength }),
    ...(item.codec ? { codec: item.codec } : {}),
    symbolExtraction: item.input.language === "Text"
      ? { support: "unsupported" as const }
      : { support: "best-effort" as const, status: manifest.symbolDiagnostics?.some((diagnostic) => diagnostic.sourceIndex === sourceIndex) ? "failed" as const : "success" as const, extractorVersion: manifest.symbolExtractorVersion },
  }));
  if (!sources.every((source) => SHA256.test(source.contentSha256))) throw new Error("source contentSha256 must be a lowercase SHA-256");
  const artifacts = images.map((image) => ({ artifactId: artifactId(sha256(image)), mediaType: "image/png", sha256: sha256(image), byteLength: image.byteLength }));
  const uniqueArtifacts = [...new Map(artifacts.map((artifact) => [artifact.artifactId, artifact])).values()];
  const tablets = (manifest.tablets ?? []).map((tablet, index) => ({
    id: tablet.id ?? (() => { throw new Error(`source tablet ${index + 1} has no persistent id`); })(),
    pageIndex: tablet.pageIndex,
    profile: tablet.profile,
    width: tablet.width,
    height: tablet.height,
    spans: tablet.spans.map((span) => ({ sourceIndex: span.sourceIndex, startLine: span.startLine, endLine: span.endLine, ...(span.bannerOnly ? { bannerOnly: true } : {}) })),
    artifactId: artifacts[index]?.artifactId ?? (() => { throw new Error(`source tablet ${index + 1} has no image artifact`); })(),
  }));
  if (tablets.some((tablet) => tablet.spans.some((span) => span.sourceIndex < 0 || span.sourceIndex >= sourceCount))) throw new Error("source tablet span references an unknown source");
  const base: Omit<SourceContextSnapshotV1, "snapshotId"> = {
    schemaVersion: 1,
    ...(projectPrefix ? { project: { projectPrefix } } : {}),
    sources,
    tablets,
    symbols: (manifest.symbols ?? []).map((symbol) => ({ sourceIndex: symbol.sourceIndex, name: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind, line: symbol.line, tabletIds: [...symbol.tabletIds] })),
    ...(manifest.symbolDiagnostics?.length ? { symbolDiagnostics: manifest.symbolDiagnostics.map((diagnostic) => ({ ...diagnostic })) } : {}),
    artifacts: uniqueArtifacts,
    capabilities: { lineProvenance: "complete", symbolExtraction: "per-source" },
    metrics: { sourceBytes: manifest.sourceBytes, sourceChars: manifest.sourceChars, encodedChars: manifest.encodedChars, removedChars: manifest.removedChars, reductionPercent: manifest.reductionPercent },
  };
  const snapshot = { ...base, snapshotId: snapshotIdFor(base) };
  validateSourceContextSnapshot(snapshot);
  return { snapshot, artifacts: [...new Map(artifacts.map((artifact, index) => [artifact.artifactId, { artifactId: artifact.artifactId, data: images[index] }])).values()] };
}

export async function readSourceContextSnapshot(path: string): Promise<SourceContextSnapshotV1> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  validateSourceContextSnapshot(parsed);
  return parsed;
}

export function validateSourceContextSnapshot(value: unknown): asserts value is SourceContextSnapshotV1 {
  if (!value || typeof value !== "object") throw new Error("invalid SourceContextSnapshot: expected an object");
  const snapshot = value as Partial<SourceContextSnapshotV1>;
  if (snapshot.schemaVersion !== 1) throw new Error(`unsupported SourceContextSnapshot schemaVersion: ${String(snapshot.schemaVersion)}`);
  if (typeof snapshot.snapshotId !== "string" || !SNAPSHOT_ID.test(snapshot.snapshotId)) throw new Error("invalid SourceContextSnapshot snapshotId");
  if (!Array.isArray(snapshot.sources) || !Array.isArray(snapshot.tablets) || !Array.isArray(snapshot.symbols) || !Array.isArray(snapshot.artifacts)) throw new Error("invalid SourceContextSnapshot collections");
  if (!snapshot.capabilities || snapshot.capabilities.lineProvenance !== "complete" || snapshot.capabilities.symbolExtraction !== "per-source") throw new Error("invalid SourceContextSnapshot capabilities");
  const sources = snapshot.sources;
  const sourceIndexes = new Set<number>();
  for (const source of sources) {
    if (!Number.isInteger(source.sourceIndex) || source.sourceIndex < 0 || sourceIndexes.has(source.sourceIndex)) throw new Error("invalid or duplicate sourceIndex");
    sourceIndexes.add(source.sourceIndex);
    if (!source.displayPath || isAbsolute(source.displayPath) || /^[A-Za-z]:[\\/]/.test(source.displayPath) || !SHA256.test(source.contentSha256)) throw new Error("invalid portable source");
    if (!source.symbolExtraction || !["unsupported", "best-effort"].includes(source.symbolExtraction.support)) throw new Error("invalid symbolExtraction support");
    if (source.symbolExtraction.support === "unsupported" && source.symbolExtraction.status !== undefined) throw new Error("unsupported symbols cannot have a status");
    if (source.symbolExtraction.status !== undefined && !["success", "partial", "failed"].includes(source.symbolExtraction.status)) throw new Error("invalid symbolExtraction status");
  }
  if ([...sourceIndexes].sort((a, b) => a - b).some((sourceIndex, index) => sourceIndex !== index)) throw new Error("sourceIndex values must be contiguous from zero");
  const artifactIds = new Set<string>();
  for (const artifact of snapshot.artifacts) {
    if (!artifact || typeof artifact.artifactId !== "string" || artifactIds.has(artifact.artifactId) || !SHA256.test(artifact.sha256)) throw new Error("invalid or duplicate artifact");
    artifactIds.add(artifact.artifactId);
  }
  const tabletIds = new Set<string>();
  const pageIndexes = new Set<number>();
  for (const tablet of snapshot.tablets) {
    if (!tablet || typeof tablet.id !== "string" || tabletIds.has(tablet.id) || !Number.isInteger(tablet.pageIndex) || tablet.pageIndex < 1 || pageIndexes.has(tablet.pageIndex) || !artifactIds.has(tablet.artifactId)) throw new Error("invalid tablet");
    tabletIds.add(tablet.id);
    pageIndexes.add(tablet.pageIndex);
    for (const span of tablet.spans) {
      if (!sourceIndexes.has(span.sourceIndex) || (span.startLine !== null && (!Number.isInteger(span.startLine) || span.startLine < 1)) || (span.endLine !== null && (!Number.isInteger(span.endLine) || span.endLine < 1)) || (span.startLine !== null && span.endLine !== null && span.startLine > span.endLine)) throw new Error("invalid source span");
    }
  }
  for (const symbol of snapshot.symbols) {
    if (!sourceIndexes.has(symbol.sourceIndex) || !Number.isInteger(symbol.line) || symbol.line < 1 || symbol.tabletIds.some((id) => !tabletIds.has(id))) throw new Error("invalid source symbol");
  }
  if (snapshotIdFor(snapshot as SourceContextSnapshotV1) !== snapshot.snapshotId) throw new Error("SourceContextSnapshot snapshotId does not match its identity");
}

