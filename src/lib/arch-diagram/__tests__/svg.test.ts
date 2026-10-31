import { describe, it, expect } from 'vitest';
import { buildModel } from '../model';
import { esc, renderSvg } from '../svg';
import { bigRows, DEMO_VPC } from './fixtures';

const render = (rows = bigRows(), direction: 'TB' | 'LR' = 'TB', lang: 'ko' | 'en' | 'zh' = 'ko') => renderSvg(buildModel(rows, { vpc: DEMO_VPC, region: 'ap-northeast-2' }), { direction, lang });

describe('renderSvg', () => {
  it('is a standalone document with a legend entry for every resource', () => {
    const svg = render();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('demo-vpc');
    expect(svg).toContain('범례');
    expect(svg).toContain('api-server-with-a-very-long-name-for');
    expect(svg).toContain('빈 서브넷 1개 숨김');
    expect(svg).toContain('정지된 서버 1대 숨김');
  });
  it('defines only the icons it uses, once each, and every use resolves', () => {
    const svg = render();
    expect(svg).toContain('id="i-alb"');
    expect(svg).not.toContain('id="i-tgw"');
    const uses = Array.from(svg.matchAll(/<use href="#(i-[a-z0-9]+)"/g)).map(m => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of Array.from(new Set(uses))) expect(svg.match(new RegExp(`id="${u}"`, 'g'))).toHaveLength(1);
    const ids = Array.from(svg.matchAll(/\bid="([^"]+)"/g)).map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('neutralises hostile tag values', () => {
    const rows = bigRows();
    const evil = '<script>alert(1)</script>"onload=x\u0007&';
    rows.ec2[0].name = evil;
    rows.vpcSubnets = rows.vpcSubnets.map(s => ({ ...s, vpc_name: evil, subnet_name: `${evil}/x${s.subnet_id}` }));
    const svg = render(rows);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('"onload=');
    expect(svg).not.toContain('\u0007');
    expect(svg).toContain('&lt;script&gt;');
  });
  it('says so when nothing is running in the VPC', () => {
    const r = bigRows();
    r.ec2 = []; r.elb = []; r.nat = []; r.rds = []; r.elasticache = []; r.lambda = [];
    expect(render(r)).toContain('켜져 있는 리소스가 없어요');
    expect(render()).not.toContain('켜져 있는 리소스가 없어요');
  });
  it('escapes all XML specials', () => {
    expect(esc(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&#39;');
    expect(esc(null)).toBe('');
  });
  it('speaks the requested language and draws both directions', () => {
    expect(render(bigRows(), 'TB', 'en')).toContain('Legend');
    expect(render(bigRows(), 'TB', 'zh')).toContain('图例');
    expect(render(bigRows(), 'LR')).toContain('demo-alb');
  });
  it('keeps icon bodies free of scripts and outside links', () => {
    expect(render()).not.toMatch(/<script|<image|<foreignObject|\son\w+=|href="http/i);
  });
});
