export const DEFAULT_MAX_TABLETS = 10;
export const DEFAULT_CONFIRM_FILES = 20;

export function maxTabletsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const value = Number(environment.PI_VISUAL_CONTEXT_MAX_TABLETS ?? DEFAULT_MAX_TABLETS);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_TABLETS;
}

export function shouldConfirmTablets(tablets: number, maxTablets = maxTabletsFromEnvironment()): boolean {
  return tablets > maxTablets;
}

export function confirmFilesFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const value = Number(environment.PI_VISUAL_CONTEXT_CONFIRM_FILES ?? DEFAULT_CONFIRM_FILES);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CONFIRM_FILES;
}

export function fileConfirmationMessage(files: number): string {
  return `visual-context: glob matched ${files} files.\nRender them?`;
}

export async function confirmFileBudget(
  ui: { confirm(title: string, message: string): Promise<boolean> },
  files: number,
  threshold = confirmFilesFromEnvironment(),
): Promise<boolean> {
  if (files <= threshold) return true;
  return ui.confirm("visual-context", fileConfirmationMessage(files));
}

export function tabletConfirmationMessage(files: number, tablets: number, chars: number, mode: "normal" | "preview" = "normal"): string {
  if (mode === "preview") return `visual-context: ${files} files · ${tablets} tablets\nRasterize ${tablets} preview tablets?`;
  const compact = chars < 1000 ? String(chars) : `${Number((chars / 1000).toPrecision(3))}k`;
  return `visual-context: ${files} files · ${tablets} tablets · ${compact} chars\nSend ${tablets} images to the model?`;
}

export async function confirmTabletBudget(
  ui: { confirm(title: string, message: string): Promise<boolean> },
  files: number,
  tablets: number,
  chars: number,
  maxTablets = maxTabletsFromEnvironment(),
  mode: "normal" | "preview" = "normal",
): Promise<boolean> {
  if (!shouldConfirmTablets(tablets, maxTablets)) return true;
  return ui.confirm("visual-context", tabletConfirmationMessage(files, tablets, chars, mode));
}
