# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform
resource "aws_subnet" "r_subnet" {
  assign_ipv6_address_on_creation                = false
  availability_zone                              = "ap-northeast-2b"
  availability_zone_id                           = "apne2-az2"
  cidr_block                                     = "10.0.1.0/24"
  customer_owned_ipv4_pool                       = null
  enable_dns64                                   = false
  enable_lni_at_device_index                     = 0
  enable_resource_name_dns_a_record_on_launch    = false
  enable_resource_name_dns_aaaa_record_on_launch = false
  ipv6_cidr_block                                = null
  ipv6_native                                    = false
  map_customer_owned_ip_on_launch                = false
  map_public_ip_on_launch                        = true
  outpost_arn                                    = null
  private_dns_hostname_type_on_launch            = "ip-name"
  tags = {
    Environment           = "sandbox"
    Name                  = "DemoStack/VPC/PublicSubnet2"
    Realm                 = "demo"
    ServiceComponent      = "demo-poc"
    ServiceDomain         = "aws"
    "aws-cdk:subnet-name" = "Public"
    "aws-cdk:subnet-type" = "Public"
  }
  tags_all = {
    Environment           = "sandbox"
    Name                  = "DemoStack/VPC/PublicSubnet2"
    Realm                 = "demo"
    ServiceComponent      = "demo-poc"
    ServiceDomain         = "aws"
    "aws-cdk:subnet-name" = "Public"
    "aws-cdk:subnet-type" = "Public"
  }
  vpc_id = "vpc-928b1a8ef13830697"
}

# __generated__ by Terraform from "sg-417b37380b1865e9e"
resource "aws_security_group" "r_sg" {
  description = "Demo ALB SG - HTTPS with Cognito auth"
  egress = [{
    cidr_blocks      = ["0.0.0.0/0"]
    description      = "Allow all outbound traffic by default"
    from_port        = 0
    ipv6_cidr_blocks = []
    prefix_list_ids  = []
    protocol         = "-1"
    security_groups  = []
    self             = false
    to_port          = 0
  }]
  ingress = [{
    cidr_blocks      = ["0.0.0.0/0"]
    description      = "HTTP redirect to HTTPS"
    from_port        = 80
    ipv6_cidr_blocks = []
    prefix_list_ids  = []
    protocol         = "tcp"
    security_groups  = []
    self             = false
    to_port          = 80
    }, {
    cidr_blocks      = ["0.0.0.0/0"]
    description      = "HTTPS"
    from_port        = 443
    ipv6_cidr_blocks = []
    prefix_list_ids  = []
    protocol         = "tcp"
    security_groups  = []
    self             = false
    to_port          = 443
  }]
  name                   = "demo-alb-sg"
  name_prefix            = null
  revoke_rules_on_delete = null
  tags = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  vpc_id = "vpc-928b1a8ef13830697"
}

# __generated__ by Terraform from "vol-9ed4b4567123ca05b"
resource "aws_ebs_volume" "r_ebs" {
  availability_zone    = "ap-northeast-2a"
  encrypted            = true
  final_snapshot       = null
  iops                 = 3000
  kms_key_id           = "arn:aws:kms:ap-northeast-2:111122223333:key/27fbf101-98f0-240d-65fe-dbda42ca1738"
  multi_attach_enabled = false
  outpost_arn          = null
  size                 = 100
  snapshot_id          = "snap-32b5b441f9a8fdc7b"
  tags                 = {}
  tags_all             = {}
  throughput           = 125
  type                 = "gp3"
}

# __generated__ by Terraform
resource "aws_lb_target_group" "r_tg" {
  connection_termination             = null
  deregistration_delay               = jsonencode(300)
  ip_address_type                    = "ipv4"
  lambda_multi_value_headers_enabled = null
  load_balancing_algorithm_type      = "round_robin"
  load_balancing_anomaly_mitigation  = "off"
  load_balancing_cross_zone_enabled  = "use_load_balancer_configuration"
  name                               = "Demo-Dashb-HCI90ZEZCMOQ"
  name_prefix                        = null
  port                               = 3000
  preserve_client_ip                 = null
  protocol                           = "HTTP"
  protocol_version                   = "HTTP1"
  proxy_protocol_v2                  = null
  slow_start                         = 0
  tags = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  target_type = "instance"
  vpc_id      = "vpc-928b1a8ef13830697"
  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200,302"
    path                = "/"
    port                = jsonencode(3000)
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }
  stickiness {
    cookie_duration = 86400
    cookie_name     = null
    enabled         = true
    type            = "lb_cookie"
  }
  target_failover {
    on_deregistration = null
    on_unhealthy      = null
  }
  target_group_health {
    dns_failover {
      minimum_healthy_targets_count      = jsonencode(1)
      minimum_healthy_targets_percentage = "off"
    }
    unhealthy_state_routing {
      minimum_healthy_targets_count      = 1
      minimum_healthy_targets_percentage = "off"
    }
  }
  target_health_state {
    enable_unhealthy_connection_termination = null
    unhealthy_draining_interval             = null
  }
}

# __generated__ by Terraform
resource "aws_lb" "r_lb" {
  client_keep_alive                                            = 3600
  customer_owned_ipv4_pool                                     = null
  desync_mitigation_mode                                       = "defensive"
  dns_record_client_routing_policy                             = null
  drop_invalid_header_fields                                   = false
  enable_cross_zone_load_balancing                             = true
  enable_deletion_protection                                   = false
  enable_http2                                                 = true
  enable_tls_version_and_cipher_suite_headers                  = false
  enable_waf_fail_open                                         = false
  enable_xff_client_port                                       = false
  enable_zonal_shift                                           = false
  enforce_security_group_inbound_rules_on_private_link_traffic = null
  idle_timeout                                                 = 3600
  internal                                                     = false
  ip_address_type                                              = "ipv4"
  load_balancer_type                                           = "application"
  name                                                         = "demo-alb"
  name_prefix                                                  = null
  preserve_host_header                                         = false
  security_groups                                              = ["sg-417b37380b1865e9e"]
  subnets                                                      = ["subnet-6436d1848ff7efdab", "subnet-d5f44685cf74c6f39"]
  tags = {
    Environment      = "sandbox"
    Name             = "demo-alb"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Name             = "demo-alb"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  xff_header_processing_mode = "append"
  access_logs {
    bucket  = ""
    enabled = false
    prefix  = null
  }
  connection_logs {
    bucket  = ""
    enabled = false
    prefix  = null
  }
  subnet_mapping {
    allocation_id        = null
    ipv6_address         = null
    private_ipv4_address = null
    subnet_id            = "subnet-6436d1848ff7efdab"
  }
  subnet_mapping {
    allocation_id        = null
    ipv6_address         = null
    private_ipv4_address = null
    subnet_id            = "subnet-d5f44685cf74c6f39"
  }
}

# __generated__ by Terraform
resource "aws_nat_gateway" "r_nat" {
  allocation_id                      = "eipalloc-dc9bb635f2d5abe20"
  connectivity_type                  = "public"
  private_ip                         = "10.0.0.222"
  secondary_allocation_ids           = []
  secondary_private_ip_address_count = 0
  secondary_private_ip_addresses     = []
  subnet_id                          = "subnet-d5f44685cf74c6f39"
  tags = {
    Environment      = "sandbox"
    Name             = "DemoStack/VPC/PublicSubnet1"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Name             = "DemoStack/VPC/PublicSubnet1"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
}

# __generated__ by Terraform from "eipalloc-dc9bb635f2d5abe20"
resource "aws_eip" "r_eip" {
  address                   = null
  associate_with_private_ip = null
  customer_owned_ipv4_pool  = null
  domain                    = "vpc"
  instance                  = null
  ipam_pool_id              = null
  network_border_group      = "ap-northeast-2"
  network_interface         = "eni-1b9a2781d9dbc9bc3"
  public_ipv4_pool          = "amazon"
  tags = {
    Environment      = "sandbox"
    Name             = "DemoStack/VPC/PublicSubnet1"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Name             = "DemoStack/VPC/PublicSubnet1"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
}

# __generated__ by Terraform from "demo-deploy-bucket"
resource "aws_s3_bucket" "r_s3" {
  bucket              = "demo-deploy-bucket"
  bucket_prefix       = null
  force_destroy       = null
  object_lock_enabled = false
  tags                = {}
  tags_all            = {}
}

# __generated__ by Terraform
resource "aws_lambda_function" "r_lambda" {
  architectures                      = ["x86_64"]
  code_signing_config_arn            = null
  description                        = "Lambda function for removing all inbound/outbound rules from the VPC default security group"
  filename                           = null
  function_name                      = "DemoStack-CustomVpcRestrictDefaultSGCustomResour-FGWjcIQN9Okp"
  handler                            = "__entrypoint__.handler"
  image_uri                          = null
  kms_key_arn                        = null
  layers                             = []
  memory_size                        = 128
  package_type                       = "Zip"
  publish                            = null
  replace_security_groups_on_destroy = null
  replacement_security_group_ids     = null
  reserved_concurrent_executions     = -1
  role                               = "arn:aws:iam::111122223333:role/DemoStack-CustomVpcRestrictDefaultSGCustomResourc-A33KaAJD0TMu"
  runtime                            = "nodejs22.x"
  s3_bucket                          = null
  s3_key                             = null
  s3_object_version                  = null
  skip_destroy                       = false
  source_code_hash                   = null
  tags = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  timeout = 900
  environment {
    variables = {
      APP_MODE    = "demo-value"
      DB_PASSWORD = "fake-secret-1"
    }
  }
  ephemeral_storage {
    size = 512
  }
  logging_config {
    application_log_level = null
    log_format            = "Text"
    log_group             = "/aws/lambda/DemoStack-CustomVpcRestrictDefaultSGCustomResour-FGWjcIQN9Okp"
    system_log_level      = null
  }
  tracing_config {
    mode = "PassThrough"
  }
}

# __generated__ by Terraform
resource "aws_db_instance" "r_rds" {
  allocated_storage                     = 20
  allow_major_version_upgrade           = null
  apply_immediately                     = null
  auto_minor_version_upgrade            = true
  availability_zone                     = "ap-northeast-2a"
  backup_retention_period               = 7
  backup_target                         = "region"
  backup_window                         = "14:51-15:21"
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  character_set_name                    = null
  copy_tags_to_snapshot                 = true
  custom_iam_instance_profile           = null
  customer_owned_ip_enabled             = false
  database_insights_mode                = "advanced"
  db_name                               = null
  db_subnet_group_name                  = "demo-db-subnet-group"
  dedicated_log_volume                  = false
  delete_automated_backups              = true
  deletion_protection                   = false
  domain                                = null
  domain_auth_secret_arn                = null
  domain_dns_ips                        = []
  domain_fqdn                           = null
  domain_iam_role_name                  = null
  domain_ou                             = null
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  engine                                = "postgres"
  engine_lifecycle_support              = "open-source-rds-extended-support-disabled"
  engine_version                        = jsonencode(18.3)
  final_snapshot_identifier             = null
  iam_database_authentication_enabled   = false
  identifier                            = "demo-dev-db"
  identifier_prefix                     = null
  instance_class                        = "db.m5.large"
  iops                                  = 0
  kms_key_id                            = "arn:aws:kms:ap-northeast-2:111122223333:key/3ecde21a-6aba-86d9-e7a1-7d6ce63be36b"
  license_model                         = "postgresql-license"
  maintenance_window                    = "sat:17:54-sat:18:24"
  manage_master_user_password           = null
  master_user_secret_kms_key_id         = null
  max_allocated_storage                 = 0
  monitoring_interval                   = 60
  monitoring_role_arn                   = "arn:aws:iam::111122223333:role/rds-monitoring-role"
  multi_az                              = false
  nchar_character_set_name              = null
  network_type                          = "IPV4"
  option_group_name                     = "default:postgres-18"
  parameter_group_name                  = "postgres18"
  password                              = null # sensitive
  password_wo                           = null # sensitive
  password_wo_version                   = null
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = "arn:aws:kms:ap-northeast-2:111122223333:key/3ecde21a-6aba-86d9-e7a1-7d6ce63be36b"
  performance_insights_retention_period = 465
  port                                  = 5432
  publicly_accessible                   = false
  replica_mode                          = null
  replicate_source_db                   = null
  skip_final_snapshot                   = true
  snapshot_identifier                   = null
  storage_encrypted                     = true
  storage_throughput                    = 0
  storage_type                          = "gp2"
  tags                                  = {}
  tags_all                              = {}
  timezone                              = null
  upgrade_storage_config                = null
  username                              = "demo"
  vpc_security_group_ids                = ["sg-6bf6aec069a3776db"]
}

# __generated__ by Terraform
resource "aws_vpc" "r_vpc" {
  assign_generated_ipv6_cidr_block     = false
  cidr_block                           = "10.0.0.0/23"
  enable_dns_hostnames                 = false
  enable_dns_support                   = true
  enable_network_address_usage_metrics = false
  instance_tenancy                     = "default"
  ipv4_ipam_pool_id                    = null
  ipv4_netmask_length                  = null
  ipv6_cidr_block                      = null
  ipv6_cidr_block_network_border_group = null
  ipv6_ipam_pool_id                    = null
  ipv6_netmask_length                  = 0
  tags = {
    Name = "demo-vpc"
  }
  tags_all = {
    Name = "demo-vpc"
  }
}

# __generated__ by Terraform
resource "aws_instance" "r_instance" {
  ami                                  = "ami-32c9e3011dcfdb702"
  associate_public_ip_address          = false
  availability_zone                    = "ap-northeast-2a"
  disable_api_stop                     = false
  disable_api_termination              = false
  ebs_optimized                        = false
  enable_primary_ipv6                  = null
  get_password_data                    = false
  hibernation                          = false
  host_id                              = null
  host_resource_group_arn              = null
  iam_instance_profile                 = "DemoStack-DemoServerInstanceProfile9BTNXP4Q-SYYN2znWXCG0"
  instance_initiated_shutdown_behavior = "stop"
  instance_type                        = "t4g.xlarge"
  ipv6_address_count                   = 0
  ipv6_addresses                       = []
  key_name                             = null
  monitoring                           = false
  placement_group                      = null
  placement_partition_number           = 0
  private_ip                           = "10.0.2.154"
  secondary_private_ips                = []
  security_groups                      = []
  source_dest_check                    = true
  subnet_id                            = "subnet-36a9a26cf913edb0b"
  tags = {
    Environment      = "sandbox"
    Name             = "DemoStack-Demo-Server"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
    UserDataVersion  = "2"
  }
  tags_all = {
    Environment      = "sandbox"
    Name             = "DemoStack-Demo-Server"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
    UserDataVersion  = "2"
  }
  tenancy                     = "default"
  user_data                   = "8cc2f65ee9b4737809194b4438df8d69c07a5bdf"
  user_data_base64            = null
  user_data_replace_on_change = null
  volume_tags                 = null
  vpc_security_group_ids      = ["sg-d7d5a5df2f45bdbfb"]
  capacity_reservation_specification {
    capacity_reservation_preference = "open"
  }
  cpu_options {
    amd_sev_snp      = null
    core_count       = 4
    threads_per_core = 1
  }
  credit_specification {
    cpu_credits = "unlimited"
  }
  enclave_options {
    enabled = false
  }
  maintenance_options {
    auto_recovery = "default"
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_protocol_ipv6          = "disabled"
    http_put_response_hop_limit = 2
    http_tokens                 = "required"
    instance_metadata_tags      = "disabled"
  }
  private_dns_name_options {
    enable_resource_name_dns_a_record    = false
    enable_resource_name_dns_aaaa_record = false
    hostname_type                        = "ip-name"
  }
  root_block_device {
    delete_on_termination = true
    encrypted             = true
    iops                  = 3000
    kms_key_id            = "arn:aws:kms:ap-northeast-2:111122223333:key/27fbf101-98f0-240d-65fe-dbda42ca1738"
    tags                  = {}
    tags_all              = {}
    throughput            = 125
    volume_size           = 100
    volume_type           = "gp3"
  }
}

# __generated__ by Terraform from "ER7GOROQANTN7Z"
resource "aws_cloudfront_distribution" "r_cloudfront" {
  aliases                         = ["cdn.example.com"]
  comment                         = "demo media CDN"
  continuous_deployment_policy_id = null
  default_root_object             = null
  enabled                         = true
  http_version                    = "http2"
  is_ipv6_enabled                 = true
  price_class                     = "PriceClass_All"
  retain_on_delete                = false
  staging                         = false
  tags = {
    Name    = "demo-media-cdn"
    project = "demo"
  }
  tags_all = {
    Name    = "demo-media-cdn"
    project = "demo"
  }
  wait_for_deployment = true
  web_acl_id          = null
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cache_policy_id            = "9f030d79-6b91-aed2-7847-b3d6052652bb"
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = null
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = null
    realtime_log_config_arn    = null
    response_headers_policy_id = null
    smooth_streaming           = false
    target_origin_id           = "demo-media.s3.ap-northeast-2.amazonaws.com-e046rahnfjr"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }
  origin {
    connection_attempts      = 3
    connection_timeout       = 10
    domain_name              = "demo-media.s3.ap-northeast-2.amazonaws.com"
    origin_access_control_id = "E1ID7ZON3O1XL"
    origin_id                = "demo-media.s3.ap-northeast-2.amazonaws.com-e046rahnfjr"
    origin_path              = null
  }
  restrictions {
    geo_restriction {
      locations        = []
      restriction_type = "none"
    }
  }
  viewer_certificate {
    acm_certificate_arn            = "arn:aws:acm:us-east-1:111122223333:certificate/ecbd5372-5ca5-0ff5-0c18-20a0bcefa52b"
    cloudfront_default_certificate = false
    iam_certificate_id             = null
    minimum_protocol_version       = "TLSv1.2_2021"
    ssl_support_method             = "sni-only"
  }
}

# __generated__ by Terraform from "DemoAgentCoreRole"
resource "aws_iam_role" "r_role" {
  assume_role_policy = jsonencode({
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "bedrock.amazonaws.com"
      }
      }, {
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "bedrock-agentcore.amazonaws.com"
      }
    }]
    Version = "2012-10-17"
  })
  description           = null
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "DemoAgentCoreRole"
  name_prefix           = null
  path                  = "/"
  permissions_boundary  = null
  tags = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
  tags_all = {
    Environment      = "sandbox"
    Realm            = "demo"
    ServiceComponent = "demo-poc"
    ServiceDomain    = "aws"
  }
}
