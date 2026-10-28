import { isAbsolute } from 'node:path';
import type { CodexExecutionConfig } from './codex.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function stringArray(value: string | undefined): string[] {
  const parsed: unknown = value ? JSON.parse(value) : [];
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('invalid_codex_adapter_options');
  return parsed as string[];
}

/** Dock selects policy; Codex ACP only applies process/session options. Never writes the native home. */
export function codexAdapterEnvironment(config: CodexExecutionConfig): NodeJS.ProcessEnv {
  const environment = { ...config.environment };
  const configured: unknown = environment.CODEX_CONFIG ? JSON.parse(environment.CODEX_CONFIG) : {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('invalid_codex_config');
  environment.CODEX_CONFIG = JSON.stringify({ model_reasoning_summary: 'concise', ...configured });
  const roots = [...stringArray(environment.CODEX_ACP_SKILL_ROOTS), ...(config.skillDirectory ? [config.skillDirectory] : [])];
  if (roots.some(root => !isAbsolute(root))) throw new Error('invalid_codex_skill_roots');
  environment.CODEX_ACP_SKILL_ROOTS = JSON.stringify([...new Set(roots)]);
  const args = stringArray(environment.CODEX_ACP_APP_SERVER_ARGS);
  if (config.desktopHost && process.platform === 'darwin') args.push(
    '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
    '-c', 'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true',
  );
  environment.CODEX_ACP_APP_SERVER_ARGS = JSON.stringify(args);
  return environment;
}

const clip = (value: unknown): unknown => typeof value === 'string' && value.length > 16000
  ? value.slice(0, 16000) + '\n…输出已截断' : value;
const bounded = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  return json && json.length > 16000 ? clip(json) : value;
};
const textParts = (parts: unknown): string => (Array.isArray(parts) ? parts : []).map(record)
  .filter(part => (part.type === 'text' || part.type === 'inputText') && typeof part.text === 'string')
  .slice(0, 32).map(part => clip(part.text)).join('\n');

/** Device display policy. Native reasoning, binary results and unknown fields never enter the projection. */
export function projectCodexItem(item: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof item.id !== 'string' || typeof item.type !== 'string') return null;
  const catalog: Record<string, string[]> = {
    commandExecution: ['command', 'cwd', 'status', 'exitCode', 'durationMs'],
    mcpToolCall: ['server', 'tool', 'status', 'arguments', 'durationMs'],
    dynamicToolCall: ['tool', 'status', 'arguments', 'success', 'durationMs'],
    webSearch: ['query', 'action'], fileChange: ['status'], reasoning: [],
  };
  const fields = Object.hasOwn(catalog, item.type) ? catalog[item.type] : undefined;
  if (!fields) return null;
  const result: Record<string, unknown> = { id: item.id, type: item.type };
  for (const key of fields) if (item[key] !== undefined) result[key] = bounded(item[key]);
  if (item.type === 'commandExecution') {
    if (item.commandActions !== undefined) result.commandActions = (Array.isArray(item.commandActions) ? item.commandActions : []).slice(0, 16).map(record).map(action =>
      Object.fromEntries(['type', 'name', 'path', 'query'].filter(key => typeof action[key] === 'string').map(key => [key, (action[key] as string).slice(0, 1024)])));
    if (item.aggregatedOutput !== undefined) result.aggregatedOutput = clip(item.aggregatedOutput);
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) result.changes = item.changes.slice(0, 64).map(record)
    .filter(change => typeof change.path === 'string').map(change => ({ path: (change.path as string).slice(0, 1024), kind: typeof change.kind === 'string' ? change.kind : record(change.kind).type }));
  if (item.type === 'dynamicToolCall' && item.contentItems !== undefined) result.contentItems = [{ type: 'text', text: clip(textParts(item.contentItems)) }];
  if (item.type === 'mcpToolCall') {
    if (item.result) {
      const value = record(item.result);
      result.result = { content: [{ type: 'text', text: clip(textParts(value.content) || JSON.stringify(value.structuredContent ?? '')) }] };
    }
    if (item.error) result.error = { message: clip(record(item.error).message) };
  }
  return result;
}

/** Reuse ACP's normalized tool facts; metadata carries only native facts ACP does not represent. */
export function mergeCodexItem(details: Record<string, unknown>, update: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> | null {
  const item = { ...previous, ...details }, input = record(update.rawInput), output = record(update.rawOutput);
  const assign = (keys: string[], source: Record<string, unknown>) => {
    for (const key of keys) if (source[key] !== undefined) item[key] = source[key];
  };
  const content = Array.isArray(update.content) ? update.content.map(record).filter(part => part.type === 'content').map(part => record(part.content)) : [];
  if (item.type === 'commandExecution') {
    assign(['command', 'cwd'], input);
    if (content.length) item.aggregatedOutput = textParts(content);
    const meta = record(update._meta);
    for (const key of ['terminal_output', 'terminal_output_delta']) {
      const data = record(meta[key]).data;
      if (typeof data === 'string') item.aggregatedOutput = String(item.aggregatedOutput ?? '') + data;
    }
    const exitCode = output.exit_code ?? record(meta.terminal_exit).exit_code;
    if (exitCode !== undefined) item.exitCode = exitCode;
  } else if (item.type === 'mcpToolCall') {
    assign(['server', 'tool', 'arguments'], input);
    assign(['result', 'error'], output);
  } else if (item.type === 'dynamicToolCall') {
    assign(['arguments'], input);
    if (update.content !== undefined) item.contentItems = content;
  } else if (item.type === 'webSearch') assign(['query', 'action'], input);
  return projectCodexItem(item);
}
