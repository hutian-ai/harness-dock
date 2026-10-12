import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { prepareCodexHome } from "../packages/drivers/src/codex-home.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
});

test("prepares an isolated Codex home that reuses only authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-codex-home-"));
  temporaryPaths.push(directory);
  const sourceAuthFile = join(directory, "desktop-auth.json");
  const codexHome = join(directory, "runtime-home");
  await writeFile(sourceAuthFile, '{"tokens":"test-only"}', { mode: 0o600 });

  await prepareCodexHome({ codexHome, authFile: sourceAuthFile });

  assert.equal(await readlink(join(codexHome, "auth.json")), sourceAuthFile);
  assert.equal(await readFile(join(codexHome, "auth.json"), "utf8"), '{"tokens":"test-only"}');
  assert.equal((await stat(codexHome)).mode & 0o777, 0o700);
});

test("preserves an explicitly provisioned isolated authentication file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-codex-home-provisioned-"));
  temporaryPaths.push(directory);
  const codexHome = join(directory, "runtime-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "auth.json"), "provisioned", { mode: 0o600 });

  await prepareCodexHome({ codexHome, authFile: join(directory, "missing-auth.json") });

  assert.equal(await readFile(join(codexHome, "auth.json"), "utf8"), "provisioned");
});

test("rejects the desktop Codex home as the runtime home", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-shared-codex-home-"));
  temporaryPaths.push(directory);

  await assert.rejects(
    prepareCodexHome({ codexHome: directory, authFile: join(directory, "auth.json") }),
    /must be isolated/u,
  );
});
