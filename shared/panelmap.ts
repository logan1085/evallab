/**
 * The disagreement map: what a finished panel round means.
 *
 * Four patterns, in order of what the user should do about them:
 *   settled          the panel agrees; provisional until the owner checks some,
 *                    because a panel can be confidently wrong together
 *   persona-driven   the split lines up with exactly one perspective; the most
 *                    actionable pattern, because it names the tradeoff the
 *                    rubric refused to make
 *   contested        the seats split with no clean perspective line
 *   blind-spot       same verdict, incompatible reasons; the rubric is being
 *                    satisfied by accident
 */

import { ABSTAIN } from './types.js';

export interface SeatVote {
  seatId: string;
  seatName: string;
  verdict: string;
  reason: string;
}

export type CasePattern = 'settled' | 'persona-driven' | 'contested' | 'blind-spot';

export interface CaseReading {
  itemId: string;
  pattern: CasePattern;
  /** For persona-driven: the seat whose stake the split lines up with. */
  dissenter: string | null;
  /** Settled cases stay provisional until the owner has graded some themself. */
  provisional: boolean;
}

/**
 * Reasons "agree" when they share enough content words. The threshold is low
 * on purpose: this flags only reasons that plainly talk past each other, not
 * every difference of phrasing. Pure and cheap so it runs on every case.
 */
export function reasonsCompatible(a: string, b: string, threshold = 0.1): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return true;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? true : shared / union >= threshold;
}

export function readCase(itemId: string, votes: SeatVote[]): CaseReading {
  const real = votes.filter((v) => v.verdict !== ABSTAIN);
  const distinct = [...new Set(real.map((v) => v.verdict))];

  if (real.length < 2) {
    return { itemId, pattern: 'contested', dissenter: null, provisional: false };
  }

  if (distinct.length === 1) {
    // Same verdict everywhere. Blind spot when the reasons pairwise disagree
    // about why: every pair incompatible means agreement by accident.
    let incompatiblePairs = 0;
    let pairs = 0;
    for (let i = 0; i < real.length; i++) {
      for (let j = i + 1; j < real.length; j++) {
        pairs++;
        if (!reasonsCompatible(real[i]!.reason, real[j]!.reason)) incompatiblePairs++;
      }
    }
    const blind = pairs > 0 && incompatiblePairs / pairs > 0.6;
    return { itemId, pattern: blind ? 'blind-spot' : 'settled', dissenter: null, provisional: !blind };
  }

  // A split. Persona-driven when exactly one seat stands apart and the rest
  // agree with each other.
  const byVerdict = new Map<string, SeatVote[]>();
  for (const v of real) {
    byVerdict.set(v.verdict, [...(byVerdict.get(v.verdict) ?? []), v]);
  }
  const groups = [...byVerdict.values()].sort((a, b) => a.length - b.length);
  if (groups.length === 2 && groups[0]!.length === 1 && groups[1]!.length >= 2) {
    return { itemId, pattern: 'persona-driven', dissenter: groups[0]![0]!.seatName, provisional: false };
  }
  return { itemId, pattern: 'contested', dissenter: null, provisional: false };
}

/* ---- Patch grounding ------------------------------------------------------ */

export interface PatchEvidence {
  itemId: string;
  seat: string;
  quote: string;
}

const MIN_QUOTE_LENGTH = 12;

/**
 * The structural rule from the spec: a proposed clause must quote at least two
 * verdict reasons verbatim or it does not get shown. This validator is the
 * gate; clause text that arrives without surviving evidence is dropped, and
 * the drop is counted, because plausible ungrounded rubric language is the
 * exact failure the product exists to prevent.
 */
export function groundEvidence(
  evidence: PatchEvidence[],
  reasonsByItemAndSeat: Map<string, string>,
): PatchEvidence[] {
  const seen = new Set<string>();
  const out: PatchEvidence[] = [];
  for (const e of evidence) {
    if (e.quote.trim().length < MIN_QUOTE_LENGTH) continue;
    const reason = reasonsByItemAndSeat.get(`${e.itemId}|${e.seat}`);
    if (!reason || !reason.includes(e.quote.trim())) continue;
    const key = `${e.itemId}|${e.seat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, quote: e.quote.trim() });
  }
  return out;
}

export function patchIsGrounded(evidence: PatchEvidence[]): boolean {
  return evidence.length >= 2 && new Set(evidence.map((e) => e.seat)).size >= 1 && new Set(evidence.map((e) => e.itemId)).size >= 1;
}
