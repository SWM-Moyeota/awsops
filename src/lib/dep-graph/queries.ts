// Read-only Steampipe queries for the dependency graph (run through batchQuery).
// 의존성 그래프용 읽기 전용 쿼리. JSONB는 TS에서 파싱한다. Lambda tags와 `$`는 쓰지 않는다.
import type { QueryName } from './types';

export const GRAPH_QUERIES: Record<QueryName, string> = {
  vpc: `SELECT arn, vpc_id, cidr_block, is_default, tags, account_id, region FROM aws_vpc`,
  subnet: `SELECT subnet_arn, subnet_id, vpc_id, cidr_block, availability_zone, tags, account_id, region FROM aws_vpc_subnet`,
  eni: `SELECT network_interface_id, partition, description, interface_type, status, requester_managed, private_ip_address, attached_instance_id, subnet_id, vpc_id, groups, tags, account_id, region FROM aws_ec2_network_interface`,
  instance: `SELECT arn, instance_id, instance_state, instance_type, private_ip_address, subnet_id, vpc_id, security_groups, iam_instance_profile_arn, tags, account_id, region FROM aws_ec2_instance`,
  sg: `SELECT arn, group_id, group_name, vpc_id, tags, account_id, region FROM aws_vpc_security_group`,
  sgRule: `SELECT group_id, is_egress, referenced_group_id, account_id, region FROM aws_vpc_security_group_rule`,
  alb: `SELECT arn, name, type, scheme, dns_name, vpc_id, availability_zones, security_groups, tags, account_id, region FROM aws_ec2_application_load_balancer`,
  nlb: `SELECT arn, name, type, scheme, dns_name, vpc_id, availability_zones, security_groups, tags, account_id, region FROM aws_ec2_network_load_balancer`,
  clb: `SELECT arn, name, scheme, dns_name, vpc_id, subnets, security_groups, tags, account_id, region FROM aws_ec2_classic_load_balancer`,
  tg: `SELECT target_group_arn, target_group_name, target_type, port, protocol, vpc_id, load_balancer_arns, target_health_descriptions, tags, account_id, region FROM aws_ec2_target_group`,
  rds: `SELECT arn, db_instance_identifier, engine, class, status, vpc_id, subnets, vpc_security_groups, tags, account_id, region FROM aws_rds_db_instance`,
  lambda: `SELECT arn, name, role, runtime, state, vpc_id, vpc_subnet_ids, vpc_security_group_ids, account_id, region FROM aws_lambda_function`,
  role: `SELECT arn, name, path, instance_profile_arns, tags, account_id, region FROM aws_iam_role`,
  // Policies apart from roles: if this read fails (SCP on attached_policy_arns), roles and uses_role stay.
  // 정책은 역할과 따로 읽는다 — 실패해도(SCP) 역할 노드와 uses_role은 남는다.
  rolePolicy: `SELECT arn, account_id, region, inline_policies_std, attached_policy_arns FROM aws_iam_role`,
  policy: `SELECT arn, account_id, region, policy_std FROM aws_iam_policy WHERE is_aws_managed = false`,
  nat: `SELECT arn, nat_gateway_id, state, vpc_id, subnet_id, nat_gateway_addresses, tags, account_id, region FROM aws_vpc_nat_gateway`,
  eip: `SELECT arn, allocation_id, public_ip, network_interface_id, instance_id, tags, account_id, region FROM aws_vpc_eip`,
  ebs: `SELECT arn, volume_id, size, volume_type, state, attachments, tags, account_id, region FROM aws_ebs_volume`,
  s3: `SELECT arn, name, event_notification_configuration, tags, account_id, region FROM aws_s3_bucket`,
  cloudfront: `SELECT arn, id, partition, domain_name, aliases, enabled, origins, tags, account_id, region FROM aws_cloudfront_distribution`,
};
