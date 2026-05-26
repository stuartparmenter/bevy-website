// Zola-compatible slugify (mirrors the Rust `slug` crate that Zola uses by default
// for both `slugify.paths` and `slugify.anchors`).
//
// Algorithm: transliterate to ASCII, then keep [a-z0-9], mapping every other run of
// characters to a single "-", trimming leading/trailing "-".

// Approximate deunicode: NFKD-decompose and strip combining marks, then drop
// remaining non-ascii. Covers the accented Latin used in author/people names.
function transliterate(input: string): string {
  return input.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function slugify(input: string): string {
  const ascii = transliterate(input);
  let out = "";
  let lastDash = false;
  for (const ch of ascii) {
    const code = ch.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      out += ch;
      lastDash = false;
    } else if (isUpper) {
      out += ch.toLowerCase();
      lastDash = false;
    } else {
      if (!lastDash && out.length > 0) {
        out += "-";
        lastDash = true;
      }
    }
  }
  // trim trailing dash
  if (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}
