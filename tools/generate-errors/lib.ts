// Port of generate-errors/src/lib.rs to TypeScript.
//
// Reads Bevy's `errors/` directory (markdown error-code docs) and produces the
// content needed to generate Zola pages under `content/learn/errors/`.
//
// The output is intended to be byte-identical to the original Rust crate.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Gets the unordered content of the error pages supplied by the user via a path
 * to the directory containing the original Bevy error files.
 *
 * Returns a map of file name -> processed markdown content.
 */
export function getErrorPages(bevyErrorsPath: string): Map<string, string> {
  // Guard clause: ensure the path exists.
  let exists = false;
  try {
    statSync(bevyErrorsPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new Error(`The path ("${bevyErrorsPath}") is invalid`);
  }

  const errorPagePaths: string[] = [];

  // Matches Bevy error codes, such as B0001, B0002, etc. (anywhere in name)
  const codeRegex = /B[0-9]{4}/;

  const entries = readdirSync(bevyErrorsPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(bevyErrorsPath, entry.name);

    // Resolve symlinks via statSync; skip directories.
    if (statSync(fullPath).isDirectory()) {
      continue;
    }

    // Only adds files that follow the Bevy error code format:
    // E.g. B0000, B0001, B0002, ..., B0030, ..., B9999.
    if (codeRegex.test(entry.name)) {
      errorPagePaths.push(fullPath);
    }
  }

  const resultsMap = new Map<string, string>();

  // The error pages already have a header built-in but Zola provides its own
  // title header so we need to remove this for proper formatting.
  //
  // NB: Rust's `Regex::replace` (not `replace_all`) replaces only the FIRST
  // occurrence, so we mirror that here with a non-global regex.
  const headerRegex = /# B[0-9]{4}/;

  for (const path of errorPagePaths) {
    // path.file_name() of a non-empty path always has a value here.
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const fileContents = readFileSync(path, "utf8");

    const regexContent = fileContents.replace(headerRegex, "");

    // Code blocks will be invalid unless the annotations are before the
    // language, like `should_panic,rust` or `no_run,rust`.
    let content = "";
    // Rust's `str::lines()` splits on \n and \r\n, and does NOT yield a final
    // empty element for a trailing newline.
    for (const line of splitLines(regexContent)) {
      // Ensure we only operate on Rust code blocks.
      if (!line.startsWith("```rust")) {
        content += line;
        content += "\n";
        continue;
      }

      // strip the leading ``` then split annotations on ','
      const annotations = line.slice("```".length).split(",");

      let newLine = "```";

      // Add all annotations other than rust first to avoid the issue.
      for (const annotation of annotations) {
        if (annotation === "rust") {
          continue;
        }
        newLine += annotation;
        newLine += ",";
      }
      newLine += "rust";

      content += newLine;
      content += "\n";
    }

    resultsMap.set(fileName, content);
  }

  return resultsMap;
}

/**
 * Splits a string into lines the way Rust's `str::lines()` does:
 * - splits on `\n`, treating a preceding `\r` as part of the line terminator
 * - does not produce a trailing empty line for a trailing newline
 */
function splitLines(s: string): string[] {
  if (s.length === 0) {
    return [];
  }
  const parts = s.split("\n");
  // A trailing "\n" yields a trailing "" entry which Rust's lines() omits.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

const SECTION_CONTENT = `+++
title = "Errors"
template = "docs.html"
page_template = "docs.html"
redirect_to = "/learn/errors/introduction"
+++
`;

const INTRODUCTION_CONTENT = `+++
title = "Introduction"
[extra]
weight = 0
+++

These pages document Bevy's error codes for the _current release_.

In case you are looking for the latest error codes from Bevy's main branch, you can find them in the [Bevy engine repository](<https://github.com/bevyengine/bevy/tree/main/errors>). 
`;

/**
 * Writes a valid docs section to contain the error pages in.
 *
 * The output path passed should be the folder you want the Zola pages to be
 * written / output (i.e. `content/learn`).
 */
export function writeSection(outputPath: string): void {
  const errorsFolderPath = join(outputPath, "errors");
  // Make sure the output folder exists.
  mkdirSync(errorsFolderPath, { recursive: true });

  writeFileSync(join(errorsFolderPath, "_index.md"), SECTION_CONTENT);
  writeFileSync(join(errorsFolderPath, "introduction.md"), INTRODUCTION_CONTENT);
}

/**
 * Writes the per-error pages to `<outputPath>/errors/`.
 */
export function writePages(outputPath: string, pages: Map<string, string>): void {
  const errorsFolderPath = join(outputPath, "errors");
  // Make sure the output folder exists.
  mkdirSync(errorsFolderPath, { recursive: true });

  // Make the keys ordered so that we know the weights for the pages.
  // Rust's `sort_unstable` on &String sorts by Unicode scalar (byte) order;
  // for ASCII error-code file names this matches a code-unit comparison.
  const keys = [...pages.keys()].sort(byteCompare);

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    // Extracts error code from the file name and uses it as the title.
    // Otherwise just uses file name for the title.
    const title = key.endsWith(".md") ? key.slice(0, -".md".length) : key;
    // The introduction page takes the zeroth position, so weights are
    // effectively one-indexed to avoid conflicts.
    const weight = index + 1;
    const body = pages.get(key);
    if (body === undefined) {
      throw new Error(`The page content for ${key} doesn't exist in the map!`);
    }

    const pageContent = `+++
title = "${title}"
[extra]
weight = ${weight}
+++

${body}`;

    writeFileSync(join(errorsFolderPath, key.toLowerCase()), pageContent);
  }
}

/** Compares two strings by Unicode code point, matching Rust's String Ord. */
function byteCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
