import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "./git-identity.js";

test("explicit commands with real git-identity and isolated Git config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-gitid-test-"));
  const environment = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_") || key === "ZDOTDIR") delete process.env[key];
  }
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.PATH = join(dirname(fileURLToPath(import.meta.url)), "node_modules", ".bin") + delimiter + process.env.PATH;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const notices: Array<{ text: string; type: string }> = [];
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const selections: Array<string | undefined> = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify(text: string, type: string) { notices.push({ text, type }); },
      async select(_title: string, options: string[]) {
        const choice = selections.shift();
        if (choice !== undefined) assert.ok(options.includes(choice), `Option missing: ${choice}`);
        return choice;
      },
    },
  } as unknown as ExtensionCommandContext;
  try {
    extension({ registerCommand(name, command) { commands.set(name, command); } } as ExtensionAPI);
    const command = commands.get("gitid")!;
    const invoke = async (args: string) => {
      notices.length = 0;
      await command.handler(args, ctx);
      return notices.at(-1);
    };
    await t.test("loading and inspecting current config never creates a store", async () => {
      assert.deepEqual([...commands.keys()], ["gitid", "git-identity"]);
      assert.equal(existsSync(join(root, ".gitidentities")), false);
      assert.equal((await invoke("current"))?.text, "No identity configured.");
      assert.equal(existsSync(join(root, ".gitidentities")), false);
      assert.equal(existsSync(join(root, ".gitconfig")), false);
    });
    git("init", "-q");
    git("config", "--global", "user.name", "Default User");
    git("config", "--global", "user.email", "default@example.test");
    const store = join(root, ".gitidentities");
    const data = {
      personal: { name: "Personal User", email: "personal@example.test", signingKey: "" },
      work: { name: "Work User", email: "work@example.test", signingKey: "" },
      unsafe: { name: "$(touch should-not-exist)", email: "unsafe@example.test", signingKey: "" },
    };
    writeFileSync(store, JSON.stringify(data));
    const snapshot = readFileSync(store, "utf8");
    await t.test("completions show profiles, actions and scope", async () => {
      assert.ok((await command.getArgumentCompletions!("per"))?.some((item) => item.value === "personal"));
      assert.ok((await command.getArgumentCompletions!("personal --g"))?.some((item) => item.value === "personal --global"));
    });
    await t.test("picker cancellation does not change config", async () => {
      const before = git("config", "--list");
      selections.push(undefined);
      await invoke("");
      assert.equal(git("config", "--list"), before);
    });
    await t.test("repository menu applies profile and both commit identities", async () => {
      selections.push("Set repository identity", "personal — Personal User <personal@example.test>");
      assert.equal((await invoke(""))?.type, "info");
      assert.equal(git("config", "--local", "user.email"), data.personal.email);
      assert.equal(git("config", "--global", "user.email"), "default@example.test");
      git("commit", "--allow-empty", "-qm", "personal test");
      assert.equal(git("show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"), "Personal User <personal@example.test>|Personal User <personal@example.test>");
    });
    await t.test("explicit use and local reset preserve global identity", async () => {
      assert.equal((await invoke("work"))?.type, "info");
      assert.equal(git("config", "--local", "user.email"), data.work.email);
      assert.equal((await invoke("reset"))?.type, "info");
      assert.equal(git("config", "user.email"), "default@example.test");
      assert.throws(() => git("config", "--local", "--get", "user.email"));
    });
    await t.test("global use and reset are explicit and scoped", async () => {
      assert.equal((await invoke("personal --global"))?.type, "info");
      assert.equal(git("config", "--global", "user.email"), data.personal.email);
      git("config", "--local", "user.name", "Local User");
      git("config", "--local", "user.email", "local@example.test");
      assert.equal((await invoke("reset --global"))?.type, "info");
      assert.throws(() => git("config", "--global", "--get", "user.email"));
      assert.equal(git("config", "--local", "user.email"), "local@example.test");
      assert.equal((await invoke("reset --global"))?.type, "info");
    });
    await t.test("invalid arguments and unsafe upstream values do not mutate config", async () => {
      const before = git("config", "--list");
      for (const args of ["missing", "unsafe", "personal extra", "--system", "personal --global --global"]) {
        assert.equal((await invoke(args))?.type, "error", args);
        assert.equal(git("config", "--list"), before);
      }
      assert.equal(existsSync(join(root, "should-not-exist")), false);
    });
    await t.test("upstream swallowed config failures are reported", async () => {
      const lock = join(root, ".git", "config.lock");
      writeFileSync(lock, "locked");
      try {
        assert.equal((await invoke("personal"))?.type, "error");
        assert.equal(git("config", "--local", "user.email"), "local@example.test");
      } finally { rmSync(lock); }
    });
    await t.test("no repository cannot silently fall back to global config", async () => {
      ctx.cwd = tmpdir();
      assert.equal((await invoke("work"))?.type, "error");
      assert.equal((await invoke("reset"))?.type, "error");
      ctx.cwd = root;
    });
    assert.equal(readFileSync(store, "utf8"), snapshot);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(root, { recursive: true, force: true });
  }
});
