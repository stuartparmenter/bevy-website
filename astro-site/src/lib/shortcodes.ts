// Zola shortcode expansion. Shortcodes are expanded to HTML/markdown *before* the
// markdown pipeline runs, mirroring how Zola substitutes templates/shortcodes/*.
//
// Supports inline `{{ name(args) }}` and block `{% name(args) %} body {% end %}`.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { REPO_ROOT, loadData } from "./content.ts";
import { getImageMetadata } from "./images.ts";

export interface ShortcodeContext {
  insertAnchorLinks?: string;
  permalink: string;
  colocatedPath: string; // page.colocated_path, e.g. "news/2025-.../"
  // Lazily-set markdown renderer to avoid an import cycle (set by markdown.ts).
}

// A late-bound markdown renderer so shortcodes can render `body | markdown`.
let mdRender: ((src: string, ctx: ShortcodeContext) => string) | null = null;
export function setMarkdownRenderer(fn: (src: string, ctx: ShortcodeContext) => string) {
  mdRender = fn;
}
function md(src: string, ctx: ShortcodeContext): string {
  if (!mdRender) throw new Error("markdown renderer not set");
  return mdRender(src, ctx);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- argument parsing ----
// Handles key="str", key='str', key=123, key=true, key=[a, b], comma-separated.
function parseArgs(raw: string): Record<string, any> {
  const args: Record<string, any> = {};
  let i = 0;
  const s = raw;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  while (i < s.length) {
    skipWs();
    const keyMatch = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=/.exec(s.slice(i));
    if (!keyMatch) break;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    skipWs();
    let value: any;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      let v = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") { v += s[i + 1]; i += 2; }
        else v += s[i++];
      }
      i++; // closing quote
      value = v;
    } else if (s[i] === "[") {
      i++;
      let depth = 1;
      let inner = "";
      while (i < s.length && depth > 0) {
        if (s[i] === "[") depth++;
        else if (s[i] === "]") { depth--; if (depth === 0) break; }
        inner += s[i++];
      }
      i++; // closing ]
      value = inner
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length)
        .map((x) => stripQuotes(x));
    } else {
      let v = "";
      while (i < s.length && s[i] !== "," && !/\s/.test(s[i])) v += s[i++];
      value = coerce(v);
    }
    args[key] = value;
    skipWs();
    if (s[i] === ",") i++;
  }
  return args;
}
function stripQuotes(x: string): any {
  if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'")))
    return x.slice(1, -1);
  return coerce(x);
}
function coerce(v: string): any {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// ---- shortcode implementations ----
type InlineFn = (args: Record<string, any>, ctx: ShortcodeContext) => string;
type BlockFn = (args: Record<string, any>, body: string, ctx: ShortcodeContext) => string;

const INLINE: Record<string, InlineFn> = {
  curly_open: () => "{",
  curly_close: () => "}",

  support_bevy: () =>
    readShortcodeMd("support_bevy"),

  heading_metadata: (a) => {
    const authors: string[] = a.authors || [];
    const prs: (string | number)[] = a.prs || [];
    let out = '<div class="heading-meta">';
    if (authors.length) {
      out += "<div><span class=\"heading-meta__title\">Authors:</span>";
      out += authors
        .map((author) =>
          author.startsWith("@")
            ? `<a href="https://github.com/${author.replace(/^@/, "")}" class="heading-meta__item">${author}</a>`
            : `<span class="heading-meta__item">${author}</span>`
        )
        .join(",");
      out += "</div>";
    }
    if (prs.length) {
      out += "<div><span class=\"heading-meta__title\">PRs:</span>";
      out += prs
        .map((pr) => `<a class="heading-meta__item" href="https://github.com/bevyengine/bevy/pull/${pr}">#${pr}</a>`)
        .join(",");
      out += "</div>";
    }
    out += "</div>";
    return out;
  },

  media_caption: (a) => {
    if (a.url) {
      return `<div style="font-size: 1.0rem; margin-top: -1.5rem !important;" class="release-feature-authors"><a href="https://${a.url}">${a.text}</a></div>`;
    }
    return `<div style="font-size: 1.0rem; margin-top: -1.5rem !important;" class="release-feature-authors">${a.text}</div>`;
  },

  compare_slider: (a, ctx) => {
    // aspect-ratio uses the source image's intrinsic size.
    const imgPath = (a.path ? a.path : ctx.colocatedPath) + a.left_image;
    const meta = getImageMetadata(imgPath);
    const heightStyle = a.height ? `;height:${a.height}` : "";
    const sliderVar = a.start_slider_at ? `--slider-value: ${a.start_slider_at};` : "";
    const leftAlt = a.left_alt || a.left_title;
    const rightAlt = a.right_alt || a.right_title;
    return (
      `<p class="image-compare-instruction">Drag this image to compare</p>` +
      `<div class="image-compare-container" style="aspect-ratio: ${meta.width} / ${meta.height}${heightStyle}">` +
      `<div style="aspect-ratio: ${meta.width} / ${meta.height};${sliderVar}" class="image-compare" data-title-a="${a.left_title}" data-title-b="${a.right_title}">` +
      `<img class="image-a" alt="${leftAlt}" src="${a.left_image}">` +
      `<img class="image-b" alt="${rightAlt}" src="${a.right_image}">` +
      `</div></div>`
    );
  },

  file_code_block: (a) => {
    const language = a.language || "rs";
    const full = join(REPO_ROOT, "learning-code-examples/examples/", a.file);
    let code = readFileSync(full, "utf8");
    if (a.anchor) {
      code = extractAnchor(code, a.anchor);
    }
    return "```" + language + "\n" + code + "```";
  },
};

const BLOCK: Record<string, BlockFn> = {
  callout: (a, body, ctx) =>
    `<aside class="callout callout--${a.type || "info"}">${md(body, ctx)}</aside>`,
  todo: (a, body, ctx) =>
    `<div class="todo"><h2 class="todo-header">TODO</h2>${md(body, ctx)}</div>`,
  incorrect_code_block: (a, body, ctx) =>
    `<div class="incorrect"><div class="incorrect-image"><img src="/assets/error_icon.svg" alt="This code is invalid" title="This code is invalid" width="82" height="82" /></div>${md(body, ctx)}</div>`,
};

function readShortcodeMd(name: string): string {
  return readFileSync(join(REPO_ROOT, "templates/shortcodes", name + ".md"), "utf8");
}

function extractAnchor(code: string, anchor: string): string {
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

// Remove the common leading indentation from a shortcode body so that markdown nested
// inside indented blocks (e.g. a callout inside <details>) isn't misread as an indented
// code block — matching Zola's rendering of `{% block %}` bodies.
function dedent(body: string): string {
  const lines = body.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)![0].length;
    if (indent < min) min = indent;
  }
  if (!isFinite(min) || min === 0) return body;
  return lines.map((l) => l.slice(min)).join("\n");
}

// ---- expander ----
export function expandShortcodes(src: string, ctx: ShortcodeContext): string {
  let out = src;

  // Block shortcodes: {% name(args) %} body {% end %}
  out = out.replace(
    /\{%\s*([a-z_]+)\s*\(([\s\S]*?)\)\s*%\}([\s\S]*?)\{%\s*end\s*%\}/g,
    (m, name: string, argStr: string, body: string) => {
      const fn = BLOCK[name];
      if (!fn) return m;
      return fn(parseArgs(argStr), dedent(body), ctx);
    }
  );

  // Inline shortcodes: {{ name(args) }}
  out = out.replace(
    /\{\{\s*([a-z_]+)\s*\(([\s\S]*?)\)\s*\}\}/g,
    (m, name: string, argStr: string) => {
      const fn = INLINE[name];
      if (!fn) return m;
      return fn(parseArgs(argStr), ctx);
    }
  );

  return out;
}
