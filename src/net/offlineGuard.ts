import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

// "Nothing is uploaded" as CODE, not copy.
//
// The default audit needs no network: the registry ships in the package, the
// repository is read from disk, and the report is printed. This guard makes
// that a hard property of the process rather than a promise: once installed,
// any attempt to open a socket, resolve a name, or call fetch() throws with a
// message that names the operation. It is installed by `--offline` or
// MENDR_OFFLINE=1, and the test suite installs it around the default audit to
// prove the claim on every build (src/audit/noNetwork.test.ts).
//
// It cannot make the customer's OWN commands offline: `fix-llm` gates run the
// repository's test/eval command in a temp copy, and that subprocess inherits
// the environment, not this in-process guard. That is documented in TRUST.md.

export const OFFLINE_MESSAGE =
  'mendr --offline: outbound network access is disabled in this process. The default audit never needs it; ' +
  'the optional provider usage read, verify-registry and a GitHub-URL clone do. Remove --offline / MENDR_OFFLINE to allow them.';

let installed = false;

/** Why the guard fired, for tests and error text. */
export class OfflineViolation extends Error {
  constructor(public readonly operation: string) {
    super(`${OFFLINE_MESSAGE} (blocked: ${operation})`);
    this.name = 'OfflineViolation';
  }
}

/** Install the guard once for the current process. Idempotent. */
export function installOfflineGuard(): void {
  if (installed) return;
  installed = true;
  const block = (operation: string) => (): never => {
    throw new OfflineViolation(operation);
  };
  // fetch (undici) — the one outbound call in mendr's own source.
  (globalThis as { fetch?: unknown }).fetch = async (...args: unknown[]): Promise<never> => {
    const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : 'fetch';
    throw new OfflineViolation(`fetch ${String(target).slice(0, 120)}`);
  };
  // Node's HTTP stacks.
  http.request = block('http.request') as unknown as typeof http.request;
  http.get = block('http.get') as unknown as typeof http.get;
  https.request = block('https.request') as unknown as typeof https.request;
  https.get = block('https.get') as unknown as typeof https.get;
  // Raw sockets and TLS. Local IPC (named pipes / unix sockets, e.g. a tool
  // runner talking to its parent process) is not the network, so only TCP
  // connections are blocked.
  const originalCreateConnection = net.createConnection;
  const isIpc = (a: unknown): boolean =>
    (typeof a === 'string' && !/^\d+$/.test(a)) ||
    (a !== null && typeof a === 'object' && typeof (a as { path?: unknown }).path === 'string' && (a as { port?: unknown }).port === undefined);
  const guardedConnect = function (this: unknown, ...args: unknown[]): net.Socket {
    if (isIpc(args[0])) return (originalCreateConnection as unknown as (...a: unknown[]) => net.Socket).apply(net, args);
    throw new OfflineViolation('net.connect');
  };
  net.connect = guardedConnect as unknown as typeof net.connect;
  net.createConnection = guardedConnect as unknown as typeof net.createConnection;
  tls.connect = block('tls.connect') as unknown as typeof tls.connect;
  // Name resolution — a request that never resolves cannot be sent.
  dns.lookup = block('dns.lookup') as unknown as typeof dns.lookup;
  dns.resolve = block('dns.resolve') as unknown as typeof dns.resolve;
  dns.resolve4 = block('dns.resolve4') as unknown as typeof dns.resolve4;
  dns.resolve6 = block('dns.resolve6') as unknown as typeof dns.resolve6;
  dns.promises.lookup = block('dns.promises.lookup') as unknown as typeof dns.promises.lookup;
  dns.promises.resolve = block('dns.promises.resolve') as unknown as typeof dns.promises.resolve;
}

/** Is the guard active? */
export function isOffline(): boolean {
  return installed;
}
