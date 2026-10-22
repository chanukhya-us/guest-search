// ReadinessChecker (task 8.6; Req 22.9): cached, timeout-bounded TCP reachability probe.
import { describe, expect, it, vi } from 'vitest';

import { ReadinessChecker, type TcpConnector } from '../../src/health.js';

const ENDPOINT = new URL('http://soap.invalid:8080/InitiateService');

describe('ReadinessChecker', () => {
  it('reports config:true and the probe result', async () => {
    const checker = new ReadinessChecker({
      endpoint: ENDPOINT,
      connect: () => Promise.resolve(true),
    });
    expect(await checker.check()).toEqual({ config: true, soap: true });
  });

  it('reports soap:false when the connector fails', async () => {
    const checker = new ReadinessChecker({
      endpoint: ENDPOINT,
      connect: () => Promise.resolve(false),
    });
    expect((await checker.check()).soap).toBe(false);
  });

  it('caches the probe result within the 30 s window (one connect per window)', async () => {
    let clock = 0;
    const connect = vi.fn<TcpConnector>(() => Promise.resolve(true));
    const checker = new ReadinessChecker({ endpoint: ENDPOINT, connect, now: () => clock });

    await checker.check();
    await checker.check();
    clock = 29_999;
    await checker.check();
    expect(connect).toHaveBeenCalledTimes(1);

    // Past the window: a fresh probe runs.
    clock = 30_000;
    await checker.check();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('passes the host, derived port and timeout to the connector', async () => {
    const connect = vi.fn<TcpConnector>(() => Promise.resolve(true));
    const checker = new ReadinessChecker({
      endpoint: new URL('https://host.invalid/x'),
      connect,
      timeoutMs: 1_000,
    });
    await checker.check();
    // https with no explicit port → 443.
    expect(connect).toHaveBeenCalledWith('host.invalid', 443, 1_000);
  });

  it('uses a real TCP probe when no connector is injected (closed port → soap:false)', async () => {
    // Port 1 is almost never open; the real connector should fail fast and report soap:false.
    const checker = new ReadinessChecker({
      endpoint: new URL('http://127.0.0.1:1/'),
      timeoutMs: 500,
    });
    expect((await checker.check()).soap).toBe(false);
  });

  it('collapses concurrent cache-miss probes onto one connect', async () => {
    let resolveConnect: (v: boolean) => void = () => undefined;
    const connect = vi.fn<TcpConnector>(
      () => new Promise<boolean>((res) => (resolveConnect = res)),
    );
    const checker = new ReadinessChecker({ endpoint: ENDPOINT, connect });

    const a = checker.check();
    const b = checker.check();
    resolveConnect(true);
    expect((await a).soap).toBe(true);
    expect((await b).soap).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
