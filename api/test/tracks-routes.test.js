import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, describe } from 'node:test';
import { spawnServer } from './harness.mjs';

describe('/api/tracks and /api/routes endpoints (Issue #40)', () => {
  test('authentication: requires cookie or bearer token, rejects missing or invalid auth', async () => {
    const user = { id: 'u_auth_test', name: 'Runner One', sv: 0 };
    const srv = await spawnServer({ users: [user] });

    try {
      // 1. Missing auth -> 401
      const noAuth = await srv.fetch('/api/tracks');
      assert.equal(noAuth.status, 401);

      // 2. Invalid cookie -> 401
      const badCookie = await srv.fetch('/api/tracks', {
        headers: { Cookie: 'gymsid=bad.token.signature' },
      });
      assert.equal(badCookie.status, 401);

      // 3. Valid cookie -> 200
      const cookie = srv.cookieFor(user);
      const cookieAuth = await srv.fetch('/api/tracks', {
        headers: { Cookie: cookie },
      });
      assert.equal(cookieAuth.status, 200);
      const dataCookie = await cookieAuth.json();
      assert.deepEqual(dataCookie.tracks, []);
      assert.deepEqual(dataCookie.routes, []);

      // 4. Valid Bearer token -> 200
      const token = srv.tokenFor(user);
      const bearerAuth = await srv.fetch('/api/tracks', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(bearerAuth.status, 200);
      const dataBearer = await bearerAuth.json();
      assert.deepEqual(dataBearer.tracks, []);
      assert.deepEqual(dataBearer.routes, []);
    } finally {
      await srv.stop();
    }
  });

  test('strict ID validation and path traversal protection', async () => {
    const user = { id: 'u_trav_test', name: 'Runner Traversal', sv: 0 };
    const srv = await spawnServer({ users: [user] });
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(user)}`,
    };

    try {
      const maliciousIds = [
        '..%2F..%2Fetc%2Fpasswd',
        '..',
        'foo%2Fbar',
        'track.json',
        'track with spaces',
        'track@special!#',
        'foo\\bar',
      ];

      for (const id of maliciousIds) {
        // PUT should be rejected with 400 or 404
        const putRes = await srv.fetch(`/api/tracks/${id}`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ points: [{ lat: 45, lng: 9 }] }),
        });
        assert.ok(
          putRes.status === 400 || putRes.status === 404,
          `Expected 400 or 404 for malicious id "${id}", got ${putRes.status}`
        );

        // GET should be rejected with 400 or 404
        const getRes = await srv.fetch(`/api/tracks/${id}`, {
          method: 'GET',
          headers: authHeaders,
        });
        assert.ok(
          getRes.status === 400 || getRes.status === 404,
          `Expected 400 or 404 for malicious id "${id}", got ${getRes.status}`
        );

        // DELETE should be rejected with 400 or 404
        const delRes = await srv.fetch(`/api/tracks/${id}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        assert.ok(
          delRes.status === 400 || delRes.status === 404,
          `Expected 400 or 404 for malicious id "${id}", got ${delRes.status}`
        );
      }
    } finally {
      await srv.stop();
    }
  });

  test('tracks and routes CRUD + compact JSON storage in user subdirectory', async () => {
    const user = { id: 'u_crud_test', name: 'Runner CRUD', sv: 0 };
    const srv = await spawnServer({ users: [user] });
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(user)}`,
    };

    try {
      const track1 = {
        name: 'Morning Trail Run',
        recordedAt: '2026-07-11T08:00:00Z',
        distanceM: 5200,
        points: [
          { lat: 46.01, lng: 8.95, ele: 275 },
          { lat: 46.02, lng: 8.96, ele: 310 },
        ],
      };

      const route1 = {
        name: 'Lake Loop 10k',
        waypoints: [
          { lat: 46.01, lng: 8.95 },
          { lat: 46.05, lng: 8.99 },
        ],
      };

      // 1. PUT track-1
      const putTrackRes = await srv.fetch('/api/tracks/track-1', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(track1),
      });
      assert.equal(putTrackRes.status, 200);
      const putTrackBody = await putTrackRes.json();
      assert.equal(putTrackBody.ok, true);
      assert.equal(putTrackBody.id, 'track-1');

      // Verify file on disk is compact JSON under users/<uid>/tracks/track-1.json
      const trackFile = path.join(srv.dataDir, 'users', user.id, 'tracks', 'track-1.json');
      assert.ok(fs.existsSync(trackFile), 'Track file exists on disk');
      const rawTrack = fs.readFileSync(trackFile, 'utf8');
      assert.equal(rawTrack, JSON.stringify(track1), 'Track is stored as compact JSON');

      // 2. PUT route-1
      const putRouteRes = await srv.fetch('/api/routes/route-1', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(route1),
      });
      assert.equal(putRouteRes.status, 200);

      const routeFile = path.join(srv.dataDir, 'users', user.id, 'routes', 'route-1.json');
      assert.ok(fs.existsSync(routeFile), 'Route file exists on disk');
      const rawRoute = fs.readFileSync(routeFile, 'utf8');
      assert.equal(rawRoute, JSON.stringify(route1), 'Route is stored as compact JSON');

      // 3. GET /api/tracks lists both stored track IDs and route IDs
      const listRes = await srv.fetch('/api/tracks', { headers: authHeaders });
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.deepEqual(listData.tracks, ['track-1']);
      assert.deepEqual(listData.routes, ['route-1']);

      // 4. GET /api/tracks/:id returns stored track
      const getTrackRes = await srv.fetch('/api/tracks/track-1', { headers: authHeaders });
      assert.equal(getTrackRes.status, 200);
      const getTrackData = await getTrackRes.json();
      assert.deepEqual(getTrackData, track1);

      // 5. GET /api/routes/:id returns stored route
      const getRouteRes = await srv.fetch('/api/routes/route-1', { headers: authHeaders });
      assert.equal(getRouteRes.status, 200);
      const getRouteData = await getRouteRes.json();
      assert.deepEqual(getRouteData, route1);

      // 6. DELETE /api/tracks/:id deletes track
      const delTrackRes = await srv.fetch('/api/tracks/track-1', {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(delTrackRes.status, 200);
      assert.ok(!fs.existsSync(trackFile), 'Track file removed from disk');

      // Subsequent GET returns 404
      const getDeletedTrack = await srv.fetch('/api/tracks/track-1', { headers: authHeaders });
      assert.equal(getDeletedTrack.status, 404);

      // Subsequent DELETE returns 404
      const delAgainTrack = await srv.fetch('/api/tracks/track-1', {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(delAgainTrack.status, 404);

      // 7. DELETE /api/routes/:id deletes route
      const delRouteRes = await srv.fetch('/api/routes/route-1', {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(delRouteRes.status, 200);
      assert.ok(!fs.existsSync(routeFile), 'Route file removed from disk');

      const getDeletedRoute = await srv.fetch('/api/routes/route-1', { headers: authHeaders });
      assert.equal(getDeletedRoute.status, 404);
    } finally {
      await srv.stop();
    }
  });

  test('user isolation: users cannot see or modify other users tracks and routes', async () => {
    const userA = { id: 'u_user_a', name: 'User A', sv: 0 };
    const userB = { id: 'u_user_b', name: 'User B', sv: 0 };
    const srv = await spawnServer({ users: [userA, userB] });

    const headersA = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(userA)}`,
    };
    const headersB = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(userB)}`,
    };

    try {
      // User A creates track-a
      await srv.fetch('/api/tracks/track-a', {
        method: 'PUT',
        headers: headersA,
        body: JSON.stringify({ name: 'User A Track' }),
      });

      // User B lists tracks -> should be empty
      const listB = await srv.fetch('/api/tracks', { headers: headersB });
      const dataB = await listB.json();
      assert.deepEqual(dataB.tracks, []);

      // User B tries to GET User A's track -> 404
      const getB = await srv.fetch('/api/tracks/track-a', { headers: headersB });
      assert.equal(getB.status, 404);

      // User B tries to DELETE User A's track -> 404
      const delB = await srv.fetch('/api/tracks/track-a', {
        method: 'DELETE',
        headers: headersB,
      });
      assert.equal(delB.status, 404);

      // User A's track is still intact
      const getA = await srv.fetch('/api/tracks/track-a', { headers: headersA });
      assert.equal(getA.status, 200);
    } finally {
      await srv.stop();
    }
  });

  test('POST /api/tracks/prune: bulk deletion by cutoff and explicit ID list', async () => {
    const user = { id: 'u_prune_test', name: 'Runner Prune', sv: 0 };
    const srv = await spawnServer({ users: [user] });
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(user)}`,
    };

    try {
      // Create 4 tracks with different timestamps
      await srv.fetch('/api/tracks/t_old_1', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ recordedAt: '2026-01-01T00:00:00Z', name: 'Old Track 1' }),
      });
      await srv.fetch('/api/tracks/t_old_2', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ recordedAt: '2026-02-01T00:00:00Z', name: 'Old Track 2' }),
      });
      await srv.fetch('/api/tracks/t_recent_1', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ recordedAt: '2026-06-01T00:00:00Z', name: 'Recent Track 1' }),
      });
      await srv.fetch('/api/tracks/t_recent_2', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ recordedAt: '2026-07-01T00:00:00Z', name: 'Recent Track 2' }),
      });

      // 1. Prune by cutoff: older than 2026-03-01 should prune t_old_1 and t_old_2
      const pruneCutoffRes = await srv.fetch('/api/tracks/prune', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ cutoff: '2026-03-01T00:00:00Z' }),
      });
      assert.equal(pruneCutoffRes.status, 200);
      const pruneCutoffData = await pruneCutoffRes.json();
      assert.equal(pruneCutoffData.ok, true);
      assert.deepEqual(pruneCutoffData.deleted.sort(), ['t_old_1', 't_old_2']);
      assert.equal(pruneCutoffData.count, 2);

      // Verify list now only has recent tracks
      const listAfterCutoff = await srv.fetch('/api/tracks', { headers: authHeaders });
      const dataAfterCutoff = await listAfterCutoff.json();
      assert.deepEqual(dataAfterCutoff.tracks.sort(), ['t_recent_1', 't_recent_2']);

      // 2. Prune by explicit ID list: prune t_recent_1
      const pruneIdsRes = await srv.fetch('/api/tracks/prune', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ids: ['t_recent_1'] }),
      });
      assert.equal(pruneIdsRes.status, 200);
      const pruneIdsData = await pruneIdsRes.json();
      assert.equal(pruneIdsData.ok, true);
      assert.deepEqual(pruneIdsData.deleted, ['t_recent_1']);
      assert.equal(pruneIdsData.count, 1);

      // Verify list now only has t_recent_2
      const listFinal = await srv.fetch('/api/tracks', { headers: authHeaders });
      const dataFinal = await listFinal.json();
      assert.deepEqual(dataFinal.tracks, ['t_recent_2']);
    } finally {
      await srv.stop();
    }
  });

  test('payload validation and reasonable size limit', async () => {
    const user = { id: 'u_limit_test', name: 'Runner Limits', sv: 0 };
    // Set a lower MAX_TRACK_SIZE for fast testing without huge allocations
    const srv = await spawnServer({
      users: [user],
      env: { MAX_TRACK_SIZE: '10240' }, // 10 KB
    });
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(user)}`,
    };

    try {
      // 1. Invalid JSON body -> 400
      const badJson = await srv.fetch('/api/tracks/t_bad_json', {
        method: 'PUT',
        headers: authHeaders,
        body: '{not: valid json',
      });
      assert.equal(badJson.status, 400);

      // 2. Overly large payload exceeding limit -> 413
      const largePayload = {
        name: 'Huge Track',
        data: 'x'.repeat(20480), // 20 KB > 10 KB
      };
      const largeRes = await srv.fetch('/api/tracks/t_huge', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(largePayload),
      });
      assert.equal(largeRes.status, 413);
    } finally {
      await srv.stop();
    }
  });

  test('user tracks/routes directory can be wiped on account cleanup', async () => {
    const user = { id: 'u_cleanup_test', name: 'Runner Cleanup', sv: 0 };
    const srv = await spawnServer({ users: [user] });
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.tokenFor(user)}`,
    };

    try {
      await srv.fetch('/api/tracks/track-del', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ name: 'To be wiped' }),
      });
      await srv.fetch('/api/routes/route-del', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ name: 'To be wiped route' }),
      });

      const userDir = path.join(srv.dataDir, 'users', user.id);
      assert.ok(fs.existsSync(userDir), 'User directory exists before cleanup');

      // Cleanup user tracks/routes
      fs.rmSync(userDir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(userDir), 'User directory cleaned up');

      const listRes = await srv.fetch('/api/tracks', { headers: authHeaders });
      const listData = await listRes.json();
      assert.deepEqual(listData.tracks, []);
      assert.deepEqual(listData.routes, []);
    } finally {
      await srv.stop();
    }
  });
});
