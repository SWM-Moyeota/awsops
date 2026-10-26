// Characterization tests — streaming (SSE) single-route path of /api/ai. FROZEN after Task 2: do not edit.
// 특성 테스트 — /api/ai 스트리밍(SSE) 단일 라우트 경로. 현재 동작을 그대로 고정한다. 바꿔야 한다면 동작이 바뀐 것이다.
import { describe, it, expect, vi } from 'vitest';
import { setupAiMocks, aiRequest, readSse, sseEvents, TEST, VPC_SQL } from './harness';
import { POST } from '@/app/api/ai/route';
import { DATASOURCE_QUERY_PROMPTS } from '@/lib/datasource-prompts';

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
};
const CODE_SUFFIX = `\n\nThe user wants to execute code. If they provide code, wrap it in a \`\`\`python code block. If they describe a task, generate Python code to accomplish it and wrap it in a \`\`\`python code block. Always include print statements to show results.`;
const CORRELATION_HINT = '\n\nIMPORTANT: The user asked about multiple datasources. Provide cross-source correlation analysis — identify patterns, correlations, and potential root causes across the different data sources.';

type Ev = [string, any];
const user = (content: string) => [{ role: 'user', content }];

async function postSse(body: Record<string, unknown>): Promise<Ev[]> {
  return readSse(await POST(aiRequest({ stream: true, ...body })));
}

const CLASSIFYING: Record<string, string> = {
  en: '🔍 Analyzing question...', ko: '🔍 질문 분석 중...', zh: '🔍 正在分析问题...',
};
const classifying = (lang = 'en'): Ev => ['status', { step: 'classifying', message: CLASSIFYING[lang] }];
const classified = (route: string, display: string): Ev =>
  ['status', { step: 'classified', route, display, message: `📡 Connecting to ${display}...` }];
const agentcoreStatus = (display: string): Ev =>
  ['status', { step: 'agentcore', message: `🤖 Calling ${display} tools...` }];
const chunk = (delta: string): Ev => ['chunk', { delta }];
/** simulateStreaming splits AgentCore text into 50-character chunks. */
const simChunks = (text: string): Ev[] => {
  const out: Ev[] = [];
  for (let i = 0; i < text.length; i += 50) out.push(chunk(text.slice(i, i + 50)));
  return out;
};

function expectRecorded(p: Record<string, unknown>) {
  expect(mocks.recordCall).toHaveBeenCalledTimes(1);
  expect(mocks.recordCall.mock.calls[0][0]).toEqual({
    timestamp: expect.any(String), responseTimeMs: expect.any(Number), model: 'test-label', ...p,
  });
}
function expectNoStats() {
  expect(mocks.recordCall).not.toHaveBeenCalled();
  expect(mocks.saveConversation).not.toHaveBeenCalled();
}

/** LOCAL helper: make the Bedrock streaming call yield `deltas` then throw `err` (harness has no mid-stream throw). */
function bedrockStreamThrowsMidway(deltas: string[], err: Error) {
  const impl = mocks.bedrockSend.getMockImplementation()!;
  mocks.bedrockSend.mockImplementation(async (cmd: any) => {
    if (cmd?.constructor?.name !== 'InvokeModelWithResponseStreamCommand') return impl(cmd);
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    async function* body() {
      for (const t of deltas) yield { chunk: { bytes: enc({ type: 'content_block_delta', delta: { text: t } }) } };
      throw err;
    }
    return { body: body() };
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('/api/ai streaming single-route path (characterization)', () => {
  it('streamClassifiedPayloads', async () => {
    // Single route: headers + classifying/classified payloads (display key, no routes key).
    mocks.bedrock.classify(['security']);
    mocks.agent.reply('ok');
    const res = await POST(aiRequest({ stream: true, messages: user('IAM 점검') }));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    let ev = await readSse(res);
    expect(ev.slice(0, 2)).toEqual([classifying(), classified('security', 'Security Gateway (14 tools)')]);

    // Language variants of the same two events.
    ev = await postSse({ messages: user('IAM 점검'), lang: 'ko' });
    expect(ev.slice(0, 2)).toEqual([
      classifying('ko'),
      ['status', { step: 'classified', route: 'security', display: 'Security Gateway (14 tools)', message: '📡 Security Gateway (14 tools) 연결 중...' }],
    ]);
    ev = await postSse({ messages: user('IAM 점검'), lang: 'zh' });
    expect(ev.slice(0, 2)).toEqual([
      classifying('zh'),
      ['status', { step: 'classified', route: 'security', display: 'Security Gateway (14 tools)', message: '📡 正在连接 Security Gateway (14 tools)...' }],
    ]);

    // Multi route: routes key, no display key, joined display names.
    mocks.bedrock.classify(['network', 'cost']);
    ev = await postSse({ messages: user('VPC and cost') });
    expect(ev.slice(0, 2)).toEqual([
      classifying(),
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
    ]);
    expect(ev.at(-1)![0]).toBe('done');
    ev = await postSse({ messages: user('VPC and cost'), lang: 'ko' });
    expect(ev[1]).toEqual(['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 멀티 라우트: Network Gateway (17 tools) + Cost Gateway (9 tools)' }]);
  });

  it('streamCodeWithAndWithoutPython', async () => {
    // No python block anywhere → 'Bedrock (code request)', no Code Interpreter, no stats, no routes key.
    mocks.bedrock.classify(['code']);
    mocks.bedrock.stream(['Explain ', 'only.']);
    const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    let ev = await postSse({ messages: many });
    expect(ev).toEqual([
      classifying(),
      classified('code', 'Code Interpreter'),
      ['status', { step: 'generating', message: '💻 Generating code...' }],
      chunk('Explain '), chunk('only.'),
      ['done', { content: 'Explain only.', model: 'test-label', via: 'Bedrock (code request)', queriedResources: [], route: 'code', inputTokens: 0, outputTokens: 0 }],
    ]);
    const gen = mocks.bedrock.calls('stream')[0];
    expect(gen.input.modelId).toBe('test-model-id');
    expect(gen.input.contentType).toBe('application/json');
    expect(gen.input.accept).toBe('application/json');
    expect(gen.body).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM.none + CODE_SUFFIX, messages: many.slice(-10) });
    expect(mocks.agent.calls()).toEqual([]);

    // Python block in the streamed reply → executing status, execution block chunk, Stop called.
    const reply = 'Run:\n```python\nprint(1)\n```';
    const block = '\n\n---\n**Code Execution Result** (exit code: 0):\n```\n1\n\n```';
    mocks.bedrock.stream([reply]);
    mocks.agent.codeOutput('1\n');
    ev = await postSse({ messages: user('run it'), lang: 'en', model: 'no-such-model' });
    expect(ev).toEqual([
      classifying(),
      classified('code', 'Code Interpreter'),
      ['status', { step: 'generating', message: '💻 Generating code...' }],
      chunk(reply),
      ['status', { step: 'executing', message: '⚡ Executing code...' }],
      chunk(block),
      ['done', { content: reply + block, model: 'test-label', via: 'Bedrock + Code Interpreter', queriedResources: ['code-interpreter'], route: 'code', inputTokens: 0, outputTokens: 0 }],
    ]);
    expect(mocks.bedrock.calls('stream')[1].system).toBe(SYSTEM.en + CODE_SUFFIX);
    expect(mocks.bedrock.calls('stream')[1].input.modelId).toBe('test-model-id'); // unknown modelKey resolves
    expect(mocks.agent.calls().map(c => [c.name, c.input])).toEqual([
      ['StartCodeInterpreterSessionCommand', { codeInterpreterIdentifier: TEST.codeInterpreter }],
      ['InvokeCodeInterpreterCommand', { codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1', name: 'executeCode', arguments: { code: 'print(1)', language: 'python' } }],
      ['StopCodeInterpreterSessionCommand', { codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1' }],
    ]);

    // Python block only in the user message; Invoke throws → 'Code execution failed', exit 1, Stop still called.
    mocks.agent.clearCalls();
    mocks.bedrock.stream(['I will run your code.']);
    const impl = mocks.agentSend.getMockImplementation()!;
    mocks.agentSend.mockImplementation(async (cmd: any) => {
      if (cmd?.constructor?.name === 'InvokeCodeInterpreterCommand') throw new Error('sandbox boom');
      return impl(cmd);
    });
    mocks.agentSend.mockClear();
    ev = await postSse({ messages: user('```python\nx = 2\n```') });
    const errBlock = '\n\n---\n**Code Execution Result** (exit code: 1):\n```\nCode execution failed: sandbox boom\n```';
    expect(ev.slice(3)).toEqual([
      chunk('I will run your code.'),
      ['status', { step: 'executing', message: '⚡ Executing code...' }],
      chunk(errBlock),
      ['done', { content: 'I will run your code.' + errBlock, model: 'test-label', via: 'Bedrock + Code Interpreter', queriedResources: ['code-interpreter'], route: 'code', inputTokens: 0, outputTokens: 0 }],
    ]);
    expect(mocks.agentSend.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      ['StartCodeInterpreterSessionCommand', { codeInterpreterIdentifier: TEST.codeInterpreter }],
      ['InvokeCodeInterpreterCommand', { codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1', name: 'executeCode', arguments: { code: 'x = 2', language: 'python' } }],
      ['StopCodeInterpreterSessionCommand', { codeInterpreterIdentifier: TEST.codeInterpreter, sessionId: 'ci-session-1' }],
    ]);
    mocks.agentSend.mockImplementation(impl);

    // Multi-route with code first → only the code handler runs (no AgentCore, no synthesis).
    mocks.agent.clearCalls();
    mocks.bedrock.clearCalls();
    mocks.bedrock.classify(['code', 'security']);
    mocks.bedrock.stream(['no code here']);
    ev = await postSse({ messages: user('calc and iam') });
    expect(ev).toEqual([
      classifying(),
      ['status', { step: 'classified', route: 'code', routes: ['code', 'security'], message: '📡 Multi-route: Code Interpreter + Security Gateway (14 tools)' }],
      ['status', { step: 'generating', message: '💻 Generating code...' }],
      chunk('no code here'),
      ['done', { content: 'no code here', model: 'test-label', via: 'Bedrock (code request)', queriedResources: [], route: 'code', inputTokens: 0, outputTokens: 0 }],
    ]);
    expect(mocks.agent.calls()).toEqual([]);
    expect(mocks.bedrock.calls().map(c => c.kind)).toEqual(['classify', 'stream']);
    expectNoStats();
  });

  it('topologyDefaultLanguagePerPath (stream half)', async () => {
    const vpc = { vpc_id: 'vpc-1', name: 'main', cidr: '10.0.0.0/16' };
    mocks.bedrock.classify(['topology'], { input: 3, output: 4 });
    mocks.bedrock.textUsage({ input: 100, output: 100 }); // topology InvokeModel tokens are NOT counted
    mocks.steampipe.vpcs({ rows: [vpc] });
    mocks.bedrock.topology({ vpc_id: 'vpc-1', include_empty: false });
    const resolving: Ev = ['status', { step: 'topology-resolving', message: '🗺️ Resolving target VPC...' }];
    const done = (content: string): Ev => ['done', {
      content, model: 'test-label', via: 'Topology View', queriedResources: ['steampipe'], route: 'topology', inputTokens: 3, outputTokens: 4,
    }];
    const EN = 'Prepared the AWSops topology for **main** (10.0.0.0/16).\n\n➡️ [Open Topology View](/topology-view?vpc=vpc-1)';

    // No lang → English (clientLang !== 'ko').
    let ev = await postSse({ messages: user('구성도 보여줘'), accountId: TEST.accountId });
    expect(ev).toEqual([classifying(), classified('topology', 'Topology View'), resolving, done(EN)]);
    expect(mocks.runQuery).toHaveBeenCalledWith(VPC_SQL, { accountId: TEST.accountId });
    const t = mocks.bedrock.calls('topology')[0];
    expect(t.body.max_tokens).toBe(200);
    expect(t.system).toContain(JSON.stringify([vpc]));

    // zh → also English content; status 'topologyResolving' is English for zh too.
    ev = await postSse({ messages: user('q'), lang: 'zh' });
    expect(ev.slice(2)).toEqual([resolving, done(EN)]);

    // ko → Korean.
    ev = await postSse({ messages: user('q'), lang: 'ko' });
    expect(ev.slice(2)).toEqual([
      ['status', { step: 'topology-resolving', message: '🗺️ 대상 VPC 확인 중...' }],
      done('**main** (10.0.0.0/16) AWSops 토폴로지를 준비했습니다.\n\n➡️ [토폴로지뷰 열기](/topology-view?vpc=vpc-1)'),
    ]);

    // include_empty → &empty=1 and the English empty note.
    mocks.bedrock.topology({ vpc_id: 'vpc-1', include_empty: true });
    ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)).toEqual(done('Prepared the AWSops topology for **main** (10.0.0.0/16). Empty subnets are included.\n\n➡️ [Open Topology View](/topology-view?vpc=vpc-1&empty=1)'));

    // VPC query error → English error text, no topology Bedrock call.
    mocks.bedrock.clearCalls();
    mocks.steampipe.vpcs({ rows: [], error: 'access denied' });
    ev = await postSse({ messages: user('q') });
    expect(ev).toEqual([classifying(), classified('topology', 'Topology View'), resolving,
      done('Could not load the VPC list (access denied). Please open the Topology View tab directly: [/topology-view](/topology-view)')]);
    expect(mocks.bedrock.calls('topology')).toEqual([]);

    // Zero VPCs → 'no VPCs found' error text.
    mocks.steampipe.vpcs({ rows: [] });
    ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)).toEqual(done('Could not load the VPC list (no VPCs found). Please open the Topology View tab directly: [/topology-view](/topology-view)'));
    expectNoStats();
  });

  it('streamDatasource', async () => {
    const prom = { id: 'd1', name: 'Prod Prom', type: 'prometheus', url: 'http://prom.internal:9090', createdAt: '', updatedAt: '' };
    const loki = { id: 'd2', name: 'Prod Loki', type: 'loki', url: 'http://loki.internal:3100', createdAt: '', updatedAt: '' };
    const rows = Array.from({ length: 120 }, (_, i) => ({ i }));
    const q = 'prometheus cpu usage';
    const display = 'Datasource Analytics';
    mocks.datasource.set('prometheus', prom);
    mocks.bedrock.classify(['datasource'], { input: 1, output: 2 });
    mocks.bedrock.dsQuery('```promql\nup\n```');
    mocks.datasource.result({ columns: ['i'], rows, metadata: { totalRows: 500 } });
    mocks.bedrock.stream(['DS ', 'ANALYSIS'], { input: 10, output: 20 });

    // Success: hardcoded-Korean statuses even with lang 'en'; 100 rows + ds.url in the context.
    let ev = await postSse({ messages: user(q), lang: 'en', model: 'no-such-model' });
    expect(ev).toEqual([
      classifying(),
      classified('datasource', display),
      ['status', { step: 'datasource-generating', message: 'Prometheus PromQL 쿼리 생성 중...' }],
      ['status', { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중...', query: 'up' }],
      ['status', { step: 'datasource-analyzing', message: '500건 결과 분석 중...' }], // metadata.totalRows wins
      chunk('DS '), chunk('ANALYSIS'),
      ['done', {
        content: 'DS ANALYSIS', model: 'test-label', via: 'Datasource Analytics: Prometheus (120 rows)',
        queriedResources: ['prometheus'], route: 'datasource', usedTools: ['prometheus: up'], inputTokens: 11, outputTokens: 22,
      }],
    ]);
    expect(mocks.queryDatasource).toHaveBeenCalledWith(prom, 'up', { start: '1h' });
    expect(mocks.bedrock.calls('dsQuery')[0].body.max_tokens).toBe(300);
    const analysis = mocks.bedrock.calls('stream')[0];
    expect(analysis.input.modelId).toBe('test-model-id'); // stream path resolves unknown modelKey
    expect(analysis.body.max_tokens).toBe(4096);
    expect(analysis.system).toBe(SYSTEM.en);
    expect(analysis.body.messages).toEqual([{
      role: 'user',
      content: q + '\n\n--- LIVE PROMETHEUS DATA (120 rows) ---\nDatasource: Prod Prom (http://prom.internal:9090)\nPromQL: up\n'
        + '```json\n' + JSON.stringify(rows.slice(0, 100), null, 2) + '\n```',
    }]);
    expectRecorded({
      route: 'datasource', gateway: 'datasource:prometheus', usedTools: ['prometheus: up'], success: true,
      via: 'Prometheus (120 rows)', inputTokens: 11, outputTokens: 22,
    });
    expect(mocks.saveConversation).toHaveBeenCalledWith({
      id: expect.any(String), userId: TEST.userEmail, timestamp: expect.any(String), route: 'datasource',
      gateway: 'datasource:prometheus', question: q, summary: 'DS ANALYSIS', usedTools: ['prometheus: up'],
      responseTimeMs: expect.any(Number), via: 'Prometheus (120 rows)',
    });

    // Empty analysis → 'No response'; no totalRows → rows.length in the analyzing status.
    mocks.recordCall.mockClear();
    mocks.datasource.result({ columns: ['i'], rows: rows.slice(0, 7), metadata: {} });
    mocks.bedrock.stream([]);
    ev = await postSse({ messages: user(q) });
    expect(sseEvents(ev, 'status').at(-1)).toEqual({ step: 'datasource-analyzing', message: '7건 결과 분석 중...' });
    expect(ev.at(-1)![1].content).toBe('No response');
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('datasource:prometheus');

    // Retry: query error → retrying status → regenerated query → success.
    mocks.bedrock.dsQuery('bad_query', 'good_query');
    mocks.datasource.result(new Error('parse error'), { columns: [], rows: [{ a: 1 }], metadata: {} });
    mocks.bedrock.stream(['OK']);
    mocks.bedrock.clearCalls();
    ev = await postSse({ messages: user(q) });
    expect(ev.slice(2)).toEqual([
      ['status', { step: 'datasource-generating', message: 'Prometheus PromQL 쿼리 생성 중...' }],
      ['status', { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중...', query: 'bad_query' }],
      ['status', { step: 'datasource-retrying', message: 'Prometheus 쿼리 오류 수정 중...' }],
      ['status', { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중 (재시도)...', query: 'good_query' }],
      ['status', { step: 'datasource-analyzing', message: '1건 결과 분석 중...' }],
      chunk('OK'),
      ['done', {
        content: 'OK', model: 'test-label', via: 'Datasource Analytics: Prometheus (1 rows)',
        queriedResources: ['prometheus'], route: 'datasource', usedTools: ['prometheus: good_query'], inputTokens: 11, outputTokens: 22,
      }],
    ]);
    expect(mocks.bedrock.calls('dsQuery')[1].body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'I generated this PromQL query: bad_query' },
      { role: 'user', content: 'That query failed with error: parse error. Fix the query.' },
    ]);

    // Both attempts fail → datasource-fallback → AgentCore 'ops' gateway (not Bedrock).
    mocks.recordCall.mockClear();
    mocks.bedrock.dsQuery('bad_query', 'still_bad');
    mocks.datasource.result(new Error('parse error'));
    mocks.agent.reply('OPS ANSWER');
    ev = await postSse({ messages: user(q), accountId: TEST.accountId });
    expect(ev.slice(2)).toEqual([
      ['status', { step: 'datasource-generating', message: 'Prometheus PromQL 쿼리 생성 중...' }],
      ['status', { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중...', query: 'bad_query' }],
      ['status', { step: 'datasource-retrying', message: 'Prometheus 쿼리 오류 수정 중...' }],
      ['status', { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중 (재시도)...', query: 'still_bad' }],
      ['status', { step: 'datasource-fallback', message: '데이터소스 쿼리 실패. Bedrock으로 폴백합니다.' }],
      agentcoreStatus(display),
      chunk('OPS ANSWER'),
      ['done', {
        content: 'OPS ANSWER', model: 'test-label', via: 'AgentCore → Datasource Analytics', queriedResources: ['ops-gateway'],
        route: 'datasource', routes: ['datasource'], usedTools: [], inputTokens: 1, outputTokens: 2,
      }],
    ]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload).toEqual({
      messages: user(q), gateway: 'ops', accountId: TEST.accountId, accountAlias: 'Prod',
    });
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('ops');

    // Empty generated query → null → fallback straight after the generating status.
    mocks.bedrock.dsQuery('');
    ev = await postSse({ messages: user(q) });
    expect(ev.slice(2, 5)).toEqual([
      ['status', { step: 'datasource-generating', message: 'Prometheus PromQL 쿼리 생성 중...' }],
      ['status', { step: 'datasource-fallback', message: '데이터소스 쿼리 실패. Bedrock으로 폴백합니다.' }],
      agentcoreStatus(display),
    ]);

    // No detectable type → datasource-no-type, then AgentCore ops (no datasource-fallback status).
    ev = await postSse({ messages: user('hello there') });
    expect(ev.slice(2, 4)).toEqual([
      ['status', { step: 'datasource-no-type', message: '데이터소스 타입을 감지할 수 없습니다. 프로메테우스, 로키, 템포, 클릭하우스 중 하나를 지정해주세요.' }],
      agentcoreStatus(display),
    ]);
    expect(ev.at(-1)![1].via).toBe('AgentCore → Datasource Analytics');

    // Datasource not configured → not-found, fallback, ops.
    mocks.datasource.set('prometheus', undefined);
    ev = await postSse({ messages: user(q) });
    expect(ev.slice(2, 5)).toEqual([
      ['status', { step: 'datasource-not-found', message: 'Prometheus 데이터소스가 설정되지 않았습니다.' }],
      ['status', { step: 'datasource-fallback', message: '데이터소스 쿼리 실패. Bedrock으로 폴백합니다.' }],
      agentcoreStatus(display),
    ]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload.gateway).toBe('ops');

    // Two types, concurrent: per-type status subsequences; correlation hint; '+' gateway.
    mocks.datasource.set('prometheus', prom);
    mocks.datasource.set('loki', loki);
    const q2 = 'prometheus 메트릭과 loki 에러 로그 상관 분석';
    const lokiRows = [{ line: 'err1' }, { line: 'err2' }, { line: 'err3' }];
    mocks.bedrock.dsQuery((call: any) => (call.system === DATASOURCE_QUERY_PROMPTS.prometheus ? 'up' : '{app="api"}'));
    mocks.datasource.result((ds: any) => (ds.type === 'prometheus'
      ? { columns: [], rows, metadata: {} }
      : { columns: [], rows: lokiRows, metadata: {} }));
    mocks.bedrock.stream(['CORR']);
    mocks.bedrock.clearCalls();
    mocks.recordCall.mockClear();
    ev = await postSse({ messages: user(q2) });
    const statuses = sseEvents(ev, 'status').slice(2);
    const promSeq = statuses.filter(s => /Prometheus|Prod Prom/.test(s.message));
    const lokiSeq = statuses.filter(s => /Loki/.test(s.message));
    expect(promSeq).toEqual([
      { step: 'datasource-generating', message: 'Prometheus PromQL 쿼리 생성 중...' },
      { step: 'datasource-querying', message: 'Prod Prom에 쿼리 실행 중...', query: 'up' },
    ]);
    expect(lokiSeq).toEqual([
      { step: 'datasource-generating', message: 'Loki LogQL 쿼리 생성 중...' },
      { step: 'datasource-querying', message: 'Prod Loki에 쿼리 실행 중...', query: '{app="api"}' },
    ]);
    expect(statuses).toHaveLength(5);
    expect(statuses.at(-1)).toEqual({ step: 'datasource-analyzing', message: '2개 데이터소스 상관 분석 중...' });
    expect(ev.at(-1)).toEqual(['done', {
      content: 'CORR', model: 'test-label', via: 'Datasource Analytics: Prometheus (120 rows) + Loki (3 rows)',
      queriedResources: ['prometheus', 'loki'], route: 'datasource', usedTools: ['prometheus: up', 'loki: {app="api"}'],
      inputTokens: 11, outputTokens: 22,
    }]);
    const corr = mocks.bedrock.calls('stream')[0];
    expect(corr.system).toBe(SYSTEM.none + CORRELATION_HINT);
    expect(corr.body.messages[0].content).toBe(q2
      + '\n\n--- LIVE PROMETHEUS DATA (120 rows) ---\nDatasource: Prod Prom (http://prom.internal:9090)\nPromQL: up\n'
      + '```json\n' + JSON.stringify(rows.slice(0, 100), null, 2) + '\n```'
      + '\n'
      + '\n\n--- LIVE LOKI DATA (3 rows) ---\nDatasource: Prod Loki (http://loki.internal:3100)\nLogQL: {app="api"}\n'
      + '```json\n' + JSON.stringify(lokiRows, null, 2) + '\n```');
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('datasource:prometheus+loki');

    // Two types, one not configured → not-found for it; single-ds analysis for the other.
    mocks.datasource.set('loki', undefined);
    mocks.recordCall.mockClear();
    ev = await postSse({ messages: user(q2) });
    const st2 = sseEvents(ev, 'status').slice(2);
    expect(st2.filter(s => /Loki/.test(s.message))).toEqual([
      { step: 'datasource-not-found', message: 'Loki 데이터소스가 설정되지 않았습니다.' },
    ]);
    expect(st2.at(-1)).toEqual({ step: 'datasource-analyzing', message: '120건 결과 분석 중...' });
    expect(st2).toHaveLength(4);
    expect(ev.at(-1)![1].via).toBe('Datasource Analytics: Prometheus (120 rows)');
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('datasource:prometheus');
  });

  it('autoCollectErrorPaths (stream half)', async () => {
    const c = mocks.collectorMock('eks-optimize');
    c.collect.mockImplementation(async (send: (e: string, d: unknown) => void) => {
      send('status', { step: 'eks-collecting', message: 'collecting metrics' });
      return structuredClone(TEST.collectorData);
    });
    mocks.bedrock.classify(['eks-optimize']);
    mocks.bedrock.stream(['EKS ', 'ANALYSIS']);
    const q = 'EKS 비용 최적화';

    // Collector statuses reach SSE; real send + isEn (no lang → true); max_tokens 8192.
    let ev = await postSse({ messages: user(q), accountId: TEST.accountId, model: 'nope' });
    expect(ev).toEqual([
      classifying(),
      classified('eks-optimize', 'EKS Cost Optimizer'),
      ['status', { step: 'eks-collecting', message: 'collecting metrics' }],
      ['status', { step: 'eks-optimize-analyzing', message: '🤖 Analyzing with Display eks-optimize...' }],
      chunk('EKS '), chunk('ANALYSIS'),
      ['done', {
        content: 'EKS ANALYSIS', model: 'test-label', via: 'Collector Via Summary', queriedResources: ['collector-resource'],
        route: 'eks-optimize', usedTools: ['collector-tool'], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(c.collect).toHaveBeenCalledWith(expect.any(Function), TEST.accountId, true);
    expect(c.formatContext).toHaveBeenCalledWith(TEST.collectorData);
    const call = mocks.bedrock.calls('stream')[0];
    expect(call.input.modelId).toBe('test-model-id'); // stream path resolves unknown modelKey
    expect(call.body).toEqual({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 8192, system: 'ANALYSIS PROMPT eks-optimize',
      messages: [{ role: 'user', content: q + '\n\nCTX:eks-optimize' }],
    });
    expectRecorded({
      route: 'eks-optimize', gateway: 'eks-optimize', usedTools: ['collector-tool'], success: true,
      via: 'Collector Via Summary', inputTokens: 0, outputTokens: 0,
    });
    expect(mocks.saveConversation.mock.calls[0][0].summary).toBe('EKS ANALYSIS');

    // ko → isEn false + Korean analyzing status; empty analysis → 'No response' but summary ''.
    mocks.recordCall.mockClear();
    mocks.saveConversation.mockClear();
    mocks.bedrock.stream([]);
    ev = await postSse({ messages: user(q), lang: 'ko' });
    expect(c.collect).toHaveBeenLastCalledWith(expect.any(Function), undefined, false);
    expect(ev[3]).toEqual(['status', { step: 'eks-optimize-analyzing', message: '🤖 Display eks-optimize 분석 중...' }]);
    expect(ev.at(-1)![1].content).toBe('No response');
    expect(mocks.saveConversation.mock.calls[0][0].summary).toBe('');

    // zh → isEn true + Chinese analyzing status.
    ev = await postSse({ messages: user(q), lang: 'zh' });
    expect(c.collect).toHaveBeenLastCalledWith(expect.any(Function), undefined, true);
    expect(ev[3]).toEqual(['status', { step: 'eks-optimize-analyzing', message: '🤖 正在使用 Display eks-optimize 分析...' }]);

    // Collector throws → `${route}-error` status → falls through to the AgentCore gateway ('ops').
    mocks.recordCall.mockClear();
    c.collect.mockRejectedValueOnce(new Error('prometheus down'));
    mocks.agent.reply('GW ANSWER');
    ev = await postSse({ messages: user(q), lang: 'ko' });
    expect(ev.slice(2)).toEqual([
      ['status', { step: 'eks-optimize-error', message: '⚠️ eks-optimize collector error: prometheus down' }],
      ['status', { step: 'agentcore', message: '🤖 EKS Cost Optimizer 도구 호출 중...' }],
      chunk('GW ANSWER'),
      ['done', {
        content: 'GW ANSWER', model: 'test-label', via: 'AgentCore → EKS Cost Optimizer', queriedResources: ['ops-gateway'],
        route: 'eks-optimize', routes: ['eks-optimize'], usedTools: [], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload.gateway).toBe('ops');
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('ops');

    // Analysis stream throws (after the analyzing status) → error status with that message → gateway.
    mocks.bedrock.fail('stream', new Error('throttled'));
    ev = await postSse({ messages: user(q) });
    expect(ev.slice(2, 6)).toEqual([
      ['status', { step: 'eks-collecting', message: 'collecting metrics' }],
      ['status', { step: 'eks-optimize-analyzing', message: '🤖 Analyzing with Display eks-optimize...' }],
      ['status', { step: 'eks-optimize-error', message: '⚠️ eks-optimize collector error: throttled' }],
      agentcoreStatus('EKS Cost Optimizer'),
    ]);

    // Another collector route uses its own module and route-specific step names.
    const idle = mocks.collectorMock('idle-scan');
    idle.collect.mockRejectedValueOnce(new Error('x'));
    mocks.bedrock.classify(['idle-scan']);
    ev = await postSse({ messages: user('idle') });
    expect(ev[2]).toEqual(['status', { step: 'idle-scan-error', message: '⚠️ idle-scan collector error: x' }]);
    expect(idle.collect).toHaveBeenCalledWith(expect.any(Function), undefined, true);
  });

  it('streamSql', async () => {
    const rows = [{ instance_id: 'i-1' }];
    mocks.bedrock.classify(['aws-data']);
    mocks.bedrock.sql('SELECT bad FROM aws_ec2_instance', '```sql\nSELECT instance_id FROM aws_ec2_instance\n```');
    mocks.steampipe.result({ rows: [], error: 'column "bad" does not exist' }, { rows });
    mocks.bedrock.stream(['IAM user ', 'count']);
    const display = 'Bedrock + Steampipe SQL';

    // Retry order; sql in querying payloads; usedTools = extracted + 'steampipe: <table>'.
    let ev = await postSse({ messages: user('EC2 목록'), accountId: TEST.accountId });
    expect(ev).toEqual([
      classifying(),
      classified('aws-data', display),
      ['status', { step: 'sql-generating', message: '📝 Generating SQL...' }],
      ['status', { step: 'sql-querying', message: '🔎 Running Steampipe query...', sql: 'SELECT bad FROM aws_ec2_instance' }],
      ['status', { step: 'sql-retrying', message: '🔄 Retrying with corrected SQL...' }],
      ['status', { step: 'sql-querying', message: '🔎 Running Steampipe query... (retry)', sql: 'SELECT instance_id FROM aws_ec2_instance' }],
      ['status', { step: 'analyzing', message: '📊 Analyzing 1 rows of data...' }],
      chunk('IAM user '), chunk('count'),
      ['done', {
        content: 'IAM user count', model: 'test-label', via: 'Bedrock + Steampipe SQL (1 rows)', queriedResources: ['steampipe'],
        route: 'aws-data', usedTools: ['list_users', 'steampipe: aws_ec2_instance'], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.runQuery.mock.calls).toEqual([
      ['SELECT bad FROM aws_ec2_instance', { accountId: TEST.accountId }],
      ['SELECT instance_id FROM aws_ec2_instance', { accountId: TEST.accountId }],
    ]);
    const sqlCalls = mocks.bedrock.calls('sql');
    expect(sqlCalls[0].system.endsWith('\n\nNote: Query targets AWS account Prod. The search_path is already set for this account, so use standard table names (no account prefix needed).')).toBe(true);
    expect(sqlCalls[1].body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'I generated this SQL: SELECT bad FROM aws_ec2_instance' },
      { role: 'user', content: 'That SQL failed with error: column "bad" does not exist. Fix the SQL using only valid column names.' },
    ]);
    const analysis = mocks.bedrock.calls('stream')[0];
    expect(analysis.body).toEqual({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM.none,
      messages: [{ role: 'user', content: 'EC2 목록\n\n--- LIVE AWS RESOURCE DATA (1 rows) ---\nSQL: SELECT instance_id FROM aws_ec2_instance\n```json\n' + JSON.stringify(rows, null, 2) + '\n```' }],
    });
    expectRecorded({
      route: 'aws-data', gateway: 'steampipe', usedTools: ['list_users', 'steampipe: aws_ec2_instance'], success: true,
      via: 'Bedrock + Steampipe SQL (1 rows)', inputTokens: 0, outputTokens: 0,
    });

    // ko statuses; no FROM → 'steampipe: query'; empty analysis → 'No response'.
    mocks.bedrock.sql('SELECT 1');
    mocks.steampipe.result({ rows: [] });
    mocks.bedrock.stream([]);
    ev = await postSse({ messages: user('q'), lang: 'ko' });
    expect(ev.slice(2, 5)).toEqual([
      ['status', { step: 'sql-generating', message: '📝 SQL 생성 중...' }],
      ['status', { step: 'sql-querying', message: '🔎 Steampipe 쿼리 실행 중...', sql: 'SELECT 1' }],
      ['status', { step: 'analyzing', message: '📊 0건 데이터 분석 중...' }],
    ]);
    expect(ev.at(-1)![1]).toMatchObject({ content: 'No response', usedTools: ['steampipe: query'], via: 'Bedrock + Steampipe SQL (0 rows)' });

    // ko retry label.
    mocks.bedrock.sql('SELECT a FROM t', 'SELECT b FROM t');
    mocks.steampipe.result({ rows: [], error: 'e1' }, { rows: [] });
    ev = await postSse({ messages: user('q'), lang: 'ko' });
    expect(ev[4]).toEqual(['status', { step: 'sql-retrying', message: '🔄 SQL 수정 후 재시도...' }]);
    expect(ev[5]).toEqual(['status', { step: 'sql-querying', message: '🔎 Steampipe 쿼리 실행 중... (재시도)', sql: 'SELECT b FROM t' }]);

    // Non-SELECT → sql-fallback → AgentCore 'ops'.
    mocks.recordCall.mockClear();
    mocks.bedrock.sql('I cannot write that query');
    mocks.agent.reply('Ops answer');
    ev = await postSse({ messages: user('EC2 목록'), accountId: TEST.accountId });
    expect(ev).toEqual([
      classifying(),
      classified('aws-data', display),
      ['status', { step: 'sql-generating', message: '📝 Generating SQL...' }],
      ['status', { step: 'sql-fallback', message: '⚠️ SQL failed, switching to AgentCore...' }],
      agentcoreStatus(display),
      chunk('Ops answer'),
      ['done', {
        content: 'Ops answer', model: 'test-label', via: 'AgentCore → Bedrock + Steampipe SQL', queriedResources: ['ops-gateway'],
        route: 'aws-data', routes: ['aws-data'], usedTools: [], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').at(-1)!.payload).toEqual({
      messages: user('EC2 목록'), gateway: 'ops', accountId: TEST.accountId, accountAlias: 'Prod',
    });
    expect(mocks.recordCall.mock.calls[0][0]).toMatchObject({ gateway: 'ops', success: true });

    // Both queries error → querying, retrying, querying(retry), sql-fallback, agentcore.
    mocks.bedrock.sql('SELECT a FROM t', 'SELECT b FROM t');
    mocks.steampipe.result({ rows: [], error: 'e1' }, { rows: [], error: 'e2' });
    ev = await postSse({ messages: user('EC2 목록') });
    expect(sseEvents(ev, 'status').slice(2).map(s => s.step)).toEqual([
      'sql-generating', 'sql-querying', 'sql-retrying', 'sql-querying', 'sql-fallback', 'agentcore',
    ]);
  });

  it('streamGateway', async () => {
    const body = '0123456789'.repeat(12); // 120 chars → 50 + 50 + 20
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(`<tool_call>{"name": "list_users"}</tool_call>\n<tool_response>{"users": 3}</tool_response>\n${body}`);
    const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    let ev = await postSse({ messages: many, accountId: TEST.accountId });
    expect(ev).toEqual([
      classifying(),
      classified('security', 'Security Gateway (14 tools)'),
      agentcoreStatus('Security Gateway (14 tools)'),
      chunk(body.slice(0, 50)), chunk(body.slice(50, 100)), chunk(body.slice(100)),
      ['done', {
        content: body, model: 'test-label', via: 'AgentCore → Security Gateway (14 tools)', queriedResources: ['security-gateway'],
        route: 'security', routes: ['security'], usedTools: ['list_users'], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    const calls = mocks.agent.calls();
    expect(calls.map(c => c.name)).toEqual(['InvokeAgentRuntimeCommand', 'StopRuntimeSessionCommand']);
    expect(calls[0].input.agentRuntimeArn).toBe(TEST.runtimeArn);
    expect(calls[0].input.qualifier).toBe('DEFAULT');
    expect(calls[0].payload).toEqual({ messages: many.slice(-10), gateway: 'security', accountId: TEST.accountId, accountAlias: 'Prod' });
    expect(mocks.reportAgentcoreInvoke.mock.calls).toEqual([[expect.stringMatching(/^[0-9a-f-]{36}$/), 'success']]);
    expectRecorded({
      route: 'security', gateway: 'security', usedTools: ['list_users'], success: true,
      via: 'AgentCore → Security Gateway (14 tools)', inputTokens: 0, outputTokens: 0,
    });

    // datasource-diag → gateway 'monitoring' + skill 'diagnostics' in the payload.
    mocks.agent.clearCalls();
    mocks.recordCall.mockClear();
    mocks.bedrock.classify(['datasource-diag']);
    mocks.agent.reply('diag ok');
    ev = await postSse({ messages: user('Prometheus 연결 진단') });
    expect(ev.slice(1)).toEqual([
      classified('datasource-diag', 'Datasource Diagnostics (8 tools)'),
      agentcoreStatus('Datasource Diagnostics (8 tools)'),
      chunk('diag ok'),
      ['done', {
        content: 'diag ok', model: 'test-label', via: 'AgentCore → Datasource Diagnostics (8 tools)', queriedResources: ['monitoring-gateway'],
        route: 'datasource-diag', routes: ['datasource-diag'], usedTools: [], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand')[0].payload).toEqual({
      messages: user('Prometheus 연결 진단'), gateway: 'monitoring', accountId: '', accountAlias: '', skill: 'diagnostics',
    });
    expect(mocks.recordCall.mock.calls[0][0].gateway).toBe('monitoring');

    // A response that is only tool tags → cleaned is empty → the raw response is streamed.
    const raw = '<tool_call>{"name": "list_roles"}</tool_call>';
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(raw);
    ev = await postSse({ messages: user('q') });
    expect(sseEvents(ev, 'chunk')).toEqual([{ delta: raw }]);
    expect(ev.at(-1)![1]).toMatchObject({ content: raw, usedTools: ['list_roles'] });

    // ValidationException → not reported to health; falls back to Bedrock.
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.agent.reply(Object.assign(new Error('bad session id'), { name: 'ValidationException' }));
    mocks.bedrock.stream(['fb']);
    ev = await postSse({ messages: user('q') });
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expect(ev.at(-1)![1].via).toBe('Bedrock Direct (fallback from Security Gateway (14 tools))');

    // Other errors are reported as error with `${name}: ${message}`.
    mocks.agent.reply(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
    await postSse({ messages: user('q') });
    expect(mocks.reportAgentcoreInvoke.mock.calls).toEqual([[expect.any(String), 'error', 'ServiceUnavailable: boom']]);
  });

  it('streamFallbackRecordsFailureWithoutRoutes', async () => {
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(new Error('agent down'));
    mocks.bedrock.stream(['Fallback ', 'cost answer']);
    const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    let ev = await postSse({ messages: many, model: 'nope' });
    expect(ev).toEqual([
      classifying(),
      classified('security', 'Security Gateway (14 tools)'),
      agentcoreStatus('Security Gateway (14 tools)'),
      ['status', { step: 'fallback', message: '🔄 Bedrock Direct fallback...' }],
      chunk('Fallback '), chunk('cost answer'),
      ['done', {
        content: 'Fallback cost answer', model: 'test-label', via: 'Bedrock Direct (fallback from Security Gateway (14 tools))',
        queriedResources: [], route: 'security', usedTools: ['get_cost_and_usage'], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect('routes' in ev.at(-1)![1]).toBe(false);
    const fb = mocks.bedrock.calls('stream')[0];
    expect(fb.input.modelId).toBe('test-model-id');
    expect(fb.body).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM.none, messages: many.slice(-10) });
    expectRecorded({
      route: 'security', gateway: 'bedrock-fallback', usedTools: ['get_cost_and_usage'], success: false,
      via: 'Bedrock Direct (fallback)', inputTokens: 0, outputTokens: 0,
    });
    expect(mocks.saveConversation.mock.calls[0][0]).toMatchObject({ gateway: 'bedrock-fallback', via: 'Bedrock Direct (fallback)', summary: 'Fallback cost answer' });

    // Empty AgentCore body → fallback too, not reported; ko status; empty stream → 'No response'.
    mocks.reportAgentcoreInvoke.mockClear();
    mocks.agent.reply('');
    mocks.bedrock.stream([]);
    ev = await postSse({ messages: user('q'), lang: 'ko' });
    expect(ev.slice(2)).toEqual([
      ['status', { step: 'agentcore', message: '🤖 Security Gateway (14 tools) 도구 호출 중...' }],
      ['status', { step: 'fallback', message: '🔄 Bedrock Direct 폴백...' }],
      ['done', {
        content: 'No response', model: 'test-label', via: 'Bedrock Direct (fallback from Security Gateway (14 tools))',
        queriedResources: [], route: 'security', usedTools: [], inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expect(mocks.bedrock.calls('stream')[1].system).toBe(SYSTEM.ko);
  });

  it('doneTokensIncludeClassification', async () => {
    mocks.bedrock.classify(['aws-data'], { input: 11, output: 3 });
    mocks.bedrock.textUsage({ input: 1000, output: 1000 }); // SQL-gen InvokeModel tokens are not counted
    mocks.bedrock.sql('SELECT 1');
    mocks.bedrock.stream(['x'], { input: 100, output: 50 });
    let ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)![1]).toMatchObject({ inputTokens: 111, outputTokens: 53 });
    expect(mocks.recordCall.mock.calls[0][0]).toMatchObject({ inputTokens: 111, outputTokens: 53 });

    // Gateway success → classification tokens only.
    mocks.recordCall.mockClear();
    mocks.bedrock.classify(['security'], { input: 11, output: 3 });
    mocks.agent.reply('ok');
    ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)![1]).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(mocks.recordCall.mock.calls[0][0]).toMatchObject({ inputTokens: 11, outputTokens: 3 });

    // Fallback → classification + fallback stream.
    mocks.agent.reply(new Error('x'));
    ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)![1]).toMatchObject({ inputTokens: 111, outputTokens: 53 });

    // Code → classification + code stream.
    mocks.bedrock.classify(['code'], { input: 11, output: 3 });
    ev = await postSse({ messages: user('q') });
    expect(ev.at(-1)![1]).toMatchObject({ inputTokens: 111, outputTokens: 53 });
  });

  it('saveConversationSlicesAndUserId', async () => {
    const question = 'Q'.repeat(150);
    const answer = 'A'.repeat(300);
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(answer);
    mocks.getUserFromRequest.mockReturnValue({ email: 'other@example.com', sub: 'other' });
    const req = aiRequest({ stream: true, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'a' }, { role: 'user', content: question }] });
    const ev = await readSse(await POST(req));
    expect(mocks.getUserFromRequest).toHaveBeenCalledWith(req);
    expect(ev.at(-1)![1].content).toBe(answer);
    expect(mocks.saveConversation).toHaveBeenCalledTimes(1);
    const saved = mocks.saveConversation.mock.calls[0][0];
    expect(saved).toEqual({
      id: expect.stringMatching(/^\d+$/), userId: 'other@example.com', timestamp: expect.any(String),
      route: 'security', gateway: 'security', question: 'Q'.repeat(100), summary: 'A'.repeat(200),
      usedTools: [], responseTimeMs: expect.any(Number), via: 'AgentCore → Security Gateway (14 tools)',
    });
    expect('question' in mocks.recordCall.mock.calls[0][0]).toBe(false);

    // saveConversation rejecting is swallowed — the stream still completes with done.
    mocks.saveConversation.mockRejectedValue(new Error('disk full'));
    const ev2 = await postSse({ messages: user('q') });
    expect(ev2.at(-1)![0]).toBe('done');
  });

  it('midStreamErrorSendsChunksThenError', async () => {
    // Code path: chunks already sent, then a single error event, no done, no stats.
    mocks.bedrock.classify(['code']);
    bedrockStreamThrowsMidway(['partial ', 'text'], new Error('stream reset'));
    let ev = await postSse({ messages: user('q') });
    expect(ev).toEqual([
      classifying(),
      classified('code', 'Code Interpreter'),
      ['status', { step: 'generating', message: '💻 Generating code...' }],
      chunk('partial '), chunk('text'),
      ['error', { error: 'stream reset' }],
    ]);
    expectNoStats();

    // Fallback path: same shape; empty error message → 'AI request failed'.
    mocks.bedrock.classify(['security']);
    mocks.agent.reply(new Error('agent down'));
    bedrockStreamThrowsMidway(['half'], new Error(''));
    ev = await postSse({ messages: user('q') });
    expect(ev.slice(2)).toEqual([
      agentcoreStatus('Security Gateway (14 tools)'),
      ['status', { step: 'fallback', message: '🔄 Bedrock Direct fallback...' }],
      chunk('half'),
      ['error', { error: 'AI request failed' }],
    ]);
    expectNoStats();
  });

  it('streamWriteAfterCloseIsContained', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const gate = deferred<string>();
      mocks.bedrock.classify(['security']);
      mocks.agent.reply(() => gate.promise);
      const res = await POST(aiRequest({ stream: true, messages: user('q') }));
      const reader = res.body!.getReader();
      await reader.read();
      // Wait until the request is parked inside the AgentCore call, then the client goes away.
      await vi.waitFor(() => expect(mocks.agent.calls('InvokeAgentRuntimeCommand')).toHaveLength(1));
      await reader.cancel();
      expect(setSpy).toHaveBeenCalledTimes(1); // the single-route keepalive interval
      const intervalId = setSpy.mock.results[0].value;

      // AgentCore answers after the client left → every later enqueue throws; contained.
      gate.resolve('late answer');
      await vi.waitFor(() => expect(clearSpy).toHaveBeenCalledWith(intervalId));
      await new Promise(r => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
      expect(mocks.reportAgentcoreInvoke.mock.calls).toEqual([[expect.any(String), 'success']]);
      // The first simulated chunk throws before recordAndSave → nothing is recorded.
      expectNoStats();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
