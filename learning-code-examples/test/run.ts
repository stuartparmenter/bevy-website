// Tests for the learning-code-examples TS port.
import { strict as assert } from "node:assert";

import {
  anchorNames,
  extractAnchor,
  parseExampleEntries,
  validateAnchors,
} from "../lib.ts";

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

// --- extractAnchor: parity with the file_code_block shortcode ---

// The example from learning-code-examples/README.md.
const SAMPLE = [
  "// ANCHOR: full_program",
  "use bevy::prelude::*;",
  "",
  "// ANCHOR: basic_component",
  "#[derive(Component)]",
  "struct BasicComponent;",
  "// ANCHOR_END: basic_component",
  "",
  "// ANCHOR: basic_system",
  "fn basic_system(mut commands: Commands) {",
  "  commands.spawn(BasicComponent);",
  '  eprintln!("spawning basic component"); // HIDE',
  "}",
  "// ANCHOR_END: basic_system",
  "",
  "// ANCHOR: app_main",
  "fn main() {",
  "  App::new().add_systems(Startup, basic_system).run();",
  '  eprintln!("app ran"); // HIDE',
  "}",
  "// ANCHOR_END: app_main",
  "// ANCHOR_END: full_program",
].join("\n");

test("extract_simple_anchor", () => {
  assert.equal(extractAnchor(SAMPLE, "basic_component"), "#[derive(Component)]\nstruct BasicComponent;\n");
});

test("extract_drops_hidden_lines", () => {
  assert.equal(
    extractAnchor(SAMPLE, "basic_system"),
    "fn basic_system(mut commands: Commands) {\n  commands.spawn(BasicComponent);\n}\n",
  );
});

test("extract_nested_excludes_inner_markers", () => {
  // full_program wraps the others; inner ANCHOR/ANCHOR_END marker lines and
  // HIDE lines are excluded, matching the shortcode.
  const expected =
    "use bevy::prelude::*;\n" +
    "\n" +
    "#[derive(Component)]\n" +
    "struct BasicComponent;\n" +
    "\n" +
    "fn basic_system(mut commands: Commands) {\n" +
    "  commands.spawn(BasicComponent);\n" +
    "}\n" +
    "\n" +
    "fn main() {\n" +
    "  App::new().add_systems(Startup, basic_system).run();\n" +
    "}\n";
  assert.equal(extractAnchor(SAMPLE, "full_program"), expected);
});

test("extract_missing_anchor_is_empty", () => {
  assert.equal(extractAnchor(SAMPLE, "does_not_exist"), "");
});

test("anchor_names", () => {
  assert.deepEqual(
    [...anchorNames(SAMPLE)].sort(),
    ["app_main", "basic_component", "basic_system", "full_program"],
  );
});

// --- validateAnchors ---

test("validate_clean_file", () => {
  assert.deepEqual(validateAnchors("f.rs", SAMPLE), []);
});

test("validate_unclosed", () => {
  const code = "// ANCHOR: foo\nlet x = 1;\n";
  const issues = validateAnchors("f.rs", code);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "unclosed-anchor");
  assert.equal(issues[0].anchor, "foo");
});

test("validate_unmatched_end", () => {
  const code = "let x = 1;\n// ANCHOR_END: foo\n";
  const issues = validateAnchors("f.rs", code);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "unmatched-end");
});

test("validate_duplicate", () => {
  const code = "// ANCHOR: foo\n// ANCHOR: foo\nx\n// ANCHOR_END: foo\n";
  const issues = validateAnchors("f.rs", code);
  assert.ok(issues.some((i) => i.kind === "duplicate-anchor" && i.anchor === "foo"));
});

test("validate_empty_anchor", () => {
  // Region contains only a HIDE line, so it renders nothing.
  const code = "// ANCHOR: foo\nx = 1; // HIDE\n// ANCHOR_END: foo\n";
  const issues = validateAnchors("f.rs", code);
  assert.ok(issues.some((i) => i.kind === "empty-anchor" && i.anchor === "foo"));
});

// --- parseExampleEntries ---

test("parse_example_entries", () => {
  const toml = [
    "[package]",
    'name = "learning-code-examples"',
    "",
    "[[example]]",
    'name = "getting-started-v1"',
    'path = "examples/quick-start/getting_started_v1.rs"',
    "",
    "[[example]]",
    'name = "position-ecs"',
    'path = "examples/quick-start/position_ecs.rs"',
  ].join("\n");
  const entries = parseExampleEntries(toml);
  assert.deepEqual(entries, [
    { name: "getting-started-v1", path: "examples/quick-start/getting_started_v1.rs" },
    { name: "position-ecs", path: "examples/quick-start/position_ecs.rs" },
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
