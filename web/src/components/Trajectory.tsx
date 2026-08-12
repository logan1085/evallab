import { useState } from 'react';
import type { TrajectoryPoint } from '../api';
import { pct } from '../ui';

/**
 * Held-out agreement across rounds.
 *
 * The chart's job is one question — did agreement move after calibration — so
 * it is a single series and carries no legend; the title names it.
 *
 * Two decisions do most of the honesty work here. A round is drawn as a dot
 * *with its interval*, because a point estimate over a handful of items implies
 * a precision the data does not have. And consecutive rounds are joined only
 * when the server says they are comparable: change the held-out traces or the
 * panel and the gap is left open rather than bridged, because a line between
 * those two points would assert a before-and-after that was never measured.
 *
 * A round with no held-out arm is not plotted at zero — it is not plotted at
 * all, and says so on the axis. Drawing "no measurement" as a collapse to zero
 * would be the most misleading thing this chart could do.
 */

const W = 720;
const H = 250;
const PAD = { top: 18, right: 64, bottom: 44, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export function Trajectory({ series }: { series: TrajectoryPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const x = (i: number) => PAD.left + (series.length === 1 ? PLOT_W / 2 : (i * PLOT_W) / (series.length - 1));
  const y = (v: number) => PAD.top + (1 - v) * PLOT_H;

  const plotted = series.map((p) => p.heldout.agreement.units > 0);
  const last = [...series].map((p, i) => (plotted[i] ? i : -1)).filter((i) => i >= 0).pop() ?? -1;

  const gaps = series
    .map((point, i) => ({ point, i }))
    .filter(({ point, i }) => i > 0 && !point.comparableToPrevious && point.comparabilityNotes.length > 0);

  return (
    <figure style={{ margin: '0 0 18px' }}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Held-out agreement across ${series.length} closed rounds`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {/* Recessive solid hairline grid — never dashed. */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--hairline-soft)" strokeWidth={1} />
              <text
                x={PAD.left - 10}
                y={y(v) + 3.5}
                textAnchor="end"
                fontSize={10}
                fontFamily="var(--data)"
                fill="var(--ink-4)"
              >
                {v * 100}%
              </text>
            </g>
          ))}

          {/* Join consecutive rounds only where the comparison is legitimate. */}
          {series.map((point, i) => {
            if (i === 0 || !point.comparableToPrevious) return null;
            if (!plotted[i] || !plotted[i - 1]) return null;
            return (
              <line
                key={`seg-${point.roundId}`}
                x1={x(i - 1)}
                y1={y(series[i - 1]!.heldout.agreement.observed)}
                x2={x(i)}
                y2={y(point.heldout.agreement.observed)}
                stroke="var(--chart)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            );
          })}

          {series.map((point, i) => {
            const stats = point.heldout.agreement;
            const cx = x(i);

            if (!plotted[i]) {
              return (
                <g key={point.roundId}>
                  <line
                    x1={cx}
                    x2={cx}
                    y1={PAD.top}
                    y2={PAD.top + PLOT_H}
                    stroke="var(--hairline)"
                    strokeWidth={1}
                    opacity={0.6}
                  />
                  <text
                    x={cx}
                    y={PAD.top + PLOT_H / 2}
                    textAnchor="middle"
                    fontSize={10}
                    fontFamily="var(--data)"
                    fill="var(--ink-4)"
                  >
                    no held-out arm
                  </text>
                </g>
              );
            }

            const cy = y(stats.observed);
            return (
              <g key={point.roundId}>
                {stats.observedCI ? (
                  <g stroke="var(--chart)" strokeWidth={2} opacity={0.32} strokeLinecap="round">
                    <line x1={cx} x2={cx} y1={y(stats.observedCI[0])} y2={y(stats.observedCI[1])} />
                    <line x1={cx - 4} x2={cx + 4} y1={y(stats.observedCI[0])} y2={y(stats.observedCI[0])} />
                    <line x1={cx - 4} x2={cx + 4} y1={y(stats.observedCI[1])} y2={y(stats.observedCI[1])} />
                  </g>
                ) : null}
                {/* 2px surface ring keeps the dot legible where it meets the line. */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={5}
                  fill="var(--chart)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
                {/* Direct-label the endpoint only; the axis, hover and table carry the rest. */}
                {i === last ? (
                  <text
                    x={cx + 12}
                    y={cy + 4}
                    fontSize={13}
                    fontFamily="var(--data)"
                    fill="var(--ink)"
                    fontWeight={600}
                  >
                    {pct(stats.observed, 0)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {series.map((point, i) => (
            <text
              key={`lab-${point.roundId}`}
              x={x(i)}
              y={H - PAD.bottom + 18}
              textAnchor="middle"
              fontSize={10}
              fontFamily="var(--data)"
              fill={hover === i ? 'var(--ink)' : 'var(--ink-4)'}
            >
              R{point.index}
              <tspan x={x(i)} dy={13} fill="var(--ink-4)">
                v{point.rubricVersion ?? '—'}
              </tspan>
            </text>
          ))}

          {/* Hit targets wider than the marks. */}
          {series.map((point, i) => (
            <rect
              key={`hit-${point.roundId}`}
              x={x(i) - PLOT_W / (series.length * 2 || 1) / 1.2}
              y={PAD.top}
              width={Math.max(28, PLOT_W / (series.length || 1) / 1.2)}
              height={PLOT_H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>

        {hover !== null && series[hover] ? (
          <Tooltip point={series[hover]!} left={(x(hover) / W) * 100} />
        ) : null}
      </div>

      <figcaption className="note" style={{ marginTop: 10 }}>
        Held-out agreement, with 95% intervals where the sample supports one. Rounds are joined only where the
        comparison is legitimate.
      </figcaption>

      {gaps.length > 0 ? (
        <ul className="plain" style={{ marginTop: 10, fontSize: 15 }}>
          {gaps.map(({ point, i }) => (
            <li key={point.roundId}>
              <strong>
                {series[i - 1]!.name} → {point.name} not compared.
              </strong>{' '}
              {point.comparabilityNotes.join(' ')}
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}

function Tooltip({ point, left }: { point: TrajectoryPoint; left: number }) {
  const stats = point.heldout.agreement;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: 0,
        transform: 'translateX(-50%)',
        background: 'var(--surface)',
        border: '1px solid var(--hairline)',
        padding: '9px 12px',
        pointerEvents: 'none',
        minWidth: 190,
        zIndex: 2,
      }}
    >
      <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>
        {point.name} · rubric v{point.rubricVersion ?? '—'}
      </div>
      <div className="tiny" style={{ marginTop: 4 }}>
        {stats.units > 0 ? (
          <>
            HELD OUT {pct(stats.observed, 1)}
            {stats.observedCI ? ` (${pct(stats.observedCI[0], 0)}–${pct(stats.observedCI[1], 0)})` : ''}
            <br />
            {stats.units} items × {stats.raters} graders
          </>
        ) : (
          'No held-out arm in this round'
        )}
        <br />
        {point.clauseCount} clause{point.clauseCount === 1 ? '' : 's'} · {point.splitCount} split
        {point.splitCount === 1 ? '' : 's'}
        {point.heldoutDelta !== null ? (
          <>
            <br />
            <span className={point.heldoutDelta >= 0 ? 'delta-up' : 'delta-down'}>
              {point.heldoutDelta >= 0 ? '+' : ''}
              {(point.heldoutDelta * 100).toFixed(1)} pts vs previous
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
