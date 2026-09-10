import type { RenderManifest } from "./rust.ts";
import { buildSourceTabletIndex, formatSourceTabletLine, formatVisualName } from "./tablet-index.ts";
import type { GroupTablet } from "./rust.ts";
import type { SourceContextSnapshotV1, SourceContextSource, SourceContextSymbol, SourceContextTablet } from "./source-context.ts";
import { validateSourceContextSnapshot } from "./source-context.ts";
import type { SymbolAnchor } from "./symbols.ts";

type NavigableTablet = GroupTablet | SourceContextTablet;
type NavigableSymbol = SymbolAnchor | SourceContextSymbol;

export type ActiveSourceContext = {
  sourceCacheKey?: string;
  projectPrefix?: string;
  snapshotId?: string;
  sources?: SourceContextSource[];
  tablets: NavigableTablet[];
  tabletIndex: string;
  symbols: NavigableSymbol[];
  artifacts?: SourceContextSnapshotV1["artifacts"];
  snapshot?: SourceContextSnapshotV1;
};

export type NavigationTarget = { tablet?: string; symbol?: string };

type SourceManifestLike = Pick<RenderManifest, "tablets" | "symbols" | "cache"> & { tabletIndex?: string; sources?: { sourcePath?: string; sourceIndex?: number; language?: SourceContextSource["language"] }[] };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function prefixFromTablets(tablets: readonly GroupTablet[]): string | undefined {
  const prefixes = new Set(tablets.map((tablet) => tablet.id?.match(/^([A-Z0-9]{1,4})-VC-\d{6}$/)?.[1]).filter((prefix): prefix is string => Boolean(prefix)));
  return prefixes.size === 1 ? [...prefixes][0] : undefined;
}

export function activeSourceContextFromManifest(manifest: SourceManifestLike): ActiveSourceContext | undefined {
  const tablets = manifest.tablets ?? [];
  if (!tablets.length) return undefined;
  const sourceIndexes = [...new Set(tablets.flatMap((tablet) => tablet.spans.map((span) => span.sourceIndex)))].sort((a, b) => a - b);
  const sources = sourceIndexes.map((sourceIndex) => {
    const source = manifest.sources?.find((candidate) => candidate.sourceIndex === sourceIndex);
    const visualName = tablets.flatMap((tablet) => tablet.spans).find((span) => span.sourceIndex === sourceIndex)?.visualName ?? `source-${sourceIndex}`;
    return { sourceIndex, displayPath: source?.sourcePath ?? visualName, language: source?.language ?? "Text", contentSha256: "0".repeat(64), symbolExtraction: { support: "unsupported" as const } };
  });
  return {
    sourceCacheKey: manifest.cache?.key,
    projectPrefix: prefixFromTablets(tablets),
    sources,
    tablets: clone(tablets),
    tabletIndex: manifest.tabletIndex ?? buildSourceTabletIndex(tablets, sources),
    symbols: clone(manifest.symbols ?? []),
  };
}

export function activeSourceContextFromSnapshot(snapshot: SourceContextSnapshotV1): ActiveSourceContext {
  validateSourceContextSnapshot(snapshot);
  return { snapshotId: snapshot.snapshotId, projectPrefix: snapshot.project?.projectPrefix, sources: clone(snapshot.sources), tablets: clone(snapshot.tablets), symbols: clone(snapshot.symbols), artifacts: clone(snapshot.artifacts), snapshot: clone(snapshot), tabletIndex: buildSourceTabletIndex(snapshot.tablets, snapshot.sources) };
}

function legacySources(tablets: readonly NavigableTablet[]): SourceContextSource[] {
  return [...new Set(tablets.flatMap((tablet) => tablet.spans.map((span) => span.sourceIndex)))].sort((a, b) => a - b).map((sourceIndex) => {
    const span = tablets.flatMap((tablet) => tablet.spans).find((candidate) => candidate.sourceIndex === sourceIndex);
    return { sourceIndex, displayPath: span && "visualName" in span ? span.visualName : `source-${sourceIndex}`, language: "Text" as const, contentSha256: "0".repeat(64), symbolExtraction: { support: "unsupported" as const } };
  });
}

export function activeSourceContextFromStored(value: unknown): ActiveSourceContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ActiveSourceContext> & Partial<SourceContextSnapshotV1>;
  if (candidate.snapshot && typeof candidate.snapshot === "object") {
    try { return activeSourceContextFromSnapshot(candidate.snapshot); } catch { return undefined; }
  }
  if (candidate.schemaVersion === 1 && Array.isArray(candidate.sources) && Array.isArray(candidate.artifacts)) {
    try { return activeSourceContextFromSnapshot(candidate as SourceContextSnapshotV1); } catch { return undefined; }
  }
  if (!Array.isArray(candidate.tablets) || !Array.isArray(candidate.symbols) || typeof candidate.tabletIndex !== "string") return undefined;
  if (!candidate.tablets.every((tablet) => tablet && typeof tablet === "object" && typeof tablet.id === "string" && Array.isArray(tablet.spans))) return undefined;
  if (!candidate.symbols.every((symbol) => symbol && typeof symbol === "object" && typeof symbol.name === "string" && typeof symbol.qualifiedName === "string" && Array.isArray(symbol.tabletIds))) return undefined;
  return { ...clone(candidate as ActiveSourceContext), sources: candidate.sources ?? legacySources(candidate.tablets) };
}

export function findActiveTablet(context: ActiveSourceContext, id: string): NavigableTablet | undefined {
  return context.tablets.find((tablet) => tablet.id === id);
}

type NavigableSymbolResult = SymbolAnchor | SourceContextSymbol;
export type ResolvedSymbol = { symbol: NavigableSymbolResult; visualNames: string[] };

export function resolveActiveSymbol(context: ActiveSourceContext, query: string): { resolved?: ResolvedSymbol; error?: string } {
  const qualified = context.symbols.filter((symbol) => symbol.qualifiedName === query);
  const candidates = qualified.length ? qualified : context.symbols.filter((symbol) => symbol.name === query);
  if (!candidates.length) return { error: `symbol "${query}" not found in the active source context` };
  if (candidates.length > 1) {
    const lines = candidates.map((symbol) => {
      const names = new Set(context.tablets.flatMap((tablet) => tablet.spans.filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine).map((span) => `${formatVisualName("visualName" in span ? span.visualName : context.sources?.find((source) => source.sourceIndex === span.sourceIndex)?.displayPath ?? `source-${span.sourceIndex}`)}:${symbol.line}`)));
      const tablets = symbol.tabletIds.join(", ") || "(no active tablet)";
      return `  ${[...names].join(" | ") || `source ${symbol.sourceIndex}:${symbol.line}`}  ${tablets}`;
    });
    return { error: `symbol "${query}" is ambiguous:\n${lines.join("\n")}` };
  }
  const symbol = candidates[0];
  if (!symbol.tabletIds.length) return { error: `symbol found but not mapped to an active source tablet: "${query}"` };
  const visualNames = [...new Set(context.tablets.flatMap((tablet) => tablet.spans.filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine).map((span) => formatVisualName("visualName" in span ? span.visualName : context.sources?.find((source) => source.sourceIndex === span.sourceIndex)?.displayPath ?? `source-${span.sourceIndex}`))))];
  return { resolved: { symbol, visualNames } };
}

export function buildTabletNavigationPrompt(tablet: NavigableTablet, question: string, sources?: readonly SourceContextSource[]): string {
  return `Focus on source tablet ${tablet.id} from the visual source context already attached earlier in this conversation.\n\n${formatSourceTabletLine(tablet, sources)}\n\n${question}`;
}

export function buildSymbolNavigationPrompt(resolved: ResolvedSymbol, question: string): string {
  const declaration = resolved.visualNames.length ? resolved.visualNames.map((name) => `${name}:${resolved.symbol.line}`).join(" | ") : `source:${resolved.symbol.line}`;
  return `Focus on symbol ${resolved.symbol.qualifiedName} in the visual source context already attached earlier in this conversation.\n\nDeclaration: ${declaration}\nSource tablets: ${resolved.symbol.tabletIds.join(", ")}\n\n${question}`;
}

export function resolveNavigation(context: ActiveSourceContext | undefined, target: NavigationTarget, question: string): { text?: string; error?: string } {
  if (!context) return { error: "no active source context in this conversation" };
  if (target.tablet) {
    const tablet = findActiveTablet(context, target.tablet);
    return tablet ? { text: buildTabletNavigationPrompt(tablet, question, context.sources) } : { error: `tablet ${target.tablet} is not active in this conversation` };
  }
  const result = resolveActiveSymbol(context, target.symbol!);
  return result.error ? { error: result.error } : { text: buildSymbolNavigationPrompt(result.resolved!, question) };
}

const SYMBOL_LIST_LIMIT = 100;

function symbolLocation(context: ActiveSourceContext, symbol: SymbolAnchor): string {
  const locations = new Set(context.tablets.flatMap((tablet) => tablet.spans
    .filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine)
    .map((span) => `${formatVisualName("visualName" in span ? span.visualName : context.sources?.find((source) => source.sourceIndex === span.sourceIndex)?.displayPath ?? `source-${span.sourceIndex}`)}:${symbol.line}`)));
  return [...locations].join(" | ") || `source:${symbol.sourceIndex}:${symbol.line}`;
}

export function formatSymbolList(context: ActiveSourceContext | undefined, query?: string): { text?: string; error?: string; total?: number; shown?: number } {
  if (!context) return { error: "no active source context in this conversation" };
  if (!context.symbols.length) return { text: "no symbol anchors are available in the active source context", total: 0, shown: 0 };
  const matches = query === undefined ? [...context.symbols] : context.symbols
    .map((symbol, index) => ({ symbol, index, rank: symbol.qualifiedName === query ? 0 : symbol.name === query ? 1 : symbol.qualifiedName.toLowerCase().includes(query.toLowerCase()) || symbol.name.toLowerCase().includes(query.toLowerCase()) ? 2 : 3 }))
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.symbol);
  if (!matches.length) return { text: `no symbol anchors match "${query}" in the active source context`, total: 0, shown: 0 };
  const shownSymbols = matches.slice(0, SYMBOL_LIST_LIMIT);
  const nameWidth = Math.max(...shownSymbols.map((symbol) => (symbol.qualifiedName || symbol.name).length));
  const kindWidth = Math.max(...shownSymbols.map((symbol) => symbol.kind.length));
  const locationWidth = Math.max(...shownSymbols.map((symbol) => symbolLocation(context, symbol).length));
  const lines = shownSymbols.map((symbol) => {
    const name = symbol.qualifiedName || symbol.name;
    return `${name.padEnd(nameWidth)}  ${symbol.kind.padEnd(kindWidth)}  ${symbolLocation(context, symbol).padEnd(locationWidth)}  ${symbol.tabletIds.join(", ")}`;
  });
  if (matches.length > SYMBOL_LIST_LIMIT) lines.push(`showing ${SYMBOL_LIST_LIMIT} of ${matches.length} symbols; use @v --symbols <query> to narrow the list`);
  return { text: lines.join("\n"), total: matches.length, shown: shownSymbols.length };
}
