/**
 * The composer sits inside ONE Liquid Glass dock pane (`composer-dock`, built
 * from components/Glass.tsx): `--glass-tint` over the blurred transcript, the
 * `--glass-band` light bands, `--glass-edge` side lines, no ring, and the neutral
 * `glass-shadow` for depth. The pane also holds an approval bar fused to the composer's top and the
 * collapsed bar, so those share the material instead of meeting it at a seam;
 * the wrapper's own surface and border are therefore transparent in every mode
 * (an incognito / temporary session still paints its coloured border). The pane
 * is always mounted: toggling it would remount the editor and drop the draft's
 * focus when an approval lands.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@radix-ui/react-dropdown-menu', async () => await import('./__mocks__/@radix-ui/react-dropdown-menu'))
vi.mock('@radix-ui/react-popover', async () => await import('./__mocks__/@radix-ui/react-popover'))
import { screen } from '@testing-library/react'
import ChatInput from '../components/ChatInput'
import { createTestStore, renderWithProviders } from './helpers'
import type { RootState } from '../store'

const INDEX_CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8')
const CHAT_INPUT_SRC = readFileSync(resolve(process.cwd(), 'src/components/ChatInput.tsx'), 'utf-8')
const SETTINGS_SEARCH_SRC = readFileSync(resolve(process.cwd(), 'src/pages/settings/SettingsSearch.tsx'), 'utf-8')
const FOLLOW_UP_BAR_SRC = readFileSync(resolve(process.cwd(), 'src/components/FollowUpBar.tsx'), 'utf-8')

const dockOf = (wrapper: HTMLElement) => wrapper.closest('[data-testid="composer-dock"]') as HTMLElement

describe('composer liquid glass', () => {
  it('keeps the wrapper transparent so the dock pane shows through', () => {
    renderWithProviders(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} />)
    const wrapper = screen.getByTestId('input-wrapper')
    expect(wrapper.className).toContain('bg-transparent')
    expect(wrapper.className).toContain('border-transparent')
    expect(wrapper.className).not.toContain('bg-bg-elevated')
  })

  // With an approval box fused above, the bar and the composer share the ONE
  // dock pane: the wrapper stays transparent (no seam, no notch), keeps its
  // focus-within accent brightening, and the dock swaps its halo for the
  // approval glow so the pending decision is what lights up.
  it('keeps the wrapper on the shared pane and lights the approval glow while an approval is attached', () => {
    const store = createTestStore({
      chat: {
        activeSlot: 'slot-1',
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'permission',
            content: 'Running: ls /tmp',
            meta: { approval_id: 'ap-1', request_id: 'req-1', tool_input: '{"command":"ls /tmp"}', tool_title: 'Running: ls /tmp', tool_call_id: 'tc-1' },
          },
        ],
        toolLog: [],
        slotStatusDetail: {},
      } as unknown as RootState['chat'],
      dashboard: {
        slots: [{ key: 'slot-1', messages: 2, running: true, pending_approval: true, waiting_for_input: false }],
        approvalMode: 'normal',
        connected: true,
        channelTrusted: false,
        refreshTrigger: 0,
        unreadSlots: [],
        updateProgress: null,
      } as unknown as RootState['dashboard'],
    })
    renderWithProviders(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} />, { store })
    const wrapper = screen.getByTestId('input-wrapper')
    expect(wrapper.className).toContain('bg-transparent')
    expect(wrapper.className).not.toContain('focus-within:border-accent')
    expect(wrapper.className).not.toContain('bg-bg-elevated')
    const dock = dockOf(wrapper)
    expect(dock.className).toContain('approval-glow')
    expect(dock.className).toContain('glass-shadow')
    expect(screen.getByRole('button', { name: /allow once/i })).toBeTruthy()
  })

  it('mounts one dock pane around the wrapper: no ring on the box, neutral shadow, 16px glass, theme tint', () => {
    renderWithProviders(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} />)
    const wrapper = screen.getByTestId('input-wrapper')
    const dock = dockOf(wrapper)
    expect(dock).not.toBeNull()
    // The material draws no rim: the outer box carries only the caller's shadow.
    expect(dock.className).not.toMatch(/\bborder\b/)
    expect(dock.className).toContain('glass-shadow')
    expect(dock.style.borderRadius).toBe('16px')
    // Glass IS the host: the dock element itself is the LiquidGlass root (no
    // wrapper box), carrying the radius, the caller's class and the effect
    // layers, with the children rendered directly after them.
    expect(dock.classList.contains('liquid-glass')).toBe(true)
    expect(dock.style.isolation).toBe('isolate')
    // The tint rides the oversized frost box inside the clipping effect layer.
    const boxes = Array.from(dock.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"] > span'))
    expect(boxes.some(l => l.style.background.includes('var(--glass-tint)'))).toBe(true)
    // Layers under the children: -1 inside the host's own stacking context.
    for (const layer of dock.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"]')) expect(layer.style.zIndex).toBe('-1')
  })

  it('defines the glass tokens (tint, focus tint, band, edge, hairline) for both polarities', () => {
    expect(INDEX_CSS).toMatch(/:root \{ --glass-tint: rgba\(30, 30, 34, 0\.40\); --glass-tint-focus: rgba\(56, 56, 62, 0\.50\); --glass-band: rgba\(255, 255, 255, 0\.22\); --glass-edge: rgba\(255, 255, 255, 0\.14\); --glass-edge-focus: rgba\(255, 255, 255, 0\.55\); --glass-hairline: rgba\(0, 0, 0, 0\.50\); \}/)
    expect(INDEX_CSS).toMatch(/\[data-mode="light"\] \{ --glass-tint: rgba\(238, 238, 243, 0\.45\); --glass-tint-focus: rgba\(255, 255, 255, 0\.92\); --glass-band: rgba\(255, 255, 255, 0\.92\); --glass-edge: rgba\(0, 0, 0, 0\.24\); --glass-edge-focus: rgba\(0, 0, 0, 0\.60\); --glass-hairline: rgba\(0, 0, 0, 0\.20\); \}/)
  })

  it('stands the context shelf on a short fade to page colour', () => {
    // The shelf (agent, project, branch, model chips) sits below the glass on
    // the bare transcript, which scrolls under the floating dock. It fades from
    // nothing at the pane's bottom edge to solid `--bg` 6px below it -- short,
    // so a bubble edge scrolling under the strip cannot show through as a
    // second line under the pane.
    // Neither the shelf nor the fade is its own stacking context: the
    // `z-index: -1` layer resolves against the dock's input-area wrapper
    // (ChatPage's `relative z-10 dock-inert`), so it sits BEHIND the pane's
    // shadow (a fade painted over the shadow whitened it out part-way and left
    // a bright band under the pane), above the transcript and below the chips;
    // that wrapper is also its containing block, so it spans the dock root --
    // which stops short of the scrollbar gutter -- and ChatInput hands it the
    // shelf's height. Nothing paints inside the pane.
    expect(INDEX_CSS).not.toMatch(/\.glass-shelf \{/)
    expect(INDEX_CSS).toMatch(/\.glass-shelf::before \{[^}]*position: absolute; left: 0; right: 0; bottom: 0; height: calc\(var\(--glass-shelf-h, 32px\) \+ 4px\);[^}]*linear-gradient\(to bottom, transparent, var\(--bg\) 6px\);[^}]*z-index: -1;/)
    expect(INDEX_CSS).not.toMatch(/\.glass-shelf::before \{[^}]*100vw/)
    // The containing-block contract: neither the shelf nor ChatInput's
    // `input-area` root may become positioned, or the fade would resolve
    // against them instead of the dock wrapper (Design, round 1).
    expect(CHAT_INPUT_SRC).toMatch(/className=\{`input-area px-4 pb-1 \$\{hasApproval \? 'pt-0' : 'pt-1'\} mx-auto w-full flex flex-col`\}/)
    expect(CHAT_INPUT_SRC).not.toMatch(/className=\{`input-area [^`]*\b(relative|absolute|fixed|sticky)\b/)
    expect(CHAT_INPUT_SRC).toMatch(/data-testid="composer-context-shelf" className="glass-shelf pt-1 flex items-center gap-2 min-w-0" style=\{\{ \['--glass-shelf-h' as string\]: `\$\{shelfHeight\}px` \}\}/)
  })

  it('lets the follow-up chips keep their top and bottom hairline', () => {
    // The chip row is overflow-x:auto, which makes overflow-y auto too, and the
    // glass hairline is drawn 0.5px OUTSIDE each chip's box -- a row exactly one
    // chip tall clipped it top and bottom. One pixel of padding, cancelled by
    // the negative margin, lets the line through at the same row height.
    expect(FOLLOW_UP_BAR_SRC).toMatch(/className=\{`flex \$\{CHIP_ROW_GAP\} overflow-x-auto items-end py-px -my-px`\}/)
  })

  // Every glass surface, the session composer included, wears the neutral
  // `glass-shadow`: focus is the deeper shadow PLUS the brighter focus tint and
  // darker side lines, never a theme-colored glow or ring. The tint step is for
  // neutral panes only: an accent / warn pane keeps its hue while a control
  // inside it has focus. A pending approval takes the shadow slot for its warm
  // glow and leaves the focus step on.
  it('gives every glass pane the same neutral focus cue, no accent glow', () => {
    expect(INDEX_CSS).toMatch(/\.glass-shadow:focus-within \{ box-shadow: 0 0 18px rgba\(0, 0, 0, 0\.14\); \}/)
    expect(INDEX_CSS).toMatch(/\.glass-shadow\.approval-glow, \.glass-shadow\.approval-glow:focus-within \{ box-shadow: var\(--approval-shadow\); \}/)
    expect(INDEX_CSS).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.approval-glow\{animation:none;--glow-strength:\.6\}\}/)
    // Focus steps the tint AND darkens the side lines (--glass-edge-focus); the
    // capsule's neutral focus cue is that pair, never an accent ring.
    expect(INDEX_CSS).toMatch(/\.glass-shadow:focus-within:not\(\.glass-accent, \.glass-warn\) \{ --glass-tint: var\(--glass-tint-focus\); --glass-edge: var\(--glass-edge-focus\); \}/)
    expect(INDEX_CSS).not.toContain('composer-halo')
    expect(INDEX_CSS).not.toMatch(/\.glass-shadow[^{]* \{[^}]*--accent/)
    expect(CHAT_INPUT_SRC).not.toContain('composer-halo')
    expect(CHAT_INPUT_SRC).not.toContain('focus-within:border-accent')
    // The Settings search bar follows the same rule: its boxed input keeps the
    // shared `focus-ring` shape but swaps the accent for a neutral border + halo.
    expect(SETTINGS_SEARCH_SRC).toMatch(/className="settings-search relative shrink-0"/)
    // The ring must stay a ring: 60% text over the border token clears 3:1 against the field in both polarities (Opus, round 2); --border-strong alone did not.
    expect(INDEX_CSS).toMatch(/\.settings-search \.focus-ring:focus-visible\{border-color:color-mix\(in srgb,var\(--text\) 60%,var\(--border\)\);\n\s+box-shadow:0 0 0 3px color-mix\(in srgb,var\(--text\) 22%,transparent\),0 0 20px rgba\(0,0,0,\.06\)\}/)
  })

  // There is ONE material: every dock surface is the primitive rendered as its
  // own element. The only per-call-site CSS is which tint step a pane is on,
  // and each step is a `--glass-tint` swap derived once on :root.
  it('has no CSS copy of the material, only tint steps on the host', () => {
    expect(INDEX_CSS).not.toContain('glass-pane')
    expect(INDEX_CSS).toMatch(/:root \{ --glass-tint-accent: color-mix\(in srgb, var\(--accent\) 14%, var\(--glass-tint\)\); --glass-tint-warn: color-mix\(in srgb, var\(--warn\) 12%, var\(--glass-tint\)\); --glass-tint-hover: color-mix\(in srgb, var\(--text\) 8%, var\(--glass-tint\)\); \}/)
    expect(INDEX_CSS).toContain('.glass-accent { --glass-tint: var(--glass-tint-accent); }')
    expect(INDEX_CSS).toContain('.glass-warn { --glass-tint: var(--glass-tint-warn); }')
    expect(INDEX_CSS).toContain('.glass-hover:hover { --glass-tint: var(--glass-tint-hover); }')
  })

  // The material must solidify wherever the app's other glass does: reduced
  // transparency, increased contrast, and a Chromium built without
  // backdrop-filter (#1817) — otherwise the transcript would show through the
  // box the user is typing into and through every chip above it.
  it('solidifies the pane under every glass fallback rule', () => {
    for (const block of [/@supports not \(\(backdrop-filter[\s\S]*?\n\}/, /@media \(prefers-reduced-transparency: reduce\)\{[\s\S]*?\n\}/, /@media \(prefers-contrast: more\)\{[\s\S]*?\n\}/]) {
      const rule = INDEX_CSS.match(block)?.[0] ?? ''
      expect(rule, String(block)).toContain('.liquid-glass{ background:var(--bg-elevated) !important')
      // The hide rule names the primitive's own layer attribute, never
      // `aria-hidden`: the children render directly, so a decorative icon
      // (`<Lightbulb aria-hidden>` in TipCard) is a direct child too and an
      // `aria-hidden` selector would delete it with the layers.
      expect(rule, String(block)).toContain('.liquid-glass>[data-liquid-glass-layer]{ display:none !important }')
      expect(rule, String(block)).not.toContain('[aria-hidden="true"]{ display:none')
      // The neutral pane's focus cue (tint + side-line step) lives in those
      // hidden layers, so a solidified pane holding focus needs the standard ring.
      expect(rule, String(block)).toMatch(/\.glass-shadow:focus-within\{ outline:2px solid var\(--accent\) !important; outline-offset:2px/)
    }
  })

  // The solid fallback fill is !important, so the picked chip and the incognito
  // chip must re-assert their hue on it or lose their only visible difference.
  it('keeps the accent and warn tints under the solidifying fallbacks', () => {
    for (const block of [/@supports not \(\(backdrop-filter[\s\S]*?\n\}/, /@media \(prefers-reduced-transparency: reduce\)\{[\s\S]*?\n\}/]) {
      const rule = INDEX_CSS.match(block)?.[0] ?? ''
      expect(rule, String(block)).toContain('.liquid-glass.glass-accent{ background:color-mix(in srgb, var(--accent) 14%, var(--bg-elevated)) !important }')
      expect(rule, String(block)).toContain('.liquid-glass.glass-warn{ background:color-mix(in srgb, var(--warn) 12%, var(--bg-elevated)) !important }')
    }
  })
})
