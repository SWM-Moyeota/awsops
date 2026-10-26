import { describe, it, expect } from 'vitest';
import { TRACKED, findTracked, eventNamesFor } from '../catalog';
import { toRecords, classifyActor, detectTool } from '../parse';
import createBucket from './fixtures/CreateBucket.json';
import runInstances from './fixtures/RunInstances.json';
import createSg from './fixtures/CreateSecurityGroup.json';
import createDb from './fixtures/CreateDBInstance.json';

const ACCT = '111122223333';
const clone = <T,>(o: T): any => JSON.parse(JSON.stringify(o));

function threeInstances() {
  const ev = clone(runInstances);
  const tpl = ev.responseElements.instancesSet.items[0];
  ev.eventID = 'evt-3';
  ev.responseElements.instancesSet.items = ['a', 'b', 'c'].map((s, i) => ({
    ...clone(tpl),
    instanceId: `i-0000000000000000${i}`,
    tagSet: { items: [{ key: 'Name', value: `web-${s}` }] },
  }));
  return ev;
}

describe('catalog', () => {
  it('findsTrackedByNameAndSource', () => {
    expect(findTracked('CreateBucket', 's3.amazonaws.com')?.resourceType).toBe('s3-bucket');
    expect(findTracked('CreateBucket', 'ec2.amazonaws.com')).toBeUndefined();
  });
  it('eventNamesForIsUniqueAndRegionScoped', () => {
    const us = eventNamesFor('us-east-1');
    expect(us.sort()).toEqual(['CreateRole', 'CreateUser', 'DeleteRole', 'DeleteUser']);
    const ap = eventNamesFor('ap-northeast-2');
    expect(new Set(ap).size).toBe(ap.length);
    expect(ap).toContain('CreateCluster');
    expect(ap).not.toContain('CreateUser');
    expect(TRACKED.length).toBeGreaterThan(40);
  });
});

describe('toRecords', () => {
  it('runInstancesYieldsOneRecordPerInstance', () => {
    const recs = toRecords(threeInstances(), ACCT);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.id)).toEqual(['evt-3:0', 'evt-3:1', 'evt-3:2']);
    expect(recs.map((r) => r.resourceName)).toEqual(['web-a', 'web-b', 'web-c']);
    expect(recs[0].kind).toBe('create');
    expect(recs[0].resourceType).toBe('ec2-instance');
  });
  it('singleInstanceNameFromTagSet', () => {
    const recs = toRecords(runInstances, ACCT);
    expect(recs).toHaveLength(1);
    expect(recs[0].resourceId).toMatch(/^i-/);
    expect(recs[0].resourceName).toBe('moyeota-osrm');
    expect(recs[0].sourceIp).toBe('203.0.113.10');
    expect(recs[0].tool).toBe('console');
  });
  it('instanceNameFallsBackToRequestTags', () => {
    const ev = clone(runInstances);
    for (const it of ev.responseElements.instancesSet.items) delete it.tagSet;
    expect(toRecords(ev, ACCT)[0].resourceName).toBe('moyeota-osrm');
  });
  it('bucketNameFromRequest', () => {
    const [r] = toRecords(createBucket, ACCT);
    expect(r.resourceType).toBe('s3-bucket');
    expect(r.resourceId).toBe('moyeota-media');
    expect(r.resourceName).toBe('moyeota-media');
    expect(r.actor).toEqual({ kind: 'person', name: 'tjdgns9954' });
    expect(r.id).toBe(`${r.eventId}:0`);
    expect(r.accountId).toBe(ACCT);
    expect(r.region).toBe('ap-northeast-2');
  });
  it('securityGroupAndRdsIds', () => {
    const [sg] = toRecords(createSg, ACCT);
    expect(sg.resourceId).toMatch(/^sg-/);
    expect(sg.resourceType).toBe('security-group');
    const [db] = toRecords(createDb, ACCT);
    expect(db.resourceId).toBe('moyeota-prod');
    expect(db.resourceType).toBe('rds-instance');
  });
  it('terminateInstancesYieldsDeletes', () => {
    const ev = {
      eventID: 'evt-t', eventName: 'TerminateInstances', eventSource: 'ec2.amazonaws.com', awsRegion: 'ap-northeast-2',
      eventTime: '2026-10-20T00:00:00Z', userIdentity: { type: 'IAMUser', userName: 'jiwoo' },
      requestParameters: { instancesSet: { items: [{ instanceId: 'i-1' }, { instanceId: 'i-2' }] } },
    };
    const recs = toRecords(ev, ACCT);
    expect(recs.map((r) => r.resourceId)).toEqual(['i-1', 'i-2']);
    expect(recs.every((r) => r.kind === 'delete')).toBe(true);
  });
  it('iamUserViaCloudFormationKeepsPerson', () => {
    const ev = clone(createSg);
    ev.userIdentity.invokedBy = 'cloudformation.amazonaws.com';
    ev.userAgent = 'cloudformation.amazonaws.com';
    const [r] = toRecords(ev, ACCT);
    expect(r.actor).toEqual({ kind: 'person', name: 'sungyoon' });
    expect(r.via).toBe('CloudFormation');
    expect(r.tool).toBe('cloudformation');
  });
  it('serviceLinkedRoleIsAuto', () => {
    const ev = clone(createSg);
    ev.userIdentity = {
      type: 'AssumedRole',
      arn: 'arn:aws:sts::111122223333:assumed-role/AWSServiceRoleForAutoScaling/AutoScaling',
      sessionContext: { sessionIssuer: { type: 'Role', userName: 'AWSServiceRoleForAutoScaling' } },
    };
    const [r] = toRecords(ev, ACCT);
    expect(r.actor).toEqual({ kind: 'auto', name: 'Auto Scaling' });
  });
  it('cdkExecRoleIsAuto', () => {
    const ev = clone(createSg);
    ev.userIdentity = {
      type: 'AssumedRole',
      arn: 'arn:aws:sts::111122223333:assumed-role/cdk-hnb659fds-cfn-exec-role-111122223333-ap-northeast-2/AWSCloudFormation',
      sessionContext: { sessionIssuer: { type: 'Role', userName: 'cdk-hnb659fds-cfn-exec-role-111122223333-ap-northeast-2' } },
    };
    expect(toRecords(ev, ACCT)[0].actor).toEqual({ kind: 'auto', name: 'CloudFormation (CDK)' });
  });
  it('awsopsRoleKeepsSourceIdentity', () => {
    const ev = clone(createSg);
    ev.userIdentity = {
      type: 'AssumedRole',
      arn: 'arn:aws:sts::111122223333:assumed-role/AWSopsSlackControlRole/slack-ctl',
      sessionContext: { sourceIdentity: 'slack-sungyoon', sessionIssuer: { type: 'Role', userName: 'AWSopsSlackControlRole' } },
    };
    expect(toRecords(ev, ACCT)[0].actor).toEqual({ kind: 'awsops', name: 'AWSops', sourceIdentity: 'slack-sungyoon' });
    ev.userIdentity.sessionContext.sourceIdentity = undefined;
    ev.userIdentity.sessionContext.sessionIssuer.userName = 'awsops-ec2-role';
    expect(toRecords(ev, ACCT)[0].actor).toEqual({ kind: 'awsops', name: 'AWSops' });
  });
  it('rootIsRoot', () => {
    const ev = clone(createSg);
    ev.userIdentity = { type: 'Root', arn: 'arn:aws:iam::111122223333:root' };
    expect(toRecords(ev, ACCT)[0].actor).toEqual({ kind: 'root', name: '루트 계정' });
  });
  it('untrackedEventYieldsNothing', () => {
    const ev = clone(createSg);
    ev.eventName = 'CreateLogStream';
    expect(toRecords(ev, ACCT)).toEqual([]);
  });
  it('oddPayloadsNeverThrow', () => {
    for (const x of [null, undefined, 42, 'x', [], {}, { eventName: 'CreateBucket' }, { eventName: 'RunInstances', eventSource: 'ec2.amazonaws.com', userIdentity: 5 }]) {
      expect(() => toRecords(x, ACCT)).not.toThrow();
    }
    expect(toRecords({ eventName: 'RunInstances', eventSource: 'ec2.amazonaws.com', responseElements: {} }, ACCT)).toEqual([]);
  });
  it('ecsVsEksClusterBySource', () => {
    const base = { eventID: 'c1', eventName: 'CreateCluster', awsRegion: 'ap-northeast-2', eventTime: '2026-10-20T00:00:00Z',
      userIdentity: { type: 'IAMUser', userName: 'jiwoo' } };
    const ecs = toRecords({ ...base, eventSource: 'ecs.amazonaws.com', requestParameters: { clusterName: 'c-ecs' } }, ACCT);
    const eks = toRecords({ ...base, eventSource: 'eks.amazonaws.com', requestParameters: { name: 'c-eks' } }, ACCT);
    expect(ecs[0].resourceType).toBe('ecs-cluster');
    expect(ecs[0].resourceId).toBe('c-ecs');
    expect(eks[0].resourceType).toBe('eks-cluster');
    expect(eks[0].resourceId).toBe('c-eks');
  });
  it('loadBalancerNameFromArn', () => {
    const ev = { eventID: 'l1', eventName: 'DeleteLoadBalancer', eventSource: 'elasticloadbalancing.amazonaws.com', awsRegion: 'ap-northeast-2',
      eventTime: '2026-10-20T00:00:00Z', userIdentity: { type: 'IAMUser', userName: 'jiwoo' },
      requestParameters: { loadBalancerArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/my-alb/abc123' } };
    const [r] = toRecords(ev, ACCT);
    expect(r.resourceName).toBe('my-alb');
    expect(r.resourceId).toContain('my-alb');
  });
  it('failedCallMarkedFailed', () => {
    const ev = clone(createBucket);
    ev.errorCode = 'AccessDenied';
    expect(toRecords(ev, ACCT)[0].failed).toBe(true);
    expect(toRecords(createBucket, ACCT)[0].failed).toBeUndefined();
  });
  it('iamEventsAreUsEast1', () => {
    const ev = { eventID: 'u1', eventName: 'CreateUser', eventSource: 'iam.amazonaws.com', awsRegion: 'us-east-1',
      eventTime: '2026-10-20T00:00:00Z', userIdentity: { type: 'Root' }, requestParameters: { userName: 'newbie' } };
    const [r] = toRecords(ev, ACCT);
    expect(r.resourceType).toBe('iam-user');
    expect(r.resourceId).toBe('newbie');
    expect(r.region).toBe('us-east-1');
  });
});

describe('classifyActor', () => {
  it('ssoRoleUsesSessionName', () => {
    const r = classifyActor({
      type: 'AssumedRole',
      arn: 'arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Admin_abc/kim@example.com',
      sessionContext: { sessionIssuer: { userName: 'AWSReservedSSO_Admin_abc' } },
    });
    expect(r.actor).toEqual({ kind: 'person', name: 'kim@example.com' });
  });
  it('otherRoleIsAutoWithSession', () => {
    const r = classifyActor({
      type: 'AssumedRole',
      arn: 'arn:aws:sts::111122223333:assumed-role/my-role/sess1',
      sessionContext: { sessionIssuer: { userName: 'my-role' } },
    });
    expect(r.actor).toEqual({ kind: 'auto', name: 'my-role(sess1)' });
  });
  it('awsServiceTypeIsAuto', () => {
    const r = classifyActor({ type: 'AWSService', invokedBy: 'ecs.amazonaws.com' });
    expect(r.actor.kind).toBe('auto');
    expect(r.actor.name).toBe('ecs');
  });
  it('autoscalingViaForIamUser', () => {
    expect(classifyActor({ type: 'IAMUser', userName: 'x', invokedBy: 'autoscaling.amazonaws.com' }).via).toBe('Auto Scaling');
    expect(classifyActor({ type: 'IAMUser', userName: 'x', invokedBy: 'sagemaker.amazonaws.com' }).via).toBe('sagemaker');
  });
  it('garbageIsAuto', () => {
    expect(classifyActor(undefined).actor.kind).toBe('auto');
    expect(classifyActor('x').actor.kind).toBe('auto');
  });
});

describe('detectTool', () => {
  it('invokedByWins', () => {
    expect(detectTool('aws-cli/2', 'cloudformation.amazonaws.com')).toBe('cloudformation');
    expect(detectTool('Boto3', 'autoscaling.amazonaws.com')).toBe('autoscaling');
  });
  it('console', () => {
    expect(detectTool('console.amazonaws.com', undefined)).toBe('console');
    expect(detectTool('signin.amazonaws.com', undefined)).toBe('console');
    expect(detectTool('AWS Internal', undefined)).toBe('console');
    expect(detectTool('Mozilla/5.0 (Macintosh) Chrome/155', undefined)).toBe('console');
  });
  it('cliTerraformSdkOther', () => {
    expect(detectTool('aws-cli/2.15.0 Python/3.11', undefined)).toBe('cli');
    expect(detectTool('APN/1.0 HashiCorp/1.0 Terraform/1.6 (+https://www.terraform.io) terraform-provider-aws/5', undefined)).toBe('terraform');
    expect(detectTool('Boto3/1.34 md/Botocore', undefined)).toBe('sdk');
    expect(detectTool('aws-sdk-go-v2/1.2', undefined)).toBe('sdk');
    expect(detectTool('aws-sdk-js/3.0', undefined)).toBe('sdk');
    expect(detectTool('curl/8', undefined)).toBe('other');
    expect(detectTool(undefined, undefined)).toBe('other');
  });
});

// ---- stop / start / modify (cost detective) ----
function ev(source: string, name: string, req: unknown, id = 'evt-x') {
  return {
    eventVersion: '1.11', eventTime: '2026-10-20T05:10:17Z', eventSource: source, eventName: name,
    awsRegion: 'ap-northeast-2', sourceIPAddress: '203.0.113.10',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/154.0.0.0 Safari/537.36',
    userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::111122223333:user/sungyoon', accountId: '111122223333', accessKeyId: 'AKIAEXAMPLE', userName: 'sungyoon' },
    requestParameters: req, responseElements: null, eventID: id, recipientAccountId: '111122223333',
  };
}

describe('stop/start/modify', () => {
  it('stopStartYieldOneRecordPerInstance', () => {
    const req = { instancesSet: { items: [{ instanceId: 'i-0aaa' }, { instanceId: 'i-0bbb' }] }, force: false };
    const stop = toRecords(ev('ec2.amazonaws.com', 'StopInstances', req, 'e-stop'), ACCT);
    expect(stop.map((r) => [r.id, r.kind, r.resourceType, r.resourceId])).toEqual([
      ['e-stop:0', 'stop', 'ec2-instance', 'i-0aaa'], ['e-stop:1', 'stop', 'ec2-instance', 'i-0bbb'],
    ]);
    const start = toRecords(ev('ec2.amazonaws.com', 'StartInstances', req, 'e-start'), ACCT);
    expect(start).toHaveLength(2);
    expect(start[0].kind).toBe('start');
  });
  it('modifyInstanceAttributeOnlyForInstanceType', () => {
    const typed = toRecords(ev('ec2.amazonaws.com', 'ModifyInstanceAttribute', { instanceId: 'i-0aaa', instanceType: { value: 'm5.xlarge' } }), ACCT);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ kind: 'modify', resourceType: 'ec2-instance', resourceId: 'i-0aaa' });
    expect(toRecords(ev('ec2.amazonaws.com', 'ModifyInstanceAttribute', { instanceId: 'i-0aaa', disableApiTermination: { value: true } }), ACCT)).toEqual([]);
    expect(toRecords(ev('ec2.amazonaws.com', 'ModifyInstanceAttribute', { instanceId: 'i-0aaa', groupId: ['sg-1'] }), ACCT)).toEqual([]);
  });
  it('rdsStopStartModify', () => {
    const req = { dBInstanceIdentifier: 'moyeota-prod' };
    const kinds = [['StopDBInstance', 'stop'], ['StartDBInstance', 'start'], ['ModifyDBInstance', 'modify']] as const;
    for (const [name, kind] of kinds) {
      const r = toRecords(ev('rds.amazonaws.com', name, req), ACCT);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ kind, resourceType: 'rds-instance', resourceId: 'moyeota-prod' });
    }
  });
  it('modifyVolume', () => {
    const r = toRecords(ev('ec2.amazonaws.com', 'ModifyVolume', { volumeId: 'vol-0abc', size: 200, volumeType: 'gp3' }), ACCT);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'modify', resourceType: 'ebs-volume', resourceId: 'vol-0abc' });
  });
  it('catalogRegions', () => {
    for (const n of ['StopInstances', 'StartInstances', 'ModifyInstanceAttribute']) expect(findTracked(n, 'ec2.amazonaws.com')?.region).toBe('ap-northeast-2');
    expect(eventNamesFor('ap-northeast-2')).toEqual(expect.arrayContaining(['StopDBInstance', 'StartDBInstance', 'ModifyDBInstance', 'ModifyVolume']));
  });
});
