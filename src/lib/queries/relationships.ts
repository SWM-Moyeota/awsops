export const queries = {
  // EC2 -> VPC, Subnet, SGs
  ec2Relations: `
    SELECT
      i.account_id,
      i.instance_id,
      i.instance_type,
      i.instance_state,
      i.vpc_id,
      i.subnet_id,
      i.private_ip_address,
      i.public_ip_address,
      tags ->> 'Name' AS name,
      tags ->> 'aws:eks:cluster-name' AS eks_cluster
    FROM aws_ec2_instance i
    ORDER BY i.vpc_id, i.subnet_id
  `,

  // VPC -> Subnets
  vpcSubnets: `
    SELECT
      v.account_id,
      v.vpc_id,
      v.cidr_block AS vpc_cidr,
      v.tags ->> 'Name' AS vpc_name,
      s.subnet_id,
      s.cidr_block AS subnet_cidr,
      s.availability_zone,
      s.tags ->> 'Name' AS subnet_name
    FROM aws_vpc v
    LEFT JOIN aws_vpc_subnet s ON v.vpc_id = s.vpc_id
    ORDER BY v.vpc_id, s.availability_zone
  `,

  // ELB -> VPC, SGs
  elbRelations: `
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_application_load_balancer
    UNION ALL
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_network_load_balancer
  `,

  // NAT GW -> VPC, Subnet
  natRelations: `
    SELECT account_id, nat_gateway_id, vpc_id, subnet_id, state,
      tags ->> 'Name' AS name
    FROM aws_vpc_nat_gateway
  `,

  // IGW -> VPC
  igwRelations: `
    SELECT
      account_id,
      internet_gateway_id,
      jsonb_array_elements(attachments) ->> 'VpcId' AS vpc_id,
      tags ->> 'Name' AS name
    FROM aws_vpc_internet_gateway
  `,

  // TGW -> Attachments
  tgwRelations: `
    SELECT
      account_id,
      transit_gateway_attachment_id,
      transit_gateway_id,
      resource_id,
      resource_type,
      state,
      tags ->> 'Name' AS name
    FROM aws_ec2_transit_gateway_vpc_attachment
  `,

  // RDS -> VPC, Subnet Group
  rdsRelations: `
    SELECT
      account_id,
      db_instance_identifier,
      engine,
      class AS db_instance_class,
      vpc_id,
      availability_zone,
      endpoint_address
    FROM aws_rds_db_instance
  `,

  // Route tables -> subnet associations, routes (public/private tiering)
  routeTables: `
    SELECT
      account_id,
      route_table_id,
      vpc_id,
      associations,
      routes
    FROM aws_vpc_route_table
  `,

  // Target groups -> ALB target resolution
  targetGroups: `
    SELECT
      account_id,
      target_group_arn,
      target_group_name,
      vpc_id,
      load_balancer_arns,
      target_health_descriptions
    FROM aws_ec2_target_group
  `,

  // ElastiCache clusters -> AZ placement (subnet group carries the VPC)
  elasticache: `
    SELECT
      c.cache_cluster_id,
      c.engine,
      c.preferred_availability_zone AS availability_zone,
      g.vpc_id
    FROM aws_elasticache_cluster c
    JOIN aws_elasticache_subnet_group g
      ON c.cache_subnet_group_name = g.cache_subnet_group_name
  `,

  // MSK clusters -> client subnets
  msk: `
    SELECT
      cluster_name,
      state,
      provisioned -> 'BrokerNodeGroupInfo' -> 'ClientSubnets' AS client_subnets
    FROM aws_msk_cluster
  `,

  // OpenSearch domains (VPC domains carry subnet ids)
  opensearch: `
    SELECT
      domain_name,
      engine_version,
      vpc_options -> 'SubnetIds' AS subnet_ids
    FROM aws_opensearch_domain
  `,

  // VPC-attached Lambda functions
  lambdaVpc: `
    SELECT
      name,
      runtime,
      vpc_id,
      vpc_subnet_ids
    FROM aws_lambda_function
    WHERE vpc_id IS NOT NULL AND vpc_id != ''
  `,

  // VPC endpoints -> VPC boundary placement
  vpcEndpoints: `
    SELECT
      vpc_endpoint_id,
      vpc_id,
      service_name,
      vpc_endpoint_type
    FROM aws_vpc_endpoint
  `,

  // Account-global resources for the external tray (default-off layers)
  s3Buckets: `
    SELECT name, region FROM aws_s3_bucket
  `,
  dynamodbTables: `
    SELECT name FROM aws_dynamodb_table
  `,
  cloudfrontDists: `
    SELECT id, domain_name, aliases FROM aws_cloudfront_distribution
  `,
  route53Zones: `
    SELECT name, private_zone FROM aws_route53_zone
  `,

  // Architecture diagram: instances with their Auto Scaling group / 아키텍처 다이어그램: 오토 스케일링 그룹이 있는 인스턴스
  diagramEc2: `
    SELECT
      instance_id,
      instance_type,
      instance_state,
      vpc_id,
      subnet_id,
      private_ip_address,
      public_ip_address,
      tags ->> 'Name' AS name,
      COALESCE(tags ->> 'eks:cluster-name', tags ->> 'aws:eks:cluster-name') AS eks_cluster,
      tags ->> 'aws:autoscaling:groupName' AS asg_name
    FROM aws_ec2_instance
  `,

  // Architecture diagram: RDS placement and Multi-AZ standby / 아키텍처 다이어그램: RDS 위치와 Multi-AZ 대기
  diagramRds: `
    SELECT
      db_instance_identifier,
      engine,
      class AS db_instance_class,
      vpc_id,
      availability_zone,
      multi_az,
      secondary_availability_zone,
      status,
      subnets
    FROM aws_rds_db_instance
  `,

  // Architecture diagram: CloudFront origins, to link a distribution to a load balancer / 아키텍처 다이어그램: CloudFront 원본 (로드밸런서 연결 확인용)
  diagramCloudfront: `
    SELECT id, domain_name, aliases, origins FROM aws_cloudfront_distribution
  `,

  // EKS nodes -> instances
  eksNodes: `
    SELECT name, namespace, pod_ip, node_name, phase
    FROM kubernetes_pod
    WHERE phase = 'Running'
    ORDER BY node_name, namespace
    LIMIT 200
  `,

  // K8s Services / K8s 서비스
  k8sServices: `
    SELECT
      name, namespace, type, cluster_ip,
      selector::text AS selector
    FROM kubernetes_service
    ORDER BY namespace, name
  `,

  // K8s Ingress / K8s 인그레스
  k8sIngress: `
    SELECT
      name, namespace,
      ingress_class_name,
      rules::text AS rules,
      status_load_balancer::text AS load_balancer
    FROM kubernetes_ingress
    ORDER BY namespace, name
  `,
};
