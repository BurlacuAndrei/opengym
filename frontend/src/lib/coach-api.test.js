import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStore, DEF } from '../store/useStore.js'
import {
  setStorageBackend,
  createMemoryStorageBackend
} from './token-storage.js'
import {
  setByokKey,
  clearByokKey,
  resetByokState,
  setByokPending,
  setByokJob,
  getByokStatus
} from './coach-byok.js'
import * as byokModule from './coach-byok.js'

let mockMobile = false
let mockDemo = false
const mockApi = vi.fn()

vi.mock('./mobile.js', () => ({
  get MOBILE() { return mockMobile }
}))

vi.mock('./demo.js', () => ({
  get DEMO() { return mockDemo }
}))

vi.mock('./api.js', () => ({
  api: (...args) => mockApi(...args)
}))

const mockDemoMod = {
  demoStatus: vi.fn(() => ({ job: null, pending: null, cap: { used: 0, limit: 0 } })),
  demoReview: vi.fn(() => ({ ok: true, job: null })),
  demoPlan: vi.fn(() => ({ ok: true, job: null })),
  demoRefine: vi.fn(() => ({ ok: true, job: null })),
  demoResolve: vi.fn(() => ({ ok: true })),
  demoDisclosure: vi.fn(() => ({ provider: 'demo', providerLabel: 'Demo Coach', categories: ['plan'] }))
}

vi.mock('./coach-demo.js', () => mockDemoMod)

import {
  getActiveMode,
  coachStatus,
  requestReview,
  requestPlan,
  refinePlan,
  resolvePending,
  forgetCoach,
  disclosure,
  useCoachAvailable,
  useCoachStatus,
  setCachedByokKey,
  resetCachedByokKey,
  JOB_ERRORS
} from './coach-api.js'

describe('coach-api unified client dispatch and hooks', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockMobile = false
    mockDemo = false
    resetCachedByokKey()
    setStorageBackend(createMemoryStorageBackend())
    await clearByokKey()
    resetByokState()

    useStore.setState({
      config: { coach: { enabled: true, providerLabel: 'OpenGym Server AI' } },
      user: { id: 'user-1', name: 'Lifter' },
      S: {
        ...DEF,
        routines: [{ id: 'r1', name: 'Upper Body', ex: [{ id: '0001', sets: 3, reps: 8 }] }]
      }
    })
  })

  afterEach(() => {
    resetCachedByokKey()
    resetByokState()
  })

  describe('getActiveMode resolution & precedence', () => {
    it('resolves demo mode when DEMO is true', async () => {
      mockDemo = true
      expect(await getActiveMode()).toBe('demo')
    })

    it('resolves server mode when config.coach.enabled is true and user is logged in', async () => {
      mockMobile = false
      mockDemo = false
      useStore.setState({ config: { coach: { enabled: true } }, user: { id: 'u1' } })
      expect(await getActiveMode()).toBe('server')
    })

    it('gives server mode strict precedence over mobile BYOK even if byok key exists', async () => {
      mockMobile = true
      mockDemo = false
      await setByokKey('sk-ant-test-key')
      setCachedByokKey('sk-ant-test-key')
      useStore.setState({ config: { coach: { enabled: true } }, user: { id: 'u1' } })

      expect(await getActiveMode()).toBe('server')
    })

    it('resolves byok mode on mobile when server coach is disabled and byok key is present', async () => {
      mockMobile = true
      mockDemo = false
      await setByokKey('sk-ant-test-key')
      setCachedByokKey('sk-ant-test-key')
      useStore.setState({ config: { coach: { enabled: false } }, user: { id: 'u1' } })

      expect(await getActiveMode()).toBe('byok')
    })

    it('resolves byok mode on mobile for guest user (no user logged in) when byok key is present', async () => {
      mockMobile = true
      mockDemo = false
      await setByokKey('sk-openai-key')
      setCachedByokKey('sk-openai-key')
      useStore.setState({ config: { coach: { enabled: true } }, user: null })

      expect(await getActiveMode()).toBe('byok')
    })

    it('falls back to server mode on web when coach is disabled', async () => {
      mockMobile = false
      mockDemo = false
      useStore.setState({ config: { coach: { enabled: false } }, user: { id: 'u1' } })

      expect(await getActiveMode()).toBe('server')
    })
  })

  describe('Server mode dispatch', () => {
    beforeEach(() => {
      mockMobile = false
      mockDemo = false
      useStore.setState({ config: { coach: { enabled: true } }, user: { id: 'u1' } })
    })

    it('dispatches coachStatus to GET /api/coach/status', async () => {
      mockApi.mockResolvedValueOnce({ job: null, pending: null, cap: { used: 1, limit: 5 } })
      const res = await coachStatus()
      expect(mockApi).toHaveBeenCalledWith('/api/coach/status')
      expect(res.cap.limit).toBe(5)
    })

    it('dispatches requestReview to POST /api/coach/review with note', async () => {
      mockApi.mockResolvedValueOnce({ ok: true, job: { id: 'j1' } })
      await requestReview('focus on shoulders')
      expect(mockApi).toHaveBeenCalledWith('/api/coach/review', {
        method: 'POST',
        body: JSON.stringify({ note: 'focus on shoulders' })
      })
    })

    it('dispatches requestPlan to POST /api/coach/plan with intake', async () => {
      mockApi.mockResolvedValueOnce({ ok: true, job: { id: 'j2' } })
      const intake = { goal: 'strength', daysPerWeek: 4 }
      await requestPlan(intake)
      expect(mockApi).toHaveBeenCalledWith('/api/coach/plan', {
        method: 'POST',
        body: JSON.stringify({ intake })
      })
    })

    it('dispatches refinePlan to POST /api/coach/plan with refine text', async () => {
      mockApi.mockResolvedValueOnce({ ok: true, job: { id: 'j3' } })
      await refinePlan('fewer leg days')
      expect(mockApi).toHaveBeenCalledWith('/api/coach/plan', {
        method: 'POST',
        body: JSON.stringify({ refine: 'fewer leg days' })
      })
    })

    it('dispatches resolvePending to POST /api/coach/pending/resolve', async () => {
      mockApi.mockResolvedValueOnce({ ok: true })
      await resolvePending({ accepted: ['plan'] })
      expect(mockApi).toHaveBeenCalledWith('/api/coach/pending/resolve', {
        method: 'POST',
        body: JSON.stringify({ accepted: ['plan'] })
      })
    })

    it('dispatches forgetCoach to POST /api/coach/forget', async () => {
      mockApi.mockResolvedValueOnce({ ok: true })
      await forgetCoach()
      expect(mockApi).toHaveBeenCalledWith('/api/coach/forget', {
        method: 'POST',
        body: '{}'
      })
    })

    it('dispatches disclosure to GET /api/coach/disclosure', async () => {
      mockApi.mockResolvedValueOnce({ provider: 'openai', categories: ['plan', 'training'] })
      const res = await disclosure()
      expect(mockApi).toHaveBeenCalledWith('/api/coach/disclosure')
      expect(res.provider).toBe('openai')
    })
  })

  describe('Android BYOK mode dispatch', () => {
    beforeEach(async () => {
      mockMobile = true
      mockDemo = false
      await setByokKey('sk-ant-test-key')
      setCachedByokKey('sk-ant-test-key')
      useStore.setState({ config: { coach: { enabled: false } }, user: null })
    })

    it('dispatches coachStatus to local getByokStatus', async () => {
      setByokJob({ id: 'job-1', kind: 'review', state: 'running' })
      setByokPending({ id: 'prop-1', kind: 'review', changes: [] })

      const status = await coachStatus()
      expect(status.job?.id).toBe('job-1')
      expect(status.pending?.id).toBe('prop-1')
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('dispatches requestReview to runByokReview without touching HTTP API', async () => {
      const spy = vi.spyOn(byokModule, 'runByokReview').mockResolvedValueOnce({ ok: true, pending: { id: 'p-rev' } })
      await requestReview('tweaked hamstring')

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].note).toBe('tweaked hamstring')
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('dispatches requestPlan to runByokPlan without touching HTTP API', async () => {
      const spy = vi.spyOn(byokModule, 'runByokPlan').mockResolvedValueOnce({ ok: true, pending: { id: 'p-create' } })
      const intake = { goal: 'muscle', daysPerWeek: 3 }
      await requestPlan(intake)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].intake).toEqual(intake)
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('dispatches refinePlan to runByokPlan with refine argument', async () => {
      const spy = vi.spyOn(byokModule, 'runByokPlan').mockResolvedValueOnce({ ok: true, pending: { id: 'p-refined' } })
      await refinePlan('swap bench for dumbbell press')

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].refine).toBe('swap bench for dumbbell press')
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('allows Android BYOK lifters to view, accept, and discard proposals', async () => {
      // 1. Lifter has a pending proposal in BYOK memory
      setByokPending({
        id: 'byok-proposal-1',
        kind: 'create',
        bundle: { name: 'Full Body 3x', routines: [] }
      })

      // View
      const status = await coachStatus()
      expect(status.pending).not.toBeNull()
      expect(status.pending.id).toBe('byok-proposal-1')

      // Accept
      const acceptRes = await resolvePending({ accepted: ['plan'] })
      expect(acceptRes.ok).toBe(true)
      expect(getByokStatus().pending).toBeNull()

      // Reset and test Discard
      setByokPending({
        id: 'byok-proposal-2',
        kind: 'review',
        changes: [{ id: 'c1', type: 'swap-exercise' }]
      })
      expect(getByokStatus().pending.id).toBe('byok-proposal-2')

      const discardRes = await resolvePending({ dismissed: true })
      expect(discardRes.ok).toBe(true)
      expect(getByokStatus().pending).toBeNull()
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('clears pending proposal when forgetCoach is invoked in BYOK mode', async () => {
      setByokPending({ id: 'pending-to-forget', kind: 'create' })
      expect(getByokStatus().pending).not.toBeNull()

      const res = await forgetCoach()
      expect(res.ok).toBe(true)
      expect(getByokStatus().pending).toBeNull()
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('dispatches disclosure to byokDisclosure returning client provider info', async () => {
      const disc = await disclosure()
      expect(disc.provider).toBe('anthropic')
      expect(disc.providerLabel).toBe('Anthropic Claude')
      expect(disc.categories.length).toBeGreaterThan(0)
      expect(mockApi).not.toHaveBeenCalled()
    })
  })

  describe('Demo mode dispatch', () => {
    beforeEach(() => {
      mockDemo = true
      mockMobile = false
    })

    it('routes all Coach operations to demo handlers', async () => {
      await coachStatus()
      expect(mockDemoMod.demoStatus).toHaveBeenCalled()

      await requestReview('demo note')
      expect(mockDemoMod.demoReview).toHaveBeenCalled()

      await requestPlan({ goal: 'strength' })
      expect(mockDemoMod.demoPlan).toHaveBeenCalled()

      await refinePlan('demo refine')
      expect(mockDemoMod.demoRefine).toHaveBeenCalled()

      await resolvePending({ accepted: ['plan'] })
      expect(mockDemoMod.demoResolve).toHaveBeenCalled()

      await forgetCoach()
      expect(mockDemoMod.demoResolve).toHaveBeenCalledTimes(2)

      const disc = await disclosure()
      expect(mockDemoMod.demoDisclosure).toHaveBeenCalled()
      expect(disc.provider).toBe('demo')

      expect(mockApi).not.toHaveBeenCalled()
    })
  })

  describe('useCoachAvailable hook', () => {
    function AvailabilityProbe() {
      const available = useCoachAvailable()
      return React.createElement('span', { 'data-testid': 'available' }, String(available))
    }

    it('returns true synchronously for Server Coach enabled with user', () => {
      mockMobile = false
      mockDemo = false
      useStore.setState({ config: { coach: { enabled: true } }, user: { id: 'u1' } })

      const html = renderToStaticMarkup(React.createElement(AvailabilityProbe))
      expect(html).toContain('true')
    })

    it('returns false for web when Server Coach is not enabled', () => {
      mockMobile = false
      mockDemo = false
      useStore.setState({ config: { coach: { enabled: false } }, user: { id: 'u1' } })

      const html = renderToStaticMarkup(React.createElement(AvailabilityProbe))
      expect(html).toContain('false')
    })

    it('returns true for Demo mode', () => {
      mockDemo = true
      mockMobile = false
      useStore.setState({ config: { coach: { enabled: false } }, user: null })

      const html = renderToStaticMarkup(React.createElement(AvailabilityProbe))
      expect(html).toContain('true')
    })

    it('returns true on mobile when cached BYOK key is present', () => {
      mockMobile = true
      mockDemo = false
      setCachedByokKey('sk-ant-test')
      useStore.setState({ config: { coach: { enabled: false } }, user: null })

      const html = renderToStaticMarkup(React.createElement(AvailabilityProbe))
      expect(html).toContain('true')
    })

    it('returns false on mobile when BYOK key is absent', () => {
      mockMobile = true
      mockDemo = false
      setCachedByokKey(null)
      useStore.setState({ config: { coach: { enabled: false } }, user: null })

      const html = renderToStaticMarkup(React.createElement(AvailabilityProbe))
      expect(html).toContain('false')
    })
  })

  describe('useCoachStatus hook in Android BYOK mode', () => {
    it('subscribes to in-memory status transitions without timers', async () => {
      mockMobile = true
      mockDemo = false
      await setByokKey('sk-ant-test-key')
      setCachedByokKey('sk-ant-test-key')
      useStore.setState({ config: { coach: { enabled: false } }, user: null })

      let hookState = null
      function StatusProbe() {
        const status = useCoachStatus(true)
        hookState = status
        return React.createElement('div', { 'data-testid': 'status' }, status.job ? 'job' : 'idle')
      }

      renderToStaticMarkup(React.createElement(StatusProbe))
      expect(hookState).not.toBeNull()
      expect(hookState.job).toBeNull()
      expect(hookState.pending).toBeNull()

      setByokPending({ id: 'prop-subscribe', kind: 'create' })
      const status = await coachStatus()
      expect(status.pending?.id).toBe('prop-subscribe')
    })
  })

  describe('JOB_ERRORS mapping', () => {
    it('defines user-facing copy for all known server error classes', () => {
      expect(JOB_ERRORS.off).toContain('isn’t set up')
      expect(JOB_ERRORS.busy).toContain('already thinking')
      expect(JOB_ERRORS.cap).toContain('resting')
      expect(JOB_ERRORS.consent).toContain('needs your go-ahead')
    })
  })
})
