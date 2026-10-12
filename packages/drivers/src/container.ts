import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const exec = promisify(execFile);
export interface ContainerConfig {
  engine: 'docker' | 'podman';
  executable?: string;
  /** Immutable local sha256 image ID or registry digest. */
  image: string;
  /** Explicit operator opt-in; never enabled automatically. Podman only. */
  disableSelinuxLabel?: boolean;
}
export class ContainerHarness {
  readonly command: string[];
  readonly name: string;
  private readonly executable: string;
  private readonly owner: string;
  private readonly nodeId: string;
  constructor(config: ContainerConfig, nodeId: string, cwd: string, codexHome: string, stateDir: string) {
    if (!['docker', 'podman'].includes(config.engine)) throw new Error('invalid_container_engine');
    if (!/^sha256:[a-f0-9]{64}$/.test(config.image) && !/@sha256:[a-f0-9]{64}$/.test(config.image))
      throw new Error('Container image must be an immutable sha256 ID or registry digest');
    if (config.disableSelinuxLabel !== undefined &&
      (typeof config.disableSelinuxLabel !== 'boolean' || config.engine !== 'podman'))
      throw new Error('invalid_selinux_option');
    for (const path of [cwd, codexHome, stateDir])
      if (!isAbsolute(path) || path.includes(',') || path === '/') throw new Error('invalid_container_mount');
    if (!nodeId) throw new Error('Container requires a configured nodeId');
    this.nodeId = nodeId;
    this.owner = createHash('sha256').update(resolve(stateDir)).digest('hex');
    this.name = `harness-dock-${nodeId}`;
    this.executable = config.executable ?? config.engine;
    this.command = [this.executable, 'run', '--rm', '-i', '--name', this.name,
      '--label', `harness-dock.node=${nodeId}`, '--label', `harness-dock.owner=${this.owner}`,
      ...(config.disableSelinuxLabel ? ['--security-opt=label=disable'] : []),
      '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=256', '--memory=2g', '--cpus=2',
      '--user', String(process.getuid?.() ?? 1000),
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
      '--mount', `type=bind,source=${cwd},target=${cwd}`,
      '--mount', `type=bind,source=${codexHome},target=/dock-home`,
      '--workdir', cwd, '--env', 'HOME=/dock-home', '--env', 'CODEX_HOME=/dock-home',
      '--env', 'INITIAL_AGENT_MODE=workspace-write',
      config.image];
  }
  /** Fails closed when the engine is unavailable or a name belongs to another owner. */
  async cleanup(): Promise<void> {
    const options = { timeout: 20_000, maxBuffer: 1024 * 1024 };
    const { stdout } = await exec(this.executable, ['ps', '-a', '--filter', `name=${this.name}`, '--format', '{{.Names}}'], options);
    if (!stdout.trim().split(/\s+/).includes(this.name)) return;
    const result = await exec(this.executable, ['inspect', this.name], options);
    const [{ Id: containerId, Config: { Labels: labels } }] = JSON.parse(result.stdout) as
      [{ Id: string; Config: { Labels: Record<string, string> } }];
    if (labels['harness-dock.owner'] !== this.owner || labels['harness-dock.node'] !== this.nodeId)
      throw new Error('container_owner_mismatch');
    // A container name can be reassigned between inspection and deletion.
    await exec(this.executable, ['rm', '--force', containerId], options);
  }
}
