import { loadContent, templateFor } from "../src/lib/content.ts";
const { all } = loadContent();
const routes = new Set<string>();
const redirects = new Set<string>();
for (const n of all) {
  // skip redirect_to sections' own page? Zola still emits a redirect page at section path.
  routes.add(n.path);
  for (const a of n.aliases) {
    const p = (a.startsWith("/") ? a : "/" + a).replace(/\/?$/, "/");
    redirects.add(p);
  }
  if (n.redirectTo) redirects.add(n.path);
}
const out = [...routes].map(p => `R ${p}`).concat([...redirects].map(p => `A ${p}`)).sort();
console.log(out.join("\n"));
console.error(`pages+sections=${routes.size} redirects=${redirects.size}`);
