// Dependency graph shared types.
// 의존성 그래프 공용 타입 — 간선 방향: src가 dst를 쓴다/의존한다.
export type NodeType = 'vpc'|'subnet'|'eni'|'instance'|'sg'|'lb'|'tg'|'rds'|'lambda'|'role'|'nat'|'eip'|'ebs'|'s3'|'cloudfront';
export type EdgeType = 'in_vpc'|'in_subnet'|'uses_sg'|'allows_from'|'uses_role'|'uses_volume'|'uses_eni'|'uses_eip'|'forwards_to'|'targets'|'can_access'|'notifies'|'origin';

export interface GraphNode { arn: string; type: NodeType; id: string; name: string; accountId: string; region: string; attrs: Record<string, unknown> }
export interface GraphEdge { src: string; dst: string; type: EdgeType }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; dropped: number }

export type QueryName = 'vpc'|'subnet'|'eni'|'instance'|'sg'|'sgRule'|'alb'|'nlb'|'clb'|'tg'|'rds'|'lambda'|'role'|'policy'|'nat'|'eip'|'ebs'|'s3'|'cloudfront';
export type Row = Record<string, unknown>;
export type Rows = Partial<Record<QueryName, Row[]>>;

export interface BuildStats { builtAt: string; nodeCounts: Partial<Record<NodeType, number>>; edgeCount: number; dropped: number; warnings: string[] }
export interface WalkNode extends GraphNode { depth: number }
export interface WalkResult { nodes: WalkNode[]; truncated: boolean }
export interface Neighborhood { center: GraphNode; nodes: Array<WalkNode & { side: 'center'|'dependent'|'dependency' }>; edges: GraphEdge[]; truncated: boolean }

// Informational impact line for SG preview cards (Slack safe AI actions).
// 보안그룹 미리보기 카드용 영향 요약 — 안내만 하며 정책 판단에는 쓰지 않는다.
export interface GraphImpact { count: number; sample: string[]; builtAt: string; truncated: boolean }
