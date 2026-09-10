import type { GroupTablet } from "./rust.ts";
import type { SourceContextSnapshotV1, SourceContextSource, SourceContextSpan, SourceContextTablet } from "./source-context.ts";

export function formatVisualName(name: string): string {
  return name
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("|", "\\|")
    .replaceAll(":", "\\:");
}

type TabletSpan = GroupTablet["spans"][number] | SourceContextSpan;
type Tablet = GroupTablet | SourceContextTablet;

function sourceName(span: TabletSpan, sources?: readonly SourceContextSource[]): string {
  return "visualName" in span ? span.visualName : sources?.find((source) => source.sourceIndex === span.sourceIndex)?.displayPath ?? `source-${span.sourceIndex}`;
}

export function formatSourceSpan(span: TabletSpan, sources?: readonly SourceContextSource[]): string {
  const name = formatVisualName(sourceName(span, sources));
  if (span.bannerOnly || (span.startLine === null && span.endLine === null)) return `${name}:empty`;
  return `${name}:${span.startLine ?? "?"}-${span.endLine ?? "?"}`;
}

/** Project the canonical SOURCE tablet provenance into the compact model-facing index. */
export function formatSourceTabletLine(tablet: Tablet, sources?: readonly SourceContextSource[]): string {
  const id = tablet.id ?? `VC-${String(tablet.pageIndex).padStart(3, "0")}`;
  const spans = tablet.spans.map((span) => formatSourceSpan(span, sources)).join(" | ");
  return spans ? `${id} ${spans}` : id;
}

export function buildSourceTabletIndex(tablets: readonly Tablet[], sources?: readonly SourceContextSource[]): string {
  return tablets.map((tablet) => formatSourceTabletLine(tablet, sources)).join("\n");
}

export function buildSnapshotTabletIndex(snapshot: Pick<SourceContextSnapshotV1, "sources" | "tablets">): string {
  return buildSourceTabletIndex(snapshot.tablets, snapshot.sources);
}

export function buildHistoricalSourcePrompt(question: string, tablets: readonly GroupTablet[]): string {
  const index = buildSourceTabletIndex(tablets);
  return index ? `Use the attached visual source context to answer the question.\n\nSource tablet index:\n${index}\n\n${question}` : `Use the attached visual source context to answer the question.\n\n${question}`;
}

export function buildVisualSourcePrompt(tablets: readonly GroupTablet[]): string {
  const index = buildSourceTabletIndex(tablets);
  return index ? `Use the attached visual task and source context to answer.\n\nSource tablet index:\n${index}` : "Use the attached visual task and source context to answer.";
}
