import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EMBEDDING_DIMENSIONS, embeddingCoreStatus } from "../dist/index.js";

test("the built artifact carries no static transformers import", async () => {
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.equal(/from\s*["']@huggingface\/transformers["']/.test(source), false);
});

test("the runtime is imported only inside a dynamic import", async () => {
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.match(source, /import\(\s*["']@huggingface\/transformers["']\s*\)/);
});

test("importing the package loads no model", () => {
  assert.equal(embeddingCoreStatus().loaded, false);
});

test("the loader asks for the quantized weights by their v4 name", async () => {
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.match(source, /dtype:\s*["']q8["']/);
  assert.equal(/quantized:\s*true/.test(source), false);
});

test("the vector width has one owner", () => {
  assert.equal(EMBEDDING_DIMENSIONS, 1024);
  assert.equal(embeddingCoreStatus().dimensions, 1024);
});
