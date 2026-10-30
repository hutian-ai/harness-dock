import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Build the real socket boundary into the fixture, without depending on mutable workspace dist files. */
export async function writePanelControlFixture(bundle: string): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const protocolPackage = join(root, 'packages/protocol/package.json');
  const protocol = join(bundle, 'node_modules/@harness-dock/protocol');
  await mkdir(join(bundle, 'dist'), { recursive: true });
  await mkdir(join(protocol, 'dist'), { recursive: true });
  const compile = async (source: string, target: string) => {
    const { outputText, diagnostics } = ts.transpileModule(await readFile(source, 'utf8'), {
      fileName: source,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true, rewriteRelativeImportExtensions: true },
    });
    if (diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('invalid_panel_control_fixture');
    await writeFile(target, outputText);
  };
  await compile(join(root, 'apps/daemon/src/local-control.ts'), join(bundle, 'dist/local-control.js'));
  await copyFile(protocolPackage, join(protocol, 'package.json'));
  for (const name of await readdir(join(root, 'packages/protocol/src'))) {
    if (name.endsWith('.ts')) await compile(join(root, 'packages/protocol/src', name), join(protocol, 'dist', name.slice(0, -3) + '.js'));
  }
  const zod = await realpath(dirname(createRequire(protocolPackage).resolve('zod/package.json')));
  // This fixture loads ESM only. Keep the complete JS tree, package metadata and license,
  // without repeatedly hashing TypeScript sources/declarations in every release preflight.
  await cp(zod, join(bundle, 'node_modules/zod'), { recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: async source => /\.(?:js|json)$/u.test(source) || basename(source) === 'LICENSE' || (await lstat(source)).isDirectory(),
  });
}
