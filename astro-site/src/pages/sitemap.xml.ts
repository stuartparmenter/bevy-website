// Mirrors templates/sitemap.xml: one <url> per page/section without extra.status.
import { loadContent } from "../lib/content.ts";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function GET() {
  const { all } = loadContent();
  const entries = all
    .filter((n) => !(n.extra && n.extra.status))
    .sort((a, b) => a.permalink.localeCompare(b.permalink));
  const urls = entries
    .map((e) => {
      const lastmod = e.date ? `\n        <lastmod>${e.date}</lastmod>` : "";
      return `    <url>\n        <loc>${escapeXml(e.permalink)}</loc>${lastmod}\n    </url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  return new Response(body, { headers: { "Content-Type": "application/xml" } });
}
