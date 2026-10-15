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

export const HOSTED_ENDPOINT_MESSAGE =
  'Custom model endpoints are available only in a trusted self-hosted installation. This public demo does not accept or call arbitrary model servers.';
