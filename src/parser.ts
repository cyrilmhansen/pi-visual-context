export type VisualInput = { source: string; sources: string[]; question: string; profile: string; render: boolean; open: boolean; visualPrompt: boolean; tablet?: string; symbol?: string; symbols?: string };

export function parseVisualInput(text: string): VisualInput {
  if (!text.startsWith("@v ")) throw new Error("not a visual-context input");
  const rest = text.slice(3);
  const spacedSeparator = rest.indexOf(" -- ");
  const endSeparator = spacedSeparator < 0 && /\s--$/.test(rest.trim()) ? rest.lastIndexOf(" --") : -1;
  const separator = spacedSeparator >= 0 ? spacedSeparator : endSeparator;
  const separatorLength = spacedSeparator >= 0 ? 4 : 3;
  const sourceText = separator < 0 ? rest.trim() : rest.slice(0, separator).trim();
  const sourceArgs = sourceText.split(/\s+/).filter(Boolean);
  const question = separator < 0 ? "" : rest.slice(separator + separatorLength).trim();
  let profile = "normal";
  let render = false;
  let open = false;
  let visualPrompt = false;
  let tablet: string | undefined;
  let symbol: string | undefined;
  let symbols: string | undefined;
  let profileSpecified = false;
  const sources: string[] = [];
  for (let index = 0; index < sourceArgs.length; index++) {
    const argument = sourceArgs[index];
    if (argument === "--render") render = true;
    else if (argument === "--open") open = true;
    else if (argument === "--visual-prompt") visualPrompt = true;
    else if (argument === "--profile") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v profile syntax; use: --profile <name>");
      profile = value;
      profileSpecified = true;
    } else if (argument === "--tablet") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v tablet syntax; use: --tablet <id>");
      tablet = value;
    } else if (argument === "--symbol") {
      const value = sourceArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("malformed @v symbol syntax; use: --symbol <name>");
      symbol = value;
    } else if (argument === "--symbols") {
      if (symbols !== undefined) throw new Error("malformed @v symbols syntax; use: --symbols [query]");
      const value = sourceArgs[index + 1];
      if (value && !value.startsWith("--")) { symbols = value; index++; }
      else symbols = "";
    } else sources.push(argument);
  }
  if (open) render = true;
  if (symbols !== undefined) {
    if (sources.length) throw new Error("--symbols cannot be combined with source paths");
    if (tablet || symbol) throw new Error("--symbols cannot be combined with navigation targets");
    if (visualPrompt) throw new Error("--symbols cannot be combined with --visual-prompt");
    if (render || open) throw new Error("--symbols cannot be combined with --render or --open");
    if (profileSpecified) throw new Error("--symbols cannot be combined with --profile");
    if (question) throw new Error("--symbols is a local query and does not accept a question");
  }
  if (tablet && symbol) throw new Error("--tablet and --symbol cannot be used together");
  if (tablet || symbol) {
    if (sources.length) throw new Error("navigation targets cannot be combined with source paths");
    if (visualPrompt) throw new Error("navigation cannot be combined with --visual-prompt");
    if (render || open) throw new Error("navigation cannot be combined with --render or --open");
    if (profileSpecified) throw new Error("navigation cannot be combined with --profile");
    if (!question) throw new Error("navigation requires a non-empty question");
  }
  if (!sources.length && (!visualPrompt || !question) && !tablet && !symbol && symbols === undefined) throw new Error(visualPrompt ? "visual prompt without sources requires a non-empty prompt" : "malformed @v syntax; source paths and question are required");
  if (!question && !render && !tablet && !symbol && symbols === undefined) throw new Error("malformed @v syntax; source paths and question are required");
  return { source: sources[0], sources, question, profile, render, open, visualPrompt, ...(tablet ? { tablet } : {}), ...(symbol ? { symbol } : {}), ...(symbols !== undefined ? { symbols } : {}) };
}
