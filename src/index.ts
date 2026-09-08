import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { parseVisualInput, renderSources, RenderCancelled } from "./rust";
import { getVisualProfile } from "./profile";
import { buildContinuousRequestManifest } from "./manifest";
import { displaySourcePaths, expandSourcePatterns } from "./sources";
import { confirmFileBudget, confirmTabletBudget, maxTabletsFromEnvironment } from "./policy";
import { openPreview } from "./preview";
import { registerVisualContextCommand } from "./command";

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const imageHash = (data: Buffer | string) => createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "base64") : data).digest("hex");
const showUsage = () => !["0", "false", "no", "off"].includes((process.env.PI_VISUAL_CONTEXT_SHOW_USAGE ?? "").toLowerCase());
const compactNumber = (value: number) => value < 1000 ? String(value) : `${Number((value / 1000).toPrecision(3))}k`;
const compactCost = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

function setGeneratedImageDetail(value: unknown, hashes: Set<string>): boolean {
  if (Array.isArray(value)) return value.reduce((changed, item) => setGeneratedImageDetail(item, hashes), false) || false;
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  let changed = false;
  if (object.type === "input_image" && typeof object.image_url === "string" && object.image_url.startsWith("data:")) {
    const comma = object.image_url.indexOf(",");
    const encoded = comma >= 0 ? object.image_url.slice(comma + 1) : "";
    if (encoded && hashes.has(imageHash(encoded)) && object.detail !== "original") {
      object.detail = "original";
      changed = true;
    }
  }
  for (const child of Object.values(object)) changed = setGeneratedImageDetail(child, hashes) || changed;
  return changed;
}

export default function (pi: ExtensionAPI) {
  let active: { manifestPath: string; manifest: Record<string, unknown> } | undefined;
  const usage = { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 };
  const generatedImageHashes = new Set<string>();

  registerVisualContextCommand(pi);

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.startsWith("@v ")) return { action: "continue" };
    ctx.ui.setWidget("visual-context-help", undefined);
    const status = (text: string) => ctx.ui.setStatus("visual-context", `visual-context: ${text}`);
    try {
      const { sources, question, profile: profileName, render: preview, open } = parseVisualInput(event.text);
      const profile = getVisualProfile(profileName);
      const readStarted = performance.now();
      const sourcePaths = await expandSourcePatterns(sources, ctx.cwd);
      const expansionMs = Math.round((performance.now() - readStarted) * 100) / 100;
      if (!await confirmFileBudget(ctx.ui, sourcePaths.length)) {
        ctx.ui.setStatus("visual-context", undefined);
        return { action: "handled" };
      }
      const displayPaths = displaySourcePaths(sourcePaths, ctx.cwd);
      const renderInputs = sourcePaths.map((sourcePath, index) => {
        const extension = extname(sourcePath).toLowerCase();
        const language = extension === ".rs" ? "Rust" as const : extension === ".py" ? "Python" as const : [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"].includes(extension) ? "C" as const : undefined;
        if (!language) throw new Error(`unsupported source extension: ${extension}`);
        return { path: sourcePath, displayPath: displayPaths[index], language };
      });
      const rendered = await renderSources(renderInputs, status, profile, {
        readMs: expansionMs,
        beforeRasterize: async (tabletCount, sourceChars) => confirmTabletBudget(ctx.ui, sourcePaths.length, tabletCount, sourceChars, maxTabletsFromEnvironment(), preview ? "preview" : "normal"),
        onCacheHit: preview ? undefined : async (tabletCount, sourceChars) => confirmTabletBudget(ctx.ui, sourcePaths.length, tabletCount, sourceChars, maxTabletsFromEnvironment()),
      });
      const images = rendered.images;
      const pageDimensions = rendered.manifest.pageDimensions;
      if (rendered.manifest.cache?.hit) status(`cache hit · ${images.length} tablets`);
      else status(`ready: ${images.length} pages, ${pageDimensions.map((page) => `${page.width}x${page.height}`).join(", ")}`);
      Object.assign(usage, { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const firstBase = basename(sourcePaths[0], extname(sourcePaths[0]));
      const debugName = sources.length === 1 ? firstBase : `${firstBase}-multi`;
      const debugDir = resolve(ctx.cwd, ".pi", "visual-context", `${stamp}-${debugName}`);
      await mkdir(debugDir, { recursive: true });
      const pageFiles = images.map((_, index) => `page-${String(index + 1).padStart(3, "0")}.png`);
      for (let index = 0; index < images.length; index++) await writeFile(resolve(debugDir, pageFiles[index]), images[index]);
      for (const image of images) generatedImageHashes.add(imageHash(image));
      const requestManifest = buildContinuousRequestManifest(rendered.sourceManifests, pageFiles, rendered.manifest, { ...usage });
      const manifestPath = resolve(debugDir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(requestManifest, null, 2)}\n`);
      const sourceChars = rendered.manifest.sourceChars;
      if (preview) {
        ctx.ui.setStatus("visual-context", undefined);
        ctx.ui.notify(`visual-context preview: ${sourcePaths.length} files · ${compactNumber(images.length)} tablets · ${compactNumber(sourceChars)} chars\n${debugDir}`, "info");
        if (open) await openPreview(debugDir);
        return { action: "handled" };
      }
      active = { manifestPath, manifest: requestManifest };
      ctx.ui.setStatus("visual-context", undefined);
      return {
        action: "transform",
        text: `Use the attached visual source context to answer the question.\n\n${question}`,
        images: [...(event.images ?? []), ...images.map((data) => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/png" as const }))],
      };
    } catch (error) {
      if (error instanceof RenderCancelled) {
        ctx.ui.setStatus("visual-context", undefined);
        return { action: "handled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      status(`failed: ${message}`);
      ctx.ui.notify(`@v failed: ${message}`, "error");
      ctx.ui.setStatus("visual-context", undefined);
      return { action: "handled" };
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    if (setGeneratedImageDetail(event.payload, generatedImageHashes)) return event.payload;
  });

  pi.on("message_end", async (event) => {
    if (!active || event.message.role !== "assistant") return;
    const message = event.message as any;
    const u = message.usage ?? {};
    usage.assistantMessageCount++;
    usage.modelCallCount++;
    usage.input += number(u.input);
    usage.output += number(u.output);
    usage.cacheRead += number(u.cacheRead);
    usage.cacheWrite += number(u.cacheWrite);
    usage.reasoning += number(u.reasoning);
    usage.totalCost += number(u.cost?.total ?? u.cost);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;
    const manifest = { ...active.manifest, usage: { ...usage } };
    await writeFile(active.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (showUsage()) {
      const finalUsage = manifest.usage as typeof usage;
      ctx.ui.notify(`visual-context: ${manifest.pageCount} pages · ${compactNumber(Number(manifest.globalMetrics ? (manifest.globalMetrics as any).sourceChars : manifest.sourceChars))} chars · ${finalUsage.modelCallCount} call${finalUsage.modelCallCount === 1 ? "" : "s"} · ↑ ${compactNumber(finalUsage.input)} · ↓ ${compactNumber(finalUsage.output)} · R ${compactNumber(finalUsage.cacheRead)} · W ${compactNumber(finalUsage.cacheWrite)} · ${compactCost(finalUsage.totalCost)}`, "info");
    }
    active = undefined;
  });
}
