import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

type Scope = "local" | "global";
type UiContext = Pick<ExtensionCommandContext, "cwd" | "ui">;

interface IdentityCommandResult {
  output: string;
  error?: string;
}

async function runGitIdentity(args: string[], cwd: string): Promise<IdentityCommandResult> {
  try {
    const result = await execFileAsync("git", ["identity", ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 1024 * 1024,
    });
    return {
      output: stripAnsi(result.stdout).trim(),
    };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    const details = [commandError.stderr, commandError.stdout, commandError.message]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(stripAnsi)
      .join("\n")
      .trim();
    return { output: "", error: details || "git identity command failed" };
  }
}

async function requireRepository(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function getProfiles(cwd: string): Promise<string[]> {
  const result = await runGitIdentity(["ls"], cwd);
  if (result.error) throw new Error(result.error);
  return result.output.split("\n").map((profile) => profile.trim()).filter(Boolean);
}

async function getProfileDetails(profile: string, cwd: string): Promise<string> {
  const result = await runGitIdentity(["show", profile], cwd);
  if (result.error) throw new Error(result.error);
  return result.output.replace(/\n+/g, " | ");
}

async function chooseProfile(ctx: UiContext): Promise<string | undefined> {
  const profiles = await getProfiles(ctx.cwd);
  if (profiles.length === 0) {
    throw new Error("No saved Git identities were found.");
  }

  const choice = await ctx.ui.select("Choose a Git identity", [...profiles, "Cancel"]);
  return choice && choice !== "Cancel" ? choice : undefined;
}

async function chooseScope(ctx: UiContext): Promise<Scope | undefined> {
  const choice = await ctx.ui.select("Apply the identity to", [
    "Current repository",
    "Global Git config",
    "Cancel",
  ]);
  if (choice === "Current repository") return "local";
  if (choice === "Global Git config") return "global";
  return undefined;
}

async function applyIdentity(profile: string, scope: Scope, cwd: string): Promise<string> {
  if (scope === "local") {
    const repository = await requireRepository(cwd);
    if (!repository) {
      throw new Error("The current directory is not inside a Git repository. Choose global scope instead.");
    }
  }

  const result = await runGitIdentity(
    ["use", profile, ...(scope === "global" ? ["--global"] : [])],
    cwd,
  );
  if (result.error) throw new Error(result.error);
  return result.output || `Identity set to ${profile}`;
}

async function resetLocalIdentity(cwd: string): Promise<string> {
  const repository = await requireRepository(cwd);
  if (!repository) {
    throw new Error("The current directory is not inside a Git repository.");
  }

  const result = await runGitIdentity(["reset"], cwd);
  if (result.error) throw new Error(result.error);
  return result.output || "Local Git identity reset";
}

async function listIdentities(cwd: string): Promise<string> {
  const profiles = await getProfiles(cwd);
  const details = await Promise.all(
    profiles.map(async (profile) => `${profile}: ${await getProfileDetails(profile, cwd)}`),
  );
  return details.join("\n");
}

async function showCurrentIdentity(cwd: string): Promise<string> {
  const local = await runGitIdentity(["current"], cwd);
  const global = await runGitIdentity(["current", "--global"], cwd);
  const lines = [];
  if (!local.error) lines.push(`Current scope: ${local.output}`);
  if (!global.error) lines.push(`Global scope: ${global.output}`);
  if (lines.length === 0) throw new Error(local.error || global.error || "Unable to read Git identity");
  return lines.join("\n");
}

function resultText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter(Boolean);
  const command = args[0];

  try {
    if (command === "list") {
      ctx.ui.notify(await listIdentities(ctx.cwd), "info");
      return;
    }
    if (command === "current") {
      ctx.ui.notify(await showCurrentIdentity(ctx.cwd), "info");
      return;
    }
    if (command === "reset") {
      ctx.ui.notify(await resetLocalIdentity(ctx.cwd), "info");
      return;
    }
    if (command === "help") {
      ctx.ui.notify(
        "Usage: /gitid [profile] [--global] | /gitid reset | /gitid list | /gitid current",
        "info",
      );
      return;
    }

    const global = args.includes("--global");
    const explicitProfile = args.find((arg) => arg !== "--global");
    const profile = explicitProfile || (await chooseProfile(ctx));
    if (!profile) return;

    const scope = global ? "global" : explicitProfile ? "local" : await chooseScope(ctx);
    if (!scope) return;

    const details = await applyIdentity(profile, scope, ctx.cwd);
    ctx.ui.notify(`${details}\nProfile: ${await getProfileDetails(profile, ctx.cwd)}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

const gitIdentityTool = defineTool({
  name: "git_identity",
  label: "Git identity",
  description:
    "Use saved git-identity profiles. This tool never auto-switches identities; choose an action explicitly. Local scope is the default for use.",
  parameters: Type.Object({
    action: StringEnum(["choose", "use", "reset", "list", "current"] as const, {
      description: "Explicit identity action",
    }),
    profile: Type.Optional(Type.String({ description: "Saved profile name, such as github or cmiot" })),
    scope: Type.Optional(
      StringEnum(["local", "global"] as const, {
        description: "Apply to the current repository or global Git config",
      }),
    ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      if (params.action === "list") return resultText(await listIdentities(ctx.cwd));
      if (params.action === "current") return resultText(await showCurrentIdentity(ctx.cwd));
      if (params.action === "reset") return resultText(await resetLocalIdentity(ctx.cwd));

      const profile = params.profile || (await chooseProfile(ctx));
      if (!profile) return resultText("Identity selection cancelled.");
      const scope = params.scope || (params.action === "choose" ? await chooseScope(ctx) : "local");
      if (!scope) return resultText("Identity selection cancelled.");
      return resultText(await applyIdentity(profile, scope, ctx.cwd));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerCommand("gitid", {
    description: "Choose or inspect a saved Git identity",
    handler: handleCommand,
  });
  pi.registerCommand("git-identity", {
    description: "Choose or inspect a saved Git identity",
    handler: handleCommand,
  });
  pi.registerTool(gitIdentityTool);
}
