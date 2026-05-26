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

// Matches Tera's `escape` filter (escape_html), which also escapes ' and /.
function teraEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
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

  // Inlined from the former templates/shortcodes/support_bevy.md.
  support_bevy: () =>
    `## Support Bevy

Bevy will always be free and open-source, but it isn't free to make! Because Bevy is free, we rely on the generosity of the Bevy community to fund our efforts. If you are a happy user of Bevy or you believe in our mission, please consider [donating to the Bevy Foundation](/donate)... every bit helps!

<a class="button button--pink" href="/donate">Donate <img class="button__icon" src="/assets/heart.svg" alt="heart icon"></a>
`,

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

  // release-content shortcodes (templates/shortcodes/{migration_guides,release_notes,
  // changelog,contributors}.md). These emit markdown (re-rendered by the page); a couple
  // embed pre-rendered HTML via Zola's `| markdown` filter (nested render).
  migration_guides: (a) => {
    const base = `release-content/${a.version}/migration-guides`;
    const data = loadData(`${base}/_guides.toml`);
    const out: string[] = [];
    out.push(
      `<aside class="callout callout--warning">\n  <p>Bevy relies heavily on improvements in the Rust language and compiler. As a result, the Minimum Supported Rust Version (MSRV) is "the latest stable release" of Rust.</p>\n</aside>`
    );
    out.push(`<div class="migration-guide">`);
    let previousArea = "";
    for (const guide of data.guides) {
      const areaName = guide.areas && guide.areas[0] ? guide.areas[0] : "Without area";
      const areaChanged = areaName !== previousArea;
      if (areaChanged) {
        previousArea = areaName;
        out.push(`## ${areaName}`);
      } else {
        out.push(`<hr>`);
      }
      out.push(`### ${guide.title}`);
      out.push(headingMetaAreas(guide.areas || [], guide.prs || []));
      out.push(loadData(`${base}/${guide.file_name}`));
    }
    out.push(`</div>`);
    return out.join("\n\n");
  },

  release_notes: (a, ctx) => {
    const base = `release-content/${a.version}/release-notes`;
    const data = loadData(`${base}/_release-notes.toml`);
    const out: string[] = [];
    for (const note of data.release_notes) {
      out.push(`## ${note.title}`);
      out.push(headingMetaAuthors(note.authors || [], note.prs || []));
      const body = (loadData(`${base}/${note.file_name}`) as string).split("POST_PATH").join(ctx.colocatedPath);
      out.push(md(body, ctx));
    }
    return out.join("\n\n");
  },

  changelog: (a, ctx) => {
    const data = loadData(`release-content/${a.version}/changelog.toml`);
    const out: string[] = [];
    out.push("## Full Changelog");
    out.push(
      "The changes mentioned above are only the most appealing, highest impact changes that we've made this cycle.\nInnumerable bug fixes, documentation changes and API usability tweaks made it in too.\nFor a complete list of changes, check out the PRs listed below."
    );
    for (const area of data.areas) {
      const name = area.name && area.name.length ? area.name.join(" + ") : "";
      out.push(name ? `### ${name}` : "### No area label");
      let ul = '<ul class="pr-list">\n';
      for (const pr of area.prs) {
        // Zola renders `pr.title | escape | markdown`, wrapping it in <p> and rendering
        // inline markdown (e.g. `code`).
        const title = md(teraEscape(pr.title), ctx).trim();
        ul += `<li class="pr-list__item"><a href="https://github.com/bevyengine/bevy/pull/${pr.number}">${title}</a></li>\n`;
      }
      ul += "</ul>";
      out.push(ul);
    }
    return out.join("\n\n");
  },

  contributors: (a) => {
    const data = loadData(`release-content/${a.version}/contributors.toml`);
    const out: string[] = [];
    out.push("## Contributors");
    out.push(
      `A huge thanks to the ${data.contributors.length} contributors that made this release (and associated docs) possible! In random order:`
    );
    let ul = '<ul class="contributors">\n';
    for (const c of data.contributors) ul += `<li>${c.name}</li>\n`;
    ul += "</ul>";
    out.push(ul);
    return out.join("\n\n");
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

// heading-meta block for release notes (Authors + PRs), matching release_notes.md.
function headingMetaAuthors(authors: string[], prs: (string | number)[]): string {
  const a = authors
    .map((author, i) => {
      const item = author.startsWith("@")
        ? `<a href="https://github.com/${author.replace(/^@/, "")}" class="heading-meta__item">${author}</a>`
        : `<span class="heading-meta__item">${author}</span>`;
      return item + (i < authors.length - 1 ? "," : "");
    })
    .join("");
  const p = prs
    .map((pr, i) => `<a class="heading-meta__item" href="https://github.com/bevyengine/bevy/pull/${pr}">#${pr}</a>` + (i < prs.length - 1 ? "," : ""))
    .join("");
  return (
    `<div class="heading-meta">\n  <div>\n    <span class="heading-meta__title">Authors:</span>\n    ${a}\n  </div>\n` +
    `  <div>\n    <span class="heading-meta__title">PRs:</span>\n    ${p}\n  </div>\n</div>`
  );
}

// heading-meta block for migration guides (Areas + PRs), matching migration_guides.md.
function headingMetaAreas(areas: string[], prs: (string | number)[]): string {
  const a = areas
    .map((area, i) => `<span class="heading-meta__item">${area}</span>` + (i < areas.length - 1 ? ", " : ". "))
    .join("");
  const p = prs
    .map((pr, i) => `<a class="heading-meta__item" href="https://github.com/bevyengine/bevy/pull/${pr}">#${pr}</a>` + (i < prs.length - 1 ? ", " : ""))
    .join("");
  return (
    `<div class="heading-meta">\n  <div>\n    <span class="heading-meta__title">Areas:</span>\n    ${a}\n  </div>\n` +
    `  <div>\n    <span class="heading-meta__title"> PRs:</span>\n    ${p}\n  </div>\n</div>`
  );
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

  // Inline shortcodes: {{ name(args) }}. When the invocation is alone on its line (Zola's
  // block context), surround its output with blank lines so block-level markdown it emits
  // (headings, HTML blocks) is parsed correctly and doesn't get glued to its neighbours.
  out = out.replace(
    /\{\{\s*([a-z_]+)\s*\(([\s\S]*?)\)\s*\}\}/g,
    (m, name: string, argStr: string, offset: number, full: string) => {
      const fn = INLINE[name];
      if (!fn) return m;
      const result = fn(parseArgs(argStr), ctx);
      const before = full.slice(0, offset);
      const after = full.slice(offset + m.length);
      const aloneOnLine = /(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\n|$)/.test(after);
      return aloneOnLine ? `\n\n${result}\n\n` : result;
    }
  );

  return out;
}
