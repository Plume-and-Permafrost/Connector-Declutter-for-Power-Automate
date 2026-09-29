# Architecture

How Connector Declutter works inside, and why it is built the way it is. The
[README](../README.md) covers installing and using it.

## Response filtering

Response bodies cannot be rewritten with `declarativeNetRequest`, and the designer
uses `XMLHttpRequest` rather than `fetch`, so filtering happens in page context by
hooking both. Two endpoints feed the whole panel:

- `POST …/powerautomate/operationGroups` — the connector list
- `POST …/powerautomate/operations` — a connector's actions, and search

Filtering there rather than in the DOM means search, pagination and result counts
stay consistent with each other, and there is nothing to re-hide when the panel
re-renders.

Filtering is per environment. The request host encodes the environment id (strip the
dashes, lowercase, then all-but-the-last-two characters, a dot, and the last two), so
a tab that moves between environments picks up the right policy with no reload. Where
several policies govern one environment, `Blocked` in any of them wins.

A 250-entry page routinely filters down to single figures, which would stall the
panel's infinite scroll. When that happens the hook follows `nextLink` itself and
merges pages until the result looks full again, handing back the link *after* the
last page it consumed so nothing repeats.

## The extra filter pills

The designer's connector filter — All, Built-in, Shared, Custom — is not markup
that can be added to. The pills and the predicate behind each one both come from
one class in its bundle:

```
getRuntimeCategories()                          -> [{ key, text }, …]  the pills
filterConnector(connector, category)            -> boolean             browsing
searchOperations(term, actionType, category, …) -> Promise             searching
```

So that class is what gets extended, in `src/maker/search-service.js`. Appending to
`getRuntimeCategories` means the designer renders our pills itself, with its own
markup, its own selected state and its own "No results found for the specified
filters" when one matches nothing. There is nothing to keep in step with a
re-render, and nothing that breaks when Fluent renames a class.

Building the pills out of cloned DOM does not work, and it is worth saying why:
React binds handlers through its own fiber tree, and a node the extension creates
has no fiber. Such a pill looks right and does nothing when clicked.

The class is found by **shape** — those three method names — not by webpack module
id and not by any minified identifier, because both change on every deploy. Getting
at the module cache means wrapping each chunk's factories as they are pushed onto
`webpackJsonp`: this build's jsonp callback ignores `executeModules`, so pushing a
module of our own and letting it run does not work, but the first wrapped factory
the app executes is handed `__webpack_require__` and that exposes the cache. If the
shape ever stops matching, the extension logs it, gives up after a minute, and the
designer keeps its stock behaviour.

Searching goes through the service's tag mapper, which turns a category it does not
recognise into no filter at all. So a search under one of our pills asks the
designer for `ALL` and narrows the answer here — and writes the narrowed list back
to `lastSearchResults`, which is what `getOperationById` reads when a result card is
clicked. Narrowing reads each result's `operationGroup`, not its `api`: a built-in
operation has `properties.api = null`, so matching on the connector alone drops
every built-in from every search made under one of these pills.

This is a different layer from the response filtering above and the two do not
overlap: that one hides what the maker cannot use, always, on the wire; this one is
the maker choosing a subset of what is left, one click at a time.

**In Flow** needs one more thing: knowing what is in the flow. That comes off the
wire like everything else here. Opening a flow fetches it expanded, and the response
carries both `properties.connectionReferences` — keyed by connector name — and a
`definitionSummary` whose connector steps name their `api`. Rather than reaching
into that shape by path, the body is walked and every group name in it collected, so
a saved flow's *request* body updates the filter without waiting for a refetch. The walk is deferred by a tick: the hook holds the load event until a
transform settles, opening a flow is the slowest thing the designer does, and a
reader with no opinion on the body has no business adding to it.

Three details, each of which got this wrong before it got it right:

- `…/flows/{id}/connections` looks like exactly the endpoint for this and is not.
  Despite sitting under the flow's own path it answers with every connection the
  *signed-in user* holds — including connectors the flow does not use at all — so
  it is deliberately not read. Using it
  would have made this filter mean "connectors I have ever signed in to".
- A flow says `properties.apiId: …/apis/shared_logicflows`, which is the flow
  itself rather than a connector in it. It is skipped along with `shared_powerflows`
  and `shared_pqogenericconnector` — the same set the designer excludes from its own
  connection queries.
- Built-in steps name nothing: a bare `{ type: 'Switch' }`, or a `{ type: 'Request',
  kind: 'Button' }`, with no group on them even in a response expanded to include
  every operation's definition. So the pair is looked up in a table taken from the
  operation catalogue. The *pair* — the type alone is ambiguous, `Request` being a
  step in eighteen different groups depending on its kind (Button is Flow, Http is
  Request, TeamsWebhook is Teams), while `(type, kind)` picks exactly one group for
  every built-in operation there is, with no collisions. A pair the table has not
  got is skipped rather than guessed at, so a built-in released since it was taken
  costs its group here and nothing else.

## Fail open

Anything the extension cannot classify with confidence stays visible: built-ins,
custom connectors, connectors newer than the imported policy, policies with an
`environmentType` it does not recognise, and connectors your tenant marks
unblockable. A designer group covered by several policy entries — the Power Virtual
Agents channels all map onto one group — is hidden only when every one of them is
blocked. The category filters are the deliberate exception, because those are your
explicit choices.

## Microsoft, My Filter and In Flow

The extension adds three filters of its own beside the designer's All, Built-in,
Shared and Custom:

- **Microsoft** — a fixed list of Microsoft's own connectors.
- **My Filter** — whatever you tick in the settings page.
- **In Flow** — what the flow on screen already uses, connectors and built-ins.

They behave like the designer's own, because they are the designer's own: which one
is selected is its state, not the extension's, and picking **All** turns the filter
off again. They are separate from the category filters and from DLP hiding — a pill
narrows what is left after those have run, and cannot re-admit anything they hide.
Nothing here is on until a pill is clicked.

**Microsoft** is Microsoft's *products*, not everything Microsoft *publishes*. The
catalogue's only marker is the publisher, and that is not the same question —
Microsoft publishes the Salesforce, Dropbox, Gmail, Slack and Trello connectors too.
So the list is the publisher's narrowed by brand: Azure, Dynamics, Microsoft 365,
Power Platform and the wholly-owned brands (GitHub, LinkedIn, Skype), plus all
seventeen built-in groups, which are Microsoft's own and would be startling to lose.
Protocol connectors Microsoft happens to publish — FTP, SFTP, SMTP, RSS, File System —
are left out; they are not a product. It is a snapshot of the catalogue this was
built against, so anything released since will be missing, and **My Filter** is
where to add it.

**My Filter** is edited in the settings page: a searchable list of every
connector with a checkbox each, and a **Clear all** button that asks first. The list
is what the designer has shown while the extension was watching — the interceptor
reports every operation group it sees and the service worker keeps the union — so it
starts empty and fills in the first time you open a connector panel. Those names are
kept under their own storage key rather than in the settings, so the full catalogue's
worth of them stay out of an exported configuration.

The designer builds its filter list once per render, so a tick made while a designer
tab is open reaches it on the next one; reload the tab if it does not seem to have
taken. An empty **My Filter** matches nothing, which is what an explicit click on
an empty filter should do — the designer shows its own empty state, and **All** is one
click away.

**In Flow** needs no setting up: it reads the open flow. A flow built out of nothing
but Condition, Switch and Initialize variable comes to Control and Variable, and one
with a Teams action in it adds Teams. It follows the flow as you save it, and it
empties when you move to a different flow.

## Steady rows

Hovering a connector card makes the row about half a pixel taller, and because the
list is virtualised — Fluent's `ms-List` measures its cells and re-lays the page out
when one changes — the whole grid twitches as the pointer crosses it. **Stop rows
resizing when you hover them** pins it.

The box shadow looks like the culprit and is innocent: a shadow never takes part in
layout. The cause is two controls the designer only puts in the row while it is
hovered, from its own styles:

```js
recommendationPanelCard: {
  '&:focus, &:hover, &:focus-within': {
    '& .favorite-button-visible-on-hover': { display: 'inline' },
    '& .info-dot-visible-on-hover':       { display: 'inline' }
  }
}
recommendationPanelCardVisibleOnHover: { display: 'none' }
```

So the info dot — and the favourite star, when the designer has decided to hide that
one too — go from `display: none` to `display: inline`, and the row grows by whatever
the taller of them adds. The setting reserves their box all the time and toggles only
`visibility`, on exactly the three states the designer uses. `display: inline` is the
value the designer itself sets on hover, so the reserved box and the hovered box are
the same box and there is nothing left to change. The cost is that every row is always
as tall as a hovered one.

Those two class names are hand-written rather than generated, which is the only reason
this can be pinned in CSS at all — everything else on the card is a Griffel atomic
class whose name changes between builds.

## Panel sections

Above the connector list the designer stacks three collapsible sections — Favourites,
AI capabilities and Built-in tools. Each can be removed, and the Favourites list can be
opened automatically. All four are off by default.

Removing a section is a layout choice, not a filter: it is the same catalogue
underneath, so everything in a hidden section is still in the list below it and still
turns up in search.

Opening Favourites presses the section's own **See all** link rather than expanding the
accordion — each section shows only its first few entries, so expanding one is not the
same as seeing them all. The link sits beside the heading rather than inside the
collapsible panel, so it works whether the section is expanded or not; when it is absent,
because nothing is truncated, a collapsed section is expanded instead. It is done once
per time the panel opens, keyed on the panel rather than on the sections — clicking
**See all** replaces the sections with the list, so a latch keyed on the accordion would
fire again the moment you navigated back.

Unlike the connector rows, the sections carry no automation id, no id and no
aria-label: the heading text is the only thing that tells them apart, so only an
English designer is recognised. Spelling, case and punctuation are ignored, so both
*Favourites* and *Favorites* match, but a designer in another language keeps all three
sections rather than losing the wrong one.

Hiding a panel section is the same idea in reverse: `sections.js` marks each
`.fui-AccordionItem` with `data-cdpa-section` once it has read the heading, and one
stylesheet hides the marked values the settings ask for. Here the rule *is*
`display:none !important` — the item's own `display` comes from the same
runtime-inserted Griffel class, and a hidden section has no hover state left to
protect. Marks are identities rather than settings, so toggling a section rewrites
the stylesheet and touches nothing in the DOM.

## Colour coding

Colour coding tints with `background-image: linear-gradient(c, c)` rather than
`background-color`. The card sets its own background-color from a Griffel atomic class
(`.fxugw4r{background-color:var(--colorNeutralBackground1)}`) which is added at runtime
with `insertRule`, so it always lands after the extension's `document_start` sheet and
wins at equal specificity. Raising specificity is unwinnable against generated class
names and `!important` would kill the card's hover feedback, so the tint uses a
different longhand instead: Griffel forbids shorthands, so nothing the designer emits
resets `background-image`, and hover still shifts the base colour under a fixed tint.

There are five tints. Two are the DLP classifications, always meaningful; the other
three say why a connector would normally have been hidden, and only appear with
**Show everything** on, since with it off those rows are not in the panel at all. A
key beside the panel's close button names each colour, with a tooltip on hover and on
keyboard focus.

`Blocked` outranks every category rule: DLP is the one constraint a maker cannot lift
from the panel, so a blocked connector reads as blocked even when a rule catches it
too. That makes the category colours rarer than they look — desktop and agent
connectors are often blocked by DLP as well — so those two colours mean specifically "hidden by a rule of yours, and otherwise
allowed". Colour keys are category rule ids, so a rule the user adds gets its own
swatch in settings; one with no colour set falls back to a neutral grey.

The key's tooltip is a top-layer `popover`, not a positioned pseudo-element. The
panel's search bar sits in a stacking context that paints above the header's, so an
absolutely positioned tooltip goes behind it however high its `z-index` — only the
top layer is outside that ordering, and outside any overflow clipping on the way up.

Colour coding matches rows on `data-automation-id="flow-op-search-result-…"`. The
designer is Fluent UI v9, so its class names are generated and unmatchable, but that
automation id is the connector's resource path (lowercased, `/` and `.` turned into
`_`) — so the connector is read straight off the DOM rather than guessed from its
display name. That gives it a name and a display name but no tags, and a tag is the
only thing that matches a rule like `DesktopFlow` — so the interceptor stashes what
each catalogue response said about every group in `__cdpa.catalogue`, and the
decorator reads it, falling back to the DOM. Both run in page context, so this is a
shared object rather than a message.

## Logging and tokens

`storage` and the pure common modules log into whichever of the consoles listed in the README they were
loaded into, so those channels turn up in more than one place.

`bridge` and `admin-ui` run in the isolated world, so they come from `src/iso/log.js`;
everything else comes from `src/common/log.js`. The two behave the same.

The designer's own page context cannot read `chrome.storage`, so the flag reaches it
two ways: the bridge pushes it across with the settings, and it is mirrored into that
origin's `localStorage` under `cdpa:debug`. The mirror is what makes logging live from
`document_start`, so **reload the tab** after switching it on to see the startup path.

Logging is treated as optional infrastructure: every module carries a silent
fallback, so if `log.js` does not load the extension keeps filtering and simply says
nothing. A debug switch must never be able to stop the thing working — `node --test`
covers that case explicitly.

The hook collects bearer tokens in page memory to drive auto-fetch. They are never
logged, never stored and never leave the page — the log records only that a candidate
was captured and whether it was accepted.

## Content scripts and worlds

No build step and no dependencies. Every source file is a classic script that hangs
its exports off a shared `__cdpa` global, so the same file loads unchanged in a
content script (which cannot use ES modules), in the service worker via
`importScripts`, in the extension's own pages, and under `node --test`.

Each origin gets two `content_scripts` entries, one per world, and **the two must not
list the same file**. Chrome injects a given path into a document once: whatever
appears in both entries reaches only the first, with no warning and no error. That is
why the isolated worlds load `src/iso/log.js` rather than `src/common/log.js`, and why
`decorate.js` sits in page context beside the modules it needs instead of in the
isolated world with the bridge. `test/manifest.test.js` fails the build if the two
entries for an origin ever share a file, or if any script reaches for a `__cdpa`
member no sibling in its entry defines.
