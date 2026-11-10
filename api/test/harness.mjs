import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, '../server.js');

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

export function createTempDataDir({ users = [], secret = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-test-'));
  const sec = secret || crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'secret'), sec, { mode: 0o600 });
  const db = { users, creds: [], subs: [], invites: [] };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db));
  return { dir, secret: sec };
}

export function makeSessionToken(user, secret, days = 90) {
  const u = typeof user === 'string' ? { id: user, sv: 0 } : user;
  const exp = Date.now() + days * 86400000;
  const payload = `${u.id}:${exp}:${u.sv || 0}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function makeSessionCookie(user, secret, days = 90) {
  return `gymsid=${makeSessionToken(user, secret, days)}`;
}

export async function spawnServer(options = {}) {
  const port = options.port ?? (await getFreePort());
  let dataDir = options.dataDir;
  let secret = options.secret;
  let autoCreated = false;

  if (!dataDir) {
    const res = createTempDataDir({ users: options.users, secret });
    dataDir = res.dir;
    secret = res.secret;
    autoCreated = true;
  }

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const assignedPort = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString();
      const match = buf.match(/gym-api on :(\d+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.once('exit', (code, sig) =>
      reject(new Error(`Server exited early with code ${code} signal ${sig}`))
    );
  });

  const origin = `http://127.0.0.1:${assignedPort}`;

  async function stop() {
    if (child.exitCode !== null) return;
    return new Promise(resolve => {
      child.once('exit', (code, signal) => {
        if (autoCreated && options.cleanup !== false) {
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
        }
        resolve({ code, signal });
      });
      child.kill('SIGTERM');
    });
  }

  return {
    child,
    port: assignedPort,
    origin,
    dataDir,
    secret,
    fetch: (p, init = {}) => fetch(`${origin}${p}`, init),
    cookieFor: (u, days) => makeSessionCookie(u, secret, days),
    stop,
  };
}
