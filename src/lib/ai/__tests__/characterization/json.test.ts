// Characterization tests — JSON (stream:false) path of /api/ai. FROZEN after Task 2: do not edit.
// 특성 테스트 — /api/ai 비스트리밍(JSON) 경로. 현재 동작을 그대로 고정한다. 바꿔야 한다면 동작이 바뀐 것이다.
import { describe, it, expect } from 'vitest';
import { setupAiMocks, aiRequest, badJsonRequest, readJson, TEST, VPC_SQL } from './harness';
import { POST, GET } from '@/app/api/ai/route';

const mocks = setupAiMocks();

const BASE_SYSTEM_PROMPT = `You are AWSops AI Assistant, an expert in AWS cloud operations.
You help users understand and manage their AWS infrastructure.
You have access to real-time AWS resource data via Steampipe queries.
When users ask about their resources, analyze the data provided.
Always be concise and provide actionable insights.
Format responses in markdown for readability.
When discussing security issues, prioritize them by severity.`;
const SYSTEM = {
  none: BASE_SYSTEM_PROMPT + '\nRespond in the same language as the user\'s question.',
  en: BASE_SYSTEM_PROMPT + '\nAlways respond in English regardless of the input language.',
  ko: BASE_SYSTEM_PROMPT + '\nAlways respond in Korean (한국어) regardless of the input language.',
  zh: BASE_SYSTEM_PROMPT + '\nAlways respond in Simplified Chinese (简体中文) regardless of the input language.',
};
const CODE_SUFFIX = `\n\nThe user wants to execute code. If they provide code, wrap it in a \`\`\`python code block. If they describe a task, generate Python code to accomplish it and wrap it in a \`\`\`python code block. Always include print statements to show results.`;
const SYNTH_SUFFIX = `\n\nYou are synthesizing answers from multiple AWS service agents. Combine them into one coherent, well-structured response. Do not repeat information.`;

const user = (content: string) => [{ role: 'user', content }];

async function postJson(body: Record<string, unknown>) {
  return readJson(await POST(aiRequest({ stream: false, ...body })));
}

function expectNoStats() {
  expect(mocks.recordCall).not.toHaveBeenCalled();
  expect(mocks.saveConversation).not.toHaveBeenCalled();
}

describe('/api/ai JSON path (characterization)', () => {
  it('validationRejectsBadJsonAndEmptyMessages', async () => {
    const bad = await readJson(await POST(badJsonRequest()));
    expect(bad).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });

    for (const body of [{}, { messages: [] }, { messages: 'hi' }, { messages: [], stream: true }]) {
      const res = await readJson(await POST(aiRequest(body)));
      expect(res).toEqual({ status: 400, body: { error: 'Messages required' } });
    }
    expect(mocks.bedrockSend).not.toHaveBeenCalled();
    expect(mocks.agentSend).not.toHaveBeenCalled();
  });

  it('getReturnsModelLabel', async () => {
    const res = await readJson(await GET());
    expect(res).toEqual({ status: 200, body: { model: 'test-label' } });
  });

  it('classifyParsesMultiSingleInvalidAndFallsBackToGeneral', async () => {
    // Classification request shape: model, max_tokens 100, last 10 messages only.
    const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    mocks.bedrock.classify('{"route": "security"}');
    mocks.agent.reply('SEC ANSWER');
    let res = await postJson({ messages: many });
    const cls = mocks.bedrock.calls('classify')[0];
    expect(cls.input.modelId).toBe('test-model-id');
    expect(cls.input.contentType).toBe('application/json');
    expect(cls.input.accept).toBe('application/json');
    expect(cls.body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(cls.body.max_tokens).toBe(100);
    expect(cls.body.messages).toEqual(many.slice(-10));
    expect(cls.system.startsWith('You are an intent classifier for an AWS operations dashboard.')).toBe(true);
    expect(cls.system.endsWith('Respond with ONLY a JSON object: {"routes": ["<route>"]} or {"routes": ["<route1>", "<route2>"]}')).toBe(true);
    // Single-route form {"route": "x"} is accepted.
    expect(res.body.route).toBe('security');
    expect(res.body.routes).toEqual(['security']);

    // Multi form: unknown routes filtered out BEFORE capping at 3; order kept.
    mocks.bedrock.clearCalls();
    mocks.bedrock.classify('Sure: {"routes": ["network", "bogus", "cost", "security", "iac"]}');
    mocks.agent.reply('ANSWER');
    mocks.bedrock.text('SYNTH');
    res = await postJson({ messages: user('q') });
    expect(res.body.route).toBe('network');
    expect(res.body.routes).toEqual(['network', 'cost', 'security']);

    // Multi form with no valid route falls through to single-form match, then to general.
    for (const raw of ['{"routes": ["bogus"]}', 'not json at all', '{"route": "bogus"}', '']) {
      mocks.bedrock.classify(raw);
      mocks.agent.reply('GENERAL ANSWER');
      res = await postJson({ messages: user('q') });
      expect(res.body.route).toBe('general');
      expect(res.body.routes).toEqual(['general']);
      expect(res.body.via).toBe('AgentCore → Ops Gateway (9 tools)');
    }

    // Classifier throws → general.
    mocks.bedrock.fail('classify', new Error('throttled'));
    mocks.agent.reply('GENERAL ANSWER');
    res = await postJson({ messages: user('q') });
    expect(res.status).toBe(200);
    expect(res.body.routes).toEqual(['general']);
    expect(res.body.content).toBe('GENERAL ANSWER');
    expectNoStats();
  });

  it('jsonCodeVia', async () => {
    // No python block anywhere → 'Bedrock (code)', no execution.
    mocks.bedrock.classify(['code']);
    mocks.bedrock.text('Here is an explanation without code.');
    let res = await postJson({ messages: user('calculate something') });
    expect(res).toEqual({
      status: 200,
      body: {
        content: 'Here is an explanation without code.', model: 'test-label',
        via: 'Bedrock (code)', queriedResources: [], usedTools: [], route: 'code', routes: ['code'],
      },
    });
    const gen = mocks.bedrock.calls('text')[0];
    expect(gen.input.modelId).toBe('test-model-id');
    expect(gen.body.max_tokens).toBe(4096);
    expect(gen.system).toBe(SYSTEM.none + CODE_SUFFIX);
    expect(mocks.agent.calls()).toEqual([]);

    // Python block in the reply → Code Interpreter runs it; block appended.
    mocks.bedrock.text('Run this:\n```python\nprint(1)\n```\n');
    mocks.agent.codeOutput('1\n');
    res = await postJson({ messages: user('run it'), lang: 'en' });
    expect(res.body).toEqual({
      content: 'Run this:\n```python\nprint(1)\n```\n' + '\n\n---\n**Code Execution Result** (exit code: 0):\n```\n1\n\n```',
      model: 'test-label', via: 'Bedrock + Code Interpreter', queriedResources: ['code-interpreter'],
      usedTools: [], route: 'code', routes: ['code'],
    });
    expect(mocks.bedrock.calls('text')[1].system).toBe(SYSTEM.en + CODE_SUFFIX);
    const ci = mocks.agent.calls();
    expect(ci.map(c => c.name)).toEqual([
      'StartCodeInterpreterSessionCommand', 'InvokeCodeInterpreterCommand', 'StopCodeInterpreterSessionCommand',
    ]);
    expect(ci[0].input).toEqual({ codeInterpreterIdentifier: TEST.codeInterpreter });
    expect(ci[1].input).toEqual({
      codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1',
      name: 'executeCode', arguments: { code: 'print(1)', language: 'python' },
    });
    expect(ci[2].input).toEqual({ codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1' });

    // Python block only in the user's message is also executed.
    mocks.bedrock.text('ok');
    res = await postJson({ messages: user('```python\nx = 2\n```') });
    expect(res.body.via).toBe('Bedrock + Code Interpreter');
    expect(mocks.agent.calls('InvokeCodeInterpreterCommand')[1].input.arguments).toEqual({ code: 'x = 2', language: 'python' });
    expectNoStats();
  });

  it('topologyDefaultLanguagePerPath (JSON half): no lang gives Korean', async () => {
    const vpcs = [
      { vpc_id: 'vpc-1', name: 'main', cidr: '10.0.0.0/16' },
      { vpc_id: 'vpc-2', name: null, cidr: '10.1.0.0/16' },
    ];
    mocks.bedrock.classify(['topology']);
    mocks.steampipe.vpcs({ rows: vpcs });
    mocks.bedrock.topology({ vpc_id: 'vpc-1', include_empty: true });
    let res = await postJson({ messages: user('main 구성도'), accountId: TEST.accountId });
    expect(res.body).toEqual({
      content: '**main** (10.0.0.0/16) AWSops 토폴로지를 준비했습니다. 빈 서브넷도 포함했습니다.\n\n➡️ [토폴로지뷰 열기](/topology-view?vpc=vpc-1&empty=1)',
      model: 'test-label', via: 'Topology View', queriedResources: ['steampipe'], usedTools: [],
      route: 'topology', routes: ['topology'],
    });
    expect(mocks.runQuery).toHaveBeenCalledWith(VPC_SQL, { accountId: TEST.accountId });
    const topo = mocks.bedrock.calls('topology')[0];
    expect(topo.body.max_tokens).toBe(200);
    expect(topo.system).toContain(JSON.stringify(vpcs));

    // lang 'en' → English; 'zh' → Korean (JSON uses lang === 'en').
    mocks.bedrock.topology({ vpc_id: 'vpc-1', include_empty: false });
    res = await postJson({ messages: user('show main'), lang: 'en' });
    expect(res.body.content).toBe('Prepared the AWSops topology for **main** (10.0.0.0/16).\n\n➡️ [Open Topology View](/topology-view?vpc=vpc-1)');
    res = await postJson({ messages: user('show main'), lang: 'zh' });
    expect(res.body.content).toBe('**main** (10.0.0.0/16) AWSops 토폴로지를 준비했습니다.\n\n➡️ [토폴로지뷰 열기](/topology-view?vpc=vpc-1)');

    // Unresolved VPC → Korean picker table (no lang).
    mocks.bedrock.topology({ vpc_id: null });
    res = await postJson({ messages: user('구성도') });
    expect(res.body.content).toBe(
      '여러 VPC가 있습니다 — 어느 VPC를 보시겠어요?\n\n| 이름 | VPC ID | CIDR | 토폴로지 |\n|---|---|---|---|\n'
      + '| main | `vpc-1` | 10.0.0.0/16 | [열기](/topology-view?vpc=vpc-1) |\n'
      + '| - | `vpc-2` | 10.1.0.0/16 | [열기](/topology-view?vpc=vpc-2) |',
    );

    // VPC query error → Korean error text, still a successful topology answer.
    mocks.steampipe.vpcs({ rows: [], error: 'conn refused' });
    res = await postJson({ messages: user('구성도') });
    expect(res.body.content).toBe('VPC 목록을 불러오지 못했습니다 (conn refused). 토폴로지뷰 탭에서 직접 확인해주세요: [/topology-view](/topology-view)');
    expect(res.body.via).toBe('Topology View');
    expectNoStats();
  });

  it('jsonDatasourceUses80RowsNoUrlAndBedrockFallback', async () => {
    const ds = { id: 'd1', name: 'Prod Prom', type: 'prometheus', url: 'http://prom.internal:9090', createdAt: '', updatedAt: '' };
    const rows = Array.from({ length: 120 }, (_, i) => ({ i }));
    mocks.datasource.set('prometheus', ds);
    mocks.bedrock.classify(['datasource']);
    mocks.bedrock.dsQuery('```promql\nup\n```');
    mocks.datasource.result({ columns: ['i'], rows, metadata: { totalRows: 120 } });
    mocks.bedrock.text('DS ANALYSIS');
    const q = 'prometheus cpu usage';
    let res = await postJson({ messages: user(q) });
    expect(res.body).toEqual({
      content: 'DS ANALYSIS', model: 'test-label', via: 'Datasource Analytics: Prometheus (120 rows)',
      queriedResources: ['prometheus'], usedTools: ['prometheus: up'], route: 'datasource', routes: ['datasource'],
    });
    expect(mocks.queryDatasource).toHaveBeenCalledWith(ds, 'up', { start: '1h' });
    const gen = mocks.bedrock.calls('dsQuery')[0];
    expect(gen.body.max_tokens).toBe(300);
    expect(gen.input.modelId).toBe('test-model-id');
    const analysis = mocks.bedrock.calls('text')[0];
    expect(analysis.input.modelId).toBe('test-model-id');
    expect(analysis.system).toBe(SYSTEM.none);
    expect(analysis.body.max_tokens).toBe(4096);
    const last = analysis.body.messages[analysis.body.messages.length - 1].content;
    expect(last).toBe(q + '\n\n' + '--- LIVE PROMETHEUS DATA (120 rows) ---\nDatasource: Prod Prom\nPromQL: up\n'
      + '```json\n' + JSON.stringify(rows.slice(0, 80), null, 2) + '\n```');
    expect(last).not.toContain('prom.internal');

    // Unknown modelKey → InvokeModel modelId undefined (no fallback on the JSON datasource path).
    mocks.bedrock.clearCalls();
    res = await postJson({ messages: user(q), model: 'no-such-model' });
    expect(res.body.content).toBe('DS ANALYSIS');
    expect(mocks.bedrock.calls('text')[0].input.modelId).toBeUndefined();
    // ...while a known legacy key resolves to the configured model.
    mocks.bedrock.clearCalls();
    await postJson({ messages: user(q), model: 'sonnet-4.6' });
    expect(mocks.bedrock.calls('text')[0].input.modelId).toBe('test-model-id');

    // Query fails twice (with one regenerated query) → null → Bedrock Direct fallback.
    mocks.bedrock.clearCalls();
    mocks.queryDatasource.mockClear();
    mocks.bedrock.dsQuery('bad_query', 'still_bad');
    mocks.datasource.result(new Error('parse error'));
    mocks.bedrock.text('FALLBACK ANSWER');
    res = await postJson({ messages: user(q), model: 'no-such-model' });
    expect(res.body).toEqual({
      content: 'FALLBACK ANSWER', model: 'test-label', via: 'Bedrock Direct (fallback)',
      queriedResources: [], route: 'datasource', routes: ['datasource'],
    });
    expect('usedTools' in res.body).toBe(false);
    expect(mocks.queryDatasource.mock.calls.map(c => c[1])).toEqual(['bad_query', 'still_bad']);
    const regen = mocks.bedrock.calls('dsQuery')[1].body.messages;
    expect(regen.slice(-2)).toEqual([
      { role: 'assistant', content: 'I generated this PromQL query: bad_query' },
      { role: 'user', content: 'That query failed with error: parse error. Fix the query.' },
    ]);
    const fb = mocks.bedrock.calls('text')[0];
    expect(fb.input.modelId).toBe('test-model-id'); // fallback resolves unknown modelKey
    expect(fb.system).toBe(SYSTEM.none);
    expect(fb.body.messages).toEqual(user(q));

    // No datasource type detected → fallback; datasource not configured → fallback.
    mocks.bedrock.text('FB2');
    res = await postJson({ messages: user('hello there') });
    expect(res.body.via).toBe('Bedrock Direct (fallback)');
    mocks.datasource.set('prometheus', undefined);
    res = await postJson({ messages: user(q) });
    expect(res.body.via).toBe('Bedrock Direct (fallback)');
    expect(res.body.content).toBe('FB2');
    expectNoStats();
  });

  it('autoCollectErrorPaths (JSON half): collect(fn, acct, true); on error Bedrock fallback', async () => {
    const c = mocks.collectorMock('eks-optimize');
    mocks.bedrock.classify(['eks-optimize']);
    mocks.bedrock.text('EKS ANALYSIS');
    let res = await postJson({ messages: user('EKS 비용 최적화'), accountId: TEST.accountId, lang: 'ko' });
    expect(res.body).toEqual({
      content: 'EKS ANALYSIS', model: 'test-label', via: 'Collector Via Summary',
      queriedResources: ['collector-resource'], usedTools: ['collector-tool'],
      route: 'eks-optimize', routes: ['eks-optimize'],
    });
    expect(c.collect).toHaveBeenCalledTimes(1);
    expect(c.collect).toHaveBeenCalledWith(expect.any(Function), TEST.accountId, true);
    const noop = c.collect.mock.calls[0][0] as (...a: unknown[]) => unknown;
    expect(noop('status', { x: 1 })).toBeUndefined();
    expect(c.formatContext).toHaveBeenCalledWith(TEST.collectorData);
    const call = mocks.bedrock.calls('text')[0];
    expect(call.system).toBe('ANALYSIS PROMPT eks-optimize');
    expect(call.body.max_tokens).toBe(8192);
    expect(call.input.modelId).toBe('test-model-id');
    expect(call.body.messages).toEqual([{ role: 'user', content: 'EKS 비용 최적화\n\nCTX:eks-optimize' }]);

    // Invalid accountId is dropped before reaching the collector; unknown modelKey → modelId undefined.
    mocks.bedrock.clearCalls();
    res = await postJson({ messages: user('EKS 비용 최적화'), accountId: 'abc', model: 'nope' });
    expect(c.collect).toHaveBeenLastCalledWith(expect.any(Function), undefined, true);
    expect(mocks.bedrock.calls('text')[0].input.modelId).toBeUndefined();

    // Collector throws → handler returns null → Bedrock Direct fallback (no status events, no stats).
    mocks.bedrock.clearCalls();
    c.collect.mockRejectedValueOnce(new Error('prometheus down'));
    mocks.bedrock.text('FALLBACK');
    res = await postJson({ messages: user('EKS 비용 최적화'), lang: 'zh' });
    expect(res.body).toEqual({
      content: 'FALLBACK', model: 'test-label', via: 'Bedrock Direct (fallback)',
      queriedResources: [], route: 'eks-optimize', routes: ['eks-optimize'],
    });
    expect(mocks.bedrock.calls('text')).toHaveLength(1);
    expect(mocks.bedrock.calls('text')[0].system).toBe(SYSTEM.zh);
    expect(mocks.agent.calls()).toEqual([]);

    // Analysis Bedrock call throws → also null → fallback.
    mocks.bedrock.text(new Error('bedrock 500'), 'FALLBACK 2');
    res = await postJson({ messages: user('EKS 비용 최적화') });
    expect(res.body.via).toBe('Bedrock Direct (fallback)');
    expect(res.body.content).toBe('FALLBACK 2');

    // Each auto-collect route resolves to its own collector module.
    for (const route of ['db-optimize', 'msk-optimize', 'idle-scan', 'trace-analyze', 'incident'] as const) {
      mocks.bedrock.classify([route]);
      mocks.bedrock.text(`ANALYSIS ${route}`);
      res = await postJson({ messages: user('q') });
      expect(res.body.content).toBe(`ANALYSIS ${route}`);
      expect(mocks.collectorMock(route).collect).toHaveBeenCalledWith(expect.any(Function), undefined, true);
    }
    expectNoStats();
  });

  it('jsonSqlUsedToolsEmpty, plus a failure goes to the AgentCore ops gateway', async () => {
    const rows = [{ instance_id: 'i-1', name: 'web' }];
    mocks.bedrock.classify(['aws-data']);
    mocks.bedrock.sql('```sql\nSELECT instance_id FROM aws_ec2_instance\n```');
    mocks.steampipe.result({ rows });
    // Content full of tool keywords — JSON still reports usedTools: [].
    mocks.bedrock.text('IAM user list, cost, metric, VPC 목록');
    let res = await postJson({ messages: user('EC2 목록'), accountId: TEST.accountId });
    expect(res.body).toEqual({
      content: 'IAM user list, cost, metric, VPC 목록', model: 'test-label',
      via: 'Bedrock + Steampipe SQL (1 rows)', queriedResources: ['steampipe'], usedTools: [],
      route: 'aws-data', routes: ['aws-data'],
    });
    expect(mocks.runQuery).toHaveBeenCalledWith('SELECT instance_id FROM aws_ec2_instance', { accountId: TEST.accountId });
    const gen = mocks.bedrock.calls('sql')[0];
    expect(gen.body.max_tokens).toBe(500);
    expect(gen.system.endsWith('\n\nNote: Query targets AWS account Prod. The search_path is already set for this account, so use standard table names (no account prefix needed).')).toBe(true);
    const analysis = mocks.bedrock.calls('text')[0];
    expect(analysis.system).toBe(SYSTEM.none);
    expect(analysis.body.max_tokens).toBe(4096);
    expect(analysis.body.messages).toEqual([{
      role: 'user',
      content: 'EC2 목록\n\n--- LIVE AWS RESOURCE DATA (1 rows) ---\nSQL: SELECT instance_id FROM aws_ec2_instance\n```json\n'
        + JSON.stringify(rows, null, 2) + '\n```',
    }]);

    // Empty analysis text → content '' (JSON has no 'No response' default here).
    mocks.bedrock.text('');
    res = await postJson({ messages: user('EC2 목록') });
    expect(res.body.content).toBe('');
    expect(res.body.via).toBe('Bedrock + Steampipe SQL (1 rows)');

    // Zero rows is a success: data 'No results found.', 0 rows.
    mocks.bedrock.clearCalls();
    mocks.steampipe.result({ rows: [] });
    mocks.bedrock.text('none');
    res = await postJson({ messages: user('EC2 목록') });
    expect(res.body.via).toBe('Bedrock + Steampipe SQL (0 rows)');
    expect(mocks.bedrock.calls('text')[0].body.messages[0].content).toContain('```json\nNo results found.\n```');

    // First query errors → regenerate with fix messages → second succeeds.
    mocks.bedrock.clearCalls();
    mocks.runQuery.mockClear();
    mocks.bedrock.sql('SELECT bad FROM aws_vpc', 'SELECT vpc_id FROM aws_vpc');
    mocks.steampipe.result({ rows: [], error: 'column "bad" does not exist' }, { rows: [{ vpc_id: 'vpc-1' }] });
    mocks.bedrock.text('VPC ANALYSIS');
    res = await postJson({ messages: user('VPC 목록') });
    expect(res.body.via).toBe('Bedrock + Steampipe SQL (1 rows)');
    expect(mocks.runQuery.mock.calls.map(c => c[0])).toEqual(['SELECT bad FROM aws_vpc', 'SELECT vpc_id FROM aws_vpc']);
    expect(mocks.runQuery.mock.calls[0][1]).toEqual({ accountId: undefined });
    expect(mocks.bedrock.calls('sql')[1].body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'I generated this SQL: SELECT bad FROM aws_vpc' },
      { role: 'user', content: 'That SQL failed with error: column "bad" does not exist. Fix the SQL using only valid column names.' },
    ]);
    expect(mocks.bedrock.calls('sql')[1].system.includes('Note: Query targets')).toBe(false);

    // SQL generation yields a non-SELECT → falls through to the AgentCore 'ops' gateway.
    mocks.bedrock.sql('I cannot write that query');
    mocks.agent.reply('<tool_call>{"name": "run_steampipe_query"}</tool_call>\nOps answer');
    res = await postJson({ messages: user('EC2 목록'), accountId: TEST.accountId });
    expect(res.body).toEqual({
      content: 'Ops answer', model: 'test-label', via: 'AgentCore → Bedrock + Steampipe SQL',
      queriedResources: ['ops-gateway'], usedTools: ['run_steampipe_query'],
      route: 'aws-data', routes: ['aws-data'],
    });
    const inv = mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!;
    expect(inv.input.agentRuntimeArn).toBe(TEST.runtimeArn);
    expect(inv.input.qualifier).toBe('DEFAULT');
    expect(inv.payload).toEqual({
      messages: user('EC2 목록'), gateway: 'ops', accountId: TEST.accountId, accountAlias: 'Prod',
    });

    // Both queries error → also AgentCore 'ops'; AgentCore null too → Bedrock Direct fallback.
    mocks.bedrock.sql('SELECT a FROM t', 'SELECT b FROM t');
    mocks.steampipe.result({ rows: [], error: 'e1' }, { rows: [], error: 'e2' });
    mocks.agent.reply(new Error('agent down'));
    mocks.bedrock.text('FB');
    res = await postJson({ messages: user('EC2 목록') });
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload.gateway).toBe('ops');
    expect(res.body).toEqual({
      content: 'FB', model: 'test-label', via: 'Bedrock Direct (fallback)', queriedResources: [],
      route: 'aws-data', routes: ['aws-data'],
    });
    expectNoStats();
  });

  it('jsonGatewaySuccessAndFallback', async () => {
    mocks.bedrock.classify(['security']);
    mocks.agent.reply('<tool_call>{"name": "list_users"}</tool_call>\n<tool_response>{"users": 3}</tool_response>\nThere are 3 IAM users.');
    let res = await postJson({ messages: user('IAM 사용자 점검'), accountId: TEST.accountId });
    expect(res.body).toEqual({
      content: 'There are 3 IAM users.', model: 'test-label', via: 'AgentCore → Security Gateway (14 tools)',
      queriedResources: ['security-gateway'], usedTools: ['list_users'], route: 'security', routes: ['security'],
    });
    const calls = mocks.agent.calls();
    expect(calls.map(c => c.name)).toEqual(['InvokeAgentRuntimeCommand', 'StopRuntimeSessionCommand']);
    expect(calls[0].payload).toEqual({ messages: user('IAM 사용자 점검'), gateway: 'security', accountId: TEST.accountId, accountAlias: 'Prod' });
    expect(calls[1].input).toEqual({ agentRuntimeArn: TEST.runtimeArn, runtimeSessionId: 'runtime-session-1', qualifier: 'DEFAULT' });
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.reportAgentcoreInvoke.mock.calls[0][1]).toBe('success');

    // JSON-quoted AgentCore body is unwrapped; skill is passed for datasource-diag; last 10 messages.
    const many = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    mocks.bedrock.classify(['datasource-diag']);
    mocks.agent.reply(JSON.stringify('quoted answer'));
    res = await postJson({ messages: many });
    expect(res.body.content).toBe('quoted answer');
    expect(res.body.via).toBe('AgentCore → Datasource Diagnostics (8 tools)');
    expect(res.body.queriedResources).toEqual(['monitoring-gateway']);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload).toEqual({
      messages: many.slice(-10), gateway: 'monitoring', accountId: '', accountAlias: '', skill: 'diagnostics',
    });

    // AgentCore error → reported as error → Bedrock Direct fallback (no usedTools key).
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.bedrock.clearCalls();
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
    mocks.bedrock.text('FALLBACK ANSWER');
    res = await postJson({ messages: user('IAM 사용자 점검'), lang: 'ko', model: 'whatever' });
    expect(res.body).toEqual({
      content: 'FALLBACK ANSWER', model: 'test-label', via: 'Bedrock Direct (fallback)',
      queriedResources: [], route: 'security', routes: ['security'],
    });
    expect('usedTools' in res.body).toBe(false);
    expect(mocks.reportAgentcoreInvoke.mock.calls.map(c => c.slice(1))).toEqual([['error', 'ServiceUnavailable: boom']]);
    const fb = mocks.bedrock.calls('text')[0];
    expect(fb.system).toBe(SYSTEM.ko);
    expect(fb.input.modelId).toBe('test-model-id');
    expect(fb.body.max_tokens).toBe(4096);

    // ValidationException is not reported; empty fallback text → 'No response'.
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.agent.reply(Object.assign(new Error('bad payload'), { name: 'ValidationException' }));
    mocks.bedrock.text('');
    res = await postJson({ messages: user('IAM 사용자 점검') });
    expect(res.body.content).toBe('No response');
    expect(res.body.via).toBe('Bedrock Direct (fallback)');
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();

    // Empty AgentCore body counts as failure (falsy) → fallback, and is not reported as success.
    mocks.agent.reply('');
    mocks.bedrock.text('FB3');
    res = await postJson({ messages: user('IAM 사용자 점검') });
    expect(res.body.content).toBe('FB3');
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expectNoStats();
  });

  it('multiRouteOutcomes (JSON half)', async () => {
    const answers: Record<string, string> = { security: 'SEC ANSWER', cost: 'COST ANSWER' };
    const q = '보안과 비용 분석';

    // 2 successes → InvokeModel synthesis.
    mocks.bedrock.classify(['security', 'cost']);
    mocks.agent.reply((p: any) => answers[p.gateway]);
    mocks.bedrock.text('SYNTHESIZED');
    let res = await postJson({ messages: user(q), lang: 'en' });
    expect(res.body).toEqual({
      content: 'SYNTHESIZED', model: 'test-label',
      via: 'Multi-Route: AgentCore → Security Gateway (14 tools) + AgentCore → Cost Gateway (9 tools)',
      queriedResources: ['security-gateway', 'cost-gateway'], route: 'security', routes: ['security', 'cost'],
    });
    expect('usedTools' in res.body).toBe(false);
    expect(mocks.bedrock.calls('converse')).toEqual([]);
    expect(mocks.bedrock.calls('stream')).toEqual([]);
    const synth = mocks.bedrock.calls('text');
    expect(synth).toHaveLength(1);
    expect(synth[0].input.modelId).toBe('test-model-id');
    expect(synth[0].system).toBe(SYSTEM.en + SYNTH_SUFFIX);
    expect(synth[0].body.max_tokens).toBe(4096);
    expect(synth[0].body.messages).toEqual([{
      role: 'user',
      content: `Question: ${q}\n\nMultiple agents responded:\n\n--- AgentCore → Security Gateway (14 tools) ---\nSEC ANSWER\n\n--- AgentCore → Cost Gateway (9 tools) ---\nCOST ANSWER\n\nPlease synthesize into one comprehensive answer.`,
    }]);
    // One shared requestId across every AgentCore call of the request.
    const ids1 = mocks.reportAgentcoreInvoke.mock.calls.map(c => c[0]);
    expect(ids1).toHaveLength(2);
    expect(new Set(ids1).size).toBe(1);
    expect(mocks.reportAgentcoreInvoke.mock.calls.map(c => c[1])).toEqual(['success', 'success']);

    // Empty synthesis text → contents joined with '\n\n---\n\n'.
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.bedrock.text('');
    res = await postJson({ messages: user(q) });
    expect(res.body.content).toBe('SEC ANSWER\n\n---\n\nCOST ANSWER');
    const ids2 = mocks.reportAgentcoreInvoke.mock.calls.map(c => c[0]);
    expect(new Set(ids2).size).toBe(1);
    expect(ids2[0]).not.toBe(ids1[0]); // a new request gets a new id

    // 1 success → returned directly, no synthesis.
    mocks.bedrock.clearCalls();
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.agent.reply((p: any) => {
      if (p.gateway === 'cost') throw new Error('cost down');
      return answers[p.gateway];
    });
    res = await postJson({ messages: user(q) });
    expect(res.body).toEqual({
      content: 'SEC ANSWER', model: 'test-label', via: 'AgentCore → Security Gateway (14 tools)',
      queriedResources: ['security-gateway'], route: 'security', routes: ['security', 'cost'],
    });
    expect(mocks.bedrock.calls('text')).toEqual([]);
    const outcomes = mocks.reportAgentcoreInvoke.mock.calls;
    expect(outcomes.map(c => c[1]).sort()).toEqual(['error', 'success']);
    expect(new Set(outcomes.map(c => c[0])).size).toBe(1);

    // 0 successes → fixed message, no Bedrock fallback.
    mocks.bedrock.clearCalls();
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.agent.reply(new Error('all down'));
    res = await postJson({ messages: user(q) });
    expect(res).toEqual({
      status: 200,
      body: {
        content: 'All routes failed. Please try again.', model: 'test-label',
        via: 'Multi-route (all failed)', queriedResources: [], route: 'security', routes: ['security', 'cost'],
      },
    });
    expect(mocks.bedrock.calls('text')).toEqual([]);
    expect(mocks.reportAgentcoreInvoke.mock.calls.map(c => c[1])).toEqual(['error', 'error']);
    expect(new Set(mocks.reportAgentcoreInvoke.mock.calls.map(c => c[0])).size).toBe(1);

    // A participant that throws (code handler, uncaught) is just a failed route.
    mocks.bedrock.classify(['code', 'security']);
    mocks.bedrock.text(new Error('code gen failed'));
    mocks.agent.reply('SEC ONLY');
    res = await postJson({ messages: user(q) });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('SEC ONLY');
    expect(res.body.routes).toEqual(['code', 'security']);
    expectNoStats();
  });

  it('jsonThrowGives500', async () => {
    // Uncaught throw inside the single-route handler (code path) → 500 with the message.
    mocks.bedrock.classify(['code']);
    mocks.bedrock.text(new Error('bedrock down'));
    let res = await postJson({ messages: user('run code') });
    expect(res).toEqual({ status: 500, body: { error: 'bedrock down' } });

    // Fallback Bedrock call throws → 500; empty message → 'AI request failed'.
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(new Error('agent down'));
    mocks.bedrock.text(new Error(''));
    res = await postJson({ messages: user('q') });
    expect(res).toEqual({ status: 500, body: { error: 'AI request failed' } });
    expectNoStats();
  });
});
