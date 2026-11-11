/* The gate between a language model's output and someone's training plan.
 *
 * Everything upstream of here is advisory — the prompt asks for a shape, the model usually
 * obliges. This file is where "usually" stops mattering. Nothing reaches a user that has not
 * resolved against the real exercise library, matched the closed list of change types, and
 * stayed inside the two things the Coach is allowed to touch (routines and the week).
 */
export * from '../../shared/coach/validate.js';
