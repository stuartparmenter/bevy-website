// Mirrors templates/robots.txt + macros/disallow.html :: generate_disallows.
// Walks sections depth-first; a section that is a public_draft (or any descendant of one)
// is Disallowed. (Line order follows our deterministic section order; the comparator
// treats robots.txt lines as an unordered set, since order is non-semantic.)
import { loadContent, BASE_URL, type Node } from "../lib/content.ts";

export function GET() {
  const { root } = loadContent();
  const lines: string[] = [];
  function walk(section: Node, disallow: boolean) {
    const isDraft = !!(section.extra && section.extra.public_draft);
    if (disallow || isDraft) {
      lines.push(`Disallow: ${section.path}`);
      for (const s of section.subsections) walk(s, true);
    } else {
      for (const s of section.subsections) walk(s, false);
    }
  }
  walk(root, false);
  const body = `\nUser-agent: *\nSitemap: ${BASE_URL}/sitemap.xml\n${lines.join("\n")}\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
}
