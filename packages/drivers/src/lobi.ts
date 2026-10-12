import { ExecaError } from "execa";
import { raceWithSignalAndTimeout } from "./protocol-operation.ts";
import {
  PROTOCOL_VERSION,
  type NewSessionResponse,
  type NewSessionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionConfigOptionRequest,
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import {
  startProtocolProcess,
  runBoundedCommand,
  closeProtocolProcess,
} from "./process-command.ts";
import {
  AcpProbeError,
  ACP_PROBE_TOOLS,
  type ProbeCommand,
  type AcpExecutor,
  type AcpExecutionInput,
  type AcpExecutionResult,
  type AcpInspection,
} from "./acp-types.ts";
import { runAcpSession } from "./acp-session.ts";
import { createMcpBridge } from "./mcp-bridge.ts";

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
  const probeDirectory = await mkdtemp(
    join(tmpdir(), "harness-dock-lobi-probe-"),
  );
  const bridge = await createMcpBridge({
    tools: ACP_PROBE_TOOLS,
    signal,
    invocation: {
      signal,
      onToolCall: async () => ({
        isError: true,
        content: { code: "PROBE_DATA_ONLY" },
      }),
    },
  });
  const child = startProtocolProcess(
    executable,
    [...LOBI_ACP_ARGS, "--cwd", probeDirectory],
    {
      cwd: probeDirectory,
      env,
    },
  );
  child.stderr.resume();
  const exitPromise = child.exited;
  const clientApp = createAcpClientApp({
    name: "harness-dock-runtime-daemon-probe",
  });
  const connection = clientApp.connect(
    ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  try {
    const initialized = await raceWithSignalAndTimeout(
      Promise.race([
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "harness-dock-runtime-daemon-probe",
            version: "0.1.0",
          },
        }),
        connection.closed.then(() => {
          throw new Error("Lobi CodeWiz ACP probe connection closed");
        }),
        exitPromise.then((code) => {
          throw new Error(`Lobi CodeWiz exited during ACP probe (${code})`);
        }),
      ]),
      { signal, label: "Lobi CodeWiz ACP initialize" },
    );
    const session = await raceWithSignalAndTimeout(
      Promise.race([
        connection.agent.request<NewSessionResponse, NewSessionRequest>(
          methods.agent.session.new,
          {
            cwd: probeDirectory,
            mcpServers: [bridge.descriptor],
          },
        ),
        connection.closed.then(() => {
          throw new Error("Lobi CodeWiz ACP probe connection closed");
        }),
        exitPromise.then((code) => {
          throw new Error(
            `Lobi CodeWiz exited during ACP session probe (${code})`,
          );
        }),
      ]),
      { signal, label: "Lobi CodeWiz ACP session" },
    );
    const modelOption = findConfigOption(
      session.configOptions,
      "model",
      "model",
    );
    if (modelOption?.type !== "select")
      throw new Error(
        "Lobi CodeWiz did not report a selectable model option during probe",
      );
    const mcpTools = await raceWithSignalAndTimeout(bridge.ready, {
      signal,
      timeoutMs: 3_000,
      label: "Lobi MCP tool discovery",
    }).then(
      () => true,
      () => false,
    );
    signal.throwIfAborted();
    return {
      protocolVersion: initialized.protocolVersion,
      loadSession: initialized.agentCapabilities?.loadSession === true,
      resumeSession:
        initialized.agentCapabilities?.sessionCapabilities?.resume !==
        undefined,
      models: [...new Set(optionValues(modelOption))],
      modes: [
        ...new Set(session.modes?.availableModes.map((mode) => mode.id) ?? []),
      ],
      mcpTools,
    };
  } finally {
    await closeProtocolProcess(child);
    await bridge.close();
    await rm(probeDirectory, { recursive: true, force: true });
  }
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

export class LobiAcpExecutor implements AcpExecutor {
  readonly key = "lobi";
  #mcpTools = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #modelAllowlist: string[];
  readonly #probeCommand: ProbeCommand;
  readonly #probeAcp: ProbeAcp;
  #availableModes: string[] = [];

  constructor(options: LobiAcpOptions) {
    this.#env = { ...options.env };
    this.#executable = options.executable;
    this.#modelAllowlist = [...new Set(options.modelAllowlist ?? [])];
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
    if (!acp.loadSession || !acp.resumeSession)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP does not support governed session resume",
      );
    if (acp.models.length === 0)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP reported an empty model catalog",
      );
    if (acp.modes.length === 0)
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP reported an empty mode catalog",
      );
    if (!acp.modes.includes("plan") || !acp.modes.includes("build"))
      throw new AcpProbeError(
        "protocol_error",
        "Lobi CodeWiz ACP must report plan and build modes",
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
    };
  }

  async execute<TDelivery = unknown>(
    input: AcpExecutionInput<TDelivery>,
  ): Promise<AcpExecutionResult> {
    const { cwd: workdir, signal, callbacks, skillDirectory } = input;
    if ((input.tools?.length ?? 0) > 0 && !this.#mcpTools)
      throw new Error("Lobi MCP tool transport has not been verified");
    const selectedMode = configuredMode(input.config, this.#availableModes);
    if (
      this.#modelAllowlist.length > 0 &&
      !this.#modelAllowlist.includes(input.model)
    )
      throw new Error(
        `Lobi model is outside the local allowlist: ${input.model}`,
      );
    return runAcpSession({
      provider: {
        source: "lobi-codewiz-acp",
        label: "Lobi CodeWiz",
        stopErrorPrefix: "lobi",
      },
      ...input,
      prepareCommand: () => {
        return {
          executable: this.#executable,
          args: [...LOBI_ACP_ARGS, "--cwd", workdir],
          env: {
            ...this.#env,
            ...(skillDirectory
              ? {
                  OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    skills: { paths: [skillDirectory] },
                  }),
                }
              : {}),
          },
        };
      },
      configure: async ({ agent, awaitAcp, sessionId, session, resumed }) => {
        if (!sessionId) throw new Error("Lobi CodeWiz returned no session id");
        const sessionModes =
          session.modes?.availableModes.map((mode) => mode.id) ?? [];
        if (!sessionModes.includes(selectedMode))
          throw new Error(
            `Lobi mode is unavailable in this session: ${selectedMode}`,
          );

        await awaitAcp(
          agent.request(methods.agent.session.setMode, {
            sessionId,
            modeId: selectedMode,
          }),
          "mode configuration",
        );
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
