# Task: build a weekly training plan

Design a complete plan from `coachProfile` (their intake answers) and, if present, `history` (what they have already been lifting).

## Constraints

- Schedule exactly `coachProfile.daysPerWeek` training days. Use `preferredDays` when given (0 = Sunday … 6 = Saturday).
- Fit `coachProfile.sessionMin` minutes: roughly 2–3 minutes per straight set including rest; supersets (`sg`) buy time back when the session is tight.
- Only exercises from `library`. Respect `equipment`, `limitations`, and `dislikes` — a plan someone will not do is a plan that failed.
- If `history.workingWeights` is present, any starting `weight` you set must be at or below what they have already handled for that exercise. For anything they have not trained, omit `weight` entirely — the app's first session sets the baseline.
- 1–7 routines, each 3–12 exercises, compound work before accessories.
- **Cardio sessions in plan (`coachProfile.includeCardio`)**:
  - When `coachProfile.includeCardio` is `false` (or omitted): do NOT include standalone cardio sessions in `week` (`kind: "cardio"`). Cardio sessions are disabled.
  - When `coachProfile.includeCardio` is `true`: you may schedule standalone cardio items in `week` with `kind: "cardio"`, `type` from `coachProfile.cardioTypes` (or standard types: run, ride, walk, hike), and positive duration or distance. Do not exceed `coachProfile.cardioSessionsPerWeek` (1–7). Gym training days must still match `coachProfile.daysPerWeek`. Optional interval `steps` may specify `kind` (warmup, work, recover, cooldown) with positive `durSec` or `distM`.
- **Modality switches & target sessions (`coachProfile.modalities`)**:
  - `coachProfile.modalities` is `{ gym: boolean, cardio: boolean, hiit: boolean, yoga: boolean, mobility: boolean }`.
  - Only schedule routines or sessions for modalities that are enabled (`true`). Any routine or week item of a disabled modality will be rejected.
  - When enabled, you can propose `hiit`, `yoga`, and `mobility` routines with `kind` (`gym`, `hiit`, `yoga`, `mobility`), custom per-routine `restSec` (seconds between exercises), library poses/drills, and `customEx` entries with `desc`.
  - Enforce session counts matching target `sessionsPerWeek` (or `coachProfile.daysPerWeek` / `coachProfile.cardioSessionsPerWeek`) for each enabled modality.

## Output

```
{
  "coach_contract": 1,
  "opengym_plan": 1,
  "name": "<short plan name>",
  "summary": "<2-4 sentences: the shape of the plan and why it fits what they asked for>",
  "basedOn": "<what you used — e.g. 'your last 12 weeks' or 'no history yet'>",
  "week": { "1": "r1", "3": "r2", "5": "r3" },
  "routines": [
    {
      "id": "r1",
      "name": "<routine name>",
      "emoji": "<one emoji>",
      "kind": "gym",
      "restSec": 90,
      "prog": "linear",
      "why": "<1-2 sentences: what this day is for>",
      "ex": [
        {
          "id": "<library id>",
          "sets": 3,
          "mode": "reps",
          "reps": 8,
          "prog": "linear",
          "inc": 2.5,
          "repsMin": 8,
          "sg": "a",
          "why": "<1-2 sentences naming why this exercise, here, at this prescription>"
        }
      ]
    }
  ],
  "customEx": []
}
```

- `week` keys are weekday numbers as strings (0 = Sunday … 6 = Saturday). Values are routine ids (`routines[].id`) or, when `includeCardio` is true, standalone cardio objects `{ "kind": "cardio", "type": "run", "duration": 30 }` (or arrays if combining).
- `mode` is `reps` (use `reps`), `time` (use `sec`), or `cardio` (use `min` and `speed`).
- `prog` on a routine is its default; on an exercise it overrides. `inc` is the load step in `meta.unit`; `repsMin` only matters for `double`.
- `sg`: give two exercises the same short string to superset them. They must be adjacent in the list.
- `customEx` stays empty unless the library genuinely lacks something the plan needs; then add `{ "id": "cx1", "n": "<name>", "bp": "<body part>", "desc": "<how to do it>" }` and reference `cx1` from a routine.
