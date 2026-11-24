# openGym

A self-hosted and local-first strength, cardio, and mobility training tracker with deterministic progression and an optional Coach.

## Language

### Training & Planning

**Routine**:
A named template of exercises, target sets, reps or durations, rest intervals, and a progression policy for a specific modality (`gym`, `hiit`, `yoga`, or `mobility`).
_Avoid_: Program, workout template, split

**Workout**:
A completed or in-progress strength session where actual weight, reps, duration, and effort are logged against a Routine or ad-hoc exercises.
_Avoid_: Session log, training entry

**Flow Session**:
A timed, auto-advancing session (HIIT, Yoga, or Mobility) that steps through sequential moves and rest periods with voice cues.
_Avoid_: Circuit workout, timer session

**Cardio Activity**:
A logged endurance session (such as a run, ride, walk, or hike) with duration, distance, pace, and an optional GPS Track.
_Avoid_: Cardio workout, GPS session

**Track**:
The time-series of geographic coordinates, elevation, heart rate, and cadence recorded during a Cardio Activity.
_Avoid_: Breadcrumb log, GPS trace

**Route**:
A reusable geographic path (imported from GPX or saved from a Track) that an athlete can follow during a Cardio Activity.
_Avoid_: Course, path template

### Coaching

**Coach**:
The training advisor that reads an athlete's plan and recent training window to draft a new weekly plan or propose evidence-backed adjustments.
_Avoid_: AI assistant, bot, virtual trainer

**Proposal**:
A pending Coach recommendation awaiting the athlete's decision—either a complete initial plan (`create`) or a discrete set of changes to the active plan (`review`).
_Avoid_: Suggestion batch, draft plan, diff
