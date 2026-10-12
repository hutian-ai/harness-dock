import { ExecaError } from "execa";
import { probeAcpSession } from "./acp-probe.ts";
import {
  PROTOCOL_VERSION,
  type SetSessionConfigOptionResponse,
  type SetSessionConfigOptionRequest,
  methods,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const DEEPSEEK_PERMISSION_PRESETS = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const DEEPSEEK_CONFIG_KEYS = ["reasoning_effort", "permission_preset"];
const SUPPORTED_DEEPSEEK_HARNESS_VERSION = "0.1.2-rc.1";
const SEMANTIC_VERSION_TOKEN =
  /(?<![0-9A-Za-z.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![0-9A-Za-z.-])/u;

type AcpProbeResult = {
  protocolVersion: number;
  models: string[];
  reasoningEffortsByModel: Record<string, string[]>;
  mcpTools?: boolean;
  loadSession?: boolean;
  resumeSession?: boolean;
};
type ProbeAcp = (
  executable: string,
  signal: AbortSignal,
) => Promise<AcpProbeResult>;

export type DeepSeekAcpOptions = {
  env: NodeJS.ProcessEnv;
  executable: string;
  models?: string[];
  permissionPreset?: "read-only" | "workspace-write" | "danger-full-access";
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

function deepSeekHarnessVersion(output: string): string | null {
  return output.match(SEMANTIC_VERSION_TOKEN)?.[1] ?? null;
}

async function defaultProbeAcp(
  executable: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<AcpProbeResult> {
  return probeAcpSession({ executable, signal, env, label: 'DeepSeek Harness', args: () => ['--profile', 'acp'] }, async ({ agent, session, awaitAcp }) => {
    let configOptions = session.configOptions;
    const models = optionValues(requireModelOption(configOptions));
    const reasoningEntries: Array<[string, string[]]> = [];
    for (const model of models) {
      const modelOption = requireModelOption(configOptions);
      if (modelOption.currentValue !== model) {
        const configured = await awaitAcp(agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId, configId: modelOption.id, value: model,
        }), 'model configuration');
        configOptions = configured.configOptions;
      }
      assertSelectedModel(configOptions, model);
      const reasoningOption = findConfigOption(configOptions, 'thought_level', 'reasoning_effort');
      reasoningEntries.push([model, reasoningOption ? optionValues(reasoningOption) : []]);
    }
    return { models, reasoningEffortsByModel: Object.fromEntries(reasoningEntries) };
  });
}

function configuredString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configuredSelect(
  config: Record<string, unknown>,
  key: string,
  values: readonly string[],
  fallback?: string,
): string | undefined {
  const value = configuredString(config, key) ?? fallback;
  if (value !== undefined && !values.includes(value))
    throw new Error(`DeepSeek Harness ${key} is unavailable: ${value}`);
  return value;
}

function assertSupportedConfigKeys(config: Record<string, unknown>): void {
  const unsupportedKey = Object.keys(config).find(
    (key) => !DEEPSEEK_CONFIG_KEYS.includes(key),
  );
  if (unsupportedKey)
    throw new Error(
      `DeepSeek Harness config key is unavailable: ${unsupportedKey}`,
    );
}

function boundedPermissionPresets(
  ceiling: DeepSeekAcpOptions["permissionPreset"],
): Array<"read-only" | "workspace-write" | "danger-full-access"> {
  const maximum = DEEPSEEK_PERMISSION_PRESETS.indexOf(
    ceiling ?? "workspace-write",
  );
  return DEEPSEEK_PERMISSION_PRESETS.slice(0, maximum + 1) as Array<
    "read-only" | "workspace-write" | "danger-full-access"
  >;
}

function optionValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const values = option.options.flatMap((entry) =>
    "options" in entry
      ? entry.options.map((value) => value.value)
      : [entry.value],
  );
  if (values.some((value) => !value.trim()))
    throw new Error(`DeepSeek Harness ${option.id} reported an invalid value`);
  return [...new Set(values)];
}

function requireModelOption(options: SessionConfigOption[] | null | undefined) {
  const option = findConfigOption(options, "model", "model");
  if (option?.type !== "select" || optionValues(option).length === 0)
    throw new Error(
      "DeepSeek Harness did not report a nonempty selectable model option",
    );
  return option;
}

function assertSelectedModel(
  options: SessionConfigOption[] | null | undefined,
  model: string,
) {
  const option = requireModelOption(options);
  if (!optionValues(option).includes(model) || option.currentValue !== model)
    throw new Error(`DeepSeek Harness did not confirm model: ${model}`);
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

export class DeepSeekAcpExecutor implements AcpExecutor {
  readonly key = "deepseek-harness";
  #mcpTools = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #models: string[];
  readonly #permissionPreset:
    "read-only" | "workspace-write" | "danger-full-access";
  readonly #probeCommand: ProbeCommand;
  readonly #probeAcp: ProbeAcp;

  constructor(options: DeepSeekAcpOptions) {
    this.#env = { ...options.env };
    this.#executable = options.executable;
    this.#models = [...new Set(options.models ?? [])];
    this.#permissionPreset = options.permissionPreset ?? "workspace-write";
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
        "DeepSeek Harness version probe failed",
      );
    const acpResult = await this.#probeCommand(
      this.#executable,
      ["--profile", "acp", "--help"],
      signal,
    );
    if (acpResult.exitCode !== 0)
      throw new AcpProbeError(
        "protocol_error",
        "DeepSeek Harness ACP command is unavailable",
      );
    const versionOutput =
      versionResult.stdout.trim() || versionResult.stderr.trim();
    const version = deepSeekHarnessVersion(versionOutput);
    if (!version)
      throw new AcpProbeError(
        "protocol_error",
        "DeepSeek Harness returned no valid version",
      );
    if (version !== SUPPORTED_DEEPSEEK_HARNESS_VERSION)
      throw new AcpProbeError(
        "unsupported_version",
        "DeepSeek Harness version is unsupported",
      );
    let acp: AcpProbeResult;
    try {
      acp = await this.#probeAcp(this.#executable, signal);
    } catch (error) {
      if (error instanceof ExecaError || error instanceof DOMException)
        throw error;
      throw new AcpProbeError(
        "protocol_error",
        "DeepSeek Harness ACP capability probe failed",
        error,
      );
    }
    if (acp.protocolVersion !== PROTOCOL_VERSION)
      throw new AcpProbeError(
        "unsupported_version",
        "DeepSeek Harness ACP protocol is unsupported",
      );
    if (acp.models.length === 0 || acp.models.some((model) => !model.trim()))
      throw new AcpProbeError(
        "protocol_error",
        "DeepSeek Harness ACP reported an empty or invalid model catalog",
      );
    const unavailableModels = this.#models.filter(
      (model) => !acp.models.includes(model),
    );
    if (unavailableModels.length > 0)
      throw new AcpProbeError(
        "protocol_error",
        `DeepSeek Harness model allowlist is unavailable: ${unavailableModels.join(", ")}`,
      );
    const models = this.#models.length > 0 ? this.#models : acp.models;
    const modelValues = Object.fromEntries(
      models.map((model) => [model, acp.reasoningEffortsByModel[model] ?? []]),
    );
    this.#mcpTools = acp.mcpTools === true;
    return {
      version,
      protocolVersion: acp.protocolVersion,
      models: [...models],
      modes: [],
      loadSession: acp.loadSession === true,
      resumeSession: acp.loadSession === true || acp.resumeSession === true,
      mcpTools: this.#mcpTools,
      reasoningEffortsByModel: modelValues,
      permissionPresets: boundedPermissionPresets(this.#permissionPreset),
    };
  }

  async execute<TDelivery = unknown>(
    input: AcpExecutionInput<TDelivery>,
  ): Promise<AcpExecutionResult> {
    const { cwd: workdir, signal, callbacks, skillDirectory } = input;
    if ((input.tools?.length ?? 0) > 0 && !this.#mcpTools)
      throw new Error("DeepSeek MCP tool transport has not been verified");
    assertSupportedConfigKeys(input.config);
    const reasoningEffort = configuredString(input.config, "reasoning_effort");
    if (this.#models.length > 0 && !this.#models.includes(input.model))
      throw new Error(
        `DeepSeek Harness model is outside the local allowlist: ${input.model}`,
      );
    const permissionPreset = configuredSelect(
      input.config,
      "permission_preset",
      boundedPermissionPresets(this.#permissionPreset),
      this.#permissionPreset,
    );
    let skillConfigDirectory: string | undefined;
    try {
      return await runAcpSession({
        provider: {
          source: "deepseek-harness-acp",
          label: "DeepSeek Harness",
          stopErrorPrefix: "deepseek_harness",
        },
        ...input,
        allowSessionResume: input.allowSessionResume ?? true,
        prepareCommand: async () => {
          const args = ["--profile", "acp"];
          if (skillDirectory) {
            skillConfigDirectory = await mkdtemp(
              join(tmpdir(), "harness-dock-dsh-skills-"),
            );
            const patch = join(skillConfigDirectory, "skills.json");
            await writeFile(
              patch,
              JSON.stringify([
                {
                  id: "skill-filesystem",
                  config: { customSkillDirs: [skillDirectory] },
                },
              ]),
              { mode: 0o600 },
            );
            args.push("--patch", patch);
          }
          return {
            executable: this.#executable,
            args,
            env: {
              ...this.#env,
              DSH_PERMISSION_MODE: permissionPreset!,
            },
          };
        },
        configure: async ({ agent, awaitAcp, sessionId, session, resumed }) => {
          let configOptions = session.configOptions;
          await callbacks.onProgress({
            source: "deepseek-harness-acp",
            sessionId,
            phase: resumed ? "session_resumed" : "session_started",
          });

          const modelOption = requireModelOption(configOptions);
          if (!optionValues(modelOption).includes(input.model))
            throw new Error(
              `DeepSeek Harness model is unavailable: ${input.model}`,
            );
          if (modelOption.currentValue !== input.model) {
            const configured = await awaitAcp(
              agent.request<
                SetSessionConfigOptionResponse,
                SetSessionConfigOptionRequest
              >(methods.agent.session.setConfigOption, {
                sessionId,
                configId: modelOption.id,
                value: input.model,
              }),
              "model configuration",
            );
            configOptions = configured.configOptions;
          }
          assertSelectedModel(configOptions, input.model);
          const reasoningOption = findConfigOption(
            configOptions,
            "thought_level",
            "reasoning_effort",
          );
          if (reasoningEffort) {
            if (
              reasoningOption?.type !== "select" ||
              !optionValues(reasoningOption).includes(reasoningEffort)
            )
              throw new Error(
                `DeepSeek Harness reasoning effort is unavailable: ${reasoningEffort}`,
              );
            if (reasoningOption.currentValue !== reasoningEffort) {
              const configured = await awaitAcp(
                agent.request<
                  SetSessionConfigOptionResponse,
                  SetSessionConfigOptionRequest
                >(methods.agent.session.setConfigOption, {
                  sessionId,
                  configId: reasoningOption.id,
                  value: reasoningEffort,
                }),
                "reasoning configuration",
              );
              const accepted = findConfigOption(
                configured.configOptions,
                "thought_level",
                "reasoning_effort",
              );
              assertSelectedModel(configured.configOptions, input.model);
              if (
                accepted?.type !== "select" ||
                accepted.currentValue !== reasoningEffort
              )
                throw new Error(
                  `DeepSeek Harness did not confirm reasoning effort: ${reasoningEffort}`,
                );
            }
          }
        },
      });
    } finally {
      if (skillConfigDirectory)
        await rm(skillConfigDirectory, { recursive: true, force: true });
    }
  }
}
