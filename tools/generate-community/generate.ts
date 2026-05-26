#!/usr/bin/env node --experimental-strip-types
// Port of generate-community/src/bin/generate.rs to TypeScript.
//
// Reads the `bevy-community` directory and generates Zola content under the
// website's content directory (people sections/pages, `_index.md`s, member
// `.md` files with `+++` TOML frontmatter).
//
// Usage (positional args, matching the Rust binary):
//   node --experimental-strip-types generate.ts <community_dir> <content_dir> <content_sub_dir>

import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";

import {
  parseMembers,
  parseRoles,
  rolesIntoMap,
  applyRoles,
  nodeName,
  nodeOrder,
  type Section,
  type Member,
  type CommunityNode,
} from "./lib.ts";

import {
  serializeFrontmatter,
  type TomlFieldValue,
} from "./toml-serialize.ts";

// --- Frontmatter writers (ports of the FrontMatterWriter impls) ---

function memberProfilePictureLink(member: Member): string | null {
  const pp = member.profilePicture;
  if (pp === null) return null;
  if (pp.kind === "GitHub") {
    // member.github.as_ref().unwrap()
    if (member.github == null) {
      throw new Error("Profile Picture set to GitHub, but no GitHub profile found");
    }
    return `https://github.com/${member.github}.png`;
  }
  return pp.file;
}

function writeMember(
  member: Member,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  const path = join(rootPath, currentPath);

  let profilePicture = memberProfilePictureLink(member);

  // For a File profile picture, copy the image next to the page and rewrite the
  // link to be relative to the section path. Matches the Rust impl.
  if (member.profilePicture !== null && member.profilePicture.kind === "File") {
    const file = member.profilePicture.file;
    const imageFileLink = join(currentPath, file);
    const originalImage = join(dirname(member.originalPath!), file);
    profilePicture = imageFileLink;
    try {
      copyFileSync(originalImage, join(path, file));
    } catch {
      // Rust uses `let _ = fs::copy(...)`, ignoring errors.
    }
  }

  const topLevel: Array<[string, TomlFieldValue]> = [
    ["title", member.name],
    ["weight", weight],
  ];

  // Field order must match FrontMatterMemberExtra exactly.
  const extra: Array<[string, TomlFieldValue]> = [
    ["profile_picture", profilePicture],
    ["sponsor", member.sponsor],
    ["bio", member.bio],
    ["discord", member.discord],
    ["discord_userid", member.discordUserid],
    ["github", member.github],
    ["mastodon_user", member.mastodon ? member.mastodon.username : null],
    ["mastodon_instance", member.mastodon ? member.mastodon.instance : null],
    ["twitter", member.twitter],
    ["bluesky", member.bluesky],
    ["instagram", member.instagram],
    ["itch_io", member.itchIo],
    ["steam_developer", member.steamDeveloper],
    ["website", member.website],
    ["roles", member.roles],
  ];

  const fileName = basename(member.originalPath!).replace(".toml", "");
  const body = `+++\n${serializeFrontmatter(topLevel, extra)}\n+++\n`;
  writeFileSync(join(path, `${fileName}.md`), body);
}

// Rust sorts sub-sections by the string `"{order}-{name}"`. Rust's string Ord is
// a byte-wise (UTF-8) comparison, which we reproduce here.
function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

// Fisher-Yates shuffle (matches `slice.shuffle(&mut rng())` semantics: a uniform
// random permutation, non-deterministic).
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function writeSection(
  section: Section,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  const sectionFolder = section.filename ?? section.name.toLowerCase();
  const sectionPath = join(currentPath, sectionFolder);
  const path = join(rootPath, sectionPath);
  // Rust uses `fs::create_dir` (non-recursive). The parent always exists because
  // sections are written top-down.
  mkdirSync(path);

  // FrontMatterSection field order: title, sort_by, template, weight, [extra].
  // weight = section.order ?? 0, then overridden by `weight` arg when order is None.
  const weightValue = section.order ?? weight;
  const topLevel: Array<[string, TomlFieldValue]> = [
    ["title", section.name],
    ["sort_by", "weight"],
    ["template", section.template], // omitted if null
    ["weight", weightValue],
  ];
  const extra: Array<[string, TomlFieldValue]> = [
    ["header_message", section.header], // omitted if null
    ["sort_order_reversed", section.sortOrderReversed],
  ];

  const body = `+++\n${serializeFrontmatter(topLevel, extra)}\n+++\n`;
  writeFileSync(join(path, "_index.md"), body);

  // Collect sub-sections, sort by "{order}-{name}".
  const sortedSections: CommunityNode[] = [];
  for (const content of section.content) {
    if (content.kind === "Section") {
      sortedSections.push(content);
    }
  }
  sortedSections.sort((a, b) =>
    byteCompare(`${nodeOrder(a)}-${nodeName(a)}`, `${nodeOrder(b)}-${nodeName(b)}`),
  );

  // Group members by order (BTreeMap = ascending numeric key order), shuffle
  // within each group, then concatenate.
  const orderGroups = new Map<number, CommunityNode[]>();
  for (const content of section.content) {
    if (content.kind === "Member") {
      const order = nodeOrder(content);
      const members = orderGroups.get(order) ?? [];
      members.push(content);
      orderGroups.set(order, members);
    }
  }

  const sortedKeys = [...orderGroups.keys()].sort((a, b) => a - b);
  const orderedMembers: CommunityNode[] = [];
  for (const key of sortedKeys) {
    const members = orderGroups.get(key)!;
    shuffle(members);
    orderedMembers.push(...members);
  }

  const all = [...sortedSections, ...orderedMembers];
  all.forEach((content, i) => {
    writeNode(content, rootPath, sectionPath, i);
  });
}

function writeNode(
  node: CommunityNode,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  if (node.kind === "Section") {
    writeSection(node.section, rootPath, currentPath, weight);
  } else {
    writeMember(node.member, rootPath, currentPath, weight);
  }
}

function cloneSection(section: Section): Section {
  return JSON.parse(JSON.stringify(section)) as Section;
}

function main(): void {
  const args = process.argv.slice(2);

  const communityDir = args[0];
  if (communityDir === undefined) {
    throw new Error("Expected first argument to be the path to the community directory.");
  }
  const contentDir = args[1];
  if (contentDir === undefined) {
    throw new Error("Expected second argument to be the path to the website content directory.");
  }
  const contentSubDir = args[2];
  if (contentSubDir === undefined) {
    throw new Error("Expected third argument to be the name of the community directory.");
  }

  // Create the content directory if it does not exist.
  mkdirSync(contentDir, { recursive: true });

  const peopleRootSection = parseMembers(communityDir);

  const rolesPath = join(communityDir, "_roles.toml");
  // Rust: read_to_string(...).expect("Could not read _roles.toml.")
  readFileSync(rolesPath, "utf8"); // throws if missing, matching the expect()
  const roles = parseRoles(rolesPath);
  applyRoles(peopleRootSection, rolesIntoMap(roles));

  writeSection(peopleRootSection, contentDir, contentSubDir, 0);

  // Build the "Supporting Bevy Development" donate section from a clone of
  // "The Bevy Organization", keeping only members that have a sponsor.
  const orgNode = peopleRootSection.content.find(
    (node) => nodeName(node) === "The Bevy Organization",
  );
  if (orgNode === undefined || orgNode.kind !== "Section") {
    throw new Error("unexpected kind of node or missing for The Bevy Organization");
  }

  const donate = cloneSection(orgNode.section);
  donate.name = "Supporting Bevy Development";
  donate.filename = "donate";
  donate.header = "Supporting Bevy";
  donate.template = "donate-community.html";

  donate.content = donate.content.filter((node) => {
    if (node.kind !== "Member") {
      throw new Error("got an unexpected subsection");
    }
    return node.member.sponsor != null;
  });

  writeSection(donate, contentDir, contentSubDir, 0);
}

main();
