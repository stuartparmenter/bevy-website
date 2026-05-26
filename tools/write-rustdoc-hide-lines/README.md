# Write `rustdoc` `hide_lines` Annotations (TypeScript)

This is a TypeScript port of the Rust crate in `../../write-rustdoc-hide-lines/`,
part of converting the site's tooling from Rust to TypeScript. Behavior is
intended to be identical to the original.

This utility recursively iterates over all Markdown files in a given folder. It
updates the [`hide_lines` Zola annotation] on all `rust` and `rs` code blocks to
match [rustdoc hidden lines]. It matches all lines that start with `# ` (a space
after the `#` is required, so attributes like `#[derive(...)]` are not hidden).
If `hide_lines` is out of date, the tool can automatically update it.

[`hide_lines` Zola annotation]: https://www.getzola.org/documentation/content/syntax-highlighting/#annotations
[rustdoc hidden lines]: https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html#hiding-portions-of-the-example

## Requirements

Node 22+. The TypeScript runs directly via Node's type stripping
(`--experimental-strip-types`); there is no build step and no runtime
dependencies.

## Usage

Format one or more directories (rewrites files in place):

```shell
node --experimental-strip-types src/main.ts format ./path/to/directory
node --experimental-strip-types src/main.ts format ./folder1 ./folder2
```

Check directories without modifying them (exits non-zero if any file would
change):

```shell
node --experimental-strip-types src/main.ts check ./folder1 ./folder2
```

When the `GITHUB_ACTIONS=true` environment variable is set, `check` emits
GitHub Actions log grouping and `::error::` annotations, matching the Rust tool.

## Tests

Unit tests ported from the Rust crate's `#[cfg(test)]` modules:

```shell
node --experimental-strip-types test/run.ts
```

## Port notes

The transformation is byte-for-byte equivalent to the Rust implementation:

- Input is split using Rust `str::lines()` semantics (split on `\n`, trailing
  `\r` removed, no trailing empty line), and each output line is followed by
  `\n` (matching Rust `writeln!`). A file with no final newline gains one, and
  CRLF line endings are normalized to LF.
- The same regexes are used: code-block detection `\s*```(\w*)`, fence parsing
  `(\s*)```(.+)`, and hidden-line detection `^\s*#(?: |$)`.
- Only `rust` / `rs` code blocks are touched; other languages and non-code text
  pass through unchanged.
- Hidden-line ranges are 1-based and inclusive, formatted as space-separated
  `N` or `start-end` tokens, exactly as the original.

There is no TOML handling: front matter and all non-code text are passed through
verbatim, so no TOML parser is needed.
