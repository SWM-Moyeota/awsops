// Rule-based cleanup of generated config / 생성된 설정의 규칙 기반 정리
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePlanErrors, applyRules, RULE_IDS, LAMBDA_PLACEHOLDER } from '../rules';
import { splitResources } from '../hcl';

const dir = join(__dirname, 'fixtures');
const raw = readFileSync(join(dir, 'generated.raw.tf'), 'utf-8');
const log = readFileSync(join(dir, 'plan-errors.txt'), 'utf-8');

const block = (text: string, address: string) => splitResources(text).find(r => r.address === address)!.body;
const absErr = (address: string, line: number, title: string, detail: string, src = 'x = 1') => {
  const [t, n] = address.split('.');
  return `Error: ${title}\n\n  with ${address},\n  on generated.tf line ${line}, in resource "${t}" "${n}":\n  ${line}: ${src}\n\n${detail}\n`;
};

describe('parsePlanErrors', () => {
  it('finds all 18 fixture errors with address and resource-relative line', () => {
    const errs = parsePlanErrors(log);
    expect(errs.length).toBe(18);
    for (const e of errs) {
      expect(e.address).toMatch(/^aws_[a-z0-9_]+\.r_[a-z0-9_]+$/);
      expect(typeof e.line).toBe('number');
      expect(e.relative).toBe(true);
      expect(e.file).toBe('generated.tf');
    }
    expect(errs[0]).toMatchObject({ title: 'Invalid combination of arguments', address: 'aws_lb.r_lb', line: 1 });
    expect(errs[0].detail).toContain('only one of `subnet_mapping,subnets`');
    expect(errs[6]).toMatchObject({ title: 'enable_lni_at_device_index must not be zero, got 0', address: 'aws_subnet.r_subnet', line: 7, detail: '' });
    expect(errs.filter(e => e.address === 'aws_lb_target_group.r_tg').map(e => e.line)).toEqual([48, 49, 62]);
  });

  it('parses absolute-line errors with source snippet, box-drawing prefixes and errors without location', () => {
    const boxed = [
      '╷',
      '│ Error: Conflicting configuration arguments',
      '│ ',
      '│   with aws_subnet.r_subnet,',
      '│   on generated.tf line 7, in resource "aws_subnet" "r_subnet":',
      '│    7:   availability_zone = "ap-northeast-2b"',
      '│ ',
      '│ "availability_zone": conflicts with availability_zone_id',
      '╵',
      '╷',
      '│ Error: No valid credential sources found',
      '│ ',
      '│ Please see the provider docs.',
      '╵',
    ].join('\n');
    const errs = parsePlanErrors(boxed);
    expect(errs).toEqual([
      { title: 'Conflicting configuration arguments', address: 'aws_subnet.r_subnet', line: 7, file: 'generated.tf', relative: false, detail: '"availability_zone": conflicts with availability_zone_id' },
      { title: 'No valid credential sources found', detail: 'Please see the provider docs.' },
    ]);
  });

  it('returns nothing for a clean log', () => {
    expect(parsePlanErrors('Plan: 3 to import, 0 to add, 0 to change, 0 to destroy.\n')).toEqual([]);
  });
});

describe('applyRules — each rule on a minimal snippet', () => {
  it('lists every rule id', () => {
    expect([...RULE_IDS]).toEqual(['drop-null', 'default-value', 'conflict-computed', 'empty-required-block', 'lb-subnet-mapping', 'lambda-placeholder', 'instance-user-data-hash']);
  });

  it('drop-null: drops attribute = null lines (with comments) but not inside heredocs or object values', () => {
    const t = [
      'resource "aws_db_instance" "a" {',
      '  password = null # sensitive',
      '  name     = "x"',
      '  user_data = <<EOT',
      '  keep = null',
      'EOT',
      '  policy = jsonencode({',
      '    Condition = null',
      '  })',
      '  tags = {',
      '    k = null',
      '  }',
      '  block {',
      '    inner = null',
      '  }',
      '}',
    ].join('\n');
    const r = applyRules(t, []);
    expect(r.text).not.toContain('password');
    expect(r.text).not.toContain('inner = null');
    expect(r.text).toContain('  keep = null');
    expect(r.text).toContain('Condition = null');
    expect(r.text).toContain('k = null');
    expect(r.applied).toContain('drop-null:aws_db_instance.a');
  });

  it('default-value: removes a default-valued line an error points at, keeps non-default ones', () => {
    const t = 'resource "aws_vpc" "v" {\n  cidr_block          = "10.0.0.0/16"\n  ipv6_netmask_length = 0\n  tags                = {}\n}\n';
    const log = absErr('aws_vpc.v', 3, 'Missing required argument', 'x') + absErr('aws_vpc.v', 2, 'Some error', 'y');
    const r = applyRules(t, parsePlanErrors(log));
    expect(r.text).not.toContain('ipv6_netmask_length');
    expect(r.text).toContain('cidr_block');
    expect(r.text).toContain('tags                = {}');
    expect(r.applied).toEqual(['default-value:aws_vpc.v']);
  });

  it('default-value: resolves resource-relative lines from the generate step', () => {
    const t = '# c\nresource "aws_vpc" "v" {\n  cidr_block          = "10.0.0.0/16"\n  ipv6_netmask_length = 0\n}\n';
    const log = 'Error: Missing required argument\n\n  with aws_vpc.v,\n  on generated.tf line 2:\n  (source code not available)\n\nx\n';
    expect(applyRules(t, parsePlanErrors(log)).text).not.toContain('ipv6_netmask_length');
  });

  it('default-value: ignores lines in other files', () => {
    const t = 'resource "aws_vpc" "v" {\n  a = 0\n  b = 0\n}\n';
    const log = 'Error: x\n\n  on imports.tf line 2:\n   2:   to = aws_vpc.v\n\ny\n';
    expect(applyRules(t, parsePlanErrors(log)).text).toBe(t);
  });

  it('conflict-computed: removes the computed side of a known conflict pair', () => {
    const t = 'resource "aws_subnet" "s" {\n  availability_zone    = "ap-northeast-2b"\n  availability_zone_id = "apne2-az2"\n}\n';
    const log = absErr('aws_subnet.s', 2, 'Conflicting configuration arguments', '"availability_zone": conflicts with\navailability_zone_id');
    const r = applyRules(t, parsePlanErrors(log));
    expect(r.text).toBe('resource "aws_subnet" "s" {\n  availability_zone    = "ap-northeast-2b"\n}\n');
    expect(r.applied).toEqual(['conflict-computed:aws_subnet.s']);
    const i = 'resource "aws_instance" "i" {\n  cpu_core_count       = 4\n  cpu_threads_per_core = 1\n  ipv6_address_count   = 1\n}\n';
    const log2 = absErr('aws_instance.i', 2, 'Conflicting configuration arguments', '"cpu_core_count": conflicts with cpu_options')
      + absErr('aws_instance.i', 3, 'Conflicting configuration arguments', '"cpu_threads_per_core": conflicts with cpu_options')
      + absErr('aws_instance.i', 4, 'Conflicting configuration arguments', '"ipv6_address_count": conflicts with ipv6_addresses');
    expect(applyRules(i, parsePlanErrors(log2)).text).toBe('resource "aws_instance" "i" {\n}\n');
    const n = 'resource "aws_nat_gateway" "n" {\n  secondary_private_ip_address_count = 2\n}\n';
    const log3 = absErr('aws_nat_gateway.n', 2, 'Conflicting configuration arguments', '"secondary_private_ip_addresses": conflicts with\nsecondary_private_ip_address_count');
    expect(applyRules(n, parsePlanErrors(log3)).text).toBe('resource "aws_nat_gateway" "n" {\n}\n');
  });

  it('empty-required-block: removes a nested block left empty whose argument "is required"', () => {
    const t = 'resource "aws_lb_target_group" "t" {\n  port = 80\n  target_failover {\n    on_deregistration = null\n    on_unhealthy      = null\n  }\n  stickiness {\n    enabled = true\n  }\n}\n';
    const log = absErr('aws_lb_target_group.t', 4, 'Missing required argument', 'The argument "target_failover.0.on_deregistration" is required, but no definition\nwas found.')
      + absErr('aws_lb_target_group.t', 8, 'Missing required argument', 'The argument "stickiness.0.type" is required, but no definition was found.');
    const r = applyRules(t, parsePlanErrors(log));
    expect(r.text).toBe('resource "aws_lb_target_group" "t" {\n  port = 80\n  stickiness {\n    enabled = true\n  }\n}\n');
    expect(r.applied).toContain('empty-required-block:aws_lb_target_group.t');
  });

  it('lb-subnet-mapping: removes subnet_mapping blocks when subnets is set', () => {
    const t = 'resource "aws_lb" "l" {\n  subnets = ["s-1"]\n  subnet_mapping {\n    subnet_id = "s-1"\n  }\n}\nresource "aws_lb" "m" {\n  subnet_mapping {\n    subnet_id = "s-2"\n  }\n}\n';
    const r = applyRules(t, []);
    expect(block(r.text, 'aws_lb.l')).toBe('resource "aws_lb" "l" {\n  subnets = ["s-1"]\n}');
    expect(block(r.text, 'aws_lb.m')).toContain('subnet_mapping');
    expect(r.applied).toEqual(['lb-subnet-mapping:aws_lb.l']);
  });

  it('lambda-placeholder: adds a placeholder filename and ignore when no code source is set', () => {
    const t = 'resource "aws_lambda_function" "f" {\n  filename      = null\n  function_name = "x"\n}\nresource "aws_lambda_function" "g" {\n  image_uri = "repo:tag"\n}\n';
    const r = applyRules(t, []);
    expect(LAMBDA_PLACEHOLDER).toBe('lambda-placeholder.zip');
    expect(block(r.text, 'aws_lambda_function.f')).toBe(
      'resource "aws_lambda_function" "f" {\n  filename = "lambda-placeholder.zip"\n  function_name = "x"\n  lifecycle {\n    ignore_changes = [filename, source_code_hash]\n  }\n}');
    expect(block(r.text, 'aws_lambda_function.g')).toBe('resource "aws_lambda_function" "g" {\n  image_uri = "repo:tag"\n}');
    expect(r.ignored).toEqual({ 'aws_lambda_function.f': ['filename', 'source_code_hash'] });
    expect(r.applied).toContain('lambda-placeholder:aws_lambda_function.f');
  });

  it('instance-user-data-hash: drops a 40-hex user_data and ignores it, keeps real scripts', () => {
    const t = 'resource "aws_instance" "i" {\n  ami       = "ami-1"\n  user_data = "8cc2f65ee9b4737809194b4438df8d69c07a5bdf"\n}\nresource "aws_instance" "j" {\n  user_data = "#!/bin/bash"\n}\n';
    const r = applyRules(t, []);
    expect(block(r.text, 'aws_instance.i')).toBe('resource "aws_instance" "i" {\n  ami       = "ami-1"\n  lifecycle {\n    ignore_changes = [user_data]\n  }\n}');
    expect(block(r.text, 'aws_instance.j')).toContain('#!/bin/bash');
    expect(r.ignored).toEqual({ 'aws_instance.i': ['user_data'] });
  });
});

describe('applyRules — real fixture', () => {
  const errs = parsePlanErrors(log);
  const rawLines = raw.split('\n');
  const rs = splitResources(raw);
  // Lines the fixture errors point to, as (address, trimmed text) / 픽스처 오류가 가리키는 줄 (주소, 줄 내용)
  const pointed = errs.map(e => {
    const r = rs.find(x => x.address === e.address)!;
    return { address: e.address!, text: rawLines[r.startLine + e.line! - 1].trim() };
  });
  // Lines that must survive: the kept side of a conflict and the aws_lb lines (subnet_mapping goes instead) / 남아야 하는 줄
  const keep = new Set([
    'aws_subnet.r_subnet|availability_zone                              = "ap-northeast-2b"',
    'aws_lb.r_lb|client_keep_alive                                            = 3600',
    'aws_lb.r_lb|subnets                                                      = ["subnet-6436d1848ff7efdab", "subnet-d5f44685cf74c6f39"]',
  ]);

  it('first pass removes every line the fixture errors point to (except the kept side) and keeps 14 resources', () => {
    const r = applyRules(raw, errs);
    expect(splitResources(r.text).length).toBe(14);
    for (const p of pointed) {
      const lines = block(r.text, p.address).split('\n').map(l => l.trim());
      const key = `${p.address}|${p.text}`;
      if (keep.has(key)) expect(lines, key).toContain(p.text);
      else expect(lines, key).not.toContain(p.text);
    }
    expect(r.text).not.toMatch(/=\s*null\s*(#.*)?$/m);
    expect(block(r.text, 'aws_lb_target_group.r_tg')).not.toContain('target_failover');
    expect(block(r.text, 'aws_lb_target_group.r_tg')).not.toContain('target_health_state');
    expect(block(r.text, 'aws_lb_target_group.r_tg')).toContain('target_group_health');
    expect(block(r.text, 'aws_subnet.r_subnet')).not.toContain('availability_zone_id');
    expect(block(r.text, 'aws_nat_gateway.r_nat')).not.toContain('secondary_private_ip_address_count');
    expect(block(r.text, 'aws_lb.r_lb')).not.toContain('subnet_mapping');
    expect(block(r.text, 'aws_lambda_function.r_lambda')).toContain(`filename = "${LAMBDA_PLACEHOLDER}"`);
    expect(block(r.text, 'aws_instance.r_instance')).not.toContain('8cc2f65ee9b4737809194b4438df8d69c07a5bdf');
    expect(r.ignored).toEqual({
      'aws_lambda_function.r_lambda': ['filename', 'source_code_hash'],
      'aws_instance.r_instance': ['user_data'],
    });
    for (const id of RULE_IDS) expect(r.applied.some(a => a.startsWith(`${id}:`)), id).toBe(true);
  });

  it('a second pass with synthetic absolute-line errors is stable (no duplicates, still 14)', () => {
    const first = applyRules(raw, errs);
    const rs1 = splitResources(first.text);
    const at = (a: string) => rs1.find(r => r.address === a)!.startLine;
    const log2 = absErr('aws_lb.r_lb', at('aws_lb.r_lb'), 'Invalid combination of arguments', '"subnet_mapping": only one of `subnet_mapping,subnets` can be specified')
      + absErr('aws_lambda_function.r_lambda', at('aws_lambda_function.r_lambda'), 'Invalid combination of arguments', '"filename": one of `filename,image_uri,s3_bucket` must be specified')
      + absErr('aws_instance.r_instance', at('aws_instance.r_instance'), 'Invalid value', 'user_data');
    const second = applyRules(first.text, parsePlanErrors(log2));
    expect(splitResources(second.text).length).toBe(14);
    expect(second.text).toBe(first.text);
    expect(second.ignored).toEqual({});
    expect(second.applied).toEqual([]);
    expect(second.text.match(/lambda-placeholder\.zip/g)!.length).toBe(1);
    expect(second.text.match(/lifecycle \{/g)!.length).toBe(2);
  });
});
