import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseVisualInput, renderRust } from "./rust";

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

export default function (pi: ExtensionAPI) {
  let active: { manifestPath: string; manifest: Record<string, unknown> } | undefined;
  const usage = { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 };

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.startsWith("@v ")) return { action: "continue" };
    const status = (text: string) => ctx.ui.setStatus("visual-context", `visual-context: ${text}`);
    try {
      const { source, question } = parseVisualInput(event.text);
      const sourcePath = resolve(ctx.cwd, source);
      try { await access(sourcePath); } catch { throw new Error(`source file does not exist: ${source}`); }
      const sourceText = await readFile(sourcePath, "utf8");
      status(`${basename(sourcePath)} ${Buffer.byteLength(sourceText)} B / ${sourceText.length} chars`);
      const result = await renderRust(sourcePath, status);
      const { manifest } = result;
      status(`ready: ${manifest.pageCount} pages, ${manifest.pageWidth}x${manifest.pageHeight}`);
      Object.assign(usage, { modelCallCount: 0, assistantMessageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalCost: 0 });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const debugDir = resolve(ctx.cwd, ".pi", "visual-context", `${stamp}-${basename(sourcePath, ".rs")}`);
      await mkdir(debugDir, { recursive: true });
      for (let i = 0; i < result.images.length; i++) {
        await writeFile(resolve(debugDir, `page-${String(i + 1).padStart(3, "0")}.png`), result.images[i]);
      }
      const manifestPath = resolve(debugDir, "manifest.json");
      const requestManifest = { ...manifest, sourcePath, pages: result.images.map((_, i) => `page-${String(i + 1).padStart(3, "0")}.png`), usage: { ...usage } };
      await writeFile(manifestPath, `${JSON.stringify(requestManifest, null, 2)}\n`);
      active = { manifestPath, manifest: requestManifest };
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

  pi.on("agent_end", async () => {
    if (!active) return;
    const manifest = { ...active.manifest, usage: { ...usage } };
    await writeFile(active.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    active = undefined;
  });
}
