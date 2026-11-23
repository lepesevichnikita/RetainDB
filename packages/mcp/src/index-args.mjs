/**
 * Argument vector for the `retaindb-index` CLI, kept separate from the MCP handler so the
 * mapping from tool arguments to flags can be tested without spawning a process.
 * @param {{ root: string, project?: string, graph?: boolean, dry_run?: boolean, batch?: number, delay?: number }} options
 */
export function buildIndexArgs(options) {
  const { root, project, graph = true, dry_run = false, batch, delay } = options;
  const args = ["--root", root];
  if (project) args.push("--project", project);
  if (graph) args.push("--graph");
  if (dry_run) args.push("--dry-run");
  if (batch) args.push("--batch", String(batch));
  if (delay !== undefined) args.push("--delay", String(delay));
  return args;
}
