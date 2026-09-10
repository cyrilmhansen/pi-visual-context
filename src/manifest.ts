import type { RenderManifest } from "./rust";
import type { TaskManifest } from "./task.ts";

export type RenderedSource = { path: string; manifest: RenderManifest };

function globalMetrics(rendered: RenderedSource[]) {
  return rendered.reduce((sum, item) => ({
    sourceBytes: sum.sourceBytes + item.manifest.sourceBytes,
    sourceChars: sum.sourceChars + item.manifest.sourceChars,
    encodedChars: sum.encodedChars + item.manifest.encodedChars,
    removedChars: sum.removedChars + item.manifest.removedChars,
  }), { sourceBytes: 0, sourceChars: 0, encodedChars: 0, removedChars: 0 });
}

export function buildRequestManifest(
  rendered: RenderedSource[],
  pageFiles: string[][],
  profile: RenderManifest["profile"],
  usage: Record<string, unknown>,
) {
  const sources = rendered.map((item, index) => ({ ...item.manifest, sourcePath: item.path, pages: pageFiles[index] }));
  const metrics = globalMetrics(rendered);
  const pageDimensions = rendered.flatMap((item) => item.manifest.pageDimensions);
  const pages = pageFiles.flat();
  if (rendered.length === 1) return { ...rendered[0].manifest, sourcePath: rendered[0].path, pages, sources, globalMetrics: metrics, tabletSourcesKnown: true, usage };
  return { profile, sources, pages, pageCount: pages.length, pageDimensions, tablets: rendered.flatMap((item) => item.manifest.tablets ?? []), tabletSources: rendered.flatMap((item) => item.manifest.tablets ?? []), tabletSourcesKnown: true, globalMetrics: metrics, usage };
}

export function buildVisualPromptRequestManifest(
  task: TaskManifest,
  taskFiles: string[],
  source: RenderManifest | null,
  sourceManifests: RenderedSource[],
  sourceFiles: string[],
  usage: Record<string, unknown>,
) {
  return {
    visualPrompt: true,
    task: { ...task, pages: taskFiles },
    source: source ? { ...source, pages: sourceFiles, sources: sourceManifests.map((item) => ({ ...item.manifest, sourcePath: item.path })) } : null,
    pageCount: taskFiles.length + sourceFiles.length,
    sourceChars: source?.sourceChars ?? 0,
    globalMetrics: { sourceChars: source?.sourceChars ?? 0, sourceBytes: source?.sourceBytes ?? 0, encodedChars: source?.encodedChars ?? 0, removedChars: source?.removedChars ?? 0 },
    totalTablets: taskFiles.length + sourceFiles.length,
    usage,
  };
}

export function buildContinuousRequestManifest(
  sourceManifests: RenderedSource[],
  pageFiles: string[],
  manifest: RenderManifest,
  usage: Record<string, unknown>,
) {
  return {
    ...manifest,
    sources: sourceManifests.map((item) => ({ ...item.manifest, sourcePath: item.path })),
    pages: pageFiles,
    pageCount: pageFiles.length,
    globalMetrics: globalMetrics(sourceManifests),
    tablets: manifest.tablets ?? [],
    tabletSources: manifest.tablets ?? [],
    tabletSourcesKnown: true,
    usage,
  };
}
