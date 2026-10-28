// Root-cause shared types: signals, write events, suspects, incidents, eval scenarios.
// 장애 원인 분석 공용 타입 — 신호·쓰기 이벤트·용의자·사건·평가 시나리오.
import type { GraphData, NodeType } from '@/lib/dep-graph/types';
import type { Actor, ToolId } from '@/lib/change-timeline/types';

// Anomaly signal kinds the detector watches. / 감지 루프가 보는 이상 신호 4종.
export type SignalKind = 'alb-5xx' | 'tg-unhealthy' | 'ec2-status' | 'alarm';
export interface Signal { kind: SignalKind; accountId: string; region: string; resourceArn: string | null; alarmArn?: string; alarmName?: string; startedAt: string; detail: string; recent?: number; baseline?: number }

// A resource named by an event: by ARN, or by id (+ type when known). / 이벤트가 가리키는 리소스.
export interface ResourceRef { type: NodeType | null; id?: string; arn?: string }
// One CloudTrail write event, parsed and sanitized. / 파싱·정리된 CloudTrail 쓰기 이벤트 하나.
export interface WriteEvent { eventId: string; eventName: string; eventSource: string; time: string; accountId: string; region: string; actor: Actor; tool: ToolId; refs: ResourceRef[]; params: string }

// Graph history: one snapshot per build, merged over the incident window. / 빌드별 스냅샷과 창 범위 합본.
export interface GraphSnapshot { builtAt: string; data: GraphData }
export interface MergedGraph { data: GraphData; from: string | null; to: string | null; count: number }

// Hop count from the target, or why there is none. / 대상까지의 홉 수, 또는 없는 이유.
export type Distance = number | 'unconnected' | 'not-in-graph' | 'no-target';
export interface Proximity { distance: Distance; path: string[]; matchedArn: string | null }
export interface Suspect { event: WriteEvent; proximity: Proximity; weights: { time: number; graph: number; kind: number }; score: number; rank: number }

// AI explanation; causes must cite eventIds from the bundle. / AI 설명 — 원인은 근거 묶음의 eventId를 인용해야 한다.
export interface AiCause { eventId: string; reason: string; confidence: 'high' | 'medium' | 'low' }
export interface AiResult { status: 'ok' | 'unverified' | 'failed' | 'skipped'; summary?: string; causes?: AiCause[]; checks?: string[]; droppedCitations: number }

export interface Analysis { analyzedAt: string; windowFrom: string; windowTo: string; graph: { from: string | null; to: string | null; count: number }; eventsSeen: number; truncated: boolean; failedRegions: string[]; suspects: Suspect[]; ai: AiResult }
// analysisAttempts: auto analyses started so far (max 3). / 지금까지 시작한 자동 분석 횟수(최대 3).
export interface Incident { id: string; key: string; accountId: string; region: string; resourceArn: string | null; resourceName: string | null; signals: Signal[]; startedAt: string; firstSeenAt: string; lastSeenAt: string; status: 'open' | 'resolved'; source: 'auto' | 'manual'; analysis?: Analysis; notifiedAt?: string; analysisAttempts?: number }

// Replay-test case: small graph history, raw CloudTrail events, the operator's answer. / 재현 시험 한 건.
export interface Scenario { id: string; title: string; category: string; knownLimit?: boolean; accountId: string; region: string; targetArn: string | null; startedAt: string; graphs: GraphSnapshot[]; events: Record<string, unknown>[]; answer: string }
