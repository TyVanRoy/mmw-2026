# MMW26 — Miami Music Week 2026 Event Tracker

A live-updating event tracker for Miami Music Week (March 18 – April 1, 2026). Scrapes [19hz.info](https://19hz.info/eventlisting_Miami.php) every 5 minutes, uses Claude to enrich the raw data, and serves a filterable single-page app.

---

## Project Structure

```
mmw26/
├── server.js          # Express server + cron job + parse + Claude enrichment
├── package.json
├── Procfile           # Heroku process declaration
├── .env.example       # Environment variable template
└── public/
    ├── index.html     # The SPA — all UI, filters, and rendering logic
    └── events.json    # Generated at runtime — do not edit manually
```

---

## How It Works

### Data Pipeline

1. **Fetch** — `server.js` hits `https://19hz.info/eventlisting_Miami.php` and parses the HTML table using `cheerio`
2. **Filter** — Only rows with dates in the `Mar 18 – Apr 1` range are kept
3. **Parse** — Each row is broken into: `titlePart`, `venue`, `area`, `genres[]`, `priceStr`, `age`, `timeRaw`, `startHour`
4. **Enrich** — The raw batch is sent to Claude (`claude-sonnet-4-6`) in a single API call. Claude returns a JSON array with `name` (event brand), `artists` (lineup string), and `type` (pool / outdoor / night / festival / cruise)
5. **Write** — The enriched array is written to `public/events.json` with a timestamp
6. **Serve** — Express serves `public/` as static files. The browser fetches `/events.json` on load and every 5 minutes thereafter

### Cron Schedule

Runs every 5 minutes: `*/5 * * * *`

On startup, `refresh()` is also called immediately so the file is never stale on a cold boot.

### Fallback

`index.html` still contains the hardcoded events array from the last manual sync. If `events.json` hasn't been written yet (e.g., during the first cold boot before the first `refresh()` completes), the page falls back to that bundled data silently.

---

## Fields

Each event object in `events.json` has:

| Field | Source | Notes |
|---|---|---|
| `day` | Parsed | ISO date string, e.g. `'2026-03-27'` |
| `name` | Claude inferred | Event/brand name, split from artist list |
| `artists` | Claude inferred | Full lineup as a string |
| `venue` | Parsed | Venue name from 19hz |
| `area` | Parsed | City/neighborhood (Miami, Miami Beach, etc.) |
| `startHour` | Parsed | Integer 0–30. After-hours (1–6am) stored as 25–30 for sort continuity |
| `timeDisplay` | Parsed | Raw time string from 19hz e.g. `"10pm-5am"` |
| `type` | Claude inferred | `pool` / `outdoor` / `night` / `festival` / `cruise` |
| `genres` | Parsed | Array of lowercase strings from 19hz tags |
| `priceRaw` | Parsed | Numeric — `0` for free, first `$N` found otherwise |
| `priceDisplay` | Parsed | Raw price string from 19hz |
| `age` | Parsed | `'18+'`, `'21+'`, `'All ages'`, or `'TBA'` |
| `link` | Parsed | Ticket/event URL |

### Fields Inferred by Claude vs Parsed Directly

**Claude infers:**
- `name` — 19hz combines title and artists into one field ("Black Book Records: Chris Lake, Eats Everything..."). Claude splits this into a clean event name and a separate artist string
- `artists` — the lineup portion after the split
- `type` — inferred from venue name and context. This is the most subjective field. Hotel venues → pool, Wynwood lots/parks/outdoor spaces → outdoor, clubs → night, etc.

**Parsed mechanically:**
- Everything else. If Claude's API is unavailable, the parse step still runs and the event appears with `type: 'night'` as default and `name` set to the raw `titlePart`

---

## Filters

The UI supports multi-select filters with OR logic within groups and AND logic across groups.

| Filter | Values |
|---|---|
| Day | Dynamically generated from event data (Mar 18 – Apr 1) |
| Time | Afternoon (12–6pm), Evening (6–10pm), Late Night (10pm–2am), After Hours (2am+) |
| Type | Pool Party, Open Air, Nightclub, Festival, Cruise |
| Genre | House, Tech House, Techno, Progressive, Deep House, Afro/Organic, Trance, Breaks, Bass/Dubstep, Drum & Bass, Big Room, EDM |
| Price | Free, Under $50, $50–$100, $100+ |
| Starred | Starred only |

### Genre Aliases

The genre filter uses grouped aliases so a single button covers related tags:

| Button | Matches |
|---|---|
| Afro / Organic | `afro house`, `organic house` |
| Trance | `trance`, `psytrance`, `hard trance` |
| Breaks | `breaks`, `miami bass` |
| Bass / Dubstep | `bass`, `dubstep`, `bass house`, `melodic dubstep`, `hybrid trap` |
| Big Room | `big room`, `big room house`, `latin house` |
| EDM | `edm`, `pop edm`, `electro house` |

---

## Setup

### Local

```bash
git clone <repo>
cd mmw26
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm start
# Open http://localhost:3000
```

For development with auto-restart on file changes:
```bash
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude enrichment |
| `PORT` | No | Defaults to `3000` |

### Heroku

```bash
heroku create mmw26
heroku config:set ANTHROPIC_API_KEY=your_key_here
git push heroku main
```

One eco dyno is sufficient. The app is a single Node process. No database, no worker — just Express + a cron.

**Note on Heroku dynos:** Eco/Basic dynos sleep after 30 minutes of inactivity. If you need the cron to fire reliably even with no traffic, upgrade to a Standard dyno or use an uptime monitor (e.g., UptimeRobot pinging the app every 20 minutes).

---

## Updating the Hardcoded Fallback Data

The hardcoded events array in `index.html` is a snapshot from a prior manual sync. To update it:

1. Run the server locally and wait for `events.json` to be written
2. Open `events.json`
3. Replace the `const events = [...]` array in `index.html` with the new array
4. Commit

Alternatively, ask Claude to re-fetch `https://19hz.info/eventlisting_Miami.php` and diff the current `events` array against the live source, then patch `index.html` accordingly. This was the workflow used during initial development.

---

## Extending the Project

### Changing the Date Range

In `server.js`, update `RANGE_START` and `RANGE_END`:

```js
const RANGE_START = new Date(2026, 2, 15); // March 15
const RANGE_END   = new Date(2026, 3, 5);  // April 5
```

The frontend generates day filter buttons and sections dynamically from the event data, so no HTML changes are needed.

### Changing the Source

The parser in `parseEvents()` is tightly coupled to 19hz's HTML table structure. If 19hz changes their markup, update the `cheerio` selectors accordingly. The table has columns: date/time | event+venue | price | age | organizers | links.

### Adjusting Claude's Inference

The enrichment prompt is in `server.js` inside `enrichWithClaude()`. If `type` inference is consistently wrong for certain venues, add explicit rules to the prompt, e.g.:

```
- "Hialeah Park Casino" → always "outdoor"
- "Club Space" or "Floyd" → always "night"
```

### Cost

At ~80 events per run and ~claude-sonnet-4-6 pricing, each enrichment pass costs roughly $0.01–0.03. At 5-minute intervals over the 15-day MMW window that's around $6–20 total. Well within reason. If cost is a concern, switch to `claude-haiku-4-5-20251001` in `server.js` — the task is simple enough.

---

## Known Quirks

- **`startHour` for after-hours sets:** Times between 1am–6am are stored as 25–30 (i.e., `+24`) so events that start after midnight sort correctly after 11pm events rather than appearing at the top of the list alongside morning pool parties. The time filter in the UI accounts for this — "After Hours" checks `startHour >= 2 && startHour < 12`.

- **Multi-day events:** Events like Ultra (Fri–Sun) or Where Are My Keys (Fri–Sun) appear only on Friday since that's their start date. The `timeDisplay` field notes the span (e.g. `"5pm – Sun 8am"`) but they won't appear when filtering to Saturday alone.

- **Price = $0 for TBA:** Events with no price listed get `priceRaw: 0`, which makes them appear under the "Free" filter. This is a known imprecision. Check `priceDisplay` for the actual string.

- **`type: 'cruise'` is rare** — only a couple of events. The Cosmic Gate Sunset Cruise and the Spring Break Boat Trip are the primary examples.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Server | Node.js, Express |
| Scheduling | node-cron |
| Scraping | node-fetch, cheerio |
| Enrichment | Anthropic Claude API (`@anthropic-ai/sdk`) |
| Frontend | Vanilla JS, single HTML file, no bundler |
| Hosting | Heroku (single dyno) |

---

## Prior Development Context

This project was built in a single Claude chat session. The frontend (`index.html`) went through several iterations:

- Initial build: hardcoded events, single-select filters, techno/house/tech house only
- Phase 2: multi-select filters with OR-within / AND-across logic
- Phase 3: full event list added (all genres, all types)
- Phase 4: expanded time slots (4 buckets) and genre filters (13 options with aliases)
- Phase 5: live data pipeline — `server.js` added, `index.html` converted to fetch from `events.json`

The Claude session included the complete event data parsed from 19hz as of late February 2026. The hardcoded fallback in `index.html` reflects that snapshot.
