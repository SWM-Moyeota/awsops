// Change timeline — fixed list of tracked CloudTrail events (spec §4).
// 변경 기록 — 수집 대상 CloudTrail 이벤트 고정 목록. 목록에 없는 이벤트는 저장하지 않는다.
import type { ChangeKind, ResourceType, TrackedEvent, TrackedRegion } from './types';

const AP: TrackedRegion = 'ap-northeast-2';
const US: TrackedRegion = 'us-east-1';

function pair(source: string, type: ResourceType, create: string, del: string, region: TrackedRegion = AP): TrackedEvent[] {
  const mk = (eventName: string, kind: ChangeKind): TrackedEvent => ({ eventName, eventSource: source, kind, resourceType: type, region });
  return [mk(create, 'create'), mk(del, 'delete')];
}

export const TRACKED: TrackedEvent[] = [
  ...pair('s3.amazonaws.com', 's3-bucket', 'CreateBucket', 'DeleteBucket'),
  ...pair('ec2.amazonaws.com', 'ec2-instance', 'RunInstances', 'TerminateInstances'),
  ...pair('ec2.amazonaws.com', 'ebs-volume', 'CreateVolume', 'DeleteVolume'),
  ...pair('ec2.amazonaws.com', 'ebs-snapshot', 'CreateSnapshot', 'DeleteSnapshot'),
  ...pair('ec2.amazonaws.com', 'security-group', 'CreateSecurityGroup', 'DeleteSecurityGroup'),
  ...pair('ec2.amazonaws.com', 'elastic-ip', 'AllocateAddress', 'ReleaseAddress'),
  ...pair('ec2.amazonaws.com', 'nat-gateway', 'CreateNatGateway', 'DeleteNatGateway'),
  ...pair('ec2.amazonaws.com', 'vpc', 'CreateVpc', 'DeleteVpc'),
  ...pair('ec2.amazonaws.com', 'subnet', 'CreateSubnet', 'DeleteSubnet'),
  ...pair('elasticloadbalancing.amazonaws.com', 'load-balancer', 'CreateLoadBalancer', 'DeleteLoadBalancer'),
  ...pair('elasticloadbalancing.amazonaws.com', 'target-group', 'CreateTargetGroup', 'DeleteTargetGroup'),
  ...pair('rds.amazonaws.com', 'rds-instance', 'CreateDBInstance', 'DeleteDBInstance'),
  ...pair('rds.amazonaws.com', 'rds-cluster', 'CreateDBCluster', 'DeleteDBCluster'),
  ...pair('elasticache.amazonaws.com', 'elasticache-cluster', 'CreateCacheCluster', 'DeleteCacheCluster'),
  ...pair('elasticache.amazonaws.com', 'elasticache-replication-group', 'CreateReplicationGroup', 'DeleteReplicationGroup'),
  ...pair('elasticache.amazonaws.com', 'elasticache-serverless', 'CreateServerlessCache', 'DeleteServerlessCache'),
  ...pair('lambda.amazonaws.com', 'lambda-function', 'CreateFunction20150331', 'DeleteFunction20150331'),
  ...pair('ecr.amazonaws.com', 'ecr-repository', 'CreateRepository', 'DeleteRepository'),
  ...pair('ecs.amazonaws.com', 'ecs-cluster', 'CreateCluster', 'DeleteCluster'),
  ...pair('ecs.amazonaws.com', 'ecs-service', 'CreateService', 'DeleteService'),
  ...pair('eks.amazonaws.com', 'eks-cluster', 'CreateCluster', 'DeleteCluster'),
  ...pair('dynamodb.amazonaws.com', 'dynamodb-table', 'CreateTable', 'DeleteTable'),
  ...pair('iam.amazonaws.com', 'iam-user', 'CreateUser', 'DeleteUser', US),
  ...pair('iam.amazonaws.com', 'iam-role', 'CreateRole', 'DeleteRole', US),
];

const INDEX = new Map<string, TrackedEvent>(TRACKED.map((t) => [`${t.eventSource}|${t.eventName}`, t]));

export function findTracked(eventName: string, eventSource: string): TrackedEvent | undefined {
  return INDEX.get(`${eventSource}|${eventName}`);
}

export function eventNamesFor(region: TrackedRegion): string[] {
  return Array.from(new Set(TRACKED.filter((t) => t.region === region).map((t) => t.eventName)));
}
