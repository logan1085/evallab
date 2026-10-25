/** Public deployments are usable demos until an operator explicitly enables paid calls. */
export function hosted(): boolean {
  return !!process.env.VERCEL;
}

export function liveModelsEnabled(): boolean {
  if (!hosted()) return true;
  const daily = Number(process.env.GR_DAILY_COST_CEILING_CREDITS);
  const round = Number(process.env.GR_ROUND_COST_CEILING_CREDITS);
  return process.env.GR_ENABLE_LIVE_MODE === 'true'
    && Number.isFinite(daily) && daily > 0
    && Number.isFinite(round) && round > 0;
}

export function configuredModelKey(): string | undefined {
  return liveModelsEnabled() ? process.env.OPENROUTER_API_KEY || undefined : undefined;
}

/**
 * Why the deployment is in the mode it is in, in the operator's terms: each
 * line names the variable that would change it. Read by /api/health so a
 * hosted deployment that is unexpectedly simulated says which of the four
 * conditions is missing, rather than leaving the operator to guess.
 */
export function liveModeReport(): { mode: 'live' | 'simulated'; hosted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const key = !!process.env.OPENROUTER_API_KEY;
  if (!key) reasons.push('OPENROUTER_API_KEY is not set');
  if (hosted()) {
    if (process.env.GR_ENABLE_LIVE_MODE !== 'true') reasons.push('GR_ENABLE_LIVE_MODE is not "true"');
    const daily = Number(process.env.GR_DAILY_COST_CEILING_CREDITS);
    const round = Number(process.env.GR_ROUND_COST_CEILING_CREDITS);
    if (!Number.isFinite(daily) || daily <= 0) reasons.push('GR_DAILY_COST_CEILING_CREDITS is not a positive number');
    if (!Number.isFinite(round) || round <= 0) reasons.push('GR_ROUND_COST_CEILING_CREDITS is not a positive number');
  }
  return { mode: reasons.length === 0 ? 'live' : 'simulated', hosted: hosted(), reasons };
}

/** What this deployment lets a visitor do, for the UI to shape itself around. */
export function capabilities(): { liveModels: boolean; ownEndpoints: boolean } {
  return { liveModels: liveModeReport().mode === 'live', ownEndpoints: !hosted() };
}

export const HOSTED_ENDPOINT_MESSAGE =
  'Custom model endpoints are available only in a trusted self-hosted installation. This public demo does not accept or call arbitrary model servers.';
