/**
 * The panel layer's pure rules: how a case reads, and the grounding gate that
 * keeps proposed rubric language attached to what the seats actually said.
 */
import { describe, expect, it } from 'vitest';
import { readCase, reasonsCompatible, groundEvidence, patchIsGrounded, type SeatVote } from '../shared/panelmap.js';
import { ARCHETYPES, REQUIRED_SEAT, archetype } from '../shared/panel.js';

const vote = (seatName: string, verdict: string, reason: string): SeatVote => ({
  seatId: seatName, seatName, verdict, reason,
});

describe('how a case reads', () => {
  it('settled: same verdict, compatible reasons, and provisional by default', () => {
    const r = readCase('i1', [
      vote('A', 'pass', 'Complete answer, clearly stated and resolved.'),
      vote('B', 'pass', 'The answer is complete and clearly resolved.'),
      vote('C', 'pass', 'Resolved cleanly with a complete answer.'),
    ]);
    expect(r.pattern).toBe('settled');
    expect(r.provisional).toBe(true);
  });

  it('persona-driven: exactly one seat stands apart from an agreeing rest', () => {
    const r = readCase('i2', [
      vote('The impatient user', 'pass', 'Fast and direct.'),
      vote('The support lead', 'pass', 'Nothing left open.'),
      vote('The safety reviewer', 'fail', 'It answered what it should have declined.'),
    ]);
    expect(r.pattern).toBe('persona-driven');
    expect(r.dissenter).toBe('The safety reviewer');
  });

  it('contested: a split with no clean perspective line', () => {
    const r = readCase('i3', [
      vote('A', 'pass', 'Good.'),
      vote('B', 'fail', 'Bad.'),
      vote('C', 'fail', 'Bad.'),
      vote('D', 'recoverable', 'Fixable.'),
    ]);
    expect(r.pattern).toBe('contested');
  });

  it('blind spot: unanimous verdict, reasons that talk past each other', () => {
    const r = readCase('i4', [
      vote('A', 'pass', 'Excellent brevity throughout, admirably concise writing.'),
      vote('B', 'pass', 'Refund policy correctly applied under threshold.'),
      vote('C', 'pass', 'Declined the risky portion appropriately, hedged well.'),
    ]);
    expect(r.pattern).toBe('blind-spot');
    // A blind spot is not a regression case; it must not read as settled.
    expect(r.provisional).toBe(false);
  });

  it('one real vote cannot settle anything', () => {
    expect(readCase('i5', [vote('A', 'pass', 'x'), vote('B', 'abstain', '')]).pattern).toBe('contested');
  });
});

describe('reason compatibility', () => {
  it('shared stakes read as compatible; disjoint stakes do not', () => {
    expect(reasonsCompatible('The answer was complete and resolved', 'Complete answer, fully resolved')).toBe(true);
    expect(reasonsCompatible('Excellent brevity, concise', 'Refund threshold applied correctly')).toBe(false);
  });
});

describe('the grounding gate', () => {
  const reasons = new Map([
    ['i1|The safety reviewer', 'It answered a question it should have declined to answer.'],
    ['i2|The literalist', 'The rubric does not decide this case; nothing written settles it.'],
  ]);

  it('keeps only quotes that appear verbatim in a real reason', () => {
    const kept = groundEvidence(
      [
        { itemId: 'i1', seat: 'The safety reviewer', quote: 'should have declined' },
        { itemId: 'i2', seat: 'The literalist', quote: 'nothing written settles it' },
        { itemId: 'i1', seat: 'The safety reviewer', quote: 'this quote was never said' },
        { itemId: 'i9', seat: 'Ghost seat', quote: 'should have declined' },
      ],
      reasons,
    );
    expect(kept).toHaveLength(2);
    expect(patchIsGrounded(kept)).toBe(true);
  });

  it('a patch with fewer than two surviving quotes is not grounded', () => {
    const kept = groundEvidence([{ itemId: 'i1', seat: 'The safety reviewer', quote: 'should have declined' }], reasons);
    expect(patchIsGrounded(kept)).toBe(false);
  });

  it('rejects quotes too short to mean anything', () => {
    const kept = groundEvidence([{ itemId: 'i1', seat: 'The safety reviewer', quote: 'declined' }], reasons);
    expect(kept).toHaveLength(0);
  });
});

describe('the archetype library', () => {
  it('always contains the literalist, which is the instrument', () => {
    expect(archetype(REQUIRED_SEAT)).not.toBeNull();
    expect(ARCHETYPES.some((a) => a.id === 'literalist')).toBe(true);
  });

  it('every seat has a stated objective and a failure trigger', () => {
    for (const a of ARCHETYPES) {
      expect(a.objective.length).toBeGreaterThan(10);
      expect(a.failsFor.length).toBeGreaterThan(10);
    }
  });
});
