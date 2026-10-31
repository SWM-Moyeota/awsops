// Synthetic rows only, no real account data / 합성 행만 사용, 실제 계정 데이터 없음
import type { DiagramRows, Row } from '../types';

const VPC = 'vpc-0a1b2c3d4e5f60718';
const subnet = (id: string, name: string, cidr: string, az: string): Row => ({ account_id: '111122223333', vpc_id: VPC, vpc_cidr: '10.0.0.0/16', vpc_name: 'demo-vpc', subnet_id: id, subnet_cidr: cidr, availability_zone: az, subnet_name: name });
const inst = (id: string, name: string, sid: string, extra: Row = {}): Row => ({ instance_id: id, name, vpc_id: VPC, subnet_id: sid, instance_type: 't3.medium', instance_state: 'running', private_ip_address: `10.0.9.${id.length}`, public_ip_address: null, eks_cluster: null, asg_name: null, ...extra });
const route = (extra: Row) => ({ DestinationCidrBlock: '0.0.0.0/0', GatewayId: null, NatGatewayId: null, ...extra });

// Two AZs, ALB + NLB, ASGs, Multi-AZ RDS, cache, Lambda and account services / 2개 AZ, ALB+NLB, ASG, Multi-AZ RDS, 캐시, Lambda, 계정 서비스
export function bigRows(): DiagramRows {
  return {
    vpcSubnets: [
      subnet('subnet-pub-a', 'demo/PublicA', '10.0.0.0/24', 'ap-northeast-2a'),
      subnet('subnet-pub-c', 'demo/PublicC', '10.0.1.0/24', 'ap-northeast-2c'),
      subnet('subnet-app-a', 'demo/AppA', '10.0.10.0/24', 'ap-northeast-2a'),
      subnet('subnet-app-c', 'demo/AppC', '10.0.11.0/24', 'ap-northeast-2c'),
      subnet('subnet-db-a', 'demo/DbA', '10.0.20.0/24', 'ap-northeast-2a'),
      subnet('subnet-db-c', 'demo/DbC', '10.0.21.0/24', 'ap-northeast-2c'),
      subnet('subnet-empty', 'demo/Unused', '10.0.99.0/24', 'ap-northeast-2c'),
    ],
    ec2: [
      inst('i-bastion0a', 'bastion', 'subnet-pub-a', { public_ip_address: '203.0.113.10' }),
      inst('i-web00000a', 'web-1', 'subnet-app-a', { asg_name: 'web-asg' }),
      inst('i-web00001a', 'web-2', 'subnet-app-a', { asg_name: 'web-asg' }),
      inst('i-web00000c', 'web-3', 'subnet-app-c', { asg_name: 'web-asg' }),
      inst('i-api00000a', 'api-server-with-a-very-long-name-for-wrapping', 'subnet-app-a'),
      inst('i-api00000c', 'api-2', 'subnet-app-c', { instance_state: 'stopped' }),
      inst('i-gone', 'gone', 'subnet-app-c', { instance_state: 'terminated' }),
    ],
    elb: [
      { arn: 'arn:alb', elb_name: 'demo-alb', type: 'application', scheme: 'internet-facing', vpc_id: VPC, dns_name: 'demo-alb.elb.example.com', availability_zones: [{ SubnetId: 'subnet-pub-a' }, { SubnetId: 'subnet-pub-c' }] },
      { arn: 'arn:nlb', elb_name: 'demo-nlb', type: 'network', scheme: 'internal', vpc_id: VPC, dns_name: 'demo-nlb.elb.example.com', availability_zones: [{ SubnetId: 'subnet-app-a' }, { SubnetId: 'subnet-app-c' }] },
    ],
    nat: [
      { nat_gateway_id: 'nat-a', vpc_id: VPC, subnet_id: 'subnet-pub-a', state: 'available', name: null },
      { nat_gateway_id: 'nat-c', vpc_id: VPC, subnet_id: 'subnet-pub-c', state: 'available', name: null },
    ],
    igw: [{ internet_gateway_id: 'igw-demo', vpc_id: VPC, name: 'demo-igw' }],
    routeTables: [
      { vpc_id: VPC, associations: [{ SubnetId: 'subnet-pub-a' }, { SubnetId: 'subnet-pub-c' }], routes: [route({ GatewayId: 'igw-demo' })] },
      { vpc_id: VPC, associations: [{ SubnetId: 'subnet-app-a' }, { SubnetId: 'subnet-db-a' }], routes: [route({ NatGatewayId: 'nat-a' })] },
      { vpc_id: VPC, associations: [{ SubnetId: 'subnet-app-c' }, { SubnetId: 'subnet-db-c' }], routes: [route({ NatGatewayId: 'nat-c' })] },
      { vpc_id: VPC, associations: [{ Main: true }], routes: [{ GatewayId: 'local', DestinationCidrBlock: '10.0.0.0/16' }] },
    ],
    targetGroups: [
      { vpc_id: VPC, load_balancer_arns: ['arn:alb'], target_health_descriptions: [{ Target: { Id: 'i-web00000a' } }, { Target: { Id: 'i-web00001a' } }, { Target: { Id: 'i-web00000c' } }] },
      { vpc_id: VPC, load_balancer_arns: ['arn:nlb'], target_health_descriptions: [{ Target: { Id: 'i-api00000a' } }, { Target: { Id: 'i-api00000c' } }] },
    ],
    rds: [{ db_instance_identifier: 'demo-mysql', engine: 'mysql', db_instance_class: 'db.r6g.large', vpc_id: VPC, availability_zone: 'ap-northeast-2a', multi_az: true, secondary_availability_zone: 'ap-northeast-2c', status: 'available', subnets: [{ SubnetIdentifier: 'subnet-db-a' }, { SubnetIdentifier: 'subnet-db-c' }] }],
    elasticache: [{ cache_cluster_id: 'demo-redis-001', engine: 'redis', availability_zone: 'ap-northeast-2c', vpc_id: VPC }],
    lambda: [{ name: 'demo-worker', runtime: 'python3.12', vpc_id: VPC, vpc_subnet_ids: ['subnet-app-a', 'subnet-app-c'] }],
    msk: [{ cluster_name: 'other-vpc-kafka', state: 'ACTIVE', client_subnets: ['subnet-elsewhere'] }],
    opensearch: [],
    endpoints: [{ vpc_id: VPC, service_name: 's3' }, { vpc_id: VPC, service_name: 'ssm' }],
    tgw: [],
    s3: [{ name: 'a' }, { name: 'b' }],
    dynamodb: [],
    cloudfront: [
      { id: 'E1', domain_name: 'd1.cloudfront.net', aliases: { Items: ['www.example.com'] }, origins: [{ DomainName: 'demo-alb.elb.example.com' }] },
      { id: 'E2', domain_name: 'd2.cloudfront.net', aliases: { Items: null }, origins: [{ DomainName: 'bucket.s3.amazonaws.com' }] },
    ],
    route53: [{ name: 'example.com.' }],
  };
}

export const DEMO_VPC = VPC;
