# Bevy Website

The source files for <https://bevy.org>. This includes official Bevy news, docs, and interactive examples.

If you would like to contribute, check out [CONTRIBUTING.md](/CONTRIBUTING.md) and then submit a pull request!

## Astro

The Bevy website is built with [Astro](https://astro.build/) (Node 22+).

To check out any local changes you've made:

1. Install [Node.js](https://nodejs.org/) 22 or newer.
2. Clone the Bevy Website git repo and enter that directory:
   1. `git clone https://github.com/bevyengine/bevy-website.git`
   2. `cd bevy-website`
3. Install dependencies with `npm install`.
4. Start the dev server with `npm run dev` (or `npm run build` to produce the static site in `dist/`).

A local server should start and you should be able to access a local version of the website from there.

### Assets, Errors, and Examples pages

These pages need to be generated in a separate step by running the shell scripts in the `generate-assets`, `generate-errors`, and `generate-wasm-examples` directories. On Windows, you can use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) or [git bash](https://gitforwindows.org/).

## Contributing documentation

If you want to contribute to Bevy's documentation found under `content/learn/`, we have a [style guide](content/learn/contribute/helping-out/writing-docs.md#contributors-style-guide) to help you.
