/** Weekly cadence fires within the minute; everyWorkouts fires as soon as the count is met. */
export function isDue(coach, S, now) {
  const cadence = coach?.cadence;
  if (!cadence || cadence === 'off') return false;
  const lastAt = coach.lastReview?.at || 0;

  // Nothing new to read is the most common reason not to run, and it applies to both modes.
  const workouts = S?.workouts || [];
  const since = workouts.filter(w => !lastAt || (w.end || 0) > lastAt || w.d > new Date(lastAt).toISOString().slice(0, 10));
  if (!since.length) return false;

  if (cadence.everyWorkouts) {
    return since.length >= Math.max(1, Math.min(20, cadence.everyWorkouts));
  }
  if (cadence.weekly) {
    if (!now) return false;
    const wantDay = cadence.weekly.day ?? 0;
    const wantTime = cadence.weekly.time || '18:00';
    if (now.weekday !== wantDay || now.hhmm !== wantTime) return false;
    // One per day, even if the tick sees the same minute twice.
    return new Date(lastAt).toISOString().slice(0, 10) !== now.date;
  }
  return false;
}
