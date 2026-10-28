import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeepSeekAcpExecutor } from "../packages/drivers/src/deepseek.ts";
import type { AcpExecutor, AcpPermissionRequest } from "../packages/drivers/src/acp-types.ts";

type DriverKey = "deepseek-harness";
type Scenario =
  | "spawn_failed"
  | "setup_cancel"
  | "slow_setup"
  | "unconfirmed"
  | "cancelled"
  | "completed"
  | "disconnected"
  | "refusal"
  | "unrequested_cancel"
  | "cache_usage"
  | "permission"
  | "permission_default"
  | "permission_error"
  | "permission_once"
  | "permission_exact"
  | "permission_exact_always"
  | "permission_unknown_option"
  | "permission_ambiguous"
  | "elicitation_form"
  | "elicitation_url"
  | "permission_after_cancel"
  | "permission_callback_cancel";

async function runScenario(key: DriverKey, scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "dock-driver-safety-"));
  const executable = join(directory, "provider");
  const logPath = join(directory, "observations.jsonl");
  await writeFile(logPath, "");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (value) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + "\\n");
const key = ${JSON.stringify(key)};
const scenario = ${JSON.stringify(scenario)};
record({controlVariables: Object.keys(process.env).filter(key => key.startsWith("APP_CONTROL_"))});
let promptId;
const exactOptions = [{optionId:"write-once-a",name:"Write for this request",kind:"allow_once"},{optionId:"write-once-b",name:"Allow alternate action",kind:"allow_once"},{optionId:"reject-exact",name:"Reject this request",kind:"reject_once"},{optionId:"persist-explicit",name:"Allow remembered",kind:"allow_always"}];
const requestPermission = () => send({jsonrpc:"2.0",id:900,method:"session/request_permission",params:{sessionId:"session-1",toolCall:{toolCallId:"tool-1",title:"Write",kind:"edit",status:"pending"},options:scenario === "permission"?[{optionId:"always",name:"Always allow",kind:"allow_always"}]:["permission_exact","permission_exact_always","permission_unknown_option","permission_ambiguous"].includes(scenario)?exactOptions:[{optionId:"once",name:"Allow once",kind:"allow_once"}]}});
const finish = (cancelled) => {
  send({jsonrpc:"2.0",id:promptId,result:{stopReason:cancelled?"cancelled":"end_turn",...(scenario==="cache_usage"?{usage:{totalTokens:12,inputTokens:7,outputTokens:5,cachedReadTokens:2,cachedWriteTokens:3}}:{})}});
};
const lines = readline.createInterface({input:process.stdin});
lines.on("line", line => {
 const request=JSON.parse(line);
 if(request.method) record({method:request.method});
 if(scenario === "setup_cancel") return;
 const reply = result => send({jsonrpc:"2.0",id:request.id,result});
 if(request.method === "initialize") {record({clientCapabilities:request.params.clientCapabilities});const respond=()=>reply({protocolVersion:1,agentCapabilities:{loadSession:true},userAgent:"fake"});if(scenario==="slow_setup")setTimeout(respond,8000);else respond();}
 if(request.method === "session/new") {const respond=()=>reply({sessionId:"session-1",configOptions:[{id:"model",name:"Model",category:"model",type:"select",currentValue:"test-model",options:[{value:"test-model",name:"Test"}]}],modes:{availableModes:[{id:"build",name:"Build"}]}});if(scenario==="slow_setup")setTimeout(respond,8000);else respond();}
 if(request.method === "session/set_mode") reply({});
 if(request.method === "session/prompt") {
  promptId = request.id;
  if(scenario === "disconnected") return process.exit(3);
  if(scenario === "refusal") return reply({stopReason:"refusal"});
  if(scenario === "unrequested_cancel") return reply({stopReason:"cancelled"});
  if(scenario === "cache_usage") return finish(false);
  if(scenario === "slow_setup") return finish(false);
  if(scenario.startsWith("elicitation_")) send({jsonrpc:"2.0",id:900,method:"elicitation/create",params:{sessionId:"session-1",message:"Native question",...(scenario==="elicitation_form"?{mode:"form",requestedSchema:{type:"object",properties:{answer:{type:"string",enum:["left","right"]}},required:["answer"]}}:{mode:"url",url:"https://example.test/authorize",elicitationId:"native-auth"})}});
  else if(["permission", "permission_default", "permission_error", "permission_once", "permission_callback_cancel", "permission_exact", "permission_exact_always", "permission_unknown_option", "permission_ambiguous"].includes(scenario)) requestPermission();
  else send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"session-1",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"test-active"}}}});
 }
 if(request.method === "session/cancel") {
  if(scenario === "permission_after_cancel") requestPermission();
  else if(scenario !== "unconfirmed" && scenario !== "permission_callback_cancel") setTimeout(()=>finish(scenario === "cancelled"),25);
 }
 if(request.id === 900 && request.result) {record({permissionResult:request.result});finish(false)}
});
lines.on("close",()=>process.exit(0));
`,
  );
  await chmod(executable, 0o755);
  const command =
    scenario === "spawn_failed"
      ? join(directory, "missing-provider")
      : executable;
  const driver: AcpExecutor = new DeepSeekAcpExecutor({
    env: process.env, executable: command, models: ["test-model"],
  });
  const controller = new AbortController();
  let abortedAt: number | undefined;
  controller.signal.addEventListener(
    "abort",
    () => (abortedAt = performance.now()),
    {
      once: true,
    },
  );
  const previousToken = process.env.APP_CONTROL_RUNTIME_CONNECTION_TOKEN;
  const previousDatabase = process.env.APP_CONTROL_DATABASE_URL;
  process.env.APP_CONTROL_RUNTIME_CONNECTION_TOKEN = "test-only-control-token";
  process.env.APP_CONTROL_DATABASE_URL = "test-only-database-token";
  let cancelTimer: NodeJS.Timeout | undefined;
  let permissionProgressCount = 0;
  let starts = 0;
  const permissionDeliveries: Promise<boolean>[] = [];
  const permissionRequests: AcpPermissionRequest[] = [];
  try {
    const result = await driver.execute({
      runId: "018f47f2-4f15-7c86-a8d9-9e38115d9030",
      allowSessionResume: true,
      model: "test-model",
      config: {},
      prompt: "test",
      cwd: directory,
      signal: controller.signal,
      callbacks: {
        permission:
          scenario === "permission_default"
            ? undefined
            : async (request, _signal, responseSent) => {
                permissionRequests.push(request);
                permissionDeliveries.push(responseSent.then(() => true, () => false));
                if (scenario === "permission_error")
                  throw new Error("permission unavailable");
                if (scenario === "permission_exact") return { optionId: "reject-exact" };
                if (scenario === "permission_exact_always") return { optionId: "persist-explicit" };
                if (scenario === "permission_unknown_option") return { optionId: "not-offered" };
                if (scenario === "elicitation_form") return { action: "accept", content: { answer: "right" } };
                if (scenario === "elicitation_url") return { action: "decline" };
                return "allow";
              },
        onStarted: async () => {
          starts += 1;
          if (scenario === "setup_cancel")
            cancelTimer = setTimeout(
              () => controller.abort("cancel_requested"),
              25,
            );
        },
        onProgress: async (payload) => {
          if (payload.permission) {
            permissionProgressCount += 1;
            if (scenario === "permission_callback_cancel") {
              await new Promise<void>((resolve) => {
                queueMicrotask(() => {
                  controller.abort("daemon_shutdown");
                  resolve();
                });
              });
            }
          }
          const active =
            (payload.update as { sessionUpdate?: string } | undefined)
              ?.sessionUpdate === "agent_message_chunk";
          if (active && !cancelTimer)
            cancelTimer = setTimeout(
              () => controller.abort("cancel_requested"),
              15,
            );
        },
      },
    });
    const observations = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      result,
      observations,
      permissionProgressCount,
      permissionRequests,
      permissionDeliveries: await Promise.all(permissionDeliveries),
      starts,
      abortToFinishMs:
        abortedAt === undefined ? undefined : performance.now() - abortedAt,
    };
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (previousToken === undefined)
      delete process.env.APP_CONTROL_RUNTIME_CONNECTION_TOKEN;
    else process.env.APP_CONTROL_RUNTIME_CONNECTION_TOKEN = previousToken;
    if (previousDatabase === undefined)
      delete process.env.APP_CONTROL_DATABASE_URL;
    else process.env.APP_CONTROL_DATABASE_URL = previousDatabase;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const key of ["deepseek-harness"] as const) {
  test("ACP initialization and session creation retain independent 15-second budgets", { timeout: 25_000 }, async () => {
    const { result, observations } = await runScenario(key, "slow_setup");
    assert.equal(result.state, "completed");
    assert.equal(observations.filter(entry => entry.method === "session/new").length, 1);
    assert.equal(observations.filter(entry => entry.method === "session/prompt").length, 1);
  });
  test(`${key} turns a spawn failure into one failed terminal`, async () => {
    const { result, starts } = await runScenario(key, "spawn_failed");
    assert.equal(starts, 1);
    assert.equal(result.state, "failed");
    assert.equal(
      result.errorCode,
      {
        "deepseek-harness": "deepseek_harness_acp_start_failed",
      }[key],
    );
  });
  test(`${key} accepts Provider cancellation confirmation and excludes control credentials`, async () => {
    const { result, observations } = await runScenario(key, "cancelled");
    assert.equal(result.state, "cancelled");
    assert.deepEqual(observations[0]?.controlVariables, []);
  });
  for (const scenario of ["permission_exact", "permission_exact_always", "permission_unknown_option", "permission_ambiguous"] as const) {
    test(`${key} preserves exact native permission choices and rejects guessing: ${scenario}`, async () => {
      const { result, observations, permissionRequests, permissionDeliveries } = await runScenario(key, scenario);
      assert.equal(result.state, "completed");
      assert.equal(permissionRequests[0]?.canAllow, false);
      assert.deepEqual(permissionRequests[0]?.options, [
        { optionId: "write-once-a", name: "Write for this request", kind: "allow_once" },
        { optionId: "write-once-b", name: "Allow alternate action", kind: "allow_once" },
        { optionId: "reject-exact", name: "Reject this request", kind: "reject_once" },
        { optionId: "persist-explicit", name: "Allow remembered", kind: "allow_always" },
      ]);
      assert.deepEqual(permissionDeliveries, [true]);
      const optionId = scenario === "permission_exact" ? "reject-exact" : scenario === "permission_exact_always" ? "persist-explicit" : undefined;
      assert.deepEqual(observations.find(entry => entry.permissionResult)?.permissionResult,
        { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    });
  }
  for (const scenario of ["elicitation_form", "elicitation_url"] as const) {
    test(`${key} forwards native elicitation and transport delivery: ${scenario}`, async () => {
      const { result, observations, permissionRequests, permissionDeliveries } = await runScenario(key, scenario);
      assert.equal(result.state, "completed");
      assert.deepEqual((observations.find(entry => entry.clientCapabilities)?.clientCapabilities as Record<string, unknown>).elicitation,
        { form: {}, url: {} });
      assert.deepEqual(permissionRequests[0]?.form, scenario === "elicitation_form"
        ? { mode: "form", message: "Native question", requestedSchema: { type: "object", properties: { answer: { type: "string", enum: ["left", "right"] } }, required: ["answer"] } }
        : { mode: "url", message: "Native question", url: "https://example.test/authorize", elicitationId: "native-auth" });
      assert.deepEqual(permissionDeliveries, [true]);
      assert.deepEqual(observations.find(entry => entry.permissionResult)?.permissionResult, scenario === "elicitation_form"
        ? { action: "accept", content: { answer: "right" } } : { action: "decline" });
    });
  }
  // Shared ACP lifecycle and permission policies use the remaining public harness adapter.
  test(
    `${key} cancels during setup without dispatching a prompt`,
    { timeout: 3_000 },
    async () => {
      const { result, observations } = await runScenario(key, "setup_cancel");
      assert.equal(result.state, "cancelled");
      assert.ok(
        !observations.some(({ method }) => method === "session/prompt"),
      );
    },
  );
  test(
    `${key} keeps an unconfirmed cancellation outcome unknown`,
    { timeout: 10_000 },
    async () => {
      const { result, observations } = await runScenario(key, "unconfirmed");
      assert.equal(result.state, "unknown");
      assert.equal(result.sessionId, "session-1");
      assert.ok(
        observations.some((entry) => entry.method === "session/cancel"),
      );
    },
  );
  test(`${key} preserves a completed Provider result that races cancellation`, async () => {
    const { result } = await runScenario(key, "completed");
    assert.equal(result.state, "completed");
  });
  for (const scenario of ["disconnected", "refusal", "unrequested_cancel"] as const) {
    test(`ACP preserves the Provider terminal boundary: ${scenario}`, async () => {
      const { result, observations } = await runScenario(key, scenario);
      assert.equal(result.state, scenario === "disconnected" ? "unknown" : "failed");
      assert.equal(observations.filter(entry => entry.method === "session/prompt").length, 1);
      assert.equal(observations.filter(entry => entry.method === "session/new").length, 1);
    });
  }
  test("ACP preserves cached token fields through the runtime usage projection", async () => {
    const { result } = await runScenario(key, "cache_usage");
    assert.equal(result.state, "completed");
    assert.deepEqual(result.usage, { totalTokens: 12, inputTokens: 7, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 3 });
  });
  {
    test(`${key} grants an available one-time permission while active`, async () => {
      const { result, observations, permissionDeliveries } = await runScenario(
        key,
        "permission_once",
      );
      assert.equal(result.state, "completed");
      assert.deepEqual(permissionDeliveries, [true]);
      assert.deepEqual(
        observations.find((entry) => entry.permissionResult)?.permissionResult,
        {
          outcome: { outcome: "selected", optionId: "once" },
        },
      );
    });
    for (const scenario of [
      "permission",
      "permission_default",
      "permission_error",
      "permission_after_cancel",
      "permission_callback_cancel",
    ] as const) {
      test(`ACP denies tool permission: ${scenario}`, async () => {
        const { result, observations, permissionProgressCount } =
          await runScenario(key, scenario);
        assert.equal(result.state, "completed");
        assert.deepEqual(
          observations.find((entry) => entry.permissionResult)
            ?.permissionResult,
          {
            outcome: { outcome: "cancelled" },
          },
        );
        assert.equal(
          permissionProgressCount,
          scenario === "permission_after_cancel" ? 0 : 1,
        );
      });
    }
  }
}
