// Characterization tests — streaming (stream:true) MULTI-route path of /api/ai. FROZEN after Task 2: do not edit.
// 특성 테스트 — /api/ai 스트리밍 멀티 라우트 경로. 현재 동작을 그대로 고정한다. 바꿔야 한다면 동작이 바뀐 것이다.
import { describe, it, expect } from 'vitest';
import { setupAiMocks, aiRequest, readSse, sseEvents, TEST } from './harness';
import { POST } from '@/app/api/ai/route';

const mocks = setupAiMocks();

const BASE_SYSTEM_PROMPT = `You are AWSops AI Assistant, an expert in AWS cloud operations.
You help users understand and manage their AWS infrastructure.
You have access to real-time AWS resource data via Steampipe queries.
When users ask about their resources, analyze the data provided.
Always be concise and provide actionable insights.
Format responses in markdown for readability.
When discussing security issues, prioritize them by severity.`;
const SYSTEM_NONE = BASE_SYSTEM_PROMPT + '\nRespond in the same language as the user\'s question.';
const SYSTEM_KO = BASE_SYSTEM_PROMPT + '\nAlways respond in Korean (한국어) regardless of the input language.';
const SYNTH_SUFFIX = `\n\nYou are synthesizing answers from multiple AWS service agents. Combine them into one coherent, well-structured response. Do not repeat information.`;
const NET = 'AgentCore → Network Gateway (17 tools)';
const COST = 'AgentCore → Cost Gateway (9 tools)';
const JOIN = '\n\n---\n\n';

const user = (content: string) => [{ role: 'user', content }];

async function postStream(body: Record<string, unknown>) {
  return readSse(await POST(aiRequest({ stream: true, ...body })));
}
/** `[event, data]` list reduced to `[event, step | 'delta' | undefined]`-free exact pairs: status → {step,message}, others whole. */
const names = (list: Array<[string, any]>) => list.map(([e, d]) => (e === 'status' ? `status:${d.step}` : e));

/** AgentCore replies keyed by payload.gateway; an Error value fails that gateway. */
function agentByGateway(map: Record<string, string | Error>) {
  mocks.agent.reply((payload: any) => {
    const v = map[payload.gateway];
    if (v instanceof Error) throw v;
    return v;
  });
}

describe('/api/ai streaming multi-route (characterization)', () => {
  it('twoSuccessesSynthesizeViaConverseStream', async () => {
    mocks.bedrock.classify(['network', 'cost'], { input: 10, output: 5 });
    agentByGateway({ network: 'ALPHA', cost: 'BETA' });
    mocks.bedrock.converse(['SYN-1 ', 'SYN-2']);
    const events = await postStream({ messages: user('q1') });

    expect(events).toEqual([
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['status', { step: 'synthesizing', message: '📊 Synthesizing 2 responses...' }],
      ['chunk', { delta: 'SYN-1 ' }],
      ['chunk', { delta: 'SYN-2' }],
      ['done', {
        content: 'SYN-1 SYN-2', model: 'test-label', via: `Multi-Route: ${NET} + ${COST}`,
        queriedResources: ['network-gateway', 'cost-gateway'], route: 'network', routes: ['network', 'cost'],
        usedTools: [], inputTokens: 10, outputTokens: 5,
      }],
    ]);

    // Synthesis request: ConverseStream, exact prompt shape; no InvokeModel / InvokeModelWithResponseStream synthesis.
    const conv = mocks.bedrock.calls('converse');
    expect(conv).toHaveLength(1);
    expect(conv[0].input).toEqual({
      modelId: 'test-model-id',
      system: [{ text: SYSTEM_NONE + SYNTH_SUFFIX }],
      messages: [{ role: 'user', content: [{ text: `Question: q1\n\nMultiple agents responded:\n\n--- ${NET} ---\nALPHA\n\n--- ${COST} ---\nBETA\n\nPlease synthesize into one comprehensive answer.` }] }],
      inferenceConfig: { maxTokens: 4096 },
    });
    expect(mocks.bedrock.calls('text')).toHaveLength(0);
    expect(mocks.bedrock.calls('stream')).toHaveLength(0);

    // Each participant called its own gateway with the same messages.
    const calls = mocks.agent.calls('InvokeAgentRuntimeCommand');
    expect(calls.map(c => c.payload.gateway).sort()).toEqual(['cost', 'network']);
    for (const c of calls) {
      expect(c.payload).toEqual({ messages: user('q1'), gateway: c.payload.gateway, accountId: '', accountAlias: '' });
    }

    // Stats: one recordCall under the multi gateway name, tokens = classification only (synthesis tokens not counted).
    expect(mocks.recordCall).toHaveBeenCalledTimes(1);
    const rec = mocks.recordCall.mock.calls[0][0];
    expect(rec).toMatchObject({
      route: 'network', gateway: 'multi:network+cost', usedTools: [], success: true,
      via: `Multi-Route: ${NET} + ${COST}`, inputTokens: 10, outputTokens: 5, model: 'test-label',
    });
    expect(mocks.saveConversation).toHaveBeenCalledTimes(1);
    expect(mocks.saveConversation.mock.calls[0][0]).toMatchObject({
      userId: TEST.userEmail, route: 'network', gateway: 'multi:network+cost', question: 'q1',
      summary: 'SYN-1 SYN-2', usedTools: [], via: `Multi-Route: ${NET} + ${COST}`,
    });
  });

  it('twoSuccessesUsesLangSpecificStatusAndSynthesisPrompt', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: 'ALPHA', cost: 'BETA' });
    mocks.bedrock.converse(['S']);
    const events = await postStream({ messages: user('q'), lang: 'ko' });
    expect(events.slice(0, 4)).toEqual([
      ['status', { step: 'classifying', message: '🔍 질문 분석 중...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 멀티 라우트: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 2개 Gateway 병렬 호출 중...' }],
      ['status', { step: 'synthesizing', message: '📊 2개 응답 합성 중...' }],
    ]);
    expect(mocks.bedrock.calls('converse')[0].input.system).toEqual([{ text: SYSTEM_KO + SYNTH_SUFFIX }]);
  });

  it('threeRoutesCountInStatusAndSynthesis', async () => {
    mocks.bedrock.classify(['network', 'cost', 'security']);
    agentByGateway({ network: 'A', cost: 'B', security: 'C' });
    mocks.bedrock.converse(['S']);
    const events = await postStream({ messages: user('q') });
    expect(sseEvents(events, 'status').map(s => s.message)).toEqual([
      '🔍 Analyzing question...',
      '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools) + Security Gateway (14 tools)',
      '🤖 Calling 3 Gateways in parallel...',
      '📊 Synthesizing 3 responses...',
    ]);
    const done = sseEvents(events, 'done')[0];
    expect(done.routes).toEqual(['network', 'cost', 'security']);
    expect(done.queriedResources).toEqual(['network-gateway', 'cost-gateway', 'security-gateway']);
    expect(done.via).toBe('Multi-Route: AgentCore → Network Gateway (17 tools) + AgentCore → Cost Gateway (9 tools) + AgentCore → Security Gateway (14 tools)');
  });

  it('twoSuccessesMergeUsedToolsFromParticipantsAndSynthesis', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({
      network: '<tool_call>{"name": "analyze_reachability"}</tool_call>NETDATA',
      cost: 'COSTDATA',
    });
    mocks.bedrock.converse(['uses ', '"tool_name": "get_cost_and_usage"']);
    const events = await postStream({ messages: user('q') });
    const done = sseEvents(events, 'done')[0];
    // participants' tools first (deduped), then tools extracted from the synthesized text
    expect(done.usedTools).toEqual(['analyze_reachability', 'get_cost_and_usage']);
    expect(done.content).toBe('uses "tool_name": "get_cost_and_usage"');
    // <tool_call> tags are stripped from each participant's content before synthesis
    const text = mocks.bedrock.calls('converse')[0].input.messages[0].content[0].text;
    expect(text).toContain(`--- ${NET} ---\nNETDATA\n\n--- ${COST} ---\nCOSTDATA`);
    expect(mocks.recordCall.mock.calls[0][0].usedTools).toEqual(['analyze_reachability', 'get_cost_and_usage']);
  });

  it('oneSuccessReturnsDirectAnswerWithoutSynthesisOrStats', async () => {
    mocks.bedrock.classify(['network', 'cost'], { input: 7, output: 3 });
    const long = 'x'.repeat(120);
    agentByGateway({ network: long, cost: new Error('boom') });
    const events = await postStream({ messages: user('q') });

    expect(events).toEqual([
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['chunk', { delta: 'x'.repeat(50) }],
      ['chunk', { delta: 'x'.repeat(50) }],
      ['chunk', { delta: 'x'.repeat(20) }],
      ['done', {
        content: long, model: 'test-label', via: NET,
        queriedResources: ['network-gateway'], route: 'network', routes: ['network', 'cost'],
        usedTools: [], inputTokens: 7, outputTokens: 3,
      }],
    ]);
    expect(mocks.bedrock.calls('converse')).toHaveLength(0);
    expect(mocks.bedrock.calls('stream')).toHaveLength(0);
    // The 1-success branch records NOTHING (no recordCall / saveConversation).
    expect(mocks.recordCall).not.toHaveBeenCalled();
    expect(mocks.saveConversation).not.toHaveBeenCalled();
  });

  it('oneSuccessFromSecondRouteKeepsFirstRouteInDone', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: new Error('down'), cost: 'COSTONLY' });
    const events = await postStream({ messages: user('q') });
    expect(events.slice(3)).toEqual([
      ['chunk', { delta: 'COSTONLY' }],
      ['done', {
        content: 'COSTONLY', model: 'test-label', via: COST,
        queriedResources: ['cost-gateway'], route: 'network', routes: ['network', 'cost'],
        usedTools: [], inputTokens: 0, outputTokens: 0,
      }],
    ]);
  });

  it('oneSuccessIgnoresNullParticipantButKeepsToolsOfSuccessOnly', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: '<tool_call>{"name": "analyze_reachability"}</tool_call>NETDATA', cost: '' });
    const events = await postStream({ messages: user('q') });
    const done = sseEvents(events, 'done')[0];
    expect(done.content).toBe('NETDATA');
    expect(done.usedTools).toEqual(['analyze_reachability']);
    expect(done.queriedResources).toEqual(['network-gateway']);
  });

  it('zeroSuccessesFallBackToBedrockDirectStream', async () => {
    mocks.bedrock.classify(['network', 'cost'], { input: 10, output: 5 });
    agentByGateway({ network: new Error('x'), cost: new Error('y') });
    mocks.bedrock.stream(['FB-1 ', 'FB-2'], { input: 100, output: 20 });
    const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const events = await postStream({ messages: many });

    expect(events).toEqual([
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['status', { step: 'fallback', message: '🔄 Gateway timeout, switching to Bedrock Direct...' }],
      ['chunk', { delta: 'FB-1 ' }],
      ['chunk', { delta: 'FB-2' }],
      ['done', {
        content: 'FB-1 FB-2', model: 'test-label',
        via: 'Bedrock Direct (multi-route fallback: network+cost timed out)', queriedResources: [],
        route: 'network', routes: ['network', 'cost'], usedTools: [],
        inputTokens: 110, outputTokens: 25,
      }],
    ]);
    const st = mocks.bedrock.calls('stream');
    expect(st).toHaveLength(1);
    expect(st[0].input.modelId).toBe('test-model-id');
    expect(st[0].body).toEqual({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM_NONE,
      messages: many.slice(-10),
    });
    expect(mocks.bedrock.calls('converse')).toHaveLength(0);
    // No stats on the all-failed fallback.
    expect(mocks.recordCall).not.toHaveBeenCalled();
    expect(mocks.saveConversation).not.toHaveBeenCalled();
  });

  it('zeroSuccessesEmptyFallbackTextIsNoResponse', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: new Error('x'), cost: new Error('y') });
    mocks.bedrock.stream([]);
    const events = await postStream({ messages: user('q') });
    expect(events.slice(3)).toEqual([
      ['status', { step: 'fallback', message: '🔄 Gateway timeout, switching to Bedrock Direct...' }],
      ['done', {
        content: 'No response', model: 'test-label',
        via: 'Bedrock Direct (multi-route fallback: network+cost timed out)', queriedResources: [],
        route: 'network', routes: ['network', 'cost'], usedTools: [],
        inputTokens: 0, outputTokens: 0,
      }],
    ]);
  });

  it('zeroSuccessesAndFallbackThrowSendsErrorEvent', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: new Error('x'), cost: new Error('y') });
    mocks.bedrock.fail('stream', new Error('bedrock down'));
    const events = await postStream({ messages: user('q') });
    expect(events).toEqual([
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['status', { step: 'fallback', message: '🔄 Gateway timeout, switching to Bedrock Direct...' }],
      // the message is fixed; the underlying error text is swallowed
      ['error', { error: 'All routes and fallback failed' }],
    ]);
    expect(mocks.recordCall).not.toHaveBeenCalled();
  });

  it('emptySynthesisFallsBackToJoinedContents', async () => {
    mocks.bedrock.classify(['network', 'cost'], { input: 1, output: 2 });
    agentByGateway({ network: 'ALPHA', cost: 'BETA' });
    mocks.bedrock.converse([]);
    const events = await postStream({ messages: user('q') });
    expect(events).toEqual([
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['status', { step: 'synthesizing', message: '📊 Synthesizing 2 responses...' }],
      // no chunk events: the joined fallback text is only delivered in `done`
      ['done', {
        content: `ALPHA${JOIN}BETA`, model: 'test-label', via: `Multi-Route: ${NET} + ${COST}`,
        queriedResources: ['network-gateway', 'cost-gateway'], route: 'network', routes: ['network', 'cost'],
        usedTools: [], inputTokens: 1, outputTokens: 2,
      }],
    ]);
    expect(mocks.recordCall.mock.calls[0][0]).toMatchObject({ gateway: 'multi:network+cost', success: true });
    expect(mocks.saveConversation.mock.calls[0][0].summary).toBe(`ALPHA${JOIN}BETA`);
  });

  it('synthesisThrowSendsErrorEventAndRecordsNothing', async () => {
    mocks.bedrock.classify(['network', 'cost']);
    agentByGateway({ network: 'ALPHA', cost: 'BETA' });
    mocks.bedrock.fail('converse', new Error('converse boom'));
    const events = await postStream({ messages: user('q') });
    expect(names(events)).toEqual(['status:classifying', 'status:classified', 'status:multi-call', 'status:synthesizing', 'error']);
    expect(events[4]).toEqual(['error', { error: 'converse boom' }]);
    expect(mocks.recordCall).not.toHaveBeenCalled();
  });

  it('sharesOneRequestIdAcrossAllAgentCoreCalls', async () => {
    mocks.bedrock.classify(['network', 'cost', 'security']);
    agentByGateway({ network: 'A', cost: new Error('ServiceUnavailable'), security: 'C' });
    mocks.bedrock.converse(['S']);
    await postStream({ messages: user('q') });
    const calls = mocks.reportAgentcoreInvoke.mock.calls;
    expect(calls).toHaveLength(3);
    const ids = new Set(calls.map(c => c[0]));
    expect(ids.size).toBe(1);
    expect(typeof calls[0][0]).toBe('string');
    expect(calls.map(c => c[1]).sort()).toEqual(['error', 'success', 'success']);
    expect(calls.find(c => c[1] === 'error')!.slice(1)).toEqual(['error', 'Error: ServiceUnavailable']);

    // A second request gets a different id.
    mocks.reportAgentcoreInvoke.mockClear();
    await postStream({ messages: user('q') });
    const ids2 = new Set(mocks.reportAgentcoreInvoke.mock.calls.map(c => c[0]));
    expect(ids2.size).toBe(1);
    expect(Array.from(ids2)[0]).not.toBe(Array.from(ids)[0]);
  });

  it('classificationTokensOnlyInDoneAndSynthesisTokensNotCounted', async () => {
    mocks.bedrock.classify(['network', 'cost'], { input: 11, output: 4 });
    mocks.bedrock.textUsage({ input: 999, output: 999 });
    mocks.bedrock.stream(['unused'], { input: 999, output: 999 });
    agentByGateway({ network: 'A', cost: 'B' });
    mocks.bedrock.converse(['S']);
    const done = sseEvents(await postStream({ messages: user('q') }), 'done')[0];
    expect(done.inputTokens).toBe(11);
    expect(done.outputTokens).toBe(4);
  });

  it('doneRoutesPresentOnlyOnGatewayMultiBranches', async () => {
    // 2-success, 1-success, 0-success all carry `routes` (asserted exactly above). Handlers that run for routes[0]
    // even in multi mode (sql / auto-collect / code) return their single-route `done` WITHOUT `routes`.
    mocks.bedrock.classify(['aws-data', 'network']);
    mocks.bedrock.sql('SELECT * FROM aws_ec2_instance');
    mocks.steampipe.result({ rows: [{ a: 1 }] });
    const sqlEvents = await postStream({ messages: user('list ec2') });
    const sqlDone = sseEvents(sqlEvents, 'done')[0];
    expect(sqlDone).not.toHaveProperty('routes');
    expect(sqlDone.route).toBe('aws-data');

    mocks.bedrock.classify(['eks-optimize', 'network']);
    const collEvents = await postStream({ messages: user('optimize eks') });
    const collDone = sseEvents(collEvents, 'done')[0];
    expect(collDone).not.toHaveProperty('routes');
    expect(collDone.route).toBe('eks-optimize');
  });

  it('sqlFirstWithSuccessRunsOnlySqlHandlerAndIgnoresOtherRoutes', async () => {
    mocks.bedrock.classify(['aws-data', 'network'], { input: 2, output: 1 });
    mocks.bedrock.sql('SELECT * FROM aws_ec2_instance');
    mocks.steampipe.result({ rows: [{ a: 1 }] });
    mocks.bedrock.stream(['SQLANS'], { input: 30, output: 8 });
    const events = await postStream({ messages: user('list ec2') });
    expect(names(events)).toEqual([
      'status:classifying', 'status:classified', 'status:sql-generating', 'status:sql-querying', 'status:analyzing', 'chunk', 'done',
    ]);
    // `classified` still advertises the multi-route form
    expect(events[1][1]).toMatchObject({ step: 'classified', route: 'aws-data', routes: ['aws-data', 'network'] });
    expect(events[1][1].message).toBe('📡 Multi-route: Bedrock + Steampipe SQL + Network Gateway (17 tools)');
    expect(mocks.agentSend).not.toHaveBeenCalled();
    expect(mocks.bedrock.calls('converse')).toHaveLength(0);
    expect(sseEvents(events, 'done')[0]).toMatchObject({ via: 'Bedrock + Steampipe SQL (1 rows)', inputTokens: 32, outputTokens: 9 });
  });

  it('sqlFailureInsideMultiFallsThroughAndSqlRunsAgain', async () => {
    // routes[0] = aws-data: the streaming SQL handler runs first; on failure it falls through to the multi block,
    // where handleSingleRoute('aws-data') generates SQL a SECOND time before routing to AgentCore ops.
    mocks.bedrock.classify(['aws-data', 'network']);
    mocks.bedrock.sql('DROP TABLE x'); // non-SELECT → generateSQL returns null
    agentByGateway({ ops: 'OPSANS', network: 'NETANS' });
    mocks.bedrock.converse(['SYN']);
    const events = await postStream({ messages: user('list ec2') });

    expect(names(events)).toEqual([
      'status:classifying', 'status:classified',
      'status:sql-generating', 'status:sql-fallback',
      'status:multi-call', 'status:synthesizing', 'chunk', 'done',
    ]);
    expect(events[3][1].message).toBe('⚠️ SQL failed, switching to AgentCore...');
    expect(mocks.bedrock.calls('sql')).toHaveLength(2); // once in the stream SQL handler, once in the multi participant
    expect(mocks.runQuery).not.toHaveBeenCalled();
    const gws = mocks.agent.calls('InvokeAgentRuntimeCommand').map(c => c.payload.gateway).sort();
    expect(gws).toEqual(['network', 'ops']);
    const done = sseEvents(events, 'done')[0];
    expect(done.via).toBe('Multi-Route: AgentCore → Bedrock + Steampipe SQL + AgentCore → Network Gateway (17 tools)');
    expect(done.queriedResources).toEqual(['ops-gateway', 'network-gateway']);
    expect(done.routes).toEqual(['aws-data', 'network']);
    expect(done.route).toBe('aws-data');
  });

  it('sqlQueryErrorInsideMultiReRunsSqlAndQueryInParticipant', async () => {
    mocks.bedrock.classify(['aws-data', 'network']);
    mocks.bedrock.sql('SELECT * FROM aws_ec2_instance');
    mocks.steampipe.result({ rows: [], error: 'column nope does not exist' });
    agentByGateway({ ops: 'OPSANS', network: 'NETANS' });
    mocks.bedrock.converse(['SYN']);
    const events = await postStream({ messages: user('list ec2') });

    const statuses = sseEvents(events, 'status');
    expect(statuses.map(s => s.step)).toEqual([
      'classifying', 'classified', 'sql-generating',
      'sql-querying', 'sql-retrying', 'sql-querying', 'sql-fallback',
      'multi-call', 'synthesizing',
    ]);
    expect(statuses[3]).toMatchObject({ sql: 'SELECT * FROM aws_ec2_instance', message: '🔎 Running Steampipe query...' });
    expect(statuses[5].message).toBe('🔎 Running Steampipe query... (retry)');
    // stream handler: 2 queries (+2 SQL generations); participant re-runs the same: 2 more queries (+2 generations)
    expect(mocks.runQuery).toHaveBeenCalledTimes(4);
    expect(mocks.bedrock.calls('sql')).toHaveLength(4);
    expect(sseEvents(events, 'done')[0].via).toBe('Multi-Route: AgentCore → Bedrock + Steampipe SQL + AgentCore → Network Gateway (17 tools)');
  });

  it('collectorFailureInMultiFallsThroughToMultiCall', async () => {
    mocks.bedrock.classify(['eks-optimize', 'network']);
    mocks.collectorMock('eks-optimize').collect.mockRejectedValue(new Error('collect boom'));
    agentByGateway({ network: 'NETANS' });
    const events = await postStream({ messages: user('q') });
    expect(events.slice(2)).toEqual([
      ['status', { step: 'eks-optimize-error', message: '⚠️ eks-optimize collector error: collect boom' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
      ['chunk', { delta: 'NETANS' }],
      ['done', expect.objectContaining({ via: NET, route: 'eks-optimize', routes: ['eks-optimize', 'network'], queriedResources: ['network-gateway'] })],
    ]);
  });

  it('datasourceAndTopologyFirstAreNotShortCircuitedInMulti', async () => {
    // topology / datasource handlers are guarded by !isMulti: the multi block runs instead and the participant
    // handler (non-streaming) does the work. A datasource route with no detectable datasource type yields null.
    mocks.bedrock.classify(['datasource', 'network']);
    agentByGateway({ network: 'NETANS' });
    const events = await postStream({ messages: user('hello') });
    expect(names(events)).toEqual(['status:classifying', 'status:classified', 'status:multi-call', 'chunk', 'done']);
    expect(sseEvents(events, 'done')[0]).toMatchObject({ via: NET, route: 'datasource', routes: ['datasource', 'network'] });
  });
});
