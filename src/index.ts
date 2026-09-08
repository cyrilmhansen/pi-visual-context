import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { parseVisualInput, renderC, renderRust } from "./rust";
import { getVisualProfile } from "./profile";
import { buildRequestManifest } from "./manifest";

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

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.startsWith("@v ")) return { action: "continue" };
    const status = (text: string) => ctx.ui.setStatus("visual-context", `visual-context: ${text}`);
    try {
      const { sources, question, profile: profileName } = parseVisualInput(event.text);
      const profile = getVisualProfile(profileName);
      const sourcePaths = sources.map((source) => resolve(ctx.cwd, source));
      for (let i = 0; i < sourcePaths.length; i++) {
        try { await access(sourcePaths[i]); } catch { throw new Error(`source file does not exist: ${sources[i]}`); }
      }
      const rendered = [] as Array<{ path: string; result: Awaited<ReturnType<typeof renderRust>> }>;
      for (const sourcePath of sourcePaths) {
        const sourceText = await readFile(sourcePath, "utf8");
        status(`${basename(sourcePath)} ${Buffer.byteLength(sourceText)} B / ${sourceText.length} chars`);
        const extension = extname(sourcePath).toLowerCase();
        const result = extension === ".rs"
          ? await renderRust(sourcePath, status, profile)
          : await renderC(sourcePath, status, profile);
        rendered.push({ path: sourcePath, result });
      }
      const images = rendered.flatMap(({ result }) => result.images);
      const pageDimensions = rendered.flatMap(({ result }) => result.manifest.pageDimensions);
      status(`ready: ${images.length} pages, ${pageDimensions.map((page) => `${page.width}x${page.height}`).join(", ")}`);
      Object.assign(usage, { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const firstBase = basename(sourcePaths[0], extname(sourcePaths[0]));
      const debugName = sources.length === 1 ? firstBase : `${firstBase}-multi`;
      const debugDir = resolve(ctx.cwd, ".pi", "visual-context", `${stamp}-${debugName}`);
      await mkdir(debugDir, { recursive: true });
      const pageFilesBySource: string[][] = [];
      let pageOffset = 0;
      for (const item of rendered) {
        const pageFiles = item.result.images.map((_, index) => `page-${String(pageOffset + index + 1).padStart(3, "0")}.png`);
        for (let i = 0; i < item.result.images.length; i++) await writeFile(resolve(debugDir, pageFiles[i]), item.result.images[i]);
        pageOffset += item.result.images.length;
        pageFilesBySource.push(pageFiles);
      }
      for (const image of images) generatedImageHashes.add(imageHash(image));
      const requestManifest = buildRequestManifest(rendered.map((item) => ({ path: item.path, manifest: item.result.manifest })), pageFilesBySource, profile, { ...usage });
      const manifestPath = resolve(debugDir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(requestManifest, null, 2)}\n`);
      active = { manifestPath, manifest: requestManifest };
      ctx.ui.setStatus("visual-context", undefined);
      return {
        action: "transform",
        text: `Use the attached visual source context to answer the question.\n\n${question}`,
        images: [...(event.images ?? []), ...images.map((data) => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/png" as const }))],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status(`failed: ${message}`);
      ctx.ui.notify(`@v failed: ${message}`, "error");
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
