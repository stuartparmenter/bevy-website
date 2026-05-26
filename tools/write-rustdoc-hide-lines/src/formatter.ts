// Port of `src/formatter.rs`.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { CodeBlockDefinition } from "./code_block_definition.ts";
import { getHiddenRanges, rangesEqual } from "./hidden_ranges.ts";

/**
 * Mirrors Rust's `str::lines()`:
 * - Splits on `\n`.
 * - A trailing `\r` on each line is removed (handles CRLF).
 * - A trailing `\n` does NOT produce a final empty line.
 *
 * So `"a\nb\n"` -> `["a", "b"]` and `"a\nb"` -> `["a", "b"]`.
 */
function rustLines(src: string): string[] {
  if (src.length === 0) {
    return [];
  }
  const parts = src.split("\n");
  // A trailing `\n` yields a final empty element in JS split; Rust drops it.
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
}

/**
 * Checks the given directory, returning a list of unformatted files.
 */
export async function check(dir: string): Promise<string[]> {
  const unformattedFiles: string[] = [];

  await visitDirMdFiles(dir, async (filePath) => {
    console.log(`- ${debugPath(filePath)}`);

    const src = await fs.readFile(filePath, "utf8");
    const formatted = formatFile(src);

    if (src !== formatted) {
      unformattedFiles.push(filePath);
    }
  });

  return unformattedFiles;
}

/**
 * Formats the given directory, automatically adding `hide_lines` annotations.
 */
export async function format(dir: string): Promise<void> {
  await visitDirMdFiles(dir, async (filePath) => {
    console.log(`- ${debugPath(filePath)}`);

    const src = await fs.readFile(filePath, "utf8");
    const formatted = formatFile(src);

    await fs.writeFile(filePath, formatted);
  });
}

/**
 * Calls `cb` for every `.md` file recursively found within `dir`.
 * Throws (Rust `bail!`) if `dir` is not a directory.
 */
async function visitDirMdFiles(
  dir: string,
  cb: (filePath: string) => Promise<void>,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(
      `Tried visiting the path ${debugPath(dir)} that was not a directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Tried visiting the path ${debugPath(dir)} that was not a directory.`,
    );
  }

  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const entryStat = await fs.stat(entryPath);

    if (entryStat.isDirectory()) {
      await visitDirMdFiles(entryPath, cb);
    } else {
      const ext = path.extname(entryPath);
      // `path.extension()` returns the part after the final dot, without the dot.
      if (ext.length > 0) {
        const extNoDot = ext.slice(1);
        if (extNoDot.toLowerCase() === "md") {
          await cb(entryPath);
        }
      }
    }
  }
}

// Find a code block delimiter and optionally the first specified language.
// Rust `Regex::captures` is search (unanchored); JS `exec` without `^` is too.
const CODE_BLOCK_DELIM = /\s*```(\w*)/;

export function formatFile(src: string): string {
  let contents = "";
  let rustBlock: string[] = [];
  let isRust = false;

  let insideCodeBlock = false;

  for (const line of rustLines(src)) {
    const match = CODE_BLOCK_DELIM.exec(line);
    // `cap.get(1)` — capture group 1 (`\w*`) is always present when the
    // overall regex matches, so `is_some()` <=> overall match.
    const codeBlockDelimMatch = match !== null ? match[1] : null;
    const isCodeBlockDelim = codeBlockDelimMatch !== null;

    if (!insideCodeBlock && isCodeBlockDelim) {
      const lang = codeBlockDelimMatch as string;
      if (lang === "rust" || lang === "rs") {
        isRust = true;
      }
      insideCodeBlock = true;
    } else if (insideCodeBlock && isCodeBlockDelim) {
      insideCodeBlock = false;
    }

    // Pass through non-rust code block contents and contents outside code blocks.
    if (!isRust) {
      contents += `${line}\n`;
      continue;
    }

    rustBlock.push(line);

    if (insideCodeBlock) {
      continue;
    }

    // Process the `rust` code block.
    const code = rustBlock.slice(1, rustBlock.length - 1);
    const realHiddenRanges = getHiddenRanges(code);
    const definition = CodeBlockDefinition.new(rustBlock[0]);
    if (definition === null) {
      // Rust `.unwrap()` would panic here.
      throw new Error(
        `Failed to parse code block definition: ${rustBlock[0]}`,
      );
    }

    const annotationHiddenRanges = definition.getHiddenRanges();
    if (annotationHiddenRanges !== null) {
      if (!rangesEqual(annotationHiddenRanges, realHiddenRanges)) {
        definition.setHiddenRanges(realHiddenRanges);
      }
    } else {
      if (realHiddenRanges.length !== 0) {
        definition.setHiddenRanges(realHiddenRanges);
      }
    }

    // Rewrite code block Zola annotations.
    rustBlock[0] = definition.intoString();

    // Write code block.
    contents += `${rustBlock.join("\n")}\n`;

    // Reset state.
    insideCodeBlock = false;
    rustBlock = [];
    isRust = false;
  }

  return contents;
}

// Mirrors Rust's `{:?}` debug formatting of a `Path` (quoted string).
export function debugPath(p: string): string {
  return JSON.stringify(p);
}
