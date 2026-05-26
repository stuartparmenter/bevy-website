// Port of generate-community/src/lib.rs to TypeScript.
//
// Reads the `bevy-community` repo layout and builds an in-memory tree of
// sections and members, mirroring the Rust data model and directory walk.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parse as parseToml } from "smol-toml";

// Known member keys (kebab-case in the TOML files). Used to enforce the Rust
// crate's `#[serde(deny_unknown_fields)]` behaviour.
const MEMBER_KEYS = new Set([
  "name",
  "profile-picture",
  "sponsor",
  "bio",
  "discord",
  "discord-userid",
  "github",
  "mastodon",
  "twitter",
  "bluesky",
  "instagram",
  "itch-io",
  "steam-developer",
  "website",
  "roles",
]);

export type ProfilePicture =
  | { kind: "GitHub" }
  | { kind: "File"; file: string };

export interface Mastodon {
  username: string;
  instance: string;
}

export interface Member {
  name: string;
  profilePicture: ProfilePicture | null;
  sponsor: string | null;
  bio: string | null;

  // social links
  discord: string | null;
  discordUserid: string | null;
  github: string | null;
  mastodon: Mastodon | null;
  twitter: string | null;
  bluesky: string | null;
  instagram: string | null;
  itchIo: string | null;
  steamDeveloper: string | null;
  website: string | null;

  // not read from the toml file
  originalPath: string | null;
  roles: string[] | null;
}

export interface Sme {
  area: string;
  id: string;
}

export interface Roles {
  projectLead: string[];
  maintainer: string[];
  sme: Sme[];
}

export type CommunityNode =
  | { kind: "Section"; section: Section }
  | { kind: "Member"; member: Member };

export interface Section {
  name: string;
  filename: string | null;
  content: CommunityNode[];
  template: string | null;
  header: string | null;
  order: number | null;
  sortOrderReversed: boolean;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected string, got ${typeof value}`);
  }
  return value;
}

function asOptString(value: unknown): string | null {
  if (value === undefined) return null;
  return asString(value);
}

// extract_profile_picture: "GitHub" -> GitHub, anything else -> File(value)
function extractProfilePicture(value: unknown): ProfilePicture | null {
  if (value === undefined) return null;
  const buf = asString(value);
  if (buf === "GitHub") return { kind: "GitHub" };
  return { kind: "File", file: buf };
}

// extract_mastodon: splits on '@', discards first segment, then username, then instance.
function extractMastodon(value: unknown): Mastodon | null {
  if (value === undefined) return null;
  const buf = asString(value);
  const parts = buf.split("@");
  // parts[0] is skipped (details.next()); username = parts[1]; instance = parts[2].
  // The Rust code unwraps these, so missing segments are a hard error.
  const username = parts[1];
  const instance = parts[2];
  if (username === undefined || instance === undefined) {
    throw new Error(`invalid mastodon value: ${buf}`);
  }
  return { username, instance };
}

function parseMember(path: string): Member {
  const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;

  // deny_unknown_fields
  for (const key of Object.keys(raw)) {
    if (!MEMBER_KEYS.has(key)) {
      throw new Error(`unknown field \`${key}\` in ${path}`);
    }
  }

  if (raw.name === undefined) {
    throw new Error(`missing field \`name\` in ${path}`);
  }

  const rolesRaw = raw.roles;
  let roles: string[] | null = null;
  if (rolesRaw !== undefined) {
    if (!Array.isArray(rolesRaw)) throw new Error(`\`roles\` must be an array in ${path}`);
    roles = rolesRaw.map((r) => asString(r));
  }

  return {
    name: asString(raw.name),
    profilePicture: extractProfilePicture(raw["profile-picture"]),
    sponsor: asOptString(raw.sponsor),
    bio: asOptString(raw.bio),
    discord: asOptString(raw.discord),
    discordUserid: asOptString(raw["discord-userid"]),
    github: asOptString(raw.github),
    mastodon: extractMastodon(raw.mastodon),
    twitter: asOptString(raw.twitter),
    bluesky: asOptString(raw.bluesky),
    instagram: asOptString(raw.instagram),
    itchIo: asOptString(raw["itch-io"]),
    steamDeveloper: asOptString(raw["steam-developer"]),
    website: asOptString(raw.website),
    originalPath: path,
    roles,
  };
}

export function rolesIntoMap(roles: Roles): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const push = (id: string, role: string) => {
    const arr = map.get(id) ?? [];
    arr.push(role);
    map.set(id, arr);
  };
  for (const id of roles.projectLead) push(id, "Project Lead");
  for (const id of roles.maintainer) push(id, "Maintainer");
  for (const sme of roles.sme) push(sme.id, `SME-${sme.area}`);
  return map;
}

export function parseRoles(path: string): Roles {
  const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  // The Rust struct uses deny_unknown_fields with kebab-case keys.
  const known = new Set(["project-lead", "maintainer", "sme"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`unknown field \`${key}\` in ${path}`);
  }
  const projectLead = (raw["project-lead"] as unknown[] | undefined) ?? [];
  const maintainer = (raw["maintainer"] as unknown[] | undefined) ?? [];
  const smeRaw = (raw["sme"] as unknown[] | undefined) ?? [];
  const sme: Sme[] = smeRaw.map((s) => {
    const obj = s as Record<string, unknown>;
    return { area: asString(obj.area), id: asString(obj.id) };
  });
  return {
    projectLead: projectLead.map((v) => asString(v)),
    maintainer: maintainer.map((v) => asString(v)),
    sme,
  };
}

export function applyRoles(section: Section, roles: Map<string, string[]>): void {
  for (const content of section.content) {
    if (content.kind === "Section") {
      applyRoles(content.section, roles);
    } else {
      const member = content.member;
      member.roles = member.github != null ? (roles.get(member.github) ?? null) : null;
    }
  }
}

export function nodeName(node: CommunityNode): string {
  return node.kind === "Section" ? node.section.name : node.member.name;
}

export function nodeOrder(node: CommunityNode): number {
  if (node.kind === "Section") {
    return node.section.order ?? 99999;
  }
  const roles = node.member.roles;
  if (roles != null) {
    if (roles.some((p) => p === "Project Lead")) return 0;
    if (roles.some((p) => p === "Maintainer")) return 1;
    if (roles.length > 0) return 2;
    return 99999;
  }
  return 99999;
}

function visitDirs(dir: string, section: Section): void {
  // Rust: `visit_dirs` only descends `if dir.is_dir()`. Callers only pass
  // confirmed directories, so a read error here is a genuine I/O error and
  // should propagate (matching the Rust crate's `?` on `read_dir`).
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const name = entry.name;
    if (name === ".git" || name === ".github") continue;

    const path = join(dir, name);
    const isDir = entry.isDirectory();

    if (isDir) {
      let order: number | null = null;
      let sortOrderReversed = false;
      const categoryPath = join(path, "_category.toml");
      if (existsSync(categoryPath)) {
        const fromFile = parseToml(readFileSync(categoryPath, "utf8")) as Record<string, unknown>;
        const orderVal = fromFile.order;
        order = typeof orderVal === "number" && Number.isInteger(orderVal) ? orderVal : null;
        const reversedVal = fromFile.sort_order_reversed;
        sortOrderReversed = typeof reversedVal === "boolean" ? reversedVal : false;
      }
      const newSection: Section = {
        name,
        filename: null,
        content: [],
        template: null,
        header: null,
        order,
        sortOrderReversed,
      };
      visitDirs(path, newSection);
      section.content.push({ kind: "Section", section: newSection });
    } else {
      if (name === "_category.toml" || name === "_roles.toml") continue;
      const ext = extname(name);
      if (ext !== ".toml") {
        // Rust: `path.extension().expect("file must have an extension")`.
        if (ext === "") {
          throw new Error(`file must have an extension: ${path}`);
        }
        continue;
      }
      const member = parseMember(path);
      section.content.push({ kind: "Member", member });
    }
  }
}

export function parseMembers(communityDir: string): Section {
  const peopleRoot: Section = {
    name: "People",
    filename: null,
    content: [],
    template: "people.html",
    header: "People",
    order: null,
    sortOrderReversed: false,
  };

  // Mirror Rust's `if dir.is_dir()` guard. Only the existence/dir check is
  // guarded; errors raised while walking (e.g. invalid TOML, unknown fields)
  // must propagate, matching the Rust crate's `unwrap()`/`expect()` panics.
  let isDir = false;
  try {
    isDir = statSync(communityDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    visitDirs(communityDir, peopleRoot);
  }

  return peopleRoot;
}

// Re-export helpers used by the binaries.
export { basename };
