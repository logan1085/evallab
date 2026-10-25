import { useMode } from './mode';

/**
 * The band that says what this deployment is. Mode is read from the server,
 * never inferred from the browser's hostname, and the band is quiet: one
 * line in the house type, on the house tokens, not a banner.
 */
export function ModeNotice() {
  const m = useMode();
  if (m.mode === 'unknown') return null;
  return (
    <aside className="mode-notice" aria-label="Evaluation mode">
      {m.mode === 'simulated' ? (
        <>
          <b>Free demo.</b> Create a project, edit its standard, run a simulated panel, and leave with a framework. Scenarios and
          verdicts are fixtures, not model judgments. Use fictional or non-sensitive examples.
        </>
      ) : (
        <>
          <b>Live model mode.</b> Your cases are sent to model providers to be judged. Use non-sensitive examples.
        </>
      )}
    </aside>
  );
}
