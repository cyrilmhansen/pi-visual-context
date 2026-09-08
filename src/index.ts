import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { parseVisualInput, renderRust } from "./rust";
import { getVisualProfile } from "./profile";

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
      const { source, question, profile: profileName } = parseVisualInput(event.text);
      const profile = getVisualProfile(profileName);
      const sourcePath = resolve(ctx.cwd, source);
      try { await access(sourcePath); } catch { throw new Error(`source file does not exist: ${source}`); }
      const sourceText = await readFile(sourcePath, "utf8");
      status(`${basename(sourcePath)} ${Buffer.byteLength(sourceText)} B / ${sourceText.length} chars`);
      const result = await renderRust(sourcePath, status, profile);
      const { manifest } = result;
      status(`ready: ${manifest.pageCount} pages, ${manifest.pageDimensions.map((page) => `${page.width}x${page.height}`).join(", ")}`);
      Object.assign(usage, { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const debugDir = resolve(ctx.cwd, ".pi", "visual-context", `${stamp}-${basename(sourcePath, ".rs")}`);
      await mkdir(debugDir, { recursive: true });
      for (let i = 0; i < result.images.length; i++) {
        await writeFile(resolve(debugDir, `page-${String(i + 1).padStart(3, "0")}.png`), result.images[i]);
      }
      const manifestPath = resolve(debugDir, "manifest.json");
      for (const image of result.images) generatedImageHashes.add(imageHash(image));
      const requestManifest = { ...manifest, sourcePath, pages: result.images.map((_, i) => `page-${String(i + 1).padStart(3, "0")}.png`), usage: { ...usage } };
      await writeFile(manifestPath, `${JSON.stringify(requestManifest, null, 2)}\n`);
      active = { manifestPath, manifest: requestManifest };
      ctx.ui.setStatus("visual-context", undefined);
      return {
        action: "transform",
        text: `Use the attached visual source context to answer the question.\n\n${question}`, 
        images: [...(event.images ?? []), ...result.images.map((data) => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/png" as const }))],
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
      ctx.ui.notify(`visual-context: ${manifest.pageCount} pages · ${compactNumber(Number(manifest.sourceChars))} chars · ${finalUsage.modelCallCount} call${finalUsage.modelCallCount === 1 ? "" : "s"} · ↑ ${compactNumber(finalUsage.input)} · ↓ ${compactNumber(finalUsage.output)} · R ${compactNumber(finalUsage.cacheRead)} · W ${compactNumber(finalUsage.cacheWrite)} · ${compactCost(finalUsage.totalCost)}`, "info");
    }
    active = undefined;
  });
}
