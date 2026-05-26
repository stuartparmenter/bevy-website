// Port of the `learning-code-examples` crate's tooling to TypeScript.
//
// The original crate (`../../learning-code-examples/`) is a Cargo "examples"
// project: a collection of `.rs` files under `examples/` plus a
// `validate_examples.sh` that runs `cargo check --examples`,
// `cargo clippy --examples -- -Dwarnings`, and `cargo fmt --check`.
//
// There is no Rust source (`src/`) to port — the only logic is the shell
// validation. The compilation/lint/format checks inherently require `cargo`
// and the Rust toolchain, so those are reproduced by shelling out to `cargo`
// (see `validate.ts`). This module provides the non-cargo logic that can run
// without a Rust toolchain: parsing the `[[example]]` entries from
// `Cargo.toml`, extracting/validating the `// ANCHOR:` regions inside the
// example files, and checking that anchors referenced by site content exist.
//
// The anchor-extraction logic mirrors the `file_code_block` shortcode exactly
// (see `astro-site/src/lib/shortcodes.ts` `extractAnchor` and
// `templates/shortcodes/file_code_block.md`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ExampleEntry {
  /** `name = "..."` from the `[[example]]` table. */
  name: string;
  /** `path = "..."` relative to the crate root, e.g. `examples/quick-start/foo.rs`. */
  path: string;
}

export interface AnchorIssue {
  /** Crate-relative path of the example file the issue was found in. */
  file: string;
  kind:
    | "duplicate-anchor" // same anchor name opened twice
    | "unclosed-anchor" // ANCHOR with no matching ANCHOR_END
    | "unmatched-end" // ANCHOR_END with no matching ANCHOR
    | "empty-anchor"; // anchor region produced no rendered lines
  anchor: string;
  /** 1-based line number the issue relates to (best effort). */
  line: number;
}

export interface ReferenceIssue {
  /** Content file containing the `file_code_block` call. */
  source: string;
  /** The `file=` argument (relative to learning-code-examples/examples/). */
  file: string;
  /** The `anchor=` argument, if any. */
  anchor?: string;
  kind: "missing-file" | "missing-anchor";
}

/**
 * Parse the `[[example]]` tables out of a `Cargo.toml`.
 *
 * Intentionally a tiny, dependency-free parser scoped to exactly the shape the
 * crate uses (`name` and `path` string keys inside `[[example]]` tables). It is
 * not a general TOML parser.
 */
export function parseExampleEntries(cargoToml: string): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  let current: Partial<ExampleEntry> | null = null;

  const flush = () => {
    if (current && current.name !== undefined && current.path !== undefined) {
      entries.push({ name: current.name, path: current.path });
    }
    current = null;
  };

  for (const rawLine of cargoToml.split("\n")) {
    const line = rawLine.trim();
    if (line === "[[example]]") {
      flush();
      current = {};
      continue;
    }
    // A new table header that isn't [[example]] ends the current example.
    if (line.startsWith("[") && line !== "[[example]]") {
      flush();
      continue;
    }
    if (current === null) continue;

    const m = /^(name|path)\s*=\s*"([^"]*)"/.exec(line);
    if (m) {
      const key = m[1] as "name" | "path";
      current[key] = m[2];
    }
  }
  flush();
  return entries;
}

/**
 * Extract a single anchor region from an example file's source.
 *
 * This is a faithful reproduction of the `file_code_block` shortcode's
 * `extractAnchor` (astro-site/src/lib/shortcodes.ts), which itself mirrors the
 * original Zola Tera template `templates/shortcodes/file_code_block.md`:
 *
 *  - Lines are split on `\n`.
 *  - A line ending with `// ANCHOR_END: <anchor>` closes the region (checked
 *    BEFORE the line is emitted, so the end marker line is never included).
 *  - A line ending with `// HIDE` is dropped from output.
 *  - While inside the region, lines that do not contain `// ANCHOR:` or
 *    `// ANCHOR_END:` (and are not hidden) are emitted, each followed by `\n`.
 *  - A line ending with `// ANCHOR: <anchor>` opens the region (checked AFTER
 *    emission, so the start marker line is never included).
 *
 * Returns the rendered code (may be empty if the anchor does not exist).
 */
export function extractAnchor(code: string, anchor: string): string {
  const lines = code.split("\n");
  let out = "";
  let inAnchor = false;
  for (const line of lines) {
    if (line.endsWith("// ANCHOR_END: " + anchor)) inAnchor = false;
    const hidden = line.endsWith("// HIDE");
    if (inAnchor && !hidden && !line.includes("// ANCHOR:") && !line.includes("// ANCHOR_END:")) {
      out += line + "\n";
    }
    if (line.endsWith("// ANCHOR: " + anchor)) inAnchor = true;
  }
  return out;
}

const ANCHOR_RE = /\/\/ ANCHOR: (.+)$/;
const ANCHOR_END_RE = /\/\/ ANCHOR_END: (.+)$/;

/**
 * Collect the set of anchor names defined in a file (anything opened with
 * `// ANCHOR: <name>`).
 */
export function anchorNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const line of code.split("\n")) {
    const m = ANCHOR_RE.exec(line);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/**
 * Validate the anchor structure of a single example file.
 *
 * Checks for:
 *  - duplicate open anchors (same name opened while already open),
 *  - `// ANCHOR_END:` markers with no matching open,
 *  - `// ANCHOR:` markers never closed,
 *  - anchors whose extracted content is empty.
 *
 * Anchors may be nested (the shortcode supports it), so "open" tracking is a
 * multiset keyed by name.
 */
export function validateAnchors(file: string, code: string): AnchorIssue[] {
  const issues: AnchorIssue[] = [];
  const lines = code.split("\n");
  // name -> line number where it was opened
  const open = new Map<string, number>();
  const seen = new Set<string>();

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const start = ANCHOR_RE.exec(line);
    const end = ANCHOR_END_RE.exec(line);
    if (end) {
      const name = end[1].trim();
      if (!open.has(name)) {
        issues.push({ file, kind: "unmatched-end", anchor: name, line: lineNo });
      } else {
        open.delete(name);
      }
    }
    if (start) {
      const name = start[1].trim();
      if (open.has(name)) {
        issues.push({ file, kind: "duplicate-anchor", anchor: name, line: lineNo });
      }
      open.set(name, lineNo);
      seen.add(name);
    }
  });

  for (const [name, lineNo] of open) {
    issues.push({ file, kind: "unclosed-anchor", anchor: name, line: lineNo });
  }

  // Empty-region check, only for anchors that were properly opened+closed.
  for (const name of seen) {
    if (open.has(name)) continue; // unclosed already reported
    if (extractAnchor(code, name).length === 0) {
      issues.push({ file, kind: "empty-anchor", anchor: name, line: 0 });
    }
  }

  return issues;
}

/** Recursively list `.rs` files under a directory (crate-relative paths). */
export function listExampleFiles(examplesDir: string, crateRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".rs")) out.push(relative(crateRoot, full));
    }
  };
  walk(examplesDir);
  out.sort();
  return out;
}

export interface FileCodeBlockRef {
  source: string; // content file the call appears in
  file: string; // file= argument
  anchor?: string; // anchor= argument
}

const FILE_CODE_BLOCK_RE = /\{\{-?\s*file_code_block\(([^)]*)\)/g;

/** Parse `file=` / `anchor=` from a shortcode argument string. */
function parseShortcodeArgs(args: string): { file?: string; anchor?: string } {
  const file = /file\s*=\s*"([^"]*)"/.exec(args)?.[1];
  const anchor = /anchor\s*=\s*"([^"]*)"/.exec(args)?.[1];
  return { file, anchor };
}

/** Find every `file_code_block` shortcode call in the given content files. */
export function findFileCodeBlockRefs(contentFiles: string[], contentRoot: string): FileCodeBlockRef[] {
  const refs: FileCodeBlockRef[] = [];
  for (const f of contentFiles) {
    const text = readFileSync(f, "utf8");
    const source = relative(contentRoot, f);
    for (const m of text.matchAll(FILE_CODE_BLOCK_RE)) {
      const { file, anchor } = parseShortcodeArgs(m[1]);
      if (file === undefined) continue;
      refs.push({ source, file, anchor });
    }
  }
  return refs;
}

/** Recursively list files under a directory matching the given extensions. */
export function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (exts.some((e) => entry.endsWith(e))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Cross-check that every `file_code_block` reference resolves to an existing
 * example file and (when an anchor is given) an existing, non-empty anchor.
 */
export function validateReferences(refs: FileCodeBlockRef[], examplesDir: string): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  const cache = new Map<string, string | null>();

  const read = (relPath: string): string | null => {
    if (cache.has(relPath)) return cache.get(relPath)!;
    let content: string | null;
    try {
      content = readFileSync(join(examplesDir, relPath), "utf8");
    } catch {
      content = null;
    }
    cache.set(relPath, content);
    return content;
  };

  for (const ref of refs) {
    const code = read(ref.file);
    if (code === null) {
      issues.push({ source: ref.source, file: ref.file, anchor: ref.anchor, kind: "missing-file" });
      continue;
    }
    if (ref.anchor !== undefined) {
      const names = anchorNames(code);
      if (!names.has(ref.anchor)) {
        issues.push({ source: ref.source, file: ref.file, anchor: ref.anchor, kind: "missing-anchor" });
      }
    }
  }
  return issues;
}
