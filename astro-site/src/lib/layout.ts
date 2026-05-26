// Helpers mirroring Tera macros/logic from templates/layouts/base.html + macros/.
import type { Node } from "./content.ts";
import { loadData } from "./content.ts";

// Zola's minify_html minifies inline JS with a different JS minifier than
// @minify-html/node, so these are stored verbatim as Zola emits them and the post-build
// minifier runs with minify_js disabled (there are only these 3 distinct inline scripts
// site-wide). minify_css remains on, since that engine matches Zola's exactly.
export const PLAUSIBLE_SCRIPT =
  "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||(a=>{plausible.o=a||{}});plausible.init()";

export const SHOW_DRAFTS_SCRIPT =
  "const search_params=new URLSearchParams(window.location.search);if(search_params.has(`show_drafts`)||document.cookie.indexOf(`show_drafts`)>=0){let a=`show_drafts`;if(search_params.get(a)===`0`){document.cookie=`show_drafts=;path=/;expires=Thu, 01 Jan 1970 00:00:00 UTC`}else{document.cookie=`show_drafts=1;path=/`;document.body.classList.add(a)}}";

export const IMAGE_COMPARE_SCRIPT =
  'import{enable_image_compare as a}from"/components.js";document.addEventListener(`DOMContentLoaded`,(()=>{a()}))';

const startsWith = (s: string | undefined, p: string) => !!s && s.startsWith(p);

// macros/base.html :: page_header_message
export function pageHeaderMessage(node?: Node): string {
  if (!node) return "";
  const ex = node.extra || {};
  if (ex.header_message) return ex.header_message;
  const p = node.path;
  if (startsWith(p, "/learn/book/")) return "The Book";
  if (startsWith(p, "/learn/migration-guides/")) return "Migration Guides";
  if (startsWith(p, "/learn/errors/")) return "Errors";
  if (startsWith(p, "/learn/quick-start/")) return "Quick Start";
  if (startsWith(p, "/learn/advanced-examples")) return "Advanced Examples";
  if (startsWith(p, "/learn/contribute/")) return "Contribute";
  if (startsWith(p, "/news/")) return "News";
  if (p === "/") return "Features";
  return "";
}

// layouts/base.html page_title computation
export function pageTitle(node?: Node): string {
  const title = node?.title;
  if (!title) return "Bevy Engine";
  const p = node!.path;
  if (startsWith(p, "/learn/book/")) return "Bevy Book: " + title;
  if (startsWith(p, "/learn/errors/")) return "Bevy Errors: " + title;
  if (startsWith(p, "/assets")) return "Bevy Assets";
  return title;
}

export interface HeaderItem {
  name: string;
  path?: string;
  extraClass?: string;
}

export const HEADER_ITEMS: HeaderItem[] = [
  { name: "Getting Started", path: "/learn/quick-start/getting-started", extraClass: "main-menu__entry--getting-started" },
  { name: "Learn" },
  { name: "News" },
  { name: "Community" },
  { name: "Foundation" },
  { name: "Assets" },
  { name: "Examples" },
];

// macros/header.html :: header_item -> { href, active }
export function headerItem(item: HeaderItem, currentPath: string) {
  const lower = currentPath.toLowerCase();
  const home = "/";
  const route = item.path ? item.path : "/" + item.name;
  const currentlyHome = item.path === home && lower === home;
  const isActive = lower.startsWith("/" + item.name.toLowerCase()) || currentlyHome;
  return {
    href: route.toLowerCase() + "/",
    active: isActive,
    name: item.name,
    extraClass: item.extraClass || "",
  };
}

export interface FooterLink {
  title: string;
  url: string;
  image: string;
  image_alt: string;
  show_in_footer?: boolean;
}

export function footerLinks(): FooterLink[] {
  const data = loadData("content/community/links.toml");
  return (data.links as FooterLink[]).filter((l) => l.show_in_footer);
}

// Whether base.html sets a noindex robots meta. In base.html the check runs *before*
// the head_extensions block that assigns `ancestor_is_public_draft`, so that variable is
// always still false at check time — only the node's OWN extra.public_draft triggers it.
export function isNoindex(node?: Node, _ancestorIsPublicDraft = false): boolean {
  return !!(node && node.extra && node.extra.public_draft);
}
