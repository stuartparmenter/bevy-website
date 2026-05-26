// Logic for templates/docs.html: root-section resolution, reading-order flattening,
// prev/next navigation. Mirrors the Tera traversal (pages+subsections interleaved and
// sorted by extra.weight, pre-order DFS; migration guides reversed).
import { loadContent, type Node } from "./content.ts";

// base.html root_section_paths (workaround list).
const ROOT_SECTION_PATHS = [
  "learn/quick-start",
  "learn/book",
  "learn/migration-guides",
  "learn/advanced-examples",
  "learn/errors",
  "learn/contribute",
];

export function rootSectionFor(node: Node): Node | undefined {
  const { byPath } = loadContent();
  for (const rp of ROOT_SECTION_PATHS) {
    const comps = rp.split("/");
    if (node.components.slice(0, comps.length).join("/") === comps.join("/")) {
      return byPath.get("/" + rp + "/");
    }
  }
  return undefined;
}

export function isMigrationGuide(currentPath: string): boolean {
  return currentPath.startsWith("/learn/migration-guides");
}

// Combine a section's pages and subsections, sorted by extra.weight. Pages precede
// subsections at equal weight (Tera `pages | concat(with=subsections)`); the base array
// is already ordered by source path, giving a deterministic forward-alphabetical tiebreak.
//
// TODO: Zola breaks equal-weight ties using its filesystem-walk order, which is
// non-portable. This matches every docs section except two book pairs
// (the-renderer/assets, release-builds/profiling) whose Zola order is reverse-alpha. The
// menu comparison is order-insensitive (see tools/compare.mjs) so the menu still matches;
// only the prev/next footer of those ~2 pages can differ. Pin down Zola's real order to
// remove the discrepancy.
export function pagesAndSections(section: Node): Node[] {
  const items = [...section.pages, ...section.subsections];
  return items
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.weight - b.n.weight) || (a.i - b.i))
    .map((x) => x.n);
}

// Pre-order DFS flatten in reading order (matches docs.html's manual 3-level nesting).
export function flattenReading(root: Node, isMigration: boolean): Node[] {
  const out: Node[] = [];
  const walk = (section: Node) => {
    for (const item of pagesAndSections(section)) {
      out.push(item);
      if (item.kind === "section") walk(item);
    }
  };
  walk(root);
  return isMigration ? out.reverse() : out;
}

export function prevNext(node: Node): { prev?: Node; next?: Node } {
  const root = rootSectionFor(node);
  if (!root) return {};
  const all = flattenReading(root, isMigrationGuide(node.path));
  let prev: Node | undefined;
  let next: Node | undefined;
  let foundCurrent = false;
  for (const p of all) {
    if (foundCurrent) {
      if (p.extra && p.extra.public_draft) continue;
      next = p;
      break;
    }
    if (node.path === p.path) {
      foundCurrent = true;
      continue;
    }
    if (p.extra && p.extra.public_draft) continue;
    prev = p;
  }
  return { prev, next };
}

// public_draft::warning chain: returns the warning kind for the current node, plus
// whether any ancestor section is a public draft (=> noindex).
export function ancestorIsPublicDraft(node: Node): boolean {
  // base.html computes this from section_or_page.ancestors in docs.html head_extensions.
  let p: Node | undefined = node.parent;
  while (p) {
    if (p.extra && p.extra.public_draft) return true;
    p = p.parent;
  }
  return false;
}
