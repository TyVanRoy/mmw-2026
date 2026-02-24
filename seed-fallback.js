#!/usr/bin/env node
// Seed script — fetches 19hz, parses, enriches in batches, outputs JS for index.html fallback.
// Usage: ANTHROPIC_API_KEY=... node seed-fallback.js > /tmp/fallback-events.js

const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const { parseEvents, parsePrice, SOURCE_URL } = require('./server');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BATCH_SIZE = 50;

async function enrichBatch(rawEvents) {
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
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = response.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(text);
}

async function run() {
  console.error('Fetching 19hz...');
  const res = await fetch(SOURCE_URL);
  const html = await res.text();
  const raw = parseEvents(html);
  console.error(`Parsed ${raw.length} events`);

  // Enrich in batches
  const allEnriched = [];
  for (let i = 0; i < raw.length; i += BATCH_SIZE) {
    const batch = raw.slice(i, i + BATCH_SIZE);
    console.error(`Enriching batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} events)...`);
    const enriched = await enrichBatch(batch);
    allEnriched.push(...enriched);
  }
  console.error(`Enriched ${allEnriched.length} events total`);

  // Assemble final events
  const events = raw.map((r, i) => ({
    day: r.day,
    name: allEnriched[i]?.name || r.titlePart,
    artists: allEnriched[i]?.artists || '',
    venue: r.venue,
    area: r.area,
    startHour: r.startHour,
    timeDisplay: r.timeRaw,
    type: allEnriched[i]?.type || 'night',
    genres: r.genres,
    priceRaw: parsePrice(r.priceStr),
    priceDisplay: r.priceStr || 'TBA',
    age: r.age,
    link: r.link,
  }));

  // Output as JS
  const days = {};
  events.forEach(e => { days[e.day] = (days[e.day] || 0) + 1; });
  console.error('\nEvents by day:');
  Object.entries(days).sort().forEach(([d, n]) => console.error(`  ${d}: ${n}`));

  console.log(JSON.stringify(events, null, 2));
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
