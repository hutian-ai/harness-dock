import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Package the existing hutian-ai logo at every standard macOS icon size before signing. */
export async function buildPanelIcon(destination: string): Promise<void> {
  const temporary = await mkdtemp(join(dirname(destination), '.app-icon-'));
  try {
    const iconset = join(temporary, 'AppIcon.iconset');
    const source = resolve('apps/device-panel/Resources/HutianLogo.png');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = String(size * scale);
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('/usr/bin/sips', ['-z', pixels, pixels, source, '--out', join(iconset, name)], { stdio: 'pipe' });
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', destination], { stdio: 'pipe' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
