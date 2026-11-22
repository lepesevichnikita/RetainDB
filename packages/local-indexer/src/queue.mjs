/**
 * A persisted FIFO of pending writes.
 *
 * Every entry has a key. Adding a key that is already queued replaces its payload, so a
 * chunk of the same file and range keeps only its newest copy instead of piling up. The
 * queue is saved after every batch, so a killed run resumes with what is left.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapLimit(entries, limit, run) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(entries[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class IndexQueue {
  constructor(path) {
    this.path = path;
    this.entries = new Map();
  }

  static async open(path) {
    const queue = new IndexQueue(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      for (const [key, payload] of parsed.entries ?? []) queue.entries.set(key, payload);
    } catch {
      queue.entries = new Map();
    }
    return queue;
  }

  get size() {
    return this.entries.size;
  }

  add(key, payload) {
    this.entries.set(key, payload);
  }

  take(limit) {
    const batch = [];
    for (const entry of this.entries) {
      batch.push(entry);
      if (batch.length === limit) break;
    }
    return batch;
  }

  drop(keys) {
    for (const key of keys) this.entries.delete(key);
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const file = `${this.path}.${process.pid}.tmp`;
    await writeFile(file, `${JSON.stringify({ entries: [...this.entries] })}\n`, "utf8");
    await rename(file, this.path);
  }
}

/**
 * Drain the queue in windows of `groupSize * concurrency`, handing each worker one group.
 * A group is one request when the caller batches, one entry when it does not. Keys are
 * dropped only after their group succeeded, so an interrupted run resumes with the rest.
 */
export async function drainQueue(queue, handler, options) {
  const { groupSize = 1, concurrency = 1, delayMs = 0 } = options;
  let sent = 0;
  while (queue.size > 0) {
    const window = queue.take(groupSize * concurrency);
    const groups = [];
    for (let index = 0; index < window.length; index += groupSize) {
      groups.push(window.slice(index, index + groupSize));
    }
    await mapLimit(groups, concurrency, (group) => handler(
      group.map((entry) => entry[1]),
      group.map((entry) => entry[0]),
    ));
    queue.drop(window.map((entry) => entry[0]));
    await queue.save();
    sent += window.length;
    if (delayMs > 0 && queue.size > 0) await sleep(delayMs);
  }
  return sent;
}
