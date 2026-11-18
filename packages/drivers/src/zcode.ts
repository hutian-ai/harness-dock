import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpRuntimeOptions,
} from "acpx/runtime";
import { createAgentRegistry } from "acpx/agent-registry";
import { AcpSessionHost, type AcpInspection } from "./acp-session-host.ts";
import { AGENT_PROCESS_ENV_ALLOW } from "./agent-environment.ts";
import type { AcpInitialization } from "./acp-input.ts";

export interface ZcodeHostEnvironment {
  cwd: string;
  stateDir: string;
  zcodeHome: string;
  zcodeBin: string;
  environment?: NodeJS.ProcessEnv;
  mcpServers?: AcpRuntimeOptions["mcpServers"];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const choices = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((row) =>
        typeof object(row).value === "string"
          ? [String(object(row).value)]
          : choices(object(row).options),
      )
    : [];
async function prepare(
  environment: ZcodeHostEnvironment,
): Promise<ZcodeHostEnvironment> {
  for (const path of [
    environment.cwd,
    environment.stateDir,
    environment.zcodeHome,
    environment.zcodeBin,
  ])
    if (!isAbsolute(path)) throw new Error("zcode_paths_must_be_absolute");
  const rel = relative(environment.zcodeHome, environment.stateDir);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error("zcode_state_must_be_separate");
  if (
    !(await stat(environment.cwd)).isDirectory() ||
    !(await stat(environment.zcodeBin)).isFile()
  )
    throw new Error("zcode_installation_unavailable");
  const config = join(environment.stateDir, "bridge-config", "zcode-acp");
  await mkdir(config, { recursive: true, mode: 0o700 });
  // Bridge-only preferences. No native settings/authentication files are rewritten.
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      session: { mode: "build", showCompletionStatus: false },
      quota: { autoResume: false },
      remote: { enabled: false },
    }),
    { mode: 0o600 },
  );
  return environment;
}
export function createZcodeRuntime(
  environment: ZcodeHostEnvironment,
  command?: string[],
  observers: Pick<AcpRuntimeOptions, "onAcpMessage"> = {},
) {
  const entry = join(
    dirname(createRequire(import.meta.url).resolve("zcode-acp-server")),
    "index.js",
  );
  return createAcpRuntime({
    cwd: environment.cwd,
    sessionStore: createRuntimeStore({ stateDir: environment.stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { zcode: command ?? [process.execPath, entry] },
    }),
    agentProcessEnvAllow: AGENT_PROCESS_ENV_ALLOW,
    agentProcessEnv: {
      ...environment.environment,
      ZCODE_BIN: environment.zcodeBin,
      ZCODE_HOME: environment.zcodeHome,
      ZCODE_ACP_RUNTIME: "node",
      XDG_CONFIG_HOME: join(environment.stateDir, "bridge-config"),
      ZCODE_ACP_MODE: "build",
      ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
      ZCODE_ACP_REMOTE: "0",
      ZCODE_ACP_SHOW_COMPLETION_STATUS: "0",
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
function inspect(
  value: unknown,
  initialization: AcpInitialization,
): AcpInspection {
  if (
    initialization.result.protocolVersion !== 1 ||
    object(initialization.result.agentInfo).name !== "zcode-acp-server" ||
    !Array.isArray(value)
  )
    throw new Error("zcode_acp_initialization_invalid");
  const configOptions = value
    .map(object)
    .map((option) =>
      option.id === "thought" ? { ...option, id: "reasoning_effort" } : option,
    );
  const model = configOptions.find((option) => option.id === "model");
  const models = choices(model?.options);
  if (
    !models.length ||
    models.length > 256 ||
    !models.includes(String(model?.currentValue))
  )
    throw new Error("zcode_models_unavailable");
  const capabilities = object(initialization.result.agentCapabilities);
  const catalog = object(object(model?._meta).zcode).modelCapabilities;
  const perModel = new Map<string, string[]>();
  if (Array.isArray(catalog)) {
    for (const entry of catalog.slice(0, 256)) {
      const row = object(entry);
      if (
        typeof row.id !== "string" ||
        !models.includes(row.id) ||
        !Array.isArray(row.efforts)
      )
        continue;
      perModel.set(
        row.id,
        [
          ...new Set(
            row.efforts.filter(
              (value): value is string =>
                typeof value === "string" &&
                value.length > 0 &&
                value.length <= 64,
            ),
          ),
        ].slice(0, 32),
      );
    }
  }
  return {
    configOptions,
    models: models.map((id) => ({
      id,
      efforts:
        perModel.get(id) ??
        (id === model?.currentValue
          ? choices(
              configOptions.find((option) => option.id === "reasoning_effort")
                ?.options,
            )
          : []),
    })),
    currentModelId: String(model?.currentValue),
    promptCapabilities: initialization.promptCapabilities,
    sessionResume: !!object(capabilities.sessionCapabilities).resume,
    mcpCapabilities: {
      http: object(capabilities.mcpCapabilities).http === true,
    },
  };
}
/** Version-pinned community ACP adapter; inference and credentials stay in the native device environment. */
export class ZcodeHost<TDelivery = unknown> extends AcpSessionHost<
  ZcodeHostEnvironment,
  TDelivery
> {
  constructor() {
    super({
      agent: "zcode",
      prepare,
      runtime: createZcodeRuntime,
      inspect,
      effortKey: "thought",
      finalMessage: "last-on-end-turn",
    });
  }
}
