/**
 * The spend guard: ceilings enforced inside callModel, before the request
 * goes out, returning a typed budget_exceeded rather than throwing. A round
 * that trips a ceiling stops with a recorded, visible reason, never a silent
 * partial result.
 */

import type { DB } from './db.js';
import type { SpendGuard } from './gateway.js';
import * as store from './store.js';

export const ROUND_CEILING_ENV = 'GR_ROUND_COST_CEILING_CREDITS';
export const DAILY_CEILING_ENV = 'GR_DAILY_COST_CEILING_CREDITS';

export function createSpendGuard(db: DB): SpendGuard {
  return {
    async check(caller) {
      const roundCeiling = Number(process.env[ROUND_CEILING_ENV] ?? '');
      const dailyCeiling = Number(process.env[DAILY_CEILING_ENV] ?? '');

      if (Number.isFinite(roundCeiling) && roundCeiling > 0 && caller.round_id) {
        const spent = (await store.costForRound(db, caller.round_id)).totalCredits;
        if (spent >= roundCeiling) {
          return {
            kind: 'budget_exceeded',
            message: `This round has spent ${spent.toFixed(4)} credits, at its ${roundCeiling} ceiling. Raise ${ROUND_CEILING_ENV} to continue.`,
          };
        }
      }
      if (Number.isFinite(dailyCeiling) && dailyCeiling > 0) {
        const spent = await store.dailySpend(db);
        if (spent >= dailyCeiling) {
          return {
            kind: 'budget_exceeded',
            message: `Daily spend is ${spent.toFixed(4)} credits, at the ${dailyCeiling} ceiling. Raise ${DAILY_CEILING_ENV} or wait.`,
          };
        }
      }
      return null;
    },
  };
}
