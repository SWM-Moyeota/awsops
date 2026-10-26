/**
 * Characterization harness for `src/app/api/ai/route.ts` (`POST` / `GET`).
 * `/api/ai` 특성 테스트 하네스 — 외부 의존성을 모두 목으로 바꾸고, 응답을 읽는 도우미를 제공한다.
 *
 * Usage (import the harness BEFORE the route so its vi.mock calls are registered first):
 *
 *   import { setupAiMocks, aiRequest, readJson, readSse } from './harness';
 *   import { POST, GET } from '@/app/api/ai/route';
 *   const mocks = setupAiMocks();          // call once at file top level; registers a beforeEach reset
 *
 * setupAiMocks() returns stable handles (same objects for the whole file, state reset before each test):
 *   - bedrockSend   vi.fn — BedrockRuntimeClient.send. Dispatches on `cmd.constructor.name` and, for
 *                   InvokeModelCommand, on the system prompt:
 *                     'classify' — starts with "You are an intent classifier"
 *                     'sql'      — starts with "You are a Steampipe SQL expert"
 *                     'topology' — starts with "The user wants to see a VPC topology"
 *                     'dsQuery'  — equals one of the real DATASOURCE_QUERY_PROMPTS values
 *                     'text'     — any other InvokeModel (analysis, code, fallback, synthesis, collector)
 *                   InvokeModelWithResponseStreamCommand → 'stream', ConverseStreamCommand → 'converse'.
 *   - bedrock       reply setters + call log. Each setter takes one or more replies, consumed in order;
 *                   the last one stays sticky. A reply may be a value, an Error (thrown), or a function
 *                   `(call) => value` (may throw).
 *                     bedrock.classify(['sql'] | rawText, usage?)   → {"routes": [...]} text
 *                     bedrock.sql(...sqlTexts)
 *                     bedrock.topology(obj | rawText)               → obj is JSON.stringified
 *                     bedrock.dsQuery(...queryTexts)
 *                     bedrock.text(...texts)                        (usage via bedrock.textUsage)
 *                     bedrock.stream(chunks: string[], usage?)      usage = {input, output}, sticky
 *                     bedrock.streams(...replies)                   queue of string[] replies (one per call)
 *                     bedrock.converse(chunks: string[])
 *                     bedrock.fail(kind, err)
 *                     bedrock.calls(kind?) → [{ kind, name, input, body, system }] (a filtered copy)
 *                     bedrock.clearCalls()
 *                   Defaults: classify → {"routes": ["general"]}, sql → 'SELECT 1', topology → '{}',
 *                   dsQuery → 'up', text → 'TEXT', stream → ['STREAM'], converse → ['CONVERSE'].
 *   - agentSend     vi.fn — BedrockAgentCoreClient.send.
 *   - agent         agent.reply(...replies) for InvokeAgentRuntimeCommand; a reply is a string (body text),
 *                   an Error, the string 'HANG' (never resolves — use with fake timers), or a function
 *                   `(payload, input) => string` (payload = parsed JSON payload).
 *                   agent.codeOutput(text) sets the code-interpreter stream text.
 *                   agent.calls(name?) → [{ name, input, payload }]; agent.clearCalls()
 *   - runQuery      vi.fn — `@/lib/steampipe`.runQuery. Topology's VPC query is answered by
 *                   steampipe.vpcs(rows | {error}); every other SQL by steampipe.result(...replies)
 *                   (reply = {rows, error?} | Error | fn(sql, opts)). Default `{ rows: [] }`.
 *   - queryDatasource vi.fn — `@/lib/datasource-client`. datasource.result(...replies) (reply = QueryResult-ish
 *                   | Error | fn(ds, query, opts)). datasource.set(type, cfg | undefined) controls
 *                   getDefaultDatasource; default: none configured.
 *   - recordCall, saveConversation (resolves), reportAgentcoreInvoke — plain vi.fn spies.
 *   - getConfig     vi.fn → { agentRuntimeArn: TEST.runtimeArn, codeInterpreterName: TEST.codeInterpreter }.
 *   - collectorMock(route) → the mocked default export of `@/lib/collectors/<route>`:
 *                   { collect: vi.fn, formatContext: vi.fn, analysisPrompt, displayName }.
 *                   Default collect resolves TEST.collectorData; formatContext returns `\n\nCTX:<route>`.
 *
 * Fixed values (TEST): model id 'test-model-id', label 'test-label', account '111111111111' alias 'Prod',
 * user email 'tester@example.com'.
 *
 * Helpers: aiRequest(body) — NextRequest-like `{ json: async () => body, headers }`;
 *          badJsonRequest() — json() rejects; readJson(res) → { status, body };
 *          readSse(res) → Array<[event, data]>; sseEvents(list, name) filters by event.
 */
import { vi, beforeEach } from 'vitest';
import { DATASOURCE_QUERY_PROMPTS } from '@/lib/datasource-prompts';

export const TEST = {
  modelId: 'test-model-id',
  modelLabel: 'test-label',
  runtimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-2:000000000000:runtime/test',
  codeInterpreter: 'awsops_code_interpreter_test',
  accountId: '111111111111',
  accountAlias: 'Prod',
  userEmail: 'tester@example.com',
  collectorData: {
    sections: { a: 1 },
    usedTools: ['collector-tool'],
    queriedResources: ['collector-resource'],
    viaSummary: 'Collector Via Summary',
  },
} as const;

export const COLLECTOR_ROUTES = ['eks-optimize', 'db-optimize', 'msk-optimize', 'idle-scan', 'trace-analyze', 'incident'] as const;
export type CollectorRoute = typeof COLLECTOR_ROUTES[number];

type Reply = unknown;
type BedrockKind = 'classify' | 'sql' | 'topology' | 'dsQuery' | 'text' | 'stream' | 'converse';

const H = vi.hoisted(() => {
  const queues: Record<string, unknown[]> = {};
  const state = {
    queues,
    bedrockCalls: [] as any[],
    agentCalls: [] as any[],
    codeOutput: 'CODE OUTPUT',
    classifyUsage: { input: 0, output: 0 },
    textUsage: { input: 0, output: 0 },
    streamUsage: { input: 0, output: 0 },
    datasources: {} as Record<string, unknown>,
  };
  const take = (key: string, fallback: unknown): unknown => {
    const q = queues[key];
    if (!q || q.length === 0) return fallback;
    return q.length > 1 ? q.shift() : q[0];
  };
  const resolveReply = (r: unknown, ...args: unknown[]): unknown => {
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return (r as (...a: unknown[]) => unknown)(...args);
    return r;
  };
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  return {
    state, take, resolveReply, enc,
    bedrockSend: vi.fn(),
    agentSend: vi.fn(),
    runQuery: vi.fn(),
    queryDatasource: vi.fn(),
    recordCall: vi.fn(),
    saveConversation: vi.fn(),
    reportAgentcoreInvoke: vi.fn(),
    getConfig: vi.fn(),
    getUserFromRequest: vi.fn(),
    collectors: Object.fromEntries(
      ['eks-optimize', 'db-optimize', 'msk-optimize', 'idle-scan', 'trace-analyze', 'incident'].map(route => [route, {
        collect: vi.fn(),
        formatContext: vi.fn(),
        analysisPrompt: `ANALYSIS PROMPT ${route}`,
        displayName: `Display ${route}`,
      }]),
    ) as Record<string, any>,
  };
});

// Command classes: keep the real class names so dispatch on cmd.constructor.name works.
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class Cmd { constructor(public input: any) {} }
  return {
    BedrockRuntimeClient: class { send(cmd: any) { return H.bedrockSend(cmd); } },
    InvokeModelCommand: class InvokeModelCommand extends Cmd {},
    InvokeModelWithResponseStreamCommand: class InvokeModelWithResponseStreamCommand extends Cmd {},
    ConverseStreamCommand: class ConverseStreamCommand extends Cmd {},
  };
});
vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  class Cmd { constructor(public input: any) {} }
  return {
    BedrockAgentCoreClient: class { send(cmd: any) { return H.agentSend(cmd); } },
    InvokeAgentRuntimeCommand: class InvokeAgentRuntimeCommand extends Cmd {},
    StopRuntimeSessionCommand: class StopRuntimeSessionCommand extends Cmd {},
    StartCodeInterpreterSessionCommand: class StartCodeInterpreterSessionCommand extends Cmd {},
    InvokeCodeInterpreterCommand: class InvokeCodeInterpreterCommand extends Cmd {},
    StopCodeInterpreterSessionCommand: class StopCodeInterpreterSessionCommand extends Cmd {},
  };
});
vi.mock('@/lib/steampipe', () => ({ runQuery: (...a: unknown[]) => H.runQuery(...a) }));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => H.getConfig(),
  validateAccountId: (id: string) => /^\d{12}$/.test(id),
  getAccountById: (id: string) => (id === '111111111111'
    ? { accountId: '111111111111', alias: 'Prod', connectionName: 'aws_111111111111', region: 'ap-northeast-2', isHost: true }
    : undefined),
  getBedrockModelId: () => 'test-model-id',
  getBedrockModelLabel: () => 'test-label',
  getDefaultDatasource: (type: string) => H.state.datasources[type],
}));
vi.mock('@/lib/agentcore-stats', () => ({ recordCall: (...a: unknown[]) => H.recordCall(...a) }));
vi.mock('@/lib/agentcore-memory', () => ({ saveConversation: (...a: unknown[]) => H.saveConversation(...a) }));
vi.mock('@/lib/auth-utils', () => ({ getUserFromRequest: (...a: unknown[]) => H.getUserFromRequest(...a) }));
vi.mock('@/lib/health/monitor', () => ({ reportAgentcoreInvoke: (...a: unknown[]) => H.reportAgentcoreInvoke(...a) }));
vi.mock('@/lib/datasource-client', () => ({ queryDatasource: (...a: unknown[]) => H.queryDatasource(...a) }));

const collectorFactory = (route: string) => ({ default: H.collectors[route] });
vi.mock('@/lib/collectors/eks-optimize', () => collectorFactory('eks-optimize'));
vi.mock('@/lib/collectors/db-optimize', () => collectorFactory('db-optimize'));
vi.mock('@/lib/collectors/msk-optimize', () => collectorFactory('msk-optimize'));
vi.mock('@/lib/collectors/idle-scan', () => collectorFactory('idle-scan'));
vi.mock('@/lib/collectors/trace-analyze', () => collectorFactory('trace-analyze'));
vi.mock('@/lib/collectors/incident', () => collectorFactory('incident'));

// ---------------------------------------------------------------------------
// Bedrock dispatch
// ---------------------------------------------------------------------------
function bedrockKind(name: string, system: unknown): BedrockKind {
  if (name === 'InvokeModelWithResponseStreamCommand') return 'stream';
  if (name === 'ConverseStreamCommand') return 'converse';
  const s = typeof system === 'string' ? system : '';
  if (s.startsWith('You are an intent classifier')) return 'classify';
  if (s.startsWith('You are a Steampipe SQL expert')) return 'sql';
  if (s.startsWith('The user wants to see a VPC topology')) return 'topology';
  if ((Object.values(DATASOURCE_QUERY_PROMPTS) as string[]).includes(s)) return 'dsQuery';
  return 'text';
}

const BEDROCK_DEFAULTS: Record<BedrockKind, unknown> = {
  classify: '{"routes": ["general"]}',
  sql: 'SELECT 1',
  topology: '{}',
  dsQuery: 'up',
  text: 'TEXT',
  stream: ['STREAM'],
  converse: ['CONVERSE'],
};

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

async function bedrockImpl(cmd: any) {
  const name: string = cmd?.constructor?.name;
  const input = cmd?.input;
  let body: any;
  if (input?.body instanceof Uint8Array) {
    try { body = JSON.parse(new TextDecoder().decode(input.body)); } catch { body = undefined; }
  }
  const system = name === 'ConverseStreamCommand' ? input?.system?.[0]?.text : body?.system;
  const kind = bedrockKind(name, system);
  const call = { kind, name, input, body, system };
  H.state.bedrockCalls.push(call);
  const reply = H.resolveReply(H.take(`bedrock:${kind}`, BEDROCK_DEFAULTS[kind]), call);

  if (kind === 'stream') {
    const chunks = reply as string[];
    const u = H.state.streamUsage;
    const events = [
      { chunk: { bytes: H.enc({ type: 'message_start', message: { usage: { input_tokens: u.input } } }) } },
      ...chunks.map(t => ({ chunk: { bytes: H.enc({ type: 'content_block_delta', delta: { text: t } }) } })),
      { chunk: { bytes: H.enc({ type: 'message_delta', usage: { output_tokens: u.output } }) } },
    ];
    return { body: iterate(events) };
  }
  if (kind === 'converse') {
    const chunks = reply as string[];
    return { stream: iterate(chunks.map(t => ({ contentBlockDelta: { delta: { text: t } } }))) };
  }
  const u = kind === 'classify' ? H.state.classifyUsage : H.state.textUsage;
  return {
    body: H.enc({ content: [{ text: reply as string }], usage: { input_tokens: u.input, output_tokens: u.output } }),
  };
}

// ---------------------------------------------------------------------------
// AgentCore dispatch
// ---------------------------------------------------------------------------
async function agentImpl(cmd: any) {
  const name: string = cmd?.constructor?.name;
  const input = cmd?.input;
  let payload: any;
  if (name === 'InvokeAgentRuntimeCommand') {
    try { payload = JSON.parse(input.payload); } catch { payload = input?.payload; }
  }
  H.state.agentCalls.push({ name, input, payload });
  switch (name) {
    case 'InvokeAgentRuntimeCommand': {
      const raw = H.take('agent:invoke', 'AGENT RESPONSE');
      if (raw === 'HANG') return new Promise(() => {});
      const text = H.resolveReply(raw, payload, input);
      if (text === 'HANG') return new Promise(() => {});
      return { runtimeSessionId: 'runtime-session-1', response: { transformToString: async () => text as string } };
    }
    case 'StartCodeInterpreterSessionCommand':
      return { sessionId: 'ci-session-1' };
    case 'InvokeCodeInterpreterCommand':
      return { stream: iterate([{ result: { content: [{ text: H.state.codeOutput }] } }]) };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function setQueue(key: string, replies: unknown[]) {
  H.state.queues[key] = [...replies];
}

const handles = {
  bedrockSend: H.bedrockSend,
  agentSend: H.agentSend,
  runQuery: H.runQuery,
  queryDatasource: H.queryDatasource,
  recordCall: H.recordCall,
  saveConversation: H.saveConversation,
  reportAgentcoreInvoke: H.reportAgentcoreInvoke,
  getConfig: H.getConfig,
  getUserFromRequest: H.getUserFromRequest,
  collectorMock(route: CollectorRoute | string): {
    collect: ReturnType<typeof vi.fn>; formatContext: ReturnType<typeof vi.fn>; analysisPrompt: string; displayName: string;
  } {
    const c = H.collectors[route];
    if (!c) throw new Error(`no collector mock for ${route}`);
    return c;
  },
  bedrock: {
    classify(routes: string[] | string, usage?: { input: number; output: number }) {
      setQueue('bedrock:classify', [Array.isArray(routes) ? JSON.stringify({ routes }) : routes]);
      if (usage) H.state.classifyUsage = usage;
    },
    sql(...replies: Reply[]) { setQueue('bedrock:sql', replies); },
    topology(reply: Reply) {
      setQueue('bedrock:topology', [reply !== null && typeof reply === 'object' && !(reply instanceof Error) ? JSON.stringify(reply) : reply]);
    },
    dsQuery(...replies: Reply[]) { setQueue('bedrock:dsQuery', replies); },
    text(...replies: Reply[]) { setQueue('bedrock:text', replies); },
    textUsage(usage: { input: number; output: number }) { H.state.textUsage = usage; },
    /** chunks may also be an Error or a function returning string[] (see Reply). */
    stream(chunks: string[] | Reply, usage?: { input: number; output: number }) {
      setQueue('bedrock:stream', [chunks]);
      if (usage) H.state.streamUsage = usage;
    },
    streams(...replies: Reply[]) { setQueue('bedrock:stream', replies); },
    converse(chunks: Reply) { setQueue('bedrock:converse', [chunks]); },
    fail(kind: BedrockKind, err: Error) { setQueue(`bedrock:${kind}`, [err]); },
    calls(kind?: BedrockKind): Array<{ kind: BedrockKind; name: string; input: any; body: any; system: any }> {
      return H.state.bedrockCalls.filter(c => !kind || c.kind === kind);
    },
    clearCalls() { H.state.bedrockCalls.length = 0; },
  },
  agent: {
    reply(...replies: Reply[]) { setQueue('agent:invoke', replies); },
    codeOutput(text: string) { H.state.codeOutput = text; },
    calls(name?: string): Array<{ name: string; input: any; payload: any }> {
      return H.state.agentCalls.filter(c => !name || c.name === name);
    },
    clearCalls() { H.state.agentCalls.length = 0; },
  },
  steampipe: {
    vpcs(reply: Reply) { setQueue('steampipe:vpcs', [reply]); },
    result(...replies: Reply[]) { setQueue('steampipe:result', replies); },
  },
  datasource: {
    set(type: string, cfg: unknown) { H.state.datasources[type] = cfg; },
    result(...replies: Reply[]) { setQueue('datasource:result', replies); },
  },
};

export type AiMocks = typeof handles;

export const VPC_SQL = `SELECT vpc_id, tags ->> 'Name' AS name, cidr_block AS cidr FROM aws_vpc ORDER BY name NULLS LAST`;

function reset() {
  for (const k of Object.keys(H.state.queues)) delete H.state.queues[k];
  H.state.bedrockCalls.length = 0;
  H.state.agentCalls.length = 0;
  H.state.codeOutput = 'CODE OUTPUT';
  H.state.classifyUsage = { input: 0, output: 0 };
  H.state.textUsage = { input: 0, output: 0 };
  H.state.streamUsage = { input: 0, output: 0 };
  for (const k of Object.keys(H.state.datasources)) delete H.state.datasources[k];

  H.bedrockSend.mockReset().mockImplementation(bedrockImpl);
  H.agentSend.mockReset().mockImplementation(agentImpl);
  H.runQuery.mockReset().mockImplementation(async (sql: string, opts: unknown) => {
    const key = sql === VPC_SQL ? 'steampipe:vpcs' : 'steampipe:result';
    return H.resolveReply(H.take(key, { rows: [] }), sql, opts);
  });
  H.queryDatasource.mockReset().mockImplementation(async (ds: unknown, query: string, opts: unknown) =>
    H.resolveReply(H.take('datasource:result', { columns: [], rows: [], metadata: {} }), ds, query, opts));
  H.recordCall.mockReset();
  H.saveConversation.mockReset().mockResolvedValue(undefined);
  H.reportAgentcoreInvoke.mockReset();
  H.getConfig.mockReset().mockReturnValue({ agentRuntimeArn: TEST.runtimeArn, codeInterpreterName: TEST.codeInterpreter });
  H.getUserFromRequest.mockReset().mockReturnValue({ email: TEST.userEmail, sub: 'tester-sub' });
  for (const [route, c] of Object.entries(H.collectors)) {
    c.collect.mockReset().mockResolvedValue(structuredClone(TEST.collectorData));
    c.formatContext.mockReset().mockReturnValue(`\n\nCTX:${route}`);
  }
}

/** Register a beforeEach reset and return the (stable) mock handles. Call once at file top level. */
export function setupAiMocks(): AiMocks {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reset();
  });
  return handles;
}

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------
export function aiRequest(body: unknown): any {
  return { json: async () => body, headers: new Headers() };
}

export function badJsonRequest(): any {
  return { json: async () => { throw new SyntaxError('Unexpected token'); }, headers: new Headers() };
}

export async function readJson(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}

export async function readSse(res: Response): Promise<Array<[event: string, data: any]>> {
  const text = await res.text();
  const out: Array<[string, any]> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    out.push([event, data ? JSON.parse(data) : undefined]);
  }
  return out;
}

export function sseEvents(list: Array<[string, any]>, name: string): any[] {
  return list.filter(([e]) => e === name).map(([, d]) => d);
}
