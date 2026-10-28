// Policy rules (spec §3.5 rules 1-7). Pure: no I/O. Any denial rejects the whole plan.
// 규칙 검사. 하나라도 거부되면 계획 전체를 실행하지 않고, 이유는 모두 모아서 보여 준다.
import { safeName } from '@/lib/slack-control/ec2';
import type { ActionPlanConfig, PolicyResult, Snapshot, StepChange } from './types';

const PROD_KEYS = new Set(['env', 'environment']);
const PROD_VALUES = new Set(['prod', 'production']);
const MAX_PORT_SPAN = 1000;

function isProd(tags: Record<string, string>): boolean {
  return Object.entries(tags).some(([k, v]) => PROD_KEYS.has(k.trim().toLowerCase()) && PROD_VALUES.has(String(v).trim().toLowerCase()));
}

/**
 * World-open = prefix length 0, whatever the address is written as (::0/0, 0::/0, 1.2.3.4/0, 0.0.0.0/00 …).
 * validate.ts already canonicalizes; this does not rely on it.
 * 주소 표기와 상관없이 접두사 길이가 0이면 전체 공개로 본다.
 */
function isWorldOpen(source: string): boolean {
  if (source.startsWith('sg-')) return false;
  const m = /\/\s*(\d+)\s*$/.exec(source);
  return !m || Number(m[1]) === 0; // no parsable prefix → treat as world-open (fail closed)
}

export function evaluatePolicy(
  changes: StepChange[],
  s: Snapshot,
  cfg: Pick<ActionPlanConfig, 'maxBlastRadius'>,
): PolicyResult {
  const denials: string[] = [];
  const deny = (msg: string) => { if (!denials.includes(msg)) denials.push(msg); };

  for (const { step, noop } of changes) {
    if (noop) continue;
    const snap = s[step.target.id];
    const label = safeName(snap?.name || step.target.name) || step.target.id;

    if (!snap) { deny(`${label}의 현재 상태를 확인하지 못해서 실행할 수 없어요.`); continue; }

    // 1. control tag
    if (snap.tags['awsops:control'] !== 'allow') {
      deny(`${label}에는 awsops:control=allow 태그가 없어서 제어할 수 없어요.`);
    }
    // 2. production protection
    if (isProd(snap.tags)) {
      deny(`${label}은(는) 운영(Production) 리소스라서 변경할 수 없어요.`);
    }
    // 3. protected tag keys
    if ((step.action === 'tag.set' || step.action === 'tag.remove') && (step.key ?? '').toLowerCase().startsWith('awsops:')) {
      deny(`${label}의 awsops: 로 시작하는 태그는 만들거나 바꾸거나 지울 수 없어요.`);
    }

    if (step.action === 'sg.ingress.add') {
      const r = step.rule;
      if (r) {
        // 4. no world-open except 80/443
        if (isWorldOpen(r.source)) {
          const web = r.fromPort === r.toPort && (r.fromPort === 80 || r.fromPort === 443);
          if (!web) deny(`${label}에 전체 공개(${r.source})로 ${r.fromPort === r.toPort ? r.fromPort : `${r.fromPort}-${r.toPort}`} 포트를 여는 것은 허용되지 않아요. 80과 443만 가능해요.`);
        }
        // 5. too broad
        if ((r.protocol as string) === '-1') {
          deny(`${label}에 모든 프로토콜을 여는 규칙은 허용되지 않아요.`);
        } else if (r.toPort - r.fromPort + 1 > MAX_PORT_SPAN) {
          deny(`${label}에 포트 ${r.fromPort}-${r.toPort} 처럼 ${MAX_PORT_SPAN}개를 넘는 범위는 열 수 없어요.`);
        }
      }
    }

    // 6. blast radius — unknown ENI count is a denial (fail closed)
    if (step.target.type === 'security-group' && step.action.startsWith('sg.')) {
      if (snap.eniCount === undefined) {
        deny(`${label}을(를) 쓰는 네트워크 인터페이스 수를 확인하지 못해서 실행할 수 없어요.`);
      } else if (snap.eniCount > cfg.maxBlastRadius) {
        deny(`${label}을(를) 쓰는 네트워크 인터페이스가 ${snap.eniCount}개라 영향이 너무 커요(최대 ${cfg.maxBlastRadius}개). 콘솔에서 직접 해 주세요.`);
      }
    }

    // 7. transitional states
    if (step.target.type === 'instance') {
      const st = snap.state;
      if (st === 'shutting-down') deny(`${label}은(는) 종료되는 중이라 어떤 작업도 할 수 없어요.`);
      else if (step.action === 'ec2.start' && st === 'stopping') deny(`${label}은(는) 지금 꺼지는 중이라 켤 수 없어요. 잠시 뒤에 다시 해 주세요.`);
      else if (step.action === 'ec2.stop' && st === 'pending') deny(`${label}은(는) 지금 켜지는 중이라 끌 수 없어요. 잠시 뒤에 다시 해 주세요.`);
    }
  }
  return { ok: denials.length === 0, denials };
}
