// ============================================================================
// Tool usage extraction / 사용된 도구 추출
// ============================================================================
// 알려진 MCP 도구 이름 (125개 중 주요 도구) / Known MCP tool names for matching
export const KNOWN_TOOLS = new Set([
  // Network (17)
  'get_path_trace_methodology', 'find_ip_address', 'get_eni_details', 'list_vpcs',
  'get_vpc_network_details', 'get_vpc_flow_logs', 'describe_network', 'list_transit_gateways',
  'get_tgw_details', 'get_tgw_routes', 'get_all_tgw_routes', 'list_tgw_peerings',
  'list_vpn_connections', 'list_network_firewalls', 'get_firewall_rules',
  'analyze_reachability', 'query_flow_logs',
  // Container (24)
  'list_eks_clusters', 'get_eks_vpc_config', 'get_eks_insights', 'get_cloudwatch_logs',
  'get_cloudwatch_metrics', 'get_eks_metrics_guidance', 'get_policies_for_role',
  'search_eks_troubleshoot_guide', 'generate_app_manifest',
  'ecs_resource_management', 'ecs_troubleshooting_tool', 'wait_for_service_ready',
  'istio_overview', 'list_virtual_services', 'list_destination_rules', 'list_istio_gateways',
  'list_service_entries', 'list_authorization_policies', 'list_peer_authentications',
  'check_sidecar_injection', 'list_envoy_filters', 'list_istio_crds', 'istio_troubleshooting', 'query_istio_resource',
  // IaC (12)
  'validate_cloudformation_template', 'check_cloudformation_template_compliance',
  'troubleshoot_cloudformation_deployment', 'search_cdk_documentation',
  'search_cloudformation_documentation', 'cdk_best_practices', 'read_iac_documentation_page',
  'SearchAwsProviderDocs', 'SearchAwsccProviderDocs', 'SearchSpecificAwsIaModules',
  'SearchUserProvidedModule', 'terraform_best_practices',
  // Data (24)
  'list_tables', 'describe_table', 'query_table', 'get_item', 'dynamodb_data_modeling', 'compute_performances_and_costs',
  'list_db_instances', 'list_db_clusters', 'describe_db_instance', 'describe_db_cluster', 'execute_sql', 'list_snapshots',
  'list_cache_clusters', 'describe_cache_cluster', 'list_replication_groups', 'describe_replication_group',
  'list_serverless_caches', 'elasticache_best_practices',
  'list_clusters', 'get_cluster_info', 'get_configuration_info', 'get_bootstrap_brokers', 'list_nodes', 'msk_best_practices',
  // Security (14)
  'list_users', 'get_user', 'list_roles', 'get_role_details', 'list_groups', 'get_group',
  'list_policies', 'list_user_policies', 'list_role_policies', 'get_user_policy', 'get_role_policy',
  'list_access_keys', 'simulate_principal_policy', 'get_account_security_summary',
  // Monitoring (16)
  'get_metric_data', 'get_metric_metadata', 'analyze_metric', 'get_recommended_metric_alarms',
  'get_active_alarms', 'get_alarm_history', 'describe_log_groups', 'analyze_log_group',
  'execute_log_insights_query', 'get_logs_insight_query_results', 'cancel_logs_insight_query',
  'lookup_events', 'list_event_data_stores', 'lake_query', 'get_query_status', 'get_query_results',
  // Cost (9)
  'get_today_date', 'get_cost_and_usage', 'get_cost_and_usage_comparisons',
  'get_cost_comparison_drivers', 'get_cost_forecast', 'get_dimension_values',
  'get_tag_values', 'get_pricing', 'list_budgets',
  // Ops (9)
  'search_documentation', 'read_documentation', 'recommend', 'list_regions',
  'get_regional_availability', 'prompt_understanding', 'call_aws', 'suggest_aws_commands', 'run_steampipe_query',
  // Diagnostics (8)
  'validate_datasource_url', 'resolve_dns', 'check_nlb_targets',
  'analyze_security_groups', 'trace_network_path', 'test_http_connectivity',
  'check_k8s_service_endpoints', 'run_full_diagnosis',
]);

// 응답 내용 기반 도구 추론 매핑 / Infer tools from response content keywords
export const TOOL_KEYWORD_MAP: Record<string, string[]> = {
  // Security
  'list_users': ['IAM 사용자', 'IAM user', 'iam user', '사용자 목록', 'user list'],
  'get_user': ['사용자 상세', 'user detail'],
  'list_roles': ['IAM 역할', 'IAM role', '역할 목록', 'role list'],
  'get_role_details': ['역할 상세', 'role detail', 'trust policy'],
  'list_access_keys': ['액세스 키', 'access key', 'AccessKey'],
  'simulate_principal_policy': ['시뮬레이션', 'simulate', 'permission test'],
  'get_account_security_summary': ['보안 요약', 'security summary', 'MFA', 'mfa_enabled'],
  'list_policies': ['정책 목록', 'policy list', 'AdministratorAccess'],
  'list_user_policies': ['사용자 정책', 'user policy', '인라인 정책'],
  'list_role_policies': ['역할 정책', 'role policy'],
  // Network
  'list_vpcs': ['VPC 목록', 'vpc_id', 'VPC ID', 'cidr_block'],
  'get_vpc_network_details': ['서브넷', 'subnet', '라우트 테이블', 'route table', 'NACL'],
  'list_transit_gateways': ['Transit Gateway', 'TGW', 'tgw-'],
  'get_tgw_routes': ['TGW 라우트', 'tgw route'],
  'list_vpn_connections': ['VPN', 'vpn-'],
  'analyze_reachability': ['Reachability', 'reachability', '도달성'],
  'query_flow_logs': ['Flow Log', 'flow log', '플로우 로그'],
  'list_network_firewalls': ['Network Firewall', 'firewall'],
  'describe_network': ['네트워크 구성', 'network describe'],
  // Container
  'list_eks_clusters': ['EKS 클러스터', 'eks cluster'],
  'ecs_resource_management': ['ECS 서비스', 'ecs service', 'ECS 태스크'],
  'istio_overview': ['Istio', 'istio', '서비스 메시'],
  // Monitoring
  'get_metric_data': ['메트릭', 'metric', 'CPU 사용', 'cpu utilization'],
  'get_active_alarms': ['알람', 'alarm', 'CloudWatch alarm'],
  'lookup_events': ['CloudTrail', 'cloudtrail', 'API 이벤트', 'api event'],
  'execute_log_insights_query': ['Log Insights', 'log insights', '로그 분석'],
  'describe_log_groups': ['로그 그룹', 'log group'],
  // Cost
  'get_cost_and_usage': ['비용', 'cost', 'billing', '청구'],
  'get_cost_forecast': ['예측', 'forecast'],
  'list_budgets': ['예산', 'budget'],
  'get_pricing': ['가격', 'pricing', '단가'],
  // Data
  'list_tables': ['DynamoDB', 'dynamodb', '테이블 목록'],
  'list_db_instances': ['RDS', 'rds', 'DB 인스턴스'],
  'list_cache_clusters': ['ElastiCache', 'elasticache', 'Redis', 'Valkey'],
  'list_clusters': ['MSK', 'Kafka', 'kafka'],
  // Diagnostics
  'validate_datasource_url': ['URL 검증', 'SSRF', 'ssrf', 'URL validation'],
  'resolve_dns': ['DNS 해석', 'dns resolution', 'DNS lookup', '호스트 해석'],
  'check_nlb_targets': ['NLB 타겟', 'nlb target', 'target health', '타겟 헬스'],
  'analyze_security_groups': ['SG 분석', 'security group analysis', 'SG 체인', 'sg chain'],
  'trace_network_path': ['네트워크 경로', 'network path', 'cross-vpc', '크로스VPC'],
  'test_http_connectivity': ['HTTP 연결', 'http connectivity', 'health check', '헬스체크'],
  'check_k8s_service_endpoints': ['K8s 엔드포인트', 'service endpoint', 'Pod 매칭'],
  'run_full_diagnosis': ['전체 진단', 'full diagnosis', '연결 진단', 'connectivity diagnosis'],
};

export function extractUsedTools(rawResponse: string): string[] {
  const tools = new Set<string>();
  let m: RegExpExecArray | null;
  // 1. <tool_call> 태그 / <tool_call> tags
  const callRegex = /<tool_call>\s*\{[^}]*"name"\s*:\s*"([^"]+)"/g;
  while ((m = callRegex.exec(rawResponse)) !== null) tools.add(m[1]);
  // 2. "tool_name" 필드 / "tool_name" field
  const useRegex = /"tool_name"\s*:\s*"([^"]+)"/g;
  while ((m = useRegex.exec(rawResponse)) !== null) tools.add(m[1]);
  // 3. 백틱으로 감싼 도구 이름 / Backtick-wrapped tool names
  const backtickRegex = /`([a-zA-Z][a-zA-Z0-9_]+)`/g;
  while ((m = backtickRegex.exec(rawResponse)) !== null) {
    if (KNOWN_TOOLS.has(m[1])) tools.add(m[1]);
  }
  // 4. 백틱 없이 텍스트에 등장하는 알려진 도구 이름 / Known tool names in plain text
  Array.from(KNOWN_TOOLS).forEach(toolName => {
    if (toolName.length > 6 && rawResponse.includes(toolName)) tools.add(toolName);
  });
  // 5. 응답 내용 키워드로 도구 추론 / Infer tools from response content keywords
  Object.entries(TOOL_KEYWORD_MAP).forEach(([tool, keywords]) => {
    if (keywords.some(kw => rawResponse.includes(kw))) tools.add(tool);
  });
  return Array.from(tools);
}
