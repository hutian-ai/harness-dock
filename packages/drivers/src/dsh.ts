import { AcpSessionHost, type AcpInspection } from "./acp-session-host.ts";
import { createHash } from "node:crypto";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpRuntimeOptions,
} from "acpx/runtime";
import { createAgentRegistry } from "acpx/agent-registry";
import { AGENT_PROCESS_ENV_ALLOW } from "./agent-environment.ts";
import { AcpInitialization, type ImageInput } from "./acp-input.ts";
import type {
  NativePermissionDecision,
  NativePermissionRequest,
} from "./execution.ts";
import { type McpInvocation, type McpToolDefinition } from "./mcp-bridge.ts";
import { MAX_OBSERVATION_BYTES } from "./output-limits.ts";

export interface DshHostEnvironment {
  cwd: string;
  dshHome: string;
  dshBin: string;
  stateDir: string;
  environment?: NodeJS.ProcessEnv;
  skillDirectory?: string;
}
export type DshInspection = AcpInspection;
export interface DshEvidence {
  runId: string;
  sessionId?: string;
  state: "unknown" | "completed" | "failed" | "cancelled";
  messages: { id: string; text: string }[];
  stopReason?: string;
  error?: string;
}
export interface DshHostInput<TDelivery = unknown> {
  environment: DshHostEnvironment;
  runId: string;
  prompt: string;
  attachments?: ImageInput[];
  model?: string;
  effort?: string;
  resumeThreadId?: string;
  previousRunId?: string;
  retainSession: boolean;
  signal: AbortSignal;
  tools: {
    name: string;
    definitions: McpToolDefinition[];
    invocation: McpInvocation<TDelivery>;
  };
  onReady(sessionId: string): Promise<void>;
  onEvent(event: Record<string, unknown>): Promise<void>;
  permission?(
    request: NativePermissionRequest,
    signal: AbortSignal,
    responseSent: Promise<void>,
  ): Promise<NativePermissionDecision>;
}
type RuntimeEnvironment = DshHostEnvironment & {
  patchPath?: string;
  mcpServers?: AcpRuntimeOptions["mcpServers"];
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** The selected native installation owns configuration, credentials and policy. */
export function createDshRuntime(
  environment: RuntimeEnvironment,
  command?: string[],
  observers: Pick<AcpRuntimeOptions, "onAcpMessage"> = {},
) {
  const nativeCommand = [".js", ".mjs", ".cjs"].includes(
    extname(environment.dshBin),
  )
    ? [process.execPath, environment.dshBin]
    : [environment.dshBin];
  return createAcpRuntime({
    cwd: environment.cwd,
    sessionStore: createRuntimeStore({ stateDir: environment.stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: {
        dsh: command ?? [
          ...nativeCommand,
          "--profile",
          "acp",
          ...(environment.patchPath ? ["--patch", environment.patchPath] : []),
        ],
      },
    }),
    agentProcessEnvAllow: AGENT_PROCESS_ENV_ALLOW,
    agentProcessEnv: {
      ...environment.environment,
      DSH_HOME: environment.dshHome,
    },
    mcpServers: environment.mcpServers,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    fs: false,
    terminal: false,
    timeoutMs: 30_000,
    ...observers,
  });
}

/** Add a separate named skill provider; never replace the user's existing roots. */
export async function prepareDshEnvironment(
  environment: DshHostEnvironment,
): Promise<RuntimeEnvironment> {
  for (const path of [
    environment.cwd,
    environment.dshHome,
    environment.dshBin,
    environment.stateDir,
  ])
    if (!isAbsolute(path)) throw new Error("dsh_paths_must_be_absolute");
  const rel = relative(environment.dshHome, environment.stateDir);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error("dsh_state_must_be_separate");
  if (!(await stat(environment.dshHome)).isDirectory())
    throw new Error("dsh_home_unavailable");
  if (!(await stat(environment.cwd)).isDirectory())
    throw new Error("dsh_workspace_unavailable");
  await access(environment.dshBin, 1);
  if (!environment.skillDirectory) return environment;
  if (
    !isAbsolute(environment.skillDirectory) ||
    !(await stat(environment.skillDirectory)).isDirectory()
  )
    throw new Error("dsh_skill_root_unavailable");
  await mkdir(environment.stateDir, { recursive: true, mode: 0o700 });
  const patchPath = join(
    environment.stateDir,
    `caller-skills-${hash(environment.skillDirectory)}.json`,
  );
  // JSON is YAML-compatible. insert keeps native configuration and its providers intact.
  const overlay = [
    {
      insert: [
        {
          id: "harness-dock-caller-skills",
          name: "@deepseek-ai/dsh-skill-filesystem",
          config: {
            providerName: "harness-dock-caller",
            includeDefaultRoots: false,
            customSkillDirs: [environment.skillDirectory],
          },
        },
      ],
    },
  ];
  await writeFile(patchPath, JSON.stringify(overlay), { mode: 0o600 });
  return { ...environment, patchPath };
}

function choices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = object(item);
    return typeof row.value === "string" ? [row.value] : choices(row.options);
  });
}
function inspection(
  configOptions: unknown,
  initialization: AcpInitialization,
): DshInspection {
  if (
    initialization.result.protocolVersion !== 1 ||
    object(initialization.result.agentInfo).name !== "deepseek-harness-acp"
  )
    throw new Error("dsh_acp_initialization_invalid");
  if (
    !Array.isArray(configOptions) ||
    Buffer.byteLength(JSON.stringify(configOptions), "utf8") >
      MAX_OBSERVATION_BYTES
  )
    throw new Error("dsh_inspection_invalid");
  const options = configOptions.map(object);
  const model = options.find((option) => option.id === "model");
  if (
    !model ||
    model.type !== "select" ||
    typeof model.currentValue !== "string"
  )
    throw new Error("dsh_inspection_invalid");
  const efforts = choices(
    options.find((option) => option.id === "reasoning_effort")?.options,
  );
  const capabilities = object(initialization.result.agentCapabilities);
  const resume = object(capabilities.sessionCapabilities).resume;
  const models = choices(model.options);
  if (
    !models.includes(model.currentValue) ||
    models.length > 256 ||
    models.some(
      (id) => !id.trim() || id.length > 500 || /[\u0000-\u001f]/u.test(id),
    )
  )
    throw new Error("dsh_inspection_invalid");
  return {
    configOptions,
    promptCapabilities: initialization.promptCapabilities,
    currentModelId: model.currentValue,
    sessionResume:
      resume !== null && typeof resume === "object" && !Array.isArray(resume),
    mcpCapabilities: {
      http: object(capabilities.mcpCapabilities).http === true,
    },
    // Effort choices are exact-model dependent; only the selected route owns this list.
    models: [...new Set(models)].map((id) => ({
      id,
      efforts: id === model.currentValue ? efforts : [],
    })),
  };
}

/** Native dsh dialect of the shared ACP session lifecycle. */
export class DshHost<TDelivery = unknown> extends AcpSessionHost<
  RuntimeEnvironment,
  TDelivery
> {
  constructor(runtimeFactory = createDshRuntime) {
    super({
      agent: "dsh",
      prepare: prepareDshEnvironment,
      runtime: runtimeFactory,
      inspect: inspection,
    });
  }
}
