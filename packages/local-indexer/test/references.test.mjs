import test from "node:test";
import assert from "node:assert/strict";
import { extractReferences, referenceEdges, resolveReference } from "../src/references.mjs";

test("markdown links, images, wiki links and imports are all references", () => {
  const text = [
    "See [the guide](../docs/guide.md) and ![diagram](./img/flow.png).",
    "Inline [[architecture]] link, import { x } from \"./util\";",
    "External [site](https://example.com) and [anchor](#top) are not files.",
  ].join("\n");
  const found = extractReferences(text);
  assert.ok(found.includes("../docs/guide.md"));
  assert.ok(found.includes("./img/flow.png"));
  assert.ok(found.includes("architecture"));
  assert.ok(found.includes("./util"));
  assert.ok(!found.some((target) => target.startsWith("https://")));
  assert.ok(!found.includes("#top"));
});

test("a relative reference resolves against the file that made it", () => {
  const known = new Set(["packages/app/src/util.ts", "docs/guide.md"]);
  assert.equal(resolveReference("packages/app/src/main.ts", "./util", known), "packages/app/src/util.ts");
  assert.equal(resolveReference("packages/app/src/main.ts", "../src/util.ts", known), "packages/app/src/util.ts");
  assert.equal(resolveReference("README.md", "docs/guide.md", known), "docs/guide.md");
});

test("a reference to a file the index does not hold is dropped, not stored as a blind name", () => {
  const known = new Set(["a.ts"]);
  assert.equal(resolveReference("a.ts", "./missing", known), null);
  assert.deepEqual(referenceEdges("a.ts", "[x](./missing.md)", known), []);
});

test("a self reference never becomes an edge", () => {
  const known = new Set(["a.md"]);
  assert.deepEqual(referenceEdges("a.md", "[me](./a.md)", known), []);
});

test("an edge names both ends as files that exist", () => {
  const known = new Set(["docs/guide.md", "README.md"]);
  assert.deepEqual(referenceEdges("README.md", "[guide](docs/guide.md)", known), [
    { from: "README.md", to: "docs/guide.md", kind: "references" },
  ]);
});
