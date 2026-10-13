# pi-git-identity

A small [pi](https://pi.dev) extension that adds an interactive Git identity picker.

It is an explicit wrapper around the third-party [`git-identity`](https://github.com/runebaas/git-identity) package, pinned and tested with `git-identity@1.1.4`. The extension delegates profile storage and Git configuration changes to that package.

The extension does not automatically switch identities, inspect remotes, install Git hooks, or create repository rules. It only changes Git identity when you run its command or the agent calls its tool.

## Prerequisites

Install the wrapped third-party package first:

```bash
npm install --global git-identity@1.1.4
```

The package stores saved profiles in `~/.gitidentities` and supports the same local and global scope as its own CLI.

## Install in pi

Install this repository as a pi package:

```bash
pi install git:github.com/meatRoll/pi-git-identity
```

For a one-session test:

```bash
pi -e git:github.com/meatRoll/pi-git-identity
```

After installing or changing the extension, run `/reload` in pi.

## Commands

Run `/gitid` or `/git-identity` with no arguments to open a picker. The extension first lets you choose a saved profile and then choose whether to apply it to the current repository or the global Git config.

Direct forms are also available:

```text
/gitid github             Apply github to the current repository
/gitid github --global   Apply github to global Git config
/gitid reset             Remove local identity settings from the current repository
/gitid list              List saved profiles
/gitid current           Show current and global identities
/gitid help              Show command usage
```

The agent can use the `git_identity` tool with explicit actions: `choose`, `use`, `reset`, `list`, and `current`. A tool request without a scope uses the current repository, which avoids changing global configuration accidentally.

## Development

```bash
npm install
npm run typecheck
```

The extension invokes `git identity` with argument arrays through Node's `execFile`; it does not build shell commands from profile values.

## Third-party attribution

This repository is an adapter around `git-identity@1.1.4` by [runebaas](https://github.com/runebaas/git-identity), licensed under MIT. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The adapter code in this repository is also released under the MIT License.
