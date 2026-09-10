import type { GroupTablet } from "./rust.ts";

export function formatVisualName(name: string): string {
  return name
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("|", "\\|")
    .replaceAll(":", "\\:");
}

export function formatSourceSpan(span: GroupTablet["spans"][number]): string {
  const name = formatVisualName(span.visualName);
  if (span.bannerOnly || (span.startLine === null && span.endLine === null)) return `${name}:empty`;
  return `${name}:${span.startLine ?? "?"}-${span.endLine ?? "?"}`;
}

/** Project the canonical SOURCE tablet provenance into the compact model-facing index. */
export function formatSourceTabletLine(tablet: GroupTablet): string {
  const id = tablet.id ?? `VC-${String(tablet.pageIndex).padStart(3, "0")}`;
  const spans = tablet.spans.map(formatSourceSpan).join(" | ");
  return spans ? `${id} ${spans}` : id;
}

export function buildSourceTabletIndex(tablets: readonly GroupTablet[]): string {
  return tablets.map(formatSourceTabletLine).join("\n");
}

export function buildHistoricalSourcePrompt(question: string, tablets: readonly GroupTablet[]): string {
  const index = buildSourceTabletIndex(tablets);
  return index ? `Use the attached visual source context to answer the question.\n\nSource tablet index:\n${index}\n\n${question}` : `Use the attached visual source context to answer the question.\n\n${question}`;
}

export function buildVisualSourcePrompt(tablets: readonly GroupTablet[]): string {
  const index = buildSourceTabletIndex(tablets);
  return index ? `Use the attached visual task and source context to answer.\n\nSource tablet index:\n${index}` : "Use the attached visual task and source context to answer.";
}
