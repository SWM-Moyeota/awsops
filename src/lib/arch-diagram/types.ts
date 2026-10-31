// Shared types for the architecture diagram / 아키텍처 다이어그램 공용 타입
import type { IconKey } from './icons';

export type ResKind = IconKey | 'internet';
export type Tier = 'public' | 'private';
export type Direction = 'TB' | 'LR';

// One drawn resource / 그려지는 리소스 하나
export interface Res {
  id: string;
  kind: ResKind;
  name: string;
  // Second line in the legend (type, engine, state) / 범례의 둘째 정보 (타입, 엔진, 상태)
  detail?: string;
  // Instances folded into this icon / 이 아이콘으로 접은 인스턴스 수
  count?: number;
  // Auto Scaling group: drawn with an orange dashed frame / 오토 스케일링 그룹: 주황 점선 테두리
  group?: boolean;
  // Legend number, set at the end of buildModel / 범례 번호, buildModel 끝에서 매김
  n?: number;
}

export interface SubnetModel {
  id: string;
  name: string;
  cidr: string;
  az: string;
  tier: Tier;
  resources: Res[];
  // Load balancer nodes live here though no icon does / 아이콘은 없어도 로드밸런서 노드가 있음
  lbNodes: boolean;
  // Multi-subnet resources drawn in another subnet that also use this one / 다른 서브넷에 그렸지만 이 서브넷도 쓰는 리소스
  also: Res[];
}

export interface AzModel { name: string; public: SubnetModel[]; private: SubnetModel[] }

// Endpoints may be a resource id or `subnet:<subnet-id>` / 끝점은 리소스 id 또는 `subnet:<서브넷 id>`
export interface EdgeModel { from: string; to: string; dashed?: boolean; label?: string }

export interface DiagramModel {
  vpc: { id: string; name: string; cidr: string; accountId: string; region: string };
  internet?: Res;
  igw?: Res;
  lbs: Res[];
  // Attached to the VPC itself (endpoints, TGW) / VPC 자체에 붙은 것
  attachments: Res[];
  azs: AzModel[];
  // Global services in front of this VPC / 이 VPC 앞단의 전역 서비스
  edgeServices: Res[];
  // Account-wide regional services, not tied to this VPC / 이 VPC에 묶이지 않은 계정 공통 서비스
  services: Res[];
  edges: EdgeModel[];
  hiddenEmpty: number;
  // Stopped servers and databases left out / 그리지 않은 정지 상태의 서버·DB 수
  hiddenStopped: number;
  skipped: string[];
}

// Query results by name; optional sources may be missing / 이름별 쿼리 결과, 선택 소스는 없을 수 있음
export interface DiagramRows {
  vpcSubnets: Row[]; ec2: Row[]; elb: Row[]; nat: Row[]; igw: Row[]; routeTables: Row[]; targetGroups: Row[];
  rds?: Row[]; elasticache?: Row[]; lambda?: Row[]; msk?: Row[]; opensearch?: Row[]; endpoints?: Row[]; tgw?: Row[];
  s3?: Row[]; dynamodb?: Row[]; cloudfront?: Row[]; route53?: Row[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface BuildOptions { vpc: string; includeEmpty?: boolean; excludeSubnets?: string[]; includeServices?: boolean; region?: string; skipped?: string[] }
