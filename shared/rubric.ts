/**
 * Rubric rendering and export.
 *
 * A rubric leaves this product in three forms: markdown for humans, JSON for
 * machines, and a judge prompt. All three come from the same function so a
 * calibrated rubric cannot drift from the judge built out of it.
 */

import type { RubricVersion, Trace } from './types.js';

export function renderRubricMarkdown(
  rubric: RubricVersion,
  opts: { includeProvenance?: boolean; includeOpenQuestions?: boolean; includeConflicts?: boolean } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${rubric.name}`);
  lines.push('');
  lines.push(`_Version ${rubric.version}_`);
  lines.push('');
  if (rubric.preamble.trim()) {
    lines.push(rubric.preamble.trim());
    lines.push('');
  }

  lines.push('## Verdict scale');
  lines.push('');
  for (const level of [...rubric.scale].sort((a, b) => b.rank - a.rank)) {
    lines.push(`- **${level.label}**`);
  }
  lines.push('');

  if (rubric.criteria.length > 0) {
    lines.push('## Criteria');
    lines.push('');
    for (const c of rubric.criteria) {
      lines.push(`### ${c.title}`);
      lines.push('');
      lines.push(c.body.trim());
      lines.push('');
      // The citation is part of the rubric, not a footnote about it, so it goes
      // to the judge as well as to people. Splitting them would break the one
      // guarantee that makes a judge's disagreement diagnostic: that it read
      // exactly what the humans read.
      if (c.source?.quote) {
        lines.push(`> ${c.source.quote.trim()}`);
        lines.push(`> — ${c.source.document}`);
        lines.push('');
      }
    }
  }

  if (rubric.clauses.length > 0) {
    lines.push('## Clauses from resolved disagreements');
    lines.push('');
    lines.push(
      'Each sentence below exists because two graders landed in different places on a real trace and had to say what the rubric was missing.',
    );
    lines.push('');
    for (const clause of rubric.clauses) {
      const provenance =
        opts.includeProvenance && clause.originRoundId ? `  <!-- from round ${clause.originRoundId} -->` : '';
      lines.push(`- ${clause.text.trim()}${provenance}`);
    }
    lines.push('');
  }

  if (opts.includeConflicts && rubric.conflicts.length > 0) {
    lines.push('## Rules that could not become tests');
    lines.push('');
    lines.push(
      'These came out of the operating documents and are unresolved on purpose. A contradiction is for the team to settle; nothing here has been quietly reconciled.',
    );
    lines.push('');
    for (const c of rubric.conflicts) {
      const where = c.documents.length > 0 ? ` (${c.documents.join(', ')})` : '';
      lines.push(`- **${c.kind === 'contradiction' ? 'Contradiction' : 'Not checkable'}${where}:** ${c.statement.trim()}`);
      if (c.detail.trim()) lines.push(`  ${c.detail.trim()}`);
    }
    lines.push('');
  }

  if (opts.includeOpenQuestions && rubric.openQuestions.length > 0) {
    lines.push('## What this rubric does not answer yet');
    lines.push('');
    lines.push(
      'These are the cases the rubric leaves to the grader. Expect disagreement here first — that is what the next round is for.',
    );
    lines.push('');
    for (const q of rubric.openQuestions) {
      lines.push(`- **${q.question.trim()}**`);
      if (q.why.trim()) lines.push(`  ${q.why.trim()}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The judge prompt is the rubric, verbatim, plus the output contract. Nothing is
 * paraphrased: if a judge disagrees with the humans, the rubric is the thing to
 * fix, and that is only true if the judge read exactly what the humans read.
 *
 * Open questions are deliberately left out, even though they are part of the
 * rubric document. Telling a judge "abstain when the case turns on one of these"
 * would make an early, gap-riddled rubric abstain more and a calibrated one
 * abstain less — and since abstentions never count as agreement, calibration
 * would appear to work for a reason that has nothing to do with judgment. The
 * measurement artefact is worth more than the honesty gained, so the judge grades
 * the settled rubric and its mistakes on unsettled cases stay visible as
 * disagreement.
 *
 * Conflicts are left out for the same reason, and a stronger one: a rule that
 * contradicts another rule is not gradable by anybody, so handing it to a judge
 * could only produce a guess or an abstention.
 */
export function buildJudgeSystemPrompt(rubric: RubricVersion): string {
  const scale = [...rubric.scale].sort((a, b) => b.rank - a.rank);
  return [
    'You are grading agent transcripts against a rubric that a team calibrated by hand.',
    'Apply the rubric as written. Do not substitute your own standard, and do not soften a verdict because the transcript is sympathetic.',
    '',
    renderRubricMarkdown(rubric),
    '',
    '## Output contract',
    '',
    `Reply with a single JSON object and nothing else: {"verdict": one of ${scale
      .map((s) => JSON.stringify(s.id))
      .join(' | ')} | "abstain", "rationale": a sentence citing the clause or criterion that decided it}.`,
    'Use "abstain" only when the transcript genuinely does not contain enough to apply the rubric. Abstaining to avoid a hard call is a failure of the judge.',
  ].join('\n');
}

export function buildJudgeUserPrompt(trace: Pick<Trace, 'title' | 'content'>): string {
  return [`## Trace: ${trace.title}`, '', '```', trace.content, '```', '', 'Grade this trace.'].join('\n');
}

export function nextVersionName(rubric: RubricVersion): string {
  return rubric.name;
}
