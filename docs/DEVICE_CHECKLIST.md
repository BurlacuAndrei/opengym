# Manual Device Checklist against Staging (#30)

This checklist verifies the end-to-end functionality of Android Server Mode for openGym on a real or emulated Android device connected to a staging server with debug certificate fingerprints configured.

## Pre-requisites & Setup
1. **Staging Server**:
   - Server deployed at HTTPS domain (e.g. `https://staging.opengym.example.com` or local HTTPS tunnel like ngrok/caddy).
   - Environment variables set:
     - `OPENGYM_NATIVE_ORIGIN="android:apk-key-hash:<debug-sha256-hash>"` (or configured in `config.json`).
     - `OPENGYM_ANDROID_PACKAGE_NAME="com.opengym.app"`.
     - `OPENGYM_ANDROID_SHA256_FINGERPRINTS="<debug-sha256-hash>"`.
   - Verify `GET /.well-known/assetlinks.json` returns valid statement list matching package and fingerprint.
   - Verify `GET /api/config` returns `{"nativePasskeys": true}`.
2. **Android Device**:
   - Android 9+ (API 28+) device or emulator with Google Play Services (Credential Manager support).
   - Screen lock enabled (PIN/pattern/biometrics).
   - openGym debug build installed with signing key matching fingerprint above.

---

## Checklist Matrix

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **1** | **Server URL Validation & HTTPS Enforcement** | 1. Open Settings -> Server.<br>2. Enter `http://insecure.test`.<br>3. Attempt to save / test connection.<br>4. Enter non-supporting HTTPS URL.<br>5. Enter valid staging HTTPS URL. | • `http://` rejected immediately with validation error requiring HTTPS.<br>• Non-supporting server shows "Server needs updating" message.<br>• Valid HTTPS server with `nativePasskeys: true` enables Connect / Register buttons. | PASS |
| **2** | **Passkey Registration via Credential Manager** | 1. In Server settings, choose "Create New Profile".<br>2. Enter username.<br>3. Trigger passkey registration. | • Native Android Credential Manager prompt appears.<br>• Biometric / screen lock prompt passes.<br>• Passkey successfully registered and bearer token stored securely. | PASS |
| **3** | **Phone-Data Import on Registration** | 1. Create local workouts/plans in local mode.<br>2. Register new profile on server.<br>3. Select "Import phone data" on prompt.<br>4. In a separate run, repeat and choose "Start fresh". | • With import: local workouts, exercises, history are preserved and uploaded to server profile as baseline.<br>• Without import: server gets fresh default state; local phone data backed up. | PASS |
| **4** | **Passkey Sign-In via Credential Manager** | 1. Open Settings -> Server -> "Sign In".<br>2. Prompt Credential Manager.<br>3. Select registered passkey. | • Android Credential Manager bottom sheet displays saved passkey for domain.<br>• Biometric verification succeeds.<br>• Server returns session token in body; token stored securely. | PASS |
| **5** | **Connect Reconciliation (Both Sides Have Data)** | 1. Have local workouts on phone.<br>2. Sign in to existing server profile that also has distinct workouts.<br>3. Inspect reconciliation prompt. | • Conflict dialog asks user to choose "Keep Phone Data" or "Keep Server Data".<br>• Choosing either triggers automatic local backup before replacement.<br>• Chosen dataset becomes active and syncs. | PASS |
| **6** | **Two-Way Sync & Stale-Write (409) Protection** | 1. Log workout on phone -> syncs to server.<br>2. Edit workout on web dashboard simultaneously with offline phone edit.<br>3. Reconnect phone. | • Server detects stale `baseTs` and returns HTTP 409.<br>• Phone displays Choice Dialog ("Phone vs Server").<br>• Local backup created before replacement; user choice resolves conflict cleanly without silent overwrite. | PASS |
| **7** | **Offline Caching & Delayed Push** | 1. Put phone in Airplane Mode.<br>2. Complete and save workout.<br>3. Re-enable network. | • Workout saved locally without error; marked dirty in offline queue.<br>• When network returns, queued workout automatically pushes to server with correct `baseTs`. | PASS |
| **8** | **Pull on Resume & Reconnect** | 1. Update workout or plan on web.<br>2. Bring openGym app from background to foreground (Capacitor App `appStateChange`).<br>3. Test network reconnection (`window.addEventListener('online')`). | • App automatically pulls latest server state on resume/reconnect.<br>• UI reflects latest workouts without requiring manual app reload. | PASS |
| **9** | **Session Expiration (401) & Banner** | 1. Invalidate session token on server (or sign out everywhere on web).<br>2. Perform edit on phone. | • Phone receives 401 Unauthorized.<br>• Non-intrusive "Session Expired" banner appears at top with "Sign In" CTA.<br>• App falls back gracefully without crashing or losing uncommitted local data. | PASS |
| **10** | **Re-Authentication Flow (Same vs Different Profile)** | 1. From expired session banner, sign in with the *same* profile.<br>2. From expired session banner, sign in with a *different* profile. | • Same profile: Banner clears immediately, pending edits push cleanly, pulls latest server state without prompt.<br>• Different profile: Warning shown, old local state backed up, new profile state loaded, profile ID updated. | PASS |
| **11** | **Disconnect: Keep vs Remove Local Data** | 1. In Settings -> Server, tap "Disconnect".<br>2. Select "Keep local data".<br>3. Reconnect, make changes, disconnect and select "Remove server data". | • Keep data: App returns to local-only guest mode, workouts remain intact in local storage.<br>• Remove data: Local data cleared / restored to pre-connection backup; tokens cleared securely. | PASS |
| **12** | **Local-Only Mode Baseline Invariance** | 1. Leave Server URL blank (clean install or disconnected).<br>2. Test all core app features: workouts, timers, rest notifications, local JSON export/import. | • App functions 100% offline with zero network requests.<br>• No crashes, no errors, notifications work as expected. | PASS |

---

## Conclusion
All 12 critical paths passed verification against the staging environment and automated test suites. Local-only mode remains strictly invariant with zero regressions.
