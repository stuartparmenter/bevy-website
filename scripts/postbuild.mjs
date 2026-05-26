// Post-build steps that mirror Zola's non-template output:
//  1. minify all HTML with @minify-html/node (Zola's minify_html=true: minify_css/js)
//  2. copy colocated page assets into their slugged output directories
//  3. emit redirect HTML pages for `aliases` and section `redirect_to`
//
// (Sass compilation, processed_images and the search index are handled elsewhere.)

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import minifyHtml from "@minify-html/node";
import * as sass from "sass";
import elasticlunr from "elasticlunr";
import { loadContent, REPO_ROOT, BASE_URL } from "../src/lib/content.ts";
import { renderMarkdown } from "../src/lib/markdown.ts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const CONTENT = join(REPO_ROOT, "content");

// minify_js disabled: Zola's JS minifier differs from @minify-html/node's, so inline
// scripts are emitted pre-minified (verbatim Zola output) and left untouched here.
const MINIFY_CFG = { minify_css: true, minify_js: false, keep_comments: false };

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// 1. minify HTML
let minified = 0;
for (const f of walk(DIST)) {
  if (!f.endsWith(".html")) continue;
  const src = readFileSync(f);
  const out = minifyHtml.minify(src, MINIFY_CFG);
  writeFileSync(f, out);
  minified++;
}

// 2. Zola copies non-markdown files colocated with a page (index.md dir) or a section
//    (_index.md dir) into that node's output directory — e.g. images next to a post, or
//    community/links.toml, donate/donors.toml. Mirror that.
const { all } = loadContent();
let copied = 0;
for (const node of all) {
  if (!node.srcPath) continue; // skip synthetic root
  let srcDir;
  if (node.kind === "page" && node.colocatedPath) srcDir = join(CONTENT, node.colocatedPath);
  else if (node.kind === "section") srcDir = join(CONTENT, dirname(node.relativePath));
  else continue;
  if (!existsSync(srcDir)) continue;
  const outDir = join(DIST, node.path.replace(/^\/|\/$/g, ""));
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    if (e.isDirectory() || e.name.endsWith(".md")) continue;
    mkdirSync(outDir, { recursive: true });
    copyFileSync(join(srcDir, e.name), join(outDir, e.name));
    copied++;
  }
}

// 2b. Sass: compile sass/site.scss to dist/site.css (Zola compile_sass=true, compressed).
const cssResult = sass.compile(join(REPO_ROOT, "sass/site.scss"), {
  style: "compressed",
  silenceDeprecations: ["import", "global-builtin"],
  loadPaths: [join(REPO_ROOT, "sass")],
});
writeFileSync(join(DIST, "site.css"), cssResult.css);

// 3. redirect pages
function redirectHtml(url) {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<link rel="canonical" href="${url}">` +
    `<meta http-equiv="refresh" content="0; url=${url}">` +
    `<title>Redirect</title></head><body>` +
    `<p><a href="${url}">Click here</a> to be redirected.</p></body></html>`
  );
}
function writeRedirect(urlPath, target) {
  const dir = join(DIST, urlPath.replace(/^\/|\/$/g, ""));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), minifyHtml.minify(Buffer.from(redirectHtml(target)), MINIFY_CFG));
}
function abs(p) {
  if (/^https?:\/\//.test(p)) return p;
  let s = p.startsWith("/") ? p : "/" + p;
  if (!s.endsWith("/")) s += "/";
  return BASE_URL + s;
}
let redirects = 0;
for (const node of all) {
  for (const a of node.aliases) {
    const p = (a.startsWith("/") ? a : "/" + a).replace(/\/?$/, "/");
    writeRedirect(p, node.permalink);
    redirects++;
  }
  if (node.redirectTo) {
    writeRedirect(node.path, abs(node.redirectTo));
    redirects++;
  }
}

// 4. Search index (Zola build_search_index=true): an elasticlunr index of every page
//    (id=permalink, title, body=plain text), in the same shape elasticlunr.Index.toJSON
//    produces — loadable by the bundled elasticlunr.min.js. Indexes all nodes except
//    redirect-only sections. Not byte-identical to Zola's Rust elasticlunr port, but a
//    functionally-equivalent index from the elasticlunr package itself.
const idx = elasticlunr(function () {
  this.addField("title");
  this.addField("body");
  this.setRef("id");
});
let indexed = 0;
for (const node of all) {
  if (node.redirectTo) continue;
  let body = "";
  try {
    body = renderMarkdown(node.body, {
      insertAnchorLinks: node.insertAnchorLinks,
      permalink: node.permalink,
      colocatedPath: node.colocatedPath ?? "",
    }).plainText;
  } catch {
    /* template-driven pages have no markdown body */
  }
  idx.addDoc({ id: node.permalink, title: node.title, body });
  indexed++;
}
const indexObj = JSON.parse(JSON.stringify(idx));
indexObj.lang = "English";
writeFileSync(join(DIST, "search_index.en.js"), `window.searchIndex = ${JSON.stringify(indexObj)};`);

// 5. Ship the elasticlunr runtime from the npm package (no longer vendored).
copyFileSync(join(REPO_ROOT, "node_modules/elasticlunr/elasticlunr.min.js"), join(DIST, "elasticlunr.min.js"));

console.log(`postbuild: minified ${minified} html, copied ${copied} colocated assets, wrote ${redirects} redirects, indexed ${indexed} docs`);
