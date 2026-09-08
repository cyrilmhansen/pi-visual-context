import type { RenderManifest } from "./rust";

export type RenderedSource = { path: string; manifest: RenderManifest };

export function buildRequestManifest(
  rendered: RenderedSource[],
  pageFiles: string[][],
  profile: RenderManifest["profile"],
  usage: Record<string, unknown>,
) {
  const sources = rendered.map((item, index) => ({ ...item.manifest, sourcePath: item.path, pages: pageFiles[index] }));
  const globalMetrics = rendered.reduce((sum, item) => ({
    sourceBytes: sum.sourceBytes + item.manifest.sourceBytes,
    sourceChars: sum.sourceChars + item.manifest.sourceChars,
    encodedChars: sum.encodedChars + item.manifest.encodedChars,
    removedChars: sum.removedChars + item.manifest.removedChars,
  }), { sourceBytes: 0, sourceChars: 0, encodedChars: 0, removedChars: 0 });
  const pageDimensions = rendered.flatMap((item) => item.manifest.pageDimensions);
  const pages = pageFiles.flat();
  if (rendered.length === 1) {
    return { ...rendered[0].manifest, sourcePath: rendered[0].path, pages, sources, globalMetrics, usage };
  }
  return { profile, sources, pages, pageCount: pages.length, pageDimensions, globalMetrics, usage };
}
