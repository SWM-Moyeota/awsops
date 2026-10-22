import { describe, it, expect, vi, beforeEach } from 'vitest';

const lambdaSend = vi.fn();
const controlSend = vi.fn();
const bedrockSend = vi.fn();
const configMock = vi.fn(() => ({ agentRuntimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-2:116662357283:runtime/awsops_agent-b4JqGWCZuC' } as Record<string, unknown>));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class { send = controlSend; },
  GetAgentRuntimeCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send = bedrockSend; },
  InvokeModelCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => configMock(),
  getBedrockModelId: () => 'global.anthropic.claude-opus-4-8',
}));
vi.mock('@/lib/steampipe', () => ({
  pingSteampipe: vi.fn(async () => ({ ok: true, message: 'select 1 ok' })),
}));

import {
  TOOL_LAMBDAS, classifyLambdaProbe, checkAgentcoreRuntime, checkLambdas, checkBedrock, checkSteampipe,
} from '../checks';

const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  lambdaSend.mockReset();
  controlSend.mockReset();
  bedrockSend.mockReset();
});

describe('classifyLambdaProbe', () => {
  it('classifyImportErrorFails', () => {
    const payload = '{"errorMessage": "Unable to import module \'lambda_function\': No module named \'boto4\'", "errorType": "Runtime.ImportModuleError", "requestId": "", "stackTrace": []}';
    const r = classifyLambdaProbe('Unhandled', payload);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Runtime.ImportModuleError');
  });

  it('classifyUnknownToolIsOk', () => {
    const payload = '{"statusCode": 400, "body": "{\\"error\\": \\"Unknown tool: __healthcheck__\\"}"}';
    expect(classifyLambdaProbe(undefined, payload).ok).toBe(true);
  });

  it('classifyKeyErrorIsOk', () => {
    const payload = '{"errorMessage": "\'source_ip\'", "errorType": "KeyError", "requestId": "abc", "stackTrace": ["  File \\"/var/task/lambda_function.py\\", line 12"]}';
    expect(classifyLambdaProbe('Unhandled', payload).ok).toBe(true);
  });

  it('classifyTimeoutFails', () => {
    const payload = '{"errorMessage": "2026-10-22T03:00:00.000Z 1234 Task timed out after 30.03 seconds"}';
    const r = classifyLambdaProbe('Unhandled', payload);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/timed out/i);
  });
});

describe('TOOL_LAMBDAS', () => {
  it('toolLambdaListHasExactly19AndExcludesWatchdog', () => {
    expect(TOOL_LAMBDAS).toHaveLength(19);
    expect(new Set(TOOL_LAMBDAS).size).toBe(19);
    expect(TOOL_LAMBDAS).not.toContain('awsops-health-watchdog');
    expect(TOOL_LAMBDAS.every((n) => n.startsWith('awsops-'))).toBe(true);
    expect(TOOL_LAMBDAS).toContain('awsops-network-mcp');
    expect(TOOL_LAMBDAS).toContain('awsops-valkey-mcp');
  });
});

describe('checkLambdas', () => {
  it('aggregatesFailuresAndCapsConcurrencyAt4', async () => {
    let inFlight = 0;
    let peak = 0;
    lambdaSend.mockImplementation(async (cmd: { input: { FunctionName: string } }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (cmd.input.FunctionName === 'awsops-iam-mcp') {
        return { FunctionError: 'Unhandled', Payload: enc('{"errorType":"Runtime.ImportModuleError","errorMessage":"No module named x"}') };
      }
      return { Payload: enc('{"statusCode":400,"body":"Unknown tool"}') };
    });
    const r = await checkLambdas();
    expect(r.id).toBe('lambda');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('awsops-iam-mcp');
    expect(lambdaSend).toHaveBeenCalledTimes(19);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('sdkErrorCountsAsFailure', async () => {
    lambdaSend.mockImplementation(async (cmd: { input: { FunctionName: string } }) => {
      if (cmd.input.FunctionName === 'awsops-core-mcp') {
        const e = new Error('Function not found'); e.name = 'ResourceNotFoundException'; throw e;
      }
      return { Payload: enc('{}') };
    });
    const r = await checkLambdas();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('awsops-core-mcp');
  });

  it('allHealthyIsOk', async () => {
    lambdaSend.mockResolvedValue({ Payload: enc('{"statusCode":400}') });
    expect((await checkLambdas()).ok).toBe(true);
  });
});

describe('checkAgentcoreRuntime', () => {
  it('readyIsOkAndUsesLastArnSegment', async () => {
    controlSend.mockResolvedValue({ status: 'READY' });
    const r = await checkAgentcoreRuntime();
    expect(r).toMatchObject({ id: 'agentcore-runtime', ok: true });
    expect(controlSend.mock.calls[0][0].input).toEqual({ agentRuntimeId: 'awsops_agent-b4JqGWCZuC' });
  });

  it('notReadyFails', async () => {
    controlSend.mockResolvedValue({ status: 'UPDATE_FAILED', failureReason: 'image pull' });
    const r = await checkAgentcoreRuntime();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('UPDATE_FAILED');
  });

  it('missingArnFails', async () => {
    configMock.mockReturnValueOnce({});
    const r = await checkAgentcoreRuntime();
    expect(r).toEqual({ id: 'agentcore-runtime', ok: false, message: 'agentRuntimeArn not configured' });
    expect(controlSend).not.toHaveBeenCalled();
  });
});

describe('checkBedrock / checkSteampipe', () => {
  it('bedrockUsesMaxTokens1', async () => {
    bedrockSend.mockResolvedValue({ body: enc('{}') });
    const r = await checkBedrock();
    expect(r).toMatchObject({ id: 'bedrock', ok: true });
    const input = bedrockSend.mock.calls[0][0].input;
    expect(input.modelId).toBe('global.anthropic.claude-opus-4-8');
    expect(JSON.parse(new TextDecoder().decode(input.body)).max_tokens).toBe(1);
  });

  it('bedrockErrorFailsWithMessage', async () => {
    const e = new Error('not authorized'); e.name = 'AccessDeniedException';
    bedrockSend.mockRejectedValue(e);
    const r = await checkBedrock();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('AccessDeniedException');
  });

  it('steampipeWrapsPing', async () => {
    expect(await checkSteampipe()).toEqual({ id: 'steampipe', ok: true, message: 'select 1 ok' });
  });
});
