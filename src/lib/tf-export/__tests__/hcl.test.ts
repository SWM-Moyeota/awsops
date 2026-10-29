// HCL block utilities: string/heredoc-safe splitting and edits / HCL 블록 도구: 문자열·heredoc에 안전한 분리와 편집
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  splitResources, replaceResource, removeResource, removeLines, removeNestedBlock,
  insertIntoResource, setLifecycleIgnore, removeImport, renameAddress,
} from '../hcl';

const raw = readFileSync(join(__dirname, 'fixtures', 'generated.raw.tf'), 'utf-8');

describe('splitResources', () => {
  it('finds all 14 resources in the generated fixture with line ranges', () => {
    const rs = splitResources(raw);
    expect(rs.map(r => r.address)).toEqual([
      'aws_subnet.r_subnet', 'aws_security_group.r_sg', 'aws_ebs_volume.r_ebs', 'aws_lb_target_group.r_tg',
      'aws_lb.r_lb', 'aws_nat_gateway.r_nat', 'aws_eip.r_eip', 'aws_s3_bucket.r_s3', 'aws_lambda_function.r_lambda',
      'aws_db_instance.r_rds', 'aws_vpc.r_vpc', 'aws_instance.r_instance', 'aws_cloudfront_distribution.r_cloudfront',
      'aws_iam_role.r_role',
    ]);
    const subnet = rs[0];
    expect(subnet.type).toBe('aws_subnet');
    expect(subnet.name).toBe('r_subnet');
    expect(subnet.startLine).toBe(5);
    expect(subnet.endLine).toBe(40);
    expect(subnet.body.startsWith('resource "aws_subnet" "r_subnet" {')).toBe(true);
    expect(subnet.body.endsWith('}')).toBe(true);
    expect(raw.slice(subnet.start, subnet.end)).toBe(subnet.body);
    // jsonencode({...}) and list-of-object braces stay balanced / jsonencode·객체 목록 중괄호도 짝이 맞음
    const role = rs[13];
    expect(role.startLine).toBe(615);
    expect(role.endLine).toBe(651);
  });

  it('ignores braces inside quoted strings, escapes and interpolations', () => {
    const t = [
      'resource "aws_x" "a" {',
      '  d = "has } and { braces \\" still string ${lookup(m, "}")} ${ {k = "{"}["k"] }"',
      '  e = "$${not_interp {"',
      '}',
      'resource "aws_x" "b" {',
      '}',
      '',
    ].join('\n');
    const rs = splitResources(t);
    expect(rs.map(r => r.address)).toEqual(['aws_x.a', 'aws_x.b']);
    expect(rs[0].endLine).toBe(4);
  });

  it('ignores braces and fake resources inside heredocs and comments', () => {
    const t = [
      '# resource "aws_x" "commented" {',
      'resource "aws_x" "a" {',
      '  user_data = <<-EOT',
      '    }',
      '    resource "aws_x" "fake" {',
      '    say "unbalanced',
      '    ${var.x} }}',
      '    EOT',
      '  script = <<EOT',
      '{',
      'EOT',
      '  /* } { */',
      '  // }',
      '}',
      '',
    ].join('\n');
    const rs = splitResources(t);
    expect(rs.map(r => r.address)).toEqual(['aws_x.a']);
    expect(rs[0].endLine).toBe(14);
  });
});

const two = [
  '# __generated__ by Terraform',
  'resource "aws_lb" "a" {',
  '  name = "x"',
  '  subnet_mapping {',
  '    subnet_id = "s-1"',
  '  }',
  '  subnet_mapping {',
  '    subnet_id = "s-2"',
  '  }',
  '  access_logs {',
  '    subnet_mapping = "keep"',
  '  }',
  '}',
  '',
  '# __generated__ by Terraform',
  'resource "aws_lb" "b" {',
  '  subnet_mapping {',
  '    subnet_id = "s-3"',
  '  }',
  '}',
  '',
].join('\n');

describe('block edits', () => {
  it('replaceResource swaps only the named block', () => {
    const out = replaceResource(two, 'aws_lb.b', 'resource "aws_lb" "b" {\n  name = "new"\n}\n');
    expect(splitResources(out).find(r => r.address === 'aws_lb.b')!.body).toBe('resource "aws_lb" "b" {\n  name = "new"\n}');
    expect(out).toContain('subnet_id = "s-1"');
    expect(replaceResource(two, 'aws_lb.zzz', 'x')).toBe(two);
  });

  it('removeResource drops the block and its generated comment', () => {
    const out = removeResource(two, 'aws_lb.a');
    expect(splitResources(out).map(r => r.address)).toEqual(['aws_lb.b']);
    expect(out.startsWith('# __generated__ by Terraform\nresource "aws_lb" "b" {')).toBe(true);
    expect(out).not.toContain('s-1');
  });

  it('removeLines removes 1-based lines and ignores out-of-range numbers', () => {
    expect(removeLines('a\nb\nc\nd', [2, 4, 99, 0])).toBe('a\nc');
  });

  it('removeNestedBlock removes every direct occurrence in that resource only', () => {
    const out = removeNestedBlock(two, 'aws_lb.a', 'subnet_mapping');
    const a = splitResources(out).find(r => r.address === 'aws_lb.a')!.body;
    expect(a).not.toContain('s-1');
    expect(a).not.toContain('s-2');
    expect(a).toContain('subnet_mapping = "keep"');
    expect(a).toContain('access_logs {');
    expect(out).toContain('s-3');
  });

  it('removeNestedBlock accepts a dotted path for deeper blocks', () => {
    const t = 'resource "aws_x" "a" {\n  outer {\n    inner {\n      v = 1\n    }\n    w = 2\n  }\n  inner {\n    v = 3\n  }\n}\n';
    const out = removeNestedBlock(t, 'aws_x.a', 'outer.inner');
    expect(out).toBe('resource "aws_x" "a" {\n  outer {\n    w = 2\n  }\n  inner {\n    v = 3\n  }\n}\n');
  });

  it('insertIntoResource puts the snippet right after the opening line', () => {
    const out = insertIntoResource(two, 'aws_lb.b', 'filename = "lambda-placeholder.zip"');
    expect(out).toContain('resource "aws_lb" "b" {\n  filename = "lambda-placeholder.zip"\n  subnet_mapping {');
    const one = insertIntoResource('resource "aws_x" "a" {}\n', 'aws_x.a', 'v = 1');
    expect(splitResources(one)[0].body).toBe('resource "aws_x" "a" {\n  v = 1\n}');
  });
});

describe('setLifecycleIgnore', () => {
  const base = 'resource "aws_instance" "a" {\n  ami = "x"\n}\n';
  it('creates a lifecycle block at the end of the resource', () => {
    expect(setLifecycleIgnore(base, 'aws_instance.a', ['user_data'])).toBe(
      'resource "aws_instance" "a" {\n  ami = "x"\n  lifecycle {\n    ignore_changes = [user_data]\n  }\n}\n');
  });
  it('merges into an existing ignore_changes without duplicates', () => {
    const once = setLifecycleIgnore(base, 'aws_instance.a', ['filename', 'source_code_hash']);
    const twice = setLifecycleIgnore(once, 'aws_instance.a', ['source_code_hash', 'user_data']);
    expect(twice).toContain('ignore_changes = [filename, source_code_hash, user_data]');
    expect(twice.match(/lifecycle/g)!.length).toBe(1);
    const multi = 'resource "aws_x" "a" {\n  lifecycle {\n    ignore_changes = [\n      tags,\n    ]\n  }\n}\n';
    expect(setLifecycleIgnore(multi, 'aws_x.a', ['user_data'])).toBe(
      'resource "aws_x" "a" {\n  lifecycle {\n    ignore_changes = [tags, user_data]\n  }\n}\n');
  });
  it('adds ignore_changes to a lifecycle block that lacks it and keeps "all"', () => {
    const lc = 'resource "aws_x" "a" {\n  lifecycle {\n    prevent_destroy = false\n  }\n}\n';
    expect(setLifecycleIgnore(lc, 'aws_x.a', ['user_data'])).toBe(
      'resource "aws_x" "a" {\n  lifecycle {\n    ignore_changes = [user_data]\n    prevent_destroy = false\n  }\n}\n');
    const all = 'resource "aws_x" "a" {\n  lifecycle {\n    ignore_changes = all\n  }\n}\n';
    expect(setLifecycleIgnore(all, 'aws_x.a', ['user_data'])).toBe(all);
  });
  it('merges into a single-line lifecycle block instead of adding a stray line', () => {
    const one = 'resource "aws_x" "a" {\n  lifecycle { ignore_changes = [tags] }\n}\n';
    expect(setLifecycleIgnore(one, 'aws_x.a', ['user_data'])).toBe(
      'resource "aws_x" "a" {\n  lifecycle { ignore_changes = [tags, user_data] }\n}\n');
    const other = 'resource "aws_x" "a" {\n  lifecycle { create_before_destroy = true }\n}\n';
    expect(setLifecycleIgnore(other, 'aws_x.a', ['user_data'])).toBe(
      'resource "aws_x" "a" {\n  lifecycle {\n    create_before_destroy = true\n    ignore_changes = [user_data]\n  }\n}\n');
    const empty = 'resource "aws_x" "a" {\n  lifecycle {}\n}\n';
    expect(setLifecycleIgnore(empty, 'aws_x.a', ['user_data'])).toBe(
      'resource "aws_x" "a" {\n  lifecycle {\n    ignore_changes = [user_data]\n  }\n}\n');
    const allOne = 'resource "aws_x" "a" {\n  lifecycle { ignore_changes = all }\n}\n';
    expect(setLifecycleIgnore(allOne, 'aws_x.a', ['user_data'])).toBe(allOne);
  });
});

describe('imports and renames', () => {
  const imports = [
    'import {', '  to = aws_vpc.r1', '  id = "vpc-1"', '}', '',
    'import {', '  to = aws_vpc.r10', '  id = "vpc-10"', '}', '',
  ].join('\n');

  it('removeImport removes only the exact address', () => {
    const out = removeImport(imports, 'aws_vpc.r1');
    expect(out).not.toContain('vpc-1"');
    expect(out).toContain('to = aws_vpc.r10');
    expect(out).toContain('vpc-10');
    expect(removeImport(imports, 'aws_vpc.r')).toBe(imports);
  });

  it('renameAddress renames the label and references, never partial matches', () => {
    const t = [
      'resource "aws_vpc" "r1" {',
      '  cidr_block = "10.0.0.0/16"',
      '}',
      'resource "aws_vpc" "r10" {',
      '  cidr_block = "10.1.0.0/16"',
      '}',
      'resource "aws_subnet" "s" {',
      '  vpc_id     = aws_vpc.r1.id',
      '  other      = aws_vpc.r10.id',
      '  name       = "${aws_vpc.r1.id}-x"',
      '  note       = "aws_vpc.r1 literal"',
      '  ds         = data.aws_vpc.r1.id',
      '  depends_on = [aws_vpc.r1]',
      '}',
      '',
    ].join('\n');
    const out = renameAddress(t, 'aws_vpc.r1', 'aws_vpc.main');
    expect(splitResources(out).map(r => r.address)).toEqual(['aws_vpc.main', 'aws_vpc.r10', 'aws_subnet.s']);
    expect(out).toContain('vpc_id     = aws_vpc.main.id');
    expect(out).toContain('other      = aws_vpc.r10.id');
    expect(out).toContain('"${aws_vpc.main.id}-x"');
    expect(out).toContain('"aws_vpc.r1 literal"');
    expect(out).toContain('data.aws_vpc.r1.id');
    expect(out).toContain('depends_on = [aws_vpc.main]');
    expect(renameAddress(imports, 'aws_vpc.r1', 'aws_vpc.main')).toContain('to = aws_vpc.main\n');
    expect(renameAddress(imports, 'aws_vpc.r1', 'aws_vpc.main')).toContain('to = aws_vpc.r10\n');
  });
});
