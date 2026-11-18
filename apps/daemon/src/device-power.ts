import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export interface DevicePowerStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  error?: "power_settings_unavailable" | "power_assertion_unavailable";
}

async function preference(stateDir: string): Promise<boolean> {
  let file;
  try {
    file = await open(
      join(stateDir, "power.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 1024 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error("power_settings_unavailable");
    const value = JSON.parse(await file.readFile("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 1 ||
      typeof value.keepAwake !== "boolean"
    )
      throw new Error("power_settings_unavailable");
    return value.keepAwake;
  } finally {
    await file.close();
  }
}

export async function idlePowerStatus(
  stateDir: string,
): Promise<DevicePowerStatus> {
  if (process.platform !== "darwin")
    return { supported: false, enabled: false, active: false };
  try {
    return {
      supported: true,
      enabled: await preference(stateDir),
      active: false,
    };
  } catch {
    return {
      supported: true,
      enabled: false,
      active: false,
      error: "power_settings_unavailable",
    };
  }
}

/** Device-local policy. Its lifetime is the daemon's, including idle time and reconnects. */
export class DevicePower {
  #status: DevicePowerStatus = {
    supported: process.platform === "darwin",
    enabled: false,
    active: false,
  };
  #child?: ChildProcess;
  #retry?: NodeJS.Timeout;
  #closed = false;
  #pending: Promise<void> = Promise.resolve();
  constructor(readonly stateDir: string) {}
  get status(): DevicePowerStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    this.#status = await idlePowerStatus(this.stateDir);
    if (this.#status.error)
      console.error(`Device keep-awake unavailable: ${this.#status.error}`);
    await this.#serialize(() => this.#apply());
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error("device_stopping");
      if (!this.#status.supported)
        throw new Error("power_management_unsupported");
      const temporary = join(this.stateDir, `.power-${randomUUID()}.tmp`);
      try {
        // Do not silently replace an unreadable or foreign preference file.
        await preference(this.stateDir);
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({ keepAwake: enabled }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(this.stateDir, "power.json"));
        const directory = await open(this.stateDir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        throw new Error("power_settings_unavailable");
      } finally {
        await rm(temporary, { force: true });
      }
      this.#status.enabled = enabled;
      this.#status.error = undefined;
      await this.#apply();
    });
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => {});
    return next;
  }

  #scheduleRetry(): void {
    if (this.#closed || !this.#status.enabled || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#serialize(() => this.#apply());
    }, 5_000);
    this.#retry.unref();
  }

  async #apply(): Promise<void> {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    if (this.#closed || !this.#status.enabled) {
      await this.#release();
      return;
    }
    if (this.#child && this.#status.active) return;
    await this.#release();
    const child = spawn(
      "/usr/bin/caffeinate",
      ["-i", "-w", String(process.pid)],
      { stdio: "ignore" },
    );
    this.#child = child;
    const ended = () => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#status.active = false;
      this.#status.error = "power_assertion_unavailable";
      this.#scheduleRetry();
    };
    child.once("exit", ended);
    child.once("error", ended);
    child.unref();
    // Confirm this helper's OS assertion, not another application's keep-awake state.
    for (
      let attempt = 0;
      attempt < 5 && this.#child === child && !this.#closed;
      attempt++
    ) {
      try {
        const { stdout } = await exec("/usr/bin/pmset", ["-g", "assertions"], {
          timeout: 2_000,
          maxBuffer: 256 * 1024,
        });
        if (
          this.#child === child &&
          stdout
            .split("\n")
            .some(
              (line) =>
                line.includes(`pid ${child.pid}(caffeinate):`) &&
                /PreventUserIdleSystemSleep|NoIdleSleepAssertion/u.test(line),
            )
        ) {
          this.#status.active = true;
          this.#status.error = undefined;
          return;
        }
      } catch {
        /* An unconfirmed assertion is not reported as active. */
      }
      await delay(100);
    }
    await this.#release();
    if (!this.#closed) {
      this.#status.error = "power_assertion_unavailable";
      this.#scheduleRetry();
    }
  }

  async #release(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid
    ) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    this.#status.active = false;
  }

  close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    return this.#serialize(() => this.#release());
  }
}
