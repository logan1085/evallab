/**
 * Creates the demo project and prints the shared link.
 * `npm run seed`
 */
import { openDb } from '../db.js';
import { seedDemoProject } from '../seed.js';

const db = await openDb();
const seeded = await seedDemoProject(db);
const base = process.env.GR_BASE_URL ?? 'http://localhost:8787';

console.log('Demo project created.');
console.log(`  slug   ${seeded.slug}`);
console.log(`  link   ${base}/p/${seeded.slug}?k=${seeded.token}`);
console.log('');
console.log('Round 1 is already graded and closed, so the split report has something in it.');
console.log('The twelve transcripts are authored, not captured from production runs.');

await db.close();
