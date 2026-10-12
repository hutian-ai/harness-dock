import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { LobiAcpExecutor } from "../packages/drivers/src/lobi.ts";
import type { AcpFileChangeEvent } from "../packages/drivers/src/acp-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((temporaryPath) =>
        rm(temporaryPath, { recursive: true, force: true }),
      ),
  );
});

test("uses an explicit Lobi model allowlist only to narrow the ACP catalog", async () => {
  const driver = new LobiAcpExecutor({
    env: process.env,
    executable: "/opt/codewiz",
    modelAllowlist: ["codewiz/qwen3.7-plus"],
    probeCommand: async (_executable, args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "0.1.95\n" : "ACP help\n",
      stderr: "",
    }),
    probeAcp: async () => ({
      protocolVersion: 1,
      loadSession: true,
      resumeSession: true,
      models: ["codewiz/claude-sonnet-5", "codewiz/qwen3.7-plus"],
      modes: ["plan", "build"],
    }),
  });

  assert.deepEqual((await driver.probe()).models, ["codewiz/qwen3.7-plus"]);
});

test("rejects a stale Lobi model allowlist", async () => {
  const driver = new LobiAcpExecutor({
    env: process.env,
    executable: "/opt/codewiz",
    modelAllowlist: ["codewiz/removed-model"],
    probeCommand: async (_executable, args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "0.1.95\n" : "ACP help\n",
      stderr: "",
    }),
    probeAcp: async () => ({
      protocolVersion: 1,
      loadSession: true,
      resumeSession: true,
      models: ["codewiz/qwen3.7-plus"],
      modes: ["plan", "build"],
    }),
  });

  await assert.rejects(
    driver.probe(),
    /model allowlist is unavailable: codewiz\/removed-model/u,
  );
});

for (const scenario of [
  "resume",
  "missing-loaded-model",
  "missing-loaded-modes",
  "removed-loaded-model",
  "removed-loaded-mode",
  "unacknowledged-model",
  "unsupported-resume",
] as const) {
  test(`revalidates the actual Lobi session catalog: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dock-lobi-catalog-"));
    temporaryPaths.push(directory);
    const executable = join(directory, "codewiz");
    const requestLog = join(directory, "requests.jsonl");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require("node:fs");
const readline=require("node:readline");
const scenario=${JSON.stringify(scenario)};
let model="other-model";
const metadata=()=>({
 configOptions:scenario === "missing-loaded-model" ? [] : [{id:"model",name:"Model",type:"select",currentValue:model,options:(scenario === "removed-loaded-model" ? ["other-model"] : ["other-model","test-model"]).map(value=>({value,name:value}))}],
 modes:{currentModeId:"build",availableModes:(scenario === "missing-loaded-modes" ? [] : scenario === "removed-loaded-mode" ? ["plan"] : ["plan","build"]).map(id=>({id,name:id}))}
});
const lines=readline.createInterface({input:process.stdin});
lines.on("line",line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(requestLog)},JSON.stringify({method:request.method,params:request.params})+"\\n");
 const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
 if(request.method==="initialize") reply({protocolVersion:1,agentCapabilities:{loadSession:scenario!=="unsupported-resume"}});
 if(request.method==="session/load") reply(metadata());
 if(request.method==="session/new") reply({sessionId:"new-session",...metadata()});
 if(request.method==="session/set_mode") reply({});
 if(request.method==="session/set_config_option") {if(scenario!=="unacknowledged-model") model=request.params.value;reply({configOptions:metadata().configOptions});}
 if(request.method==="session/prompt") reply({stopReason:"end_turn"});
});
lines.on("close",()=>process.exit(0));
`,
    );
    await chmod(executable, 0o755);
    const driver = new LobiAcpExecutor({
      env: process.env,
      executable,
      probeCommand: async () => ({ exitCode: 0, stdout: "0.1.95", stderr: "" }),
      probeAcp: async () => ({
        protocolVersion: 1,
        loadSession: true,
        resumeSession: true,
        models: ["other-model", "test-model"],
        modes: ["plan", "build"],
      }),
    });
    await driver.probe();
    const result = await driver.execute({
      runId: "018f47f2-4f15-7c86-a8d9-9e38115d9080",
      allowSessionResume: true,
      model: "test-model",
      config: { mode: "build" },
      prompt: "check session configuration",
      resumeSessionId: "saved-session",
      cwd: directory,
      signal: new AbortController().signal,
      callbacks: {
        permission: async () => "allow",
        onStarted: async () => undefined,
        onProgress: async () => undefined,
      },
    });
    const requests = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
    assert.equal(result.state, scenario === "resume" ? "completed" : "failed");
    assert.equal(
      requests.some((request) => request.method === "session/prompt"),
      scenario === "resume",
    );
    assert.equal(
      requests.some((request) => request.method === "session/new"),
      false,
    );
    if (scenario === "resume") {
      assert.equal(result.sessionId, "saved-session");
      assert.equal(result.resumed, true);
      assert.equal(result.resumable, true);
      assert.deepEqual(
        requests.find(
          (request) => request.method === "session/set_config_option",
        )?.params,
        { sessionId: "saved-session", configId: "model", value: "test-model" },
      );
    }
  });
}

test("rejects the older global CodeWiz build before registering Lobi", async () => {
  const driver = new LobiAcpExecutor({
    env: process.env,
    executable: "codewiz",
    probeCommand: async (_executable, args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "0.1.91\n" : "ACP help\n",
      stderr: "",
    }),
    probeAcp: async () => ({
      protocolVersion: 1,
      loadSession: true,
      resumeSession: true,
      models: ["codewiz/qwen3.7-plus"],
      modes: ["plan", "build"],
    }),
  });

  await assert.rejects(driver.probe(), /expected 0\.1\.95 or newer/u);
});

test("uses configured modes and explicit permission decisions for fresh and resumable execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-fake-lobi-acp-"));
  temporaryPaths.push(directory);
  const executable = join(directory, "codewiz");
  const requestLog = join(directory, "requests.jsonl");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.1.95"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("ACP help"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
let pendingPromptId = null;
lines.on("line", (line) => {
  fs.appendFileSync(process.env.FAKE_LOBI_REQUEST_LOG, line + "\\n");
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, resume: {} } },
    agentInfo: { name: "CodeWiz", version: "0.1.95" }
  } });
  if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: {
    sessionId: "lobi-session-1",
    modes: { currentModeId: "build", availableModes: [
      { id: "plan", name: "Plan" },
      { id: "build", name: "Build" },
      { id: "hephaestus", name: "Hephaestus" }
    ] },
    configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "codewiz/claude-sonnet-5", options: [
      { value: "codewiz/claude-sonnet-5", name: "Sonnet" },
      { value: "codewiz/qwen3.7-plus", name: "Qwen" }
    ] }]
  } });
  if (request.method === "session/load") send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "session/set_mode") send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "session/set_config_option") send({ jsonrpc: "2.0", id: request.id, result: { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: request.params.value, options: [{ value: request.params.value, name: request.params.value }] }] } });
  if (request.method === "session/prompt") {
    pendingPromptId = request.id;
    send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {
      sessionId: "lobi-session-1",
      toolCall: { toolCallId: "tool-1", title: "Run", kind: "execute", rawInput: {} },
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow" },
        { kind: "reject_once", name: "Reject once", optionId: "reject" }
      ]
    } });
  }
  if (request.id === "permission-1" && request.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "lobi-session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", content: [{ type: "diff", path: process.cwd() + "/LOBI.txt", oldText: null, newText: "owned\\n" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "lobi-session-1", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" }
    } } });
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn", usage: { totalTokens: 8 } } });
  }
});
lines.on("close", () => process.exit(0));
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const previousLog = process.env.FAKE_LOBI_REQUEST_LOG;
  process.env.FAKE_LOBI_REQUEST_LOG = requestLog;
  try {
    const driver = new LobiAcpExecutor({
      env: process.env,
      executable,
    });
    assert.deepEqual((await driver.probe()).models, [
      "codewiz/claude-sonnet-5",
      "codewiz/qwen3.7-plus",
    ]);
    const baseInput = {
      model: "codewiz/qwen3.7-plus",
      config: { mode: "hephaestus" },
      prompt: "complete the task",
    } as const;
    const progress: Array<Record<string, unknown>> = [];
    const fileChanges: AcpFileChangeEvent[] = [];
    const generation = await driver.execute({
      ...baseInput,
      runId: "018f47f2-4f15-7c86-a8d9-9e38115d9020",
      allowSessionResume: false,
      cwd: directory,
      signal: new AbortController().signal,
      callbacks: {
        permission: async () => "allow",
        onStarted: async () => undefined,
        onProgress: async (payload) => {
          progress.push(payload);
        },
        onFileChanges: async (event) => {
          fileChanges.push(event);
        },
      },
    });
    const cli = await driver.execute({
      ...baseInput,
      runId: "018f47f2-4f15-7c86-a8d9-9e38115d9021",
      allowSessionResume: true,
      cwd: directory,
      signal: new AbortController().signal,
      callbacks: {
        permission: async () => "allow",
        onStarted: async () => undefined,
        onProgress: async (payload) => {
          progress.push(payload);
        },
      },
    });

    assert.equal(generation.state, "completed");
    assert.equal(cli.state, "completed");
    assert.equal(fileChanges.length, 1);
    const reportedChange =
      fileChanges[0]?.kind === "delta" ? fileChanges[0].changes[0] : null;
    assert.equal(reportedChange?.path.endsWith("/LOBI.txt"), true);
    assert.equal(reportedChange?.beforeText, null);
    assert.equal(reportedChange?.afterText, "owned\n");
    assert.equal(generation.text, "done");
    assert.equal(generation.sessionId, "lobi-session-1");
    assert.equal(generation.resumable, false);
    assert.equal(cli.text, "done");
    assert.equal(cli.sessionId, "lobi-session-1");
    assert.equal(cli.resumable, true);
    assert.equal(cli.resumed, false);
    const requests = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      requests
        .filter((entry) => entry.method === "session/set_mode")
        .map((entry) => entry.params),
      [
        { sessionId: "lobi-session-1", modeId: "hephaestus" },
        { sessionId: "lobi-session-1", modeId: "hephaestus" },
      ],
    );
    assert.deepEqual(
      requests
        .filter((entry) => entry.id === "permission-1")
        .map((entry) => entry.result),
      [
        { outcome: { outcome: "selected", optionId: "allow" } },
        { outcome: { outcome: "selected", optionId: "allow" } },
      ],
    );
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_LOBI_REQUEST_LOG;
    else process.env.FAKE_LOBI_REQUEST_LOG = previousLog;
  }
});
