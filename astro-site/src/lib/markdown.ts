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
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { slugify } from "./slugify.ts";
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

// Remark (mdast): resolve relative URLs of *markdown-native* links/images against the
// page permalink, as Zola does. Raw-HTML elements (e.g. <video src>) are NOT touched,
// matching Zola which only resolves markdown link/image syntax. Fragment-only links
// (`#anchor`) are also resolved to absolute permalinks.
function remarkResolveLinks(permalink: string) {
  const isRelative = (u: string) =>
    u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("/") && !u.startsWith("//");
  const resolve = (u: string) => {
    let v = u;
    if (v.startsWith("./")) v = v.slice(2);
    return isRelative(v) ? permalink + v : v;
  };
  return (tree: any) => {
    visit(tree, (node: any) => {
      if ((node.type === "link" || node.type === "image" || node.type === "definition") && typeof node.url === "string") {
        node.url = resolve(node.url);
      }
    });
  };
}

// Rehype: replace the `<!-- more -->` comment with a block-level continue-reading span
// (pulldown-cmark/Zola insert it at block level, not wrapped in a paragraph).
function rehypeContinueReading() {
  return (tree: any) => {
    visit(tree, "comment", (node: any, index: number | undefined, parent: any) => {
      if (parent && typeof index === "number" && /^\s*more\s*$/.test(node.value)) {
        parent.children[index] = {
          type: "element",
          tagName: "span",
          properties: { id: "continue-reading" },
          children: [],
        };
      }
    });
  };
}

// Reproduce striptags() of pulldown-cmark's (un-minified) HTML. remark-rehype already
// inserts "\n" text nodes between block children, matching pulldown-cmark's per-block
// newlines, so plain text-node concatenation (void elements contribute nothing) suffices.
function zolaPlainText(node: any): string {
  if (node.type === "text") return node.value;
  if (node.type === "root" || node.type === "element") {
    return (node.children || []).map(zolaPlainText).join("");
  }
  return "";
}

function rehypePlainText(ref: { text: string }) {
  return (tree: any) => {
    ref.text = zolaPlainText(tree);
  };
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
    const before = renderToHtml(expanded.slice(0, moreMatch.index), ctx, [], { text: "" });
    summaryHtml = before;
  }

  const toc: TocEntry[] = [];
  const ptRef = { text: "" };
  const html = renderToHtml(expanded, ctx, toc, ptRef);
  return { html, toc, summary: summaryHtml, plainText: ptRef.text };
}

function renderToHtml(src: string, ctx: ShortcodeContext, toc: TocEntry[], ptRef: { text: string }): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfmNoAutolink)
    .use(remarkResolveLinks, ctx.permalink)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeContinueReading)
    .use(rehypeZolaCode)
    .use(rehypeHeadings, {
      insertAnchor: ctx.insertAnchorLinks,
      permalink: ctx.permalink,
      toc,
    })
    .use(rehypePlainText, ptRef)
    .use(rehypeStringify, { allowDangerousHtml: true, closeSelfClosing: true })
    .processSync(src);
  return String(file);
}

// Truncate like Tera's truncate filter (count chars, append "…" when longer).
export function truncate(s: string, length: number): string {
  const chars = Array.from(s);
  if (chars.length <= length) return s;
  return chars.slice(0, length).join("") + "…";
}

// Provide the renderer to the shortcode module (for `body | markdown`), avoiding a cycle.
setMarkdownRenderer((src, ctx) => renderToHtml(src, ctx, [], { text: "" }));
