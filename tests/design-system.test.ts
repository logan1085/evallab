/**
 * One design system, checked rather than eyeballed.
 *
 * Two files define the product's look and neither can import the other: the
 * app's stylesheet, and the Standards page, which is server-rendered as a
 * standalone HTML document with its CSS inlined so a shared link is one fast
 * crawlable file. Copies drift, and "the Standards page matches the app" is
 * exactly the kind of claim that quietly stops being true.
 *
 * The scroll-pin guards below outlived the prototype they were written for:
 * the landing carries the same technique, so it inherits the same traps.
 *
 * (The retired direction-two prototype at web/public/agent.html is a dark
 * design the launch spec replaced; it is no longer held to this palette.)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderStandardsPage, type StandardsView } from '../server/standards.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const landing = readFileSync(`${root}web/src/landing.css`, 'utf8');
const appStyles = readFileSync(`${root}web/src/styles.css`, 'utf8');

/** CSS comments explain the rules they forbid, so they must not be searched. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Pull `--name: value` pairs out of a stylesheet. A declaration may end at a
 * semicolon or at the closing brace, and hex is case-insensitive, so both are
 * normalised: this compares colours, not typing.
 */
function tokens(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    const name = match[1]!.toLowerCase();
    const value = match[2]!;
    if (!(name in found)) found[name] = value.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  return found;
}

const view: StandardsView = {
  project: { name: 'Meridian Outfitters', slug: 'meridian', isPublic: true },
  version: { version: 2, preamble: 'A support agent.', criteria: [{ id: 'c1', title: 'x', body: 'A clause.' }], changelog: '', createdAt: '2026-08-26T00:00:00.000Z' },
  addedIds: new Set(['c1']),
  patches: [{ text: 'The added sentence.', evidence: [{ seat: 'The literalist', quote: 'nothing settles it' }], seatsSided: [] }],
  seats: [{ name: 'The literalist', objective: 'Grades what is written.', failsFor: 'Fails gap-filling.', model: 'simulated' }],
  stats: { cases: 12, splits: 14, sentences: 1, simulated: true },
  owner: false,
  k: null,
};

describe('the Standards page and the app are one design system', () => {
  const app = tokens(appStyles);
  const page = tokens(renderStandardsPage(view, 'https://example.test'));

  it('copies the palette exactly, token for token', () => {
    // Named rather than counted, so dropping one from the page fails here
    // instead of quietly shrinking the set the test checks.
    const expected = ['--paper', '--ink', '--muted', '--hairline', '--amber', '--signal'];
    expect(Object.keys(page).filter((k) => expected.includes(k)).sort()).toEqual([...expected].sort());

    const mismatched = expected.filter((k) => app[k] !== page[k]).map((k) => `${k}: ${app[k]} vs ${page[k]}`);
    expect(mismatched).toEqual([]);
  });

  it('uses the same three families, each for its one job', () => {
    const html = renderStandardsPage(view, 'https://example.test');
    expect(html).toContain('Newsreader');
    expect(html).toContain('Inter');
    expect(html).toContain('IBM Plex Mono');
    // Evidence is always mono: the clause bodies and the quoted reasons.
    expect(html).toMatch(/\.clause \.body\{[^}]*IBM Plex Mono/);
    expect(html).toMatch(/\.quote\{[^}]*IBM Plex Mono/);
  });

  it('spends the signal red only on splits', () => {
    const html = withoutComments(renderStandardsPage(view, 'https://example.test'));
    // Every rule that paints the signal colour must belong to a split state:
    // an added clause, its tag, or the added line in the evidence diff.
    const rules = [...html.matchAll(/([^{}]+)\{[^}]*var\(--signal\)[^}]*\}/g)].map((m) => m[1]!.trim());
    const allowed = /(added|\.tag|\.add)/;
    expect(rules.filter((r) => !allowed.test(r))).toEqual([]);
  });

  it('paints its own ground, so it never borrows the host theme', () => {
    expect(renderStandardsPage(view, 'https://example.test')).toMatch(/body\{[^}]*background:\s*var\(--paper\)/);
  });
});

describe('the landing page pinned poll can actually pin', () => {
  it('never hides overflow on the landing root', () => {
    // `overflow-x: hidden` on an ancestor makes it a scroll container, which
    // silently breaks `position: sticky` for every descendant. The stage stops
    // pinning and the sequence plays to an empty viewport while the DOM
    // updates correctly behind it: no error, just a blank screen.
    const rootBlock = withoutComments(landing.slice(landing.indexOf('.landing {'), landing.indexOf('.l-wrap {')));
    expect(rootBlock).not.toMatch(/overflow(-x)?\s*:\s*hidden/);
  });

  it('keeps the stage sticky and the scroller tall enough to travel through', () => {
    const css = withoutComments(landing);
    expect(css).toMatch(/\.l-scroller\s*\{[^}]*height:\s*\d+vh/);
    expect(css).toMatch(/\.l-stage\s*\{[^}]*position:\s*sticky/);
  });

  it('unpins under reduced motion and dims votes only when motion is welcome', () => {
    const reduce = landing.slice(landing.indexOf('prefers-reduced-motion: reduce'));
    expect(reduce).toMatch(/\.l-scroller\s*\{\s*height:\s*auto/);
    expect(reduce).toMatch(/\.l-stage\s*\{\s*position:\s*static/);
    // The dimmed not-yet-voted state must live inside the no-preference guard,
    // so a reader with motion reduced, or with the script dead, sees the
    // finished poll from CSS alone.
    const noPref = landing.indexOf('prefers-reduced-motion: no-preference');
    const dimmed = landing.indexOf('.l-demo--stage .l-verdict {');
    expect(noPref).toBeGreaterThan(-1);
    expect(dimmed).toBeGreaterThan(noPref);
  });
});

describe('the app stylesheet keeps the signal reserved', () => {
  it('never spends the signal colour on chrome', () => {
    const css = withoutComments(appStyles);
    const rules = [...css.matchAll(/([^{}]+)\{[^}]*var\(--signal\)[^}]*\}/g)]
      .map((m) => m[1]!.trim())
      // :root is where the tokens themselves are declared, aliases included.
      .filter((selector) => selector !== ':root');
    // Only split states may spend it. Buttons, links and logos must not appear
    // here: red means the judges are fighting, and nothing else.
    expect(rules.filter((selector) => !/split/.test(selector))).toEqual([]);
  });
});
