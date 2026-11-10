import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { getFreePort, makeSessionCookie, spawnServer } from './harness.mjs';

describe('server test harness & baseline API', () => {
  test('free port allocation and clean SIGTERM shutdown', async () => {
    const port = await getFreePort();
    assert.ok(port > 0, 'allocated port should be positive');

    const srv = await spawnServer({ port });
    assert.equal(srv.port, port);
    assert.ok(fs.existsSync(path.join(srv.dataDir, 'secret')), 'secret file generated');

    const res = await srv.fetch('/api/config');
    assert.equal(res.status, 200);

    const exitInfo = await srv.stop();
    assert.ok(exitInfo.code === 0 || exitInfo.signal === 'SIGTERM');
  });

  test('GET /api/me authentication flow', async () => {
    const user = { id: 'u_test_1', name: 'Lifter One', sv: 0 };
    const srv = await spawnServer({ users: [user] });

    try {
      // 1. Missing cookie -> 401
      const noAuth = await srv.fetch('/api/me');
      assert.equal(noAuth.status, 401);

      // 2. Invalid cookie -> 401
      const badAuth = await srv.fetch('/api/me', {
        headers: { Cookie: 'gymsid=invalid.sig' },
      });
      assert.equal(badAuth.status, 401);

      // 3. Valid cookie -> 200
      const cookie = srv.cookieFor(user);
      const goodAuth = await srv.fetch('/api/me', {
        headers: { Cookie: cookie },
      });
      assert.equal(goodAuth.status, 200);
      const data = await goodAuth.json();
      assert.deepEqual(data, {
        user: { id: user.id, name: user.name, admin: false },
      });
    } finally {
      await srv.stop();
    }
  });

  test('GET /api/data and PUT /api/data with active field stripping', async () => {
    const user = { id: 'u_test_2', name: 'Lifter Two', sv: 0 };
    const srv = await spawnServer({ users: [user] });
    const cookie = srv.cookieFor(user);

    try {
      // 1. Unauthenticated -> 401
      const unauthGet = await srv.fetch('/api/data');
      assert.equal(unauthGet.status, 401);

      const unauthPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: {} }),
      });
      assert.equal(unauthPut.status, 401);

      // 2. Initial state -> null
      const initGet = await srv.fetch('/api/data', {
        headers: { Cookie: cookie },
      });
      assert.equal(initGet.status, 200);
      const initData = await initGet.json();
      assert.equal(initData.state, null);

      // 3. Bad body -> 400
      const badPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notState: true }),
      });
      assert.equal(badPut.status, 400);

      // 4. PUT state with active field
      const clientState = {
        _ts: 1700000000,
        routines: [{ id: 'r1', name: 'Squat Day' }],
        active: { routineId: 'r1', startedAt: 1700000100 },
      };

      const putRes = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: clientState }),
      });
      assert.equal(putRes.status, 200);
      const putData = await putRes.json();
      assert.deepEqual(putData, { ok: true, ts: clientState._ts });

      // 5. Subsequent GET confirms active field was stripped
      const fetchGet = await srv.fetch('/api/data', {
        headers: { Cookie: cookie },
      });
      assert.equal(fetchGet.status, 200);
      const fetched = await fetchGet.json();
      assert.equal(fetched.state._ts, 1700000000);
      assert.deepEqual(fetched.state.routines, clientState.routines);
      assert.equal(fetched.state.active, undefined, 'active field must be stripped');

      // 6. Direct file check on disk
      const saved = JSON.parse(
        fs.readFileSync(path.join(srv.dataDir, `state-${user.id}.json`), 'utf8')
      );
      assert.equal(saved.active, undefined, 'disk state must not contain active');
    } finally {
      await srv.stop();
    }
  });
});
