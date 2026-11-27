import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, EMBEDDING_DIMENSIONS, assertDimensions, resolveModel } from "../src/embedder.mjs";

test("a bare --embed means the default 1024-dimension model", () => {
  assert.equal(resolveModel(true), DEFAULT_MODEL);
  assert.equal(resolveModel(""), "");
});

test("an explicit model name is kept as given", () => {
  assert.equal(resolveModel("Xenova/multilingual-e5-large"), "Xenova/multilingual-e5-large");
});

test("a vector of the stored dimension passes through untouched", () => {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
  assert.equal(assertDimensions(vector, DEFAULT_MODEL), vector);
});

test("a vector of any other dimension is refused with the model named", () => {
  assert.throws(
    () => assertDimensions(new Array(384).fill(0.1), "Xenova/bge-small-en-v1.5"),
    /384 dimensions; RetainDB stores 1024/,
  );
});
