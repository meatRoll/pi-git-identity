# pi-git-identity

An interactive Git identity picker for [pi](https://pi.dev). Type `/git-identity` and choose an action with the arrow keys; profile names, commit names and email addresses appear in the picker.

**This extension wraps the third-party [`runebaas/git-identity`](https://github.com/runebaas/git-identity) CLI, tested with `git-identity@1.1.4`.** Saved profiles stay in its existing `~/.gitidentities` file. Repository identity changes are delegated to its `use` and `reset` commands. Global clearing, which upstream does not provide, uses Git's own config commands.

## Install

Install the upstream CLI and check that Git can find it:

```bash
npm install --global git-identity@1.1.4
git identity --version
pi install git:github.com/meatRoll/pi-git-identity
```

Run `/reload` in an existing pi session. With nvm, the upstream CLI must be installed in the Node version available on pi's PATH.

To save a profile from your current Git identity:

```bash
git identity add personal
```

Repeat with your other identities, or edit `~/.gitidentities`. The store contains only profile data, for example:

```json
{
  "personal": {
    "name": "Example User",
    "email": "personal@example.test",
    "signingKey": ""
  },
  "work": {
    "name": "Example User",
    "email": "work@example.test",
    "signingKey": ""
  }
}
```

Do not use `reset`, `list`, `current` or `help` as profile names; they are command actions.

## Use

`/git-identity` opens the menu:

- Set repository identity
- Set global identity
- Clear repository identity
- Clear global identity
- Show current identity
- List saved profiles

Choosing a set action opens a second picker showing each saved name and email. Escape closes either picker without applying a change. Slash commands and their arguments support pi's command completion.

Direct commands are also available:

| Command | Effect |
| --- | --- |
| `/git-identity personal` | Apply a profile to the current repository |
| `/git-identity personal --global` | Apply a profile to global Git config |
| `/git-identity --global` | Open the global profile picker |
| `/git-identity reset` | Clear current repository identity settings |
| `/git-identity reset --global` | Remove global `user.name` and `user.email` |
| `/git-identity list` | List saved profiles with names and emails |
| `/git-identity current` | Show configured names/emails and their source files |
| `/git-identity help` | Show usage |

Changes persist in ordinary Git configuration until you clear or replace them. They also affect commits made outside pi. Clearing a scope allows identities from other scopes or included files to apply again. Included configuration files are not rewritten; the extension reports an error if an included identity prevents a requested clear.

There are no automatic identity switches, remote rules, hooks, background processes, repository tracking files or agent-callable mutation tools. Merely loading the extension or checking current configuration does not create a profile file or change Git configuration.

## Upstream behavior and limits

`git-identity@1.1.4` is an older CLI. Its `use` command also manages `user.signingkey`, and its local `reset` removes that key along with the local name/email. It may additionally change `core.gpgsign`. This adapter preserves upstream behavior; check your signing configuration if you use signed commits. Global clearing in this adapter removes only name and email.

The adapter passes arguments with Node's `execFile`, checks the requested profile before applying it, and verifies name/email writes because upstream can report success despite failed Git writes. Upstream itself builds shell commands, so the adapter rejects names, emails and signing keys containing shell-sensitive quotes, backticks, dollar signs, backslashes or line breaks.

`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `author.*`, `committer.*`, explicit `--author`, and history-preserving operations such as cherry-pick can override or preserve commit identity. This is a convenient configuration picker, not a commit enforcement mechanism. It changes no existing commits or GitHub login credentials.

## Development and validation

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

Tests invoke the real upstream CLI in isolated temporary repositories and a temporary HOME. They cover picker cancellation, repository/global setting and clearing, commit author/committer, invalid inputs, config lock failures and argument completion.

The upstream CLI has been checked separately with Git 2.39.5 and Git 2.56.0. Wrapper integration tests use Git 2.39.5. pi loading has been checked with the installed pi 0.85.1, and types are checked with the development dependency version recorded in `package-lock.json`.

The pinned upstream development dependency brings older transitive dependencies. `npm audit` currently reports advisories in `tmp` and `external-editor`; this adapter uses identity operations, not the editor functionality. The extension does not bundle the upstream CLI into its production package; it invokes your installed CLI.

## Attribution and license

This repository was AI-assisted. Adapter code is MIT licensed. `git-identity` is a separate MIT-licensed project by Daan Boerlage (runebaas). Its original copyright and license are reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Your actual profile store, Git configuration, credentials and email history are never included in this repository.
