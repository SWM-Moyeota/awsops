// Topology chat API: turns natural-language requests into either
//  - a validated JSON Patch against the current FossFLOW model (visual edits),
//  - generator option changes (layer toggles / VPC switch / empty subnets), or
//  - a plain answer.
// 토폴로지 채팅 API: 자연어 요청을 ① 다이어그램 JSON 패치(시각 편집, 서버 검증)
// ② 생성기 옵션 변경(레이어 토글·VPC 전환) ③ 일반 답변으로 번역한다.
import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getBedrockModelId } from '@/lib/app-config';
import { applyPatch, PatchOp } from '@/lib/fossflow/patch';
import { validateFossflowModel } from '@/lib/fossflow/validate';

const bedrockClient = new BedrockRuntimeClient({ region: 'ap-northeast-2' });
const MAX_OPS = 200;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatContext {
  vpcId: string;
  vpcName?: string;
  vpcs: Array<{ vpcId: string; name: string; cidr: string }>;
  options: Record<string, any>;
}

function systemPrompt(model: any, context: ChatContext, isEn: boolean): string {
  const modelJson = JSON.stringify(model);
  return `You are the AWSops topology assistant. The user is viewing a FossFLOW diagram (isometric canvas) of an AWS VPC and wants to modify it through chat.

CURRENT DIAGRAM MODEL (icons stripped):
${modelJson}

CONTEXT:
- Current VPC: ${context.vpcId} (${context.vpcName || ''})
- Available VPCs: ${JSON.stringify(context.vpcs)}
- Current generator options: ${JSON.stringify(context.options)}
  VPC-scoped layers (default ON): showIgw, showTgw, showRds, showEgress, showEks (cluster overlay), showElasticache, showMsk, showOpensearch, showLambda (VPC lambdas), showEndpoints (VPC endpoints)
  Account-global tray layers (default OFF): showS3, showDynamodb, showCloudfront, showRoute53
  Other options: includeEmpty (empty subnets), vpc (switches the diagram to another VPC)

MODEL SCHEMA NOTES:
- items: [{id, name, icon, description?}] — icon must be one of the ids in the icons array
- views[0].items: [{id, tile:{x,y}, labelHeight?}] — id must exist in items
- views[0].rectangles: [{id, color, from:{x,y}, to:{x,y}}] — color must exist in colors
- views[0].connectors: [{id, color, style: SOLID|DOTTED|DASHED, width, description?, anchors:[{id, ref:{item: <view item id>}}]}] — each anchor ref has exactly one key
- views[0].textBoxes: [{id, tile:{x,y}, content, fontSize}]
- colors: [{id, value: "#rrggbb"}]

DECIDE THE ACTION and respond with ONLY a JSON object, no prose:

1. Visual edit of what is already drawn (remove elements, change colors/line styles/labels/positions, add text notes):
{"action":"patch","ops":[<RFC6902 add/remove/replace ops>],"message":"<short ${isEn ? 'English' : 'Korean'} summary>"}
Patch rules:
- Array removals: use the element index at the time the op runs; when removing several array elements, order ops from the HIGHEST index to the lowest.
- When removing a view item or model item, also remove connectors anchored to it and the corresponding entry in BOTH items and views[0].items.
- To recolor a class of lines (e.g. all blue lines), replace the value of the referenced color in /colors, or add a new color and update the connectors' color refs.
- Never touch /icons.
- Do not exceed ${MAX_OPS} ops.

2. Change what data is drawn (switch VPC, include empty subnets, toggle any layer listed above):
{"action":"options","options":{<subset of: vpc, includeEmpty, showIgw, showTgw, showRds, showEgress, showEks, showElasticache, showMsk, showOpensearch, showLambda, showEndpoints, showS3, showDynamodb, showCloudfront, showRoute53>},"message":"<short summary>"}
Note: options regenerate the diagram from live data, which DISCARDS previous patch edits — mention that in the message if patches were likely applied.

3. Question or unsupported request:
{"action":"answer","message":"<${isEn ? 'English' : 'Korean'} answer>"}
For unsupported drawing requests (resources with no layer, e.g. SQS, API Gateway), say it is not supported yet and list what IS supported: layer toggles (IGW/TGW/RDS/EKS overlay/ElastiCache/MSK/OpenSearch/Lambda/VPC endpoints/egress + account-global S3/DynamoDB/CloudFront/Route53), VPC switch, empty subnets, removing drawn elements, colors/line styles, text notes, node labels.

Respond in ${isEn ? 'English' : 'Korean'} for the message field.`;
}

async function callModel(system: string, messages: ChatMessage[]): Promise<any> {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    system,
    messages: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
  });
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: getBedrockModelId(),
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    })
  );
  const text = JSON.parse(new TextDecoder().decode(response.body)).content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('model returned no JSON');
  return JSON.parse(match[0]);
}

export async function POST(request: NextRequest) {
  try {
    const { messages, model, context, lang } = await request.json();
    if (!Array.isArray(messages) || !model || !context?.vpcId) {
      return NextResponse.json({ error: 'messages, model, context required' }, { status: 400 });
    }
    const isEn = lang === 'en';
    const system = systemPrompt(model, context, isEn);

    let result = await callModel(system, messages);

    if (result.action === 'patch') {
      let ops: PatchOp[] = Array.isArray(result.ops) ? result.ops.slice(0, MAX_OPS) : [];
      // Validate against the stripped model; one self-repair round on failure
      // 스트립된 모델 기준 검증, 실패 시 1회 자가 수정
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const patched = applyPatch(model, ops);
          const issues = validateFossflowModel(patched);
          if (issues.length === 0) {
            return NextResponse.json({ action: 'patch', ops, message: result.message || '' });
          }
          throw new Error(issues.slice(0, 8).join('; '));
        } catch (err: any) {
          if (attempt === 1) {
            return NextResponse.json({
              action: 'answer',
              message: isEn
                ? `Could not apply the edit (${err.message}). Please rephrase the request.`
                : `편집을 적용하지 못했습니다 (${err.message}). 요청을 조금 다르게 표현해주세요.`,
            });
          }
          const retryMessages: ChatMessage[] = [
            ...messages,
            { role: 'assistant', content: JSON.stringify({ action: 'patch', ops }) },
            {
              role: 'user',
              content: `Your patch failed validation: ${err.message}. Return a corrected {"action":"patch",...} JSON.`,
            },
          ];
          result = await callModel(system, retryMessages);
          ops = Array.isArray(result.ops) ? result.ops.slice(0, MAX_OPS) : [];
        }
      }
    }

    if (result.action === 'options') {
      return NextResponse.json({
        action: 'options',
        options: result.options || {},
        message: result.message || '',
      });
    }

    return NextResponse.json({ action: 'answer', message: result.message || '...' });
  } catch (err: any) {
    console.error('[TopologyChat] failed:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
