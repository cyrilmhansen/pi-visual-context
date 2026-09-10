import { extname } from "node:path";
import { getVisualProfile, type VisualProfile } from "./profile.ts";
import { displaySourcePaths, expandSourcePatterns } from "./sources.ts";
import { renderSources, type RenderInput, type RenderManifest, type RenderOptions } from "./rust.ts";
import { buildSourceTabletIndex } from "./tablet-index.ts";
import { buildSourceContextSnapshot, type SourceContextArtifactPayload, type SourceContextSnapshotV1 } from "./source-context.ts";

export type SourceContextOptions = {
  cwd: string;
  sources: string[];
  profile?: string | VisualProfile;
  onProgress?: (text: string) => void;
  confirmSources?: (count: number) => Promise<boolean>;
  afterSourcesExpanded?: (paths: string[], inputs: RenderInput[]) => Promise<void>;
  beforeRasterize?: RenderOptions["beforeRasterize"];
  onCacheHit?: RenderOptions["onCacheHit"];
  cacheDirectory?: string;
};

export type SourceContext = {
  images: Buffer[];
  manifest: RenderManifest;
  sourceManifests: { path: string; manifest: RenderManifest }[];
  sourcePaths: string[];
  inputs: RenderInput[];
  tabletIndex: string;
  snapshot: SourceContextSnapshotV1;
  artifactPayloads: SourceContextArtifactPayload[];
};

function languageFor(path: string): RenderInput["language"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".rs") return "Rust";
  if (extension === ".py") return "Python";
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"].includes(extension)) return "C";
  return "Text";
}

export async function prepareSourceContext(options: SourceContextOptions): Promise<SourceContext | undefined> {
  const started = performance.now();
  const onProgress = options.onProgress ?? (() => {});
  const sourcePaths = await expandSourcePatterns(options.sources, options.cwd);
  if (options.confirmSources && !await options.confirmSources(sourcePaths.length)) return undefined;
  const displayPaths = displaySourcePaths(sourcePaths, options.cwd);
  const inputs = sourcePaths.map((path, index) => ({ path, displayPath: displayPaths[index], language: languageFor(path) }));
  const expansionMs = Math.round((performance.now() - started) * 100) / 100;
  await options.afterSourcesExpanded?.(sourcePaths, inputs);
  const profile = typeof options.profile === "string" || options.profile === undefined ? getVisualProfile(options.profile ?? "normal") : options.profile;
  const rendered = await renderSources(inputs, onProgress, profile, {
    beforeRasterize: options.beforeRasterize,
    onCacheHit: options.onCacheHit,
    cacheDirectory: options.cacheDirectory,
    projectRoot: options.cwd,
    readMs: expansionMs,
  });
  const portable = buildSourceContextSnapshot(rendered.manifest, rendered.sourceIdentities.map((identity, index) => ({ input: inputs[index], contentSha256: identity.contentSha256, byteLength: identity.byteLength, codec: identity.codec })), rendered.images, rendered.projectPrefix);
  return { ...rendered, sourcePaths, inputs, tabletIndex: buildSourceTabletIndex(rendered.manifest.tablets ?? []), snapshot: portable.snapshot, artifactPayloads: portable.artifacts };
}
