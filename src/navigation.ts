import type { RenderManifest } from "./rust.ts";
import { buildSourceTabletIndex, formatSourceTabletLine, formatVisualName } from "./tablet-index.ts";
import type { GroupTablet } from "./rust.ts";
import type { SymbolAnchor } from "./symbols.ts";

export type ActiveSourceContext = {
  sourceCacheKey?: string;
  projectPrefix?: string;
  tablets: GroupTablet[];
  tabletIndex: string;
  symbols: SymbolAnchor[];
};

export type NavigationTarget = { tablet?: string; symbol?: string };

type SourceManifestLike = Pick<RenderManifest, "tablets" | "symbols" | "cache"> & { tabletIndex?: string };

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
  return {
    sourceCacheKey: manifest.cache?.key,
    projectPrefix: prefixFromTablets(tablets),
    tablets: clone(tablets),
    tabletIndex: manifest.tabletIndex ?? buildSourceTabletIndex(tablets),
    symbols: clone(manifest.symbols ?? []),
  };
}

export function activeSourceContextFromStored(value: unknown): ActiveSourceContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ActiveSourceContext>;
  if (!Array.isArray(candidate.tablets) || !Array.isArray(candidate.symbols) || typeof candidate.tabletIndex !== "string") return undefined;
  if (!candidate.tablets.every((tablet) => tablet && typeof tablet === "object" && typeof tablet.id === "string" && Array.isArray(tablet.spans))) return undefined;
  if (!candidate.symbols.every((symbol) => symbol && typeof symbol === "object" && typeof symbol.name === "string" && typeof symbol.qualifiedName === "string" && Array.isArray(symbol.tabletIds))) return undefined;
  return clone(candidate as ActiveSourceContext);
}

export function findActiveTablet(context: ActiveSourceContext, id: string): GroupTablet | undefined {
  return context.tablets.find((tablet) => tablet.id === id);
}

export type ResolvedSymbol = { symbol: SymbolAnchor; visualNames: string[] };

export function resolveActiveSymbol(context: ActiveSourceContext, query: string): { resolved?: ResolvedSymbol; error?: string } {
  const qualified = context.symbols.filter((symbol) => symbol.qualifiedName === query);
  const candidates = qualified.length ? qualified : context.symbols.filter((symbol) => symbol.name === query);
  if (!candidates.length) return { error: `symbol "${query}" not found in the active source context` };
  if (candidates.length > 1) {
    const lines = candidates.map((symbol) => {
      const names = new Set(context.tablets.flatMap((tablet) => tablet.spans.filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine).map((span) => `${formatVisualName(span.visualName)}:${symbol.line}`)));
      const tablets = symbol.tabletIds.join(", ") || "(no active tablet)";
      return `  ${[...names].join(" | ") || `source ${symbol.sourceIndex}:${symbol.line}`}  ${tablets}`;
    });
    return { error: `symbol "${query}" is ambiguous:\n${lines.join("\n")}` };
  }
  const symbol = candidates[0];
  if (!symbol.tabletIds.length) return { error: `symbol found but not mapped to an active source tablet: "${query}"` };
  const visualNames = [...new Set(context.tablets.flatMap((tablet) => tablet.spans.filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine).map((span) => formatVisualName(span.visualName))))];
  return { resolved: { symbol, visualNames } };
}

export function buildTabletNavigationPrompt(tablet: GroupTablet, question: string): string {
  return `Focus on source tablet ${tablet.id} from the visual source context already attached earlier in this conversation.\n\n${formatSourceTabletLine(tablet)}\n\n${question}`;
}

export function buildSymbolNavigationPrompt(resolved: ResolvedSymbol, question: string): string {
  const declaration = resolved.visualNames.length ? resolved.visualNames.map((name) => `${name}:${resolved.symbol.line}`).join(" | ") : `source:${resolved.symbol.line}`;
  return `Focus on symbol ${resolved.symbol.qualifiedName} in the visual source context already attached earlier in this conversation.\n\nDeclaration: ${declaration}\nSource tablets: ${resolved.symbol.tabletIds.join(", ")}\n\n${question}`;
}

export function resolveNavigation(context: ActiveSourceContext | undefined, target: NavigationTarget, question: string): { text?: string; error?: string } {
  if (!context) return { error: "no active source context in this conversation" };
  if (target.tablet) {
    const tablet = findActiveTablet(context, target.tablet);
    return tablet ? { text: buildTabletNavigationPrompt(tablet, question) } : { error: `tablet ${target.tablet} is not active in this conversation` };
  }
  const result = resolveActiveSymbol(context, target.symbol!);
  return result.error ? { error: result.error } : { text: buildSymbolNavigationPrompt(result.resolved!, question) };
}

const SYMBOL_LIST_LIMIT = 100;

function symbolLocation(context: ActiveSourceContext, symbol: SymbolAnchor): string {
  const locations = new Set(context.tablets.flatMap((tablet) => tablet.spans
    .filter((span) => span.sourceIndex === symbol.sourceIndex && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine)
    .map((span) => `${formatVisualName(span.visualName)}:${symbol.line}`)));
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
