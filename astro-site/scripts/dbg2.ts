import { loadContent } from "../src/lib/content.ts";
import { renderMarkdown } from "../src/lib/markdown.ts";
const { all } = loadContent();
for (const p of ["/foundation/meeting-minutes/board-meeting-2024-02-03/", "/news/bevy-0-11/"]) {
  const n = all.find(x => x.path === p)!;
  const r = renderMarkdown(n.body, { insertAnchorLinks: n.insertAnchorLinks, permalink: n.permalink, colocatedPath: n.colocatedPath ?? "" });
  console.log("==", p, "anchor:", n.insertAnchorLinks);
  console.log("PT:", JSON.stringify(r.plainText.slice(0,80)));
  console.log("bodyStart:", JSON.stringify(n.body.slice(0,40)));
}
