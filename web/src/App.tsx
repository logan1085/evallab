import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, recallKey, rememberKey } from './api';
import { Home } from './pages/Home';
import { SetupPage } from './pages/Setup';
import { ProjectPage } from './pages/Project';
import { PanelRoundPage } from './pages/PanelRound';
import { Masthead } from './ui';
import { ModeNotice } from './ModeNotice';

export function App() {
  return (
    <>
    <ModeNotice />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/setup" element={<SetupPage />} />
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
    </>
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
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const validated = useRef<{ slug: string; token: string } | null>(null);

  useEffect(() => {
    if (!slug) return;
    const fromUrl = params.get('k');
    const candidate = fromUrl ?? recallKey(slug);
    if (candidate && validated.current?.slug === slug && validated.current.token === candidate) {
      setToken(candidate);
      setError(null);
      setChecking(false);
      if (fromUrl) {
        const next = new URLSearchParams(params);
        next.delete('k');
        setParams(next, { replace: true });
      }
      return;
    }
    let active = true;
    setToken(null);
    setError(null);
    setChecking(!!candidate);
    if (!candidate) return;

    // Validate before saving a shared key or admitting the page. A wrong or
    // revoked saved key must lead back to this form, not a dead-end error.
    void api.project(slug, candidate).then(() => {
      if (!active) return;
      rememberKey(slug, candidate);
      validated.current = { slug, token: candidate };
      setToken(candidate);
      setChecking(false);
      if (fromUrl) {
        // Drop the key from the address bar after it has been checked.
        const next = new URLSearchParams(params);
        next.delete('k');
        setParams(next, { replace: true });
      }
    }).catch((err: unknown) => {
      if (!active) return;
      setChecking(false);
      setError(err instanceof ApiError && (err.status === 401 || err.status === 403)
        ? 'That key is wrong or has been revoked. Paste a working project key below.'
        : err instanceof Error ? err.message : 'The project could not be checked. Try again.');
    });
    return () => { active = false; };
  }, [slug, params, setParams, attempt]);

  if (!slug) return <Navigate to="/" replace />;
  if (checking) return <main className="sheet"><p role="status">Checking your project key…</p></main>;
  if (token) return <>{children}</>;

  return (
    <main className="sheet">
      <Masthead crumbs={['Access']} title="This link needs its key" standfirst="The shared link is the only credential in v1. Paste the key from the end of the invite URL." />
      <div className="panel" style={{ maxWidth: 520 }}>
        {error ? <p role="alert">{error}</p> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            const next = new URLSearchParams(params);
            next.set('k', typed.trim());
            setParams(next, { replace: true });
            setAttempt((value) => value + 1);
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
