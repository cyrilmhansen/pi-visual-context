import type { VisualProfile } from "./profile.ts";
import type { GitProvenance } from "./git.ts";
import type { SymbolAnchor, SymbolDiagnostic } from "./symbols.ts";

export type ProvenanceSpan = { sourceIndex: number; sourcePath: string; visualName: string; startLine: number | null; endLine: number | null; bannerOnly?: boolean };
export type GroupTablet = { id?: string; pageIndex: number; profile: VisualProfile["name"]; width: number; height: number; spans: ProvenanceSpan[] };
export type RenderManifest = {
  sourceBytes: number; sourceChars: number; encodedChars: number; removedChars: number; reductionPercent: number; pageCount: number;
  profile: VisualProfile; language: "Rust" | "C" | "Python" | "Text" | "Mixed"; codec?: "rust" | "c" | "python" | "text";
  pageDimensions: { width: number; height: number }[];
  finalPage: { originalDimensions: { width: number; height: number }; croppedDimensions: { width: number; height: number }; columnsUsed: number; croppedRightPixels: number; croppedBottomPixels: number };
  timingsMs?: Record<string, number>; workers?: number; requestedProfile?: VisualProfile["name"];
  renderGroups?: { profile: VisualProfile["name"]; reason: string; sources: string[]; pageCount: number; pageDimensions: { width: number; height: number }[]; workers: number; fontsUsed?: string[] }[];
  tablets?: GroupTablet[]; fontsUsed?: string[]; git?: GitProvenance; gitRepository?: number | null;
  cache?: { schemaVersion: number; key: string; hit: boolean }; symbols?: SymbolAnchor[]; symbolDiagnostics?: SymbolDiagnostic[]; symbolExtractorVersion?: string;
};
export type RenderInput = { path: string; displayPath: string; language: "Rust" | "C" | "Python" | "Text" };
export type RenderSourceIdentity = { displayPath: string; language: RenderInput["language"]; contentSha256: string; byteLength: number; codec?: string };
export class RenderCancelled extends Error { constructor() { super("render cancelled"); } }
export type RenderOptions = {
  beforeRasterize?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  onCacheHit?: (pageCount: number, sourceChars: number) => Promise<boolean>;
  cacheDirectory?: string; projectRoot?: string; workRoot?: string; stateRoot?: string; readMs?: number; git?: GitProvenance; gitRepositoryIds?: (number | null)[];
};
export type PdfRenderResult = { images: Buffer[]; pageDimensions: { width: number; height: number }[]; finalPage: { width: number; height: number; columnsUsed: number; croppedRightPixels: number; croppedBottomPixels: number }; workers: number };
