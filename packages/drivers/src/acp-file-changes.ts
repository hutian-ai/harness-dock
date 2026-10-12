import { createHash } from "node:crypto";
import { MAX_OBSERVATION_BYTES, readBoundedText } from './output-limits.ts';
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { applyPatch, parsePatch, reversePatch } from "diff";
import type { AcpFileChangeEvent, AcpReportedFileChange } from "./acp-types.ts";

type ReadTextFile = (path: string) => Promise<string | null>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function defaultReadTextFile(path: string): Promise<string | null> {
  try {
    return await readBoundedText(path, MAX_OBSERVATION_BYTES);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return null;
    if (error instanceof Error && error.message === 'resource_exhausted:file_bytes') return null;
    throw error;
  }
}

async function vendorReportedChange(
  update: SessionUpdate,
  readTextFile: ReadTextFile,
): Promise<{
  path: string;
  beforeText: string | null;
  afterText: string | null;
} | null> {
  const rawUpdate = update as unknown as Record<string, unknown>;
  const rawInput = isObject(rawUpdate.rawInput) ? rawUpdate.rawInput : null;
  const rawOutput = isObject(rawUpdate.rawOutput) ? rawUpdate.rawOutput : null;
  const metadata =
    rawOutput && isObject(rawOutput.metadata) ? rawOutput.metadata : null;
  const patchText =
    metadata && typeof metadata.diff === "string" ? metadata.diff : null;
  const path =
    metadata && typeof metadata.filepath === "string"
      ? metadata.filepath
      : rawInput && typeof rawInput.filePath === "string"
        ? rawInput.filePath
        : null;
  if (!patchText || !path) return null;

  const parsed = parsePatch(patchText);
  if (parsed.length !== 1) return null;
  const afterText =
    rawInput && typeof rawInput.content === "string"
      ? rawInput.content
      : await readTextFile(path);
  if (metadata?.exists === false) {
    if (afterText === null) return null;
    return { path, beforeText: null, afterText };
  }
  const beforeText = applyPatch(afterText ?? "", reversePatch(parsed[0]!));
  if (beforeText === false) return null;
  return { path, beforeText, afterText };
}

export async function acpFileChangeEvent(
  source: string,
  sessionId: string,
  update: SessionUpdate,
  readTextFile: ReadTextFile = defaultReadTextFile,
): Promise<AcpFileChangeEvent | null> {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  )
    return null;
  // The unchanged progress notification carries the explicit omission marker upstream.
  if (Buffer.byteLength(JSON.stringify(update), 'utf8') > MAX_OBSERVATION_BYTES) return null;
  let changes: AcpReportedFileChange[] = (update.content ?? [])
    .filter((content) => content.type === "diff")
    .map((content) => ({
      path: content.path,
      beforeText: content.oldText ?? null,
      afterText: content.newText,
    }));
  if (changes.length === 0) {
    const vendorChange = await vendorReportedChange(update, readTextFile);
    if (vendorChange) changes = [vendorChange];
  }
  if (changes.length === 0) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify(changes))
    .digest("hex");
  return {
    kind: "delta",
    eventKey: `${source}:${sessionId}:${update.toolCallId}:${digest}`,
    changes,
  };
}
