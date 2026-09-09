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
  if (rendered.length === 1) return { ...rendered[0].manifest, sourcePath: rendered[0].path, pages, sources, globalMetrics: metrics, usage };
  return { profile, sources, pages, pageCount: pages.length, pageDimensions, globalMetrics: metrics, usage };
}

export function buildVisualPromptRequestManifest(
  task: TaskManifest,
  taskFiles: string[],
  source: RenderManifest,
  sourceManifests: RenderedSource[],
  sourceFiles: string[],
  usage: Record<string, unknown>,
) {
  return {
    visualPrompt: true,
    task: { ...task, pages: taskFiles },
    source: { ...source, pages: sourceFiles, sources: sourceManifests.map((item) => ({ ...item.manifest, sourcePath: item.path })) },
    pageCount: taskFiles.length + sourceFiles.length,
    sourceChars: source.sourceChars,
    globalMetrics: { sourceChars: source.sourceChars, sourceBytes: source.sourceBytes, encodedChars: source.encodedChars, removedChars: source.removedChars },
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
    tabletSources: null,
    tabletSourcesKnown: false,
    usage,
  };
}
