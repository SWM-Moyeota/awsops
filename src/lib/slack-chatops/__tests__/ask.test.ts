import { describe, it, expect, vi } from 'vitest';
import { askAwsops } from '../ask';

const msgs = [{ role: 'user' as const, content: 'EC2?' }];

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('askAwsops', () => {
  it('postsNonStreamingKoreanRequestToLocalAiApi', async () => {
    const fetchImpl = vi.fn(async () => res(200, { content: '답', via: 'Steampipe' }));
    const out = await askAwsops(msgs, { baseUrl: 'http://127.0.0.1:3000', fetchImpl });
    expect(out).toEqual({ content: '답', via: 'Steampipe' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/api/ai');
    expect(JSON.parse(String(init.body))).toEqual({ messages: msgs, stream: false, lang: 'ko' });
  });

  it('throwsStatusOnHttpError', async () => {
    const fetchImpl = vi.fn(async () => res(500, { error: 'boom' }));
    await expect(askAwsops(msgs, { fetchImpl })).rejects.toThrow('AI API 500: boom');
  });

  it('throwsWhenBodyHasErrorOrNoContent', async () => {
    await expect(askAwsops(msgs, { fetchImpl: vi.fn(async () => res(200, { error: 'x' })) })).rejects.toThrow();
    await expect(askAwsops(msgs, { fetchImpl: vi.fn(async () => res(200, { content: '' })) })).rejects.toThrow();
  });
});
