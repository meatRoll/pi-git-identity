import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
type Scope = "local" | "global";
type Profile = { name: string; email: string; signingKey?: string };
const help = "/git-identity → menu\n/git-identity PROFILE [--global]\n/git-identity reset [--global]\n/git-identity list | current | help";

function profiles(): Record<string, Profile> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(homedir(), ".gitidentities"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No saved profiles. Save one first with: git identity add PROFILE");
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

async function run(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", args, { cwd, timeout: 15_000, maxBuffer: 128 * 1024 });
    return result.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
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
    if (positional.length > 1 || tokens.filter((token) => token === "--global").length > 1 ||
        positional.some((token) => token.startsWith("-"))) throw new Error(help);
    let action = positional[0];
    let selectedScope = scope;
    let id: string | undefined;
    if (!action) {
      if (tokens.length === 0) {
        const choices = ["Set repository identity", "Set global identity", "Clear repository identity", "Clear global identity", "Show current identity", "List saved profiles"];
        const chosen = await ctx.ui.select("Git identity", choices);
        if (!chosen) return;
        const index = choices.indexOf(chosen);
        if (index < 0) return;
        selectedScope = index === 1 || index === 3 ? "global" : "local";
        action = index < 2 ? "use" : index < 4 ? "reset" : index === 4 ? "current" : "list";
      } else {
        action = "use";
      }
      if (action === "use") {
        const saved = profiles();
        const ids = Object.keys(saved);
        if (!ids.length) throw new Error("No saved profiles. Use git identity add PROFILE first.");
        const labels = ids.map((key) => `${key} — ${saved[key].name} <${saved[key].email}>`);
        const choice = await ctx.ui.select(`Choose ${selectedScope} identity`, labels);
        if (!choice) return;
        id = ids[labels.indexOf(choice)];
        if (!id) return;
      }
    }
    let output: string;
    if (action === "help") {
      output = help;
    } else if (action === "list") {
      output = Object.entries(profiles()).map(([key, value]) => `${key} — ${value.name} <${value.email}>`).join("\n") || "No saved profiles.";
    } else if (action === "current") {
      // Git reads below do not create a profile store, unlike upstream current.
      try {
        const result = await exec("git", ["config", "--show-origin", "--get-regexp", "^user\\.(name|email)$"], { cwd: ctx.cwd, timeout: 15_000 });
        output = result.stdout.trim();
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
        output = "No identity configured.";
      }
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
    description: "Choose, clear or inspect Git identity (git-identity wrapper)",
    getArgumentCompletions(prefix) {
      let ids: string[] = [];
      try { ids = Object.keys(profiles()); } catch { /* Show actions even without a store. */ }
      const words = prefix.split(/\s+/);
      const last = words.pop() ?? "";
      const candidates = words.length ? ["--global"] : [...ids, "reset", "list", "current", "help", "--global"];
      return candidates.filter((value) => value.startsWith(last)).map((value) => ({
        value: [...words, value].join(" "), label: value,
      }));
    },
    handler: handle,
  });
}
