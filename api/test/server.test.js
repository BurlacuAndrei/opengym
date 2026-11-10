import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { certFingerprintToApkOrigin, getFreePort, makeSessionCookie, spawnServer } from './harness.mjs';

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

  test('PUT /api/data stale state write rejection with 409 (#4)', async () => {
    const user = { id: 'u_conflict_test', name: 'Conflict Lifter', sv: 0 };
    const srv = await spawnServer({ users: [user] });

    try {
      const cookie = srv.cookieFor(user);

      // 1. Initial write with no stored state -> succeeds
      const initialPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { _ts: 1000, name: 'Initial' }, baseTs: 0 }),
      });
      assert.equal(initialPut.status, 200);

      // 2. Mismatched baseTs -> 409 conflict, returns stored state, disk unchanged
      const conflictPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { _ts: 2000, name: 'Stale update' }, baseTs: 999 }),
      });
      assert.equal(conflictPut.status, 409);
      const conflictData = await conflictPut.json();
      assert.equal(conflictData.error, 'conflict');
      assert.equal(conflictData.state._ts, 1000);
      assert.equal(conflictData.state.name, 'Initial');

      const diskCheck = JSON.parse(
        fs.readFileSync(path.join(srv.dataDir, `state-${user.id}.json`), 'utf8')
      );
      assert.equal(diskCheck.name, 'Initial', 'file unchanged on conflict');

      // 3. Matching baseTs -> succeeds
      const matchingPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { _ts: 1001, name: 'Updated' }, baseTs: 1000 }),
      });
      assert.equal(matchingPut.status, 200);

      // 4. Missing baseTs -> legacy write succeeds
      const legacyPut = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { _ts: 1002, name: 'Legacy' } }),
      });
      assert.equal(legacyPut.status, 200);

      const finalCheck = JSON.parse(
        fs.readFileSync(path.join(srv.dataDir, `state-${user.id}.json`), 'utf8')
      );
      assert.equal(finalCheck.name, 'Legacy');
    } finally {
      await srv.stop();
    }
  });

  test('GET /api/config native passkey capability flag (#8)', async () => {
    // 1. Unconfigured server: response has no 'native' key
    const srvUnconfigured = await spawnServer();
    try {
      const res = await srvUnconfigured.fetch('/api/config');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal('native' in data, false, 'unconfigured config has no native key');
      assert.deepEqual(data, { invite_only: false });
    } finally {
      await srvUnconfigured.stop();
    }

    // 2. Configured server: response includes native: { rpId }
    const sampleCert = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
    const srvConfigured = await spawnServer({
      env: {
        ANDROID_PACKAGE: 'ch.duartesantos.opengym',
        ANDROID_CERT_SHA256: sampleCert,
        RP_ID: 'example.com',
      },
    });
    try {
      const res = await srvConfigured.fetch('/api/config');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.native, 'configured config has native object');
      assert.equal(data.native.rpId, 'example.com');
    } finally {
      await srvConfigured.stop();
    }
  });

  test('Bearer session tokens accepted on /api/me and /api/data (#11)', async () => {
    const user = { id: 'u_bearer_test', name: 'Bearer Lifter', sv: 0 };
    const srv = await spawnServer({ users: [user] });

    try {
      const validToken = srv.tokenFor(user);

      // 1. Bearer token works on /api/me
      const meRes = await srv.fetch('/api/me', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(meRes.status, 200);
      const meData = await meRes.json();
      assert.equal(meData.user.id, user.id);

      // 2. Bearer token works on PUT /api/data and GET /api/data
      const putRes = await srv.fetch('/api/data', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: { _ts: 5000, name: 'Bearer State' } }),
      });
      assert.equal(putRes.status, 200);

      const getRes = await srv.fetch('/api/data', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.state.name, 'Bearer State');

      // 3. Expired token rejected with 401
      const expiredToken = srv.tokenFor(user, -1); // expired 1 day ago
      const expRes = await srv.fetch('/api/me', {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.equal(expRes.status, 401);

      // 4. Token predating "sign out everywhere" rejected
      // User signs out everywhere via cookie/bearer on POST /api/logout/all
      const logoutAllRes = await srv.fetch('/api/logout/all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(logoutAllRes.status, 200);

      // Old token now has version 0, but user.sv is now 1 -> rejected with 401
      const staleTokenRes = await srv.fetch('/api/me', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(staleTokenRes.status, 401);

      // 5. Cookie session still works with updated user version
      user.sv = 1;
      const newCookie = srv.cookieFor(user);
      const cookieRes = await srv.fetch('/api/me', {
        headers: { Cookie: newCookie },
      });
      assert.equal(cookieRes.status, 200);
    } finally {
      await srv.stop();
    }
  });

  test('GET /.well-known/assetlinks.json (#9)', async () => {
    // 1. Unconfigured server -> 404
    const srvUnconf = await spawnServer();
    try {
      const res = await srvUnconf.fetch('/.well-known/assetlinks.json');
      assert.equal(res.status, 404);
    } finally {
      await srvUnconf.stop();
    }

    // 2. Configured server -> 200 with AssetLinks statement array
    const sampleFp = '14:6D:E9:D5:70:E4:F7:CC:37:A8:12:4A:BA:36:27:C5:3B:56:59:75:A0:92:DF:D3:59:C2:59:F0:45:1E:AE:12';
    const srvConf = await spawnServer({
      env: {
        ANDROID_PACKAGE: 'ch.duartesantos.opengym',
        ANDROID_CERT_SHA256: sampleFp,
      },
    });
    try {
      const res = await srvConf.fetch('/.well-known/assetlinks.json');
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('application/json'));
      const list = await res.json();
      assert.ok(Array.isArray(list));
      assert.equal(list.length, 1);
      assert.deepEqual(list[0].relation, [
        'delegate_permission/common.handle_all_urls',
        'delegate_permission/common.get_login_creds',
      ]);
      assert.equal(list[0].target.namespace, 'android_app');
      assert.equal(list[0].target.package_name, 'ch.duartesantos.opengym');
      assert.deepEqual(list[0].target.sha256_cert_fingerprints, [sampleFp]);
    } finally {
      await srvConf.stop();
    }
  });

  test('certFingerprintToApkOrigin conversion and passkey origin acceptance (#10)', async () => {
    // 1. Unit conversion test
    const hexFp = '14:6D:E9:D5:70:E4:F7:CC:37:A8:12:4A:BA:36:27:C5:3B:56:59:75:A0:92:DF:D3:59:C2:59:F0:45:1E:AE:12';
    const origin = certFingerprintToApkOrigin(hexFp);
    assert.ok(origin.startsWith('android:apk-key-hash:'));
    const b64u = origin.slice('android:apk-key-hash:'.length);
    assert.equal(Buffer.from(b64u, 'base64url').toString('hex'), hexFp.replace(/:/g, '').toLowerCase());

    // 2. Web login options and verify route accepts web ORIGIN
    const srv = await spawnServer();
    try {
      const optRes = await srv.fetch('/api/login/options', { method: 'POST', body: '{}' });
      assert.equal(optRes.status, 200);
      const { cid, options } = await optRes.json();
      assert.ok(cid);
      assert.ok(options.challenge);
    } finally {
      await srv.stop();
    }
  });
});
