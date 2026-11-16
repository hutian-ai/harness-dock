import { delimiter, dirname } from 'node:path';
import { nativePathVariables } from './autostart.ts';

/** Retain local selections when a GUI starts the daemon with a smaller PATH. */
export function installationEnvironment(record: { searchPath: string; environment?: Record<string, string> }, runtime: string,
  inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH');
  const livePath = pathKey ? environment[pathKey] : undefined;
  for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
  environment.PATH = [...new Set([dirname(runtime), livePath, record.searchPath].filter(Boolean)
    .flatMap(value => value!.split(delimiter)).filter(Boolean))].join(delimiter);
  for (const key of nativePathVariables) if (record.environment?.[key]) environment[key] = record.environment[key];
  return environment;
}
