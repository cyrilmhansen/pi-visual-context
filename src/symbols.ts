import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL_INDEX_VERSION = "0.4c-1";

export type SymbolKind = "module" | "type" | "function" | "method" | "constant" | "static" | "macro";
export type SymbolAnchor = {
  sourceIndex: number;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  line: number;
  tabletIds: string[];
};
export type SymbolDiagnostic = { sourceIndex: number; message: string };
export type SymbolInput = { path: string; language: "Rust" | "C" | "Python" | "Text" };

type RawSymbol = Omit<SymbolAnchor, "sourceIndex" | "tabletIds">;

function lineNumber(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") line++;
    else if (source[index] === "\r" && source[index + 1] !== "\n") line++;
  }
  return line;
}

function maskNonCode(source: string, language: "Rust" | "C"): string {
  const chars = [...source];
  const blank = (index: number) => { if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " "; };
  let index = 0;
  let blockCommentDepth = 0;
  while (index < chars.length) {
    if (blockCommentDepth > 0) {
      if (chars[index] === "/" && chars[index + 1] === "*" && language === "Rust") { blank(index); blank(index + 1); index += 2; blockCommentDepth++; }
      else if (chars[index] === "*" && chars[index + 1] === "/") { blank(index); blank(index + 1); index += 2; blockCommentDepth--; }
      else { blank(index); index++; }
      continue;
    }
    if (chars[index] === "/" && chars[index + 1] === "/") {
      blank(index); blank(index + 1); index += 2;
      while (index < chars.length && chars[index] !== "\n" && chars[index] !== "\r") { blank(index); index++; }
      continue;
    }
    if (chars[index] === "/" && chars[index + 1] === "*") { blank(index); blank(index + 1); index += 2; blockCommentDepth = 1; continue; }
    if (language === "Rust" && chars[index] === "r") {
      let marker = index + 1;
      while (chars[marker] === "#") marker++;
      if (chars[marker] === '"') {
        const hashes = marker - index - 1;
        for (let cursor = index; cursor <= marker; cursor++) blank(cursor);
        index = marker + 1;
        while (index < chars.length) {
          if (chars[index] === '"') {
            let cursor = index + 1;
            while (cursor < chars.length && chars[cursor] === "#") cursor++;
            if (cursor - index - 1 === hashes) { for (let close = index; close < cursor; close++) blank(close); index = cursor; break; }
          }
          blank(index); index++;
        }
        continue;
      }
    }
    if (chars[index] === '"' || chars[index] === "'") {
      const quote = chars[index]; blank(index++);
      while (index < chars.length) {
        if (chars[index] === "\\") { blank(index++); if (index < chars.length) blank(index++); continue; }
        if (chars[index] === quote) { blank(index++); break; }
        blank(index++);
      }
      continue;
    }
    index++;
  }
  return chars.join("");
}

function rustSymbols(source: string): RawSymbol[] {
  const masked = maskNonCode(source, "Rust");
  const symbols: RawSymbol[] = [];
  const containers: { name: string; kind: "module" | "impl"; depth: number }[] = [];
  let depth = 0;
  const identifier = String.raw`[\p{L}_][\p{L}\p{N}_]*`;
  const id = `(${identifier})`;
  const add = (name: string, kind: SymbolKind, line: number) => {
    const prefix = containers.map((item) => item.name).filter(Boolean);
    symbols.push({ name, qualifiedName: [...prefix, name].join("::"), kind, line });
  };
  const lines = masked.split(/(?<=\n)|(?<=\r)(?!\n)/);
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const lineNo = lineNumber(source, offset);
    const impl = trimmed.match(new RegExp(String.raw`^impl(?:\s*<[^{}]*>)?\s+${id}(?:\s*<[^{}]*>)?(?:\s+for\s+${id})?\s*\{`, "u"));
    const module = trimmed.match(new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?mod\s+${id}\s*\{`, "u"));
    const macro = trimmed.match(new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?macro_rules!\s*${id}`, "u"));
    const declaration = trimmed.match(new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)*(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+${id}`, "u"));
    if (impl) {
      const target = trimmed.match(new RegExp(String.raw`^impl(?:\s*<[^{}]*>)?\s+(${identifier})(?:\s*<[^{}]*>)?(?:\s+for\s+(${identifier}))?`, "u"));
      const name = target?.[2] ?? target?.[1];
      if (name) containers.push({ name, kind: "impl", depth: depth + 1 });
    } else if (module) {
      const prefix = containers.map((item) => item.name).filter(Boolean);
      symbols.push({ name: module[1], qualifiedName: [...prefix, module[1]].join("::"), kind: "module", line: lineNo });
      containers.push({ name: module[1], kind: "module", depth: depth + 1 });
    } else if (macro) {
      add(macro[1], "macro", lineNo);
    } else if (declaration) {
      const kind = declaration[1] === "fn" ? (containers.at(-1)?.kind === "impl" ? "method" : "function") : declaration[1] === "struct" || declaration[1] === "enum" || declaration[1] === "trait" || declaration[1] === "type" ? "type" : declaration[1] === "const" ? "constant" : "static";
      add(declaration[2], kind, lineNo);
    }
    for (const character of line) {
      if (character === "{") depth++;
      else if (character === "}") depth--;
    }
    while (containers.length && depth < containers.at(-1)!.depth) containers.pop();
    offset += line.length;
  }
  return symbols;
}

function cSymbols(source: string): RawSymbol[] {
  const masked = maskNonCode(source, "C");
  const symbols: RawSymbol[] = [];
  const add = (name: string, kind: SymbolKind, line: number) => symbols.push({ name, qualifiedName: name, kind, line });
  const lines = masked.split(/(?<=\n)|(?<=\r)(?!\n)/);
  let offset = 0;
  for (const line of lines) {
    const lineNo = lineNumber(source, offset);
    const macro = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)/);
    const aggregate = line.match(/^\s*(?:typedef\s+)?(struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/);
    const typedef = line.match(/^\s*typedef\s+(?:(?:struct|union|enum)\s+)?[A-Za-z_]\w*(?:\s*\*)?\s+([A-Za-z_]\w*)\s*;/);
    const functionMatch = line.match(/^\s*(?:(?:static|extern|inline|unsigned|signed|long|short|const|volatile|struct|union|enum|[A-Za-z_]\w*)[\s*]+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/);
    if (macro) add(macro[1], "macro", lineNo);
    else if (aggregate) add(aggregate[2], "type", lineNo);
    else if (typedef) add(typedef[1], "type", lineNo);
    else if (functionMatch && !["if", "for", "while", "switch"].includes(functionMatch[1])) add(functionMatch[1], "function", lineNo);
    offset += line.length;
  }
  return symbols;
}

async function pythonSymbols(sourcePath: string): Promise<RawSymbol[]> {
  const binary = resolve(root, "tools/python-strip-lex/target/release/python-strip-lex");
  const { stdout } = await run(binary, ["--symbols-json", sourcePath]);
  const parsed = JSON.parse(stdout) as RawSymbol[];
  return parsed.filter((symbol) => Number.isInteger(symbol.line) && symbol.line >= 1 && typeof symbol.name === "string" && typeof symbol.qualifiedName === "string");
}

export async function extractSymbols(input: SymbolInput, sourceIndex: number): Promise<{ symbols: Omit<SymbolAnchor, "tabletIds" | "sourceIndex">[]; diagnostic?: SymbolDiagnostic }> {
  try {
    const source = await readFile(input.path, "utf8");
    const symbols = input.language === "Python" ? await pythonSymbols(input.path) : input.language === "Rust" ? rustSymbols(source) : input.language === "C" ? cSymbols(source) : [];
    return { symbols };
  } catch (error) {
    return { symbols: [], diagnostic: { sourceIndex, message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function extractAllSymbols(inputs: readonly SymbolInput[]): Promise<{ symbols: Omit<SymbolAnchor, "tabletIds">[]; diagnostics: SymbolDiagnostic[]; version: string }> {
  const results = await Promise.all(inputs.map((input, index) => extractSymbols(input, index)));
  const symbols = results.flatMap((result, sourceIndex) => result.symbols.map((symbol) => ({ ...symbol, sourceIndex })));
  symbols.sort((a, b) => a.sourceIndex - b.sourceIndex || a.line - b.line);
  return {
    symbols,
    diagnostics: results.flatMap((result) => result.diagnostic ? [result.diagnostic] : []),
    version: SYMBOL_INDEX_VERSION,
  };
}

export function mapSymbolsToTablets(symbols: readonly Omit<SymbolAnchor, "tabletIds">[], tablets: readonly { id?: string; spans: readonly { sourceIndex: number; startLine: number | null; endLine: number | null; bannerOnly?: boolean }[] }[]): SymbolAnchor[] {
  return symbols.map((symbol) => ({
    ...symbol,
    tabletIds: tablets.filter((tablet) => tablet.spans.some((span) => span.sourceIndex === symbol.sourceIndex && !span.bannerOnly && span.startLine !== null && span.endLine !== null && span.startLine <= symbol.line && symbol.line <= span.endLine)).map((tablet) => tablet.id).filter((id): id is string => typeof id === "string"),
  }));
}

export { SYMBOL_INDEX_VERSION };
