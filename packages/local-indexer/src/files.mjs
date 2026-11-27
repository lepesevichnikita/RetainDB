import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Directories that are build output or dependency stores, never the repository's own source.
 * Only used when the target is not a git work tree, because there git already answers this
 * question through .gitignore.
 */
const DEFAULT_SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".next", ".nuxt", ".turbo", ".cache", "coverage",
]);

async function gitFiles(root) {
  try {
    const { stdout } = await run(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter(Boolean);
    if (files.length === 0) return null;
    return [...new Set(files)];
  } catch {
    return null;
  }
}

async function walk(root, dir = root, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && DEFAULT_SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, found);
    else if (entry.isFile()) found.push(relative(root, full));
  }
  return found;
}

/**
 * The files an index should hold: what git tracks plus what git does not ignore. Honouring
 * .gitignore is the whole point — a tree with node_modules or vendored code must not turn
 * into thousands of chunks nobody asked for. A directory outside git falls back to skipping
 * the standard dependency and build directories.
 */
export async function listFiles(root) {
  const tracked = await gitFiles(root);
  return tracked ?? (await walk(root));
}
