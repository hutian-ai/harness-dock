import { ExecaError } from "execa";
import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedCommand } from "../packages/drivers/src/process-command.ts";

test("bounds each output stream while preserving text and nonzero exit codes", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('中文\\r\\n' + 'x'.repeat(10000)); process.stderr.write('y'.repeat(126) + '\\r\\n' + 'z'.repeat(10000)); process.exitCode = 7",
    ],
    { maxOutputCharacters: 128 },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "中文\r\n" + "x".repeat(124));
  assert.equal(result.stderr, "y".repeat(126) + "\r\n");
});

test("terminates hanging commands on timeout or cancellation", async () => {
  for (const failure of ["timedOut", "isCanceled"] as const) {
    await assert.rejects(
      runBoundedCommand(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        {
          timeoutMs: failure === "timedOut" ? 20 : 10_000,
          signal:
            failure === "isCanceled" ? AbortSignal.timeout(20) : undefined,
        },
      ),
      (error: unknown) => error instanceof ExecaError && error[failure],
    );
  }
});

test("does not restore host variables excluded from an explicit environment", async () => {
  const key = "APP_TEST_HOST_ONLY";
  const previous = process.env[key];
  process.env[key] = "host-only";
  try {
    const result = await runBoundedCommand(
      process.execPath,
      [
        "-e",
        `process.stdout.write(process.env.${key} ?? process.env.PROBE_VALUE)`,
      ],
      { env: { PROBE_VALUE: "isolated" } },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "isolated");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("observes Provider exit while a descendant still holds its output pipe", async () => {
  const { setTimeout: delay } = await import("node:timers/promises");
  const { startProtocolProcess, closeProtocolProcess } =
    await import("../packages/drivers/src/process-command.ts");
  const child = startProtocolProcess(
    process.execPath,
    [
      "-e",
      `
    const {spawn}=require("node:child_process");
    const descendant=spawn(process.execPath,["-e","setTimeout(()=>{},500)"],{stdio:["ignore",process.stdout,process.stderr]});
    descendant.unref();
    process.exit(0);
  `,
    ],
    { env: process.env },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exit = child.exited;
  await new Promise<void>((resolve) =>
    child.nodeChildProcess.once("exit", () => resolve()),
  );
  try {
    assert.equal(
      await Promise.race([exit.then(() => "exited"), delay(100, "pending")]),
      "exited",
    );
  } finally {
    await closeProtocolProcess(child);
  }
});
