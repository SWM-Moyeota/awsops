import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { layoutNeighborhood, TYPE_COLORS } from '../layout';

type Side = 'center' | 'dependent' | 'dependency';
const n = (arn: string, type: string, name: string, depth: number, side: Side) => ({ arn, type, name, depth, side });

describe('layoutNeighborhood', () => {
  const nodes = [
    n('arn:c', 'sg', 'center', 0, 'center'),
    n('arn:d2', 'instance', 'web', 2, 'dependent'),
    n('arn:d1', 'eni', 'eni-1', 1, 'dependent'),
    n('arn:p-b', 'vpc', 'b-vpc', 1, 'dependency'),
    n('arn:p-a', 'role', 'a-role', 1, 'dependency'),
  ];
  const pos = layoutNeighborhood({ nodes });

  it('puts the center at x=0', () => {
    expect(pos['arn:c'].x).toBe(0);
    expect(pos['arn:c'].y).toBe(0);
  });

  it('puts a depth-2 dependent at x=-520', () => {
    expect(pos['arn:d2'].x).toBe(-520);
    expect(pos['arn:d1'].x).toBe(-260);
  });

  it('stacks depth-1 dependencies sorted by type then name at y -40 and 40', () => {
    // role < vpc, so a-role comes first. / 종류 순: role이 vpc보다 앞
    expect(pos['arn:p-a']).toEqual({ x: 260, y: -40 });
    expect(pos['arn:p-b']).toEqual({ x: 260, y: 40 });
  });

  it('sorts by name within the same type', () => {
    const p = layoutNeighborhood({ nodes: [n('arn:z', 'sg', 'zeta', 1, 'dependency'), n('arn:a', 'sg', 'alpha', 1, 'dependency')] });
    expect(p['arn:a'].y).toBe(-40);
    expect(p['arn:z'].y).toBe(40);
  });

  it('gives every input arn a position', () => {
    for (const nd of nodes) expect(pos[nd.arn]).toBeDefined();
    expect(Object.keys(pos)).toHaveLength(nodes.length);
  });
});

describe('TYPE_COLORS', () => {
  it('uses only theme accents plus gray', () => {
    const allowed = new Set(['#00d4ff', '#00ff88', '#a855f7', '#f59e0b', '#ef4444', '#6b7280']);
    for (const c of Object.values(TYPE_COLORS)) expect(allowed.has(c)).toBe(true);
    expect(Object.keys(TYPE_COLORS)).toHaveLength(15);
  });
});

describe('depGraph i18n parity', () => {
  const dir = path.resolve(__dirname, '../../../lib/i18n/translations');
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
  const ko = load('ko.json');
  const en = load('en.json');
  const zh = load('zh.json');
  const keys = Object.keys(ko).filter((k) => k.startsWith('depGraph.') || k === 'sidebar.depGraph');

  it('has depGraph keys in ko.json', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(ko['depGraph.project.notice']).toBe('안내만 해요 — 실제로 지우지 않아요');
  });

  it('every depGraph key in ko.json exists in en.json and zh.json', () => {
    const missing = keys.filter((k) => !(k in en) || !(k in zh));
    expect(missing).toEqual([]);
  });

  it('has an edge and type label for every EdgeType and NodeType', () => {
    const edges = ['in_vpc', 'in_subnet', 'uses_sg', 'allows_from', 'uses_role', 'uses_volume', 'uses_eni', 'uses_eip', 'forwards_to', 'targets', 'can_access', 'notifies', 'origin'];
    for (const e of edges) expect(ko[`depGraph.edge.${e}`]).toBeTruthy();
    for (const t of Object.keys(TYPE_COLORS)) expect(ko[`depGraph.type.${t}`]).toBeTruthy();
  });
});
