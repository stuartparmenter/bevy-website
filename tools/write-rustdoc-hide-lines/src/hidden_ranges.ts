// Port of `src/hidden_ranges.rs`.
//
// A `HiddenRange` mirrors Rust's `std::ops::Range<usize>`: a half-open interval
// in the type, but here used inclusively (start..=end of line numbers, 1-based)
// exactly as the original code does (`range.end = n`).

export interface HiddenRange {
  start: number;
  end: number;
}

export type HiddenRanges = HiddenRange[];

// Match lines starting with a potentially indented `#` followed by a space or EOL.
const IS_HIDDEN_RE = /^\s*#(?: |$)/;

/**
 * Computes the hidden line ranges for a slice of code lines.
 *
 * Line numbers are 1-based, matching the Rust implementation (`n = idx + 1`).
 * Ranges are inclusive on both ends.
 */
export function getHiddenRanges(code: string[]): HiddenRanges {
  const ranges: HiddenRanges = [];
  let currRange: HiddenRange | null = null;

  for (let idx = 0; idx < code.length; idx++) {
    const n = idx + 1;
    const line = code[idx];
    const isHidden = IS_HIDDEN_RE.test(line);

    if (isHidden) {
      if (currRange !== null) {
        currRange.end = n;
      } else {
        currRange = { start: n, end: n };
      }
    } else {
      if (currRange !== null) {
        ranges.push(currRange);
      }
      currRange = null;
    }
  }

  if (currRange !== null) {
    ranges.push(currRange);
  }

  return ranges;
}

/** Structural equality for two range lists (Rust `PartialEq` on `Vec<Range>`). */
export function rangesEqual(a: HiddenRanges, b: HiddenRanges): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) {
      return false;
    }
  }
  return true;
}
