// Pure helpers for extracting license + bevy version from a Cargo.toml manifest.
//
// Ports the `cargo_toml`-based logic in generate-assets/src/lib.rs:
//   - get_license
//   - get_bevy_version_from_manifest
//   - search_bevy_in_manifest_dependencies
//   - get_bevy_manifest_dependency_version
//
// These functions are network-free (they take an already-fetched manifest
// string) and are fully unit-testable. The crates.io / GitHub / GitLab fetching
// that *supplies* the manifest text lives in metadata.ts.

import { parse as parseToml } from "smol-toml";

const OFFICIAL_BEVY_CRATE_PREFIX_RANGE_START = "bevy";
const OFFICIAL_BEVY_CRATE_PREFIX_RANGE_END = "bevz";

// A parsed dependency, mirroring the variants of `cargo_toml::Dependency`.
type Dependency =
  | { kind: "Simple"; version: string }
  | { kind: "Detailed"; version: string | null; git: string | null; branch: string | null; path: string | null }
  | { kind: "Inherited" };

export interface Manifest {
  // package.license (Inheritable::Set) and package.license-file
  packageLicense: string | null;
  packageHasLicenseFile: boolean;
  hasPackage: boolean;
  dependencies: Map<string, Dependency>;
  devDependencies: Map<string, Dependency>;
  workspaceDependencies: Map<string, Dependency> | null;
}

function parseDependency(value: unknown): Dependency {
  if (typeof value === "string") {
    return { kind: "Simple", version: value };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // `cargo_toml` treats a detail table with `workspace = true` as Inherited.
    if (obj.workspace === true) {
      return { kind: "Inherited" };
    }
    const version = typeof obj.version === "string" ? obj.version : null;
    const git = typeof obj.git === "string" ? obj.git : null;
    const branch = typeof obj.branch === "string" ? obj.branch : null;
    const path = typeof obj.path === "string" ? obj.path : null;
    return { kind: "Detailed", version, git, branch, path };
  }
  // Fallback: treat unknown shapes as a detailed dep with no version.
  return { kind: "Detailed", version: null, git: null, branch: null, path: null };
}

function parseDependencyTable(value: unknown): Map<string, Dependency> {
  const map = new Map<string, Dependency>();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, dep] of Object.entries(value as Record<string, unknown>)) {
      map.set(key, parseDependency(dep));
    }
  }
  return map;
}

/** Parse a Cargo.toml string into the subset of fields we need. */
export function parseManifest(content: string): Manifest {
  const raw = parseToml(content) as Record<string, unknown>;

  const pkg = raw.package as Record<string, unknown> | undefined;
  let packageLicense: string | null = null;
  let packageHasLicenseFile = false;
  if (pkg !== undefined) {
    // `license` is `Option<Inheritable<String>>`. A workspace-inherited license
    // (`license.workspace = true`) is NOT `Inheritable::Set`, so it is ignored,
    // matching the Rust `if let Inheritable::Set(license)` arm.
    if (typeof pkg.license === "string") {
      packageLicense = pkg.license;
    }
    // license-file (kebab) is the canonical key; license_file also accepted.
    packageHasLicenseFile =
      typeof pkg["license-file"] === "string" || typeof pkg["license_file"] === "string";
  }

  const workspace = raw.workspace as Record<string, unknown> | undefined;

  return {
    hasPackage: pkg !== undefined,
    packageLicense,
    packageHasLicenseFile,
    dependencies: parseDependencyTable(raw.dependencies),
    devDependencies: parseDependencyTable(raw["dev-dependencies"] ?? raw["dev_dependencies"]),
    workspaceDependencies:
      workspace !== undefined ? parseDependencyTable(workspace.dependencies) : null,
  };
}

/**
 * Gets the license from a manifest, emulating crates.io behaviour.
 * Mirrors `get_license`.
 */
export function getLicense(manifest: Manifest): string | null {
  if (!manifest.hasPackage) return null;
  if (manifest.packageLicense !== null) {
    return manifest.packageLicense;
  }
  return manifest.packageHasLicenseFile ? "non-standard" : null;
}

/**
 * Gets the version from a single bevy dependency. Returns the version string if
 * available; for a git dependency returns "main" (branch == "main") or "git".
 * Mirrors `get_bevy_manifest_dependency_version`.
 */
function getBevyDependencyVersion(dep: Dependency): string | null {
  switch (dep.kind) {
    case "Simple":
      return dep.version;
    case "Detailed":
      if (dep.version !== null) return dep.version;
      if (dep.git !== null) {
        return dep.branch === "main" ? "main" : "git";
      }
      return null;
    case "Inherited":
      return null;
  }
}

/**
 * Returns entries of a dependency map whose key falls in the half-open range
 * [start, end), in ascending key order, matching Rust's `BTreeMap::range`
 * (which uses byte-wise string ordering for `String` keys).
 */
function rangeByKey(
  deps: Map<string, Dependency>,
  start: string,
  end: string,
): Array<[string, Dependency]> {
  const startBuf = Buffer.from(start, "utf8");
  const endBuf = Buffer.from(end, "utf8");
  const entries: Array<[string, Dependency]> = [];
  for (const [key, dep] of deps) {
    const k = Buffer.from(key, "utf8");
    if (Buffer.compare(k, startBuf) >= 0 && Buffer.compare(k, endBuf) < 0) {
      entries.push([key, dep]);
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")));
  return entries;
}

/**
 * Finds the first official bevy crate present in a (sorted) dependency range and
 * returns its version. Both inputs are assumed sorted by key; this walks them in
 * lock-step like the Rust `search_bevy_in_manifest_dependencies`.
 */
function searchBevyInDependencies(
  dependencies: Array<[string, Dependency]>,
  bevyCrates: string[],
): string | null {
  let di = 0;
  let bi = 0;
  while (di < dependencies.length && bi < bevyCrates.length) {
    const depName = dependencies[di][0];
    const bevyCrateName = bevyCrates[bi];
    const cmp = byteCompare(depName, bevyCrateName);
    if (cmp < 0) {
      di += 1;
    } else if (cmp === 0) {
      const version = getBevyDependencyVersion(dependencies[di][1]);
      if (version !== null) return version;
      // Found an official bevy crate but no version; advance both.
      di += 1;
      bi += 1;
    } else {
      bi += 1;
    }
  }
  return null;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Finds a bevy version from a manifest, checking (in order) dependencies, dev
 * dependencies, then workspace dependencies. Returns `null` if `bevyCrates` is
 * `null`. Mirrors `get_bevy_version_from_manifest`.
 *
 * `bevyCrates` must be sorted lexicographically (byte order), matching the Rust
 * `bevy_crates_names`.
 */
export function getBevyVersionFromManifest(
  manifest: Manifest,
  bevyCrates: string[] | null,
): string | null {
  if (bevyCrates === null) return null;

  const start = OFFICIAL_BEVY_CRATE_PREFIX_RANGE_START;
  const end = OFFICIAL_BEVY_CRATE_PREFIX_RANGE_END;

  let result = searchBevyInDependencies(
    rangeByKey(manifest.dependencies, start, end),
    bevyCrates,
  );
  if (result !== null) return result;

  result = searchBevyInDependencies(
    rangeByKey(manifest.devDependencies, start, end),
    bevyCrates,
  );
  if (result !== null) return result;

  if (manifest.workspaceDependencies !== null) {
    result = searchBevyInDependencies(
      rangeByKey(manifest.workspaceDependencies, start, end),
      bevyCrates,
    );
    if (result !== null) return result;
  }

  return null;
}

// --- license / version merging (used when scanning multiple Cargo.toml) ---

/** Merge two licenses, getting the combination of both. Mirrors `merge_license`. */
export function mergeLicense(
  license1: string | null,
  license2: string | null,
): string | null {
  if (license1 === null) return license2;
  if (license2 === null) return license1;
  if (license1.includes(license2)) return license1;
  if (license2.includes(license1)) return license2;
  return license1 + " " + license2;
}

/**
 * Merge two versions, getting the "maximum" of the two. Mirrors `merge_version`
 * (currently just returns version1 if it is `Some`).
 */
export function mergeVersion(
  version1: string | null,
  version2: string | null,
): string | null {
  if (version1 !== null) return version1;
  return version2;
}
