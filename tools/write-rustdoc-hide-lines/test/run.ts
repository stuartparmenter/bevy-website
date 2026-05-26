// Tests ported from the Rust crate's `#[cfg(test)]` modules.
import { strict as assert } from "node:assert";

import { getHiddenRanges } from "../src/hidden_ranges.ts";
import { CodeBlockDefinition } from "../src/code_block_definition.ts";
import { formatFile } from "../src/formatter.ts";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(`  ${(e as Error).message}`);
  }
}

const splitLines = (code: string): string[] => code.split("\n");

// --- hidden_ranges tests ---

test("empty_block", () => {
  assert.deepEqual(getHiddenRanges(splitLines("")), []);
});

test("no_hidden", () => {
  const code = splitLines("1\n2\n3\n4\n5\n");
  assert.deepEqual(getHiddenRanges(code), []);
});

test("single_range", () => {
  const code = splitLines("# 1\n# 2\n# 3\n4\n5\n");
  assert.deepEqual(getHiddenRanges(code), [{ start: 1, end: 3 }]);
});

test("single_range_no_content", () => {
  const code = splitLines("#\n#\n#\n4\n5\n");
  assert.deepEqual(getHiddenRanges(code), [{ start: 1, end: 3 }]);
});

test("multi_range", () => {
  const code = splitLines("# 1\n# 2\n3\n# 4\n# 5\n");
  assert.deepEqual(getHiddenRanges(code), [
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ]);
});

test("single_line_range", () => {
  const code = splitLines("1\n2\n3\n4\n# 5\n");
  assert.deepEqual(getHiddenRanges(code), [{ start: 5, end: 5 }]);
});

// --- code_block_definition tests ---

test("should_ignore_malformed_lines", () => {
  for (const c of ["text line", "```", "```js"]) {
    assert.equal(CodeBlockDefinition.new(c), null);
  }
});

test("should_parse_simple_lines", () => {
  for (const c of ["```rust", "```rs"]) {
    const def = CodeBlockDefinition.new(c)!;
    assert.notEqual(def, null);
    assert.equal(def.intoString(), c);
  }
});

test("should_parse_other_annotations", () => {
  const line = "```rs,linenos,linenostart=10  , hl_lines=3-4 8-9";
  const def = CodeBlockDefinition.new(line)!;
  assert.equal(def.intoString(), line);
});

test("should_parse_hide_lines_annotations", () => {
  const line = "```rust,hide_lines=3-4 9";
  const def = CodeBlockDefinition.new(line)!;
  assert.deepEqual(def.getHiddenRanges(), [
    { start: 3, end: 4 },
    { start: 9, end: 9 },
  ]);
  assert.equal(def.intoString(), line);
});

test("should_parse_annotations", () => {
  const line = "```rust,   linenos,hide_lines=3-9   ,linenostart=10  ,hl_lines=10-12";
  const def = CodeBlockDefinition.new(line)!;
  assert.deepEqual(def.getHiddenRanges(), [{ start: 3, end: 9 }]);
  assert.equal(
    def.intoString(),
    "```rust,   linenos,hide_lines=3-9,linenostart=10  ,hl_lines=10-12",
  );
});

// --- formatter tests ---

test("add_missing_annotation", () => {
  const markdown = [
    "```rust",
    "# test",
    "# test 2",
    "fn not_hidden() {",
    "",
    "}",
    "# test 3",
    "#[derive(Component)]",
    "struct A;",
    "# #[derive(Component)]",
    "struct B;",
    "```",
    "",
  ].join("\n");

  const expected = [
    "```rust,hide_lines=1-2 6 9",
    "# test",
    "# test 2",
    "fn not_hidden() {",
    "",
    "}",
    "# test 3",
    "#[derive(Component)]",
    "struct A;",
    "# #[derive(Component)]",
    "struct B;",
    "```",
    "",
  ].join("\n");

  assert.equal(formatFile(markdown), expected);
});

test("update_wrong_annotation", () => {
  const markdown = [
    "```rust,hide_lines=2-3 7",
    "# test",
    "# test 2",
    "fn not_hidden() {",
    "",
    "}",
    "# test 3",
    "```",
    "",
  ].join("\n");

  const expected = [
    "```rust,hide_lines=1-2 6",
    "# test",
    "# test 2",
    "fn not_hidden() {",
    "",
    "}",
    "# test 3",
    "```",
    "",
  ].join("\n");

  assert.equal(formatFile(markdown), expected);
});

test("remove_annotation", () => {
  const markdown = [
    "```rust,hide_lines=2-3 7",
    "fn not_hidden() {",
    "",
    "}",
    "```",
    "",
  ].join("\n");

  const expected = ["```rust", "fn not_hidden() {", "", "}", "```", ""].join(
    "\n",
  );

  assert.equal(formatFile(markdown), expected);
});

test("indented", () => {
  const markdown =
    "\n" +
    "    ```rust\n" +
    "    # test\n" +
    "    # test 2\n" +
    "    fn not_hidden() {\n" +
    "\n" +
    "    }\n" +
    "    # test 3\n" +
    "    #[derive(Component)]\n" +
    "    struct A;\n" +
    "    # #[derive(Component)]\n" +
    "    struct B;\n" +
    "    ```\n";

  const expected =
    "\n" +
    "    ```rust,hide_lines=1-2 6 9\n" +
    "    # test\n" +
    "    # test 2\n" +
    "    fn not_hidden() {\n" +
    "\n" +
    "    }\n" +
    "    # test 3\n" +
    "    #[derive(Component)]\n" +
    "    struct A;\n" +
    "    # #[derive(Component)]\n" +
    "    struct B;\n" +
    "    ```\n";

  assert.equal(formatFile(markdown), expected);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
