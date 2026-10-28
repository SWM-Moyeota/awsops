import { describe, it, expect, afterAll } from 'vitest';
import { parseGraphRequest, handleGraphRequest } from '../api';
import { createGraphStore, type GraphStore } from '../store';
import type { GraphData, GraphNode, NodeType } from '../types';

const P = (s: string) => new URLSearchParams(s);
const ARN = 'arn:aws:ec2:r:111111111111:instance/i-1';

describe('parseGraphRequest', () => {
  it('rejects unknown op', () => { expect(parseGraphRequest(P('op=bogus'))).toHaveProperty('error'); expect(parseGraphRequest(P(''))).toHaveProperty('error'); });
  it('rejects bad arn', () => { expect(parseGraphRequest(P('op=impact&arn=foo'))).toHaveProperty('error'); expect(parseGraphRequest(P('op=impact'))).toHaveProperty('error'); });
  it('clamps depth per op', () => {
    expect(parseGraphRequest(P(`op=impact&arn=${ARN}&depth=9`))).toMatchObject({ op: 'impact', depth: 3 });
    expect(parseGraphRequest(P(`op=neighborhood&arn=${ARN}&depth=9`))).toMatchObject({ op: 'neighborhood', depth: 2 });
    expect(parseGraphRequest(P(`op=deps&arn=${ARN}&depth=5`))).toMatchObject({ op: 'deps', depth: 5 });
  });
  it('parses tag on first =', () => {
    expect(parseGraphRequest(P('op=project&tag=Project=x'))).toEqual({ op: 'project', seed: { kind: 'tag', key: 'Project', value: 'x' } });
    expect(parseGraphRequest(P('op=project&tag=a=b=c'))).toMatchObject({ seed: { key: 'a', value: 'b=c' } });
    expect(parseGraphRequest(P('op=project&tag=noequals'))).toHaveProperty('error');
    expect(parseGraphRequest(P('op=project&tag=k='))).toHaveProperty('error');
  });
  it('requires exactly one project seed', () => {
    expect(parseGraphRequest(P('op=project&tag=a=b&prefix=x'))).toHaveProperty('error');
    expect(parseGraphRequest(P('op=project'))).toHaveProperty('error');
    expect(parseGraphRequest(P('op=project&vpc=foo'))).toHaveProperty('error');
    expect(parseGraphRequest(P('op=project&prefix=moyeota-'))).toMatchObject({ seed: { kind: 'prefix', prefix: 'moyeota-' } });
  });
  it('rejects long q; drops bad accountId', () => {
    expect(parseGraphRequest(P(`op=search&q=${'a'.repeat(101)}`))).toHaveProperty('error');
    expect(parseGraphRequest(P('op=hubs&accountId=abc'))).toEqual({ op: 'hubs' });
    expect(parseGraphRequest(P('op=hubs&accountId=111111111111'))).toEqual({ op: 'hubs', accountId: '111111111111' });
  });
});

const node = (arn: string, type: NodeType, name: string): GraphNode => ({ arn, type, id: name, name, accountId: '111111111111', region: 'r', attrs: {} });
const data: GraphData = {
  nodes: [node(ARN, 'instance', 'moyeota-a'), node('arn:sg', 'sg', 'moyeota-sg')],
  edges: [{ src: ARN, dst: 'arn:sg', type: 'uses_sg' }], dropped: 0,
};
let store: GraphStore;
const getStore = async () => (store ??= await createGraphStore(data, { builtAt: 'T', nodeCounts: {}, edgeCount: 1, dropped: 0, warnings: [] }));
afterAll(async () => { await store?.close(); });

describe('handleGraphRequest', () => {
  it('null store -> building', async () => {
    expect(await handleGraphRequest({ op: 'stats' }, null)).toEqual({ status: 200, body: { status: 'building' } });
  });
  it('unknown arn -> 404', async () => {
    const r = await handleGraphRequest({ op: 'impact', arn: 'arn:nope', depth: 3 }, await getStore());
    expect(r).toEqual({ status: 404, body: { error: 'not-found', builtAt: 'T' } });
  });
  it('impact ok with builtAt', async () => {
    const r = await handleGraphRequest({ op: 'impact', arn: 'arn:sg', depth: 3 }, await getStore());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ builtAt: 'T', truncated: false });
  });
  it('stats / search / hubs / neighborhood', async () => {
    const s = await getStore();
    expect((await handleGraphRequest({ op: 'stats' }, s)).body).toMatchObject({ status: 'ready' });
    expect((await handleGraphRequest({ op: 'search', q: 'moyeota' }, s)).body).toMatchObject({ builtAt: 'T', results: expect.any(Array) });
    expect((await handleGraphRequest({ op: 'hubs' }, s)).body).toMatchObject({ builtAt: 'T', hubs: expect.any(Array) });
    expect((await handleGraphRequest({ op: 'neighborhood', arn: 'arn:sg', depth: 2 }, s)).body).toMatchObject({ builtAt: 'T', center: { arn: 'arn:sg' } });
    expect((await handleGraphRequest({ op: 'neighborhood', arn: 'arn:x', depth: 2 }, s)).status).toBe(404);
  });
  it('project prefix returns members', async () => {
    const r = await handleGraphRequest({ op: 'project', seed: { kind: 'prefix', prefix: 'moyeota-' } }, await getStore());
    expect(r.status).toBe(200);
    expect((r.body as { members: unknown[] }).members).toHaveLength(2);
  });
});
