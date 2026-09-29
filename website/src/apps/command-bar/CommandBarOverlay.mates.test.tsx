import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import CommandBarOverlay from './CommandBarOverlay'

/**
 * The Command Bar's CREWMATES VIEW.
 *
 * The crew is reached here the way sessions, artifacts and folders are — one row in
 * the root that opens a view — and these tests pin that shape:
 *
 *  - the ROOT holds one row for the corpus, `Search Crewmates`, and never the roster
 *    itself; the roster is a FETCH, so a root group would either issue a request on
 *    every open of the bar or render empty on a cold install,
 *  - entering the view lands on the whole roster, narrows on a PARTIAL name, and
 *    tells two mates apart by face, name, role and whether they are working,
 *  - selecting a row navigates to that mate's own chat thread (`/members?member=…`),
 *  - the root issues NO request; entering the view is the activation event that pays
 *    for one.
 */

const dispatch = vi.fn()
const navigate = vi.fn()

const storeState: {
  dashboard: { slots: Record<string, unknown>[]; unreadSlots: string[] }
  chat: { slotStatusDetail: Record<string, unknown>; activeSlot: string | null }
} = {
  dashboard: { slots: [], unreadSlots: [] },
  chat: { slotStatusDetail: {}, activeSlot: null },
}

vi.mock('../../store', () => ({
  useAppDispatch: () => dispatch,
  useAppSelector: (fn: (s: unknown) => unknown) => fn(storeState),
}))
vi.mock('../../store/chatSlice', () => ({
  createSlot: (arg: unknown) => ({ type: 'createSlot', arg }),
  setPendingInput: (text: string) => ({ type: 'setPendingInput', text }),
  switchSlot: (arg: unknown) => ({ type: 'switchSlot', arg }),
  requestFolderReveal: (folderId: string) => ({ type: 'requestFolderReveal', folderId }),
}))
vi.mock('../../components/commandPalette/paletteActions', () => ({
  usePaletteActions: () => ({
    navigate,
    enterInsertOrNewSession: vi.fn(),
    newSessionWithToken: vi.fn(),
  }),
}))
vi.mock('../../components/commandPalette/providers/sessionsProvider', () => ({
  useSessionsProvider: () => ({ search: vi.fn(async () => []) }),
}))
vi.mock('../../components/commandPalette/providers/recentsProvider', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../components/commandPalette/providers/recentsProvider')
  >()),
  useRecentsProvider: () => ({ search: vi.fn(async () => []) }),
}))
vi.mock('../../hooks/useVisualViewport', () => ({ useVisualViewport: () => ({ height: 800 }) }))
vi.mock('../../hooks/useDialogFocusTrap', () => ({ useDialogFocusTrap: () => {} }))
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ cycle: vi.fn() }) }))

/** Every network call the overlay could make, so a request is observable. */
const listApps = vi.fn(async () => [])
const chatFolders = vi.fn(async () => [] as unknown[])
const kirocrewConfig = vi.fn(async () => ({}) as unknown)
const agentCatalog = vi.fn(async () => ({ agents: [] as unknown[], default_agent: '' }))
vi.mock('../../api/client', () => ({
  api: {
    listApps: (...a: unknown[]) => listApps(...(a as [])),
    chatFolders: (...a: unknown[]) => chatFolders(...(a as [])),
    kirocrewConfig: (...a: unknown[]) => kirocrewConfig(...(a as [])),
    agentCatalog: (...a: unknown[]) => agentCatalog(...(a as [])),
  },
}))

function mate(over: Record<string, unknown> & { name: string }) {
  return {
    kiro_agent: '',
    workspace: '',
    memory_store: '',
    description: '',
    source: '',
    selection_kind: 'member',
    ...over,
  }
}

/**
 * Three crewmates, which is the smallest roster that proves a filter narrowed
 * rather than merely rendered: `oncall` and `accountant` both contain `c`, and only
 * `accountant` survives `acc`. `reviewer` carries a display label hiding the
 * identity `qa-bot`, which is what the route and the running lookup must key on.
 */
const ROSTER = [
  mate({ name: 'oncall', description: 'Watches the pager and triages alerts.' }),
  mate({ name: 'accountant', description: 'Reconciles the spend ledger.' }),
  mate({ name: 'qa-bot', display_name: 'reviewer', description: 'Reviews diffs.' }),
]

/**
 * The option row whose visible text contains `text`.
 *
 * Matched on the ROW's `textContent`, not with `getByText`: a title the query
 * matched is rendered through `<Highlighted>`, which splits it into one element per
 * matched run, so the name exists on screen without existing as any single text
 * node.
 */
const rowByText = (text: string): HTMLElement => {
  const rows = screen.queryAllByRole('option')
  const hit = rows.find(r => (r.textContent || '').includes(text))
  if (!hit) {
    throw new Error(
      `no option row containing "${text}"; rows: ${rows.map(r => r.textContent).join(' | ')}`,
    )
  }
  return hit
}

/** Whether any option row shows `text` — the negative form of {@link rowByText}. */
const hasRow = (text: string): boolean =>
  screen.queryAllByRole('option').some(r => (r.textContent || '').includes(text))

/**
 * How many option rows are on screen.
 *
 * What a NARROWING test must wait on. The listing already contains the row a filter
 * is supposed to leave behind, so waiting for that row to be present is satisfied
 * before the view has debounced and proves nothing; and waiting for the filtered-out
 * row to be ABSENT is satisfied during the in-flight window, where there are no rows
 * at all. The count separates all three states: 3 before, 0 in flight, 1 after.
 */
const rowCount = (): number => screen.queryAllByRole('option').length

/** The crewmate rows on screen, top to bottom, by the name each row shows. */
const rowOrder = (names: string[]): string[] =>
  screen
    .queryAllByRole('option')
    .map(r => names.find(n => (r.textContent || '').includes(n)))
    .filter((n): n is string => !!n)

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <CommandBarOverlay open onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose, client }
}

const type = (text: string) => {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } })
}

/**
 * Mount the bar and enter the crewmates view the way a user does — the root's own
 * row, with no query typed, which is how the view's listing state is reached.
 *
 * The scope is confirmed by the PLACEHOLDER rather than by a row: the error and
 * empty-roster cases legitimately have no rows, and a helper that waited for one
 * would hang on exactly the states those tests exist to pin.
 */
const openMatesView = async () => {
  const mounted = mount()
  await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
  fireEvent.mouseDown(rowByText('Search Crewmates'))
  await waitFor(() => expect(screen.getByPlaceholderText('Search all crewmates…')).toBeTruthy())
  return mounted
}

beforeEach(() => {
  vi.clearAllMocks()
  chatFolders.mockResolvedValue([])
  agentCatalog.mockResolvedValue({ agents: ROSTER, default_agent: '' })
  dispatch.mockReturnValue({ unwrap: () => Promise.resolve('slot-1') })
  storeState.dashboard = { slots: [], unreadSlots: [] }
  storeState.chat = { slotStatusDetail: {}, activeSlot: null }
})

describe('command bar — the root', () => {
  it('lists Search Crewmates as a view row on an empty query', async () => {
    mount()
    await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
    // A `view` row states that it opens a surface rather than acting.
    expect(rowByText('Search Crewmates').textContent).toContain('View')
  })

  it('offers one row for the corpus and never the roster itself', async () => {
    mount()
    type('oncall')
    // A corpus is entered here, not flattened into the first page — so even an exact
    // crew name must not produce a crewmate row in the root.
    await waitFor(() => expect(hasRow('Search crewmates for')).toBe(true))
    expect(hasRow('Watches the pager')).toBe(false)
  })

  it('keeps one row per corpus, and one tail row each, with the crew row added last', async () => {
    // Four corpora now share this surface, each reached the same way. The crewmate
    // rows were added last, so this is the assertion that would catch them landing on
    // top of a row that was already there.
    mount()
    await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
    expect(hasRow('Search Sessions')).toBe(true)
    expect(hasRow('Search Artifacts')).toBe(true)
    expect(hasRow('Search Folders')).toBe(true)
    type('oncall')
    await waitFor(() => expect(hasRow('Search crewmates for')).toBe(true))
    expect(hasRow('Search sessions for')).toBe(true)
    expect(hasRow('Search artifacts for')).toBe(true)
    expect(hasRow('Search folders for')).toBe(true)
  })

  it('reaches the view through a word the reader knows instead of our own', async () => {
    // "Crewmate" is this product's vocabulary. A reader who has not opened the
    // Crewmates page reaches for "agent", and the row has to answer to it.
    mount()
    type('agent')
    await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
  })

  it('carries a typed query into the crewmates view instead of dead-ending', async () => {
    mount()
    type('acc')
    await waitFor(() => expect(hasRow('Search crewmates for')).toBe(true))
    fireEvent.mouseDown(rowByText('Search crewmates for'))
    // The query survives the hand-off: the view opens already narrowed, so the reader
    // does not retype what they just typed. The count is what says "narrowed" — the
    // view arriving on its full listing would also show `accountant`.
    await waitFor(() => expect(rowCount()).toBe(1))
    expect(hasRow('accountant')).toBe(true)
    expect(hasRow('oncall')).toBe(false)
  })

  it('builds the root WITHOUT fetching the catalog, which is the launcher invariant', async () => {
    mount()
    await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
    type('oncall')
    await waitFor(() => expect(hasRow('Search crewmates for')).toBe(true))
    // The whole reason the roster is a view and not a root group: `useAgents` fetches
    // this endpoint on mount, and the root promises never to issue a request.
    expect(agentCatalog).not.toHaveBeenCalled()
    expect(chatFolders).not.toHaveBeenCalled()
    expect(listApps).not.toHaveBeenCalled()
  })
})

describe('command bar — crewmates view, listing and search', () => {
  it('lands on the whole roster, alphabetically, and pays for exactly one fetch', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowOrder(['accountant', 'oncall', 'reviewer'])).toEqual([
      'accountant',
      'oncall',
      'reviewer',
    ])
    // Entering the view is the activation event, and it pays once.
    expect(agentCatalog).toHaveBeenCalledTimes(1)
  })

  it('asks for the GLOBAL roster, not whichever pane the reader last touched', async () => {
    // The bar fires from anywhere in the dashboard, so a session-scoped catalog read
    // would make which crew is reachable depend on the active chat's project.
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(agentCatalog).toHaveBeenCalledWith()
  })

  it('narrows on a PARTIAL name, which is the gesture the ticket asks for', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowCount()).toBe(3)
    type('acc')
    // Waited on the COUNT, which is the only unambiguous signal here: `accountant` is
    // already on screen in the unfiltered listing, so waiting for it to be present
    // resolves before the view has debounced, and waiting for `oncall` to be absent
    // resolves during the in-flight window where no rows exist at all.
    await waitFor(() => expect(rowCount()).toBe(1))
    expect(hasRow('accountant')).toBe(true)
    expect(hasRow('oncall')).toBe(false)
  })

  it('narrows from ONE character, because the corpus is already in hand', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowCount()).toBe(3)
    type('r')
    // Only `reviewer` carries an r; the count is what proves the filter ran rather
    // than the listing simply still being on screen.
    await waitFor(() => expect(rowCount()).toBe(1))
    expect(hasRow('reviewer')).toBe(true)
  })

  it('gives each row an avatar, a name and a one-line role, so two mates are distinguishable', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    const row = rowByText('oncall')
    // The role, which is what tells two similarly-named mates apart.
    expect(row.textContent).toContain('Watches the pager and triages alerts.')
    // The face. It is the row's own art rather than a per-corpus glyph, which is the
    // only thing that makes the icon column identify the ROW.
    expect(row.querySelector('svg, img')).toBeTruthy()
    // And the two rows really are different faces, not one repeated glyph.
    const other = rowByText('accountant')
    expect(row.querySelector('svg, img')?.outerHTML).not.toBe(
      other.querySelector('svg, img')?.outerHTML,
    )
  })

  it('shows a working crewmate as working, read off the live slot frames', async () => {
    // A member slot is born with its crew pinned to `agent`, which is why the running
    // set is keyed on the name rather than on a slot key the catalog cannot rebuild.
    storeState.dashboard = {
      slots: [{ key: 'member-oncall', mode: 'member', agent: 'oncall', running: true }],
      unreadSlots: [],
    }
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowByText('oncall').textContent).toContain('Working')
    // And an idle mate is not labelled — the column is for state that is CHANGING.
    expect(rowByText('accountant').textContent).not.toContain('Working')
  })

  it('counts a mate whose SUBAGENTS are running as working', async () => {
    storeState.dashboard = {
      slots: [
        { key: 'member-oncall', mode: 'member', agent: 'oncall', running: false, subagents_running: true },
      ],
      unreadSlots: [],
    }
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowByText('oncall').textContent).toContain('Working')
  })

  it('ignores a running slot that is not a member thread', async () => {
    // An ordinary chat running the same agent is not that crewmate's own thread, and
    // reporting it as the mate working would tell the reader not to interrupt a mate
    // that is idle.
    storeState.dashboard = {
      slots: [{ key: 'chat-1', mode: 'chat', agent: 'oncall', running: true }],
      unreadSlots: [],
    }
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowByText('oncall').textContent).not.toContain('Working')
  })

  it('re-derives when a frame changes which mate is working, not after a stale window', async () => {
    // The running set is part of the query's identity precisely so this reaches the
    // screen: rebuilding the engine alone does not re-run a resolved query.
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(rowByText('oncall').textContent).not.toContain('Working')
    storeState.dashboard = {
      slots: [{ key: 'member-oncall', mode: 'member', agent: 'oncall', running: true }],
      unreadSlots: [],
    }
    // An ArrowDown, deliberately NOT a keystroke in the query. Typing would change
    // `mateQuery` and so change the key on its own, which would let this pass with the
    // running set absent from the key — the very thing it exists to pin. This only
    // re-renders, so the republished store read is the ONLY thing that can move the
    // key, and a stale cached row is what fails here.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    await waitFor(() => expect(rowByText('oncall').textContent).toContain('Working'))
  })

  it('names Enter for the destination in the footer', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    // The bar's promise is that Enter does something specific, and the footer says
    // what: this Enter lands in a conversation.
    expect(document.body.textContent).toContain('Open Chat')
  })

  it('offers the way back when a query matches nothing, so the view never dead-ends', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    type('zzzzz-no-such-crew')
    await waitFor(() => expect(hasRow('show all instead')).toBe(true))
    fireEvent.mouseDown(rowByText('show all instead'))
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
  })

  it('tells a reader with no crew that they have none, and where to make one', async () => {
    // Not "no matches": the reader typed nothing, so reporting a failed match would
    // describe a query they never made.
    agentCatalog.mockResolvedValue({ agents: [], default_agent: '' })
    await openMatesView()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No crewmates yet'))
    expect(screen.getByRole('status').textContent).toContain('Crewmates page')
  })

  it('EXCLUDES templates from the view, since they have no chat thread', async () => {
    agentCatalog.mockResolvedValue({
      agents: [...ROSTER, mate({ name: 'shipper', selection_kind: 'template' })],
      default_agent: '',
    })
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    expect(hasRow('shipper')).toBe(false)
  })

  it('offers a retry ROW when the catalog read fails, reachable from the keyboard', async () => {
    // This is the one corpus with no warm-cache path, and `useAgents` records what a
    // swallowed failure on this endpoint cost: a failed load and a one-crew install
    // rendered identically through six triage passes. A bare <button> in a paragraph
    // would be unreachable for the keyboard path that got here.
    agentCatalog.mockRejectedValue(new Error('catalog read refused: 503'))
    await openMatesView()
    await waitFor(() => expect(hasRow('Retry')).toBe(true))
    agentCatalog.mockResolvedValue({ agents: ROSTER, default_agent: '' })
    fireEvent.mouseDown(rowByText('Retry'))
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
  })

  it('leaves the view on Backspace at an empty query, back to the root', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Backspace' })
    await waitFor(() => expect(hasRow('Search Crewmates')).toBe(true))
    expect(hasRow('Watches the pager')).toBe(false)
  })
})

describe('command bar — crewmates view, selection', () => {
  it('navigates into the mate\'s own chat thread and closes the bar', async () => {
    const { onClose } = await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    fireEvent.mouseDown(rowByText('oncall'))
    expect(navigate).toHaveBeenCalledWith('/members?member=oncall')
    expect(onClose).toHaveBeenCalled()
  })

  it('navigates by the crewmate\'s IDENTITY even when a display label hides it', async () => {
    // The page resolves `?member=` against the immutable name, so routing by the
    // label would open the page on a crew that does not exist.
    await openMatesView()
    await waitFor(() => expect(hasRow('reviewer')).toBe(true))
    fireEvent.mouseDown(rowByText('reviewer'))
    expect(navigate).toHaveBeenCalledWith('/members?member=qa-bot')
  })

  it('encodes a crew name that would otherwise truncate the parameter', async () => {
    agentCatalog.mockResolvedValue({ agents: [mate({ name: 'Review & QA' })], default_agent: '' })
    await openMatesView()
    await waitFor(() => expect(hasRow('Review')).toBe(true))
    fireEvent.mouseDown(rowByText('Review'))
    expect(navigate).toHaveBeenCalledWith('/members?member=Review%20%26%20QA')
  })

  it('opens the SELECTED row on Enter after arrowing, not the first one', async () => {
    await openMatesView()
    await waitFor(() => expect(hasRow('oncall')).toBe(true))
    const input = screen.getByRole('combobox')
    // Listing order is alphabetical: accountant, oncall, reviewer.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/members?member=oncall')
  })
})
