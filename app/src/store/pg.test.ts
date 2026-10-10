import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgStore, createPool, DB_TIMEOUT_MS } from './pg.js';

// No real Postgres here. Two fakes on localhost: a black hole that accepts the connection and
// never answers (what an expired or suspended database looks like from the App), and one that
// hangs up at once. The password in the URL is there to prove it never reaches a message.

const PASSWORD = 'hunter2-not-for-logs';
const open: { server: Server; sockets: Set<Socket> }[] = [];

async function fakePostgres(onConnection: (s: Socket) => void): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    onConnection(s);
  });
  open.push({ server, sockets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `postgres://mendr:${PASSWORD}@127.0.0.1:${(server.address() as AddressInfo).port}/mendr`;
}

const blackHole = () => fakePostgres(() => undefined);
const hangsUp = () => fakePostgres((s) => s.destroy());

afterEach(async () => {
  for (const { server, sockets } of open.splice(0)) {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('the database never hangs the App silently', () => {
  it('gives up on a database that never answers, with a sentence, instead of waiting forever', async () => {
    const url = await blackHole();
    const started = Date.now();
    const err = await createPgStore(url, null, 200).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Cannot reach the database at DATABASE_URL within 0.2 s. Check the connection string in the Render dashboard.');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('names the reason when the database hangs up, and never the connection string', async () => {
    const url = await hangsUp();
    const err = (await createPgStore(url, null, 5_000).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Cannot set up the database at DATABASE_URL \(.+\)\. Check the connection string in the Render dashboard\.$/);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).not.toContain(url);
  });

  it('bounds every connection at 10 s, not only the one at boot', async () => {
    const pool = createPool('postgres://mendr:x@127.0.0.1:1/mendr');
    expect(DB_TIMEOUT_MS).toBe(10_000);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    await pool.end();
  });

  it('logs an idle connection the database dropped instead of crashing the process', async () => {
    const lines: string[] = [];
    const pool = createPool(`postgres://mendr:${PASSWORD}@db.example.neon.tech/mendr`, 1_000, (m) => lines.push(m));
    // An 'error' event with no listener throws, which is what used to take the process down.
    expect(() => pool.emit('error', new Error(`terminating connection due to administrator command (postgres://mendr:${PASSWORD}@db)`))).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^The database closed an idle connection \(terminating connection due to administrator command/);
    expect(lines[0]).not.toContain(PASSWORD);
    await pool.end();
  });

  it('the server exits non-zero with one line, instead of never listening', async () => {
    const url = await hangsUp();
    const appDir = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: appDir,
      env: { ...process.env, DATABASE_URL: url, PORT: '0', MENDR_DATA_KEY: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stdout).not.toContain('listening');
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).toMatch(/^Cannot set up the database at DATABASE_URL \(.+\)\. Check the connection string in the Render dashboard\./);
    expect(stdout + stderr).not.toContain(PASSWORD);
  }, 30_000);
});
