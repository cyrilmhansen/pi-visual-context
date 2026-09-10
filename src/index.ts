import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { parseVisualInput, RenderCancelled } from "./rust.ts";
import { prepareSourceContext } from "./core.ts";
import { buildContinuousRequestManifest, buildVisualPromptRequestManifest } from "./manifest.ts";
import { confirmFileBudget, confirmTabletBudget, maxTabletsFromEnvironment } from "./policy.ts";
import { openPreview } from "./preview.ts";
import { registerVisualContextCommand } from "./command.ts";
import { renderTask } from "./task.ts";
import { buildHistoricalSourcePrompt, buildVisualSourcePrompt } from "./tablet-index.ts";
import { activeSourceContextFromManifest, activeSourceContextFromStored, formatSymbolList, resolveNavigation, type ActiveSourceContext } from "./navigation.ts";

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
  let activeSourceContext: ActiveSourceContext | undefined;
  let pendingSourceContext: { context: ActiveSourceContext; imageHashes: Set<string>; attached: boolean } | undefined;
  const usage = { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 };
  const generatedImageHashes = new Set<string>();
  const activatePendingSource = () => {
    const pending = pendingSourceContext;
    if (!pending?.attached) return;
    try {
      pi.appendEntry("visual-context-source-context", pending.context);
      activeSourceContext = pending.context;
      pendingSourceContext = undefined;
    } catch {
      // Leave the pending context for the agent-end cleanup path.
    }
  };

  registerVisualContextCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    activeSourceContext = undefined;
    pendingSourceContext = undefined;
    for (const entry of ctx.sessionManager.getBranch().reverse()) {
      if (entry.type === "custom" && entry.customType === "visual-context-source-context") {
        activeSourceContext = activeSourceContextFromStored(entry.data);
      }
    }
  });

  // message_start only confirms that SOURCE images entered the user message.
  // Keep the candidate pending until the assistant turn succeeds.
  pi.on("message_start", (event) => {
    if (event.message.role !== "user" || !pendingSourceContext || !Array.isArray(event.message.content)) return;
    const attached = event.message.content.some((item: any) => item?.type === "image" && typeof item.data === "string" && pendingSourceContext!.imageHashes.has(imageHash(item.data)));
    if (!attached) return;
    pendingSourceContext.attached = true;
  });

  pi.on("turn_end", (event) => {
    const message = event.message as any;
    if (pendingSourceContext && (message?.stopReason === "error" || message?.stopReason === "aborted")) pendingSourceContext = undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.startsWith("@v ")) return { action: "continue" };
    ctx.ui.setWidget("visual-context-help", undefined);
    const status = (text: string) => ctx.ui.setStatus("visual-context", `visual-context: ${text}`);
    try {
      const parsed = parseVisualInput(event.text);
      const { sources, question, profile: profileName, render: preview, open, visualPrompt, tablet, symbol, symbols } = parsed;
      if (symbols !== undefined) {
        const listing = formatSymbolList(activeSourceContext, symbols || undefined);
        if (listing.error) ctx.ui.notify(`@v symbols failed: ${listing.error}`, "error");
        else ctx.ui.notify(listing.text!, "info");
        ctx.ui.setStatus("visual-context", undefined);
        return { action: "handled" };
      }
      if (tablet || symbol) {
        const navigation = resolveNavigation(activeSourceContext, { tablet, symbol }, question);
        if (navigation.error) {
          ctx.ui.notify(`@v navigation failed: ${navigation.error}`, "error");
          ctx.ui.setStatus("visual-context", undefined);
          return { action: "handled" };
        }
        status(`resolving ${tablet ?? `symbol ${symbol}`}`);
        ctx.ui.setStatus("visual-context", undefined);
        return { action: "transform", text: navigation.text! };
      }
      if ((activeSourceContext || pendingSourceContext) && sources.length && !preview) throw new Error("this conversation already has a source context; reference its VC tablets/symbols or start a new conversation");
      let taskResult;
      const taskOnlyConfirm = async (pageCount: number, chars: number, mode: "normal" | "preview") => confirmTabletBudget(ctx.ui, 0, pageCount, chars, maxTabletsFromEnvironment(), mode);
      const confirmTotal = async (sourceTablets: number, sourceChars: number, sourceCount: number, mode: "normal" | "preview") => confirmTabletBudget(ctx.ui, sourceCount, (taskResult?.images.length ?? 0) + sourceTablets, sourceChars, maxTabletsFromEnvironment(), mode);
      const renderTaskForSource = async () => {
        taskResult = visualPrompt ? await renderTask(question, (text) => status(`task ${text}`), sources.length ? {} : {
          beforeRasterize: async (pageCount, chars) => taskOnlyConfirm(pageCount, chars, preview ? "preview" : "normal"),
          onCacheHit: async (pageCount, chars) => taskOnlyConfirm(pageCount, chars, preview ? "preview" : "normal"),
        }) : undefined;
      };
      const rendered = sources.length ? await prepareSourceContext({
        cwd: ctx.cwd,
        sources,
        profile: profileName,
        onProgress: status,
        confirmSources: (count) => confirmFileBudget(ctx.ui, count),
        afterSourcesExpanded: renderTaskForSource,
        beforeRasterize: async (tabletCount, sourceChars) => visualPrompt ? confirmTotal(tabletCount, sourceChars, sources.length, preview ? "preview" : "normal") : confirmTabletBudget(ctx.ui, sources.length, tabletCount, sourceChars, maxTabletsFromEnvironment(), preview ? "preview" : "normal"),
        onCacheHit: preview ? (visualPrompt ? async (tabletCount, sourceChars) => confirmTotal(tabletCount, sourceChars, sources.length, "preview") : undefined) : async (tabletCount, sourceChars) => visualPrompt ? confirmTotal(tabletCount, sourceChars, sources.length, "normal") : confirmTabletBudget(ctx.ui, sources.length, tabletCount, sourceChars, maxTabletsFromEnvironment()),
      }) : undefined;
      if (sources.length && !rendered) {
        ctx.ui.setStatus("visual-context", undefined);
        return { action: "handled" };
      }
      if (!sources.length) await renderTaskForSource();
      const sourcePaths = rendered?.sourcePaths ?? [];
      const taskImages = taskResult?.images ?? [];
      const sourceImages = rendered?.images ?? [];
      const images = [...taskImages, ...sourceImages];
      const pageDimensions = [...(taskResult?.manifest.pageDimensions ?? []), ...(rendered?.manifest.pageDimensions ?? [])];
      if (visualPrompt) status(`ready: task ${taskImages.length} + source ${sourceImages.length} tablets`);
      else if (rendered?.manifest.cache?.hit) status(`cache hit · ${images.length} tablets`);
      else status(`ready: ${images.length} pages, ${pageDimensions.map((page) => `${page.width}x${page.height}`).join(", ")}`);
      Object.assign(usage, { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const firstBase = sourcePaths.length ? basename(sourcePaths[0], extname(sourcePaths[0])) : "task-only";
      const debugName = !sourcePaths.length ? "task-only" : sources.length === 1 ? firstBase : `${firstBase}-multi`;
      const debugDir = resolve(ctx.cwd, ".pi", "visual-context", `${stamp}-${debugName}`);
      await mkdir(debugDir, { recursive: true });
      const taskFiles = taskImages.map((_, index) => `task-${String(index + 1).padStart(3, "0")}.png`);
      const sourceFiles = (rendered?.images ?? []).map((_, index) => `source-${String(index + 1).padStart(3, "0")}.png`);
      const legacyPageFiles = (rendered?.images ?? []).map((_, index) => `page-${String(index + 1).padStart(3, "0")}.png`);
      const pageFiles = visualPrompt ? [...taskFiles, ...sourceFiles] : legacyPageFiles;
      for (let index = 0; index < images.length; index++) await writeFile(resolve(debugDir, pageFiles[index]), images[index]);
      for (const image of images) generatedImageHashes.add(imageHash(image));
      const requestManifest = visualPrompt
        ? buildVisualPromptRequestManifest(taskResult!.manifest, taskFiles, rendered?.manifest ?? null, rendered?.sourceManifests ?? [], sourceFiles, { ...usage })
        : buildContinuousRequestManifest(rendered!.sourceManifests, pageFiles, rendered!.manifest, { ...usage });
      const manifestPath = resolve(debugDir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(requestManifest, null, 2)}\n`);
      const sourceChars = rendered?.manifest.sourceChars ?? 0;
      if (preview) {
        ctx.ui.setStatus("visual-context", undefined);
        const previewSummary = visualPrompt ? `task ${taskImages.length} + source ${sourceImages.length} tablets` : `${compactNumber(images.length)} tablets`;
        ctx.ui.notify(`visual-context preview: ${sourcePaths.length} files · ${previewSummary} · ${compactNumber(sourceChars)} chars\n${debugDir}`, "info");
        if (open) await openPreview(debugDir, process.platform, undefined, visualPrompt ? "task-001.png" : "page-001.png");
        return { action: "handled" };
      }
      active = { manifestPath, manifest: requestManifest };
      if (sourcePaths.length && rendered) {
        const sourceContext = activeSourceContextFromManifest(rendered.manifest);
        if (sourceContext) pendingSourceContext = { context: sourceContext, imageHashes: new Set(sourceImages.map((image) => imageHash(image))), attached: false };
      }
      ctx.ui.setStatus("visual-context", undefined);
      const sourceTablets = rendered?.manifest.tablets ?? [];
      return {
        action: "transform",
        text: visualPrompt ? (sourcePaths.length ? buildVisualSourcePrompt(sourceTablets) : "Use the attached visual task to answer.") : buildHistoricalSourcePrompt(question, sourceTablets),
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
    const message = event.message as any;
    const assistantFailure = event.message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || Boolean(message.errorMessage));
    if (event.message.role === "assistant" && pendingSourceContext?.attached) {
      if (assistantFailure) pendingSourceContext = undefined;
      else activatePendingSource();
    }
    if (!active || event.message.role !== "assistant") return;
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
    if (pendingSourceContext) pendingSourceContext = undefined;
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
