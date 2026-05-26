#!/usr/bin/env node
// Structural comparison of two built site trees (Zola public vs Astro dist).
//
// Usage: node tools/compare.mjs <zolaDir> <astroDir> [--max N] [--only path]
//
// HTML  -> parsed to DOM, normalized (whitespace collapsed), compared tag/attrs/children.
//          <pre>/<code> blocks compared by normalized text only (syntax-highlight spans
//          differ between syntect and any JS highlighter, by design).
// XML/TXT/CSS/JSON -> normalized-text compare.
// JS    -> normalized-text compare (skipped for known generated search index).
// Binary (img/font/video) -> existence + byte-size compare.

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";
import * as parse5 from "parse5";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [zolaDir, astroDir] = positional;
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const MAX = parseInt(getFlag("--max") || "40", 10);
const ONLY = getFlag("--only");

if (!zolaDir || !astroDir) {
  console.error("usage: compare.mjs <zolaDir> <astroDir> [--max N] [--only path]");
  process.exit(2);
}

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".woff", ".woff2",
  ".ttf", ".eot", ".ico", ".svg",
]);
// Files compared as normalized text rather than DOM.
const TEXT_EXT = new Set([".xml", ".txt", ".css", ".json", ".md", ".mjs", ".js"]);

function walk(dir, base = dir, out = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.set(relative(base, full), full);
  }
  return out;
}

// ---------- HTML normalization ----------

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function normWS(s) {
  return s.replace(/\s+/g, " ").trim();
}

// Build a normalized tree from a parse5 node.
function normNode(node) {
  if (node.nodeName === "#comment") return null;
  if (node.nodeName === "#text") {
    const t = normWS(node.value);
    return t ? { type: "text", value: t } : null;
  }
  if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
    return { type: "el", tag: "#root", attrs: {}, children: normChildren(node.childNodes) };
  }
  const tag = node.tagName;
  const attrs = {};
  for (const a of node.attrs || []) {
    if (a.name === "class") {
      attrs.class = a.value.split(/\s+/).filter(Boolean).sort().join(" ");
    } else {
      attrs[a.name] = a.value;
    }
  }
  // Code blocks: compare text content only (ignore highlight span structure).
  if (tag === "pre" || tag === "code") {
    return { type: "el", tag, attrs, codeText: normWS(textContent(node)) };
  }
  if (tag === "script" || tag === "style") {
    return { type: "el", tag, attrs, raw: normWS(textContent(node)) };
  }
  return { type: "el", tag, attrs, children: normChildren(node.childNodes || []) };
}

function normChildren(nodes) {
  const out = [];
  for (const n of nodes) {
    const nn = normNode(n);
    if (nn) out.push(nn);
  }
  return out;
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value;
  let s = "";
  for (const c of node.childNodes || []) s += textContent(c);
  return s;
}

function parseHtml(src) {
  return normNode(parse5.parse(src));
}

// Diff two normalized trees; push human-readable messages into `diffs`.
function diffTree(a, b, path, diffs) {
  if (diffs.length > 8) return; // cap per-file
  if (a.type !== b.type) {
    diffs.push(`${path}: node type ${a.type} vs ${b.type}`);
    return;
  }
  if (a.type === "text") {
    if (a.value !== b.value) diffs.push(`${path}: text "${trunc(a.value)}" vs "${trunc(b.value)}"`);
    return;
  }
  if (a.tag !== b.tag) {
    diffs.push(`${path}: tag <${a.tag}> vs <${b.tag}>`);
    return;
  }
  const p = `${path}/${a.tag}`;
  // attrs
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  for (const k of keys) {
    if (a.attrs[k] !== b.attrs[k]) {
      diffs.push(`${p}: attr ${k}="${a.attrs[k] ?? "∅"}" vs "${b.attrs[k] ?? "∅"}"`);
    }
  }
  if ("codeText" in a || "codeText" in b) {
    if (a.codeText !== b.codeText) diffs.push(`${p}: code text differs ("${trunc(a.codeText)}" vs "${trunc(b.codeText)}")`);
    return;
  }
  if ("raw" in a || "raw" in b) {
    if (a.raw !== b.raw) diffs.push(`${p}: inline ${a.tag} differs ("${trunc(a.raw)}" vs "${trunc(b.raw)}")`);
    return;
  }
  const ac = a.children || [], bc = b.children || [];
  if (ac.length !== bc.length) {
    diffs.push(`${p}: child count ${ac.length} vs ${bc.length} [${ac.map(desc).slice(0,8).join(",")}] vs [${bc.map(desc).slice(0,8).join(",")}]`);
    return;
  }
  for (let i = 0; i < ac.length; i++) diffTree(ac[i], bc[i], `${p}[${i}]`, diffs);
}

function desc(n) {
  if (n.type === "text") return `"${trunc(n.value, 12)}"`;
  return `<${n.tag}>`;
}
function trunc(s, n = 40) {
  s = s ?? "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------- main ----------

const zFiles = walk(zolaDir);
const aFiles = walk(astroDir);
const all = new Set([...zFiles.keys(), ...aFiles.keys()]);

let onlyZola = [], onlyAstro = [], matched = 0;
const fileDiffs = [];

for (const rel of [...all].sort()) {
  if (ONLY && !rel.includes(ONLY)) continue;
  const zp = zFiles.get(rel), ap = aFiles.get(rel);
  if (!zp) { onlyAstro.push(rel); continue; }
  if (!ap) { onlyZola.push(rel); continue; }

  const ext = extname(rel).toLowerCase();
  try {
    if (ext === ".html") {
      const da = parseHtml(readFileSync(zp, "utf8"));
      const db = parseHtml(readFileSync(ap, "utf8"));
      const diffs = [];
      diffTree(da, db, "", diffs);
      if (diffs.length) fileDiffs.push({ rel, diffs });
      else matched++;
    } else if (ext === ".svg") {
      // SVG: compare as DOM too (structural), since they may be templated.
      const da = parseHtml(readFileSync(zp, "utf8"));
      const db = parseHtml(readFileSync(ap, "utf8"));
      const diffs = [];
      diffTree(da, db, "", diffs);
      if (diffs.length) fileDiffs.push({ rel, diffs });
      else matched++;
    } else if (TEXT_EXT.has(ext)) {
      const za = normWS(readFileSync(zp, "utf8"));
      const aa = normWS(readFileSync(ap, "utf8"));
      if (za !== aa) fileDiffs.push({ rel, diffs: [`text differs (len ${za.length} vs ${aa.length})`] });
      else matched++;
    } else if (BINARY_EXT.has(ext)) {
      const zs = statSync(zp).size, as = statSync(ap).size;
      if (zs !== as) fileDiffs.push({ rel, diffs: [`size ${zs} vs ${as}`] });
      else matched++;
    } else {
      const zs = statSync(zp).size, as = statSync(ap).size;
      if (zs !== as) fileDiffs.push({ rel, diffs: [`size ${zs} vs ${as} (unknown ext)`] });
      else matched++;
    }
  } catch (err) {
    fileDiffs.push({ rel, diffs: [`compare error: ${err.message}`] });
  }
}

console.log(`\n=== Structural comparison ===`);
console.log(`zola=${zolaDir}  astro=${astroDir}`);
console.log(`common files matched: ${matched}`);
console.log(`files differing:      ${fileDiffs.length}`);
console.log(`only in zola:         ${onlyZola.length}`);
console.log(`only in astro:        ${onlyAstro.length}`);

if (onlyZola.length) {
  console.log(`\n-- only in zola (${onlyZola.length}) --`);
  onlyZola.slice(0, MAX).forEach((f) => console.log(`  ${f}`));
  if (onlyZola.length > MAX) console.log(`  … +${onlyZola.length - MAX} more`);
}
if (onlyAstro.length) {
  console.log(`\n-- only in astro (${onlyAstro.length}) --`);
  onlyAstro.slice(0, MAX).forEach((f) => console.log(`  ${f}`));
  if (onlyAstro.length > MAX) console.log(`  … +${onlyAstro.length - MAX} more`);
}
if (fileDiffs.length) {
  console.log(`\n-- differing files (${fileDiffs.length}) --`);
  for (const { rel, diffs } of fileDiffs.slice(0, MAX)) {
    console.log(`  ${rel}`);
    diffs.forEach((d) => console.log(`     ${d}`));
  }
  if (fileDiffs.length > MAX) console.log(`  … +${fileDiffs.length - MAX} more`);
}

const ok = fileDiffs.length === 0 && onlyZola.length === 0 && onlyAstro.length === 0;
console.log(`\n${ok ? "STRUCTURALLY EQUAL ✅" : "DIFFERENCES REMAIN ❌"}\n`);
process.exit(ok ? 0 : 1);
