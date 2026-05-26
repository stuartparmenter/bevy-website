// Port of `src/code_block_definition.rs`.

import type { HiddenRange, HiddenRanges } from "./hidden_ranges.ts";

const HIDE_LINES = "hide_lines=";

type Annotation =
  | { kind: "HideLines"; ranges: HiddenRanges }
  | { kind: "Other"; content: string };

function annotationFrom(text: string): Annotation {
  const isHideLines = text.startsWith(HIDE_LINES);

  if (isHideLines) {
    // `text.get(HIDE_LINES.len()..).unwrap_or("")` — substring after the prefix.
    const rest = text.slice(HIDE_LINES.length);
    const ranges: HiddenRanges = rest
      .split(" ")
      .filter((r) => r.trim() !== "")
      .map((range): HiddenRange => {
        const isRange = range.includes("-");

        if (isRange) {
          const parts = range.split("-");
          const start = parseRustUsize(parts[0]);
          const end = parseRustUsize(parts[1]);
          return { start, end };
        } else {
          const lineNo = parseRustUsize(range);
          return { start: lineNo, end: lineNo };
        }
      });

    return { kind: "HideLines", ranges };
  } else {
    return { kind: "Other", content: text };
  }
}

// Mirrors Rust `str::parse::<usize>().unwrap()`: panics (throws) on invalid input.
function parseRustUsize(s: string): number {
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`invalid digit found in string while parsing "${s}"`);
  }
  return Number.parseInt(s, 10);
}

function annotationIntoString(annotation: Annotation): string {
  if (annotation.kind === "HideLines") {
    const ranges = annotation.ranges
      .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
      .join(" ");
    return `${HIDE_LINES}${ranges}`;
  }
  return annotation.content;
}

export class CodeBlockDefinition {
  private tag: string;
  private annotations: Annotation[];
  private hideLinesIdx: number | null;

  private constructor(
    tag: string,
    annotations: Annotation[],
    hideLinesIdx: number | null,
  ) {
    this.tag = tag;
    this.annotations = annotations;
    this.hideLinesIdx = hideLinesIdx;
  }

  /**
   * Parses a code block fence line. Returns `null` (Rust `None`) for malformed
   * lines or non-rust languages.
   */
  static new(line: string): CodeBlockDefinition | null {
    // `(\s*)```(.+)` — `.` does not match newlines, but these are single lines.
    const langRe = /(\s*)```(.+)/;
    const captures = langRe.exec(line);
    if (captures === null) {
      return null;
    }

    const whitespace = captures[1];
    const lang = captures[2];
    if (whitespace === undefined || lang === undefined) {
      return null;
    }

    let hideLinesIdx: number | null = null;

    const parts = lang.split(",");
    // `parts.next()` — first element (always present after split).
    const tag = parts[0];
    if (tag === undefined) {
      return null;
    }

    if (tag !== "rs" && tag !== "rust") {
      return null;
    }

    const rest = parts.slice(1);
    const annotations = rest.map((a, idx) => {
      const annotation = annotationFrom(a);
      if (annotation.kind === "HideLines") {
        hideLinesIdx = idx;
      }
      return annotation;
    });

    return new CodeBlockDefinition(
      `${whitespace}\`\`\`${tag}`,
      annotations,
      hideLinesIdx,
    );
  }

  getHiddenRanges(): HiddenRanges | null {
    if (this.hideLinesIdx === null) {
      return null;
    }
    const annotation = this.annotations[this.hideLinesIdx];
    if (annotation.kind === "HideLines") {
      return annotation.ranges;
    }
    // Rust `unreachable!()`.
    throw new Error("hide_lines_idx pointed at a non-HideLines annotation");
  }

  intoString(): string {
    let out = this.tag;

    if (this.annotations.length !== 0) {
      out += ",";
    }

    out += this.annotations.map(annotationIntoString).join(",");

    return out;
  }

  setHiddenRanges(hiddenRanges: HiddenRanges): void {
    if (hiddenRanges.length === 0) {
      // Remove
      if (this.hideLinesIdx !== null) {
        this.annotations.splice(this.hideLinesIdx, 1);
        this.hideLinesIdx = null;
      }
    } else {
      // Add
      const annotation: Annotation = { kind: "HideLines", ranges: hiddenRanges };

      if (this.hideLinesIdx !== null) {
        this.annotations[this.hideLinesIdx] = annotation;
      } else {
        this.annotations.push(annotation);
        this.hideLinesIdx = this.annotations.length - 1;
      }
    }
  }
}
