'use strict';
/* Refresh the OpenStreetMap facility data for Antique by hand.
   Usage:  node scripts/refresh-osm.js
   The server also does this automatically once a day. */
const osm = require('../src/osm');
const store = require('../src/store');

(async () => {
  console.log('Fetching health facilities in Antique from OpenStreetMap…');
  try {
    const data = await osm.refresh();
    console.log(`Saved ${data.facilities.length} facilities in ${data.municipalities.length} municipalities → ${store.file('osm')}`);
    console.log(`(${data.stats.elements} OSM elements, ${data.stats.unnamedSkipped} unnamed skipped, ${data.stats.duplicatesMerged} duplicates merged)`);
  } catch (err) {
    console.error('Could not refresh:', err.message);
    process.exitCode = 1;
  }
})();
