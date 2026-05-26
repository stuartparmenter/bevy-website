#!/usr/bin/env node --experimental-strip-types
// Port of the `learning-code-examples` crate tooling to TypeScript.
//
// CLI with two subcommands:
//
//   cargo         Reproduce `validate_examples.sh`: run, in the crate dir,
//                   cargo check --examples
//                   cargo clippy --examples -- -Dwarnings
//                   cargo fmt --check
//                 (Requires the Rust toolchain; shells out to `cargo`.)
//
//   check-anchors Toolchain-free validation: parse `Cargo.toml` example
//                 entries, validate the `// ANCHOR:` structure of each example
//                 file, and (optionally) verify that anchors referenced by site
//                 content (`file_code_block` shortcode calls) exist.
//
// Run with: node --experimental-strip-types validate.ts <subcommand> [options]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findFileCodeBlockRefs,
  listExampleFiles,
  listFiles,
  parseExampleEntries,
  validateAnchors,
  validateReferences,
  type AnchorIssue,
  type ReferenceIssue,
} from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// tools/learning-code-examples -> repo root is two levels up.
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_CRATE = join(REPO_ROOT, "learning-code-examples");
const DEFAULT_CONTENT = join(REPO_ROOT, "content");

const HELP = `Validate the Bevy website learning code examples.

Usage: validate <COMMAND> [OPTIONS]

Commands:
  cargo          Run cargo check/clippy/fmt over the examples (mirrors
                 validate_examples.sh). Requires the Rust toolchain.
  check-anchors  Validate ANCHOR structure and that content references resolve.
                 Does not require a Rust toolchain.

Options:
      --crate-path <PATH>    Path to the learning-code-examples crate
                             (default: <repo>/learning-code-examples)
      --content-path <PATH>  Path to the Zola/site content dir, used by
                             check-anchors to find file_code_block references
                             (default: <repo>/content). Pass "none" to skip.
  -h, --help                 Print help
`;

interface Args {
  command: string;
  cratePath: string;
  contentPath: string;
}

function parseArgs(argv: string[]): Args {
  let command: string | undefined;
  let cratePath = DEFAULT_CRATE;
  let contentPath = DEFAULT_CONTENT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--crate-path") {
      cratePath = resolve(argv[++i]);
    } else if (arg.startsWith("--crate-path=")) {
      cratePath = resolve(arg.slice("--crate-path=".length));
    } else if (arg === "--content-path") {
      contentPath = argv[++i];
    } else if (arg.startsWith("--content-path=")) {
      contentPath = arg.slice("--content-path=".length);
    } else if (!arg.startsWith("-") && command === undefined) {
      command = arg;
    } else {
      process.stderr.write(`error: unexpected argument '${arg}'\n\n${HELP}`);
      process.exit(2);
    }
  }

  if (command === undefined) {
    process.stderr.write(`error: a command is required\n\n${HELP}`);
    process.exit(2);
  }

  return { command, cratePath, contentPath };
}

/** Mirror of validate_examples.sh: cargo check + clippy + fmt, run in-crate. */
function runCargo(cratePath: string): number {
  const steps: { cmd: string; args: string[] }[] = [
    { cmd: "cargo", args: ["check", "--examples"] },
    { cmd: "cargo", args: ["clippy", "--examples", "--", "-Dwarnings"] },
    { cmd: "cargo", args: ["fmt", "--check"] },
  ];
  for (const step of steps) {
    console.log(`$ ${step.cmd} ${step.args.join(" ")}`);
    const res = spawnSync(step.cmd, step.args, { cwd: cratePath, stdio: "inherit" });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        console.error(
          `error: '${step.cmd}' not found. The cargo subcommand requires the Rust toolchain.`,
        );
      } else {
        console.error(`error: failed to run ${step.cmd}: ${err.message}`);
      }
      return 127;
    }
    // Match `&&` chaining in the shell script: stop on first failure.
    if (res.status !== 0) return res.status ?? 1;
  }
  return 0;
}

function describeAnchorIssue(i: AnchorIssue): string {
  switch (i.kind) {
    case "duplicate-anchor":
      return `${i.file}:${i.line}: anchor "${i.anchor}" opened again while already open`;
    case "unclosed-anchor":
      return `${i.file}:${i.line}: anchor "${i.anchor}" is never closed (// ANCHOR_END: ${i.anchor})`;
    case "unmatched-end":
      return `${i.file}:${i.line}: // ANCHOR_END: ${i.anchor} has no matching // ANCHOR:`;
    case "empty-anchor":
      return `${i.file}: anchor "${i.anchor}" renders no lines`;
  }
}

function describeReferenceIssue(i: ReferenceIssue): string {
  if (i.kind === "missing-file") {
    return `${i.source}: file_code_block references missing file "${i.file}"`;
  }
  return `${i.source}: file_code_block references missing anchor "${i.anchor}" in "${i.file}"`;
}

function runCheckAnchors(cratePath: string, contentPath: string): number {
  const cargoTomlPath = join(cratePath, "Cargo.toml");
  const examplesDir = join(cratePath, "examples");

  if (!existsSync(cargoTomlPath)) {
    console.error(`error: ${cargoTomlPath} not found`);
    return 2;
  }
  if (!existsSync(examplesDir)) {
    console.error(`error: ${examplesDir} not found`);
    return 2;
  }

  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const entries = parseExampleEntries(cargoToml);
  const files = listExampleFiles(examplesDir, cratePath);

  console.log(`Found ${entries.length} [[example]] entries and ${files.length} .rs files.`);

  let failures = 0;

  // 1. Every [[example]] path must exist; every .rs file should be registered.
  const entryPaths = new Set(entries.map((e) => e.path));
  for (const e of entries) {
    if (!existsSync(join(cratePath, e.path))) {
      console.error(`error: [[example]] "${e.name}" points at missing path "${e.path}"`);
      failures++;
    }
  }
  for (const f of files) {
    if (!entryPaths.has(f)) {
      console.error(`error: example file "${f}" is not registered as an [[example]] in Cargo.toml`);
      failures++;
    }
  }

  // 2. Anchor structure of each example file.
  const anchorIssues: AnchorIssue[] = [];
  for (const f of files) {
    const code = readFileSync(join(cratePath, f), "utf8");
    anchorIssues.push(...validateAnchors(f, code));
  }
  for (const issue of anchorIssues) {
    console.error(`error: ${describeAnchorIssue(issue)}`);
  }
  failures += anchorIssues.length;

  // 3. Content references (optional).
  if (contentPath !== "none") {
    if (!existsSync(contentPath)) {
      console.error(`warning: content path "${contentPath}" not found; skipping reference checks`);
    } else {
      const contentFiles = listFiles(contentPath, [".md"]);
      const refs = findFileCodeBlockRefs(contentFiles, contentPath);
      const refIssues = validateReferences(refs, examplesDir);
      console.log(`Checked ${refs.length} file_code_block references in content.`);
      for (const issue of refIssues) {
        console.error(`error: ${describeReferenceIssue(issue)}`);
      }
      failures += refIssues.length;
    }
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} issue(s) found.`);
    return 1;
  }
  console.log("All good!");
  return 0;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let code: number;
  switch (args.command) {
    case "cargo":
      code = runCargo(args.cratePath);
      break;
    case "check-anchors":
      code = runCheckAnchors(args.cratePath, args.contentPath);
      break;
    default:
      process.stderr.write(`error: unknown command '${args.command}'\n\n${HELP}`);
      process.exit(2);
  }
  process.exit(code);
}

main();
