// Idle/unused resource detection SQL — shared by the idle-scan collector and Cost Radar.
// 유휴/미사용 리소스 탐지 SQL — idle-scan 컬렉터와 비용 레이더가 함께 사용.

export const SQL_UNATTACHED_EBS = `
SELECT volume_id, volume_type, size, create_time, account_id, region
FROM aws_ebs_volume
WHERE state = 'available'
ORDER BY size DESC`;

export const SQL_GP2_VOLUMES = `
SELECT volume_id, volume_type, size, iops, account_id, region
FROM aws_ebs_volume
WHERE volume_type = 'gp2'`;

export const SQL_UNASSOCIATED_EIPS = `
SELECT allocation_id, public_ip, account_id, region
FROM aws_vpc_eip
WHERE association_id IS NULL`;

export const SQL_STOPPED_INSTANCES = `
SELECT instance_id, instance_type, launch_time, instance_state, account_id, region,
  tags ->> 'Name' as name
FROM aws_ec2_instance
WHERE instance_state = 'stopped'`;

export const SQL_OLD_SNAPSHOTS = `
SELECT snapshot_id, volume_id, volume_size, start_time, account_id, region
FROM aws_ebs_snapshot
WHERE start_time < NOW() - INTERVAL '90 days'
ORDER BY volume_size DESC
LIMIT 50`;

export const SQL_UNUSED_SECURITY_GROUPS = `
SELECT group_id, group_name, vpc_id, account_id, region
FROM aws_vpc_security_group
WHERE group_name != 'default'
  AND group_id NOT IN (
    SELECT DISTINCT unnest(security_groups)
    FROM aws_ec2_network_interface
    WHERE security_groups IS NOT NULL
  )`;
