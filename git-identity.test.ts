import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  const inputs: Array<string | undefined> = [];
  const confirmations: boolean[] = [];
  let onInput: (() => void) | undefined;
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
      async input() {
        onInput?.();
        return inputs.shift();
      },
      async confirm() { return confirmations.shift() ?? false; },
    },
  } as unknown as ExtensionCommandContext;
  try {
    extension({ registerCommand(name, command) { commands.set(name, command); } } as ExtensionAPI);
    const command = commands.get("git-identity")!;
    const invoke = async (args: string) => {
      notices.length = 0;
      await command.handler(args, ctx);
      return notices.at(-1);
    };
    await t.test("loading and inspecting current config never creates a store", async () => {
      assert.deepEqual([...commands.keys()], ["git-identity"]);
      assert.equal(existsSync(join(root, ".gitidentities")), false);
      const current = await invoke("current");
      assert.match(current?.text ?? "", /Effective identity for the current directory:/);
      assert.match(current?.text ?? "", /name: \(not configured\)/);
      assert.match(current?.text ?? "", /email: \(not configured\)/);
      assert.match(current?.text ?? "", /No identity configured\./);
      assert.equal(existsSync(join(root, ".gitidentities")), false);
      assert.equal(existsSync(join(root, ".gitconfig")), false);
    });
    await t.test("adding the first profile outside a repository only creates the profile store", async () => {
      inputs.push("First User", "first@example.test");
      assert.equal((await invoke("add first"))?.type, "info");
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".gitidentities"), "utf8")), {
        first: { name: "First User", email: "first@example.test", signingKey: "" },
      });
      assert.equal(statSync(join(root, ".gitidentities")).mode & 0o777, 0o600);
      assert.equal(existsSync(join(root, ".gitconfig")), false);
      assert.equal(existsSync(join(root, ".git")), false);
    });
    git("init", "-q");
    git("config", "--global", "user.name", "Default User");
    git("config", "--global", "user.email", "default@example.test");
    const globalCurrent = await invoke("current");
    assert.match(globalCurrent?.text ?? "", /name: Default User \[global\] \(file:.*\.gitconfig\)/);
    assert.match(globalCurrent?.text ?? "", /email: default@example\.test \[global\] \(file:.*\.gitconfig\)/);
    assert.match(globalCurrent?.text ?? "", /\[global\] user\.name = Default User/);
    assert.match(globalCurrent?.text ?? "", /\[global\] user\.email = default@example\.test/);
    const store = join(root, ".gitidentities");
    const data = {
      personal: { name: "Personal User", email: "personal@example.test", signingKey: "" },
      work: { name: "Work User", email: "work@example.test", signingKey: "", note: "Preserve extra upstream fields" },
      unsafe: { name: "$(touch should-not-exist)", email: "unsafe@example.test", signingKey: "" },
    };
    writeFileSync(store, JSON.stringify(data));
    const snapshot = readFileSync(store, "utf8");
    await t.test("completions show profiles, actions and scope", async () => {
      assert.ok((await command.getArgumentCompletions!("per"))?.some((item) => item.value === "personal"));
      assert.ok((await command.getArgumentCompletions!("personal --g"))?.some((item) => item.value === "personal --global"));
      assert.ok((await command.getArgumentCompletions!("edit wo"))?.some((item) => item.value === "edit work"));
      assert.ok((await command.getArgumentCompletions!("re"))?.some((item) => item.value === "remove"));
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
      const localCurrent = await invoke("current");
      assert.match(localCurrent?.text ?? "", /name: Personal User \[repository\] \(file:\.git\/config\)/);
      assert.match(localCurrent?.text ?? "", /email: personal@example\.test \[repository\] \(file:\.git\/config\)/);
      assert.match(localCurrent?.text ?? "", /\[global\] user\.name = Default User/);
      assert.match(localCurrent?.text ?? "", /\[repository\] user\.name = Personal User/);
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
    const localBeforeManagement = readFileSync(join(root, ".git", "config"), "utf8");
    const globalBeforeManagement = readFileSync(join(root, ".gitconfig"), "utf8");
    await t.test("profile creation from the menu is compatible with the upstream CLI", async () => {
      selections.push("Add profile");
      inputs.push("client", "Client User", "client@example.test");
      assert.equal((await invoke(""))?.type, "info");
      const saved = JSON.parse(readFileSync(store, "utf8"));
      assert.deepEqual(saved.client, { name: "Client User", email: "client@example.test", signingKey: "" });
      assert.deepEqual(saved.work, data.work);
      assert.match(git("identity", "show", "client"), /client@example.test/);
    });
    await t.test("editing preserves signing and unknown fields; empty inputs keep current values", async () => {
      const before = JSON.parse(readFileSync(store, "utf8"));
      before.work.signingKey = "EXISTING-SIGNING-KEY";
      writeFileSync(store, JSON.stringify(before));
      selections.push("Edit profile", "work — Work User <work@example.test>");
      inputs.push("New Work User", "new-work@example.test");
      assert.equal((await invoke(""))?.type, "info");
      let saved = JSON.parse(readFileSync(store, "utf8"));
      assert.deepEqual(saved.work, { ...before.work, name: "New Work User", email: "new-work@example.test" });
      assert.deepEqual(saved.personal, data.personal);
      inputs.push("", "");
      assert.equal((await invoke("edit work"))?.type, "info");
      assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), saved);
    });
    await t.test("cancellation and invalid profile input preserve the store", async () => {
      const before = readFileSync(store, "utf8");
      selections.push(undefined);
      await invoke("edit");
      inputs.push("Cancelled User", undefined);
      await invoke("add cancelled");
      confirmations.push(false);
      await invoke("remove work");
      for (const args of ["add work", "edit missing", "remove missing", "add reset", "add ../path", "edit work --global"]) {
        assert.equal((await invoke(args))?.type, "error", args);
      }
      inputs.push("Invalid User", "invalid-email");
      assert.equal((await invoke("add invalid"))?.type, "error");
      inputs.push("$(touch injected)", "unsafe@example.test");
      assert.equal((await invoke("add shell"))?.type, "error");
      assert.equal(existsSync(join(root, "injected")), false);
      assert.equal(readFileSync(store, "utf8"), before);
    });
    await t.test("deletion only removes the selected profile", async () => {
      const before = JSON.parse(readFileSync(store, "utf8"));
      selections.push("Delete profile", "client — Client User <client@example.test>");
      confirmations.push(true);
      assert.equal((await invoke(""))?.type, "info");
      delete before.client;
      assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), before);
    });
    await t.test("profile lock failures cannot truncate the existing store", async () => {
      const before = readFileSync(store, "utf8");
      const lock = `${store}.lock`;
      writeFileSync(lock, "another writer");
      try {
        inputs.push("Locked User", "locked@example.test");
        assert.equal((await invoke("add locked"))?.type, "error");
        assert.equal(readFileSync(store, "utf8"), before);
        assert.equal(readFileSync(lock, "utf8"), "another writer");
      } finally { rmSync(lock); }
    });
    await t.test("concurrent changes to the selected profile are not overwritten", async () => {
      const changed = JSON.parse(readFileSync(store, "utf8"));
      changed.work.email = "concurrent@example.test";
      onInput = () => {
        writeFileSync(store, JSON.stringify(changed));
        onInput = undefined;
      };
      inputs.push("Replacement User", "replacement@example.test");
      assert.equal((await invoke("edit work"))?.type, "error");
      assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), changed);
    });
    await t.test("unrelated changes during editing are retained", async () => {
      const changed = JSON.parse(readFileSync(store, "utf8"));
      changed.another = { name: "Another User", email: "another@example.test" };
      onInput = () => {
        writeFileSync(store, JSON.stringify(changed));
        onInput = undefined;
      };
      inputs.push("Updated User", "updated@example.test");
      assert.equal((await invoke("edit work"))?.type, "info");
      const saved = JSON.parse(readFileSync(store, "utf8"));
      assert.deepEqual(saved.another, changed.another);
      assert.equal(saved.work.name, "Updated User");
    });
    await t.test("invalid JSON is reported without replacing the store", async () => {
      const before = readFileSync(store, "utf8");
      writeFileSync(store, "{invalid json");
      try {
        assert.equal((await invoke("add broken"))?.type, "error");
        assert.equal(readFileSync(store, "utf8"), "{invalid json");
      } finally { writeFileSync(store, before); }
    });
    await t.test("editing a symlinked profile store preserves the symlink", async () => {
      const target = join(root, "shared-profiles.json");
      renameSync(store, target);
      symlinkSync(target, store);
      try {
        inputs.push("", "new-personal@example.test");
        assert.equal((await invoke("edit personal"))?.type, "info");
        assert.equal(lstatSync(store).isSymbolicLink(), true);
        assert.equal(JSON.parse(readFileSync(target, "utf8")).personal.email, "new-personal@example.test");
      } finally {
        rmSync(store);
        renameSync(target, store);
      }
    });
    assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), localBeforeManagement);
    assert.equal(readFileSync(join(root, ".gitconfig"), "utf8"), globalBeforeManagement);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(root, { recursive: true, force: true });
  }
});
