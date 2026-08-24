import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { recallKey, rememberKey } from './api';
import { Home } from './pages/Home';
import { ProjectPage } from './pages/Project';
import { PanelRoundPage } from './pages/PanelRound';
import { Masthead } from './ui';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route
        path="/p/:slug"
        element={
          <KeyGate>
            <ProjectPage />
          </KeyGate>
        }
      />
      <Route
        path="/p/:slug/round/:roundId"
        element={
          <KeyGate>
            <PanelRoundPage />
          </KeyGate>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * The key rides in the shared link once, then lives in localStorage. Someone
 * who opens the bare URL on a new device gets asked for it rather than a
 * generic 403 — the link is the credential, so losing it is the failure mode
 * worth handling well.
 */
function KeyGate({ children }: { children: React.ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!slug) return;
    const fromUrl = params.get('k');
    if (fromUrl) {
      rememberKey(slug, fromUrl);
      setToken(fromUrl);
      // Drop the key from the address bar so it does not end up in a screenshot
      // of the report, which people paste into threads constantly.
      const next = new URLSearchParams(params);
      next.delete('k');
      setParams(next, { replace: true });
      return;
    }
    setToken(recallKey(slug));
  }, [slug, params, setParams]);

  if (!slug) return <Navigate to="/" replace />;
  if (token) return <>{children}</>;

  return (
    <main className="sheet">
      <Masthead crumbs={['Access']} title="This link needs its key" standfirst="The shared link is the only credential in v1. Paste the key from the end of the invite URL." />
      <div className="panel" style={{ maxWidth: 520 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            rememberKey(slug, typed.trim());
            setToken(typed.trim());
          }}
        >
          <div className="field">
            <label htmlFor="key">Project key</label>
            <input id="key" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </div>
          <button type="submit">Open the project</button>
        </form>
      </div>
    </main>
  );
}
