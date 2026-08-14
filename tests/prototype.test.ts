/**
 * The direction-two prototype is a standalone HTML file, so it cannot import
 * the landing page's stylesheet — the tokens are copied. Copies drift, and
 * "it matches the landing page" is exactly the kind of claim that quietly stops
 * being true. So it gets checked here rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const landing = readFileSync(`${root}web/src/landing.css`, 'utf8');
const appStyles = readFileSync(`${root}web/src/styles.css`, 'utf8');
const prototype = readFileSync(`${root}web/public/agent.html`, 'utf8');

/** CSS comments explain the rules they forbid, so they must not be searched. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Pull `--name: value;` pairs out of a stylesheet. */
function tokens(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = match[1]!;
    const value = match[2]!;
    // Only the first definition — the dark-mode overrides further down the
    // landing sheet redefine app tokens, not these.
    if (!(name in found)) found[name] = value.trim().replace(/\s+/g, ' ');
  }
  return found;
}

describe('the prototype and the landing page are one design system', () => {
  const a = tokens(landing);
  const b = tokens(prototype);

  it('copies the landing palette exactly, token for token', () => {
    // Named rather than counted, so removing one from the prototype fails here
    // instead of quietly shrinking the set the test checks.
    const expected = [
      '--l-ground', '--l-raised', '--l-raised-2',
      '--l-text', '--l-text-2', '--l-text-3', '--l-line',
      '--l-fail', '--l-partial', '--l-pass', '--l-spectrum',
    ];
    expect(Object.keys(b).filter((k) => expected.includes(k)).sort()).toEqual([...expected].sort());

    const mismatched = expected.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`);
    expect(mismatched).toEqual([]);
  });

  it('uses the same type stacks as the app, which is where they are defined', () => {
    const app = tokens(appStyles);
    for (const face of ['--ui', '--display', '--data']) {
      expect(b[face], face).toBe(app[face]);
    }
  });

  it('carries the verdict-scale gradient, which is the one vibrant thing on either page', () => {
    expect(b['--l-spectrum']).toBe(a['--l-spectrum']);
    // fail → partial → pass, in that order. If the stops ever get reordered the
    // gradient stops meaning anything and becomes decoration.
    expect(b['--l-spectrum']).toMatch(/--l-fail\).*--l-partial\).*--l-pass\)/);
  });

  it('commits to dark and never reads the viewer theme', () => {
    // A single-theme page is a legitimate choice, but it has to paint its own
    // ground or it borrows the host's and becomes unreadable in light mode.
    expect(prototype).toMatch(/background:\s*var\(--l-ground\)/);
    expect(prototype).not.toContain('prefers-color-scheme');
  });
});

describe('the prototype degrades without motion', () => {
  it('hides nothing unless motion is welcome', () => {
    // The hidden state lives inside the no-preference query, so a reader with
    // motion reduced never depends on an observer firing to see the page.
    const hidden = prototype.indexOf('[data-reveal] {');
    const guard = prototype.lastIndexOf('prefers-reduced-motion: no-preference', hidden);
    expect(guard).toBeGreaterThan(-1);
    expect(hidden - guard).toBeLessThan(200);
  });

  it('unpins the scroll sequence and classifies everything up front', () => {
    const reduce = prototype.slice(prototype.indexOf('prefers-reduced-motion: reduce'));
    expect(reduce).toMatch(/\.scroller\s*\{\s*height:\s*auto/);
    expect(reduce).toMatch(/\.stage\s*\{\s*position:\s*static/);
    // And the script takes the same branch rather than leaving a dead stage.
    expect(prototype).toMatch(/if \(reduced\) \{\s*classify\(byOrder\.length\);/);
  });
});

describe('the prototype says what it is', () => {
  it('is labelled unbuilt, in the page and not only in the commit message', () => {
    expect(prototype).toMatch(/Prototype · not built/);
    expect(prototype).toMatch(/prototype, not built/i);
  });

  it('does not claim the MCP server is unbuilt, because that part is real', () => {
    expect(prototype).toMatch(/MCP server is built and working today/);
  });
});

describe('the landing page pinned poll can actually pin', () => {
  // The landing page now carries the same scroll-pinned technique as the
  // prototype, so it inherits the same trap — and the same guards.
  it('never hides overflow on the landing root', () => {
    const rootBlock = withoutComments(
      landing.slice(landing.indexOf('.landing {'), landing.indexOf('.landing ::selection')),
    );
    expect(rootBlock).not.toMatch(/overflow(-x)?\s*:\s*hidden/);
  });

  it('clips the hero bloom at the hero instead', () => {
    const hero = withoutComments(landing.slice(landing.indexOf('.l-hero {'), landing.indexOf('.l-hero::before')));
    expect(hero).toMatch(/overflow:\s*hidden/);
  });

  it('keeps the stage sticky and the scroller tall enough to travel through', () => {
    const css = withoutComments(landing);
    expect(css).toMatch(/\.l-scroller\s*\{[^}]*height:\s*\d+vh/);
    expect(css).toMatch(/\.l-stage\s*\{[^}]*position:\s*sticky/);
  });

  it('unpins under reduced motion and hides votes only when motion is welcome', () => {
    const reduce = landing.slice(landing.indexOf('prefers-reduced-motion: reduce'));
    expect(reduce).toMatch(/\.l-scroller\s*\{\s*height:\s*auto/);
    expect(reduce).toMatch(/\.l-stage\s*\{\s*position:\s*static/);
    // The dimmed not-yet-voted state must live inside the no-preference guard,
    // so a reduced-motion reader sees the finished poll from CSS alone.
    const noPref = landing.indexOf('prefers-reduced-motion: no-preference', landing.indexOf('.l-scroller'));
    const dimmed = landing.indexOf('.l-demo--stage .l-verdict {');
    expect(noPref).toBeGreaterThan(-1);
    expect(dimmed).toBeGreaterThan(noPref);
  });
});

describe('the pinned sequence can actually pin', () => {
  it('never puts overflow-x on html or body', () => {
    // `overflow-x: hidden` on html or body makes the body a scroll container,
    // which silently breaks `position: sticky` for every descendant. The stage
    // stops pinning and the whole sequence plays to an empty viewport while the
    // DOM updates correctly behind it — it looks like a blank black screen and
    // throws no error. Cost an hour once; costs a test now.
    const rootBlock = withoutComments(
      prototype.slice(prototype.indexOf('html, body {'), prototype.indexOf('::selection')),
    );
    expect(rootBlock).not.toMatch(/overflow(-x)?\s*:\s*hidden/);
  });

  it('clips the one overflowing element at that element instead', () => {
    const hero = prototype.slice(prototype.indexOf('.hero {'), prototype.indexOf('.hero::before'));
    expect(hero).toMatch(/overflow:\s*hidden/);
  });

  it('keeps the stage sticky and the scroller tall enough to travel through', () => {
    expect(prototype).toMatch(/\.scroller\s*\{[^}]*height:\s*\d+vh/);
    expect(prototype).toMatch(/\.stage\s*\{[^}]*position:\s*sticky/);
  });
});
