#!/usr/bin/env node
// Test script — runs the scrape → parse → enrich pipeline and validates output.
// Usage: node test-job.js
//   ANTHROPIC_API_KEY must be set (via .env or environment)

require('dotenv').config({ silent: true });
const fetch = require('node-fetch');
const { parseEvents, parsePrice, enrichWithClaude, SOURCE_URL } = require('./server');

const VALID_TYPES = new Set(['pool', 'outdoor', 'night', 'festival', 'cruise']);

async function run() {
  // ── 1. Fetch ────────────────────────────────────────────────────────────
  console.log(`\n🔗 Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  console.log(`   ✓ Fetched ${(html.length / 1024).toFixed(0)} KB of HTML`);

  // ── 2. Parse ────────────────────────────────────────────────────────────
  console.log(`\n📋 Parsing events...`);
  const raw = parseEvents(html);
  console.log(`   ✓ Parsed ${raw.length} events`);

  if (raw.length === 0) {
    console.log('\n⚠️  No events found — check if TARGET_DATES match current 19hz listings.');
    return;
  }

  const dayCounts = {};
  raw.forEach(e => { dayCounts[e.day] = (dayCounts[e.day] || 0) + 1; });
  const dayEntries = Object.entries(dayCounts).sort(([a], [b]) => a.localeCompare(b));
  console.log(`   By day: ${dayEntries.map(([d, n]) => `${d}: ${n}`).join('  |  ')}`);

  // Spot-check parse quality
  console.log('\n   Sample parsed event:');
  const sample = raw[0];
  console.log(`   title:    "${sample.titlePart}"`);
  console.log(`   venue:    "${sample.venue}"`);
  console.log(`   area:     "${sample.area}"`);
  console.log(`   genres:   [${sample.genres.join(', ')}]`);
  console.log(`   time:     "${sample.timeRaw}"  (startHour: ${sample.startHour})`);

  // ── 3. Enrich via Claude ────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n⚠️  ANTHROPIC_API_KEY not set — skipping enrichment step.');
    console.log('   Set it in .env or export it to test the full pipeline.');
    return;
  }

  console.log(`\n🤖 Enriching ${raw.length} events via Claude...`);
  const start = Date.now();
  const enriched = await enrichWithClaude(raw);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`   ✓ Enrichment complete in ${elapsed}s`);

  // ── 4. Validate ─────────────────────────────────────────────────────────
  console.log(`\n🔍 Validating enriched output...`);
  let errors = 0;

  if (!Array.isArray(enriched)) {
    console.log('   ✗ Response is not an array!');
    return;
  }

  if (enriched.length !== raw.length) {
    console.log(`   ✗ Length mismatch: expected ${raw.length}, got ${enriched.length}`);
    errors++;
  }

  enriched.forEach((item, i) => {
    const prefix = `   [${i}]`;
    if (typeof item.name !== 'string' || !item.name) {
      console.log(`${prefix} ✗ missing or empty "name"`);
      errors++;
    }
    if (typeof item.artists !== 'string') {
      console.log(`${prefix} ✗ "artists" is not a string (got ${typeof item.artists})`);
      errors++;
    }
    if (!VALID_TYPES.has(item.type)) {
      console.log(`${prefix} ✗ invalid type "${item.type}" (expected: ${[...VALID_TYPES].join(', ')})`);
      errors++;
    }
    const extraKeys = Object.keys(item).filter(k => !['name', 'artists', 'type'].includes(k));
    if (extraKeys.length > 0) {
      console.log(`${prefix} ⚠ unexpected keys: ${extraKeys.join(', ')}`);
    }
  });

  if (errors === 0) {
    console.log(`   ✓ All ${enriched.length} items valid`);
  } else {
    console.log(`\n   ✗ ${errors} validation error(s)`);
  }

  // ── 5. Summary table ───────────────────────────────────────────────────
  console.log('\n📊 Results preview (first 5):');
  console.log('   ' + '-'.repeat(90));
  console.log(`   ${'Name'.padEnd(30)} ${'Artists'.padEnd(35)} ${'Type'.padEnd(10)}`);
  console.log('   ' + '-'.repeat(90));
  enriched.slice(0, 5).forEach(e => {
    const name = (e.name || '').slice(0, 28).padEnd(30);
    const artists = (e.artists || '').slice(0, 33).padEnd(35);
    const type = (e.type || '').padEnd(10);
    console.log(`   ${name} ${artists} ${type}`);
  });
  console.log('   ' + '-'.repeat(90));

  // Type distribution
  const typeCounts = {};
  enriched.forEach(e => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });
  console.log('\n   Type distribution:');
  Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    console.log(`     ${t.padEnd(10)} ${n}`);
  });

  console.log('\n✅ Test complete.\n');
}

run().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
