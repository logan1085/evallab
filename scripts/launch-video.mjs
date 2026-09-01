// The launch video: the real product, recorded, not mocked. Each scene is a
// browser context with video on; title cards are pages too, so the whole cut
// is one design system. Scenes are stitched with ffmpeg at the end.
//
//   node scripts/launch-video.mjs
//   JOURNEY_URL=https://evallab-eosin.vercel.app node scripts/launch-video.mjs
//   NO_WEBFONTS=1 node scripts/launch-video.mjs   (offline: paint on fallbacks)
//
// Against a server with OPENROUTER_API_KEY set, the panel and the scenarios
// are real and the seat rows carry model names; against a bare server they
// are the labeled simulation, and the video says so, because the page does.
// Requires ffmpeg (libx264) on PATH and Playwright's chromium.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.JOURNEY_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const OUT = process.env.VIDEO_OUT ?? join(process.cwd(), 'launch-video');
const SHOW_URL = process.env.SHOW_URL ?? 'evallab-eosin.vercel.app';
const W = 1920;
const H = 1080;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const clips = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- Scene plumbing ------------------------------------------------------ */

async function scene(name, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    reducedMotion: 'no-preference',
  });
  // Where fonts.googleapis.com is unreachable the stylesheet link blocks first
  // paint until the connection dies, which records as seconds of blank paper.
  // NO_WEBFONTS=1 aborts those requests so the page paints on the fallbacks.
  if (process.env.NO_WEBFONTS) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  try {
    await fn(page);
  } finally {
    const video = page.video();
    await ctx.close();
    const path = await video.path();
    clips.push({ name, path });
    console.log(`scene: ${name}`);
  }
}

/** The chrome the recording adds: no scrollbar, and a caption strip in mono. */
async function dress(page) {
  await page.addStyleTag({
    content: `
      ::-webkit-scrollbar { display: none; }
      html { scrollbar-width: none; }
      #gr-cap {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 99999;
        background: #faf8f5; border-top: 1px solid #16130e;
        font-family: 'IBM Plex Mono', ui-monospace, 'DejaVu Sans Mono', Menlo, monospace;
        font-size: 22px; line-height: 1.4; color: #16130e; text-align: center;
        padding: 18px 40px; opacity: 0; transition: opacity .35s ease;
      }
      #gr-cap[data-on] { opacity: 1; }
    `,
  });
  await page.evaluate(() => {
    if (!document.getElementById('gr-cap')) {
      const d = document.createElement('div');
      d.id = 'gr-cap';
      document.body.appendChild(d);
    }
  });
}

async function caption(page, text) {
  await page.evaluate((t) => {
    const d = document.getElementById('gr-cap');
    if (!d) return;
    d.removeAttribute('data-on');
    setTimeout(() => {
      d.textContent = t;
      if (t) d.setAttribute('data-on', '');
    }, 200);
  }, text);
  await sleep(500);
}

/** Scroll like a person: many small wheel steps, so pinned sequences play. */
async function scrollBy(page, px, ms) {
  const steps = Math.max(1, Math.round(ms / 40));
  const per = px / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, per);
    await sleep(40);
  }
}

async function scrollToSel(page, sel, ms = 900) {
  const y = await page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().top - 120);
  await scrollBy(page, y, ms);
}

/** Title cards are pages, set from HTML, in the product's own palette. */
function cardHtml({ eyebrow = '', title, sub = '', foot = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#faf8f5;color:#16130e}
    body{display:flex;align-items:center;justify-content:center;font-family:'Newsreader',Georgia,'Liberation Serif',serif}
    .c{max-width:1300px;text-align:center;padding:0 80px;animation:in .9s ease both}
    .e{font-family:'IBM Plex Mono',ui-monospace,'DejaVu Sans Mono',monospace;font-size:22px;letter-spacing:.09em;text-transform:uppercase;color:#6b655c;margin-bottom:34px}
    h1{font-size:104px;font-weight:500;line-height:1.02;letter-spacing:-.015em;margin:0;text-wrap:balance}
    .s{font-family:'Inter',system-ui,'DejaVu Sans',sans-serif;font-size:30px;line-height:1.5;color:#6b655c;margin:38px auto 0;max-width:980px}
    .f{font-family:'IBM Plex Mono',ui-monospace,'DejaVu Sans Mono',monospace;font-size:24px;color:#16130e;margin-top:64px;border-top:1px solid #16130e;display:inline-block;padding-top:22px}
    @keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  </style></head><body><div class="c">
    ${eyebrow ? `<div class="e">${eyebrow}</div>` : ''}
    <h1>${title}</h1>
    ${sub ? `<div class="s">${sub}</div>` : ''}
    ${foot ? `<div class="f">${foot}</div>` : ''}
  </div></body></html>`;
}

async function card(name, opts, ms) {
  await scene(name, async (page) => {
    await page.setContent(cardHtml(opts));
    await sleep(ms);
  });
}

/* ---- The cut ------------------------------------------------------------- */

await card('01-title', {
  eyebrow: 'The Grading Room',
  title: 'Five experts walk in.<br>One framework walks out.',
  sub: 'Simulate experts to create the perfect evaluation framework.',
}, 4500);

let projectLink = '';

await scene('02-landing', async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dress(page);
  await sleep(1800);
  await caption(page, 'A panel of simulated expert judges with conflicting stakes. They grade your AI blind.');
  await sleep(2200);
  // Into the pinned demonstration: the three votes land as you scroll.
  await scrollToSel(page, '.l-scroller', 1000);
  await sleep(600);
  await caption(page, 'One case. Three stakes. Each seat votes without seeing the others.');
  const travel = await page.locator('.l-scroller').evaluate((el) => el.getBoundingClientRect().height - window.innerHeight);
  await scrollBy(page, travel * 0.9, 7000);
  await caption(page, 'Where they split, your rubric is silent. The split writes the missing sentence.');
  await sleep(3200);
  await scrollToSel(page, '.l-artifact', 1200);
  await caption(page, 'You leave with a document. It has a name, a version, and a link.');
  await sleep(3200);
  await scrollToSel(page, '.l-steps', 1000);
  await caption(page, 'Describe your AI. Run one round. Every split becomes a sentence.');
  await sleep(3000);
  await caption(page, '');
});

await card('03-card-setup', { eyebrow: '1', title: 'Three questions.', sub: 'That is the whole setup. No account, no sign-up.' }, 3000);

await scene('04-setup', async (page) => {
  await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle' });
  await dress(page);
  await sleep(1200);
  const answers = [
    ['Meridian Outfitters', 'Your company. Just a name to put on the framework.'],
    [
      'We sell outdoor gear online. Our AI answers billing and order questions, and can refund up to $50 without approval.',
      'What your AI handles, in your own words.',
    ],
    ['Refunds over $50 need a human. Never quote a delivery date the carrier has not confirmed.', 'The hard limits. These seed the literalist.'],
  ];
  for (const [text, cap] of answers) {
    await caption(page, cap);
    await sleep(700);
    await page.locator('input:visible').first().type(text, { delay: 34 });
    await sleep(500);
    await page.locator('button:has-text("Answer")').click();
    await sleep(700);
  }
  await caption(page, 'Five judges are written for your product. The literalist sits with them.');
  // Seats fill one at a time; hold until the bench is full and the cases are written.
  await page.waitForSelector('text=/scenarios written/i', { timeout: 120000 });
  await page.waitForSelector('text=Your panel is seated.', { timeout: 30000 });
  await sleep(3800);
  await scrollToSel(page, '.link-box', 900);
  await caption(page, 'This link is the only way back. That is the entire account system.');
  await sleep(3200);
  projectLink = (await page.locator('.link-box').first().innerText()).trim();
  await caption(page, '');
  await page.locator('button:has-text("Enter the Room")').click();
  await sleep(1500);
});

await card('05-card-room', { eyebrow: '2', title: 'The Room.', sub: 'Your panel, your cases, one button.' }, 2800);

await scene('06-room', async (page) => {
  await page.goto(projectLink, { waitUntil: 'networkidle' });
  await dress(page);
  await sleep(1400);
  await caption(page, 'Every seat is editable. Every edit is a record that feeds the diff.');
  await scrollBy(page, 420, 1400);
  await sleep(2600);
  await caption(page, 'The cases: the clear ones, the boundary ones, and the ones your rules never imagined.');
  await scrollToSel(page, 'text=The cases', 1200);
  await scrollBy(page, 700, 2600);
  await sleep(1800);
  await caption(page, '');
  await scrollBy(page, -4000, 1200);
  await sleep(600);
});

await card('07-card-round', { eyebrow: '3', title: 'Run the round.', sub: 'Every seat grades every case. Blind.' }, 2800);

await scene('08-round', async (page) => {
  await page.goto(projectLink, { waitUntil: 'networkidle' });
  await dress(page);
  await sleep(900);
  await page.locator('button:has-text("Run the round")').click();
  await caption(page, 'Verdicts land one seat at a time. No seat sees another seat.');
  await page.waitForSelector('text=/split|agreed on everything/i', { timeout: 180000 });
  await sleep(1800);
  await caption(page, 'Where the panel splits, the rubric was silent.');
  await sleep(2800);
  await scrollToSel(page, '.panel.is-split', 1200).catch(() => scrollBy(page, 900, 1200));
  await sleep(1200);
  await scrollBy(page, 700, 3200);
  await sleep(1200);
  await scrollToSel(page, '#diff', 1000);
  await caption(page, 'Every split drafts the sentence your rubric was missing. Ungrounded proposals are dropped.');
  await page.locator('button:has-text("Propose the missing sentences")').click();
  await page.waitForSelector('button:has-text("Add to my standards"), .empty', { timeout: 60000 });
  await sleep(3400);
  const accept = page.locator('button:has-text("Add to my standards")').first();
  if (await accept.count()) {
    await accept.click();
    await sleep(1600);
  }
  await caption(page, '');
  await scrollBy(page, -6000, 1000);
  await sleep(500);
});

await card('09-card-standards', { eyebrow: '4', title: 'Standards v2.', sub: 'Named. Versioned. Yours.' }, 2800);

await scene('10-standards', async (page) => {
  await page.goto(projectLink, { waitUntil: 'networkidle' });
  // Back to the round just run, then the handoff.
  const slug = new URL(projectLink).pathname.split('/')[2];
  const token = new URL(projectLink).searchParams.get('k') ?? '';
  const res = await page.evaluate(
    async ([s, t]) => (await (await fetch(`/api/v1/projects/${s}`, { headers: { 'x-gr-token': t } })).json()).rounds,
    [slug, token],
  );
  const roundId = res.at(-1).id;
  await page.goto(`${BASE}/p/${slug}/round/${roundId}`, { waitUntil: 'networkidle' });
  await dress(page);
  await sleep(1200);
  await caption(page, 'One button. The framework page writes itself from the splits.');
  await sleep(1400);
  await page.locator('button:has-text("Write the next Standards")').click();
  await page.waitForURL(/\/s\//, { timeout: 60000 });
  await page.waitForLoadState('networkidle');
  await dress(page);
  await sleep(1600);
  await caption(page, 'The framework, then the evidence for it, then the panel, so a reader can judge the judges.');
  await scrollBy(page, 700, 3600);
  await sleep(1000);
  await scrollBy(page, 900, 3600);
  await sleep(1200);
  await scrollBy(page, -6000, 1000);
  await sleep(600);
  await caption(page, 'Publish it, and the link is the artifact.');
  await page.locator('button:has-text("Publish it")').click();
  await page.waitForLoadState('networkidle');
  await dress(page);
  await caption(page, 'Publish it, and the link is the artifact.');
  await sleep(1600);
  await page.locator('button.copy').click();
  await sleep(2600);
  await caption(page, '');
});

await card('11-close', {
  title: 'The rubric diff is the product.<br>The score is the by-product.',
  foot: `${SHOW_URL} &nbsp;·&nbsp; Seat your panel`,
}, 5000);

await browser.close();

/* ---- The stitch ---------------------------------------------------------- */

const list = join(OUT, 'clips.txt');
writeFileSync(list, clips.map((c) => `file '${c.path}'`).join('\n'));
const out = join(OUT, 'the-grading-room-launch.mp4');
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', list,
  '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
  '-r', '30',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-movflags', '+faststart',
  out,
]);
console.log(`video: ${out}`);
