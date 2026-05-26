// Unit tests for the pure transformation logic (no network).
//
// Run with:  node --experimental-strip-types --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assetSlug,
  parseAssets,
  setLicense,
  setBevyVersion,
  NULL_METADATA_SOURCE,
  type Asset,
  type Section,
} from "./lib.ts";
import {
  parseManifest,
  getLicense,
  getBevyVersionFromManifest,
  mergeLicense,
  mergeVersion,
} from "./cargo-toml.ts";
import { versionMatchesReq, parseVersion } from "./semver.ts";
import { serializeFrontmatter } from "./toml-serialize.ts";

// --- assetSlug (verified against the Rust implementation) ---

test("assetSlug matches Rust behaviour", () => {
  assert.equal(assetSlug("My Asset!"), "my_asset");
  assert.equal(assetSlug("foo/bar baz"), "foo-bar_baz");
  assert.equal(assetSlug("Café münchen"), "caf_mnchen");
  assert.equal(assetSlug("a.b.c"), "abc");
  assert.equal(assetSlug("C++ Game"), "c_game");
  assert.equal(assetSlug("Hello (World)"), "hello_world");
  assert.equal(assetSlug("über_cool"), "ber_cool");
  assert.equal(assetSlug("T-Rex 2"), "t-rex_2");
});

// --- license / version setters ---

function blankAsset(): Asset {
  return {
    name: "x",
    link: "https://example.com",
    description: "d",
    order: null,
    image: null,
    crateName: null,
    licenses: null,
    bevyVersions: null,
    nsfw: null,
    originalPath: null,
  };
}

test("setLicense splits on OR and trims", () => {
  const a = blankAsset();
  setLicense(a, "MIT OR Apache-2.0");
  assert.deepEqual(a.licenses, ["MIT", "Apache-2.0"]);
});

test("setLicense is a no-op when already set", () => {
  const a = blankAsset();
  a.licenses = ["GPL"];
  setLicense(a, "MIT");
  assert.deepEqual(a.licenses, ["GPL"]);
});

test("setBevyVersion wraps in array and is a no-op when set", () => {
  const a = blankAsset();
  setBevyVersion(a, "0.14");
  assert.deepEqual(a.bevyVersions, ["0.14"]);
  setBevyVersion(a, "0.15");
  assert.deepEqual(a.bevyVersions, ["0.14"]);
});

// --- cargo-toml license + bevy version detection ---

const BEVY_CRATES = ["bevy", "bevy_transform"]; // sorted

test("getBevyVersionFromManifest: no dependency", () => {
  const m = parseManifest(`[package]\nname="x"\n`);
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), null);
});

test("getBevyVersionFromManifest: from main crate", () => {
  const m = parseManifest(`[dependencies]\nbevy = "0.10"\n`);
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: from sub crate", () => {
  const m = parseManifest(`[dependencies]\nbevy_transform = "0.10"\n`);
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: from dev-dependencies", () => {
  const m = parseManifest(`[dev-dependencies]\nbevy = "0.10"\n`);
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: from workspace dependencies", () => {
  const m = parseManifest(`[workspace.dependencies]\nbevy = "0.10"\n`);
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: ignores third-party bevy-prefixed crates", () => {
  const m = parseManifest(
    `[dependencies]\nbevy_third_party_crate_example = "0.5"\nbevy_transform = "0.10"\n`,
  );
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: path dependency falls through to dev", () => {
  const m = parseManifest(
    `[dependencies]\nbevy = { path = "fake/path" }\n[dev-dependencies]\nbevy_transform = "0.10"\n`,
  );
  assert.equal(getBevyVersionFromManifest(m, BEVY_CRATES), "0.10");
});

test("getBevyVersionFromManifest: git main / git", () => {
  const main = parseManifest(`[dependencies]\nbevy = { git = "x", branch = "main" }\n`);
  assert.equal(getBevyVersionFromManifest(main, BEVY_CRATES), "main");
  const git = parseManifest(`[dependencies]\nbevy = { git = "x", branch = "other" }\n`);
  assert.equal(getBevyVersionFromManifest(git, BEVY_CRATES), "git");
});

test("getBevyVersionFromManifest: null bevy_crates => null", () => {
  const m = parseManifest(`[dependencies]\nbevy = "0.10"\n`);
  assert.equal(getBevyVersionFromManifest(m, null), null);
});

test("getLicense: from package.license", () => {
  const m = parseManifest(`[package]\nname="x"\nlicense="MIT OR Apache-2.0"\n`);
  assert.equal(getLicense(m), "MIT OR Apache-2.0");
});

test("getLicense: license-file => non-standard", () => {
  const m = parseManifest(`[package]\nname="x"\nlicense-file="LICENSE"\n`);
  assert.equal(getLicense(m), "non-standard");
});

test("getLicense: workspace-inherited license is ignored", () => {
  const m = parseManifest(`[package]\nname="x"\nlicense.workspace=true\n`);
  assert.equal(getLicense(m), null);
});

test("getLicense: no package => null", () => {
  const m = parseManifest(`[dependencies]\nbevy="0.10"\n`);
  assert.equal(getLicense(m), null);
});

test("mergeLicense / mergeVersion", () => {
  assert.equal(mergeLicense(null, "MIT"), "MIT");
  assert.equal(mergeLicense("MIT", null), "MIT");
  assert.equal(mergeLicense("MIT OR Apache", "MIT"), "MIT OR Apache");
  assert.equal(mergeLicense("MIT", "Apache"), "MIT Apache");
  assert.equal(mergeVersion("0.14", "0.13"), "0.14");
  assert.equal(mergeVersion(null, "0.13"), "0.13");
});

// --- semver matching (verified against the Rust semver crate) ---

test("versionMatchesReq matches Rust semver", () => {
  const latest = parseVersion("0.16.1")!;
  assert.equal(versionMatchesReq("0.16", latest), true);
  assert.equal(versionMatchesReq("0.16.0", latest), true);
  assert.equal(versionMatchesReq("0.15", latest), false);
  assert.equal(versionMatchesReq("0.16.1", latest), true);
  assert.equal(versionMatchesReq("0.17", latest), false);
  assert.equal(versionMatchesReq("*", latest), true);
  assert.equal(versionMatchesReq("^0.16", latest), true);
  assert.equal(versionMatchesReq(">=0.15, <0.17", latest), true);
  assert.equal(versionMatchesReq("1.0", latest), false);
  assert.equal(versionMatchesReq("0.14.2", latest), false);
  // unparseable -> false
  assert.equal(versionMatchesReq("main", latest), false);
  assert.equal(versionMatchesReq("git", latest), false);
});

// --- toml-serialize: asset frontmatter shape (verified against Rust toml 0.9) ---

test("serializeFrontmatter reproduces Rust toml asset output", () => {
  const out = serializeFrontmatter(
    [
      ["title", "My Asset"],
      ["description", "A cool thing"],
      ["weight", 3],
    ],
    [
      ["link", "https://github.com/foo/bar"],
      ["image", "img.png"],
      ["licenses", ["MIT", "Apache-2.0"]],
      ["bevy_versions", ["0.14"]],
      ["nsfw", false],
    ],
  );
  assert.equal(
    out,
    'title = "My Asset"\n' +
      'description = "A cool thing"\n' +
      "weight = 3\n" +
      "\n[extra]\n" +
      'link = "https://github.com/foo/bar"\n' +
      'image = "img.png"\n' +
      'licenses = ["MIT", "Apache-2.0"]\n' +
      'bevy_versions = ["0.14"]\n' +
      "nsfw = false\n",
  );
});

test("serializeFrontmatter omits null fields", () => {
  const out = serializeFrontmatter(
    [
      ["title", "X"],
      ["description", "y"],
      ["weight", 0],
    ],
    [
      ["link", "https://crates.io/crates/x"],
      ["image", null],
      ["licenses", null],
      ["bevy_versions", null],
      ["nsfw", null],
    ],
  );
  assert.equal(
    out,
    'title = "X"\ndescription = "y"\nweight = 0\n\n[extra]\nlink = "https://crates.io/crates/x"\n',
  );
});

// --- directory walk (parseAssets) ---

test("parseAssets walks the tree, enforces deny_unknown_fields, reads _category.toml", () => {
  const root = mkdtempSync(join(tmpdir(), "assets-walk-"));
  try {
    // root/Audio/_category.toml + an asset
    mkdirSync(join(root, "Audio"));
    writeFileSync(join(root, "Audio", "_category.toml"), "order = 2\nsort_order_reversed = true\n");
    writeFileSync(
      join(root, "Audio", "kira.toml"),
      'name = "Kira"\nlink = "https://github.com/foo/kira"\ndescription = "Sound"\norder = 1\nlicenses = ["MIT"]\n',
    );
    // A non-toml file is ignored.
    writeFileSync(join(root, "Audio", "readme.md"), "ignore me");

    const section = parseAssets(root, NULL_METADATA_SOURCE);
    assert.equal(section.name, "Assets");
    assert.equal(section.template, "assets.html");
    assert.equal(section.content.length, 1);

    const audio = section.content[0];
    assert.equal(audio.kind, "Section");
    if (audio.kind !== "Section") throw new Error("unreachable");
    assert.equal(audio.section.name, "Audio");
    assert.equal(audio.section.order, 2);
    assert.equal(audio.section.sortOrderReversed, true);
    assert.equal(audio.section.content.length, 1);

    const asset = audio.section.content[0];
    assert.equal(asset.kind, "Asset");
    if (asset.kind !== "Asset") throw new Error("unreachable");
    assert.equal(asset.asset.name, "Kira");
    assert.equal(asset.asset.order, 1);
    assert.deepEqual(asset.asset.licenses, ["MIT"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseAssets rejects unknown fields", () => {
  const root = mkdtempSync(join(tmpdir(), "assets-bad-"));
  try {
    writeFileSync(
      join(root, "bad.toml"),
      'name = "X"\nlink = "https://x"\ndescription = "d"\nbogus = 1\n',
    );
    assert.throws(() => parseAssets(root, NULL_METADATA_SOURCE), /unknown field `bogus`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseAssets applies injected metadata (crates.io-style)", () => {
  const root = mkdtempSync(join(tmpdir(), "assets-meta-"));
  try {
    writeFileSync(
      join(root, "crate-asset.toml"),
      'name = "Foo"\nlink = "https://crates.io/crates/foo"\ndescription = "d"\ncrate = "foo"\n',
    );
    const section = parseAssets(root, {
      getExtraMetadata() {
        return ["MIT OR Apache-2.0", "0.14"];
      },
    });
    const node = section.content[0];
    if (node.kind !== "Asset") throw new Error("unreachable");
    assert.deepEqual(node.asset.licenses, ["MIT", "Apache-2.0"]);
    assert.deepEqual(node.asset.bevyVersions, ["0.14"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
