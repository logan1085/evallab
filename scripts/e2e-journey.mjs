// The whole product, walked as a customer: landing form -> scenarios written ->
// answer three of them -> download the .jsonl. Run against a dev server:
//   PORT=4188 npx tsx server/index.ts &   then   node scripts/e2e-journey.mjs
// Requires the web bundle to be built (npm run build:web) and Playwright's chromium.
import { chromium } from 'playwright';

const out = '/tmp/claude-0/-home-user-evallab/48b8d494-ded1-5d3d-a2a8-53ab11f0b919/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails.push(name); };

// 1. A company arrives and explains itself.
await page.goto('http://localhost:4188/', { waitUntil: 'networkidle' });
await page.fill('input[aria-label="Company or team name"]', 'Acme Outdoor');
await page.fill(
  'textarea[aria-label="What your company does and what your AI handles"]',
  'We sell outdoor gear online; our AI answers billing questions and can refund up to $50 without approval.',
);
await page.click('form.l-start button[type=submit]');
await page.waitForURL('**/p/**', { timeout: 30000 });
await page.waitForTimeout(800);
ok('project created from landing form', page.url().includes('/p/'));

// 2. Scenarios were written; the placeholder note shows when there is no key.
const body0 = await page.textContent('body');
ok('six scenarios in standfirst', body0.includes('6 scenarios'));
ok('placeholder notice visible without a key', body0.includes('Placeholder scenarios'));
ok('download starts disabled', await page.locator('button[disabled]', { hasText: 'Download' }).count() > 0);

// 3. Answer the first three scenarios: verdict click plus a written reason.
const cards = page.locator('.panel:has(.verdict-picker)');
ok('scenario cards rendered', (await cards.count()) === 6);
for (let i = 0; i < 3; i++) {
  const card = cards.nth(i);
  await card.locator('.verdict-picker button').first().click();
  await page.waitForTimeout(350);
  await card.locator('textarea').fill(`Because this is the behaviour we want, case ${i + 1}.`);
  await card.locator('textarea').blur();
  await page.waitForTimeout(350);
}
await page.waitForTimeout(500);
const body1 = await page.textContent('body');
ok('standfirst counts three answered', body1.includes('3 answered'));
ok('eval set panel counts three test cases', body1.includes('3 test cases ready'));
await page.screenshot({ path: `${out}/journey-answered.png`, fullPage: true });

// 4. The deliverable downloads and parses.
const href = await page.locator('a', { hasText: 'Download' }).first().getAttribute('href');
const res = await page.request.get(href.startsWith('http') ? href : `http://localhost:4188${href}`);
const text = await res.text();
const lines = text.trim().split('\n').filter(Boolean);
let parsed = 0;
for (const line of lines) { try { const o = JSON.parse(line); if (o.input && o.expected && 'why' in o) parsed++; } catch { /* not jsonl */ } }
ok('eval set downloads', res.ok());
ok(`eval set is valid jsonl with reasons (${parsed} cases)`, parsed === 3 && lines.length === 3);
console.log('CASES', lines.length, lines[0]?.slice(0, 140));

// 5. Withdrawing a call shrinks the set.
await cards.nth(0).locator('.verdict-picker button.selected').click();
await page.waitForTimeout(500);
ok('withdrawing a call updates the count', (await page.textContent('body')).includes('2 test cases ready'));

await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PASS');
