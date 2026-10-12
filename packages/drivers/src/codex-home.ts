import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type PrepareCodexHomeOptions = {
  codexHome: string;
  authFile: string;
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function prepareCodexHome(options: PrepareCodexHomeOptions): Promise<void> {
  const codexHome = resolve(options.codexHome);
  const sourceAuthFile = resolve(options.authFile);
  const targetAuthFile = join(codexHome, "auth.json");

  if (targetAuthFile === sourceAuthFile || codexHome === dirname(sourceAuthFile)) {
    throw new Error("Runtime Codex home must be isolated from the authentication source home");
  }

  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);

  try {
    await lstat(targetAuthFile);
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  try {
    await access(sourceAuthFile, constants.R_OK);
  } catch (error) {
    throw new Error(`Codex authentication is unavailable at ${sourceAuthFile}`, { cause: error });
  }

  try {
    await symlink(sourceAuthFile, targetAuthFile);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
}
