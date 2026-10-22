import { describe, it, expect, vi, afterEach } from 'vitest';

const ssmSend = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ Parameter: { Value: ' https://hooks.slack.com/services/T/B/S ' } })));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));

import { formatSlackMessage, postSlack, getWebhookUrl, REMEDIATION, CHECK_TITLES } from '../slack';
import type { Transition } from '../types';

const URL_ = 'https://hooks.slack.com/services/T000/B000/SECRETXYZ';
const opts = { dashboardUrl: 'https://awsops.moyeota.co.kr/', now: new Date('2026-10-22T03:00:00Z') };

function tr(partial: Partial<Transition>): Transition {
  return { id: 'steampipe', from: 'ok', to: 'fail', message: 'x', at: '2026-10-22T03:00:00Z', ...partial };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('formatSlackMessage', () => {
  it('failMessageHasRedEmojiTitleCauseActionAndLink', () => {
    const { text } = formatSlackMessage([tr({ message: 'connect ECONNREFUSED' })], opts);
    expect(text).toContain('🔴');
    expect(text).toContain('[AWSops]');
    expect(text).toContain('Steampipe');
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain(REMEDIATION.steampipe);
    expect(text).toContain('https://awsops.moyeota.co.kr/');
  });

  it('recoveryMessageIsGreenWithoutRemediation', () => {
    const { text } = formatSlackMessage([tr({ from: 'fail', to: 'ok', message: 'ok' })], opts);
    expect(text).toContain('🟢');
    expect(text).not.toContain(REMEDIATION.steampipe);
  });

  it('multipleTransitionsBundleIntoOneMessage', () => {
    const { text } = formatSlackMessage([tr({}), tr({ id: 'lambda' })], opts);
    expect(text).toContain(CHECK_TITLES.steampipe);
    expect(text).toContain(CHECK_TITLES.lambda);
  });

  it('timeIsRenderedInKst', () => {
    const { text } = formatSlackMessage([tr({})], opts);
    expect(text).toContain('2026-10-22 12:00 KST');
  });
});

describe('postSlack', () => {
  it('postSlackReturnsErrorOnNon200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no_service', { status: 404 })));
    const r = await postSlack(URL_, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('404');
    expect(r.error).not.toContain('SECRETXYZ');
  });

  it('postSlackReturnsOkOn200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    expect(await postSlack(URL_, { text: 'hi' })).toEqual({ ok: true });
  });

  it('postSlackNeverLogsWebhookUrl', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`fetch failed for ${URL_}`)));
    const r = await postSlack(URL_, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRETXYZ');
    for (const s of spies) {
      for (const call of s.mock.calls) {
        expect(call.map(String).join(' ')).not.toContain('SECRETXYZ');
      }
    }
  });
});

describe('getWebhookUrl', () => {
  it('ssmLookupHasAbortSignalTimeout', async () => {
    await expect(getWebhookUrl()).resolves.toBe('https://hooks.slack.com/services/T/B/S');
    expect(ssmSend).toHaveBeenCalledTimes(1);
    const opts2 = ssmSend.mock.calls[0][1] as { abortSignal?: unknown } | undefined;
    expect(opts2?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
