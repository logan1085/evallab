import { useEffect, useState } from 'react';

/**
 * What this deployment is and lets a visitor do, read once from the server
 * and shared by every surface that mentions it. The mode is never inferred
 * from the hostname: a preview and production answer for themselves.
 */
export interface DeploymentMode {
  mode: 'simulated' | 'live' | 'unknown';
  hosted: boolean;
  /** Why the deployment is simulated, in the operator's terms. Empty when live. */
  reasons: string[];
  capabilities: { liveModels: boolean; ownEndpoints: boolean };
}

const UNKNOWN: DeploymentMode = { mode: 'unknown', hosted: false, reasons: [], capabilities: { liveModels: false, ownEndpoints: true } };

let cached: DeploymentMode | null = null;
let inFlight: Promise<DeploymentMode> | null = null;

export function fetchMode(): Promise<DeploymentMode> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= fetch('/api/health')
    .then((r) => r.json())
    .then((data: Partial<DeploymentMode> & { live?: { hosted?: boolean; reasons?: string[] } }) => {
      const next: DeploymentMode = {
        mode: data.mode === 'simulated' || data.mode === 'live' ? data.mode : 'unknown',
        hosted: data.live?.hosted ?? false,
        reasons: data.live?.reasons ?? [],
        capabilities: {
          liveModels: data.capabilities?.liveModels ?? data.mode === 'live',
          ownEndpoints: data.capabilities?.ownEndpoints ?? !(data.live?.hosted ?? false),
        },
      };
      cached = next;
      return next;
    })
    .catch(() => UNKNOWN)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useMode(): DeploymentMode {
  const [mode, setMode] = useState<DeploymentMode>(cached ?? UNKNOWN);
  useEffect(() => {
    let live = true;
    void fetchMode().then((m) => {
      if (live) setMode(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return mode;
}

/**
 * The sentence that explains a simulated verdict, for the deployment at
 * hand: a visitor to the public demo is told it is a demo; an operator of
 * their own instance is told which variable to set.
 */
export function simulatedBecause(m: DeploymentMode): string {
  if (m.hosted) return 'Live model judging is not enabled on this deployment.';
  if (m.reasons.length > 0) return `Live model judging is off: ${m.reasons.join('; ')}. Set them in .env.local to seat real models.`;
  return 'Live model judging is not enabled.';
}
