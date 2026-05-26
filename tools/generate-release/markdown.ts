// Port of generate-release/src/markdown.rs to TypeScript.
//
// The original uses `pulldown-cmark` 0.9.2 to parse PR bodies into an event
// stream and re-renders the section under a given header (e.g. "migration
// guide") into cleaned-up Markdown.
//
// pulldown-cmark is a full CommonMark parser; there is no exact-equivalent
// dependency-free JS library. To keep this port self-contained (matching the
// `smol-toml`-only convention of the sibling ports) we implement a focused
// CommonMark-subset parser that emits the same `Event` shapes the Rust renderer
// consumes, covering the constructs that appear in Bevy PR bodies: ATX
// headings, paragraphs, fenced + indented code blocks, (nested) bullet/ordered
// lists, block quotes, thematic breaks, raw HTML blocks, and the inline
// elements the renderer special-cases (code spans, emphasis, strong, links).
//
// NOTE: this code path only runs inside the network-bound `migration-guides`
// and `release-notes` subcommands (it processes freshly fetched PR bodies), so
// it cannot be validated end-to-end offline. The committed `.md` files under
// `release-content/*/migration-guides/` are additionally hand-edited after
// generation, so they are not byte-exact references for this transform.

// --- Heading levels (pulldown-cmark `HeadingLevel`, 1..=6) ---
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

// --- Event model (subset of pulldown_cmark::Event we need) ---

export type Tag =
  | { kind: "Paragraph" }
  | { kind: "Heading"; level: HeadingLevel }
  | { kind: "BlockQuote" }
  | { kind: "CodeBlock"; fenced: boolean; lang: string }
  | { kind: "List"; ordered: boolean }
  | { kind: "Item" }
  | { kind: "Emphasis" }
  | { kind: "Strong" }
  | { kind: "Link"; dest: string };

export type Event =
  | { type: "Start"; tag: Tag }
  | { type: "End"; tag: Tag }
  | { type: "Text"; text: string }
  | { type: "Code"; text: string }
  | { type: "Html"; html: string }
  | { type: "SoftBreak" }
  | { type: "HardBreak" }
  | { type: "Rule" };

// --- Block parsing ---

interface Block {
  emit(events: Event[]): void;
}

const SMART_PUNCT: Array<[RegExp, string]> = [
  // pulldown-cmark ENABLE_SMART_PUNCTUATION transformations.
  [/---/g, "—"], // em dash
  [/--/g, "–"], // en dash
  [/\.\.\./g, "…"], // ellipsis
];

/** Applies pulldown-cmark smart-punctuation to a run of text (excluding quotes,
 *  which are context sensitive; we approximate the dash/ellipsis transforms that
 *  matter for code/identifiers rarely and keep quotes as straight to stay close
 *  to the most common rendered output). */
function smartPunctuation(text: string): string {
  let out = text;
  for (const [re, rep] of SMART_PUNCT) {
    out = out.replace(re, rep);
  }
  return out;
}

/**
 * Parse Markdown into the event stream consumed by {@link writeMarkdownSection}.
 *
 * This is intentionally a pragmatic subset parser, not a full CommonMark engine.
 */
export function parseMarkdown(body: string): Event[] {
  // Normalize line endings.
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const events: Event[] = [];
  parseBlocks(lines, 0, events);
  return events;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^( {0,3})([-+*])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/;
const HTML_BLOCK_START = /^ {0,3}<(?:[a-zA-Z][a-zA-Z0-9-]*|\/[a-zA-Z][a-zA-Z0-9-]*|!--)/;

/** Parse a list of lines (already at a given block context) into events. */
function parseBlocks(lines: string[], start: number, events: Event[]): void {
  let i = start;
  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Thematic break (must be checked before list bullets like `* * *`).
    if (THEMATIC_BREAK.test(line)) {
      events.push({ type: "Rule" });
      i += 1;
      continue;
    }

    // ATX heading.
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const level = heading[1].length as HeadingLevel;
      const text = (heading[2] ?? "").trim();
      events.push({ type: "Start", tag: { kind: "Heading", level } });
      parseInline(text, events);
      events.push({ type: "End", tag: { kind: "Heading", level } });
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const fenceChars = fence[2];
      const lang = fence[3].trim().split(/\s+/)[0] ?? "";
      const fenceChar = fenceChars[0];
      const fenceLen = fenceChars.length;
      events.push({ type: "Start", tag: { kind: "CodeBlock", fenced: true, lang } });
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const closing = new RegExp(`^ {0,3}${fenceChar === "`" ? "`" : "~"}{${fenceLen},}[ \\t]*$`);
        if (closing.test(lines[i])) {
          i += 1;
          break;
        }
        // Strip up to `indent` leading spaces.
        let cl = lines[i];
        let stripped = 0;
        while (stripped < indent && cl.startsWith(" ")) {
          cl = cl.slice(1);
          stripped += 1;
        }
        codeLines.push(cl);
        i += 1;
      }
      // pulldown-cmark emits the code content as Text including a trailing newline per line.
      events.push({ type: "Text", text: codeLines.map((l) => l + "\n").join("") });
      events.push({ type: "End", tag: { kind: "CodeBlock", fenced: true, lang } });
      continue;
    }

    // Indented code block (4 spaces), only when not a list continuation context.
    if (/^ {4}/.test(line) && !ATX_HEADING.test(line)) {
      const codeLines: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || isBlank(lines[i]))) {
        if (isBlank(lines[i])) {
          // Look ahead: only include blank lines if more indented code follows.
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j += 1;
          if (j < lines.length && /^ {4}/.test(lines[j])) {
            codeLines.push("");
            i += 1;
            continue;
          } else {
            break;
          }
        }
        codeLines.push(lines[i].replace(/^ {4}/, ""));
        i += 1;
      }
      events.push({ type: "Start", tag: { kind: "CodeBlock", fenced: false, lang: "" } });
      events.push({ type: "Text", text: codeLines.map((l) => l + "\n").join("") });
      events.push({ type: "End", tag: { kind: "CodeBlock", fenced: false, lang: "" } });
      continue;
    }

    // Block quote.
    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (BLOCKQUOTE.test(lines[i]) || (!isBlank(lines[i]) && inner.length > 0 && !ATX_HEADING.test(lines[i]) && !FENCE.test(lines[i])))) {
        const m = BLOCKQUOTE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]);
        i += 1;
        if (i < lines.length && isBlank(lines[i])) break;
      }
      events.push({ type: "Start", tag: { kind: "BlockQuote" } });
      parseBlocks(inner, 0, events);
      events.push({ type: "End", tag: { kind: "BlockQuote" } });
      continue;
    }

    // Lists.
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      i = parseList(lines, i, events, !!ordered);
      continue;
    }

    // Raw HTML block.
    if (HTML_BLOCK_START.test(line)) {
      const htmlLines: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        htmlLines.push(lines[i]);
        i += 1;
      }
      events.push({ type: "Html", html: htmlLines.map((l) => l + "\n").join("") });
      continue;
    }

    // Paragraph: gather lines until blank or an interrupting block.
    const paraLines: string[] = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i];
      if (
        ATX_HEADING.test(l) ||
        FENCE.test(l) ||
        THEMATIC_BREAK.test(l) ||
        BLOCKQUOTE.test(l) ||
        (paraLines.length > 0 && (BULLET.test(l) || ORDERED.test(l)))
      ) {
        break;
      }
      paraLines.push(l.trim());
      i += 1;
    }
    if (paraLines.length > 0) {
      events.push({ type: "Start", tag: { kind: "Paragraph" } });
      parseInlineMultiline(paraLines, events);
      events.push({ type: "End", tag: { kind: "Paragraph" } });
    }
  }
}

/** Parse a (possibly nested) list starting at line `start`. Returns next index. */
function parseList(lines: string[], start: number, events: Event[], ordered: boolean): number {
  let i = start;
  const firstMatch = ordered ? ORDERED.exec(lines[i])! : BULLET.exec(lines[i])!;
  const baseIndent = firstMatch[1].length;
  events.push({ type: "Start", tag: { kind: "List", ordered } });

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      // Peek for list continuation.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j += 1;
      if (j >= lines.length) break;
      const nextMatch = ordered ? ORDERED.exec(lines[j]) : BULLET.exec(lines[j]);
      if (nextMatch && nextMatch[1].length === baseIndent) {
        i = j;
        continue;
      }
      break;
    }

    const match = ordered ? ORDERED.exec(line) : BULLET.exec(line);
    if (!match || match[1].length !== baseIndent) {
      break;
    }

    // Compute the content indentation (marker + following whitespace).
    const marker = ordered ? match[2] + match[3] : match[2];
    const afterMarkerWs = ordered ? match[4] : match[3];
    const contentIndent = baseIndent + marker.length + afterMarkerWs.length;
    const firstContent = ordered ? match[5] : match[4];

    // Collect this item's lines (de-indented by contentIndent).
    const itemLines: string[] = [firstContent];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // Blank could be inside the item if a more-indented or list line follows.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j += 1;
        if (j < lines.length && lines[j].startsWith(" ".repeat(contentIndent))) {
          itemLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      // A new list marker at base indent ends this item.
      const bMatch = BULLET.exec(l);
      const oMatch = ORDERED.exec(l);
      if ((bMatch && bMatch[1].length <= baseIndent) || (oMatch && oMatch[1].length <= baseIndent)) {
        break;
      }
      if (l.startsWith(" ".repeat(contentIndent))) {
        itemLines.push(l.slice(contentIndent));
        i += 1;
      } else {
        // Lazy continuation line.
        itemLines.push(l.trim());
        i += 1;
      }
    }

    events.push({ type: "Start", tag: { kind: "Item" } });
    emitItemContent(itemLines, events);
    events.push({ type: "End", tag: { kind: "Item" } });
  }

  events.push({ type: "End", tag: { kind: "List", ordered } });
  return i;
}

/**
 * Emit the content of a list item. Tight items (no internal block structure
 * beyond a single paragraph) are emitted as inline text without a wrapping
 * Paragraph, matching pulldown-cmark's tight-list behaviour for the simple
 * single-line items that dominate Bevy migration guides. Nested lists / block
 * structures are recursed into.
 */
function emitItemContent(itemLines: string[], events: Event[]): void {
  // Determine whether the item is "simple": only inline content until a nested
  // block (sub-list, code fence, blank-separated paragraph) appears.
  let firstBlockIdx = itemLines.length;
  for (let k = 0; k < itemLines.length; k++) {
    const l = itemLines[k];
    if (
      BULLET.test(l) ||
      ORDERED.test(l) ||
      FENCE.test(l) ||
      isBlank(l) ||
      ATX_HEADING.test(l) ||
      BLOCKQUOTE.test(l)
    ) {
      firstBlockIdx = k;
      break;
    }
  }

  // Leading inline lines (the item's first paragraph, rendered tightly).
  const inlineLines = itemLines.slice(0, firstBlockIdx);
  if (inlineLines.length > 0) {
    parseInlineMultiline(inlineLines, events);
  }

  // Remaining lines form nested blocks.
  const rest = itemLines.slice(firstBlockIdx);
  if (rest.length > 0) {
    parseBlocks(rest, 0, events);
  }
}

// --- Inline parsing ---

/** Parse multiple paragraph lines, inserting SoftBreak between them. */
function parseInlineMultiline(lines: string[], events: Event[]): void {
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) events.push({ type: "SoftBreak" });
    parseInline(lines[k], events);
  }
}

/**
 * Parse inline content into events. Handles code spans, links, strong, emphasis,
 * inline HTML, and text (with smart punctuation applied to text runs).
 */
export function parseInline(text: string, events: Event[]): void {
  let i = 0;
  let textBuf = "";

  const flush = () => {
    if (textBuf.length > 0) {
      events.push({ type: "Text", text: smartPunctuation(textBuf) });
      textBuf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Backslash escape.
    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      textBuf += text[i + 1];
      i += 2;
      continue;
    }

    // Code span.
    if (ch === "`") {
      let tickLen = 0;
      while (text[i + tickLen] === "`") tickLen += 1;
      const ticks = "`".repeat(tickLen);
      const closeIdx = text.indexOf(ticks, i + tickLen);
      if (closeIdx !== -1) {
        flush();
        let code = text.slice(i + tickLen, closeIdx);
        // CommonMark: strip one leading/trailing space if both present and not all spaces.
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
          code = code.slice(1, -1);
        }
        events.push({ type: "Code", text: code });
        i = closeIdx + tickLen;
        continue;
      }
    }

    // Inline link [text](dest).
    if (ch === "[") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        events.push({ type: "Start", tag: { kind: "Link", dest: link.dest } });
        parseInline(link.label, events);
        events.push({ type: "End", tag: { kind: "Link", dest: link.dest } });
        i = link.end;
        continue;
      }
    }

    // Autolink <http...>.
    if (ch === "<") {
      const auto = /^<((?:https?|ftp|mailto):[^>\s]+)>/.exec(text.slice(i));
      if (auto) {
        flush();
        const dest = auto[1];
        events.push({ type: "Start", tag: { kind: "Link", dest } });
        events.push({ type: "Text", text: dest });
        events.push({ type: "End", tag: { kind: "Link", dest } });
        i += auto[0].length;
        continue;
      }
      // Inline HTML tag.
      const htmlTag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>|^<!--[\s\S]*?-->/.exec(text.slice(i));
      if (htmlTag) {
        flush();
        events.push({ type: "Html", html: htmlTag[0] });
        i += htmlTag[0].length;
        continue;
      }
    }

    // Strong (** or __).
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const delim = ch + ch;
      const closeIdx = text.indexOf(delim, i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flush();
        events.push({ type: "Start", tag: { kind: "Strong" } });
        parseInline(text.slice(i + 2, closeIdx), events);
        events.push({ type: "End", tag: { kind: "Strong" } });
        i = closeIdx + 2;
        continue;
      }
    }

    // Emphasis (* or _).
    if (ch === "*" || ch === "_") {
      const closeIdx = text.indexOf(ch, i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        flush();
        events.push({ type: "Start", tag: { kind: "Emphasis" } });
        parseInline(text.slice(i + 1, closeIdx), events);
        events.push({ type: "End", tag: { kind: "Emphasis" } });
        i = closeIdx + 1;
        continue;
      }
    }

    textBuf += ch;
    i += 1;
  }

  flush();
}

/** Parse an inline link starting at `[`. Returns label, dest, and end index. */
function parseLink(
  text: string,
  start: number,
): { label: string; dest: string; end: number } | null {
  // Find matching `]` accounting for nested brackets.
  let depth = 0;
  let j = start;
  for (; j < text.length; j++) {
    if (text[j] === "\\") {
      j += 1;
      continue;
    }
    if (text[j] === "[") depth += 1;
    else if (text[j] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (j >= text.length || text[j] !== "]") return null;
  const label = text.slice(start + 1, j);

  // Expect `(dest)` immediately after.
  if (text[j + 1] !== "(") return null;
  let k = j + 2;
  let dest = "";
  let parenDepth = 1;
  for (; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") {
      dest += text[k + 1] ?? "";
      k += 1;
      continue;
    }
    if (c === "(") parenDepth += 1;
    if (c === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
    dest += c;
  }
  if (k >= text.length) return null;
  // Strip an optional title: dest "title".
  const titleMatch = /^(\S+)\s+["'(].*$/.exec(dest);
  if (titleMatch) dest = titleMatch[1];
  return { label, dest: dest.trim(), end: k + 1 };
}

// --- Rendering (port of write_markdown_section / write_markdown_event) ---

/**
 * Writes the markdown section of the given section header to the output.
 * The header name needs to be in lower case.
 *
 * Returns `[output, sectionFound]`.
 */
export function writeMarkdownSection(
  body: string,
  sectionHeader: string,
  writeTodo: boolean,
): [string, boolean] {
  let output = "";
  const events = parseMarkdown(body);
  let idx = 0;
  let sectionFound = false;

  while (idx < events.length) {
    if (sectionFound) break;

    const event = events[idx];
    idx += 1;

    if (!(event.type === "Start" && event.tag.kind === "Heading")) {
      continue;
    }
    const headingLevel = event.tag.level;

    // Find the section header. Sometimes people will write code in the header.
    // The Rust code peeks a single next event and matches Text or Code.
    const next = events[idx];
    if (next && (next.type === "Text" || next.type === "Code")) {
      idx += 1; // consume it (matches `markdown.next()`)
      if (!next.text.toLowerCase().includes(sectionHeader)) {
        continue;
      }
    } else {
      // Heading with a non-text/code first child does not match the header.
      // (In Rust, the peeked event is consumed regardless; replicate that.)
      if (next !== undefined) idx += 1;
      continue;
    }

    sectionFound = true;
    // skip heading end event
    if (idx < events.length) idx += 1;

    // Write the section's content.
    let listItemLevel = 0;
    while (idx < events.length) {
      const ev = events[idx];
      idx += 1;

      if (ev.type === "Start" && ev.tag.kind === "Heading" && ev.tag.level <= headingLevel) {
        // go until next heading
        break;
      }
      if (ev.type === "Start" && ev.tag.kind === "List") {
        listItemLevel += 1;
      }
      if (ev.type === "End" && ev.tag.kind === "List") {
        listItemLevel -= 1;
      }
      if (ev.type === "Start" && ev.tag.kind === "Link") {
        output += "[";
        continue;
      }
      if (ev.type === "End" && ev.tag.kind === "Link") {
        output += `](${ev.tag.dest})`;
        continue;
      }

      output += writeMarkdownEvent(ev, listItemLevel - 1);
    }
  }

  if (!sectionFound) {
    // Someone didn't write a migration guide :(
    if (writeTodo) {
      output += "\n<!-- TODO -->\n";
    }
    return [output, false];
  }
  return [output, true];
}

/**
 * Write the markdown Event based on the Tag.
 * Handles edge cases like code blocks without a specified lang and aims for
 * consistent formatting. Mirrors the Rust `write_markdown_event`.
 */
function writeMarkdownEvent(event: Event, listItemLevel: number): string {
  let output = "";
  switch (event.type) {
    case "Start":
      switch (event.tag.kind) {
        case "CodeBlock":
          if (event.tag.fenced) {
            output += `\n\`\`\`${event.tag.lang === "" ? "rust" : event.tag.lang}\n`;
          } else {
            output += "\n```\n";
          }
          break;
        case "Emphasis":
          output += "_";
          break;
        case "Strong":
          output += "**";
          break;
        case "Heading":
          // A few guides used headings for emphasis; since we use headings for
          // the actual header of the guide, convey emphasis differently.
          output += "\n__";
          break;
        case "List":
          // FIXME List currently always assume they are unordered.
          output += "\n";
          break;
        case "Item":
          for (let n = 0; n < listItemLevel; n++) output += "  ";
          output += "- ";
          break;
        case "Paragraph":
          output += "\n";
          break;
        case "BlockQuote":
          output += "\n> ";
          break;
        case "Link":
          // Handled by the caller (writeMarkdownSection); see special-case there.
          break;
      }
      break;
    case "End":
      switch (event.tag.kind) {
        case "CodeBlock":
          output += "```\n";
          break;
        case "Emphasis":
          output += "_";
          break;
        case "Strong":
          output += "**";
          break;
        case "Heading":
          output += "__\n";
          break;
        case "List":
          // nothing
          break;
        case "Item":
          output += "\n";
          break;
        case "Paragraph":
          output += "\n";
          break;
        case "BlockQuote":
          output += "\n";
          break;
        case "Link":
          break;
      }
      break;
    case "Text":
      output += event.text;
      break;
    case "Code":
      output += `\`${event.text}\``;
      break;
    case "SoftBreak":
      output += "\n";
      break;
    case "Html":
      output += event.html;
      break;
    case "Rule":
      output += "---\n";
      break;
    case "HardBreak":
      // pulldown-cmark HardBreak isn't explicitly handled in the Rust match
      // (falls through to the `_ =>` debug-print arm, producing no output).
      break;
  }
  return output;
}
