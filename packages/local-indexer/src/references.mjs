/**
 * Turns the references a text file makes into graph edges between real files.
 *
 * A reference is only useful when it points at something that exists in the index: an
 * unresolved target would create a node nobody can open, so it is dropped instead of stored.
 */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const HTML_REF = /(?:href|src)\s*=\s*["']([^"'#?]+)["']/g;
const CODE_IMPORT =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*|export\s+[^'"]*?\s+from\s+)["']([^"']+)["']/g;
const C_INCLUDE = /^\s*#include\s+["']([^"']+)["']/gm;

const SKIP_PREFIX = /^(?:[a-z]+:|\/\/|mailto:|tel:|#)/i;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".py", ".go", ".rs", ".sql", ".yaml", ".yml"];

export function extractReferences(text) {
  const found = new Set();
  for (const pattern of [MARKDOWN_LINK, WIKI_LINK, HTML_REF, CODE_IMPORT, C_INCLUDE]) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1].trim();
      if (target && !SKIP_PREFIX.test(target)) found.add(target);
    }
  }
  return [...found];
}

function joinPath(fromPath, target) {
  const parts = fromPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * A reference resolves only if the index already holds the file it names, so the edge always
 * has two ends that exist.
 */
export function resolveReference(fromPath, target, knownFiles) {
  const base = target.startsWith("/")
    ? target.replace(/^\/+/, "")
    : joinPath(fromPath, target);
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = `${base}/index${extension}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

export function referenceEdges(fromPath, text, knownFiles) {
  const edges = [];
  for (const target of extractReferences(text)) {
    const resolved = resolveReference(fromPath, target, knownFiles);
    if (resolved && resolved !== fromPath) edges.push({ from: fromPath, to: resolved, kind: "references" });
  }
  return edges;
}
