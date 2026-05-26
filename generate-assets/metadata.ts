// Network / external-API enrichment layer for generate-assets.
//
// This module reproduces the side-effecting parts of generate-assets/src/lib.rs,
// src/github_client.rs and src/gitlab_client.rs:
//
//   - A crates.io database-dump loader (the Rust crate uses
//     `cratesio-dbdump-csvtab`, which downloads `db-dump.tar.gz`, loads the
//     `crates`, `dependencies`, `versions` CSVs into an in-memory SQLite DB,
//     and runs SQL against it). Here we use Node 22's `node:sqlite`.
//   - GitHub + GitLab HTTP clients (the Rust crate uses `ureq`).
//   - A `MetadataSource` implementation tying them together
//     (`get_extra_metadata` dispatch on URL host).
//
// Everything here touches the network or the filesystem dump, so it is NOT
// unit-tested offline (see README "Network dependencies"). The pure
// transformation lives in lib.ts / cargo-toml.ts.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import type { Asset, MetadataSource } from "./lib.ts";
import { setLicense, setBevyVersion } from "./lib.ts";
import {
  parseManifest,
  getLicense,
  getBevyVersionFromManifest,
  mergeLicense,
  mergeVersion,
} from "./cargo-toml.ts";

const USER_AGENT = "bevy-website-generate-assets";

// ---------------------------------------------------------------------------
// URL parsing helper (mirrors the `url` crate's path_segments / host_str usage)
// ---------------------------------------------------------------------------

interface ParsedUrl {
  host: string | null;
  // path segments WITHOUT the leading empty segment from the leading '/',
  // i.e. for `https://github.com/foo/bar` -> ["foo", "bar"].
  // NOTE: the Rust crate's indexing assumes the leading-slash convention of the
  // `url` crate's `path_segments()`, which yields ["foo","bar"] for that URL.
  segments: string[];
}

function parseUrlLike(input: string): ParsedUrl {
  const u = new URL(input);
  const host = u.hostname || null;
  // WHATWG URL pathname always starts with '/'. Drop the leading empty segment
  // so segments[0] is the first real path component, matching the Rust crate's
  // `url::Url::path_segments` for absolute URLs.
  const path = u.pathname.replace(/^\//, "");
  const segments = path === "" ? [] : path.split("/");
  return { host, segments };
}

// ---------------------------------------------------------------------------
// crates.io database dump
// ---------------------------------------------------------------------------

export interface CratesIoDb {
  db: DatabaseSync;
  /** Prepared statement returning [license, req] for a crate's latest version. */
  metadataStatement: StatementSync;
  /** Official bevy crate names, sorted lexicographically (byte order). */
  bevyCratesNames: string[];
}

/**
 * Build the crates.io SQLite DB from an extracted db-dump directory.
 *
 * The crates.io db-dump (https://static.crates.io/db-dump.tar.gz) extracts to a
 * `data/` folder containing `crates.csv`, `dependencies.csv`, `versions.csv`
 * (among others). This loads those three CSVs into an in-memory SQLite database
 * and creates the same indices as the Rust crate.
 *
 * `dataDir` should point at the directory containing the CSV files
 * (e.g. `<dump>/data`). The Rust crate downloads + caches under `./data`.
 */
export function prepareCratesDb(dataDir: string): CratesIoDb {
  const db = new DatabaseSync(":memory:");

  // Schema mirrors the columns the Rust SQL relies on. The crates.io dump CSVs
  // carry more columns; we import only the ones we query.
  db.exec(`
    CREATE TABLE crates (id TEXT, name TEXT, homepage TEXT, repository TEXT);
    CREATE TABLE versions (id TEXT, crate_id TEXT, num TEXT, license TEXT);
    CREATE TABLE dependencies (version_id TEXT, crate_id TEXT, req TEXT, kind TEXT);
  `);

  loadCsv(db, `${dataDir}/crates.csv`, "crates", ["id", "name", "homepage", "repository"]);
  loadCsv(db, `${dataDir}/versions.csv`, "versions", ["id", "crate_id", "num", "license"]);
  loadCsv(db, `${dataDir}/dependencies.csv`, "dependencies", [
    "version_id",
    "crate_id",
    "req",
    "kind",
  ]);

  db.exec(`
    CREATE INDEX IF NOT EXISTS versions_crate_id_index ON versions(crate_id);
    CREATE INDEX IF NOT EXISTS dependencies_crate_id_index ON dependencies(crate_id);
    CREATE INDEX IF NOT EXISTS crates_id_index ON crates(id);
    CREATE INDEX IF NOT EXISTS crates_name_index ON crates(name);
  `);

  const { names: bevyCratesNames, ids: bevyCratesIds } = getOfficialBevyCrates(db);
  const metadataStatement = makeMetadataStatement(db, bevyCratesIds);

  return { db, metadataStatement, bevyCratesNames };
}

/**
 * Load a crates.io dump CSV into a table, mapping the named CSV columns onto the
 * table columns. CSV header order in the dump is stable but we resolve columns
 * by header name to be robust.
 */
function loadCsv(
  db: DatabaseSync,
  csvPath: string,
  table: string,
  columns: string[],
): void {
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) return;

  const header = rows[0];
  const colIndex = columns.map((c) => {
    const idx = header.indexOf(c);
    if (idx === -1) {
      throw new Error(`crates.io dump CSV ${csvPath} is missing column \`${c}\``);
    }
    return idx;
  });

  const placeholders = columns.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  );

  db.exec("BEGIN");
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const values = colIndex.map((ci) => row[ci] ?? null);
    insert.run(...values);
  }
  db.exec("COMMIT");
}

/**
 * Minimal RFC-4180-ish CSV parser (the crates.io dump uses standard quoting with
 * doubled quotes for escapes, and may contain embedded newlines in quoted
 * fields). Returns an array of rows; each row is an array of string fields.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Trailing field/row if file doesn't end in newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Gets the official bevy crate names + ids, sorted lexicographically by name.
 * Mirrors `get_official_bevy_crates_from_crates_io_db` + `get_bevy_crates`.
 */
function getOfficialBevyCrates(db: DatabaseSync): { names: string[]; ids: string[] } {
  const stmt = db.prepare(
    `SELECT name, id FROM crates WHERE (homepage = ? OR homepage = ?) AND repository = ?`,
  );
  const rows = stmt.all(
    "https://bevy.org",
    "https://bevyengine.org",
    "https://github.com/bevyengine/bevy",
  ) as Array<{ name: string; id: string }>;

  rows.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );

  return {
    names: rows.map((r) => r.name),
    ids: rows.map((r) => r.id),
  };
}

/**
 * Builds the prepared statement that returns `[license, req]` for the latest
 * (highest semver) version of a crate, joined to its bevy dependency req if any.
 * Mirrors `get_metadata_from_cratesio_statement`.
 */
function makeMetadataStatement(db: DatabaseSync, bevyCratesIds: string[]): StatementSync {
  // The bevy crate ids are interpolated directly into the IN(...) clause exactly
  // like the Rust crate (it `.join(",")`s the ids). These come from our own DB
  // and are integers-as-text, so this is not user input.
  const idList = bevyCratesIds.join(",");
  const sql = `
    SELECT last_version.license, dep.req
    FROM (
      SELECT version_id, license, major,
        CAST(SUBSTR(minor_and_patch,0,second_point) AS INTEGER) minor,
        CAST(SUBSTR(minor_and_patch,second_point+1) AS INTEGER) patch
      FROM (
        SELECT version_id, license, major, minor_and_patch,
          INSTR(minor_and_patch, '.') second_point
        FROM (
          SELECT version_id, license,
            CAST(SUBSTR(num,0,first_point) AS INTEGER) major,
            SUBSTR(num,first_point+1) minor_and_patch
          FROM (
            SELECT v.id version_id, v.license license, v.num num,
              INSTR(v.num, '.') first_point
            FROM crates c
              INNER JOIN versions v ON c.id = v.crate_id
            WHERE c.name = ?
          )
        )
      )
      ORDER BY major DESC, minor DESC, patch DESC
      LIMIT 1
    ) last_version
      LEFT JOIN dependencies dep ON
      (
        last_version.version_id = dep.version_id AND
        dep.crate_id IN (${idList})
      )
    ORDER BY dep.kind
    LIMIT 1`;
  return db.prepare(sql);
}

/**
 * Gets `[license, version]` for a crate from the crates.io DB, retrying with `-`
 * in place of `_` if not found. Mirrors `get_metadata_from_crates_db`.
 */
function getMetadataFromCratesDb(
  cratesDb: CratesIoDb,
  crateName: string,
): [string | null, string | null] {
  const direct = queryCratesMetadata(cratesDb, crateName);
  if (direct !== null) return direct;
  const dashed = queryCratesMetadata(cratesDb, crateName.replaceAll("_", "-"));
  if (dashed !== null) return dashed;
  throw new Error(`Failed to get data from crates.io db for ${crateName}`);
}

function queryCratesMetadata(
  cratesDb: CratesIoDb,
  crateName: string,
): [string | null, string | null] | null {
  const row = cratesDb.metadataStatement.get(crateName) as
    | { license: string | null; req: string | null }
    | undefined;
  if (row === undefined) return null;
  // Rust: empty license string -> None.
  const license = row.license && row.license !== "" ? row.license : null;
  const version = row.req ?? null;
  return [license, version];
}

/** Highest (semver) version of Bevy listed in the dump. Mirrors `get_latest_bevy_version`. */
export function getLatestBevyVersion(cratesDb: CratesIoDb): string {
  const idRow = cratesDb.db.prepare(`SELECT id FROM crates WHERE name = 'bevy'`).get() as
    | { id: string }
    | undefined;
  if (idRow === undefined) {
    throw new Error("Failed to retrieve Bevy versions from crates.io db");
  }
  const rows = cratesDb.db
    .prepare(`SELECT num FROM versions WHERE crate_id = ?`)
    .all(idRow.id) as Array<{ num: string }>;

  let max: number[] | null = null;
  let maxStr: string | null = null;
  for (const r of rows) {
    const parsed = parseSemverCore(r.num);
    if (parsed === null) continue;
    if (max === null || compareSemverCore(parsed, max) > 0) {
      max = parsed;
      maxStr = r.num;
    }
  }
  if (maxStr === null) {
    throw new Error("Failed to retrieve Bevy versions from crates.io db");
  }
  return maxStr;
}

// --- semver helpers (subset sufficient for version compat + max) ---

/** Parse "MAJOR.MINOR.PATCH" (ignoring pre-release/build) into [maj,min,pat]. */
export function parseSemverCore(v: string): [number, number, number] | null {
  // Strip leading 'v' and any pre-release/build metadata.
  const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((x) => !Number.isInteger(x) || x < 0)) return null;
  return [nums[0], nums[1], nums[2]];
}

function compareSemverCore(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// GitHub client (port of github_client.rs)
// ---------------------------------------------------------------------------

export class GithubClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Gets the content of a file from a github repo (base64-decoded). */
  async getContent(username: string, repo: string, contentPath: string): Promise<string> {
    const res = await fetch(
      `https://api.github.com/repos/${username}/${repo}/contents/${contentPath}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": USER_AGENT,
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub get_content failed: ${res.status}`);
    const json = (await res.json()) as { encoding: string; content: string };
    if (json.encoding !== "base64") {
      throw new Error("Content is not in base64");
    }
    return Buffer.from(json.content.replaceAll("\n", "").trim(), "base64").toString("utf8");
  }

  /** Gets the (single) SPDX license of a github repo, or throws on NOASSERTION. */
  async getLicense(username: string, repo: string): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${username}/${repo}/license`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) throw new Error(`GitHub get_license failed: ${res.status}`);
    const json = (await res.json()) as { license: { spdx_id: string } };
    const license = json.license.spdx_id;
    if (license === "NOASSERTION") throw new Error("No spdx license assertion");
    return license;
  }

  /** Search for files by name within a repo, returning their paths. */
  async searchFile(username: string, repo: string, fileName: string): Promise<string[]> {
    const res = await fetch(
      `https://api.github.com/search/code?q=repo:${username}/${repo}+filename:${fileName}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": USER_AGENT,
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub search_file failed: ${res.status}`);
    const json = (await res.json()) as {
      total_count: number;
      incomplete_results: boolean;
      items: Array<{ path: string }>;
    };
    if (json.incomplete_results) {
      console.log(
        `Too many ${fileName} files in repository, checking only the first ${json.total_count} ones.`,
      );
    }
    return json.items.map((i) => i.path);
  }
}

// ---------------------------------------------------------------------------
// GitLab client (port of gitlab_client.rs)
// ---------------------------------------------------------------------------

export class GitlabClient {
  // The token is intentionally unused (matches the Rust crate, which comments
  // out the Authorization header because there are so few gitlab assets).
  private _token: string;

  constructor(token: string) {
    this._token = token;
  }

  async searchProjectByName(
    repositoryName: string,
  ): Promise<Array<{ id: number; default_branch: string }>> {
    const res = await fetch(
      `https://gitlab.com/api/v4/projects?search=${repositoryName}`,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    );
    if (!res.ok) throw new Error(`GitLab search failed: ${res.status}`);
    return (await res.json()) as Array<{ id: number; default_branch: string }>;
  }

  async getContent(id: number, defaultBranch: string, contentPath: string): Promise<string> {
    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${id}/repository/files/${contentPath}?ref=${defaultBranch}`,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    );
    if (!res.ok) throw new Error(`GitLab get_content failed: ${res.status}`);
    const json = (await res.json()) as { encoding: string; content: string };
    if (json.encoding !== "base64") throw new Error("Content is not in base64");
    return Buffer.from(json.content.replaceAll("\n", "").trim(), "base64").toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// GitHub / GitLab metadata extraction (ports of the lib.rs functions)
// ---------------------------------------------------------------------------

/**
 * Gets metadata from a GitHub project. Mirrors `get_metadata_from_github`:
 *   - try the root Cargo.toml,
 *   - if license missing, fetch the repo license,
 *   - if anything still missing, scan all other Cargo.toml files, merging.
 */
async function getMetadataFromGithub(
  client: GithubClient,
  username: string,
  repo: string,
  bevyCrates: string[] | null,
): Promise<[string | null, string | null]> {
  let license: string | null = null;
  let version: string | null = null;

  try {
    [license, version] = await getMetadataFromGithubManifest(
      client,
      username,
      repo,
      bevyCrates,
      "Cargo.toml",
    );
  } catch (err) {
    console.log(`Error getting metadata from root cargo file from github: ${errMsg(err)}`);
  }

  if (license === null) {
    try {
      license = await client.getLicense(username, repo);
    } catch {
      license = null;
    }
  }

  if (license === null || version === null) {
    let cargoFiles: string[];
    try {
      cargoFiles = await client.searchFile(username, repo, "Cargo.toml");
    } catch (err) {
      console.log(`Error fetching cargo files from github: ${errMsg(err)}`);
      return [license, version];
    }

    // Exclude the root Cargo.toml, already searched.
    const others = cargoFiles.filter((f) => f !== "Cargo.toml");

    for (const cargoFile of others) {
      if (license !== null && version !== null) break;
      try {
        const [newLicense, newVersion] = await getMetadataFromGithubManifest(
          client,
          username,
          repo,
          bevyCrates,
          cargoFile,
        );
        license = mergeLicense(license, newLicense);
        version = mergeVersion(version, newVersion);
      } catch (err) {
        console.log(`Error getting metadata from other cargo file from github: ${errMsg(err)}`);
        return [license, version];
      }
    }
  }

  return [license, version];
}

async function getMetadataFromGithubManifest(
  client: GithubClient,
  username: string,
  repo: string,
  bevyCrates: string[] | null,
  path: string,
): Promise<[string | null, string | null]> {
  const content = await client.getContent(username, repo, path);
  const manifest = parseManifest(content);
  return [getLicense(manifest), getBevyVersionFromManifest(manifest, bevyCrates)];
}

/** Gets metadata from a GitLab project's root Cargo.toml. Mirrors `get_metadata_from_gitlab`. */
async function getMetadataFromGitlab(
  client: GitlabClient,
  repositoryName: string,
  bevyCrates: string[] | null,
): Promise<[string | null, string | null]> {
  const searchResult = await client.searchProjectByName(repositoryName);
  const repo = searchResult[0];
  if (repo === undefined) throw new Error("Failed to find gitlab repo");

  const content = await client.getContent(repo.id, repo.default_branch, "Cargo.toml");
  const manifest = parseManifest(content);
  return [getLicense(manifest), getBevyVersionFromManifest(manifest, bevyCrates)];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// MetadataSource implementation (ports `get_extra_metadata`)
// ---------------------------------------------------------------------------

export interface NetworkMetadataOptions {
  cratesDb: CratesIoDb | null;
  githubClient: GithubClient | null;
  gitlabClient: GitlabClient | null;
}

/**
 * Builds a `MetadataSource` backed by crates.io / GitHub / GitLab.
 *
 * NOTE: the Rust crate's `get_extra_metadata` is synchronous (blocking `ureq`),
 * so the synchronous `MetadataSource.getExtraMetadata` interface used by the
 * directory walk would normally suffice. However `fetch` in Node is async. To
 * keep the walk synchronous *and* faithful, this implementation eagerly resolves
 * GitHub/GitLab lookups: it cannot be done from a sync callback. We therefore
 * expose `enrichAssets`, an async post-pass that mutates the parsed assets in
 * place, and a sync `MetadataSource` that only handles the crates.io DB (which
 * is synchronous via `node:sqlite`).
 *
 * `generate.ts` calls `parseAssets` with `cratesOnlySource(...)` and then
 * `enrichAssets(...)` to handle the network hosts. This preserves the exact
 * enrichment semantics of the Rust crate (crate name -> crates.io; otherwise
 * dispatch on link host) while respecting Node's async I/O.
 */
export function cratesOnlySource(options: NetworkMetadataOptions): MetadataSource {
  return {
    getExtraMetadata(asset: Asset): [string | null, string | null] | null {
      const { host, segments } = hostAndSegmentsFor(asset);
      if (host === "crates.io") {
        if (options.cratesDb !== null) {
          const crateName = segments[1];
          return getMetadataFromCratesDb(options.cratesDb, crateName);
        }
        return null;
      }
      // github.com / gitlab.com are handled asynchronously by enrichAssets.
      if (host === "github.com" || host === "gitlab.com" || host === null) {
        return null;
      }
      throw new Error(`Unknown host: ${asset.link}`);
    },
  };
}

function hostAndSegmentsFor(asset: Asset): { host: string | null; segments: string[] } {
  if (asset.crateName !== null) {
    return parseUrlLike(`https://crates.io/crates/${asset.crateName}`);
  }
  return parseUrlLike(asset.link);
}

/**
 * Async post-pass that enriches GitHub/GitLab-hosted assets in place. Walks the
 * already-parsed tree and, for each asset whose host is github.com or
 * gitlab.com (and which still has a crate-less link), fetches metadata and
 * applies it via setLicense / setBevyVersion (no-ops if already set, matching
 * the Rust setters).
 */
export async function enrichAssets(
  assets: Asset[],
  options: NetworkMetadataOptions,
): Promise<void> {
  const bevyCrates = options.cratesDb?.bevyCratesNames ?? null;

  for (const asset of assets) {
    // Assets with a `crate` field were already handled synchronously.
    if (asset.crateName !== null) continue;

    let parsed: { host: string | null; segments: string[] };
    try {
      parsed = parseUrlLike(asset.link);
    } catch {
      continue;
    }
    const { host, segments } = parsed;

    console.log(`Getting extra metadata for ${asset.name}`);

    try {
      let metadata: [string | null, string | null] | null = null;
      if (host === "github.com" && options.githubClient !== null) {
        metadata = await getMetadataFromGithub(
          options.githubClient,
          segments[0],
          segments[1],
          bevyCrates,
        );
      } else if (host === "gitlab.com" && options.gitlabClient !== null) {
        metadata = await getMetadataFromGitlab(
          options.gitlabClient,
          segments[1],
          bevyCrates,
        );
      }
      if (metadata !== null) {
        const [license, version] = metadata;
        setLicense(asset, license);
        setBevyVersion(asset, version);
      }
    } catch (err) {
      console.error(`Failed to get metadata for ${asset.name}`);
      console.error(`ERROR: ${errMsg(err)}`);
    }
  }
}

/** Collects every Asset in a tree into a flat array (for `enrichAssets`). */
export function collectAssets(
  node: { kind: "Section"; section: { content: any[] } } | { kind: "Asset"; asset: Asset },
): Asset[] {
  const out: Asset[] = [];
  const walk = (n: any) => {
    if (n.kind === "Asset") {
      out.push(n.asset);
    } else {
      for (const c of n.section.content) walk(c);
    }
  };
  walk(node);
  return out;
}
