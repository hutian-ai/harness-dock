import { ExecaError } from "execa";
import { probeAcpSession } from "./acp-probe.ts";
import {
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import {
  runBoundedCommand,
} from "./process-command.ts";
import {
  AcpProbeError,
  type ProbeCommand,
  type AcpExecutor,
  type AcpExecutionInput,
  type AcpExecutionResult,
  type AcpInspection,
} from "./acp-types.ts";
import { runAcpSession } from "./acp-session.ts";

const LOBI_ACP_ARGS = ["acp", "--scene", "work"] as const;
const MINIMUM_CODEWIZ_VERSION = [0, 1, 95] as const;

type AcpProbeResult = {
  protocolVersion: number;
  loadSession: boolean;
  resumeSession: boolean;
  models: string[];
  modes: string[];
  mcpTools?: boolean;
};
type ProbeAcp = (
  executable: string,
  signal: AbortSignal,
) => Promise<AcpProbeResult>;

export type LobiAcpOptions = {
  env: NodeJS.ProcessEnv;
  executable: string;
  modelAllowlist?: string[];
  /** Successful probe for the same locally selected installation/environment. */
  inspection?: AcpInspection;
  probeCommand?: ProbeCommand;
  probeAcp?: ProbeAcp;
};

function defaultProbeCommand(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): ReturnType<ProbeCommand> {
  return runBoundedCommand(executable, args, { signal, env });
}

async function defaultProbeAcp(
  executable: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<AcpProbeResult> {
  return probeAcpSession({ executable, signal, env, label: 'Lobi CodeWiz', args: cwd => [...LOBI_ACP_ARGS, '--cwd', cwd] }, ({ session }) => {
    const modelOption = findConfigOption(session.configOptions, 'model', 'model');
    if (modelOption?.type !== 'select') throw new Error('Lobi CodeWiz did not report a selectable model option during probe');
    return { models: [...new Set(optionValues(modelOption))], modes: [...new Set(session.modes?.availableModes.map(mode => mode.id) ?? [])] };
  });
}

function assertSupportedVersion(version: string): void {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (!match)
    throw new AcpProbeError(
      "unsupported_version",
      "Lobi CodeWiz returned an invalid version",
    );
  const actual = match.slice(1, 4).map(Number);
  for (const [index, minimum] of MINIMUM_CODEWIZ_VERSION.entries()) {
    if (actual[index]! > minimum) return;
    if (actual[index]! < minimum)
      throw new AcpProbeError(
        "unsupported_version",
        "Lobi CodeWiz version is unsupported; expected 0.1.95 or newer",
      );
  }
}

function optionValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "options" in entry
      ? entry.options.map((value) => value.value)
      : [entry.value],
  );
}

function findConfigOption(
  options: SessionConfigOption[] | null | undefined,
  category: string,
  fallbackId: string,
): SessionConfigOption | undefined {
  return (
    options?.find((option) => option.category === category) ??
    options?.find((option) => option.id === fallbackId)
  );
}

function configuredMode(
  config: Record<string, unknown>,
  modes: readonly string[],
): string {
  const unsupportedKey = Object.keys(config).find((key) => key !== "mode");
  if (unsupportedKey)
    throw new Error(`Lobi config key is unavailable: ${unsupportedKey}`);
  const value = config.mode;
  const mode =
    typeof value === "string" && value.trim() ? value.trim() : "build";
  if (!modes.includes(mode))
    throw new Error(`Lobi mode is unavailable: ${mode}`);
  return mode;
}

function additiveSkillConfig(existing: string | undefined, skillDirectory: string): string {
  let parsed: unknown;
  try { parsed = existing === undefined ? {} : JSON.parse(existing); }
  catch { throw new Error("Lobi native inline config is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Lobi native inline config must be an object");
  const config = parsed as Record<string, unknown>;
  const rawSkills = config.skills;
  if (rawSkills !== undefined && (!rawSkills || typeof rawSkills !== "object" || Array.isArray(rawSkills)))
    throw new Error("Lobi native inline skill config must be an object");
  const skills = (rawSkills ?? {}) as Record<string, unknown>;
  const paths = skills.paths ?? [];
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string"))
    throw new Error("Lobi native inline skill paths must be a string array");
  return JSON.stringify({ ...config, skills: { ...skills, paths: [...new Set([...paths, skillDirectory])] } });
}

export class LobiAcpExecutor implements AcpExecutor {
  readonly key = "lobi";
  #mcpTools = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #modelAllowlist: string[];
  readonly #probeCommand: ProbeCommand;
  readonly #probeAcp: ProbeAcp;
  #availableModes: string[] = [];
  #canResume = false;

  constructor(options: LobiAcpOptions) {
    this.#env = { ...options.env };
    this.#executable = options.executable;
    this.#modelAllowlist = [...new Set(options.modelAllowlist ?? [])];
    if (options.inspection) {
      this.#mcpTools = options.inspection.mcpTools === true;
      this.#canResume = options.inspection.loadSession || options.inspection.resumeSession;
      this.#availableModes = [...options.inspection.modes];
    }
    this.#probeCommand =
      options.probeCommand ??
      ((executable, args, signal) =>
        defaultProbeCommand(executable, args, signal, this.#env));
    this.#probeAcp =
      options.probeAcp ??
      ((executable, signal) => defaultProbeAcp(executable, signal, this.#env));
  }

  async probe(signal = new AbortController().signal): Promise<AcpInspection> {
    const versionResult = await this.#probeCommand(
      this.#executable,
      ["--version"],
      signal,
    );
    if (versionResult.exitCode !== 0)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz version probe failed",
      );
    const acpResult = await this.#probeCommand(
      this.#executable,
      ["acp", "--help"],
      signal,
    );
    if (acpResult.exitCode !== 0)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP command is unavailable",
      );
    const version = versionResult.stdout.trim() || versionResult.stderr.trim();
    if (!version)
      throw new AcpProbeError("protocol_error", "Lobi returned no version");
    assertSupportedVersion(version);
    let acp: AcpProbeResult;
    try {
      acp = await this.#probeAcp(this.#executable, signal);
    } catch (error) {
      if (error instanceof ExecaError || error instanceof DOMException)
        throw error;
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP initialize failed",
        error,
      );
    }
    if (acp.protocolVersion !== PROTOCOL_VERSION)
      throw new AcpProbeError(
        "unsupported_version",
        "Lobi CodeWiz ACP protocol is unsupported",
      );
    if (acp.models.length === 0)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP reported an empty model catalog",
      );
    const unavailableModels = this.#modelAllowlist.filter(
      (model) => !acp.models.includes(model),
    );
    if (unavailableModels.length > 0)
      throw new AcpProbeError(
        "protocol_error",
        `Lobi model allowlist is unavailable: ${unavailableModels.join(", ")}`,
      );
    const models =
      this.#modelAllowlist.length > 0 ? this.#modelAllowlist : acp.models;
    this.#availableModes = [...acp.modes];
    this.#canResume = acp.loadSession || acp.resumeSession;
    this.#mcpTools = acp.mcpTools === true;
    return {
      version: version.slice(0, 120),
      protocolVersion: acp.protocolVersion,
      models: [...models],
      modes: [...acp.modes],
      loadSession: acp.loadSession,
      resumeSession: acp.resumeSession,
      mcpTools: this.#mcpTools,
      reasoningEffortsByModel: {},
      permissionPresets: [],
      permissionInteractions: ["options", "form", "url"],
      callerSkills: true,
    };
  }

  async execute<TDelivery = unknown>(
    input: AcpExecutionInput<TDelivery>,
  ): Promise<AcpExecutionResult> {
    const { cwd: workdir, signal, callbacks, skillDirectory } = input;
    if ((input.tools?.length ?? 0) > 0 && !this.#mcpTools)
      throw new Error("Lobi MCP tool transport has not been verified");
    if (input.resumeSessionId && (!this.#canResume || input.allowSessionResume === false))
      throw new Error("Lobi Provider session resume is unavailable");
    const selectedMode = configuredMode(input.config, this.#availableModes);
    if (
      this.#modelAllowlist.length > 0 &&
      !this.#modelAllowlist.includes(input.model)
    )
      throw new Error(
        `Lobi model is outside the local allowlist: ${input.model}`,
      );
    const inlineSkillConfig = skillDirectory
      ? additiveSkillConfig(this.#env.OPENCODE_CONFIG_CONTENT, skillDirectory) : undefined;
    return runAcpSession({
      provider: {
        source: "lobi-codewiz-acp",
        label: "Lobi CodeWiz",
        stopErrorPrefix: "lobi",
      },
      ...input,
      allowSessionResume: input.allowSessionResume ?? true,
      prepareCommand: () => {
        return {
          executable: this.#executable,
          args: [...LOBI_ACP_ARGS, "--cwd", workdir],
          env: {
            ...this.#env,
            ...(inlineSkillConfig !== undefined ? { OPENCODE_CONFIG_CONTENT: inlineSkillConfig } : {}),
          },
        };
      },
      configure: async ({ setMode, setConfigOption, sessionId, session, resumed }) => {
        if (!sessionId) throw new Error("Lobi CodeWiz returned no session id");
        const sessionModes =
          session.modes?.availableModes.map((mode) => mode.id) ?? [];
        if (!sessionModes.includes(selectedMode))
          throw new Error(
            `Lobi mode is unavailable in this session: ${selectedMode}`,
          );

        await setMode(selectedMode);
        const modelOption = findConfigOption(
          session.configOptions,
          "model",
          "model",
        );
        if (modelOption?.type !== "select")
          throw new Error(
            "Lobi CodeWiz did not report a selectable model option",
          );
        if (!optionValues(modelOption).includes(input.model))
          throw new Error(`Lobi model is unavailable: ${input.model}`);
        if (modelOption.currentValue !== input.model) {
          const configured = await setConfigOption(modelOption.id, input.model);
          const accepted = findConfigOption(
            configured.configOptions,
            "model",
            "model",
          );
          if (
            accepted?.type !== "select" ||
            accepted.currentValue !== input.model ||
            !optionValues(accepted).includes(input.model)
          )
            throw new Error(
              `Lobi CodeWiz did not confirm model: ${input.model}`,
            );
        }
        await callbacks.onProgress({
          source: "lobi-codewiz-acp",
          sessionId,
          phase: resumed ? "session_resumed" : "session_started",
          mode: selectedMode,
        });
      },
    });
  }
}
