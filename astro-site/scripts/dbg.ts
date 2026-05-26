import { loadContent, templateFor } from "../src/lib/content.ts";
const { all } = loadContent();
const rv = all.find(n => n.path === "/foundation/meeting-minutes/recording-votes/");
console.log("found:", !!rv, "template:", rv && templateFor(rv), "parent:", rv?.parent?.path, "parentPageTemplate:", rv?.parent?.pageTemplate);
const counts: Record<string,number> = {};
for (const n of all) { const t = templateFor(n); counts[t]=(counts[t]||0)+1; }
console.log(counts);
