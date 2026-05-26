// Markdown rendering tuned to match Zola's pulldown-cmark output:
//  - code fences wrapped like syntect (`<pre class="language-X z-code" data-lang=X>`)
//    with the highlight span tree omitted (the comparator compares code text only);
//  - heading ids via Zola slugify (+ de-duplication), optional right-anchor links;
//  - raw HTML passes through; GFM tables/strikethrough/tasklists/footnotes enabled.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { slugify } from "./slugify.ts";
import { internalLinkUrl } from "./content.ts";
import { expandShortcodes, setMarkdownRenderer, type ShortcodeContext } from "./shortcodes.ts";

// GFM features matching pulldown-cmark's enabled set: tables, strikethrough, task
// lists, footnotes — but NOT autolink literals (pulldown-cmark doesn't autolink bare
// URLs) and NOT the GFM tagfilter.
function remarkGfmNoAutolink(this: any) {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(gfmStrikethrough(), gfmTable(), gfmTaskListItem(), gfmFootnote());
  fromMarkdownExtensions.push(
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
    gfmFootnoteFromMarkdown()
  );
}

function hastText(node: any): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" || node.type === "root") {
    return (node.children || []).map(hastText).join("");
  }
  return "";
}

// Rehype: rewrite <pre><code class="language-X"> to Zola's wrapper attributes.
function rehypeZolaCode() {
  return (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "pre") return;
      const code = (node.children || []).find((c: any) => c.type === "element" && c.tagName === "code");
      if (!code) return;
      const classes: string[] = (code.properties?.className as string[]) || [];
      const langClass = classes.find((c) => c.startsWith("language-"));
      const lang = langClass ? langClass.slice("language-".length) : undefined;
      if (lang) {
        node.properties = { className: [`language-${lang}`, "z-code"], "data-lang": lang };
        code.properties = { className: [`language-${lang}`], "data-lang": lang };
      } else {
        node.properties = { className: ["z-code"] };
        code.properties = {};
      }
    });
  };
}

export interface TocEntry {
  id: string;
  title: string;
  level: number;
  permalink: string;
  children: TocEntry[];
}

// Rehype: add heading ids (deduped), collect TOC, optionally append right anchor links.
function rehypeHeadings(opts: { insertAnchor?: string; permalink: string; toc: TocEntry[] }) {
  return (tree: any) => {
    const seen = new Map<string, number>();
    const flat: TocEntry[] = [];
    visit(tree, "element", (node: any) => {
      const m = /^h([1-6])$/.exec(node.tagName);
      if (!m) return;
      const level = parseInt(m[1], 10);
      const title = hastText(node).trim();
      let id = slugify(title);
      if (seen.has(id)) {
        const n = seen.get(id)! + 1;
        seen.set(id, n);
        id = `${id}-${n}`;
      } else {
        seen.set(id, 0);
      }
      node.properties = node.properties || {};
      node.properties.id = id;
      flat.push({ id, title, level, permalink: `${opts.permalink}#${id}`, children: [] });
      if (opts.insertAnchor === "right") {
        // Zola's anchor-link template contributes a newline before and after the link
        // (visible only via striptags/og:description; whitespace-only in the DOM).
        node.children.push({ type: "text", value: "\n" });
        node.children.push({
          type: "element",
          tagName: "a",
          properties: { className: ["anchor-link"], href: `#${id}` },
          children: [{ type: "text", value: "#" }],
        });
        node.children.push({ type: "text", value: "\n" });
      } else if (opts.insertAnchor === "left") {
        node.children.unshift({
          type: "element",
          tagName: "a",
          properties: { className: ["anchor-link"], href: `#${id}` },
          children: [{ type: "text", value: "#" }],
        });
      }
    });
    // Build nested TOC by heading level.
    const stack: TocEntry[] = [];
    for (const e of flat) {
      while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(e);
      else opts.toc.push(e);
      stack.push(e);
    }
  };
}

// Remark (mdast): resolve URLs of markdown-native links/images as Zola does. Raw-HTML
// elements (e.g. <video src>) are NOT touched. Links resolve only the `@/` internal-link
// syntax and `#fragment` (to absolute permalinks); other relative link paths (e.g.
// `../intro/`) are left for the browser. Relative image paths are resolved against the
// page permalink (colocated assets).
function remarkResolveLinks(opts: { permalink: string; nested: boolean }) {
  const { permalink, nested } = opts;
  // Resolvable relative target: not a scheme/protocol-relative/site-absolute URL, and not
  // a parent-relative path (`../…`, which Zola leaves for the browser). `#anchor` and bare
  // or `./`-prefixed paths ARE resolved (verbatim, appended to the permalink).
  const isResolvable = (u: string) =>
    !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("/") && !u.startsWith("//") && !u.startsWith("..");
  const resolve = (u: string) => {
    // `@/` internal links resolve everywhere (a render-time feature). Permalink-relative
    // resolution (#anchor / bare paths) only happens at page level, not in Zola's nested
    // `markdown` filter, which lacks page context.
    if (u.startsWith("@/")) {
      const resolved = internalLinkUrl(u.slice(2));
      if (resolved) return resolved;
    }
    if (nested) return u;
    return isResolvable(u) ? permalink + u : u;
  };
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (typeof node.url !== "string") return;
      if (node.type === "image" || node.type === "link" || node.type === "definition") {
        node.url = resolve(node.url);
      }
    });
  };
}

// Remark (mdast): handle Zola code-fence annotations. The fence info string is
// comma-separated: the first token is the language; `hide_lines=<ranges>` strips those
// 1-indexed lines (e.g. rustdoc `# ` lines folded by write-rustdoc-hide-lines). Other
// annotations (hl_lines, linenos, …) only affect highlight spans, which are normalized
// away, so they're just dropped from the language token.
function remarkZolaCodeFences() {
  return (tree: any) => {
    visit(tree, "code", (node: any) => {
      const info = [node.lang, node.meta].filter(Boolean).join(" ");
      if (!info) return;
      const tokens = info.split(",").map((t: string) => t.trim());
      node.lang = tokens[0] || null;
      node.meta = null;
      // Union all hide_lines ranges and strip once on the original line numbers (applying
      // multiple strips sequentially would re-index and remove the wrong lines).
      const hidden = new Set<number>();
      for (const t of tokens.slice(1)) {
        const m = /^hide_lines=(.+)$/.exec(t);
        if (m) collectRanges(m[1], hidden);
      }
      if (hidden.size) {
        node.value = node.value.split("\n").filter((_: string, i: number) => !hidden.has(i + 1)).join("\n");
      }
    });
  };
}

function collectRanges(spec: string, out: Set<number>) {
  for (const range of spec.split(/\s+/)) {
    const rm = /^(\d+)-(\d+)$/.exec(range);
    if (rm) {
      for (let i = +rm[1]; i <= +rm[2]; i++) out.add(i);
    } else if (/^\d+$/.test(range)) {
      out.add(+range);
    }
  }
}

// Rehype: replace the `<!-- more -->` raw comment with the continue-reading span. Raw
// HTML is emitted verbatim (no rehype-raw), matching pulldown-cmark, so the marker is a
// `raw` node whose string value we rewrite.
function rehypeContinueReading() {
  return (tree: any) => {
    visit(tree, "raw", (node: any) => {
      if (/^<!--\s*more\s*-->$/.test(node.value.trim())) {
        node.value = '<span id="continue-reading"></span>';
      }
    });
  };
}

// Reproduce striptags() of pulldown-cmark's (un-minified) HTML by removing tags from the
// serialized output. This (unlike walking hast text nodes) includes text inside raw-HTML
// blocks — e.g. the leading callout in a migration-guides page — matching Zola. Entities
// are preserved here and normalized by the comparator.
function stripHtmlTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
}

export interface RenderResult {
  html: string;
  toc: TocEntry[];
  summary?: string;
  /** striptags of the rendered content (for content-derived og:description) */
  plainText: string;
}

const MORE_RE = /<!--\s*more\s*-->/;

export function renderMarkdown(body: string, ctx: ShortcodeContext): RenderResult {
  const expanded = expandShortcodes(body, ctx);

  // Summary: HTML of content before a `<!-- more -->` marker (Zola semantics).
  let summaryHtml: string | undefined;
  const moreMatch = expanded.match(MORE_RE);
  if (moreMatch) {
    const before = renderToHtml(expanded.slice(0, moreMatch.index), ctx, [], { text: "" }, { nested: false });
    summaryHtml = before;
  }

  const toc: TocEntry[] = [];
  const ptRef = { text: "" };
  const html = renderToHtml(expanded, ctx, toc, ptRef, { nested: false });
  return { html, toc, summary: summaryHtml, plainText: ptRef.text };
}

// `nested` mirrors Zola's `markdown` filter used inside shortcode bodies: it still adds
// heading ids and processes code fences, but does NOT insert anchor links or resolve
// relative/internal links (the filter has no page link context).
function renderToHtml(
  src: string,
  ctx: ShortcodeContext,
  toc: TocEntry[],
  ptRef: { text: string },
  opts: { nested: boolean }
): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfmNoAutolink)
    .use(remarkZolaCodeFences)
    .use(remarkResolveLinks, { permalink: ctx.permalink, nested: opts.nested })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeContinueReading)
    .use(rehypeZolaCode)
    .use(rehypeHeadings, {
      insertAnchor: opts.nested ? undefined : ctx.insertAnchorLinks,
      permalink: ctx.permalink,
      toc,
    })
    .use(rehypeStringify, { allowDangerousHtml: true, closeSelfClosing: true })
    .processSync(src);
  const html = String(file);
  ptRef.text = stripHtmlTags(html);
  return html;
}

// Truncate like Tera's truncate filter (count chars, append "…" when longer).
export function truncate(s: string, length: number): string {
  const chars = Array.from(s);
  if (chars.length <= length) return s;
  return chars.slice(0, length).join("") + "…";
}

// Provide the nested renderer to the shortcode module (for `body | markdown`).
setMarkdownRenderer((src, ctx) => renderToHtml(src, ctx, [], { text: "" }, { nested: true }));
