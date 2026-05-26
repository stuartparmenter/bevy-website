// A minimal TOML value serializer that reproduces, byte-for-byte, the output of
// the Rust `toml` crate v0.9 (`toml::to_string`) for the specific document
// shapes emitted by generate-community.
//
// The original Rust crate serializes its frontmatter structs with serde + the
// `toml` crate. `smol-toml`'s `stringify` uses different string-quoting rules
// and a different document layout, so to keep the generated `.md` files
// identical we re-implement the relevant parts of the `toml`/`toml_writer`
// string-encoding algorithm here.
//
// Supported value kinds (all that the frontmatter needs): string, integer,
// boolean, and arrays of strings. `null`/`undefined` values are omitted, exactly
// like serde skips `Option::None`.

// --- String encoding (ported from toml_writer-1.1.1 src/string.rs) ---

interface ValueMetrics {
  maxSeqSingleQuotes: number;
  maxSeqDoubleQuotes: number;
  escapeCodes: boolean; // any ascii control char other than \t and \n (\b \f \r and < 0x1f, 0x7f)
  escape: boolean; // contains a backslash
  newline: boolean; // contains \n
}

function calculateMetrics(s: string): ValueMetrics {
  const m: ValueMetrics = {
    maxSeqSingleQuotes: 0,
    maxSeqDoubleQuotes: 0,
    escapeCodes: false,
    escape: false,
    newline: false,
  };

  // The Rust implementation iterates over bytes. We iterate over UTF-8 bytes to
  // match the run-length counting of quote sequences and control detection.
  const bytes = Buffer.from(s, "utf8");

  let prevSingle = 0;
  let prevDouble = 0;
  for (const byte of bytes) {
    if (byte === 0x27 /* ' */) {
      prevSingle += 1;
      if (prevSingle > m.maxSeqSingleQuotes) m.maxSeqSingleQuotes = prevSingle;
    } else {
      prevSingle = 0;
    }
    if (byte === 0x22 /* " */) {
      prevDouble += 1;
      if (prevDouble > m.maxSeqDoubleQuotes) m.maxSeqDoubleQuotes = prevDouble;
    } else {
      prevDouble = 0;
    }

    if (byte === 0x5c /* \ */) {
      m.escape = true;
    } else if (byte === 0x09 /* \t */) {
      // always allowed; neutral
    } else if (byte === 0x0a /* \n */) {
      m.newline = true;
    } else if (byte <= 0x1f || byte === 0x7f) {
      m.escapeCodes = true;
    }
  }

  return m;
}

type Encoding = "literal" | "basic" | "ml_literal" | "ml_basic";

function chooseEncoding(m: ValueMetrics): Encoding {
  // Mirrors TomlStringBuilder::as_default:
  //   as_basic_pretty -> as_literal -> as_ml_basic_pretty -> as_ml_literal
  //   -> (newline ? as_ml_basic : as_basic)

  // as_basic_pretty: None if escape_codes || escape || double quotes present || newline
  if (!(m.escapeCodes || m.escape || m.maxSeqDoubleQuotes > 0 || m.newline)) {
    return "basic";
  }
  // as_literal: None if escape_codes || single quotes present || newline
  if (!(m.escapeCodes || m.maxSeqSingleQuotes > 0 || m.newline)) {
    return "literal";
  }
  // as_ml_basic_pretty: None if escape_codes || escape || >2 double quotes in a row
  if (!(m.escapeCodes || m.escape || m.maxSeqDoubleQuotes > 2)) {
    return "ml_basic";
  }
  // as_ml_literal: None if escape_codes || >2 single quotes in a row
  if (!(m.escapeCodes || m.maxSeqSingleQuotes > 2)) {
    return "ml_literal";
  }
  // Fallback.
  return m.newline ? "ml_basic" : "basic";
}

function writeEscapedBasic(decoded: string, isMl: boolean): string {
  // Ported from write_toml_value's `escaped` branch (toml_writer string.rs).
  // Operates on UTF-8 bytes; non-ASCII bytes (>= 0x80) are emitted verbatim as
  // part of the unescaped run.
  const bytes = Buffer.from(decoded, "utf8");
  const maxSeqDoubleQuotes = isMl ? 2 : 0;

  let out = "";
  let i = 0;
  const n = bytes.length;

  while (i < n) {
    let unescapedEnd = i; // exclusive end of the verbatim run
    let escaped: string | null = null;
    let seqDoubleQuotes = 0;
    let j = i;
    for (; j < n; j++) {
      const b = bytes[j];
      if (b === 0x22 /* " */) {
        seqDoubleQuotes += 1;
        if (maxSeqDoubleQuotes < seqDoubleQuotes) {
          escaped = '\\"';
          break;
        }
      } else {
        seqDoubleQuotes = 0;
      }

      if (b === 0x08) {
        escaped = "\\b";
        break;
      } else if (b === 0x09) {
        escaped = "\\t";
        break;
      } else if (b === 0x0a) {
        if (!isMl) {
          escaped = "\\n";
          break;
        }
      } else if (b === 0x0c) {
        escaped = "\\f";
        break;
      } else if (b === 0x0d) {
        escaped = "\\r";
        break;
      } else if (b === 0x22) {
        // handled above
      } else if (b === 0x5c) {
        escaped = "\\\\";
        break;
      } else if (b <= 0x1f || b === 0x7f) {
        // control char with no dedicated escape: stop the run, emit \uXXXX below
        break;
      }

      unescapedEnd = j + 1;
    }

    const unescaped = bytes.toString("utf8", i, unescapedEnd);
    const escapedStr = escaped ?? "";
    // `end` advances past the verbatim run plus the single escaped char (if any).
    const end = unescapedEnd + (escaped !== null ? 1 : 0);
    out += unescaped + escapedStr;
    i = end;

    if (escaped === null && i < n) {
      // A control char with no dedicated escape: emit \uXXXX of the byte.
      const b = bytes[i];
      out += "\\u" + b.toString(16).toUpperCase().padStart(4, "0");
      i += 1;
    }
  }

  return out;
}

export function serializeTomlString(s: string): string {
  const m = calculateMetrics(s);
  const encoding = chooseEncoding(m);

  switch (encoding) {
    case "literal":
      return "'" + s + "'";
    case "basic":
      return '"' + writeEscapedBasic(s, false) + '"';
    case "ml_literal": {
      // Multi-line: a leading newline immediately after the opening delimiter is
      // trimmed by TOML, so the writer adds one when the content begins with a
      // newline... actually it always emits the leading newline for ml strings
      // when `newline` metric is true (newline_prefix = newline && is_ml).
      const prefix = m.newline ? "\n" : "";
      return "'''" + prefix + s + "'''";
    }
    case "ml_basic": {
      const prefix = m.newline ? "\n" : "";
      return '"""' + prefix + writeEscapedBasic(s, true) + '"""';
    }
  }
}

// --- Document serialization ---

// A field value: string | number | boolean | string[] | null/undefined (omitted).
export type TomlScalar = string | number | boolean | null | undefined;
export type TomlFieldValue = TomlScalar | string[];

function serializeInlineValue(value: string | number | boolean | string[]): string {
  if (typeof value === "string") {
    return serializeTomlString(value);
  }
  if (typeof value === "number") {
    // integers only in this tool
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  // string[] -> inline array, ", " separated
  return "[" + value.map((v) => serializeTomlString(v)).join(", ") + "]";
}

/**
 * Serialize a flat-map of top-level scalar fields plus a single nested `[extra]`
 * table, reproducing the layout of the Rust `toml` crate for these structs:
 *
 *   key = value
 *   ...
 *   <blank line>
 *   [extra]
 *   key = value
 *   ...
 *
 * Field insertion order is preserved (matching serde struct field order).
 * `null`/`undefined` values are skipped (like `Option::None`).
 *
 * The trailing newline matches `toml::to_string` (output ends with `\n`).
 */
export function serializeFrontmatter(
  topLevel: Array<[string, TomlFieldValue]>,
  extra: Array<[string, TomlFieldValue]>,
): string {
  let out = "";

  for (const [key, value] of topLevel) {
    if (value === null || value === undefined) continue;
    out += `${key} = ${serializeInlineValue(value)}\n`;
  }

  // The `toml` crate writes a blank line before a nested table.
  out += "\n[extra]\n";

  for (const [key, value] of extra) {
    if (value === null || value === undefined) continue;
    out += `${key} = ${serializeInlineValue(value)}\n`;
  }

  return out;
}
