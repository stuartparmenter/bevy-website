#!/usr/bin/env node --experimental-strip-types
// Port of generate-errors/src/bin/generate.rs to TypeScript.
//
// Generate error reference pages from Bevy engine for use on the Bevy website.
//
// Usage:
//   node --experimental-strip-types generate.ts --errors-path <ERRORS_PATH> --output-path <OUTPUT_PATH>

import { getErrorPages, writePages, writeSection } from "./lib.ts";

interface Args {
  errorsPath: string;
  outputPath: string;
}

const HELP = `Generate error reference pages from Bevy engine for use on the Bevy website.

Usage: generate --errors-path <ERRORS_PATH> --output-path <OUTPUT_PATH>

Options:
      --errors-path <ERRORS_PATH>  Path to the directory containing the error files stored in the local Bevy GitHub repo
      --output-path <OUTPUT_PATH>  Path to the folder which the errors section should be generated in
  -h, --help                       Print help
`;

function parseArgs(argv: string[]): Args {
  let errorsPath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--errors-path":
        errorsPath = argv[++i];
        break;
      case "--output-path":
        outputPath = argv[++i];
        break;
      default:
        // Support `--flag=value` form too.
        if (arg.startsWith("--errors-path=")) {
          errorsPath = arg.slice("--errors-path=".length);
        } else if (arg.startsWith("--output-path=")) {
          outputPath = arg.slice("--output-path=".length);
        } else {
          process.stderr.write(`error: unexpected argument '${arg}'\n\n${HELP}`);
          process.exit(2);
        }
    }
  }

  if (errorsPath === undefined) {
    process.stderr.write(`error: the following required argument was not provided: --errors-path <ERRORS_PATH>\n\n${HELP}`);
    process.exit(2);
  }
  if (outputPath === undefined) {
    process.stderr.write(`error: the following required argument was not provided: --output-path <OUTPUT_PATH>\n\n${HELP}`);
    process.exit(2);
  }

  return { errorsPath, outputPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log("Writing section index & introduction . . .");
  writeSection(args.outputPath);
  console.log("Getting error page contents . . .");
  const errorPageContent = getErrorPages(args.errorsPath);
  console.log("Writing error pages content to output path . . .");
  writePages(args.outputPath, errorPageContent);

  console.log("All good!");
}

main();
