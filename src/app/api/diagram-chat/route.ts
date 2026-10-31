// Diagram chat API: translates natural-language requests into 2D diagram
// generation options (no patch path, unlike the topology chat — regeneration options only).
// 다이어그램 채팅 API: 자연어를 2D 다이어그램 생성 옵션으로 번역한다. 패치 경로 없이 재생성 옵션만 지원.
import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getBedrockModelId } from '@/lib/app-config';

const bedrockClient = new BedrockRuntimeClient({ region: 'ap-northeast-2' });

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(request: NextRequest) {
  try {
    const { messages, context, lang } = await request.json();
    if (!Array.isArray(messages) || !context?.vpcId) {
      return NextResponse.json({ error: 'messages, context required' }, { status: 400 });
    }
    const isEn = lang === 'en';
    const system = `You are the AWSops diagram assistant. The user is viewing a 2D AWS architecture diagram (VPC > AZ > subnet bands > resources, numbered with a legend) and wants to adjust it through chat.

CONTEXT:
- Current VPC: ${context.vpcId} (${context.vpcName || ''})
- Available VPCs: ${JSON.stringify(context.vpcs || [])}
- Subnets in the current VPC: ${JSON.stringify(context.subnets || [])}
- Current options: ${JSON.stringify(context.options || {})}

SUPPORTED OPTIONS (regeneration only — the drawing itself cannot be patched):
- vpc: switch to another VPC (use the vpc_id from the list)
- direction: "TB" (AZs side by side, default) or "LR" (AZs stacked, tiers left to right)
- includeEmpty: also draw subnets without resources
- excludeSubnets: array of subnet ids or names to drop from the drawing
- includeServices: show or hide the account-wide services (S3, Route 53, DynamoDB, other CloudFront)

Respond with ONLY a JSON object, no prose:
- To change the drawing: {"action":"options","options":{<subset of the above>},"message":"<short ${isEn ? 'English' : 'Korean'} summary>"}
  excludeSubnets REPLACES the previous exclusion list — to add to it, include the previous entries too; to reset, pass [].
- For questions or unsupported requests (colors, styling, moving nodes — none of these are supported here): {"action":"answer","message":"<${isEn ? 'English' : 'Korean'} answer>"}
  For styling/editing requests, mention that free-form visual editing is available in the Topology View tab (토폴로지뷰), while this tab only supports: VPC switch, direction, empty subnets, excluding subnets, account-wide services.`;

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 500,
      system,
      messages: messages.slice(-10).map((m: ChatMessage) => ({ role: m.role, content: m.content })),
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
    const result = match ? JSON.parse(match[0]) : { action: 'answer', message: '...' };
    if (result.action === 'options') {
      return NextResponse.json({
        action: 'options',
        options: result.options || {},
        message: result.message || '',
      });
    }
    return NextResponse.json({ action: 'answer', message: result.message || '...' });
  } catch (err: any) {
    console.error('[DiagramChat] failed:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
