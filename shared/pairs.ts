/**
 * Preference pairs: two answers to one prompt, and which the standard prefers.
 *
 * Post-training on preferences needs (prompt, chosen, rejected) rows, and a
 * company's own judgment is exactly what should fill them. Two sources:
 *
 * - explicit pairs the owner poses, which every seat compares in both
 *   orders, so a seat whose choice flips when A and B swap places is
 *   counted as position bias, not preference;
 * - pairs derived from graded cases that share a prompt, where the panel
 *   put one answer above the other on the standard's scale.
 *
 * The rule from the map carries over: a preference counts only when it
 * survives the swap, and the pair has no winner on fewer than two such
 * votes.
 */

export type PairChoice = 'a' | 'b' | 'tie';

export interface PairVote {
  seatId: string;
  seatName: string;
  /** The choice under the canonical order (A first). */
  choice: PairChoice;
  reason: string;
  weight: number;
  /** True when the swapped order gave the same answer; undefined when only one order was asked. */
  stable?: boolean;
}

export interface PairOutcome {
  winner: 'a' | 'b' | null;
  /** Share of counted weight behind the winner. 1 is unanimous. */
  support: number;
  counted: number;
  /** Votes set aside: ties, and votes that flipped under the swap. */
  setAside: number;
  flipped: number;
}

export function pairOutcome(votes: PairVote[]): PairOutcome {
  const flipped = votes.filter((v) => v.stable === false).length;
  const counted = votes.filter((v) => v.choice !== 'tie' && v.stable !== false && v.weight > 0);
  const setAside = votes.length - counted.length;
  if (counted.length < 2) return { winner: null, support: 0, counted: counted.length, setAside, flipped };
  let a = 0;
  let b = 0;
  for (const v of counted) {
    if (v.choice === 'a') a += v.weight;
    else b += v.weight;
  }
  if (a === b) return { winner: null, support: 0.5, counted: counted.length, setAside, flipped };
  const winner = a > b ? 'a' : 'b';
  return { winner, support: Math.max(a, b) / (a + b), counted: counted.length, setAside, flipped };
}

/** Under the swapped order, the same preference reads as the opposite letter. */
export const swapChoice = (c: PairChoice): PairChoice => (c === 'a' ? 'b' : c === 'b' ? 'a' : 'tie');

/**
 * The prompt shared by a transcript: everything before its first assistant
 * turn, so that two transcripts with the same user turn and different
 * answers can be paired. Null when the transcript has no assistant turn.
 */
export function promptOf(content: string): { prompt: string; answer: string } | null {
  const m = /^([\s\S]*?)(^|\n)\s*(?:ASSISTANT|Assistant|AI|A|MODEL|Model|BOT|Bot)\s*:\s*/m.exec(content);
  if (!m || m.index === undefined) return null;
  const cut = m.index + m[0].length;
  const prompt = content.slice(0, m.index + (m[1]?.length ?? 0)).trim();
  const answer = content.slice(cut).trim();
  if (!prompt || !answer) return null;
  return { prompt, answer };
}

export interface GradedCase {
  id: string;
  title: string;
  content: string;
  /** The standard's rank for the ensemble verdict; higher is better. Null when undecided. */
  rank: number | null;
  verdict: string | null;
}

export interface DerivedPair {
  prompt: string;
  chosen: GradedCase;
  rejected: GradedCase;
}

/**
 * Pairs the graded cases that share a prompt and landed on different
 * levels of the scale. Same prompt means the same text before the first
 * assistant turn, whitespace aside. At most `cap` pairs, best-separated
 * first, so a large set does not become a quadratic export.
 */
export function derivePairs(cases: GradedCase[], cap = 500): DerivedPair[] {
  const groups = new Map<string, { prompt: string; items: GradedCase[] }>();
  for (const c of cases) {
    if (c.rank === null) continue;
    const split = promptOf(c.content);
    if (!split) continue;
    const key = split.prompt.replace(/\s+/g, ' ').toLowerCase();
    const g = groups.get(key) ?? { prompt: split.prompt, items: [] };
    g.items.push(c);
    groups.set(key, g);
  }
  const out: (DerivedPair & { gap: number })[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.items.length; i++) {
      for (let j = i + 1; j < g.items.length; j++) {
        const x = g.items[i]!;
        const y = g.items[j]!;
        if (x.rank === y.rank) continue;
        const [chosen, rejected] = x.rank! > y.rank! ? [x, y] : [y, x];
        out.push({ prompt: g.prompt, chosen, rejected, gap: Math.abs(x.rank! - y.rank!) });
      }
    }
  }
  return out
    .sort((p, q) => q.gap - p.gap || p.chosen.title.localeCompare(q.chosen.title))
    .slice(0, cap)
    .map(({ gap: _gap, ...p }) => p);
}
