// ============================================================================
// Route Registry: Single source of truth for all routing decisions
// 라우트 레지스트리: 모든 라우팅 결정의 단일 소스
// Adding a tool here automatically updates classification, display, and gateway mapping
// 여기에 도구를 추가하면 분류, 표시, 게이트웨이 매핑이 자동 업데이트됨
// ============================================================================
export interface RouteConfig {
  gateway: string;             // AgentCore gateway role / AgentCore 게이트웨이 역할
  skill?: string;              // SKILL_BASE override (when different from gateway) / 게이트웨이와 다른 스킬 프롬프트 사용 시
  display: string;             // UI display name / UI 표시 이름
  description: string;         // What this route handles / 이 라우트가 처리하는 것
  tools: string[];             // Available tool capabilities / 사용 가능한 도구 기능
  examples?: string[];         // Classification examples / 분류 예시
  handler?: 'code' | 'sql' | 'datasource' | 'auto-collect' | 'topology';   // Special handler type / 특수 핸들러 타입 (code: Code Interpreter, sql: pg Pool 직접, datasource: 외부 데이터소스, auto-collect: 자동 데이터 수집 분석, topology: 토폴로지뷰 링크)
}

export const ROUTE_REGISTRY: Record<string, RouteConfig> = {
  code: {
    gateway: '',
    display: 'Code Interpreter',
    description: 'Python code execution and calculations',
    tools: ['Python 코드 실행', '계산/분석/시각화', '스크립트 생성'],
    examples: ['"코드 실행해줘" → code', '"이 데이터를 파이썬으로 분석" → code'],
    handler: 'code',
  },
  network: {
    gateway: 'network',
    display: 'Network Gateway (17 tools)',
    description: 'AWS VPC networking, Transit Gateway, VPN, and traffic analysis',
    tools: [
      'VPC/Subnet/ENI/Security Group 조회 및 분석',
      'Transit Gateway(TGW) 목록/상세/라우트/피어링',
      'VPN 연결 상태, Network Firewall 규칙',
      'NAT Gateway, Internet Gateway, Route Table',
      'Reachability Analyzer (네트워크 경로 분석, 연결 확인)',
      'VPC Flow Logs 조회 및 트래픽 분석',
    ],
    examples: [
      '"TGW 라우트 분석" → network', '"VPN 연결 상태 진단" → network',
      '"EC2 간 통신 가능한지 확인" → network', '"네트워크 경로 분석" → network',
      '"플로우 로그 조회" → network', '"VPC 피어링 트러블슈팅" → network',
      '"Reachability Analyzer 실행" → network', '"방화벽 규칙 확인" → network',
    ],
  },
  container: {
    gateway: 'container',
    display: 'Container Gateway (24 tools)',
    description: 'EKS, ECS, and Istio service mesh',
    tools: [
      'EKS 클러스터/노드/Pod/로그/메트릭/IAM/트러블슈팅',
      'ECS 클러스터/서비스/태스크/ECR/Fargate 트러블슈팅',
      'Istio VirtualService/DestinationRule/Gateway/mTLS/EnvoyFilter',
    ],
    examples: [
      '"EKS 클러스터 상태" → container', '"ECS 서비스 현황" → container',
      '"Istio 현황" → container', '"Pod 상태 확인" → container',
      '"컨테이너 로그" → container', '"EKS 노드 메트릭" → container',
    ],
  },
  iac: {
    gateway: 'iac',
    display: 'IaC Gateway (12 tools)',
    description: 'Infrastructure as Code tools',
    tools: [
      'CloudFormation 템플릿 검증/컴플라이언스/배포 트러블슈팅',
      'CDK 문서/샘플/모범사례 검색',
      'Terraform AWS/AWSCC 프로바이더 문서, 모듈 검색',
    ],
    examples: ['"CDK 모범사례" → iac', '"CloudFormation 스택 오류" → iac', '"Terraform 모듈 검색" → iac'],
  },
  data: {
    gateway: 'data',
    display: 'Data Gateway (24 tools)',
    description: 'AWS databases and streaming services',
    tools: [
      'DynamoDB 테이블 목록/상세/쿼리/스캔/데이터 모델링/비용 추정',
      'RDS/Aurora 인스턴스/클러스터 목록/상세/SQL 실행(Data API)',
      'ElastiCache/Valkey 클러스터/복제 그룹/서버리스/모범사례',
      'MSK Kafka 클러스터/브로커/설정/엔드포인트/모범사례',
    ],
    examples: ['"DynamoDB 테이블 조회" → data', '"RDS 인스턴스 상태" → data', '"Kafka 클러스터 정보" → data'],
  },
  security: {
    gateway: 'security',
    display: 'Security Gateway (14 tools)',
    description: 'AWS IAM and security posture',
    tools: [
      'IAM 사용자/역할/그룹/정책 목록 및 상세',
      'Access Key 목록/상태, MFA 상태',
      'Policy Simulation (권한 테스트)',
      'Account Security Summary (계정 보안 요약)',
      'Trust Policy 분석, 인라인 정책 조회',
    ],
    examples: ['"IAM 사용자 목록" → security', '"권한 시뮬레이션" → security', '"보안 요약" → security'],
  },
  monitoring: {
    gateway: 'monitoring',
    display: 'Monitoring Gateway (16 tools)',
    description: 'AWS observability and audit',
    tools: [
      'CloudWatch 메트릭 데이터/메타데이터/추세 분석',
      'CloudWatch 알람 목록/이력/추천',
      'CloudWatch 로그 그룹/분석/Log Insights 쿼리',
      'CloudTrail API 이벤트 조회/Lake SQL 분석',
    ],
    examples: ['"CPU 사용량 확인" → monitoring', '"CloudTrail 이벤트 조회" → monitoring', '"알람 목록" → monitoring'],
  },
  cost: {
    gateway: 'cost',
    display: 'Cost Gateway (9 tools)',
    description: 'AWS billing, cost forecasting, budgets, and FinOps. NOT for EKS resource rightsizing (use eks-optimize instead)',
    tools: [
      'Cost Explorer (비용/사용량 분석, 기간 비교, 비용 동인 분석)',
      'Cost Forecast (비용 예측)',
      'Pricing (AWS 서비스 가격 조회)',
      'Budgets (예산 상태 확인)',
    ],
    examples: ['"이번 달 비용" → cost', '"EC2 비용 분석" → cost', '"비용 예측" → cost', '"서비스별 비용 추이" → cost', '"AWS 전체 비용" → cost'],
  },
  'aws-data': {
    gateway: 'ops',
    display: 'Bedrock + Steampipe SQL',
    description: 'General AWS resource inventory and status queries via SQL',
    tools: [
      'Steampipe SQL (580+ AWS 테이블 직접 쿼리)',
      'EC2/S3/VPC/Lambda/RDS/IAM 등 리소스 목록/현황 조회',
    ],
    examples: [
      '"EC2 인스턴스 목록" → aws-data', '"S3 버킷 현황" → aws-data',
      '"Lambda 함수 목록" → aws-data', '"전체 리소스 요약" → aws-data',
      '"VPC 목록" → aws-data', '"VPC 현황" → aws-data',
      '"VPC 네트워크 구성 분석" → aws-data', '"VPC 구성을 분석해줘" → aws-data',
      '"서브넷 리스트" → aws-data', '"보안그룹 목록" → aws-data',
      '"RDS 인스턴스 몇개" → aws-data', '"EKS 노드 목록" → aws-data',
      '"네트워크 현황" → aws-data', '"인프라 구성 보여줘" → aws-data',
    ],
    handler: 'sql',
  },
  topology: {
    gateway: '',
    display: 'Topology View',
    description: 'AWSops VPC topology diagram — resolves the target VPC and links to the Topology View tab (/topology-view)',
    tools: ['VPC 토폴로지 다이어그램 표시', 'VPC 선택/전환', '빈 서브넷 포함 옵션'],
    examples: [
      '"토폴로지 보여줘" → topology', '"VPC 구성도 보여줘" → topology',
      '"jaeho.p-vpc 다이어그램 보여줘" → topology', '"show the vpc topology diagram" → topology',
      '"구성도 그려줘" → topology', '"빈 서브넷도 포함해서 구성도 보여줘" → topology',
    ],
    handler: 'topology',
  },
  'datasource-diag': {
    gateway: 'monitoring',
    skill: 'diagnostics',
    display: 'Datasource Diagnostics (8 tools)',
    description: 'Datasource connectivity troubleshooting — DNS, network path, SG, NLB targets, HTTP connectivity',
    tools: [
      'URL 검증/SSRF 위험 판단/프로토콜 확인',
      'DNS 해석/IP→VPC CIDR 매핑',
      'NLB 타겟 그룹 헬스 체크',
      '보안그룹 체인 분석 (소스→목적지)',
      '네트워크 경로 추적 (TGW/Peering/Cross-VPC)',
      'HTTP 엔드포인트 연결 테스트',
      'K8s Service 엔드포인트/Pod 매칭 확인',
      '전체 6단계 자동 진단 (run_full_diagnosis)',
    ],
    examples: [
      '"Prometheus 연결 진단" → datasource-diag', '"데이터소스 연결 안됨" → datasource-diag',
      '"NLB 타겟 헬스 확인" → datasource-diag', '"datasource connection timeout" → datasource-diag',
      '"datasource connectivity troubleshoot" → datasource-diag', '"데이터소스 네트워크 경로 확인" → datasource-diag',
    ],
  },
  datasource: {
    gateway: '',
    display: 'Datasource Analytics',
    description: 'External datasource metrics, logs, and traces analysis (Prometheus, Loki, Tempo, ClickHouse)',
    tools: [
      'Prometheus PromQL 메트릭 쿼리 및 분석',
      'Loki LogQL 로그 검색 및 패턴 분석',
      'Tempo TraceQL 분산 트레이스 분석',
      'ClickHouse SQL 데이터 분석',
    ],
    examples: [
      '"프로메테우스에서 CPU 사용량 확인" → datasource', '"prometheus cpu usage" → datasource',
      '"로키에서 에러 로그 검색" → datasource', '"loki error logs" → datasource',
      '"트레이스 조회" → datasource', '"tempo traces" → datasource',
      '"클릭하우스 데이터 분석" → datasource', '"clickhouse query" → datasource',
    ],
    handler: 'datasource',
  },
  'eks-optimize': {
    gateway: '',
    display: 'EKS Cost Optimizer',
    description: 'EKS resource optimization: collects Prometheus metrics, K8s resource configs, and cost data to find rightsizing opportunities and cost savings',
    tools: [
      'Prometheus CPU/Memory 사용량 vs 요청량 비교',
      'CPU Throttling 분석',
      'HTTP 에러율 분석 (5xx)',
      'Pod 재시작 분석',
      'K8s 리소스 request/limit 분석 (Steampipe)',
      'EKS 컨테이너 비용 분석',
      'Node 활용률 분석',
    ],
    examples: [
      '"EKS 비용 개선점 찾아줘" → eks-optimize', '"EKS 리소스 최적화" → eks-optimize',
      '"컨테이너 리소스 낭비 분석" → eks-optimize', '"EKS rightsizing" → eks-optimize',
      '"Pod CPU/메모리 과다 할당 분석" → eks-optimize', '"EKS cost optimization" → eks-optimize',
      '"EKS 비용 최적화" → eks-optimize', '"EKS 비용 절감" → eks-optimize',
      '"컨테이너 비용 분석" → eks-optimize', '"K8s 리소스 최적화" → eks-optimize',
    ],
    handler: 'auto-collect',
  },
  'db-optimize': {
    gateway: '',
    display: 'DB Cost Optimizer',
    description: 'RDS, ElastiCache, OpenSearch instance rightsizing: collects CloudWatch metrics and Steampipe configs to find over-provisioned databases. NOT for EKS (use eks-optimize) or general billing (use cost)',
    tools: ['RDS CPU/Memory/IOPS/Connections 분석', 'ElastiCache CPU/Memory/Connections 분석', 'OpenSearch JVM/Storage/Latency 분석', '인스턴스 타입 rightsizing 권장'],
    examples: [
      '"RDS 비용 최적화" → db-optimize', '"ElastiCache rightsizing" → db-optimize',
      '"OpenSearch 비용 분석" → db-optimize', '"DB 리소스 낭비 확인" → db-optimize',
      '"데이터베이스 비용 절감" → db-optimize', '"RDS 인스턴스 다운사이징" → db-optimize',
    ],
    handler: 'auto-collect',
  },
  'msk-optimize': {
    gateway: '',
    display: 'MSK Optimizer',
    description: 'MSK Kafka broker rightsizing: collects broker CloudWatch metrics, Steampipe configs, and optional Prometheus Kafka metrics for throughput and consumer lag analysis',
    tools: ['MSK 브로커 CPU/Memory/처리량 분석', 'Kafka consumer lag 분석', '브로커 인스턴스 rightsizing', 'Provisioned vs Serverless 비교'],
    examples: [
      '"MSK 비용 최적화" → msk-optimize', '"Kafka 브로커 rightsizing" → msk-optimize',
      '"MSK 처리량 분석" → msk-optimize', '"MSK 브로커 다운사이징" → msk-optimize',
    ],
    handler: 'auto-collect',
  },
  'idle-scan': {
    gateway: '',
    display: 'Idle Resource Scanner',
    description: 'Scans for unused/idle AWS resources wasting money: unattached EBS, unassociated EIPs, stopped EC2s, old snapshots, gp2 volumes, unused security groups',
    tools: ['미연결 EBS 스캔', '미연결 EIP 스캔', '중지 EC2 스캔', '오래된 스냅샷 스캔', 'gp2→gp3 전환 대상 스캔', '미사용 SG 스캔'],
    examples: [
      '"미사용 리소스 찾아줘" → idle-scan', '"유휴 리소스 스캔" → idle-scan',
      '"비용 낭비 리소스" → idle-scan', '"사용 안하는 EBS 확인" → idle-scan',
      '"idle resources" → idle-scan', '"낭비되는 리소스 정리" → idle-scan',
    ],
    handler: 'auto-collect',
  },
  'trace-analyze': {
    gateway: '',
    display: 'Service Trace Analyzer',
    description: 'Distributed tracing analysis: auto-discovers Tempo/Jaeger datasource, maps service dependencies, identifies latency bottlenecks and error propagation paths',
    tools: ['서비스 의존성 매핑', '지연시간 핫스팟 분석', '에러 전파 경로 분석', '서비스별 트레이스 샘플링'],
    examples: [
      '"서비스 의존성 분석" → trace-analyze', '"지연시간 병목 찾아줘" → trace-analyze',
      '"트레이스 분석" → trace-analyze', '"서비스 호출 관계" → trace-analyze',
      '"latency bottleneck" → trace-analyze', '"서비스간 의존성 확인" → trace-analyze',
    ],
    handler: 'auto-collect',
  },
  incident: {
    gateway: '',
    display: 'Incident Analyzer',
    description: 'Multi-source incident analysis: cross-correlates Prometheus anomalies, Loki error logs, Tempo error traces, CloudWatch alarms, and K8s warning events to reconstruct incident timelines',
    tools: ['CloudWatch 알람 분석', 'K8s 이벤트 분석', 'Prometheus 이상 감지', 'Loki 에러 로그 분석', 'Tempo 에러 트레이스 분석'],
    examples: [
      '"장애 원인 분석" → incident', '"서비스 에러 원인 찾아줘" → incident',
      '"사고 분석" → incident', '"최근 이상 현상 분석" → incident',
      '"incident analysis" → incident', '"지금 무슨 문제가 있어?" → incident',
    ],
    handler: 'auto-collect',
  },
  general: {
    gateway: 'ops',
    display: 'Ops Gateway (9 tools)',
    description: 'General AWS questions, documentation, and best practices',
    tools: [
      'AWS 문서 검색/리전 가용성 확인',
      'AWS CLI 명령 실행/제안',
      'Steampipe SQL (580+ 테이블)',
    ],
    examples: ['"AWS 모범사례 알려줘" → general', '"이 서비스가 서울 리전에서 사용 가능한지" → general'],
  },
};

// Derived values from registry / 레지스트리에서 파생된 값
export type RouteType = keyof typeof ROUTE_REGISTRY;
export const VALID_ROUTES = Object.keys(ROUTE_REGISTRY) as RouteType[];
