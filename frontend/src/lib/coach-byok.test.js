import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  isServerCoachActive,
  isByokActive,
  getCoachMode,
  resolveCoachMode,
  getByokKey,
  setByokKey,
  clearByokKey,
  getByokStatus,
  setByokJob,
  clearByokJob,
  setByokPending,
  clearByokPending,
  resolveByokPending,
  resetByokState,
  executeByokCoach,
  runByokReview,
  runByokPlan
} from './coach-byok.js'
import { coachAvailable } from './coach.js'
import {
  setStorageBackend,
  createMemoryStorageBackend
} from './token-storage.js'

describe('coach-byok', () => {
  beforeEach(async () => {
    setStorageBackend(createMemoryStorageBackend())
    await clearByokKey()
    resetByokState()
  })

  describe('server-Coach precedence over BYOK (Issue #72)', () => {
    const serverCoachConfig = { coach: { enabled: true } }
    const loggedInUser = { id: 'u1', name: 'Lifter' }

    it('identifies server Coach as active when config.coach.enabled is true and user is logged in', () => {
      expect(isServerCoachActive(serverCoachConfig, loggedInUser)).toBe(true)
      expect(isServerCoachActive(serverCoachConfig, null)).toBe(false)
      expect(isServerCoachActive({ coach: { enabled: false } }, loggedInUser)).toBe(false)
      expect(isServerCoachActive({}, loggedInUser)).toBe(false)
      expect(isServerCoachActive(null, loggedInUser)).toBe(false)
    })

    it('gives server Coach strict precedence over local BYOK even if mobile and byokKey exist', async () => {
      await setByokKey('sk-ant-test-key-123')

      // Server Coach is enabled and user is logged in:
      const config = serverCoachConfig
      const user = loggedInUser
      const mobile = true
      const byokKey = 'sk-ant-test-key-123'

      expect(isServerCoachActive(config, user)).toBe(true)
      expect(isByokActive({ config, user, mobile, byokKey })).toBe(false)
      expect(getCoachMode({ config, user, mobile, byokKey })).toBe('server')

      const modeResult = await resolveCoachMode({ config, user, mobile })
      expect(modeResult).toEqual({
        mode: 'server',
        active: true,
        key: null
      })
    })

    it('falls back from server mode to BYOK mode when user is logged in but server Coach is disabled', async () => {
      await setByokKey('sk-ant-fallback-key')
      const config = { coach: { enabled: false } }
      const user = loggedInUser

      expect(isServerCoachActive(config, user)).toBe(false)
      expect(isByokActive({ config, user, mobile: true, byokKey: 'sk-ant-fallback-key' })).toBe(true)
      expect(getCoachMode({ config, user, mobile: true, byokKey: 'sk-ant-fallback-key' })).toBe('byok')

      const modeResult = await resolveCoachMode({ config, user, mobile: true })
      expect(modeResult).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-ant-fallback-key'
      })
    })

    it('falls back from server mode to BYOK mode when config has no coach property', async () => {
      const config = {}
      const user = loggedInUser
      const byokKey = 'sk-openai-test'

      expect(isServerCoachActive(config, user)).toBe(false)
      expect(isByokActive({ config, user, mobile: true, byokKey })).toBe(true)
      expect(getCoachMode({ config, user, mobile: true, byokKey })).toBe('byok')
    })

    it('falls back to BYOK mode when user is logged out (guest mode on mobile)', async () => {
      const config = serverCoachConfig
      const user = null
      const byokKey = 'sk-mobile-guest-key'

      expect(isServerCoachActive(config, user)).toBe(false)
      expect(isByokActive({ config, user, mobile: true, byokKey })).toBe(true)
      expect(getCoachMode({ config, user, mobile: true, byokKey })).toBe('byok')

      const modeResult = await resolveCoachMode({ config, user, mobile: true, byokKey })
      expect(modeResult).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-mobile-guest-key'
      })
    })

    it('integrates with coachAvailable gating helper across all server and BYOK combinations', () => {
      // Server coach enabled & user logged in -> coachAvailable is true regardless of mobile or byok
      expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' }, { mobile: true, byok: null })).toBe(true)
      expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' }, { mobile: false, byok: null })).toBe(true)
      expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' }, { mobile: true, byok: 'sk-ant-test' })).toBe(true)

      // Mobile without server coach: requires byok
      expect(coachAvailable(null, null, { mobile: true, byok: 'sk-ant-test' })).toBe(true)
      expect(coachAvailable({ coach: { enabled: false } }, { id: 'u' }, { mobile: true, byok: 'sk-ant-test' })).toBe(true)
      expect(coachAvailable(null, null, { mobile: true, byok: null })).toBe(false)
      expect(coachAvailable({ coach: { enabled: false } }, { id: 'u' }, { mobile: true, byok: null })).toBe(false)

      // Web without server coach: false even if byok is provided
      expect(coachAvailable(null, null, { mobile: false, byok: 'sk-ant-test' })).toBe(false)
    })
  })

  describe('local BYOK activation on mobile when not connected to server coach', () => {
    it('activates BYOK on mobile when valid byokKey is present', async () => {
      expect(isByokActive({ config: null, user: null, mobile: true, byokKey: 'sk-ant-api03-xxx' })).toBe(true)
      expect(getCoachMode({ config: null, user: null, mobile: true, byokKey: 'sk-ant-api03-xxx' })).toBe('byok')

      const res = await resolveCoachMode({ config: null, user: null, mobile: true, byokKey: 'sk-ant-api03-xxx' })
      expect(res).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-ant-api03-xxx'
      })
    })

    it('trims whitespace on byokKey and ignores whitespace-only keys', async () => {
      expect(isByokActive({ mobile: true, byokKey: '  sk-key-with-spaces  ' })).toBe(true)
      expect(getCoachMode({ mobile: true, byokKey: '  sk-key-with-spaces  ' })).toBe('byok')

      const res = await resolveCoachMode({ mobile: true, byokKey: '  sk-key-with-spaces  ' })
      expect(res).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-key-with-spaces'
      })

      // Whitespace-only keys are treated as no key
      expect(isByokActive({ mobile: true, byokKey: '    ' })).toBe(false)
      expect(getCoachMode({ mobile: true, byokKey: '    ' })).toBe('none')

      const emptyRes = await resolveCoachMode({ mobile: true, byokKey: '    ' })
      expect(emptyRes).toEqual({
        mode: 'none',
        active: false,
        key: null
      })
    })

    it('returns none when no byokKey is configured on mobile', async () => {
      expect(isByokActive({ config: null, user: null, mobile: true, byokKey: null })).toBe(false)
      expect(isByokActive({ config: null, user: null, mobile: true, byokKey: '' })).toBe(false)
      expect(getCoachMode({ config: null, user: null, mobile: true, byokKey: null })).toBe('none')

      const res = await resolveCoachMode({ config: null, user: null, mobile: true })
      expect(res).toEqual({
        mode: 'none',
        active: false,
        key: null
      })
    })

    it('does not activate BYOK in non-mobile environments (web) even if byokKey is passed', async () => {
      const byokKey = 'sk-ant-api03-xxx'

      expect(isByokActive({ config: null, user: null, mobile: false, byokKey })).toBe(false)
      expect(getCoachMode({ config: null, user: null, mobile: false, byokKey })).toBe('none')

      const res = await resolveCoachMode({ config: null, user: null, mobile: false, byokKey })
      expect(res).toEqual({
        mode: 'none',
        active: false,
        key: null
      })
    })
  })

  describe('getByokKey / setByokKey integration with secure storage', () => {
    it('integrates getByokKey, setByokKey, and clearByokKey with storage backend', async () => {
      expect(await getByokKey()).toBeNull()

      await setByokKey('sk-ant-test-key')
      expect(await getByokKey()).toBe('sk-ant-test-key')

      // resolveCoachMode picks up the key directly from storage
      const res = await resolveCoachMode({ mobile: true })
      expect(res).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-ant-test-key'
      })

      await clearByokKey()
      expect(await getByokKey()).toBeNull()

      const clearedRes = await resolveCoachMode({ mobile: true })
      expect(clearedRes).toEqual({
        mode: 'none',
        active: false,
        key: null
      })
    })

    it('handles initial seed via createMemoryStorageBackend', async () => {
      setStorageBackend(createMemoryStorageBackend({ byok_coach_api_key: 'sk-seeded-memory-key' }))

      expect(await getByokKey()).toBe('sk-seeded-memory-key')
      const res = await resolveCoachMode({ mobile: true })
      expect(res).toEqual({
        mode: 'byok',
        active: true,
        key: 'sk-seeded-memory-key'
      })
    })
  })

  describe('BYOK status and state transitions', () => {
    it('manages status, job, and pending proposals', () => {
      expect(getByokStatus()).toEqual({
        job: null,
        pending: null,
        cap: { used: 0, limit: 0 }
      })

      const job = { id: 'job-1', kind: 'review', state: 'running' }
      setByokJob(job)
      expect(getByokStatus().job).toEqual(job)

      clearByokJob()
      expect(getByokStatus().job).toBeNull()

      const pending = { id: 'pending-1', kind: 'review', summary: 'Good job' }
      setByokPending(pending)
      expect(getByokStatus().pending).toEqual(pending)

      const res = resolveByokPending()
      expect(res).toEqual({ ok: true })
      expect(getByokStatus().pending).toBeNull()

      setByokPending(pending)
      clearByokPending()
      expect(getByokStatus().pending).toBeNull()

      setByokJob(job)
      setByokPending(pending)
      resetByokState()
      expect(getByokStatus()).toEqual({
        job: null,
        pending: null,
        cap: { used: 0, limit: 0 }
      })
    })
  })

  describe('Android local-only BYOK Coach execution', () => {
    const mockS = {
      routines: [
        {
          id: 'r1',
          name: 'Upper Body A',
          ex: [
            { id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 60 }
          ]
        }
      ],
      week: { 1: 'r1' },
      coach: { consent: { agreedAt: '2026-11-12T00:00:00Z', version: 1 }, log: [] }
    }

    it('returns error when missing BYOK API key', async () => {
      const res = await executeByokCoach({ S: mockS })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('Missing BYOK API key')
    })

    it('executes review via Anthropic protocol when sk-ant- key is provided', async () => {
      const mockReviewResponse = {
        summary: 'Adding volume for hypertrophy',
        reading: 'Training volume is progressing well with steady recovery.',
        evidence: { sessions: 3, from: '2026-11-01', to: '2026-11-10' },
        changes: [
          {
            id: 'c-1',
            type: 'sets',
            target: { routineId: 'r1', exId: '0001' },
            before: 3,
            after: 4,
            why: 'Adding volume for hypertrophy'
          }
        ],
        notes: ['Hydrate well before next session']
      }

      const fetchFn = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({
          content: [
            { type: 'text', text: JSON.stringify(mockReviewResponse) }
          ]
        })
      })

      const res = await executeByokCoach({
        kind: 'review',
        S: mockS,
        apiKey: 'sk-ant-api03-test-token',
        fetchFn
      })

      expect(res.ok).toBe(true)
      expect(res.pending).toBeDefined()
      expect(res.pending.kind).toBe('review')
      expect(res.pending.summary).toBe('Adding volume for hypertrophy')
      expect(res.pending.changes).toHaveLength(1)
      expect(res.pending.changes[0].id).toBe('c-1')

      // Verify fetch was called with Anthropic headers and endpoint
      expect(fetchFn).toHaveBeenCalled()
      const [url, opts] = fetchFn.mock.calls[0]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect(opts.headers['x-api-key']).toBe('sk-ant-api03-test-token')
      expect(opts.headers['anthropic-version']).toBe('2023-06-01')
    })

    it('executes create plan via OpenAI protocol when non-anthropic key is provided', async () => {
      const mockPlanResponse = {
        summary: '3-day full body training program',
        routines: [
          {
            id: 'r-fullbody',
            name: 'Full Body Day 1',
            emoji: '🏋️',
            ex: [
              { id: '0001', sets: 3, reps: 8 }
            ]
          }
        ],
        week: { 1: 'r-fullbody', 3: 'r-fullbody', 5: 'r-fullbody' }
      }

      const fetchFn = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(mockPlanResponse) } }
          ]
        })
      })

      const res = await executeByokCoach({
        kind: 'create',
        S: mockS,
        apiKey: 'sk-proj-openai-api-key',
        fetchFn
      })

      expect(res.ok).toBe(true)
      expect(res.pending).toBeDefined()
      expect(res.pending.kind).toBe('create')
      expect(res.pending.summary).toBe('3-day full body training program')
      expect(res.pending.bundle.routines).toHaveLength(1)

      const [url, opts] = fetchFn.mock.calls[0]
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      expect(opts.headers['authorization']).toBe('Bearer sk-proj-openai-api-key')
    })

    it('runByokReview manages job and pending lifecycle', async () => {
      await setByokKey('sk-ant-lifecycle-key')

      const mockReviewResponse = {
        nochange: true,
        reading: 'Everything looks great, no changes needed.'
      }

      const fetchFn = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({
          content: [
            { type: 'text', text: JSON.stringify(mockReviewResponse) }
          ]
        })
      })

      const reviewPromise = runByokReview({
        S: mockS,
        note: 'Feeling good',
        fetchFn
      })

      // Immediately after start, job is set
      const statusDuring = getByokStatus()
      expect(statusDuring.job).toBeDefined()
      expect(statusDuring.job.kind).toBe('review')

      const res = await reviewPromise
      expect(res.ok).toBe(true)

      // After completion, job is cleared and pending is populated
      const statusAfter = getByokStatus()
      expect(statusAfter.job).toBeNull()
      expect(statusAfter.pending).toBeDefined()
      expect(statusAfter.pending.nochange).toBe(true)
    })

    it('runByokPlan manages job and pending lifecycle', async () => {
      await setByokKey('sk-ant-plan-key')

      const mockPlanResponse = {
        summary: 'Strength routine',
        routines: [{ id: 'r-str', name: 'A', ex: [{ id: '0001', sets: 3, reps: 5 }] }],
        week: { 1: 'r-str' }
      }

      const fetchFn = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(mockPlanResponse) }]
        })
      })

      const res = await runByokPlan({
        S: mockS,
        intake: { goal: 'strength' },
        fetchFn
      })

      expect(res.ok).toBe(true)
      expect(getByokStatus().job).toBeNull()
      expect(getByokStatus().pending.kind).toBe('create')
      expect(getByokStatus().pending.bundle.summary).toBe('Strength routine')
    })

    it('handles runner failure gracefully and cleans up job', async () => {
      await setByokKey('sk-ant-error-key')

      const fetchFn = vi.fn().mockResolvedValue({
        status: 500,
        text: async () => 'Internal Server Error'
      })

      await expect(runByokReview({ S: mockS, fetchFn })).rejects.toThrow()
      expect(getByokStatus().job).toBeNull()
    })
  })
})
