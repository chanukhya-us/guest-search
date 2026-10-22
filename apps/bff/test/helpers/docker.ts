/**
 * Docker availability gate for the optional container contract test (task 13.2).
 *
 * The local MVP is NO-Docker by default, so the WireMock/testcontainers contract test must be
 * SKIPPED cleanly — never fail, never hang — when no container runtime is present. This probe
 * is intentionally cheap and synchronous (no network, no `testcontainers` import): it only
 * decides whether the gated `describe` should run.
 *
 * Decision order:
 *   1. `RUN_CONTAINER_TESTS=false` (or `0`) — explicit opt-out, always skip.
 *   2. `RUN_CONTAINER_TESTS=true`  (or `1`) — explicit opt-in, always attempt (CI with Docker).
 *   3. Otherwise auto-detect: a `DOCKER_HOST` env var, the default Docker socket (Unix) or the
 *      Docker engine named pipe (Windows). Present → run; absent → skip.
 *
 * Auto-detect deliberately does NOT shell out to the `docker` CLI (slow, and absent here): the
 * socket/pipe check is enough to tell whether testcontainers could connect.
 */
import { existsSync } from 'node:fs';

const DEFAULT_UNIX_SOCKET = '/var/run/docker.sock';
const WINDOWS_ENGINE_PIPE = '\\\\.\\pipe\\docker_engine';

/** Normalise a boolean-ish env flag; `undefined` when unset or not a recognised value. */
function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/** Why the container test ran or skipped, for a human-readable console note. */
export interface DockerProbe {
  available: boolean;
  reason: string;
}

/** Probe for a usable container runtime without importing testcontainers or hitting the network. */
export function probeDocker(env: NodeJS.ProcessEnv = process.env): DockerProbe {
  const override = flag(env.RUN_CONTAINER_TESTS);
  if (override === false) {
    return { available: false, reason: 'RUN_CONTAINER_TESTS=false (explicit opt-out)' };
  }
  if (override === true) {
    return { available: true, reason: 'RUN_CONTAINER_TESTS=true (explicit opt-in)' };
  }

  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST.trim() !== '') {
    return { available: true, reason: `DOCKER_HOST=${env.DOCKER_HOST}` };
  }
  if (process.platform === 'win32') {
    if (existsSync(WINDOWS_ENGINE_PIPE)) {
      return { available: true, reason: 'Docker engine named pipe present' };
    }
    return { available: false, reason: 'no Docker engine named pipe and no DOCKER_HOST' };
  }
  if (existsSync(DEFAULT_UNIX_SOCKET)) {
    return { available: true, reason: `Docker socket present at ${DEFAULT_UNIX_SOCKET}` };
  }
  return {
    available: false,
    reason: `no Docker socket at ${DEFAULT_UNIX_SOCKET} and no DOCKER_HOST`,
  };
}
