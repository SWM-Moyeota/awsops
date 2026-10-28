// `config.json` → `actionPlan`, with approvers shared from `slackControl`.
// Off (null) unless actionPlan.enabled is true AND at least one approver is set.
// 승인자는 slackControl과 공유한다. enabled와 승인자가 모두 있어야 켜진다.
import { getConfig } from '@/lib/app-config';
import { getControlConfig } from '@/lib/slack-control/handle';
import type { ActionPlanConfig } from './types';

const DEFAULTS = { maxSteps: 5, maxResources: 3, maxBlastRadius: 5, undoHours: 24 };

const positive = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

export function isActionPlanEnabled(): boolean {
  return getConfig().actionPlan?.enabled === true;
}

export function getActionPlanConfig(): ActionPlanConfig | null {
  const c = getConfig().actionPlan;
  if (c?.enabled !== true) return null;
  const approval = getControlConfig();
  if (!approval) return null;
  const aliases: Record<string, string[]> = {};
  for (const [name, cidrs] of Object.entries(c.sourceAliases ?? {})) {
    if (Array.isArray(cidrs)) aliases[name] = cidrs.filter((x): x is string => typeof x === 'string');
  }
  return {
    approval,
    maxSteps: positive(c.maxSteps, DEFAULTS.maxSteps),
    maxResources: positive(c.maxResources, DEFAULTS.maxResources),
    maxBlastRadius: positive(c.maxBlastRadius, DEFAULTS.maxBlastRadius),
    undoHours: positive(c.undoHours, DEFAULTS.undoHours),
    sourceAliases: aliases,
  };
}
