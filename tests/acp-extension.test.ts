import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
} from "acpx/runtime";

test(
  "runtime extension stays on the owned turn, fences late requests, and probes without loading a session",
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dock-extension-"));
    const peer = join(root, "peer.mjs"),
      log = join(root, "methods.jsonl");
    await writeFile(
      peer,
      `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
let prompt;const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await(const line of createInterface({input:process.stdin})) {const q=JSON.parse(line);if(q.id===undefined)continue;
appendFileSync(${JSON.stringify(log)},JSON.stringify(q.method)+'\\n');
if(q.method==='initialize')send(q.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
else if(q.method==='session/new')send(q.id,{sessionId:'native'});
else if(q.method==='session/prompt')prompt=q.id;
else {send(q.id,{method:q.method});if(q.method==='_test/finish')send(prompt,{stopReason:'end_turn'});}}
`,
    );
    const runtime = createAcpRuntime({
      cwd: root,
      sessionStore: createRuntimeStore({ stateDir: join(root, "state") }),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer] },
      }),
      fs: false,
      terminal: false,
      permissionMode: "deny-all",
      timeoutMs: 5000,
    });
    try {
      await assert.rejects(
        runtime.requestExtension({
          scope: "agent",
          agent: "fixture",
          method: "session/prompt",
          params: {},
        }),
        /namespaced/,
      );
      assert.deepEqual(
        await runtime.requestExtension({
          scope: "agent",
          agent: "fixture",
          method: "_test/inspect",
          params: {},
        }),
        { method: "_test/inspect" },
      );
      assert.deepEqual(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        ["initialize", "_test/inspect"],
      );
      const handle = await runtime.ensureSession({
        agent: "fixture",
        sessionKey: "synthetic",
        mode: "persistent",
      });
      const turn = runtime.startTurn({
        handle,
        requestId: "owned",
        mode: "prompt",
        text: "synthetic",
      });
      const drain = (async () => {
        for await (const _ of turn.events) {
        }
      })();
      await turn.promptStarted;
      const extension = {
        scope: "active-turn" as const,
        handle,
        requestId: "owned",
        method: "_test/finish",
        params: {},
      };
      await assert.rejects(
        runtime.requestExtension({ ...extension, requestId: "obsolete" }),
        { code: "ACP_TURN_NOT_ACTIVE" },
      );
      await assert.rejects(
        runtime.requestExtension({ ...extension, scope: "session" }),
        /active turn/,
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        runtime.requestExtension({ ...extension, signal: cancelled.signal }),
      );
      assert.deepEqual(await runtime.requestExtension(extension), {
        method: "_test/finish",
      });
      assert.equal((await turn.result).status, "completed");
      await drain;
      await assert.rejects(runtime.requestExtension(extension), {
        code: "ACP_TURN_NOT_ACTIVE",
      });
      const methods = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        methods.filter((method) => method === "_test/finish").length,
        1,
      );
      assert.equal(methods.includes("session/load"), false);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
