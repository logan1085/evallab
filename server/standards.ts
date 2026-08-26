/**
 * The Standards page: the deliverable, rendered server-side as a real HTML
 * document. This is deliberate product shape, not a rendering shortcut. The
 * artifact people share has to be crawlable (OG tags only work server-side),
 * fast, and printable; a paper document does not need a SPA. The owner's
 * controls are plain forms on the same page, keyed by the project token.
 *
 * One rule carried over from the app: the signal red appears only where the
 * panel split, nowhere else.
 */

export interface StandardsView {
  project: { name: string; slug: string; isPublic: boolean };
  version: {
    version: number;
    preamble: string;
    criteria: { id: string; title: string; body: string }[];
    changelog: string;
    createdAt: string;
  };
  /** Criterion ids present in this version but not its parent. */
  addedIds: Set<string>;
  /** The accepted patches behind those additions, evidence and all. */
  patches: { text: string; evidence: { seat: string; quote: string }[]; seatsSided: string[] }[];
  seats: { name: string; objective: string; failsFor: string; model: string }[];
  stats: { cases: number; splits: number; sentences: number; simulated: boolean };
  /** True when the request carried the project's own key. */
  owner: boolean;
  /** Echoed into owner forms so the toggle round-trips. */
  k: string | null;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Distinct model families on the panel: the number that makes "six judges" mean something. */
export function familyCount(v: StandardsView): number {
  return new Set(v.seats.map((s) => s.model || 'unrecorded')).size;
}

/** The models themselves, named, deduped, in seat order. */
export function modelLine(v: StandardsView): string {
  const seen: string[] = [];
  for (const s of v.seats) {
    const model = s.model || 'unrecorded';
    if (!seen.includes(model)) seen.push(model);
  }
  return seen.join(' · ');
}

export function ogStatLine(v: StandardsView): string {
  const experts = v.seats.length;
  return `${experts} expert${experts === 1 ? '' : 's'}. ${v.stats.splits} disagreement${v.stats.splits === 1 ? '' : 's'}. ${v.stats.sentences} missing sentence${v.stats.sentences === 1 ? '' : 's'} found.`;
}

const CSS = `
:root{--paper:#faf8f5;--ink:#16130e;--muted:#6b655c;--hairline:#e4dfd6;--amber:#b8771a;--signal:#c22e1f;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font:17px/1.6 'Newsreader',Georgia,'Times New Roman',serif;padding:64px 24px 96px}
.doc{max-width:680px;margin:0 auto}
.mono{font-family:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;font-size:.78em;letter-spacing:0}
.ui{font-family:Inter,system-ui,sans-serif}
header.head{text-align:center;border-bottom:1px solid var(--ink);padding-bottom:28px;margin-bottom:12px}
.head h1{font-size:44px;font-weight:500;letter-spacing:-.01em}
.head .sub{font-size:24px;font-style:italic;color:var(--ink);margin-top:2px}
.head .stamp{margin-top:14px;color:var(--muted)}
section{border-top:1px solid var(--hairline);padding:36px 0}
section:first-of-type{border-top:none}
h2{font-size:15px;font-weight:600;font-family:Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:20px}
.preamble{font-size:18px;margin-bottom:20px}
.clause{padding:14px 0 14px 18px;border-left:2px solid var(--hairline);margin-bottom:14px}
.clause .body{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:14px;line-height:1.65}
.clause.added{border-left-color:var(--signal)}
.tag{display:inline-block;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:11px;color:var(--signal);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.split{margin-bottom:26px}
.split .sentence{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:14px;line-height:1.6}
.split .sentence .add{color:var(--signal)}
.quote{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);margin:8px 0 0 18px}
.quote b{color:var(--ink);font-weight:600}
.seat{padding:12px 0;border-bottom:1px solid var(--hairline)}
.seat:last-child{border-bottom:none}
.seat .name{font-size:19px}
.seat .meta{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);margin-top:2px}
.seat .model{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);margin-top:3px}
.foot{border-top:1px solid var(--ink);margin-top:24px;padding-top:24px;text-align:center;color:var(--muted)}
.btn{display:inline-block;font-family:Inter,system-ui,sans-serif;font-size:14px;font-weight:500;background:var(--ink);color:var(--paper);padding:10px 20px;border:none;border-radius:8px;text-decoration:none;cursor:pointer;margin-top:12px}
.ownerbar{font-family:Inter,system-ui,sans-serif;font-size:13px;color:var(--muted);display:flex;gap:16px;justify-content:center;align-items:center;margin:18px 0 0}
.ownerbar form{display:inline}
.ownerbar button,.ownerbar a{font:inherit;background:none;border:1px solid var(--hairline);border-radius:8px;padding:6px 12px;color:var(--ink);cursor:pointer;text-decoration:none}
.note{color:var(--muted);font-size:15px;font-style:italic}
@media print{.ownerbar,.foot .btn{display:none}}
`;

export function renderStandardsPage(v: StandardsView, baseUrl: string): string {
  const stat = ogStatLine(v);
  const title = `Standards v${v.version.version}: ${v.project.name}`;
  const date = new Date(v.version.createdAt || Date.now()).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const clauses = v.version.criteria
    .map((c) => {
      const added = v.addedIds.has(c.id);
      return `<div class="clause${added ? ' added' : ''}">
        ${added ? '<span class="tag">added after a split</span>' : ''}
        <div class="body">${esc(c.body)}</div>
      </div>`;
    })
    .join('\n');

  const evidence = v.patches
    .map(
      (p) => `<div class="split">
      <div class="sentence"><span class="add">+ ${esc(p.text)}</span></div>
      ${p.evidence
        .slice(0, 2)
        .map((e) => `<div class="quote"><b>${esc(e.seat)}:</b> “${esc(e.quote)}”</div>`)
        .join('\n')}
    </div>`,
    )
    .join('\n');

  const seats = v.seats
    .map(
      (s) => `<div class="seat">
      <div class="name">${esc(s.name)}</div>
      <div class="meta">${esc(s.objective)} · fails: ${esc(s.failsFor.replace(/^Fails /i, ''))}</div>
      <div class="model">${esc(s.model || 'unrecorded')}</div>
    </div>`,
    )
    .join('\n');

  const ownerBar = v.owner
    ? `<div class="ownerbar">
        <span>${v.project.isPublic ? 'This page is public.' : 'This page is private. Only your key opens it.'}</span>
        <form method="post" action="/s/${esc(v.project.slug)}/visibility">
          <input type="hidden" name="k" value="${esc(v.k ?? '')}" />
          <input type="hidden" name="public" value="${v.project.isPublic ? '0' : '1'}" />
          <button type="submit">${v.project.isPublic ? 'Make it private' : 'Publish it'}</button>
        </form>
        <a href="/p/${esc(v.project.slug)}?k=${encodeURIComponent(v.k ?? '')}">Run round ${'2'}</a>
      </div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(stat)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(stat)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${esc(baseUrl)}/s/${esc(v.project.slug)}" />
<meta property="og:image" content="${esc(baseUrl)}/s/${esc(v.project.slug)}/og.svg" />
<meta name="twitter:card" content="summary" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div class="doc">
  <header class="head">
    <h1>Standards v${v.version.version}</h1>
    <div class="sub">${esc(v.project.name)}</div>
    <div class="stamp mono">Graded by ${v.seats.length} ${v.stats.simulated ? 'simulated ' : ''}expert judges across ${familyCount(v)} model famil${familyCount(v) === 1 ? 'y' : 'ies'} · ${v.stats.cases} cases · ${v.stats.splits} splits · ${date}</div>
    <div class="stamp mono">${esc(modelLine(v))}</div>
    ${ownerBar}
  </header>

  <section>
    <h2>1 · The framework</h2>
    ${v.version.preamble ? `<p class="preamble">${esc(v.version.preamble)}</p>` : ''}
    ${clauses || '<p class="note">No written clauses yet. Run a round; the splits write them.</p>'}
  </section>

  <section>
    <h2>2 · Why you can trust it</h2>
    <p style="margin-bottom:18px">${v.stats.cases} cases graded blind by ${v.seats.length} judges with conflicting stakes, running on ${familyCount(v)} different model famil${familyCount(v) === 1 ? 'y' : 'ies'} so that agreement between them is not one model agreeing with itself. The panel split ${v.stats.splits} time${v.stats.splits === 1 ? '' : 's'}; ${v.stats.sentences} of those splits survived the grounding rule and became the sentences below. Every sentence quotes the room verbatim.</p>
    ${evidence || '<p class="note">Version 1 predates the first round. The evidence arrives with the first splits.</p>'}
  </section>

  <section>
    <h2>3 · The panel</h2>
    ${seats}
  </section>

  <div class="foot">
    <p>Made in The Grading Room.</p>
    <a class="btn" href="/">Seat your own panel</a>
  </div>
</div>
</body>
</html>`;
}

/** The share card. SVG keeps it dependency-free; the stat line does the work. */
export function renderOgSvg(v: StandardsView): string {
  const title = `Standards v${v.version.version}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FAF8F5"/>
  <rect x="0" y="0" width="1200" height="8" fill="#16130E"/>
  <text x="100" y="200" font-family="Georgia, 'Times New Roman', serif" font-size="88" fill="#16130E">${esc(title)}</text>
  <text x="100" y="280" font-family="Georgia, serif" font-size="44" font-style="italic" fill="#16130E">${esc(v.project.name)}</text>
  <text x="100" y="400" font-family="Menlo, monospace" font-size="34" fill="#C22E1F">${esc(ogStatLine(v))}</text>
  <text x="100" y="540" font-family="Menlo, monospace" font-size="24" fill="#6B655C">The Grading Room · the rubric diff is the product</text>
</svg>`;
}
