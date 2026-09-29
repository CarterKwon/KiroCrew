import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'
import { useVirtualChat, type UseVirtualChatOptions } from '../hooks/virtualizer/useVirtualChat'

/**
 * REGRESSION GUARD — with nothing running, an automatic pin must not move a
 * reader who has scrolled up.
 *
 * Reported from a phone: scrolling up a bit over a hundred pixels sprang the
 * transcript back to the bottom even with no turn in flight. Every automatic pin
 * is gated on `stick`, and `stick` is meant to be released by a scroll-up — but
 * that leaves the whole guarantee resting on one event's bookkeeping, and a
 * geometry commit landing at the wrong moment (a height settle, a viewport
 * resize, an iOS momentum tail) can find follow still armed.
 *
 * Two rules share the work. POSITION: a reader resting on follow's own last
 * write is still at the end and is carried (a wheel that moved nothing is not
 * a move); a reader whose scrollTop LEFT that write while nothing runs is one
 * who left, and idle + above the bottom releases follow instead of pinning.
 * INTENT IN FLIGHT: an UPWARD input stamps before the scroll event that moves
 * the reader, so for one frame the position still reads "resting"; the pin is
 * held until that scroll event lands (`upwardIntentPending`). Downward and
 * directionless input is not held -- it moves nothing at the end. Explicit
 * intent -- slot entry, the jump-to-bottom pill, sending -- goes through
 * `forcePin` and is deliberately unaffected.
 */

interface Item { id: string }
const getKey = (it: Item) => it.id
const mkItems = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

interface Geom { scrollTop: number; scrollHeight: number; clientHeight: number }

function makeScroller(initial: Geom) {
  const el = document.createElement('div')
  const state = { ...initial }
  const writes: number[] = []
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => { state.scrollTop = v; writes.push(v) },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.clientHeight })
  ;(el as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => {
    state.scrollTop = o.top
    writes.push(o.top)
  }
  return { el, state, writes }
}

class FakeRO {
  static instances: FakeRO[] = []
  constructor(readonly cb: ResizeObserverCallback) { FakeRO.instances.push(this) }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(entries: Partial<ResizeObserverEntry>[]) {
    this.cb(entries as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}

const origRO = globalThis.ResizeObserver
const origRaf = globalThis.requestAnimationFrame

beforeEach(() => {
  vi.useFakeTimers()
  FakeRO.instances = []
  globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof requestAnimationFrame
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.ResizeObserver = origRO as typeof ResizeObserver
  globalThis.requestAnimationFrame = origRaf
})

/** Mounts glued to the bottom, then grows content BELOW the fold by `growPx`.
 *
 *  No user scroll: a scroll-up releases follow on its own (correctly), which is
 *  why driving this with a gesture would pass whether or not the idle rule
 *  exists. Growth is the state where follow is still armed and the reader is no
 *  longer at the bottom — the one the idle rule alone decides. */
function mountGrownBelow(runActive: boolean, growPx: number) {
  const { el, state, writes } = makeScroller({ scrollTop: 5000 - 700, scrollHeight: 5000, clientHeight: 700 })
  const ref: RefObject<HTMLDivElement | null> = { current: el }
  const view = renderHook(
    (props: UseVirtualChatOptions<Item>) => useVirtualChat<Item>(props),
    {
      initialProps: {
        items: mkItems(60),
        sessionId: `idle-pin-${runActive}-${growPx}`,
        getKey,
        externalScrollerRef: ref,
        followOutput: true,
        runActive,
      },
    },
  )
  act(() => { vi.advanceTimersByTime(200) })
  writes.length = 0
  state.scrollHeight += growPx
  return { view, el, state, writes, bottom: () => state.scrollHeight - state.clientHeight }
}

describe('automatic pin requires a live run', () => {
  it('idle: a wheel that moved nothing does not stop a still reader being carried back', () => {
    const { view, el, state, writes, bottom } = mountGrownBelow(false, 120)
    // The reader wheeled DOWN at the end (there was nothing below, so nothing
    // moved) and a directionless grab landed too. Neither is a departure: they
    // still rest on our last write to the pixel, and the gap under them is
    // content's. Reading those stamps as "the reader left" is how a reply
    // landing in an idle DM stopped following its reader.
    act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })) })
    act(() => { el.dispatchEvent(new Event('wheel')) })
    // Step the hardware clock past the gesture-settle window, or the RO path
    // declines to evaluate at all (a gesture in flight outranks any pin) and the
    // resting rule is never reached.
    const afterGesture = performance.now() + 1000
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(afterGesture)
    const ro = FakeRO.instances[FakeRO.instances.length - 1]
    act(() => { ro.fire([{ target: el }]) })
    act(() => { vi.advanceTimersByTime(600) })
    nowSpy.mockRestore()

    expect(state.scrollTop).toBe(bottom())
    expect(writes.filter((w) => Math.abs(w - bottom()) < 2).length).toBeGreaterThan(0)
    expect(view.result.current.getFollow()).toBe(true)
  })

  it('idle: a reader whose scroll-up has LANDED is released, not sprung back', () => {
    const { view, el, state, writes, bottom } = mountGrownBelow(false, 120)
    // The whole gesture: upward input, then its scroll event moving the reader.
    act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
    const parked = state.scrollTop - 100
    state.scrollTop = parked
    act(() => { el.dispatchEvent(new Event('scroll')) })
    expect(view.result.current.getFollow()).toBe(false)
    const afterGesture = performance.now() + 1000
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(afterGesture)
    const ro = FakeRO.instances[FakeRO.instances.length - 1]
    act(() => { ro.fire([{ target: el }]) })
    act(() => { vi.advanceTimersByTime(600) })
    nowSpy.mockRestore()

    expect(state.scrollTop).toBe(parked)
    expect(writes.filter((w) => Math.abs(w - bottom()) < 2)).toEqual([])
    expect(view.result.current.getFollow()).toBe(false)
  })

  describe('upward intent whose scroll event has not dispatched yet (the sub-frame race)', () => {
    // Input lands BEFORE the scroll it causes. Between the two the reader still
    // sits on our last write to the pixel, so position alone reads "resting",
    // and an append committing in that same frame -- the growth layout effect,
    // the one pin path with no settle gate -- would pin them to the bottom
    // against the scroll-up they have just begun. The upward stamp is held until
    // its scroll event arrives; that event then decides (release if they moved
    // up, re-baseline if they did not).
    it('an UPWARD wheel followed by an append in the same frame is not pinned over', () => {
      const { el, state, writes, bottom } = makeScroller({ scrollTop: 5000 - 700, scrollHeight: 5000, clientHeight: 700 })
      const ref: RefObject<HTMLDivElement | null> = { current: el }
      const props = { items: mkItems(60), sessionId: 'idle-pin-upward-race', getKey, externalScrollerRef: ref, followOutput: true, runActive: false }
      const view = renderHook((p: UseVirtualChatOptions<Item>) => useVirtualChat<Item>(p), { initialProps: props })
      act(() => { vi.advanceTimersByTime(200) })
      writes.length = 0
      const resting = state.scrollTop
      // The wheel-up: stamped now; its scroll event is still in flight.
      act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
      // A reply lands in the same frame -- the tail grows, the row is appended.
      state.scrollHeight += 120
      act(() => { view.rerender({ ...props, items: mkItems(61) }) })
      expect(state.scrollTop).toBe(resting)
      expect(writes.filter((w) => Math.abs(w - bottom()) < 2)).toEqual([])
      // Follow is HELD, not released: the scroll event owns that decision.
      expect(view.result.current.getFollow()).toBe(true)
      // ...and here it is: the reader moved up. Released, and the next append
      // leaves them where they are.
      const parked = resting - 100
      state.scrollTop = parked
      act(() => { el.dispatchEvent(new Event('scroll')) })
      expect(view.result.current.getFollow()).toBe(false)
      act(() => { vi.advanceTimersByTime(300) })
      state.scrollHeight += 120
      act(() => { view.rerender({ ...props, items: mkItems(62) }) })
      expect(state.scrollTop).toBe(parked)
    })

    it('the same frame after a DOWNWARD wheel is pinned: a no-op input at the end is ignored', () => {
      const { el, state, bottom } = makeScroller({ scrollTop: 5000 - 700, scrollHeight: 5000, clientHeight: 700 })
      const ref: RefObject<HTMLDivElement | null> = { current: el }
      const props = { items: mkItems(60), sessionId: 'idle-pin-downward-noop', getKey, externalScrollerRef: ref, followOutput: true, runActive: false }
      const view = renderHook((p: UseVirtualChatOptions<Item>) => useVirtualChat<Item>(p), { initialProps: props })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })) })
      state.scrollHeight += 120
      act(() => { view.rerender({ ...props, items: mkItems(61) }) })
      expect(state.scrollTop).toBe(bottom())
      expect(view.result.current.getFollow()).toBe(true)
    })

    it('upward intent that never scrolls expires with the settle window', () => {
      // A transcript shorter than its viewport cannot scroll: the wheel-up
      // produces no scroll event, and the stamp must not park follow forever.
      const { el, state, bottom } = makeScroller({ scrollTop: 5000 - 700, scrollHeight: 5000, clientHeight: 700 })
      const ref: RefObject<HTMLDivElement | null> = { current: el }
      const props = { items: mkItems(60), sessionId: 'idle-pin-upward-expiry', getKey, externalScrollerRef: ref, followOutput: true, runActive: false }
      const view = renderHook((p: UseVirtualChatOptions<Item>) => useVirtualChat<Item>(p), { initialProps: props })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
      act(() => { vi.advanceTimersByTime(300) })
      state.scrollHeight += 120
      act(() => { view.rerender({ ...props, items: mkItems(61) }) })
      expect(state.scrollTop).toBe(bottom())
      expect(view.result.current.getFollow()).toBe(true)
    })
  })

  it('idle: the same growth under a reader who has NOT moved is carried back', () => {
    // No input since the entry pin, resting on it to the pixel: every pixel of
    // the gap is content settling, and the reader is kept at the end. This is
    // what native scroll anchoring did silently on Chromium; WebKit has none,
    // and releasing here is how a phone opened idle sessions above their end.
    const { view, el, state, bottom } = mountGrownBelow(false, 120)
    const ro = FakeRO.instances[FakeRO.instances.length - 1]
    act(() => { ro.fire([{ target: el }]) })
    act(() => { vi.advanceTimersByTime(600) })

    expect(state.scrollTop).toBe(bottom())
    expect(view.result.current.getFollow()).toBe(true)
  })

  it('running: the same growth IS followed', () => {
    const { view, el, state } = mountGrownBelow(true, 120)
    const parked = state.scrollTop
    const ro = FakeRO.instances[FakeRO.instances.length - 1]
    act(() => { ro.fire([{ target: el }]) })
    act(() => { vi.advanceTimersByTime(600) })

    // Mid-turn a gap must be closed, or a burst of output strands the reader.
    expect(state.scrollTop).not.toBe(parked)
    expect(view.result.current.getFollow()).toBe(true)
  })
})
