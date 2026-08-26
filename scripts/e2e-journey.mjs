// The whole product, walked as a customer: the landing promise, the three
// questions, the bench seating, the Room, the round, the spread, and the
// Standards page at the end of the handoff. Run against a dev server:
//   PORT=4188 npx tsx server/index.ts &   then   node scripts/e2e-journey.mjs
// Requires the web bundle built (npm run build:web) and Playwright's chromium.
import { chromium } from 'playwright';

// Point JOURNEY_URL at a deployment to smoke-test production:
//   JOURNEY_URL=https://your-app.vercel.app node scripts/e2e-journey.mjs
// With real keys set the script expects real scenarios and a real panel; with
// none it expects the labeled simulation. Both are verified, not assumed.
const BASE = (process.env.JOURNEY_URL ?? 'http://localhost:4188').replace(/\/+$/, '');
const out = process.env.JOURNEY_OUT ?? '/tmp/claude-0/-home-user-evallab/48b8d494-ded1-5d3d-a2a8-53ab11f0b919/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails.push(name); };

// 1. The landing: one promise, the demo, the artifact, the setup handoff.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const landing = await page.textContent('body');
ok('the promise is the headline', landing.includes('Five experts walk in.'));
ok('the artifact is on the landing', landing.includes('Standards v2') && landing.includes('added after a split'));
ok('the closer is full size, not a footer credit', landing.includes('The rubric diff is the product.'));
ok('a real framework is one click away', (await page.locator('a[href="/s/example"]').count()) > 0);
await page.screenshot({ path: `${out}/journey-1-landing.png`, fullPage: true });

// 2. Setup: three questions to a seated panel.
await page.getByRole('link', { name: 'Seat your panel' }).first().click();
await page.waitForURL('**/setup');
async function answer(text) {
  await page.getByLabel('Your answer').fill(text);
  await page.getByRole('button', { name: 'Answer' }).click();
  await page.waitForTimeout(300);
}
await answer('Acme Outdoor');
await answer('We sell outdoor gear online; our AI answers billing questions and can refund up to $50 without approval.');
await answer('Never refund over $50 without human approval.');
await page.waitForSelector('text=Your panel is seated.', { timeout: 60000 });
await page.waitForTimeout(3500); // the bench fills one seat at a time
const setupBody = await page.textContent('body');
ok('the literalist is on the bench', setupBody.includes('The literalist'));
ok('the link card says what it is', setupBody.includes('This link is the only way back to your project.'));
await page.screenshot({ path: `${out}/journey-2-setup.png`, fullPage: true });

// 3. The Room: numbered sections, the version stamp always visible.
await page.getByRole('button', { name: 'Enter the Room' }).click();
await page.waitForURL('**/p/**', { timeout: 30000 });
await page.waitForTimeout(900);
const room = await page.textContent('body');
const simulated = room.includes('Placeholder scenarios');
console.log(simulated ? 'MODE simulated (no keys)' : 'MODE real (keys present)');
ok('version stamp in the header', room.includes('Standards v1'));
ok('numbered sections: the panel, the cases', room.includes('The panel') && room.includes('The cases'));
ok('cases written', /\d+ cases/.test(room));
ok('run has a cost and time estimate', /~\d+ min/.test(room));
await page.screenshot({ path: `${out}/journey-3-room.png`, fullPage: true });

// 4. Run the round; verdicts land per seat, then the spread.
await page.getByRole('button', { name: 'Run the round' }).click();
await page.waitForURL('**/round/**', { timeout: 30000 });
// A real 6-seat round is ~36 model calls; give it room.
await page.waitForSelector('text=/split|agreed on everything/', { timeout: 240000 });
await page.waitForTimeout(700);
const spread = await page.textContent('body');
ok('the spread headline counts the splits', /split \d+ time|agreed on everything/.test(spread));
if (simulated) ok('simulated verdicts say so', spread.includes('Simulated panel'));
ok('agreement reported with AC1 beside alpha', spread.includes('AC1'));
await page.screenshot({ path: `${out}/journey-4-spread.png`, fullPage: true });

// 5. The handoff: write the next Standards and land on the document.
const handoff = page.getByRole('button', { name: 'Write the next Standards' });
ok('the handoff is offered', (await handoff.count()) === 1);
await handoff.click();
await page.waitForURL('**/s/**', { timeout: 60000 });
await page.waitForTimeout(600);
const standards = await page.textContent('body');
ok('the Standards page is the deliverable', /Standards v\d+/.test(standards));
ok('added sentences are tagged', standards.includes('added after a split'));
ok('the evidence block quotes the room', standards.includes('Why you can trust it'));
ok('the panel is on the page', standards.includes('The literalist'));
ok('every shared framework is an ad', standards.includes('Seat your own panel'));
ok('owner controls present', standards.includes('Publish it') || standards.includes('Make it private'));
await page.screenshot({ path: `${out}/journey-5-standards.png`, fullPage: true });

await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
