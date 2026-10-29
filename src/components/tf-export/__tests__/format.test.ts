import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STEPS, addArn, arnTail, buildSeed, byTypeRows, downloadUrl, effectiveAccount, elapsed, excludeReasonLabel, fileUrl, hasSecretVars,
  isSettled, outcomeColor, outcomeLabel, passRates, passedAtLabel, percent, seedKey, seedLabel, splitCode, stageLabel, stepStates,
  typeLabel, viewableFiles, type SeedForm,
} from '../format';

const dir = path.resolve(__dirname, '../../../lib/i18n/translations');
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
const ko = load('ko.json');
const en = load('en.json');
const zh = load('zh.json');

// Same interpolation as LanguageContext. / LanguageContext와 같은 보간.
const tOf = (dict: Record<string, string>) => (key: string, params?: Record<string, string | number>) => {
  let text = dict[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return text;
};
const t = tOf(ko);
const tEn = tOf(en);

const form = (p: Partial<SeedForm>): SeedForm => ({ kind: 'tag', tagKey: '', tagValue: '', prefix: '', vpcArn: '', arns: [], ...p });

describe('stage labels', () => {
  it('names the eight steps in order, in plain Korean', () => {
    expect(STEPS.map((s) => stageLabel(s, t))).toEqual([
      '준비', '원본 뽑기', '규칙으로 고치기', 'AI로 고치기', '바뀌는 것 확인', '참조·이름 정리', '다시 확인', '묶기',
    ]);
  });
  it('labels done/failed and falls back to the raw stage', () => {
    expect(stageLabel('done', t)).toBe('완료');
    expect(stageLabel('failed', t)).toBe('실패');
    expect(stageLabel('weird', t)).toBe('weird');
    expect(stageLabel('ai-fix', tEn)).toBe('Fix with AI');
  });
  it('knows when a job has stopped', () => {
    expect(isSettled('done')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('diff')).toBe(false);
    expect(isSettled(undefined)).toBe(false);
  });
});

describe('stepStates', () => {
  it('marks earlier steps done and the running one current', () => {
    expect(stepStates('diff')).toEqual(['done', 'done', 'done', 'done', 'current', 'todo', 'todo', 'todo']);
    expect(stepStates('prepare')[0]).toBe('current');
  });
  it('marks everything done when finished', () => {
    expect(stepStates('done')).toEqual(STEPS.map(() => 'done'));
  });
  it('marks the last seen stage red on failure, or nothing when unknown', () => {
    expect(stepStates('failed', 'rules')).toEqual(['done', 'done', 'failed', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(stepStates('failed', null)).toEqual(STEPS.map(() => 'todo'));
  });
});

describe('outcome labels', () => {
  it('uses the agreed badges', () => {
    expect(outcomeLabel('pass', t)).toBe('✅ diff 0');
    expect(outcomeLabel('pass-ignore', t)).toBe('🟡 ignore 사용');
    expect(outcomeLabel('failed', t)).toBe('❌ 실패');
    expect(outcomeLabel('pass-ignore', tEn)).toBe('🟡 uses ignore');
  });
  it('maps outcomes to color names', () => {
    expect(outcomeColor('pass')).toBe('green');
    expect(outcomeColor('pass-ignore')).toBe('orange');
    expect(outcomeColor('failed')).toBe('red');
  });
  it('labels where a resource passed', () => {
    expect(passedAtLabel('rules', t)).toBe('규칙만으로');
    expect(passedAtLabel('ai', t)).toBe('AI로 고친 뒤');
    expect(passedAtLabel('final', t)).toBe('정리 뒤');
    expect(passedAtLabel(undefined, t)).toBe('—');
  });
});

describe('exclude reasons', () => {
  it('names every reason in Korean', () => {
    expect(excludeReasonLabel('attached-to-instance', t)).toBe('서버에 포함됨');
    expect(excludeReasonLabel('unsupported', t)).toBe('지원 안 함');
    expect(excludeReasonLabel('over-limit', t)).toBe('개수 초과');
    expect(excludeReasonLabel('other-region', t)).toBe('다른 리전');
    expect(excludeReasonLabel('shared', t)).toBe('다른 곳에서도 씀');
    expect(excludeReasonLabel('managed', t)).toBe('AWS가 관리');
    expect(excludeReasonLabel('service-role', t)).toBe('AWS 서비스 역할');
    expect(excludeReasonLabel('mystery', t)).toBe('mystery');
  });
});

describe('percent / passRates / byTypeRows', () => {
  it('rounds to whole percent and guards zero totals', () => {
    expect(percent(13, 14)).toBe('93%');
    expect(percent(1, 3)).toBe('33%');
    expect(percent(14, 14)).toBe('100%');
    expect(percent(0, 5)).toBe('0%');
    expect(percent(0, 0)).toBe('—');
    expect(percent(NaN, 4)).toBe('—');
    expect(percent(9, 4)).toBe('100%');
  });
  it('gives the three pass rates', () => {
    expect(passRates({ total: 14, passRules: 13, passAi: 14, passFinal: 12 })).toEqual({ rules: '93%', ai: '100%', final: '86%' });
  });
  it('lists types with the most resources first', () => {
    const rows = byTypeRows({ aws_vpc: { total: 1, pass: 1 }, aws_subnet: { total: 4, pass: 3 } });
    expect(rows.map((r) => r.tfType)).toEqual(['aws_subnet', 'aws_vpc']);
    expect(rows[0].rate).toBe('75%');
    expect(byTypeRows(undefined)).toEqual([]);
  });
});

describe('buildSeed / addArn / seedKey', () => {
  it('builds trimmed tag and prefix seeds', () => {
    expect(buildSeed(form({ tagKey: ' Project ', tagValue: ' shop ' }))).toEqual({ kind: 'tag', key: 'Project', value: 'shop' });
    expect(buildSeed(form({ tagKey: 'Project' }))).toBeNull();
    expect(buildSeed(form({ kind: 'prefix', prefix: ' shop- ' }))).toEqual({ kind: 'prefix', prefix: 'shop-' });
    expect(buildSeed(form({ kind: 'prefix', prefix: 'x'.repeat(65) }))).toBeNull();
  });
  it('needs an EC2 ARN for a VPC seed', () => {
    expect(buildSeed(form({ kind: 'vpc', vpcArn: 'arn:aws:ec2:ap-northeast-2:111111111111:vpc/vpc-1' }))?.kind).toBe('vpc');
    expect(buildSeed(form({ kind: 'vpc', vpcArn: 'vpc-1' }))).toBeNull();
  });
  it('keeps 1..60 unique ARNs', () => {
    expect(buildSeed(form({ kind: 'arns', arns: [] }))).toBeNull();
    expect(buildSeed(form({ kind: 'arns', arns: ['arn:a', 'arn:a', 'nope'] }))).toEqual({ kind: 'arns', arns: ['arn:a'] });
    const many = Array.from({ length: 61 }, (_, i) => `arn:x:${i}`);
    expect(buildSeed(form({ kind: 'arns', arns: many }))).toBeNull();
  });
  it('adds an ARN once and stops at 60', () => {
    expect(addArn(['arn:a'], 'arn:a')).toEqual(['arn:a']);
    expect(addArn(['arn:a'], 'arn:b')).toEqual(['arn:a', 'arn:b']);
    const full = Array.from({ length: 60 }, (_, i) => `arn:x:${i}`);
    expect(addArn(full, 'arn:new')).toHaveLength(60);
  });
  it('gives order-free keys for ARN seeds', () => {
    expect(seedKey({ kind: 'arns', arns: ['arn:b', 'arn:a'] })).toBe(seedKey({ kind: 'arns', arns: ['arn:a', 'arn:b'] }));
    expect(seedKey(null)).toBe('');
  });
  it('describes seeds for the job list', () => {
    expect(seedLabel({ kind: 'tag', key: 'Project', value: 'shop' }, t)).toBe('태그 Project=shop');
    expect(seedLabel({ kind: 'vpc', arn: 'arn:aws:ec2:r:1:vpc/vpc-0ab' }, t)).toBe('VPC vpc-0ab');
    expect(seedLabel({ kind: 'arns', arns: ['arn:a', 'arn:b'] }, t)).toBe('개별 2개');
    expect(arnTail('arn:aws:iam::1:role/x')).toBe('x');
    expect(arnTail('arn:aws:s3:::bucket')).toBe('bucket');
  });
});

describe('files / urls / account / text', () => {
  it('hides zips and spots secret variables', () => {
    expect(viewableFiles(['providers.tf', 'lambda-placeholder.zip', 'README.md'])).toEqual(['providers.tf', 'README.md']);
    expect(viewableFiles(undefined)).toEqual([]);
    expect(hasSecretVars(['terraform.tfvars.example'])).toBe(true);
    expect(hasSecretVars(['main.tf'])).toBe(false);
  });
  it('builds /api URLs', () => {
    expect(downloadUrl('20261029-153012-a1b2c3')).toBe('/api/terraform-export?op=download&id=20261029-153012-a1b2c3');
    expect(fileUrl('j', 'network.tf')).toBe('/api/terraform-export?op=file&id=j&name=network.tf');
  });
  it('needs one account', () => {
    expect(effectiveAccount('111111111111', [])).toBe('111111111111');
    expect(effectiveAccount('__all__', [{ accountId: '111111111111' }])).toBe('111111111111');
    expect(effectiveAccount('__all__', [{ accountId: '111111111111' }, { accountId: '222222222222' }])).toBeNull();
    expect(effectiveAccount('__all__', [])).toBeNull();
  });
  it('splits backtick code parts', () => {
    expect(splitCode('a `plan` b')).toEqual([{ code: false, text: 'a ' }, { code: true, text: 'plan' }, { code: false, text: ' b' }]);
  });
  it('formats elapsed time and kinds', () => {
    expect(elapsed('2026-10-29T06:00:00Z', '2026-10-29T06:02:05Z', t)).toBe('2분 5초');
    expect(elapsed('2026-10-29T06:00:00Z', '2026-10-29T06:00:09Z', t)).toBe('9초');
    expect(elapsed('bad', undefined, t)).toBe('');
    expect(typeLabel('listener', t)).toBe('로드밸런서 리스너');
    expect(typeLabel('subnet', t)).toBe('서브넷');
  });
});

describe('tfExport i18n parity', () => {
  const pick = (k: string) => k.startsWith('tfExport.') || k === 'sidebar.tfExport';
  const keys = Object.keys(ko).filter(pick);
  it('has tfExport keys in ko.json', () => {
    expect(keys.length).toBeGreaterThan(80);
    expect(keys).toContain('sidebar.tfExport');
    expect(keys).toContain('tfExport.caution');
  });
  it('every ko key exists in en and zh, and no extra keys there', () => {
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy();
      expect(zh[k], `zh ${k}`).toBeTruthy();
    }
    expect(Object.keys(en).filter((k) => pick(k) && !(k in ko))).toEqual([]);
    expect(Object.keys(zh).filter((k) => pick(k) && !(k in ko))).toEqual([]);
  });
  it('keeps the same {placeholders} in every language', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const k of keys) {
      expect(ph(en[k]), `en ${k}`).toBe(ph(ko[k]));
      expect(ph(zh[k]), `zh ${k}`).toBe(ph(ko[k]));
    }
  });
  it('uses the agreed wording', () => {
    expect(ko['tfExport.caution']).toBe('이 코드는 지금 AWS 상태를 그대로 옮긴 거예요. `plan`에서 바꿀 것이 0개인지 꼭 확인한 뒤에만 `apply`하세요.');
    expect(ko['tfExport.result.changeMe']).toBe('비밀 값은 CHANGE_ME로 바뀌어 있어요. 채운 뒤에 plan을 돌리세요.');
    expect(ko['tfExport.notInstalled']).toBe('설치가 필요해요: scripts/18-setup-terraform.sh');
    expect(ko['sidebar.tfExport']).toBe('Terraform 코드 변환');
  });
});
