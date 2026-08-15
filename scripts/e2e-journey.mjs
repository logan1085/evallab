// The whole product, walked as a customer: landing form -> scenarios -> two blind
// voters -> close -> settle a split -> download the .jsonl. Run against a dev
// server: PORT=4188 npx tsx server/index.ts &  then  node scripts/e2e-journey.mjs
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
await page.waitForTimeout(600);
ok('project created from landing form', page.url().includes('/p/'));
const slug = page.url().split('/p/')[1].split('?')[0];

// 2. Scenarios were written, and the placeholder honesty note shows (no key here).
ok('six scenarios in standfirst', (await page.textContent('body')).includes('6 scenarios'));
await page.getByRole('button', { name: 'Scenarios', exact: true }).click();
await page.waitForTimeout(500);
ok('placeholder notice visible without a key', (await page.textContent('body')).includes('Placeholder scenarios'));
await page.getByRole('button', { name: 'Polls', exact: true }).click();
await page.waitForTimeout(400);

// 3. Ana joins and starts the poll.
await page.fill('input[aria-label="Your name"]', 'Ana');
await page.getByRole('button', { name: 'Join', exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Start poll' }).click();
await page.waitForTimeout(800);
const voteLink = page.locator('a[href*="/grade/"]').first();
ok('open poll row with a vote link', (await voteLink.count()) > 0);
await page.screenshot({ path: `${out}/journey-project.png` });

// 4. Ana votes on everything.
async function voteAll(pattern) {
  await page.waitForSelector('.verdict-picker');
  const total = await page.locator('.pill-row .pill').count() - 2; // minus prev/next
  for (let i = 0; i < total; i++) {
    const buttons = page.locator('.verdict-picker button');
    await buttons.nth(pattern[i % pattern.length]).click();
    await page.waitForTimeout(350);
  }
  return total;
}
await voteLink.click();
const n = await voteAll([0, 0, 2, 1, 0, 2]); // Ana: mostly generous
ok('Ana graded all scenarios', (await page.textContent('body')).includes('Your votes are in'));
await page.screenshot({ path: `${out}/journey-grade.png` });

// 5. Ben joins from the same link and disagrees in places.
await page.goto(`http://localhost:4188/p/${slug}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'change' }).click();
await page.fill('input[aria-label="Your name"]', 'Ben');
await page.getByRole('button', { name: 'Join', exact: true }).click();
await page.waitForTimeout(400);
await page.locator('a[href*="/grade/"]').first().click();
await voteAll([0, 2, 2, 0, 0, 2]); // Ben: harsher, splits with Ana on 2 and 4
ok('Ben graded all scenarios', (await page.textContent('body')).includes('Your votes are in'));

// 6. Close the poll from the done panel.
await page.getByRole('button', { name: 'Close the poll and see where you agree' }).click();
await page.waitForURL('**/round/**', { timeout: 15000 });
await page.waitForTimeout(800);
const reportText = await page.textContent('body');
ok('report opened', page.url().includes('/round/'));
ok('report speaks in decisions', /decision|agree/i.test(reportText));
ok('eval set section present', reportText.includes('Download eval set'));
await page.screenshot({ path: `${out}/journey-report.png`, fullPage: true });

// 7. Settle the first disagreement through the UI.
const settle = page.getByRole('button', { name: 'Settle this disagreement' }).first();
if ((await settle.count()) > 0) {
  await settle.click();
  await page.waitForTimeout(300);
  const pick = page.locator('form .pill-row .pill, form button[type=button]').first();
  await pick.click();
  await page.locator('textarea[id^="clause-"]').fill('Partial credit only when the gap is named explicitly.');
  await page.locator('button[type=submit]:not([disabled])').first().click();
  await page.waitForTimeout(700);
  ok('split resolved via UI', (await page.textContent('body')).includes('resolved'));
} else {
  ok('split available to settle (none found!)', false);
}

// 8. The deliverable: download the eval set.
const href = await page.locator('a', { hasText: 'Download eval set' }).first().getAttribute('href');
const res = await page.request.get(href.startsWith('http') ? href : `http://localhost:4188${href}`);
const bodyText = await res.text();
const lines = bodyText.trim().split('\n').filter(Boolean);
let parsed = 0;
for (const line of lines) { try { JSON.parse(line); parsed++; } catch { /* not jsonl */ } }
ok('eval set downloads', res.ok());
ok(`eval set is valid jsonl (${parsed} cases)`, parsed > 0 && parsed === lines.length);
console.log('CASES', lines.length, lines[0]?.slice(0, 140));

await page.screenshot({ path: `${out}/journey-settled.png`, fullPage: true });
await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PASS');
