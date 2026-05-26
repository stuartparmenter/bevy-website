// A small semver VersionReq matcher reproducing the subset of the Rust `semver`
// crate's behaviour used by generate-assets/src/bin/generate.rs
// (`VersionReq::parse(ver).matches(version)`).
//
// Supported comparators: `=`, `>`, `>=`, `<`, `<=`, `~`, `^` (default), `*`.
// Multiple comma-separated comparators are ANDed. A parse error yields `null`,
// matching the Rust code which treats a failed `VersionReq::parse` as
// "not semver compatible".

export interface SemverCore {
  major: number;
  minor: number;
  patch: number;
}

/** Parse "MAJOR.MINOR.PATCH" (ignoring pre-release/build) into a core version. */
export function parseVersion(v: string): SemverCore | null {
  const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
  const parts = core.split(".");
  if (parts.length < 1) return null;
  const nums: number[] = [];
  for (const p of parts.slice(0, 3)) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  return { major: nums[0], minor: nums[1] ?? 0, patch: nums[2] ?? 0 };
}

interface Comparator {
  op: "=" | ">" | ">=" | "<" | "<=" | "~" | "^";
  major: number;
  minor: number | null;
  patch: number | null;
}

function compareCore(a: SemverCore, b: SemverCore): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function parseComparator(input: string): Comparator | null {
  let s = input.trim();
  let op: Comparator["op"] = "^";
  const ops: Array<Comparator["op"]> = [">=", "<=", "=", ">", "<", "~", "^"];
  for (const candidate of ops) {
    if (s.startsWith(candidate)) {
      op = candidate;
      s = s.slice(candidate.length).trim();
      break;
    }
  }
  // version portion: MAJOR[.MINOR[.PATCH]], allow wildcards x/X/*.
  const parts = s.split(".");
  if (parts.length === 0 || parts[0] === "") return null;

  function num(part: string | undefined): number | null | "wild" {
    if (part === undefined) return null;
    if (part === "*" || part === "x" || part === "X") return "wild";
    const n = Number(part.split(/[-+]/)[0]);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }

  const majorTok = num(parts[0]);
  if (majorTok === null) return null;
  if (majorTok === "wild") {
    // "*" alone — match anything. Represent as ^0 style "any".
    return { op: "^", major: -1, minor: null, patch: null };
  }
  const minorTok = num(parts[1]);
  const patchTok = num(parts[2]);

  return {
    major: majorTok,
    minor: minorTok === "wild" || minorTok === null ? null : minorTok,
    patch: patchTok === "wild" || patchTok === null ? null : patchTok,
    op,
  };
}

function matchComparator(c: Comparator, v: SemverCore): boolean {
  // Wildcard-any (from "*").
  if (c.major === -1) return true;

  const lower: SemverCore = {
    major: c.major,
    minor: c.minor ?? 0,
    patch: c.patch ?? 0,
  };

  switch (c.op) {
    case "=": {
      if (v.major !== c.major) return false;
      if (c.minor !== null && v.minor !== c.minor) return false;
      if (c.patch !== null && v.patch !== c.patch) return false;
      return true;
    }
    case ">":
      return compareCore(v, lower) > 0;
    case ">=":
      return compareCore(v, lower) >= 0;
    case "<":
      return compareCore(v, lower) < 0;
    case "<=":
      return compareCore(v, lower) <= 0;
    case "~": {
      // ~I.J.K := >=I.J.K, <I.(J+1).0; ~I.J := >=I.J.0,<I.(J+1).0; ~I := ^I
      if (compareCore(v, lower) < 0) return false;
      if (c.minor === null) {
        // ~I -> <(I+1).0.0
        return v.major < c.major + 1;
      }
      // upper bound (I, J+1, 0)
      const upper: SemverCore = { major: c.major, minor: c.minor + 1, patch: 0 };
      return compareCore(v, upper) < 0;
    }
    case "^": {
      // Caret semantics (Rust semver):
      // ^I.J.K (I>0) -> >=I.J.K, <(I+1).0.0
      // ^0.J.K (J>0) -> >=0.J.K, <0.(J+1).0
      // ^0.0.K       -> >=0.0.K, <0.0.(K+1)
      // ^I.J         -> >=I.J.0, <(I+1).0.0  (I>0)
      // ^0.J         -> >=0.J.0, <0.(J+1).0  (J>0)
      // ^0.0         -> >=0.0.0, <0.1.0
      // ^I           -> >=I.0.0, <(I+1).0.0
      // ^0           -> >=0.0.0, <1.0.0
      if (compareCore(v, lower) < 0) return false;

      let upper: SemverCore;
      if (c.major > 0) {
        upper = { major: c.major + 1, minor: 0, patch: 0 };
      } else if (c.minor === null) {
        // ^0 -> <1.0.0
        upper = { major: 1, minor: 0, patch: 0 };
      } else if (c.minor > 0) {
        upper = { major: 0, minor: c.minor + 1, patch: 0 };
      } else if (c.patch === null) {
        // ^0.0 -> <0.1.0
        upper = { major: 0, minor: 1, patch: 0 };
      } else {
        // ^0.0.K -> <0.0.(K+1)
        upper = { major: 0, minor: 0, patch: c.patch + 1 };
      }
      return compareCore(v, upper) < 0;
    }
  }
}

/**
 * Parse a VersionReq string. Returns a matcher function, or `null` if the
 * requirement fails to parse (matching the Rust crate's behaviour of treating
 * a parse error as "no match").
 */
export function parseVersionReq(input: string): ((v: SemverCore) => boolean) | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "*") {
    return () => true;
  }
  const comparators: Comparator[] = [];
  for (const piece of trimmed.split(",")) {
    const p = piece.trim();
    if (p === "") continue;
    if (p === "*") {
      comparators.push({ op: "^", major: -1, minor: null, patch: null });
      continue;
    }
    const c = parseComparator(p);
    if (c === null) return null;
    comparators.push(c);
  }
  if (comparators.length === 0) return () => true;
  return (v: SemverCore) => comparators.every((c) => matchComparator(c, v));
}

/**
 * Returns true if `version` satisfies the requirement string `req`. A
 * parse error in either argument yields `false` (matching generate.rs).
 */
export function versionMatchesReq(req: string, version: SemverCore): boolean {
  const matcher = parseVersionReq(req);
  if (matcher === null) return false;
  return matcher(version);
}
