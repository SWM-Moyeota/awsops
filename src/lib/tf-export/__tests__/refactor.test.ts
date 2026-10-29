// References, names, layer files and the full refactor bundle / 참조·이름·레이어 파일·정리 묶음
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExportItem, TfType } from '../types';
import { buildRefIndex, applyReferences, makeNames, splitLayers, refactorBundle, renameAddresses } from '../refactor';

const raw = readFileSync(join(__dirname, 'fixtures', 'generated.raw.tf'), 'utf-8');
const ACCT = '111122223333';

// Build an ExportItem with sensible defaults / 기본값을 채운 ExportItem 만들기
const item = (address: string, importId: string, name: string, extra: Partial<ExportItem> = {}): ExportItem => ({
  address, tfType: address.split('.')[0] as TfType, importId, nodeArn: extra.nodeArn ?? '', nodeType: 'vpc', name, id: extra.id ?? importId, ...extra,
});

const LB_ARN = `arn:aws:elasticloadbalancing:ap-northeast-2:${ACCT}:loadbalancer/app/demo-alb/4c11af5cecf3de0f`;
const TG_ARN = `arn:aws:elasticloadbalancing:ap-northeast-2:${ACCT}:targetgroup/Demo-Dashb-HCI90ZEZCMOQ/72ead790848e2cf4`;
const LAMBDA = 'DemoStack-CustomVpcRestrictDefaultSGCustomResour-FGWjcIQN9Okp';
const fixtureItems: ExportItem[] = [
  item('aws_cloudfront_distribution.r_cloudfront', 'ER7GOROQANTN7Z', 'demo-media-cdn'),
  item('aws_db_instance.r_rds', 'demo-dev-db', 'demo-dev-db'),
  item('aws_ebs_volume.r_ebs', 'vol-9ed4b4567123ca05b', 'vol-9ed4b4567123ca05b'),
  item('aws_eip.r_eip', 'eipalloc-dc9bb635f2d5abe20', 'DemoStack/VPC/PublicSubnet1'),
  item('aws_iam_role.r_role', 'DemoAgentCoreRole', 'DemoAgentCoreRole', { nodeArn: `arn:aws:iam::${ACCT}:role/DemoAgentCoreRole` }),
  item('aws_instance.r_instance', 'i-b66fe5cb52952bbef', 'DemoStack-Demo-Server'),
  item('aws_lambda_function.r_lambda', LAMBDA, LAMBDA, { nodeArn: `arn:aws:lambda:ap-northeast-2:${ACCT}:function:${LAMBDA}` }),
  item('aws_lb.r_lb', LB_ARN, 'demo-alb', { nodeArn: LB_ARN }),
  item('aws_lb_target_group.r_tg', TG_ARN, 'Demo-Dashb-HCI90ZEZCMOQ', { nodeArn: TG_ARN }),
  item('aws_nat_gateway.r_nat', 'nat-638a2b90cbb311283', 'DemoStack/VPC/PublicSubnet1'),
  item('aws_s3_bucket.r_s3', 'demo-deploy-bucket', 'demo-deploy-bucket'),
  item('aws_security_group.r_sg', 'sg-417b37380b1865e9e', 'demo-alb-sg'),
  item('aws_subnet.r_subnet', 'subnet-6436d1848ff7efdab', 'DemoStack/VPC/PublicSubnet2'),
  item('aws_vpc.r_vpc', 'vpc-c5b546ea856d69318', 'demo-vpc'),
];
const fixtureImports = fixtureItems.map(i => `import {\n  to = ${i.address}\n  id = "${i.importId}"\n}\n`).join('\n');

const TWO_SG = `resource "aws_security_group" "a" {
  name   = "sg-a-name"
  vpc_id = "vpc-1"
  ingress = [{
    security_groups = ["sg-b", "sg-a"]
    self            = false
  }]
  tags = {
    Peer = "sg-b"
  }
}

resource "aws_security_group" "b" {
  vpc_id = "vpc-1"
  ingress = [{
    security_groups = ["sg-a"]
  }]
}

resource "aws_vpc" "v" {
  cidr_block = "10.0.0.0/16"
}
`;
const twoSgItems = [item('aws_security_group.a', 'sg-a', 'web'), item('aws_security_group.b', 'sg-b', 'db'), item('aws_vpc.v', 'vpc-1', 'main')];

describe('buildRefIndex', () => {
  it('maps ids, ARNs and names to the right attributes', () => {
    const idx = buildRefIndex(fixtureItems);
    expect(idx.get('vpc-c5b546ea856d69318')).toBe('aws_vpc.r_vpc.id');
    expect(idx.get('sg-417b37380b1865e9e')).toBe('aws_security_group.r_sg.id');
    expect(idx.get('eipalloc-dc9bb635f2d5abe20')).toBe('aws_eip.r_eip.id');
    expect(idx.get('ER7GOROQANTN7Z')).toBe('aws_cloudfront_distribution.r_cloudfront.id');
    expect(idx.get(LB_ARN)).toBe('aws_lb.r_lb.arn');
    expect(idx.get(TG_ARN)).toBe('aws_lb_target_group.r_tg.arn');
    expect(idx.get(`arn:aws:iam::${ACCT}:role/DemoAgentCoreRole`)).toBe('aws_iam_role.r_role.arn');
    expect(idx.get('DemoAgentCoreRole')).toBe('aws_iam_role.r_role.name');
    expect(idx.get(LAMBDA)).toBe('aws_lambda_function.r_lambda.function_name');
    expect(idx.get(`arn:aws:lambda:ap-northeast-2:${ACCT}:function:${LAMBDA}`)).toBe('aws_lambda_function.r_lambda.arn');
    expect(idx.get('demo-deploy-bucket')).toBe('aws_s3_bucket.r_s3.bucket');
    expect(idx.has('demo-dev-db')).toBe(false);
  });
  it('maps a listener ARN to .id and drops ambiguous values', () => {
    const l = `arn:aws:elasticloadbalancing:ap-northeast-2:${ACCT}:listener/app/demo-alb/1/2`;
    const idx = buildRefIndex([
      item('aws_lb_listener.l', l, 'l', { nodeType: 'listener' }),
      item('aws_iam_role.x', 'same', 'same'), item('aws_s3_bucket.x', 'same', 'same'),
    ]);
    expect(idx.get(l)).toBe('aws_lb_listener.l.id');
    expect(idx.has('same')).toBe(false);
  });
});

describe('applyReferences', () => {
  const idx = buildRefIndex(twoSgItems);
  const out = applyReferences(TWO_SG, idx);
  it('two SGs referencing each other become references both ways', () => {
    expect(out).toContain('security_groups = [aws_security_group.b.id, "sg-a"]');
    expect(out).toMatch(/resource "aws_security_group" "b" \{[\s\S]*security_groups = \[aws_security_group\.a\.id\]/);
  });
  it('skips self-references and tags; replaces plain values', () => {
    expect(out).toContain('"sg-a"]');
    expect(out).toContain('Peer = "sg-b"');
    expect((out.match(/vpc_id = aws_vpc\.v\.id/g) ?? [])).toHaveLength(2);
    expect(out).toContain('name   = "sg-a-name"');
  });
  it('honours selfAddressOf and the skip list', () => {
    const viaFn = applyReferences(TWO_SG, idx, () => 'aws_security_group.b');
    expect(viaFn).toContain('security_groups = ["sg-b", aws_security_group.a.id]');
    const skipped = applyReferences(TWO_SG, idx, undefined, { skip: ['aws_security_group.a'] });
    expect(skipped).toContain('security_groups = ["sg-b", "sg-a"]');
    expect(skipped).toContain('security_groups = [aws_security_group.a.id]');
  });
  it('fixture: lb security_groups/subnets and lists use references; unknown ids stay', () => {
    const r = applyReferences(raw, buildRefIndex(fixtureItems));
    expect(r).toMatch(/security_groups\s+= \[aws_security_group\.r_sg\.id\]/);
    expect(r).toMatch(/subnets\s+= \[aws_subnet\.r_subnet\.id, "subnet-d5f44685cf74c6f39"\]/);
    expect(r).toMatch(/allocation_id\s+= aws_eip\.r_eip\.id/);
    expect(r).toMatch(/bucket\s+= "demo-deploy-bucket"/);
    expect(r).toMatch(/function_name\s+= "DemoStack-/);
    expect(r).toContain('vpc_id = "vpc-928b1a8ef13830697"');
  });
  it('only references names when the key fits the kind (role/function/bucket)', () => {
    const src = 'resource "aws_db_instance" "d" {\n  username = "bkt"\n  log_bucket = "bkt"\n}\n';
    const r = applyReferences(src, buildRefIndex([item('aws_s3_bucket.s', 'bkt', 'bkt')]));
    expect(r).toContain('username = "bkt"');
    expect(r).toContain('log_bucket = aws_s3_bucket.s.bucket');
  });
});

describe('makeNames', () => {
  it('snake_cases, prefixes digits, dedupes per type and caps at 48', () => {
    const m = makeNames([
      item('aws_subnet.r1', 'subnet-1', 'DemoStack/VPC/PublicSubnet1'),
      item('aws_subnet.r2', 'subnet-2', 'DemoStack/VPC/PublicSubnet1'),
      item('aws_subnet.r3', 'subnet-3', 'demostack_vpc_publicsubnet1'),
      item('aws_vpc.r4', 'vpc-1', 'DemoStack/VPC/PublicSubnet1'),
      item('aws_s3_bucket.r5', '2024-logs', '2024-logs'),
      item('aws_iam_role.r6', 'x', 'A'.repeat(60)),
      item('aws_iam_role.r7', 'y', 'A'.repeat(60)),
      item('aws_vpc.r8', 'vpc-2', '한글이름'),
    ]);
    expect(m.get('aws_subnet.r1')).toBe('aws_subnet.demostack_vpc_publicsubnet1');
    expect(m.get('aws_subnet.r2')).toBe('aws_subnet.demostack_vpc_publicsubnet1_2');
    expect(m.get('aws_subnet.r3')).toBe('aws_subnet.demostack_vpc_publicsubnet1_3');
    expect(m.get('aws_vpc.r4')).toBe('aws_vpc.demostack_vpc_publicsubnet1');
    expect(m.get('aws_s3_bucket.r5')).toBe('aws_s3_bucket.r_2024_logs');
    expect(m.get('aws_iam_role.r6')).toBe(`aws_iam_role.${'a'.repeat(48)}`);
    expect(m.get('aws_iam_role.r7')).toBe(`aws_iam_role.${'a'.repeat(46)}_2`);
    expect(m.get('aws_vpc.r8')).toBe('aws_vpc.vpc');
    for (const v of Array.from(m.values())) expect(v.split('.')[1]).toMatch(/^[a-z_][a-z0-9_]{0,47}$/);
  });
});

describe('renameAddresses', () => {
  it('renames labels and references but never strings', () => {
    const src = 'resource "aws_vpc" "r1" {\n  tags = { Name = "aws_vpc.r1" }\n}\nimport {\n  to = aws_vpc.r1\n  id = "vpc-1"\n}\noutput "o" { value = aws_vpc.r1.id }\n';
    const out = renameAddresses(src, new Map([['aws_vpc.r1', 'aws_vpc.main']]));
    expect(out).toContain('resource "aws_vpc" "main" {');
    expect(out).toContain('Name = "aws_vpc.r1"');
    expect(out).toContain('to = aws_vpc.main');
    expect(out).toContain('value = aws_vpc.main.id');
  });
});

describe('splitLayers', () => {
  it('puts each type in its layer file and omits empty layers', () => {
    const files = splitLayers(raw);
    expect(Object.keys(files).sort()).toEqual(['compute.tf', 'data.tf', 'edge.tf', 'iam.tf', 'network.tf', 'security.tf']);
    const has = (f: string, t: string) => expect(files[f], `${f} ${t}`).toContain(`resource "${t}"`);
    for (const t of ['aws_vpc', 'aws_subnet', 'aws_nat_gateway', 'aws_eip']) has('network.tf', t);
    has('security.tf', 'aws_security_group');
    for (const t of ['aws_instance', 'aws_ebs_volume', 'aws_lambda_function']) has('compute.tf', t);
    for (const t of ['aws_db_instance', 'aws_s3_bucket']) has('data.tf', t);
    has('iam.tf', 'aws_iam_role');
    for (const t of ['aws_lb', 'aws_lb_target_group', 'aws_cloudfront_distribution']) has('edge.tf', t);
    const total = Object.values(files).join('\n').match(/^resource "/gm) ?? [];
    expect(total).toHaveLength(14);
    expect(Object.values(files).join('\n')).not.toContain('__generated__');
  });
  it('is safe with braces inside strings, comments and heredocs', () => {
    const src = [
      'resource "aws_iam_role" "r" {',
      '  description = "has } and { and \\" quote"',
      '  # comment with }',
      '  inline = <<-EOT',
      '    { "a": "}" }',
      '    }',
      '  EOT',
      '}',
      'resource "aws_vpc" "v" {',
      '  cidr_block = "10.0.0.0/16"',
      '}',
      '',
    ].join('\n');
    const files = splitLayers(src);
    expect(files['iam.tf']).toContain('    }\n  EOT\n}');
    expect(files['iam.tf']).not.toContain('aws_vpc');
    expect(files['network.tf']).toBe('resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n');
  });
  it('only network when only a vpc', () => {
    expect(Object.keys(splitLayers('resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n'))).toEqual(['network.tf']);
  });
});

describe('refactorBundle', () => {
  const imports = fixtureImports;
  it('refactored: renames resources and imports consistently, references, secrets out', () => {
    const { files, secrets, addresses } = refactorBundle({ generated: raw, imports, items: fixtureItems, level: 'refactored' });
    const body = Object.entries(files).filter(([k]) => k !== 'imports.tf').map(([, v]) => v).join('\n');
    const declared = (body.match(/^resource "[^"]+" "[^"]+"/gm) ?? []).map(h => h.replace(/^resource "([^"]+)" "([^"]+)"/, '$1.$2')).sort();
    const tos = (files['imports.tf'].match(/to = \S+/g) ?? []).map(t => t.slice(5)).sort();
    expect(tos).toEqual(declared);
    expect(declared).toContain('aws_vpc.demo_vpc');
    expect(declared).toContain('aws_eip.demostack_vpc_publicsubnet1');
    expect(addresses['aws_vpc.r_vpc']).toBe('aws_vpc.demo_vpc');
    expect(body).toMatch(/allocation_id\s+= aws_eip\.demostack_vpc_publicsubnet1\.id/);
    expect(body).toMatch(/security_groups\s+= \[aws_security_group\.demo_alb_sg\.id\]/);
    expect(body).not.toContain('fake-secret-1');
    expect(Object.values(files).join('\n')).not.toContain('fake-secret-1');
    expect(secrets.find(s => s.value === 'fake-secret-1')?.address).toBe(`aws_lambda_function.${LAMBDA.toLowerCase().replace(/-/g, '_').slice(0, 48).replace(/_+$/, '')}`);
    for (const s of secrets) expect(body).toContain(`var.${s.name}`);
  });
  it('named: no references, still renamed and secrets out', () => {
    const { files } = refactorBundle({ generated: raw, imports, items: fixtureItems, level: 'named' });
    const body = Object.values(files).join('\n');
    expect(body).toMatch(/security_groups\s+= \["sg-417b37380b1865e9e"\]/);
    expect(body).toContain('resource "aws_vpc" "demo_vpc"');
    expect(body).not.toContain('fake-secret-1');
  });
  it('noRefs takes the original addresses and leaves those blocks unreferenced', () => {
    const lb = fixtureItems.find(i => i.tfType === 'aws_lb')!.address;
    const { files, addresses } = refactorBundle({ generated: raw, imports, items: fixtureItems, level: 'refactored', noRefs: [lb] });
    const edge = files['edge.tf'];
    const block = edge.slice(edge.indexOf(`resource "aws_lb" "${addresses[lb].split('.')[1]}"`));
    expect(block.slice(0, block.indexOf('\n}'))).toMatch(/security_groups\s+= \["sg-417b37380b1865e9e"\]/);
  });
  it('ignores items whose resource is no longer in the text', () => {
    const gone = item('aws_vpc.gone', 'vpc-zzz', 'gone');
    const src = 'resource "aws_subnet" "s" {\n  vpc_id = "vpc-zzz"\n}\n';
    const { files } = refactorBundle({ generated: src, imports: '', items: [gone, item('aws_subnet.s', 'subnet-1', 'app')], level: 'refactored' });
    expect(files['network.tf']).toContain('vpc_id = "vpc-zzz"');
    expect(files['network.tf']).toContain('resource "aws_subnet" "app"');
  });
});
