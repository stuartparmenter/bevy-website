#!/usr/bin/env node --experimental-strip-types
// Port of generate-release/src/main.rs to TypeScript.
//
// Generates the skeleton files used for a Bevy release under
// `release-content/<release-version>/`.
//
// Requires a valid `GITHUB_TOKEN` environment variable. A `.env` file at the
// repository root is loaded automatically (mirroring the Rust crate's use of
// `dotenvy`).
//
// Example used to generate the 0.14 release:
//   node --experimental-strip-types generate.ts --from v0.13.0 --to main --release-version 0.14 migration-guides
//   node --experimental-strip-types generate.ts --from v0.13.0 --to main --release-version 0.14 release-notes
//   node --experimental-strip-types generate.ts --from v0.13.0 --to main --release-version 0.14 changelog
//   node --experimental-strip-types generate.ts --from v0.13.0 --to main --release-version 0.14 contributors

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BevyRepo, GithubClient } from "./github-client.ts";
import { generateMigrationGuides } from "./migration-guides.ts";
import { generateReleaseNotes } from "./release-notes.ts";
import { generateChangelog } from "./changelog.ts";
import { generateContributors } from "./contributors.ts";

const HELP = `Generates markdown files used for a bevy release.

Requires a valid \`GITHUB_TOKEN\` environment variable, you can use a .env file
or use your preferred method of passing env arguments.

Usage:
  generate.ts --from <FROM> --to <TO> --release-version <VERSION> <COMMAND> [OPTIONS]

Options:
  -f, --from <FROM>                 The name of the branch / tag to start from
  -t, --to <TO>                     The name of the branch / tag to end on
  -r, --release-version <VERSION>   Release version i.e.: '0.13', '0.14', etc.
      --release-path <PATH>         Override the output directory root
                                    (defaults to <repo>/release-content)
  -h, --help                        Print help

Commands:
  migration-guides   Gather PRs with the M-Needs-Migration-Guide label or a
                     Migration Guide section, writing one file per guide.
      -o, --overwrite-existing      Overwrite existing files
  release-notes      Generate release notes for all PRs with M-Needs-Release-Note.
      -o, --overwrite-existing      Overwrite existing files
      -c, --create-issues           Create issues for required release notes,
                                    and comment on the original PRs.
  changelog          Generate a list of all merged PRs for the release.
  contributors       Generate the list of contributors.
`;

interface ParsedArgs {
  from: string;
  to: string;
  releaseVersion: string;
  releasePath: string | null;
  command: string;
  overwriteExisting: boolean;
  createIssues: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let from: string | null = null;
  let to: string | null = null;
  let releaseVersion: string | null = null;
  let releasePath: string | null = null;
  let command: string | null = null;
  let overwriteExisting = false;
  let createIssues = false;

  const commands = new Set(["migration-guides", "release-notes", "changelog", "contributors"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "-f":
      case "--from":
        from = argv[++i];
        break;
      case "-t":
      case "--to":
        to = argv[++i];
        break;
      case "-r":
      case "--release-version":
        releaseVersion = argv[++i];
        break;
      case "--release-path":
        releasePath = argv[++i];
        break;
      case "-o":
      case "--overwrite-existing":
        overwriteExisting = true;
        break;
      case "-c":
      case "--create-issues":
        createIssues = true;
        break;
      default:
        if (commands.has(arg)) {
          command = arg;
        } else {
          throw new Error(`unexpected argument: ${arg}`);
        }
    }
  }

  if (from === null) throw new Error("missing required argument --from");
  if (to === null) throw new Error("missing required argument --to");
  if (releaseVersion === null) throw new Error("missing required argument --release-version");
  if (command === null) throw new Error("missing subcommand (one of: migration-guides, release-notes, changelog, contributors)");

  return { from, to, releaseVersion, releasePath, command, overwriteExisting, createIssues };
}

/** Minimal `.env` loader (mirrors `dotenvy::dotenv()`: only sets vars not already present). */
function loadDotenv(repoRoot: string): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // This script lives at <repo>/tools/generate-release/generate.ts.
  // The repo root is two directories up.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");

  loadDotenv(repoRoot);

  const token = process.env.GITHUB_TOKEN;
  if (token === undefined) {
    throw new Error("GITHUB_TOKEN not found");
  }

  const client = new GithubClient(token, BevyRepo.Bevy);

  const releaseContentRoot = args.releasePath ?? join(repoRoot, "release-content");
  const releasePath = join(releaseContentRoot, args.releaseVersion);

  mkdirSync(releasePath, { recursive: true });

  switch (args.command) {
    case "migration-guides":
      await generateMigrationGuides(
        args.from,
        args.to,
        join(releasePath, "migration-guides"),
        client,
        args.overwriteExisting,
      );
      break;
    case "release-notes":
      await generateReleaseNotes(
        args.from,
        args.to,
        join(releasePath, "release-notes"),
        client,
        args.overwriteExisting,
        args.createIssues,
      );
      break;
    case "changelog":
      await generateChangelog(args.from, args.to, join(releasePath, "changelog.toml"), client);
      break;
    case "contributors":
      await generateContributors(
        args.from,
        args.to,
        join(releasePath, "contributors.toml"),
        client,
      );
      break;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
