// Mirrors templates/atom.xml: the site-wide feed of all dated pages, newest first.
// Tera auto-escapes the .xml template, so title/summary/content are HTML-escaped here.
import { loadContent, type Node } from "../lib/content.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { rfc3339 } from "../lib/dates.ts";

const FEED_URL = "https://bevy.org/atom.xml";
const CONFIG_TITLE = "Bevy Engine";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function GET() {
  const { all } = loadContent();
  const pages = all
    .filter((n) => n.kind === "page" && n.date && !(n.extra && n.extra.public_draft))
    .sort((a, b) => (b.dateRaw || "").localeCompare(a.dateRaw || "") || a.permalink.localeCompare(b.permalink));

  const lastUpdated = pages.length ? rfc3339(pages[0].date!) : "";

  const entries = pages
    .map((page) => {
      const rendered = renderMarkdown(page.body, {
        insertAnchorLinks: page.insertAnchorLinks,
        permalink: page.permalink,
        colocatedPath: page.colocatedPath ?? "",
      });
      const published = rfc3339(page.date!);
      const updated = page.extra && page.extra.updated ? rfc3339(String(page.extra.updated)) : published;
      const authors = page.authors.length
        ? page.authors.map((a) => `<author>\n          <name>\n            ${esc(a)}\n          </name>\n        </author>`).join("\n        ")
        : `<author>\n          <name>\n            Unknown\n          </name>\n        </author>`;
      // Tera treats an empty summary as falsy, so a page whose `<!-- more -->` sits at the
      // very top (e.g. meeting minutes) uses full content, not an empty summary.
      const hasSummary = !!(rendered.summary && rendered.summary.trim());
      const contentOrSummary = hasSummary
        ? `<summary type="html">${esc(rendered.summary)}</summary>`
        : `<content type="html" xml:base="${page.permalink}">${esc(rendered.html)}</content>`;
      return (
        `    <entry xml:lang="en">\n` +
        `        <title>${esc(page.title)}</title>\n` +
        `        <published>${published}</published>\n` +
        `        <updated>${updated}</updated>\n` +
        `        ${authors}\n` +
        `        <link rel="alternate" type="text/html" href="${page.permalink}"/>\n` +
        `        <id>${page.permalink}</id>\n` +
        `        ${contentOrSummary}\n` +
        `    </entry>`
      );
    })
    .join("\n");

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">\n` +
    `    <title>${CONFIG_TITLE}</title>\n` +
    `    <link rel="self" type="application/atom+xml" href="${FEED_URL}"/>\n` +
    `    <link rel="alternate" type="text/html" href="https://bevy.org"/>\n` +
    `    <generator uri="https://www.getzola.org/">Zola</generator>\n` +
    `    <updated>${lastUpdated}</updated>\n` +
    `    <id>${FEED_URL}</id>\n` +
    `${entries}\n` +
    `</feed>`;
  return new Response(body, { headers: { "Content-Type": "application/xml" } });
}
