// Shared helpers for the generate-release TS port.

/**
 * Slugify a PR title the same way the Rust crate does:
 *   title.replace(' ', "_").replace(|c| !c.is_alphanumeric() && c != '_', "")
 *
 * `char::is_alphanumeric` is Unicode-aware (letters and numbers in any script),
 * so we use a Unicode property escape to match it. Everything that is not a
 * Unicode letter/number and not `_` is removed; spaces become `_`.
 */
export function slugifyTitle(title: string): string {
  const underscored = title.replaceAll(" ", "_");
  // Keep Unicode letters, numbers, and underscore; drop everything else.
  return [...underscored].filter((c) => c === "_" || /\p{L}|\p{N}/u.test(c)).join("");
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, never splitting a
 * multi-byte character (mirroring Rust's `String::truncate`, which operates on
 * byte indices but requires a char boundary). Rust would panic on a non-boundary
 * index; here we instead stop at the last char that fits, which is the only
 * sensible behaviour and matches the intent (and the committed file names, which
 * are all ASCII at the cut point).
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    out += ch;
  }
  return out;
}

/**
 * Compare two arrays of strings the way Rust's `Ord for Vec<String>` does:
 * element-by-element (each compared with Rust's byte-wise `String` Ord), and if
 * one is a prefix of the other, the shorter one is "less".
 */
export function compareStringArrays(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = byteCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Byte-wise (UTF-8) string comparison, matching Rust's `Ord for String`. */
export function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}
