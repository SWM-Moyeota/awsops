// Topology View helpers / 토폴로지뷰 헬퍼
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { runQuery } from '@/lib/steampipe';
import { bedrockClient } from './clients';
import { MODELS } from './models';
import { TOPOLOGY_PROMPT } from './prompts';

// Topology View handler: resolve target VPC from conversation + live VPC list
// 토폴로지뷰 핸들러: 대화 + 실시간 VPC 목록에서 대상 VPC 결정
export interface TopologyParams {
  vpcId: string | null;
  vpcName: string | null;
  vpcCidr: string | null;
  includeEmpty: boolean;
}

export async function generateTopologyParams(
  messages: Array<{role: string; content: string}>, accountId?: string
): Promise<{ params: TopologyParams | null; vpcs: Array<{vpc_id: string; name: string | null; cidr: string}>; error?: string }> {
  const vpcRes = await runQuery(
    `SELECT vpc_id, tags ->> 'Name' AS name, cidr_block AS cidr FROM aws_vpc ORDER BY name NULLS LAST`,
    { accountId }
  );
  if (vpcRes.error) return { params: null, vpcs: [], error: vpcRes.error };
  const vpcs = vpcRes.rows as Array<{vpc_id: string; name: string | null; cidr: string}>;
  if (vpcs.length === 0) return { params: null, vpcs: [], error: 'no VPCs found' };
  try {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      system: TOPOLOGY_PROMPT(vpcs),
      messages: messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS['opus-4.8'],
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const text = JSON.parse(new TextDecoder().decode(response.body)).content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    const row = vpcs.find(v => v.vpc_id === parsed.vpc_id);
    return {
      params: {
        vpcId: row?.vpc_id || null,
        vpcName: row?.name || row?.vpc_id || null,
        vpcCidr: row?.cidr || null,
        includeEmpty: Boolean(parsed.include_empty),
      },
      vpcs,
    };
  } catch (err: any) {
    console.error('[Topology] Param resolution failed:', err.message);
    return { params: null, vpcs };
  }
}

export function topologyContent(
  params: TopologyParams | null,
  vpcs: Array<{vpc_id: string; name: string | null; cidr: string}>,
  isEn: boolean,
  error?: string
): string {
  if (error) {
    return isEn
      ? `Could not load the VPC list (${error}). Please open the Topology View tab directly: [/topology-view](/topology-view)`
      : `VPC 목록을 불러오지 못했습니다 (${error}). 토폴로지뷰 탭에서 직접 확인해주세요: [/topology-view](/topology-view)`;
  }
  if (params?.vpcId) {
    const link = `/topology-view?vpc=${params.vpcId}${params.includeEmpty ? '&empty=1' : ''}`;
    const title = `**${params.vpcName}** (${params.vpcCidr || ''})`;
    const emptyNote = params.includeEmpty
      ? (isEn ? ' Empty subnets are included.' : ' 빈 서브넷도 포함했습니다.')
      : '';
    return isEn
      ? `Prepared the AWSops topology for ${title}.${emptyNote}\n\n➡️ [Open Topology View](${link})`
      : `${title} AWSops 토폴로지를 준비했습니다.${emptyNote}\n\n➡️ [토폴로지뷰 열기](${link})`;
  }
  const rows = vpcs.map(v => `| ${v.name || '-'} | \`${v.vpc_id}\` | ${v.cidr} | [${isEn ? 'Open' : '열기'}](/topology-view?vpc=${v.vpc_id}) |`).join('\n');
  const header = isEn
    ? 'Multiple VPCs found — which one would you like to see?\n\n| Name | VPC ID | CIDR | Topology |\n|---|---|---|---|\n'
    : '여러 VPC가 있습니다 — 어느 VPC를 보시겠어요?\n\n| 이름 | VPC ID | CIDR | 토폴로지 |\n|---|---|---|---|\n';
  return header + rows;
}
