import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
type Scope = "local" | "global";
type Profile = { name: string; email: string; signingKey?: string; [key: string]: unknown };
type ProfileAction = "add" | "edit" | "remove";
type IdentityKey = "user.name" | "user.email";
type IdentityEntry = { scope: string; origin: string; key: IdentityKey; value: string };
const identityKeys: IdentityKey[] = ["user.name", "user.email"];
const profileActions: ProfileAction[] = ["add", "edit", "remove"];
const help = "/git-identity → menu\n/git-identity PROFILE [--global]\n/git-identity reset [--global]\n/git-identity add | edit | remove [PROFILE]\n/git-identity list | current | help";

function profiles(allowMissing = false): Record<string, Profile> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(homedir(), ".gitidentities"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowMissing) return {};
      throw new Error("No saved profiles. Create one with /git-identity add.");
    }
    throw new Error("Unable to read ~/.gitidentities; check its JSON format.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("~/.gitidentities must contain an object of saved profiles.");
  }
  for (const value of Object.values(data)) {
    if (!value || typeof value.name !== "string" || typeof value.email !== "string" ||
        (value.signingKey !== undefined && typeof value.signingKey !== "string")) {
      throw new Error("Each saved profile must contain a name and email, and an optional string signingKey.");
    }
  }
  return data as Record<string, Profile>;
}

function saveProfile(id: string, expected: Profile | undefined, next: Profile | undefined): void {
  let target = join(homedir(), ".gitidentities");
  try {
    target = realpathSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lockPath = `${target}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Profile store is locked by another operation. Try again after it finishes.");
    }
    throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const latest = profiles(true);
    const current = Object.hasOwn(latest, id) ? latest[id] : undefined;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("This profile changed while the dialog was open. Reopen the operation to review it.");
    }
    if (next) latest[id] = next;
    else delete latest[id];
    let mode = 0o600;
    try { mode = statSync(target).mode & 0o777; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(temporary, JSON.stringify(latest, null, 2) + "\n", { flag: "wx", mode });
    renameSync(temporary, target);
  } finally {
    closeSync(lock);
    rmSync(temporary, { force: true });
    rmSync(lockPath, { force: true });
  }
}

async function manageProfile(ctx: ExtensionCommandContext, action: ProfileAction, id?: string): Promise<string | undefined> {
  const saved = profiles(action === "add");
  if (action === "add") {
    const entered = id ?? await ctx.ui.input("Profile label", "e.g. personal or work");
    if (entered === undefined) return;
    id = entered.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
        [...profileActions, "reset", "list", "current", "help", "use"].includes(id)) {
      throw new Error("Use a short profile label containing letters, numbers, dots, underscores or hyphens, not a command action.");
    }
    if (Object.hasOwn(saved, id)) throw new Error(`Profile already exists: ${id}. Use edit instead.`);
  } else {
    if (!id) {
      const ids = Object.keys(saved);
      if (!ids.length) throw new Error("No saved profiles. Create one with /git-identity add.");
      const labels = ids.map((key) => `${key} — ${saved[key].name} <${saved[key].email}>`);
      const choice = await ctx.ui.select(`Choose profile to ${action}`, labels);
      if (!choice) return;
      id = ids[labels.indexOf(choice)];
      if (!id) return;
    }
    if (!Object.hasOwn(saved, id)) throw new Error(`Unknown profile: ${id}`);
  }
  const original = Object.hasOwn(saved, id) ? saved[id] : undefined;
  if (action === "remove") {
    const accepted = await ctx.ui.confirm(`Delete profile ${id}?`,
      `Remove the saved ${original!.name} <${original!.email}> entry? Applied Git settings will remain as they are.`);
    if (!accepted) return;
    saveProfile(id, original, undefined);
    return `Deleted saved profile: ${id}. Applied Git settings remain as they are.`;
  }
  const enteredName = await ctx.ui.input(`Commit name for ${id}`, original ? `${original.name} (leave empty to keep)` : "e.g. Example User");
  if (enteredName === undefined) return;
  const enteredEmail = await ctx.ui.input(`Commit email for ${id}`, original ? `${original.email} (leave empty to keep)` : "e.g. user@example.test");
  if (enteredEmail === undefined) return;
  const name = enteredName.trim() || original?.name || "";
  const email = enteredEmail.trim() || original?.email || "";
  if (!name || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
    throw new Error("Provide a commit name and an email address.");
  }
  if (/["`$\\\r\n\0]/.test(name + email)) {
    throw new Error("Name/email contain characters unsupported by git-identity's shell quoting.");
  }
  saveProfile(id, original, { ...(original ?? { signingKey: "" }), name, email });
  return `${action === "add" ? "Added" : "Updated"} saved profile: ${id} — ${name} <${email}>. Apply it separately to change Git settings.`;
}

async function run(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", args, { cwd, timeout: 15_000, maxBuffer: 128 * 1024 });
    return result.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string; code?: number };
    const wrapped = new Error(failure.stderr?.trim() || failure.message) as Error & { code?: number };
    wrapped.code = failure.code;
    throw wrapped;
  }
}

async function config(cwd: string, scope: Scope, key: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["config", `--${scope}`, "--get", key], { cwd, timeout: 15_000 });
    return result.stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw error;
  }
}

function configScopeLabel(scope: string): string {
  if (scope === "local") return "repository";
  if (scope === "global") return "global";
  if (scope === "system") return "system";
  if (scope === "worktree") return "worktree";
  if (scope === "command") return "command";
  return scope;
}

function parseIdentityLine(line: string): IdentityEntry | undefined {
  const [scope, origin, rest] = line.split("\t", 3);
  if (!scope || !origin || !rest) return undefined;
  const match = rest.match(/^(user\.(?:name|email))(?:\s(.*))?$/);
  if (!match || !identityKeys.includes(match[1] as IdentityKey)) return undefined;
  return { scope, origin, key: match[1] as IdentityKey, value: match[2] ?? "" };
}

async function configuredIdentity(cwd: string): Promise<IdentityEntry[]> {
  try {
    const output = await run(cwd, ["config", "--show-scope", "--show-origin", "--get-regexp", "^user\\.(name|email)$"]);
    return output.split("\n").map(parseIdentityLine).filter((entry): entry is IdentityEntry => entry !== undefined);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
}

async function effectiveIdentityEntry(cwd: string, key: IdentityKey): Promise<IdentityEntry | undefined> {
  try {
    const output = await run(cwd, ["config", "--show-scope", "--show-origin", "--get", key]);
    const [scope, origin, ...valueParts] = output.split("\t");
    if (!scope || !origin || !valueParts.length) return undefined;
    return { scope, origin, key, value: valueParts.join("\t") };
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw error;
  }
}

async function currentIdentity(cwd: string): Promise<string> {
  const entries = await configuredIdentity(cwd);
  const effective = await Promise.all(identityKeys.map((key) => effectiveIdentityEntry(cwd, key)));
  const lines = ["Effective identity for the current directory:"];
  for (const [index, key] of identityKeys.entries()) {
    const entry = effective[index];
    const label = key === "user.name" ? "name" : "email";
    lines.push(entry
      ? `  ${label}: ${entry.value} [${configScopeLabel(entry.scope)}] (${entry.origin})`
      : `  ${label}: (not configured)`);
  }
  if (!entries.length) return lines.concat("", "No identity configured.").join("\n");
  lines.push("", "Configured identity entries:");
  for (const entry of entries) {
    lines.push(`  [${configScopeLabel(entry.scope)}] ${entry.key} = ${entry.value} (${entry.origin})`);
  }
  return lines.join("\n");
}

async function repository(cwd: string): Promise<void> {
  try {
    await run(cwd, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error("Current directory is not a Git repository. Use --global for global settings.");
  }
}

async function apply(cwd: string, id: string, scope: Scope): Promise<string> {
  const saved = profiles();
  if (!Object.hasOwn(saved, id)) throw new Error(`Unknown profile: ${id}`);
  const profile = saved[id];
  // Upstream interpolates these values into double-quoted shell commands.
  // Reject shell syntax before invoking its CLI, even though our own call uses execFile.
  for (const value of [profile.name, profile.email, profile.signingKey ?? ""]) {
    if (/["`$\\\r\n\0]/.test(value)) {
      throw new Error("This profile contains characters unsupported by git-identity's shell quoting.");
    }
  }
  if (scope === "local") await repository(cwd);
  await run(cwd, ["identity", "use", id, ...(scope === "global" ? ["--global"] : [])]);
  // Upstream may report success after a failed git config; verify actual writes.
  if (await config(cwd, scope, "user.name") !== profile.name ||
      await config(cwd, scope, "user.email") !== profile.email) {
    throw new Error("git-identity did not apply the requested name and email. Inspect Git config before committing.");
  }
  return `Set ${scope} identity: ${id} — ${profile.name} <${profile.email}>`;
}

async function reset(cwd: string, scope: Scope): Promise<string> {
  if (scope === "local") {
    await repository(cwd);
    await run(cwd, ["identity", "reset"]);
  } else {
    // Upstream has no global reset. Only remove name and email at the requested scope.
    for (const key of ["user.name", "user.email"]) {
      try {
        await exec("git", ["config", "--global", "--unset-all", key], { cwd, timeout: 15_000 });
      } catch (error) {
        if ((error as { code?: number }).code !== 5) throw error;
      }
    }
  }
  for (const key of ["user.name", "user.email"]) {
    if (await config(cwd, scope, key) !== undefined) {
      throw new Error(`Could not fully clear ${scope} ${key}; check included Git configuration files.`);
    }
  }
  return `Cleared ${scope} name and email. Settings from other scopes may still apply.`;
}

async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) throw new Error("/git-identity requires interactive pi or an RPC client supporting extension UI.");
  try {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const scope: Scope = tokens.includes("--global") ? "global" : "local";
    const positional = tokens.filter((token) => token !== "--global");
    const managesProfile = profileActions.includes(positional[0] as ProfileAction);
    if (positional.length > (managesProfile ? 2 : 1) || tokens.filter((token) => token === "--global").length > 1 ||
        positional.some((token) => token.startsWith("-")) || (managesProfile && scope === "global")) throw new Error(help);
    let action = positional[0];
    let selectedScope = scope;
    let id: string | undefined = managesProfile ? positional[1] : undefined;
    if (!action) {
      if (tokens.length === 0) {
        const operations: { label: string; action: string; scope?: Scope }[] = [
          { label: "Set repository identity", action: "use", scope: "local" },
          { label: "Set global identity", action: "use", scope: "global" },
          { label: "Clear repository identity", action: "reset", scope: "local" },
          { label: "Clear global identity", action: "reset", scope: "global" },
          { label: "Show current identity", action: "current" },
          { label: "List saved profiles", action: "list" },
          { label: "Add profile", action: "add" },
          { label: "Edit profile", action: "edit" },
          { label: "Delete profile", action: "remove" },
        ];
        const chosen = await ctx.ui.select("Git identity", operations.map((item) => item.label));
        const operation = operations.find((item) => item.label === chosen);
        if (!operation) return;
        selectedScope = operation.scope ?? "local";
        action = operation.action;
      } else {
        action = "use";
      }
      if (action === "use") {
        const saved = profiles();
        const ids = Object.keys(saved);
        if (!ids.length) throw new Error("No saved profiles. Create one with /git-identity add.");
        const labels = ids.map((key) => `${key} — ${saved[key].name} <${saved[key].email}>`);
        const choice = await ctx.ui.select(`Choose ${selectedScope} identity`, labels);
        if (!choice) return;
        id = ids[labels.indexOf(choice)];
        if (!id) return;
      }
    }
    let output: string;
    if (profileActions.includes(action as ProfileAction)) {
      const result = await manageProfile(ctx, action as ProfileAction, id);
      if (!result) return;
      output = result;
    } else if (action === "help") {
      output = help;
    } else if (action === "list") {
      output = Object.entries(profiles(true)).map(([key, value]) => `${key} — ${value.name} <${value.email}>`).join("\n") || "No saved profiles.";
    } else if (action === "current") {
      output = await currentIdentity(ctx.cwd);
    } else if (action === "reset") {
      output = await reset(ctx.cwd, selectedScope);
    } else {
      output = await apply(ctx.cwd, id ?? action, selectedScope);
    }
    ctx.ui.notify(output, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-identity", {
    description: "Manage profiles and choose, clear or inspect Git identity (git-identity wrapper)",
    getArgumentCompletions(prefix) {
      let ids: string[] = [];
      try { ids = Object.keys(profiles()); } catch { /* Show actions even without a store. */ }
      const words = prefix.split(/\s+/);
      const last = words.pop() ?? "";
      let candidates = [...ids, ...profileActions, "reset", "list", "current", "help", "--global"];
      if (words.length) {
        if (["edit", "remove"].includes(words[0])) candidates = ids;
        else if (words[0] === "add") candidates = [];
        else candidates = ["--global"];
      }
      return candidates.filter((value) => value.startsWith(last)).map((value) => ({
        value: [...words, value].join(" "), label: value,
      }));
    },
    handler: handle,
  });
}
