/** Exact parent names inherited by native agent children; trusted overlays are explicit. */
export const AGENT_PROCESS_ENV_ALLOW: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SYSTEMROOT',
]);
