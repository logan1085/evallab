import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ABSTAIN, type AgreementStats, type CoverageStats, type VerdictLevel } from '@shared/types';

/* ---- Formatting --------------------------------------------------------- */

export const pct = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(digits)}%`;

export const num = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits);

export const minutes = (ms: number): string => `${Math.round(ms / 60000)} min`;

/* ---- Async ------------------------------------------------------------- */

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fn()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload, setData };
}

/* ---- Chrome ------------------------------------------------------------- */

export function Masthead({
  crumbs,
  title,
  standfirst,
  right,
}: {
  crumbs: (string | { label: string; to: string })[];
  title: string;
  standfirst?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="masthead">
      <div className="stamp">
        <span>
          <b>The Grading Room</b>
        </span>
        {crumbs.map((crumb, i) =>
          typeof crumb === 'string' ? (
            <span key={i}>{crumb}</span>
          ) : (
            <Link key={i} to={crumb.to}>
              {crumb.label}
            </Link>
          ),
        )}
        {right ? <span className="spacer">{right}</span> : null}
      </div>
      <h1>{title}</h1>
      {standfirst ? <p className="standfirst">{standfirst}</p> : null}
    </header>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      {message}
      {onDismiss ? (
        <>
          {' '}
          <button className="ghost tiny-btn" onClick={onDismiss}>
            dismiss
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="spinner">LOADING {what.toUpperCase()}…</p>;
}

/* ---- Verdicts ----------------------------------------------------------- */

/** Colour follows the scale's ordinal position, so a custom scale still reads correctly. */
export function verdictClass(verdict: string, scale: VerdictLevel[]): string {
  if (verdict === ABSTAIN) return 'v-abstain';
  const ranks = scale.map((s) => s.rank);
  const level = scale.find((s) => s.id === verdict);
  if (!level) return 'v-mid';
  if (level.rank === Math.max(...ranks)) return 'v-pass';
  if (level.rank === Math.min(...ranks)) return 'v-fail';
  return 'v-mid';
}

export function Verdict({ verdict, scale }: { verdict: string | null | undefined; scale: VerdictLevel[] }) {
  if (!verdict) return <span className="verdict v-abstain">—</span>;
  const label = verdict === ABSTAIN ? 'abstain' : (scale.find((s) => s.id === verdict)?.label ?? verdict);
  return <span className={`verdict ${verdictClass(verdict, scale)}`}>{label}</span>;
}

/* ---- Stats -------------------------------------------------------------- */

/**
 * Agreement and coverage are rendered together, always. Splitting them across
 * two views is how a rubric quietly buys agreement by narrowing what it covers.
 */
export function AgreementPanel({
  label,
  agreement,
  coverage,
  compareTo,
}: {
  label: string;
  agreement: AgreementStats;
  coverage: CoverageStats;
  compareTo?: number | null;
}) {
  const delta = compareTo === null || compareTo === undefined ? null : agreement.observed - compareTo;

  return (
    <div>
      <div className="metrics">
        <div className="metric">
          <span className="metric-k">{label} agreement</span>
          <span className="metric-big">{pct(agreement.observed, 1)}</span>
          <span className="metric-sub">
            {agreement.observedCI
              ? `95% CI ${pct(agreement.observedCI[0], 0)}–${pct(agreement.observedCI[1], 0)}`
              : 'interval withheld'}
          </span>
          {delta !== null ? (
            <span className={`metric-sub ${delta >= 0 ? 'delta-up' : 'delta-down'}`}>
              {delta >= 0 ? '+' : ''}
              {(delta * 100).toFixed(1)} pts vs previous round
            </span>
          ) : null}
        </div>

        <div className="metric">
          <span className="metric-k">Chance-corrected</span>
          <span className="metric-big">{num(agreement.alphaOrdinal)}</span>
          <span className="metric-sub">
            Krippendorff&rsquo;s α, ordinal{agreement.alphaNominal !== null ? ` · nominal ${num(agreement.alphaNominal)}` : ''}
          </span>
        </div>

        <div className="metric">
          <span className="metric-k">Coverage</span>
          <span className="metric-big">{pct(coverage.participation)}</span>
          <span className="metric-sub">of the grader × item grid filled</span>
          <span className="metric-sub">
            {pct(coverage.abstentionRate)} abstained · {pct(coverage.clauseCoverage)} touched by a clause
          </span>
        </div>

        <div className="metric">
          <span className="metric-k">Sample</span>
          <span className="metric-big">
            {agreement.units}
            <span style={{ fontSize: 18, color: 'var(--faint)' }}> × {agreement.raters}</span>
          </span>
          <span className="metric-sub">comparable items × graders</span>
        </div>
      </div>

      {agreement.caveats.length > 0 ? (
        <div className="warn">
          <span className="metric-k">Read these with the number</span>
          <ul className="plain" style={{ marginBottom: 0, marginTop: 8 }}>
            {agreement.caveats.map((caveat, i) => (
              <li key={i}>{caveat}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
