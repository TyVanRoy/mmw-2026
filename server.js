const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EVENTS_FILE = path.join(__dirname, 'public', 'events.json');
const SOURCE_URL = 'https://19hz.info/eventlisting_Miami.php';
// MMW 2026 full range: Wed Mar 18 through Wed Apr 1
const MONTH_MAP = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
const RANGE_START = new Date(2026, 2, 18); // March 18
const RANGE_END   = new Date(2026, 3, 1);  // April 1

// ── Serve static files ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Parse 19hz HTML into raw event objects ─────────────────────────────────
function parseEvents(html) {
  const $ = cheerio.load(html);
  const raw = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const dateCell = $(cells[0]).text().trim();

    // Extract date: "Fri: Mar 27  (12pm-11pm)" → "Mar", "27"
    const dateMatch = dateCell.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/);
    if (!dateMatch) return;
    const eventDate = new Date(2026, MONTH_MAP[dateMatch[1]], parseInt(dateMatch[2]));
    if (eventDate < RANGE_START || eventDate > RANGE_END) return;

    // ISO date key: '2026-03-27'
    const mm = String(eventDate.getMonth() + 1).padStart(2, '0');
    const dd = String(eventDate.getDate()).padStart(2, '0');
    const dayKey = `2026-${mm}-${dd}`;

    const timeMatch = dateCell.match(/\(([^)]+)\)/);
    const timeRaw = timeMatch ? timeMatch[1] : '';

    // Parse startHour from time string
    const startMatch = timeRaw.match(/^(\d+)(?::(\d+))?(am|pm)/i);
    let startHour = 0;
    if (startMatch) {
      startHour = parseInt(startMatch[1]);
      const meridiem = startMatch[3].toLowerCase();
      if (meridiem === 'pm' && startHour !== 12) startHour += 12;
      if (meridiem === 'am' && startHour === 12) startHour = 0;
      // After-hours (2am-6am) treated as 26-30 for sort continuity
      if (meridiem === 'am' && startHour >= 1 && startHour <= 6) startHour += 24;
    }

    // Event cell: "Title @ Venue (Area) genre, genre"
    const eventCell = $(cells[1]).text().trim();
    const link = $(cells[1]).find('a').first().attr('href') || '';

    // Split on @ to get title+artists vs venue+area+genres
    const atIdx = eventCell.indexOf(' @ ');
    const titlePart = atIdx > -1 ? eventCell.slice(0, atIdx).trim() : eventCell;

    let venuePart = atIdx > -1 ? eventCell.slice(atIdx + 3) : '';
    // Venue part: "Venue Name (Area) genre, genre"
    const venueAreaMatch = venuePart.match(/^(.+?)\s*\(([^)]+)\)\s*(.*)/);
    const venue = venueAreaMatch ? venueAreaMatch[1].trim() : venuePart.trim();
    const area = venueAreaMatch ? venueAreaMatch[2].trim() : '';
    const genreStr = venueAreaMatch ? venueAreaMatch[3].trim() : '';
    const genres = genreStr ? genreStr.split(',').map(g => g.trim().toLowerCase()).filter(Boolean) : [];

    const priceStr = $(cells[2]).text().trim();
    const age = $(cells[3]).text().trim() || 'TBA';

    raw.push({ day: dayKey, titlePart, venue, area, genres, priceStr, age, timeRaw, startHour, link });
  });

  return raw;
}

// ── Extract numeric price from string ──────────────────────────────────────
function parsePrice(str) {
  if (!str || /free/i.test(str)) return 0;
  const m = str.match(/\$(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// ── Claude enrichment: infer type + split name vs artists ──────────────────
async function enrichWithClaude(rawEvents) {
  const prompt = `You are enriching event data for a Miami Music Week event tracker.

For each event below, return a JSON array (same order, same length) where each element has exactly these fields:

- "name" (string): The event brand, series, or party name. Split this from the artist list. If the title is just an artist name with no event brand, use the artist name.
- "artists" (string): The full artist lineup as a comma-separated string. If the name already covers the only artist, use an empty string "".
- "type" (string): One of "pool", "outdoor", "night", "festival", "cruise"
  - "pool" — hotel pool party (e.g. Surfcomber, Sagamore, National Hotel, Strawberry Moon)
  - "outdoor" — open-air non-pool (Wynwood lots, parks, beaches, racetracks, islands, Factory Town)
  - "night" — indoor nightclub or venue (Club Space, Floyd, E11even, Do Not Sit, etc.)
  - "festival" — multi-stage festival (Ultra, etc.)
  - "cruise" — boat/yacht event

Example input:
0: title="Black Book Records: Chris Lake, Eats Everything, Ragie Ban" venue="Toe Jam Backlot" area="Miami" genres="tech house"
1: title="Deadmau5" venue="Toe Jam Backlot" area="Miami" genres="progressive, electro"

Example output:
[{"name":"Black Book Records","artists":"Chris Lake, Eats Everything, Ragie Ban","type":"outdoor"},{"name":"Deadmau5","artists":"","type":"outdoor"}]

Respond ONLY with the raw JSON array. No markdown fences, no explanation, no trailing text.

Events:
${rawEvents.map((e, i) => `${i}: title="${e.titlePart}" venue="${e.venue}" area="${e.area}" genres="${e.genres.join(', ')}"`).join('\n')}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = response.content[0].text.trim();
  // Strip markdown fences if Claude wraps the JSON despite instructions
  text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(text);
}

// ── Main refresh pipeline ──────────────────────────────────────────────────
async function refresh() {
  console.log(`[${new Date().toISOString()}] Refreshing events...`);

  let html;
  try {
    const res = await fetch(SOURCE_URL);
    html = await res.text();
  } catch (err) {
    console.error('Failed to fetch 19hz:', err.message);
    return;
  }

  const rawEvents = parseEvents(html);
  console.log(`Parsed ${rawEvents.length} events for MMW 2026`);

  if (rawEvents.length === 0) {
    console.warn('No events parsed — skipping write');
    return;
  }

  let enriched;
  try {
    enriched = await enrichWithClaude(rawEvents);
  } catch (err) {
    console.error('Claude enrichment failed:', err.message);
    return;
  }

  const events = rawEvents.map((raw, i) => ({
    day: raw.day,
    name: enriched[i]?.name || raw.titlePart,
    artists: enriched[i]?.artists || '',
    venue: raw.venue,
    area: raw.area,
    startHour: raw.startHour,
    timeDisplay: raw.timeRaw,
    type: enriched[i]?.type || 'night',
    genres: raw.genres,
    priceRaw: parsePrice(raw.priceStr),
    priceDisplay: raw.priceStr || 'TBA',
    age: raw.age,
    link: raw.link,
  }));

  fs.writeFileSync(EVENTS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), events }, null, 2));
  console.log(`Written ${events.length} events to events.json`);
}

// ── Exports for test script ─────────────────────────────────────────────────
module.exports = { parseEvents, parsePrice, enrichWithClaude, refresh, SOURCE_URL, RANGE_START, RANGE_END };

// ── Boot ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    // Run immediately on startup, then every 5 minutes
    await refresh();
    cron.schedule('*/5 * * * *', refresh);
  });
}
