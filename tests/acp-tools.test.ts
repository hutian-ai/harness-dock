import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LobiAcpExecutor } from "../packages/drivers/src/lobi.ts";
import { DeepSeekAcpExecutor } from "../packages/drivers/src/deepseek.ts";
import { ACP_PROBE_TOOLS } from "../packages/drivers/src/acp-types.ts";
import type { McpToolCall } from "../packages/drivers/src/mcp-bridge.ts";
import type { ToolDelivery } from "../packages/drivers/src/tool-delivery.ts";

const cases = ["lobi", "deepseek-harness"] as const;

for (const key of cases) {
  test(
    `${key} bridges a Provider tool round trip`,
    { timeout: 15_000 },
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "dock-tool-driver-"));
      const executable = join(directory, "provider.cjs");
      const logPath = join(directory, "protocol.jsonl");
      const cancellation = new AbortController();
      const signal = AbortSignal.any([context.signal, cancellation.signal]);
      await writeFile(
        executable,
        `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const fs=require('node:fs');
const key=${JSON.stringify(key)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const model={id:'model',name:'Model',category:'model',type:'select',currentValue:'test-model',options:[{value:'test-model',name:'Test'}]};
let mcp; let mcpId=0; const pending=new Map();
const requestMcp=(method,params)=>new Promise((resolve,reject)=>{const id=++mcpId;pending.set(id,{resolve,reject});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n')});
const lines=createInterface({input:process.stdin});
lines.on('line',async line=>{
 const r=JSON.parse(line); const reply=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method) fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({method:r.method,dynamicTools:r.params?.dynamicTools,model:r.params?.model,effort:r.params?.effort})+'\\n');
 if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new') {
  const s=r.params.mcpServers[0];
  mcp=spawn(s.command,s.args,{env:{...process.env,...Object.fromEntries(s.env.map(e=>[e.name,e.value]))},stdio:['pipe','pipe','pipe']});mcp.stderr.resume();
  createInterface({input:mcp.stdout}).on('line',line=>{const v=JSON.parse(line);const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(new Error(v.error.message)):p.resolve(v.result)}});
  await requestMcp('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fake-acp',version:'1'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
  const listed=await requestMcp('tools/list',{});if(listed.tools.length!==1)throw new Error('unexpected manifest');
  reply({sessionId:'session-test',configOptions:[model],modes:{availableModes:[{id:'build',name:'Build'}]}});
 }
 if(r.method==='session/set_mode')reply({});
 if(r.method==='session/prompt') {const result=await requestMcp('tools/call',{name:'synthetic_search',arguments:{query:'synthetic'}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-test',update:{sessionUpdate:'tool_call_update',toolCallId:'fake-call',status:'completed',content:[{type:'content',content:result.content[0]}]}}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.parse(result.content[0].text).token}}}});reply({stopReason:'end_turn'})}
});
const close=()=>{if(mcp)mcp.kill();process.exit(0)}; lines.on('close',close);process.on('SIGTERM',close);
`,
      );
      await chmod(executable, 0o700);
      const command = async () => ({
        exitCode: 0,
        stdout: key === "deepseek-harness" ? "0.1.2-rc.1" : "0.1.95",
        stderr: "",
      });
      const driver =
        key === "lobi"
          ? new LobiAcpExecutor({
              env: process.env,
              executable,
              probeCommand: command,
              probeAcp: async () => ({
                protocolVersion: 1,
                loadSession: true,
                resumeSession: true,
                models: ["test-model"],
                modes: ["plan", "build"],
                mcpTools: true,
              }),
            })
          : new DeepSeekAcpExecutor({
              env: process.env,
              executable,
              probeCommand: command,
              probeAcp: async () => ({
                protocolVersion: 1,
                models: ["test-model"],
                reasoningEffortsByModel: {},
                loadSession: true,
                mcpTools: true,
              }),
            });
      const calls: McpToolCall[] = [];
      const deliveries: ToolDelivery<string[]>[] = [];
      try {
        const descriptor = await driver.probe(signal);
        assert.equal(descriptor.mcpTools, true);
        const result = await driver.execute({
          runId: "tool-roundtrip",
          cwd: directory,
          signal,
          model: "test-model",
          config: {},
          prompt: "call the supplied tool",
          tools: ACP_PROBE_TOOLS,
          callbacks: {
            onStarted: async () => undefined,
            onProgress: async () => undefined,
          },
          mcp: {
            signal,
            onToolCall: async (call) => {
              calls.push(call);
              return {
                content: { token: "TOOL_ROUNDTRIP_OK" },
                deliveryContext: ["test-receipt"],
              };
            },
            onToolResultDelivery: async (delivery) => {
              deliveries.push(delivery);
            },
          },
        });
        assert.equal(result.state, "completed", JSON.stringify(result));
        assert.equal(result.text, "TOOL_ROUNDTRIP_OK");
        assert.equal(calls.length, 1);
        assert.deepEqual(deliveries, [
          {
            callId: calls[0]!.callId,
            status: "delivered",
            context: ["test-receipt"],
          },
        ]);
        assert.equal(calls[0]!.name, "synthetic_search");
        assert.deepEqual(calls[0]!.arguments, { query: "synthetic" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
