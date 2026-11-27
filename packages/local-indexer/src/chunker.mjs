/**
 * Splits one source file into chunks a reader can quote.
 *
 * Symbols first: a tree-sitter grammar names every function, class and method, so a chunk
 * is a real unit of code. Adjacent small symbols are merged until the window is worth
 * embedding, and any file without a grammar, or with no symbols at all, falls back to line
 * windows. Both paths return the same shape.
 */
import { createRequire } from "node:module";

const WINDOW_LINES = 60;
const OVERLAP_LINES = 8;
const MERGE_GAP_LINES = 3;
const MAX_CHUNK_CHARS = 12_000;

const GRAMMARS = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

const SYMBOL_TYPES = new Set([
  "function_declaration", "class_declaration", "method_definition", "interface_declaration",
  "type_alias_declaration", "enum_declaration", "lexical_declaration", "variable_declaration",
  "function_definition", "class_definition", "function_item", "impl_item", "struct_item",
  "enum_item", "trait_item", "method_declaration", "type_declaration",
]);
const WRAPPER_TYPES = new Set(["export_statement", "decorated_definition"]);

const parserCache = new Map();

async function loadParser(extension) {
  const grammar = GRAMMARS[extension];
  if (!grammar) return null;
  if (parserCache.has(grammar)) return parserCache.get(grammar);
  const { Parser, Language } = await import("web-tree-sitter");
  await Parser.init();
  const require = createRequire(import.meta.url);
  const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  parserCache.set(grammar, parser);
  return parser;
}

function collectSymbols(node, found) {
  for (const child of node.namedChildren) {
    if (WRAPPER_TYPES.has(child.type)) collectSymbols(child, found);
    else if (SYMBOL_TYPES.has(child.type)) found.push(child);
    else if (child.namedChildren.length > 0 && child.type.endsWith("declaration")) collectSymbols(child, found);
  }
  return found;
}

function nameOf(node) {
  const named = node.childForFieldName("name");
  return named ? named.text.slice(0, 120) : node.type;
}

function symbolRanges(source, parser) {
  const tree = parser.parse(source);
  const nodes = collectSymbols(tree.rootNode, []);
  const ranges = nodes.map((node) => ({
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
    symbol: nameOf(node),
  }));
  return ranges.filter((range) => range.end >= range.start).sort((a, b) => a.start - b.start);
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const tail = merged[merged.length - 1];
    const touches = tail && range.start - tail.end <= MERGE_GAP_LINES;
    const fits = tail && range.end - tail.start <= WINDOW_LINES;
    if (touches && fits) tail.end = Math.max(tail.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function lineRanges(total) {
  const step = WINDOW_LINES - OVERLAP_LINES;
  const ranges = [];
  for (let start = 1; start <= total; start += step) {
    const end = Math.min(start + WINDOW_LINES - 1, total);
    ranges.push({ start, end, symbol: null });
    if (end === total) break;
  }
  return ranges;
}

function toChunk(lines, range) {
  const body = lines.slice(range.start - 1, range.end).join("\n");
  return { start_line: range.start, end_line: range.end, symbol: range.symbol, content: body.slice(0, MAX_CHUNK_CHARS) };
}

export async function chunkSource(text, extension) {
  const lines = text.split("\n");
  let ranges = [];
  try {
    const parser = await loadParser(extension);
    if (parser) ranges = mergeRanges(symbolRanges(text, parser));
  } catch {
    ranges = [];
  }
  if (ranges.length === 0) ranges = lineRanges(lines.length);
  return ranges.map((range) => toChunk(lines, range)).filter((chunk) => chunk.content.trim().length > 0);
}

export const CHUNKER = { WINDOW_LINES, OVERLAP_LINES, MAX_CHUNK_CHARS };
