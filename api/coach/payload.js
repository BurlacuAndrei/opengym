/* What actually leaves this server.
 *
 * The consent screen makes a promise about which categories of data reach the provider, and
 * this file is where that promise is either kept or quietly broken. So it is built as an
 * allowlist: every field is copied in by name. Nothing is spread, nothing is passed through,
 * and a field added to the state blob next year cannot ride along by accident — which is the
 * property the FR-11 test actually asserts.
 *
 * Excluded on purpose and permanently: the profile's display name and user id (an opaque
 * handle stands in), passkey and credential material, push subscriptions, invite data, theme
 * and appearance settings, and every other profile's everything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as shared from '../../shared/coach/payload.js';

const DATA = process.env.DATA_DIR || '/data';

/** Stable per-profile pseudonym. Never the uid, never reversible, same across jobs. */
function handle(uid) {
  const secret = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  return crypto.createHmac('sha256', secret).update('coach-handle:' + uid).digest('base64url').slice(0, 16);
}

export function build(S, uid, opts = {}) {
  const h = opts.handle || handle(uid);
  return shared.build(S, uid, { ...opts, handle: h });
}

export {
  CONTRACT, MAX_WEEKS, MAX_SESSIONS, DATA_CATEGORIES,
  stallCount, canonicalPlan, cleanPlan, librarySlice,
  libraryHas, libraryName, LIBRARY, reviewWindow
} from '../../shared/coach/payload.js';
