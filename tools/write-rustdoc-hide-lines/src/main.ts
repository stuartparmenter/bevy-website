#!/usr/bin/env node
// Port of `src/main.rs`.

import * as formatter from "./formatter.ts";
import { debugPath } from "./formatter.ts";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

async function main(): Promise<number> {
  // The first two argv entries are the node binary and script path.
  const args = process.argv.slice(2);

  const cmd = args.shift();
  const folders = args;

  switch (cmd) {
    case "check":
      return await check(folders);
    case "format":
      return await format(folders);
    case undefined:
      console.error(
        "No subcommand specified. Please use either 'format' or 'check'.",
      );
      return EXIT_FAILURE;
    default:
      console.error(
        `Invalid subcommand '${cmd}' specified. Please use either 'format' or 'check'.`,
      );
      return EXIT_FAILURE;
  }
}

async function check(folders: string[]): Promise<number> {
  if (folders.length === 0) {
    console.error(
      "Did not check any files because no folder arguments were passed.",
    );
    return EXIT_FAILURE;
  }

  // An aggregate list of all unformatted files, empty by default.
  const unformattedFiles: string[] = [];

  // Detect if we're running through Github Actions or not.
  const isCi = process.env.GITHUB_ACTIONS === "true";

  for (const folder of folders) {
    if (isCi) {
      console.log(`::group::Checking folder ${debugPath(folder)}`);
    } else {
      console.log(`\nChecking folder ${debugPath(folder)}`);
    }

    try {
      const unformatted = await formatter.check(folder);
      unformattedFiles.push(...unformatted);
    } catch (error) {
      if (isCi) {
        console.log("::endgroup::");
      }
      console.error(`Error: ${errorMessage(error)}`);
      return EXIT_FAILURE;
    }

    if (isCi) {
      console.log("::endgroup::");
    }
  }

  if (unformattedFiles.length !== 0) {
    console.log("\nThe following files are not formatted:");

    for (const p of unformattedFiles) {
      if (isCi) {
        console.log(
          `::error file=${debugPath(p)},title=File is not formatted with correct hide-lines annotations::- ${debugPath(p)}`,
        );
      } else {
        console.log(`- ${debugPath(p)}`);
      }
    }

    console.log(
      "\nRun write_rustdoc_hide_lines.sh to automatically fix these errors.",
    );

    return EXIT_FAILURE;
  } else {
    console.log("All files are properly formatted. :)");
    return EXIT_SUCCESS;
  }
}

async function format(folders: string[]): Promise<number> {
  if (folders.length === 0) {
    console.error(
      "Did not format any files because no folder arguments were passed.",
    );
    return EXIT_FAILURE;
  }

  for (const folder of folders) {
    console.log(`\nFormatting folder ${debugPath(folder)}`);

    try {
      await formatter.format(folder);
    } catch (error) {
      console.error(`Error: ${errorMessage(error)}`);
      return EXIT_FAILURE;
    }
  }

  console.log("\nAll files have been formatted successfully!");

  return EXIT_SUCCESS;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error(`Error: ${errorMessage(error)}`);
    process.exit(EXIT_FAILURE);
  },
);
