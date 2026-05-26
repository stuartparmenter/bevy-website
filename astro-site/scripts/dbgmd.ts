import { loadContent } from "../src/lib/content.ts";
import { renderMarkdown } from "../src/lib/markdown.ts";
const { all } = loadContent();
const n = all.find(x => x.path === "/foundation/meeting-minutes/recording-votes/")!;
const r = renderMarkdown(n.body, { insertAnchorLinks: n.insertAnchorLinks, permalink: n.permalink, colocatedPath: n.colocatedPath ?? "" });
console.log("PLAINTEXT:", JSON.stringify(r.plainText.slice(0,180)));
console.log("HTML head:", JSON.stringify(r.html.slice(0,200)));
