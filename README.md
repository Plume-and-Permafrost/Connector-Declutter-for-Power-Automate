# Connector Declutter for Power Automate

A Chrome and Firefox extension that removes connectors you cannot use from the Power Automate
designer's "Add an action" panel.

The designer lists the entire connector catalogue regardless of what your tenant's
DLP policy blocks — picking a blocked connector only fails later, at save time. The
catalogue runs to well over a thousand connector groups, and in a tenant with a strict
policy most of them can be blocked, so the panel can shrink to a small fraction of
its stock size.

| Filter                            | Default                |
| --------------------------------- | ---------------------- |
| Blocked by DLP policy             | on (needs policy data) |
| MCP, agent and Copilot connectors | on                     |
| Desktop connectors                | on                     |

The two category filters need no policy data, so the extension declutters from the
moment it is installed.

It also adds three filter pills beside the designer's All, Built-in, Shared and Custom:

- **Microsoft** — Microsoft's own products and the built-in connectors.
- **My Filter** — the connectors you tick in Settings.
- **In Flow** — what the flow on screen already uses.

Anything the extension cannot classify with confidence stays visible: built-ins,
custom connectors and connectors newer than the imported policy are never hidden by
the DLP filter.

How it all works, and the traps behind the design, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installing

### Chrome / Edge

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this
folder. To package it for the Chrome Web Store or Edge Add-ons:

```bash
npm install
npm run build:chrome     # zips manifest.json and src/ into web-ext-artifacts/
```

### Firefox (140 or later)

Firefox has its own manifest, `manifest.firefox.json`, which the scripts stage into
`dist/firefox/` as `manifest.json`.

```bash
npm install
npm run firefox          # launches a clean Firefox profile with the extension loaded
npm run lint:firefox     # Mozilla's add-on linter
npm run build:firefox    # zips it into web-ext-artifacts/ for signing or AMO
```

If the designer is not being filtered, check `about:addons` → the extension →
**Permissions** and make sure the Power Automate and admin-centre sites are allowed.

**Keep the two manifests in step.** They differ only in `background` and Firefox's
`browser_specific_settings`; `test/manifest.test.js` fails if anything else drifts.

## Getting policy data in

The designer has no API that says which connectors are blocked, so the blocklist has
to come from the governance API:

- **From the admin centre (default).** Open the Power Platform admin centre's
  Policies page and click **Import** when the extension offers it. Later visits
  refresh the data silently.
- **Automatically (opt-in).** Turn on *Fetch DLP policies automatically* in Settings.
  The extension reuses the token the Power Automate portal already holds; it never
  leaves the page and is never stored. This only works for accounts that can read
  DLP policies.
- **By hand.** Settings accepts a pasted `/v1/policies` response, a single policy, or
  a plain list of connector IDs to block.

**If you are not an admin**, ask one to set up the extension and use **Export
configuration** in Settings. Importing that file gives you the same filtering with no
governance access.

Nothing is fetched on a schedule, and repeated failures back off from one hour up to
a day.

## Settings

Everything is optional and lives on the settings page: DLP hiding, the category
filters (each a list of connector IDs, tags and a name pattern), the **My Filter**
picker, auto-fetch, colour coding by DLP classification, hiding the designer's
Favourites / AI capabilities / Built-in tools sections, opening Favourites
automatically, stopping rows resizing on hover, manual import, configuration
export/import, and a debug log.

## Debug logging

Turn on **Write a debug log to the browser console** under Diagnostics in Settings,
then **reload the tab**. Messages are prefixed `[declutter:<channel>]` and split
across three consoles:

| Console                                                                             | Channels                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| DevTools on `make.powerautomate.com`                                                | `maker`, `http`, `policy`, `filters`, `paginate`, `decorate`, `sections`, `hover`, `search-service`, `in-flow`, `bridge` |
| DevTools on `admin.powerplatform.microsoft.com`                                     | `admin`, `admin-ui`                                                                                                      |
| `chrome://extensions` → Connector Declutter for Power Automate → **service worker** | `background`                                                                                                             |
| The extension's own pages                                                           | `options`, `popup`                                                                                                       |

## Development

```bash
npm test
```

No build step and no runtime dependencies: every source file is a classic script
that hangs its exports off a shared `__cdpa` global.

```
src/common/     pure logic: policy resolution, category filters, pagination, the HTTP hook
src/iso/        the isolated worlds' own logger
src/maker/      designer filtering, colour coding, panel sections, hover fixes and the filter pills (page context) and its bridge (isolated world)
src/admin/      admin-centre capture and the import prompt
src/background/ storage owner
src/ui/         popup and settings
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#content-scripts-and-worlds) before
touching `content_scripts` — the two entries for an origin must never list the same
file.

`ref/` holds captured HAR and API dumps. It is gitignored and contains real tenant
data — keep it out of commits.

---

<sub>This extension was written with help from [Claude](https://claude.ai)</sub>
