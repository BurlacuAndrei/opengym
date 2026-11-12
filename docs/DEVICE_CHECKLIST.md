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

## Checklist Matrix (Server Mode - #30)

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

## Spec 1: Android GPS Activity Recording (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **13** | **Foreground Service & Continuous Location Updates** | 1. Start outdoor run or ride recording.<br>2. Verify persistent Android foreground notification appears.<br>3. Lock device and keep screen off for 10+ minutes during activity. | • Foreground service remains active and immune to Android background kill.<br>• GPS coordinates sampled continuously with zero dropped track gaps. | PASS |
| **14** | **Screen-Off GPS Sampling & Power Management** | 1. Start recording GPS activity.<br>2. Turn screen off and walk/cycle 1 km.<br>3. Inspect recorded points and timestamps in GPX/GeoJSON export. | • High-accuracy GPS sampling interval maintained with screen off.<br>• Android Doze mode does not starve location provider; no jump/teleport artifacts. | PASS |
| **15** | **Lockscreen Notification & Live Controls** | 1. Lock screen while activity recording is active.<br>2. View lockscreen tracking notification.<br>3. Tap Pause / Resume from notification. | • Lockscreen card displays live elapsed time, distance, and current pace.<br>• Controls respond instantaneously without requiring full phone unlock. | PASS |
| **16** | **Hold-to-Finish Protection** | 1. While recording, tap "Finish" button quickly.<br>2. Press and hold "Finish" button for full 1.5 seconds. | • Quick tap shows visual progress indicator or prompt, preventing accidental finish.<br>• Holding 1.5s completes activity and transitions to summary save screen. | PASS |
| **17** | **Crash Recovery from Append Log** | 1. Start GPS activity and record points.<br>2. Terminate app process via `am force-stop com.opengym.app`.<br>3. Re-launch openGym app. | • Crash recovery detects unfinished recording in persistent append log.<br>• Dialog prompts to resume or save; track points up to crash point fully restored. | PASS |

---

## Spec 2: Cardio Stats, Best Efforts & Route Following (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **18** | **Sliding Window Best Efforts & PR Badges** | 1. Complete run activity covering 5k and 10k faster than historical baseline.<br>2. Open saved activity summary. | • Sliding window best efforts calculator identifies new fastest 1k, 5k, or 10k segments.<br>• PR badges and trophies rendered on activity summary and profile PR shelf. | PASS |
| **19** | **Gear Mileage Tracking (Shoes & Bikes)** | 1. Create running shoes or bike in Settings -> Gear with retirement target.<br>2. Assign gear to completed cardio activity.<br>3. Inspect gear odometer. | • Cumulative distance accurately attributed to selected gear.<br>• Threshold warnings flag when gear reaches mileage limit; reassignment updates totals. | PASS |
| **20** | **GPX Route Breadcrumb Map Following** | 1. Import GPX route into route library.<br>2. Select "Follow Route" on map screen and begin movement. | • High-contrast breadcrumb polyline overlaid onto map.<br>• User position puck follows route path with heading orientation and auto-center. | PASS |
| **21** | **Remaining Climb & Elevation Profile** | 1. Follow route containing elevation variations.<br>2. Monitor HUD elevation panel. | • Real-time remaining distance and remaining climb (meters/feet) update dynamically.<br>• Elevation profile displays current progress marker along the vertical profile. | PASS |
| **22** | **100m Off-Course Alert with Throttled TTS** | 1. While following route, deviate more than 100m away from planned track.<br>2. Remain off-course for >30 seconds.<br>3. Return to path. | • Visual "Off Course" warning banner triggers promptly at 100m threshold.<br>• Spoken TTS alert announces deviation; alerts throttled to avoid repeated spamming.<br>• "Back on course" chime/speech sounds upon returning to path. | PASS |

---

## Spec 3: Activity & Route Server Sync (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **23** | **PUT /api/tracks/:id Upload & Sync** | 1. Complete GPS activity recording while connected to staging server.<br>2. Observe sync network traffic and server database. | • HTTP `PUT /api/tracks/:id` uploads track geometry, elevation, and metadata.<br>• Server stores track; returns HTTP 200/201; local track marked as synced. | PASS |
| **24** | **GET Lazy Download & Local Caching** | 1. Sign in to existing server profile on fresh device/browser.<br>2. Navigate to track list.<br>3. Select historical track. | • Track metadata and summary load in list view without full payload transfer.<br>• Selecting track triggers lazy GET for full coordinate points; cached locally in IndexedDB. | PASS |
| **25** | **DELETE / Prune Propagation** | 1. Delete track or route on phone or web dashboard.<br>2. Synchronize opposing client. | • DELETE operation propagates across devices.<br>• Track removed from server and pruned from local device storage without orphan records. | PASS |
| **26** | **Disconnect Data Removal** | 1. In Settings -> Server, select "Disconnect".<br>2. Choose "Remove server data". | • All server-synced tracks and routes deleted from local storage.<br>• Phone restored cleanly to guest state with server authentication tokens cleared. | PASS |
| **27** | **Single-File JSON Backup Bundling Tracks & Routes** | 1. Go to Settings -> Backup -> Export Data.<br>2. Inspect exported JSON structure.<br>3. Import into clean openGym instance. | • Single JSON backup file encapsulates workouts, history, tracks, and GPX routes.<br>• Import restores complete track points, route breadcrumbs, and stats without corruption. | PASS |

---

## Spec 4: Multi-Modality Planning & Structured Intervals (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **28** | **Cardio Sessions in Weekly Plan** | 1. Open Plan tab.<br>2. Add running and cycling sessions alongside strength workouts. | • Weekly calendar displays cardio sessions with distinct distance/time targets and modality icons.<br>• Plan overview accurately sums weekly cardio volume and strength sessions. | PASS |
| **29** | **Structured Interval Editor** | 1. Create new cardio workout -> Interval mode.<br>2. Add Warmup (5 min), Repeat Block (4x 400m fast @ target pace + 90s rest), Cooldown (5 min). | • Interval editor validates repeat counts, target paces, and time/distance triggers.<br>• Structured workout saves cleanly with full step hierarchy. | PASS |
| **30** | **Interval Execution State Machine** | 1. Start structured interval workout.<br>2. Progress through steps via elapsed time, target distance, or manual skip. | • State machine advances accurately between Warmup, Work, Rest, and Cooldown states.<br>• Next-step preview, progress bar, and countdown timers stay in exact sync. | PASS |
| **31** | **TTS Split & Transition Cues with Music Ducking** | 1. Start background music playback in external music player.<br>2. Execute structured workout with auto-split (1 km) and step transitions. | • Audio focus request temporarily ducks background music volume during speech.<br>• TTS voice announces step targets ("Fast run 400 meters") and split times clearly.<br>• Audio focus restores music volume to normal immediately after speech ends. | PASS |
| **32** | **Coach Cardio Planning Toggle & Validation** | 1. Open AI Coach settings; enable Cardio Planning.<br>2. Prompt Coach for half-marathon or 5k interval training plan.<br>3. Disable cardio toggle and request plan. | • Enabled: Coach generates structured interval sessions with valid pace and distance targets.<br>• Disabled: Coach focuses exclusively on strength/hypertrophy routines without cardio steps. | PASS |

---

## Spec 5: HIIT, Yoga & Mobility (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **33** | **Modality Kinds Categorization (HIIT, Yoga, Mobility)** | 1. Open Workout creator.<br>2. Inspect modality selector and session options. | • Modalities (Strength, Cardio, HIIT, Yoga, Mobility) clearly differentiated with visual cues.<br>• Appropriate target inputs displayed (reps/weight vs hold time/breath cycles/rounds). | PASS |
| **34** | **Custom restSec Overrides per Exercise** | 1. In a HIIT or mobility session, set global rest to 60s.<br>2. Set custom restSec override (20s) on specific high-intensity exercise.<br>3. Run workout. | • Overridden exercise triggers 20s rest timer countdown; other exercises use 60s.<br>• Timer display and notifications reflect customized rest value accurately. | PASS |
| **35** | **Free-Exercise-DB & Yoga-API Pose Library Integration** | 1. Search exercise database for "Burpee", "Downward Dog", and "Couch Stretch".<br>2. View exercise details and instructions. | • Multi-database catalog returns matched HIIT movements, yoga poses, and mobility drills.<br>• Includes target muscle groups, Sanskrit pose aliases, and step-by-step visual guidance. | PASS |
| **36** | **Freestyle Logger for Unstructured Sessions** | 1. Start Freestyle Yoga or Mobility session.<br>2. Add poses dynamically while timer is running.<br>3. Save workout. | • User can log movements, hold durations, and subjective notes on the fly without preset routine.<br>• Completed freestyle session logs to history with aggregate duration and movement list. | PASS |
| **37** | **Auto-Advancing Flow Player with Move Cues** | 1. Start pre-configured Yoga or Mobility flow in Flow Player.<br>2. Place phone on floor hands-free. | • Screen displays current pose, elapsed hold timer, and next pose preview.<br>• Audio chime/TTS signals transitions and player auto-advances to next movement. | PASS |
| **38** | **Coach Modality Toggles for Recovery Flows** | 1. In AI Coach settings, toggle on Yoga and Mobility recommendations.<br>2. Ask Coach for post-leg-day recovery suggestion. | • Coach prescribes targeted 15-minute mobility flow referencing specific hip and hamstring stretches.<br>• Respects user modality preferences when generating routine suggestions. | PASS |

---

## Spec 6: Shared Coach Core & Multi-Provider Architecture (#84)

| # | Test Scenario | Steps | Expected Result | Status |
|---|---|---|---|---|
| **39** | **Shared Validation, Repair & Payload Core** | 1. Trigger coach plan generation with simulated malformed JSON completion (unclosed quotes or trailing commas).<br>2. Inspect parser behavior. | • Shared JSON repair engine fixes syntax errors and validates output against Zod schema.<br>• Valid Workout/Plan object constructed without throwing unhandled exceptions to user. | PASS |
| **40** | **HTTP API-Key Adapters (Anthropic, OpenAI, DeepSeek, Groq, Ollama)** | 1. Configure test API keys and custom endpoints for Anthropic, OpenAI, DeepSeek, Groq, and Ollama.<br>2. Send test coaching prompts for each provider. | • Provider-specific adapters transform request formats and parse completion chunks correctly.<br>• Streaming and non-streaming responses handled seamlessly across all 5 providers. | PASS |
| **41** | **Android Keystore BYOK Coach Execution** | 1. In Settings -> AI Coach, select Bring-Your-Own-Key (BYOK).<br>2. Input provider API key.<br>3. Generate workout plan on Android device. | • API key stored securely in hardware-backed Android Keystore / EncryptedSharedPreferences.<br>• Requests originate directly from device to LLM endpoint with zero third-party leakage. | PASS |
| **42** | **Server Coach Precedence** | 1. Connect to server profile with active server-side coach subscription.<br>2. Verify precedence when local BYOK key is also present. | • System routes coach requests through server tier by default when active subscription is present.<br>• Settings clearly displays active provider status and allows fallback if disconnected. | PASS |
| **43** | **Privacy Center Consent Toggles** | 1. Open Privacy Center.<br>2. Toggle OSM Tile fetching, DEM Elevation queries, and BYOK Jurisdiction flags.<br>3. Exercise map and elevation features. | • Disabling OSM tiles halts external tile downloads.<br>• Disabling DEM elevation uses flat ground defaults without external network requests.<br>• BYOK jurisdiction flags restrict API traffic to selected regional boundaries (e.g., EU-only). | PASS |

---

## Conclusion
All 43 critical paths across Server Mode (#30) and Specs 1–6 (#84: Android GPS Activity Recording, Cardio Stats & Route Following, Activity/Route Sync, Multi-Modality Planning & Intervals, HIIT/Yoga/Mobility, and Shared Multi-Provider Coach Architecture) passed verification against the staging environment and automated test suites. Local-only mode and baseline offline operations remain strictly invariant with zero regressions.
