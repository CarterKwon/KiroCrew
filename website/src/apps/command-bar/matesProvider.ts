import { createElement } from 'react'
import { Users } from 'lucide-react'

import CrewAvatar from '../../components/CrewAvatar'
import { crewDisplayName, type KiroCrewAgent } from '../../components/AgentSelector'
import { fuzzyMatch, makeScoreThenNameComparator } from '../../utils/fuzzyMatch'
import { i18nT } from '../../i18n/t'
import type { Result, ResourceProvider } from '../../components/commandPalette/types'

/**
 * Crewmates corpus for the Command Bar's **Search Crewmates** view.
 *
 * ## Why a scoped view and not a root corpus
 *
 * `rootIndex.ts` states the rule this obeys: the first page carries only rows
 * already in memory, and a CORPUS is reached through one `view` row the reader
 * enters, because entering is the activation event that lets the engine run its
 * first query. That file also records what happened when a corpus was filed into
 * the root instead — the sidebar's folders — and the two mechanisms (an idle
 * demotion and a group cap) it then took to keep the reader's own rows from
 * filling a page nobody had typed into.
 *
 * The roster makes the same argument concretely rather than by analogy. Crewmates
 * come from `GET /api/agents/catalog`, and `useAgents` FETCHES it on mount — so a
 * root group would either issue that request on every open of the bar, which is
 * the one promise this surface makes, or subscribe to the cache with
 * `enabled: false` and render an empty Crewmates group on a cold install, which
 * reads as the feature being missing. A view pays for the fetch once, when the
 * reader asks for it. Same bargain the sessions, artifacts and folders views make.
 *
 * ## What it matches
 *
 * Fuzzy match over two fields, both of them NAMES:
 *
 *  - the mate's DISPLAY label ({@link crewDisplayName}), which is what the reader
 *    is looking at on the Crewmates page, and
 *  - its immutable `name`, when a display label hides it — that name is the
 *    identity every route and binding is keyed on, so a reader who knows a mate
 *    by it must still be able to reach the mate with it.
 *
 * An identity match scores strictly below a label match ({@link ALIAS_MATCH_PENALTY}),
 * so the word on screen always outranks the one behind it.
 *
 * The DESCRIPTION is rendered but deliberately not matched. Matching it would make
 * this a content search over prose, which is a different corpus with a different
 * cost, and the row's own subtitle already tells the reader why the mate they were
 * scanning for is the right one.
 *
 * ## What a row shows
 *
 * The mate's own face, its name, its one-line role, and — when it is working — that.
 * The avatar is the point of the icon column here: a roster is a set of faces the
 * reader already recognises, so it identifies a row in a way no glyph can, and
 * `rootIndex.ts` makes exactly that argument about a per-group icon ("the column
 * only earns its width when the icon identifies the row").
 *
 * There is deliberately NO "Crewmate" kind label in the right-hand column. Inside
 * this view every row is one, so the word would answer a question nobody asked
 * twice — the column belongs to state that is CHANGING, which is what the running
 * indicator uses it for.
 */

const PROVIDER_ID = 'mates'

/**
 * Catalog KEY for the view's label, resolved where the provider object is BUILT
 * (never at module scope, which would freeze the boot language).
 */
const PROVIDER_LABEL_KEY = 'apps.commandBar.cmd_search_mates'

/**
 * Edge length of the avatar, in px.
 *
 * Sized to the row's existing icon column (`w-4`, 16px) rather than to the face.
 * Every corpus in this bar renders into that one column, and the column is what
 * puts every row's title on the same left edge — a wider avatar would buy legibility
 * by moving the crewmate rows' titles away from where the reader's eye already is.
 * At this size the face still carries its colour and silhouette, which is what
 * distinguishes one row from another in a list being scanned.
 */
const AVATAR_PX = 16

/**
 * Score subtracted when the query matched the immutable `name` rather than the
 * DISPLAYED label. Large enough that any label match sorts above any identity
 * match (fuzzyMatch scores are bounded far below this).
 */
const ALIAS_MATCH_PENALTY = 1_000_000

/** Injectable dependencies for {@link createMatesProvider}. */
export interface MatesProviderDeps {
  /** Fetch the execution-choice catalog (React-Query-cached by the caller). */
  fetchMates: () => Promise<KiroCrewAgent[]>
  /** Land on a mate: open its pinned DM thread on the Crewmates page. */
  openMate: (name: string) => void
  /**
   * Whether this mate is working right now, read from the live slot frames the
   * dashboard already keeps current.
   *
   * Injected rather than read here for the reason `fetchMates` is: the corpus stays
   * free of React hooks so it can be exercised with a plain mock, and the store
   * wiring lives in the one component that owns this app's seams.
   *
   * REQUIRED, not defaulted. A builder that could leave it out would render every
   * mate as idle, and "idle" is a claim about a running agent rather than the
   * absence of one — the same three-state discipline the Crewmates page keeps about
   * its own roster.
   */
  isRunning: (name: string) => boolean
}

/**
 * The crew glyph, for rows that name the CORPUS rather than one mate.
 *
 * Exported so the overlay's view row and its fallback row draw the same icon as
 * this provider's own label; three spellings of one glyph is how two of them drift.
 */
export function matesIcon() {
  return createElement(Users, { size: 14, className: 'lucide-inline' })
}

/**
 * A crew field as a STRING, for anything that will call a string method on it or
 * render it.
 *
 * `KiroCrewAgent.name` and `.description` are typed `string`, and at the type level
 * this is redundant — but the values come from the config file on disk, which a hand
 * edit or an older writer can leave holding a number, `null` or an object.
 * `fuzzyMatch` calls `.toLowerCase()` on its candidate, so an unguarded read throws
 * inside the view's own query and takes the launcher down in render, where there is
 * no row left to explain it and no way to clear the box that triggered it.
 *
 * A non-string reads as EMPTY rather than being stringified, the same rule
 * `folderNameText` keeps and for the same reason: a malformed crew simply does not
 * match, instead of answering to the literal text `[object Object]`.
 */
function nameText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The mate's own face, at the row's icon size. */
function mateAvatar(mate: KiroCrewAgent, seed: string, running: boolean) {
  return createElement(CrewAvatar, {
    seed,
    avatar: mate.avatar,
    size: AVATAR_PX,
    // The face's own working animation, so the row's avatar and its status line say
    // the same thing. A still face beside a "Working…" label reads as a stale row.
    // `subtle`, because this is a dense list and the motion is a hint, not the
    // subject.
    ...(running ? { state: 'working' as const, working: 'subtle' as const } : {}),
    className: 'shrink-0',
  })
}

/**
 * Build the Crewmates {@link ResourceProvider} from injected dependencies.
 * Pure (no hooks) so it can be exercised directly in tests.
 */
export function createMatesProvider(deps: MatesProviderDeps): ResourceProvider {
  const { fetchMates, openMate, isRunning } = deps

  return {
    id: PROVIDER_ID,
    // A GETTER, not a plain call: the provider object is built inside a `useMemo`
    // whose deps do not include the language, and `LanguageProvider` re-renders
    // rather than remounting, so `label: i18nT(...)` would keep the pre-switch
    // wording forever. Same reasoning as the sessions and folders providers.
    get label() { return i18nT(PROVIDER_LABEL_KEY) },
    // The corpus glyph, not a face: this names the COLLECTION, and the product
    // already spells "the crew" with this icon on the sidebar and the Crewmates
    // page. A ghost seeded on a literal would draw a face belonging to no mate.
    icon: matesIcon(),
    // No `minQueryChars`: once the catalog is in hand the match is a local filter
    // over a roster the reader authored, so one character costs no round trip — and
    // a view that refused to narrow on one character would make the shortest names
    // the hardest to reach.
    async search(query: string): Promise<Result[]> {
      const q = query.trim()
      const rows = await fetchMates()
      // MEMBERS only. The catalog answers with configured members AND installed
      // shared templates under one `selection_kind`, and a template is not a
      // crewmate: it has no DM thread, so a row for one would navigate to a
      // Crewmates page that cannot open it. The two can also share a `name`, which
      // is why this filters on the kind rather than de-duplicating by name.
      const mates = rows.filter(m => m.selection_kind === 'member')

      const results: Result[] = []
      for (const mate of mates) {
        const identity = nameText(mate.name)
        const label = nameText(crewDisplayName(mate)) || identity
        const labelMatch = fuzzyMatch(q, label)
        // The immutable identity, consulted only when the label missed — and only
        // when it is actually a different string, so a mate with no display name
        // cannot match itself twice and outrank a mate that matched once.
        const aliasMatch =
          labelMatch || label === identity ? null : fuzzyMatch(q, identity)
        if (!labelMatch && !aliasMatch) continue
        const running = isRunning(identity)
        results.push({
          id: `${PROVIDER_ID}:${identity}`,
          providerId: PROVIDER_ID,
          title: label,
          // The mate's role, which is what tells two similarly-named mates apart.
          // Never highlighted: the description is not matched, so highlighting it
          // would mark characters the query did not find.
          subtitle: nameText(mate.description) || undefined,
          icon: mateAvatar(mate, identity, running),
          score: labelMatch ? labelMatch.score : (aliasMatch?.score ?? 0) - ALIAS_MATCH_PENALTY,
          indices: labelMatch ? labelMatch.indices : [],
          // A DOT, never a pill. The pill is reserved for what the reader OWES a
          // session, and "this mate is working" is something it is doing — the bar's
          // own status renderer keeps those two apart so "needs me" and "busy" never
          // look alike.
          ...(running
            ? {
                statusStyle: 'dot' as const,
                statusColorVar: '--accent',
                statusLabel: i18nT('apps.commandBar.working'),
                statusPulse: true,
              }
            : {}),
          // `navigate`, not `invoke`: opening a mate is a pure route change, and the
          // declarative kind is what makes the row copyable for free — `copyTarget`
          // turns a `navigate` action into a link without this provider knowing that
          // the bar has a clipboard at all.
          enter: { kind: 'navigate', route: mateRoute(identity) },
          onActivate: () => openMate(identity),
        })
      }

      // Score first, then the mate's NAME. Deliberately the display label rather
      // than a roster position: the Crewmates page orders by last activity, which
      // the catalog rows do not carry, so mirroring that order is not available here
      // and inventing a third order would be worse than a stable alphabet the reader
      // can predict.
      results.sort(makeScoreThenNameComparator(r => r.score, r => r.title))
      return results
    },
  }
}

/**
 * Route to a mate's pinned DM thread.
 *
 * Which crewmate is open rides the query string (`?member=<name>`) — the
 * Crewmates page's own contract, which is also why a reload keeps the thread. The
 * name is encoded: a crew may legitimately be called `Review & QA`, and an
 * unencoded `&` would truncate the parameter and open the page on nothing.
 *
 * Exported because the provider builds it for `enter` and the overlay's fallback
 * row has to reach the same address; two spellings of one route is how one of them
 * ends up wrong.
 */
export function mateRoute(name: string): string {
  return `/members?member=${encodeURIComponent(name)}`
}
