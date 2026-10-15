import { useEffect, useState } from 'react';

/** Mode is read from the server, never inferred from the browser's hostname. */
export function ModeNotice() {
  const [mode, setMode] = useState<'simulated' | 'live' | 'unknown'>('unknown');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.mode === 'simulated' || data.mode === 'live') setMode(data.mode);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (mode === 'unknown') return null;
  return <aside aria-label="Evaluation mode" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line, #333)', fontSize: 13, lineHeight: 1.5, textAlign: 'center' }}>
    {mode === 'simulated'
      ? <><strong>Free interactive demo.</strong> Create a project, edit its rubric, run a simulated panel, and export a framework. Scenarios and verdicts are sample data, not live model evaluations. Please use fictional or non-sensitive examples.</>
      : <><strong>Live model mode.</strong> Your cases are sent to model providers for evaluation. Please use non-sensitive examples.</>}
  </aside>;
}
