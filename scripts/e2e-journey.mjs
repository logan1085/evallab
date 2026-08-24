// The whole product, walked as a customer: the arrival conversation, the panel
// seated, the blind round run, the map read, the diff mined, the ten graded,
// the bundle offered. Run against a dev server:
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

// 1. Arrive, in conversation.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const chat = page.locator('.l-chat input');
async function answer(text) {
  await chat.fill(text);
  await chat.press('Enter');
  await page.waitForTimeout(600);
}
await page.locator('.l-chat').scrollIntoViewIfNeeded();
await answer('Acme Outdoor');
await answer('We sell outdoor gear online; our AI answers billing questions and can refund up to $50 without approval.');
ok('interview asks about limits', (await page.textContent('.l-msgs')).includes('never do'));
await answer('Never refund over $50 without human approval.');
await page.waitForURL('**/p/**', { timeout: 30000 });
await page.waitForTimeout(800);
ok('project created from the conversation', page.url().includes('/p/'));

// 2. Cases written; the panel offered. Real mode is detected, not assumed:
// with keys there is no placeholder notice and the cases are bespoke.
const body0 = await page.textContent('body');
const simulated = body0.includes('Placeholder scenarios');
console.log(simulated ? 'MODE simulated (no keys)' : 'MODE real (keys present)');
ok('cases written', /\d+ cases/.test(body0));
if (simulated) ok('placeholder notice without a key', body0.includes('Placeholder scenarios'));
else ok('no placeholder notice with keys', !body0.includes('Placeholder scenarios'));
ok('panel offered before anything runs', body0.includes('Seat the panel'));

// 3. Seat the panel; the seats are readable and labeled simulated.
await page.getByRole('button', { name: 'Seat the panel' }).click();
await page.waitForTimeout(1200);
const body1 = await page.textContent('body');
ok('literalist seated', body1.includes('The literalist'));
if (simulated) ok('seats labeled simulated without keys', body1.includes('simulated'));
else ok('seats carry real families with keys', /anthropic|openai|google/.test(body1));
ok('panel of six in standfirst', body1.includes('panel of 6'));
await page.screenshot({ path: `${out}/journey-panel.png`, fullPage: true });

// 4. Run the round; per-seat progress, then the map.
await page.getByRole('button', { name: 'Run the panel' }).click();
await page.waitForURL('**/round/**', { timeout: 30000 });
// A real 6-seat round is ~36 model calls; give it room.
await page.waitForSelector('text=/split on \\d+ of|agreed on everything/', { timeout: 240000 });
await page.waitForTimeout(600);
const mapText = await page.textContent('body');
ok('map arrived after the run', /split on \d+ of \d+ cases|agreed on everything/.test(mapText));
if (simulated) ok('simulated verdicts say so', mapText.includes('Simulated panel'));
else ok('no simulated warning with keys', !mapText.includes('Simulated panel'));
ok('agreement reported with AC1 beside alpha', mapText.includes('AC1'));

// 5. Mine the rubric diff.
await page.getByRole('button', { name: 'Propose the missing sentences' }).click();
await page.waitForTimeout(900);
const diffText = await page.textContent('body');
const hasPatches = (await page.locator('#diff .panel').count()) > 0;
ok('diff mined: patches or an honest nothing', hasPatches || diffText.includes('Nothing to propose'));
if (hasPatches) {
  ok('patches quote the room', (await page.locator('#diff .panel').first().textContent()).includes('“'));
  await page.locator('#diff .panel').first().getByRole('button', { name: 'Add to my standards' }).click();
  await page.waitForTimeout(700);
  ok('accepting writes standards v2', (await page.textContent('#diff')).includes('v2'));
}
await page.screenshot({ path: `${out}/journey-map.png`, fullPage: true });

// 6. The ten: grade everything offered, watch alignment appear.
const tenCards = page.locator('#ten .panel');
const tenCount = await tenCards.count();
ok('the ten offered (sampled across patterns)', tenCount >= 4);
for (let i = 0; i < tenCount; i++) {
  await tenCards.nth(i).locator('.verdict-picker button', { hasText: 'pass' }).click();
  await page.waitForTimeout(250);
}
await page.waitForSelector('text=Who speaks for you', { timeout: 15000 });
const tenText = await page.textContent('#ten');
ok('who-speaks-for-you table appears', tenText.includes('Who speaks for you'));
ok('false settles reported honestly', tenText.includes('confidently wrong'));
await page.screenshot({ path: `${out}/journey-ten.png`, fullPage: true });

// 7. The bundle is offered.
ok('export section present', (await page.textContent('body')).includes('Leave with files'));

await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PASS');
