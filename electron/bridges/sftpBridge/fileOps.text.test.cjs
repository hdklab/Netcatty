const test = require("node:test");
const assert = require("node:assert/strict");

const { prepareWriteContent } = require("./fileOps.cjs");

test("normalizes CRLF to LF by default (programmatic writes)", () => {
  assert.equal(prepareWriteContent("a\r\nb\r\n"), "a\nb\n");
  assert.equal(prepareWriteContent("a\nb\n"), "a\nb\n");
  assert.equal(prepareWriteContent("mixed\r\nlines\nhere"), "mixed\nlines\nhere");
});

test("preserveLineEndings keeps the bytes the built-in editor holds", () => {
  assert.equal(prepareWriteContent("a\r\nb\r\n", true), "a\r\nb\r\n");
  assert.equal(prepareWriteContent("a\nb\n", true), "a\nb\n");
  // Only an explicit `true` opts out; anything else keeps the historical rule.
  assert.equal(prepareWriteContent("a\r\nb", "true"), "a\nb");
  assert.equal(prepareWriteContent("a\r\nb", undefined), "a\nb");
});
