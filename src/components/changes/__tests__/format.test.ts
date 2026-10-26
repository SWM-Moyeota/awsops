import { describe, it, expect } from 'vitest';
import {
  consoleUrl, groupByKstDay, kstDateTime, kstDayLabel, kstTime, resourceEmoji, resourceTypeLabel, sentence,
  summarySentence, toolLabel, withObject, withSubject,
} from '../format';
import type { ChangeRecord } from '@/lib/change-timeline/types';

const rec = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  id: 'e1:0', eventId: 'e1', eventName: 'CreateBucket', accountId: '111111111111', region: 'ap-northeast-2',
  time: '2026-10-26T05:02:00Z', kind: 'create', resourceType: 's3-bucket', resourceId: 'moyeota-logs-2026',
  resourceName: 'moyeota-logs-2026', actor: { kind: 'person', name: 'sungyoon' }, tool: 'console', ...over,
});

describe('sentenceParticles', () => {
  it('uses 을 after a final consonant and 를 without one', () => {
    expect(sentence(rec())).toEqual({ who: 'sungyoon', rest: '님이 S3 버킷을 만들었어요' });
    expect(sentence(rec({ kind: 'delete', resourceType: 'security-group' })).rest).toBe('님이 보안그룹을 지웠어요');
    expect(sentence(rec({ resourceType: 'lambda-function' })).rest).toBe('님이 Lambda 함수를 만들었어요');
    expect(sentence(rec({ kind: 'delete', resourceType: 'ec2-instance' })).rest).toBe('님이 EC2 서버를 지웠어요');
    expect(sentence(rec({ resourceType: 'vpc' })).rest).toBe('님이 VPC를 만들었어요');
  });
  it('uses 이/가 for auto and AWSops rows', () => {
    const cdk = rec({ resourceType: 'security-group', actor: { kind: 'auto', name: 'CloudFormation (CDK)' } });
    expect(sentence(cdk)).toEqual({ who: 'CloudFormation (CDK)', rest: '이 보안그룹을 만들었어요' });
    expect(sentence(rec({ actor: { kind: 'auto', name: 'Auto Scaling' }, resourceType: 'ec2-instance' })).rest)
      .toBe('이 EC2 서버를 만들었어요');
    expect(sentence(rec({ actor: { kind: 'auto', name: 'ECS' } })).rest).toBe('가 S3 버킷을 만들었어요');
    expect(sentence(rec({ actor: { kind: 'awsops', name: 'AWSops' } })).rest).toBe('가 S3 버킷을 만들었어요');
  });
  it('marks root rows with a warning', () => {
    expect(sentence(rec({ actor: { kind: 'root', name: '루트 계정' } }))).toEqual({ who: '루트 계정', rest: '이 S3 버킷을 만들었어요 ⚠️' });
  });
  it('picks particles for Hangul, digits and acronyms', () => {
    expect(withObject('서버')).toBe('서버를');
    expect(withObject('보안그룹')).toBe('보안그룹을');
    expect(withSubject('EKS')).toBe('EKS가');
    expect(withSubject('Terraform')).toBe('Terraform이');
    expect(withSubject('app1')).toBe('app1이');
    expect(withSubject('app2')).toBe('app2가');
  });
});

describe('summarySentenceRanges', () => {
  it('names the range and both counts', () => {
    expect(summarySentence({ creates: 4, deletes: 1, people: 3 }, '7d')).toBe('이번 주에 4개가 생기고 1개가 사라졌어요');
    expect(summarySentence({ creates: 2, deletes: 3, people: 1 }, '24h')).toBe('오늘 2개가 생기고 3개가 사라졌어요');
    expect(summarySentence({ creates: 1, deletes: 1, people: 1 }, '30d')).toBe('이번 달에 1개가 생기고 1개가 사라졌어요');
  });
  it('drops the empty half', () => {
    expect(summarySentence({ creates: 5, deletes: 0, people: 1 }, '90d')).toBe('최근 90일 동안 5개가 생겼어요');
    expect(summarySentence({ creates: 0, deletes: 2, people: 1 }, 'all')).toBe('지금까지 2개가 사라졌어요');
  });
  it('says nothing changed', () => {
    expect(summarySentence({ creates: 0, deletes: 0, people: 0 }, '7d')).toBe('이번 주에 생기거나 사라진 리소스가 없어요');
    expect(summarySentence({ creates: 0, deletes: 0, people: 0 }, 'all')).toBe('지금까지 생기거나 사라진 리소스가 없어요');
  });
});

describe('kstTimeAmPm', () => {
  it('formats KST with 오전/오후', () => {
    expect(kstTime('2026-10-26T05:02:00Z')).toBe('오후 2:02');
    expect(kstTime('2026-10-26T02:40:00Z')).toBe('오전 11:40');
    expect(kstTime('2026-10-25T15:05:00Z')).toBe('오전 12:05');
    expect(kstTime('2026-10-26T03:00:00Z')).toBe('오후 12:00');
  });
  it('returns an empty string for bad input', () => {
    expect(kstTime('nope')).toBe('');
  });
  it('formats the full KST date', () => {
    expect(kstDateTime('2026-10-26T05:02:00Z')).toBe('2026년 10월 26일 오후 2:02');
  });
});

describe('dayLabelTodayYesterday', () => {
  const now = new Date('2026-10-26T06:00:00Z'); // 오후 3시 KST
  it('labels today and yesterday in KST', () => {
    expect(kstDayLabel('2026-10-26T05:02:00Z', now)).toBe('오늘 · 10월 26일');
    expect(kstDayLabel('2026-10-25T13:15:00Z', now)).toBe('어제 · 10월 25일');
    expect(kstDayLabel('2026-10-24T01:00:00Z', now)).toBe('10월 24일');
  });
  it('uses the KST day boundary, not UTC', () => {
    // 2026-10-25T15:30Z is 10월 26일 00:30 KST.
    expect(kstDayLabel('2026-10-25T15:30:00Z', now)).toBe('오늘 · 10월 26일');
  });
  it('adds the year for another year', () => {
    expect(kstDayLabel('2025-12-31T01:00:00Z', now)).toBe('2025년 12월 31일');
  });
  it('groups records by KST day in order', () => {
    const groups = groupByKstDay([
      rec({ id: 'a', time: '2026-10-26T05:02:00Z' }),
      rec({ id: 'b', time: '2026-10-25T15:30:00Z' }),
      rec({ id: 'c', time: '2026-10-25T13:15:00Z' }),
    ], now);
    expect(groups.map((g) => g.label)).toEqual(['오늘 · 10월 26일', '어제 · 10월 25일']);
    expect(groups[0].records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(groups[1].records.map((r) => r.id)).toEqual(['c']);
  });
});

describe('toolLabelVia', () => {
  it('maps tools to Korean labels', () => {
    expect(toolLabel('console')).toBe('콘솔');
    expect(toolLabel('cli')).toBe('CLI');
    expect(toolLabel('terraform')).toBe('Terraform');
    expect(toolLabel('sdk')).toBe('SDK');
    expect(toolLabel('autoscaling')).toBe('Auto Scaling');
    expect(toolLabel('other')).toBe('기타');
  });
  it('says "통해" when a service acted on someone\'s behalf', () => {
    expect(toolLabel('console', 'CloudFormation')).toBe('CloudFormation 통해');
    expect(toolLabel('other', 'Auto Scaling')).toBe('Auto Scaling 통해');
  });
  it('does not repeat the service it already is', () => {
    expect(toolLabel('cloudformation', 'CloudFormation')).toBe('CloudFormation');
    expect(toolLabel('autoscaling', 'Auto Scaling')).toBe('Auto Scaling');
  });
});

describe('resourceLabels', () => {
  it('names and decorates resource types', () => {
    expect(resourceTypeLabel('elasticache-replication-group')).toBe('ElastiCache 복제 그룹');
    expect(resourceTypeLabel('iam-role')).toBe('IAM 역할');
    expect(resourceEmoji('s3-bucket')).toBe('🪣');
    expect(resourceEmoji('ebs-snapshot')).toBe('💽');
    expect(resourceEmoji('nat-gateway')).toBe('🌐');
    expect(resourceEmoji('dynamodb-table')).toBe('🗄️');
    expect(resourceEmoji('eks-cluster')).toBe('📦');
    expect(resourceEmoji('iam-user')).toBe('👤');
  });
});

describe('consoleLinks', () => {
  it('links the supported types', () => {
    expect(consoleUrl(rec())).toBe('https://s3.console.aws.amazon.com/s3/buckets/moyeota-logs-2026');
    expect(consoleUrl(rec({ resourceType: 'ec2-instance', resourceId: 'i-0abc' })))
      .toBe('https://ap-northeast-2.console.aws.amazon.com/ec2/home?region=ap-northeast-2#InstanceDetails:instanceId=i-0abc');
    expect(consoleUrl(rec({ resourceType: 'security-group', resourceId: 'sg-01' })))
      .toBe('https://ap-northeast-2.console.aws.amazon.com/ec2/home?region=ap-northeast-2#SecurityGroup:groupId=sg-01');
    expect(consoleUrl(rec({ resourceType: 'rds-instance', resourceId: 'db-1' })))
      .toBe('https://ap-northeast-2.console.aws.amazon.com/rds/home?region=ap-northeast-2#database:id=db-1');
    expect(consoleUrl(rec({ resourceType: 'lambda-function', resourceId: 'fn' })))
      .toBe('https://ap-northeast-2.console.aws.amazon.com/lambda/home?region=ap-northeast-2#/functions/fn');
  });
  it('returns null for other types and unusable ids', () => {
    expect(consoleUrl(rec({ resourceType: 'vpc', resourceId: 'vpc-1' }))).toBeNull();
    expect(consoleUrl(rec({ resourceType: 'security-group', resourceId: 'my-group-name' }))).toBeNull();
  });
  it('encodes ids', () => {
    expect(consoleUrl(rec({ resourceId: 'a b' }))).toBe('https://s3.console.aws.amazon.com/s3/buckets/a%20b');
  });
});
