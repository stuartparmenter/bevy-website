// Zola-equivalent content model: walk content/, parse TOML frontmatter, and compute
// section/page nodes with the same routing, slugs, dates, ordering, aliases and
// redirects that Zola produces. This replaces Zola's content pipeline.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { slugify } from "./slugify.ts";

// Find the Zola repo root by walking up from cwd for the marker `config.toml`
// (bundling relocates this module, so a module-relative path is unreliable).
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "config.toml")) && existsSync(join(dir, "content"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  // fallback: parent of cwd (astro-site -> repo)
  return resolve(process.cwd(), "..");
}

export const REPO_ROOT = findRepoRoot();
export const CONTENT_DIR = join(REPO_ROOT, "content");
export const BASE_URL = "https://bevy.org";

export interface Node {
  kind: "section" | "page";
  srcPath: string;
  relativePath: string; // relative to content/, e.g. "news/2025-.../index.md"
  title: string;
  date?: string; // YYYY-MM-DD
  dateRaw?: string; // original string for ordering
  authors: string[];
  description?: string;
  extra: Record<string, any>;
  weight: number;
  template?: string;
  pageTemplate?: string;
  insertAnchorLinks?: string;
  sortBy?: string;
  redirectTo?: string;
  aliases: string[];
  slug: string;
  path: string; // url path, leading + trailing slash, e.g. "/news/bevy-0-17/"
  permalink: string;
  components: string[];
  colocatedPath?: string; // for colocated pages: "news/2025-.../"
  body: string;
  // tree links (filled after build)
  parent?: Node;
  pages: Node[]; // section: child pages
  subsections: Node[]; // section: child sections
  draft: boolean;
}

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-/;

function splitFrontmatter(raw: string): { fm: string; body: string } {
  if (raw.startsWith("+++")) {
    const end = raw.indexOf("\n+++", 3);
    if (end !== -1) {
      const fm = raw.slice(3, end);
      let body = raw.slice(end + 4);
      if (body.startsWith("\n")) body = body.slice(1);
      return { fm, body };
    }
  }
  return { fm: "", body: raw };
}

function parseFrontmatter(fm: string): Record<string, any> {
  if (!fm.trim()) return {};
  // smol-toml handles TOML dates as Date objects; keep as-is and normalize later.
  return parseToml(fm) as Record<string, any>;
}

function tomlDateToIso(v: any): { iso?: string; raw?: string } {
  if (v == null) return {};
  if (v instanceof Date) {
    const iso = v.toISOString().slice(0, 10);
    return { iso, raw: iso };
  }
  if (typeof v === "string") {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return { iso: m ? m[1] : v, raw: v };
  }
  // smol-toml local date objects expose toString()
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return { iso: m ? m[1] : s, raw: s };
}

function readNode(srcPath: string): Node | null {
  const rel = relative(CONTENT_DIR, srcPath);
  const raw = readFileSync(srcPath, "utf8");
  const { fm, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(fm);
  const fileName = basename(srcPath);
  const isSection = fileName === "_index.md";

  const dirRel = dirname(rel); // "" for root
  const dirParts = dirRel === "." || dirRel === "" ? [] : dirRel.split("/");

  // Determine slug + date.
  let slug: string;
  let date: string | undefined;
  let dateRaw: string | undefined;

  const extra = (meta.extra as Record<string, any>) || {};

  if (isSection) {
    // Section slug/path comes from directory components (literal dir names).
    slug = dirParts.length ? dirParts[dirParts.length - 1] : "";
  } else {
    let base = fileName.replace(/\.md$/, "");
    let dateSource = base;
    if (base === "index") {
      // colocated: derive from directory name
      base = dirParts.length ? dirParts[dirParts.length - 1] : "";
      dateSource = base;
    }
    const dm = dateSource.match(DATE_PREFIX);
    if (dm) {
      date = `${dm[1]}-${dm[2]}-${dm[3]}`;
      dateRaw = date;
      base = base.replace(DATE_PREFIX, "");
    }
    slug = (meta.slug as string) || slugify(base);
  }

  // Frontmatter date overrides derived date.
  if (meta.date != null) {
    const d = tomlDateToIso(meta.date);
    date = d.iso;
    dateRaw = d.raw;
  }

  // Compute URL path.
  const isColocated = !isSection && fileName === "index.md";
  let path: string;
  if (isSection) {
    path = dirParts.length ? "/" + dirParts.join("/") + "/" : "/";
  } else {
    // A colocated page (index.md in its own dir) replaces that directory in the URL;
    // a regular page (foo.md) nests under its directory.
    const parentParts = isColocated ? dirParts.slice(0, -1) : dirParts;
    const parentPath = parentParts.length ? "/" + parentParts.join("/") + "/" : "/";
    path = parentPath + slug + "/";
  }

  const components = path.replace(/^\/|\/$/g, "").split("/").filter(Boolean);

  // colocated path (for pages that live in their own directory as index.md)
  let colocatedPath: string | undefined;
  if (!isSection && fileName === "index.md") {
    colocatedPath = dirRel === "." ? "" : dirRel + "/";
  }

  const status = extra.status;
  const isDraft = !!extra.public_draft;

  return {
    kind: isSection ? "section" : "page",
    srcPath,
    relativePath: rel,
    title: meta.title ?? "",
    date,
    dateRaw,
    authors: (meta.authors as string[]) || [],
    description: meta.description,
    extra,
    weight: typeof extra.weight === "number" ? extra.weight : meta.weight ?? 0,
    template: meta.template,
    pageTemplate: meta.page_template,
    insertAnchorLinks: meta.insert_anchor_links,
    sortBy: meta.sort_by,
    redirectTo: meta.redirect_to,
    aliases: (meta.aliases as string[]) || [],
    slug,
    path,
    permalink: BASE_URL + path,
    components,
    colocatedPath,
    body,
    pages: [],
    subsections: [],
    draft: isDraft,
    // @ts-expect-error transient
    _status: status,
  } as Node;
}

let _cache: { all: Node[]; byPath: Map<string, Node>; root: Node } | null = null;

export function loadContent() {
  if (_cache) return _cache;
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) files.push(full);
    }
  })(CONTENT_DIR);

  const all: Node[] = [];
  for (const f of files) {
    const n = readNode(f);
    if (n) all.push(n);
  }

  // Zola synthesizes an implicit root section when content/_index.md is absent.
  if (!all.some((n) => n.kind === "section" && n.path === "/")) {
    all.push({
      kind: "section",
      srcPath: "",
      relativePath: "_index.md",
      title: "",
      authors: [],
      extra: {},
      weight: 0,
      template: "index.html",
      aliases: [],
      slug: "",
      path: "/",
      permalink: BASE_URL + "/",
      components: [],
      body: "",
      pages: [],
      subsections: [],
      draft: false,
    } as Node);
  }

  const byPath = new Map<string, Node>();
  for (const n of all) byPath.set(n.path, n);

  // Link tree: assign each page/section to its parent section.
  const sections = all.filter((n) => n.kind === "section");
  const sectionByPath = new Map(sections.map((s) => [s.path, s]));

  function parentSectionPath(n: Node): string | undefined {
    if (n.path === "/") return undefined;
    // strip last component
    const comps = n.path.replace(/^\/|\/$/g, "").split("/");
    comps.pop();
    return comps.length ? "/" + comps.join("/") + "/" : "/";
  }

  for (const n of all) {
    if (n.kind === "section" && n.path === "/") continue;
    const pp = parentSectionPath(n);
    if (pp == null) continue;
    const parent = sectionByPath.get(pp);
    if (!parent) continue;
    n.parent = parent;
    if (n.kind === "page") parent.pages.push(n);
    else parent.subsections.push(n);
  }

  // Sort pages within each section per its sort_by (date desc, else weight asc).
  for (const s of sections) {
    if (s.sortBy === "date") {
      s.pages.sort((a, b) => (b.dateRaw || "").localeCompare(a.dateRaw || ""));
    } else {
      s.pages.sort((a, b) => a.weight - b.weight);
    }
    s.subsections.sort((a, b) => a.weight - b.weight);
  }

  // Pages inherit insert_anchor_links from their nearest ancestor section (Zola behavior).
  for (const n of all) {
    if (n.insertAnchorLinks != null) continue;
    let p = n.parent;
    while (p) {
      if (p.insertAnchorLinks != null) {
        n.insertAnchorLinks = p.insertAnchorLinks;
        break;
      }
      p = p.parent;
    }
  }

  const root = sectionByPath.get("/")!;
  _cache = { all, byPath, root };
  return _cache;
}

// Resolve which template a node uses, honoring section page_template inheritance.
export function templateFor(n: Node): string {
  if (n.kind === "section") return n.template || "section.html";
  if (n.template) return n.template;
  // inherit page_template from nearest ancestor section
  let p = n.parent;
  while (p) {
    if (p.pageTemplate) return p.pageTemplate;
    p = p.parent;
  }
  return "page.html";
}

// load_data equivalent: parse a TOML file relative to repo root.
export function loadData(relPath: string): any {
  const full = join(REPO_ROOT, relPath);
  const raw = readFileSync(full, "utf8");
  if (relPath.endsWith(".toml")) return parseToml(raw);
  return raw;
}

// Resolve a Zola internal link target `path/to/file.md[#anchor]` (the part after `@/`)
// to the destination page's permalink (+ anchor).
export function internalLinkUrl(target: string): string | undefined {
  const hashIdx = target.indexOf("#");
  const filePart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const anchor = hashIdx >= 0 ? target.slice(hashIdx) : "";
  const { all } = loadContent();
  const node = all.find((n) => n.relativePath === filePart);
  if (!node) return undefined;
  return node.permalink + anchor;
}

export function fileExists(relPath: string): boolean {
  try {
    statSync(join(REPO_ROOT, relPath));
    return true;
  } catch {
    return false;
  }
}
