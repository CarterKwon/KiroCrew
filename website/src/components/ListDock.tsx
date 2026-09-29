import { type CSSProperties, type ReactNode } from 'react'

import { useMeasuredHeight } from '../hooks/useMeasuredHeight'

/**
 * The list panel's floating dock: the glass search field (and the filter chips
 * under it) hover over the top of the list and the rows scroll UNDER them, the
 * way the transcript scrolls under the composer dock. Shared by the Sessions
 * sidebar and the Crew Members roster so both lists carry the same geometry.
 *
 * The dock is measured, not assumed: its height changes when a chip row
 * appears or an error notice mounts, so `useMeasuredHeight` (the composer's
 * own strip measurement) writes the live height to `--list-dock-h` on the
 * wrapper and every scroller inside pads its top — and its scroll-padding — by
 * that much (`LIST_BODY_CLS`, components/listShell.ts). The first row is then
 * fully visible at rest, a row scrolled into view lands below the glass, and
 * rows only slide under it once the user scrolls.
 *
 * The dock wrapper itself is `pointer-events-none`, and so is every block
 * inside it (the search row's wrapper, the chip row, a notice's margin box are
 * all full-width): the transparent space beside a short chip row must still
 * reach the row underneath. Only the CONTROLS re-arm pointer events — the
 * glass field, every button (the chips, a notice's action), links, and a
 * notice's own alert / status box — so those stay clickable and the rest of
 * the band is glass in the other sense too.
 *
 * `z-30` puts the dock above a pinned folder header (`FOLDER_ROW_STICKY_Z`,
 * 20): a header pushed off its pin by the next folder travels up through the
 * band, and at `z-10` its opaque surface painted over the glass.
 */
export function ListDock({ dock, children }: { dock: ReactNode; children: ReactNode }) {
  const [dockRef, height] = useMeasuredHeight<HTMLDivElement>()
  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col"
      // `--list-dock-pin-inset`: a pinned folder header (`.folder-row-sticky`,
      // index.css) sits on the glass pane's BOTTOM edge, not on the dock's — the
      // dock ends 4px lower, the search row's `pb-1` (and a chip row's), so
      // that is the inset the sticky offset subtracts.
      style={{ '--list-dock-h': `${height}px`, '--list-dock-pin-inset': '0.25rem' } as CSSProperties}
    >
      <div ref={dockRef} className="absolute top-0 inset-x-0 z-30 pointer-events-none [&_.liquid-glass]:pointer-events-auto [&_button]:pointer-events-auto [&_a]:pointer-events-auto [&_[role=alert]]:pointer-events-auto [&_[role=status]]:pointer-events-auto" data-testid="list-dock">
        {dock}
      </div>
      {children}
    </div>
  )
}
