// Secret detection, sensitive variables and AI scrubbing / 비밀 값 찾기, sensitive 변수, AI용 가리기
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SECRET_KEY, extractSecrets, variablesTf, tfvarsExample, secretsTfvars, scrubForAi, scrubValue } from '../secrets';

const raw = readFileSync(join(__dirname, 'fixtures', 'generated.raw.tf'), 'utf-8');

const DB = `resource "aws_db_instance" "main" {
  identifier      = "demo-dev-db"
  master_password = "fake-secret-2"
  password        = null # sensitive
  username        = "demo"
  description     = "token = \\"not-a-key\\""
  metadata_options {
    http_tokens = "required"
  }
}
`;

describe('SECRET_KEY', () => {
  it('matches the documented key words', () => {
    for (const k of ['password', 'DB_PASSWORD', 'client_secret', 'auth_token', 'credentials', 'privateKey', 'ApiKey']) expect(SECRET_KEY.test(k), k).toBe(true);
    expect(SECRET_KEY.test('username')).toBe(false);
  });
});

describe('extractSecrets', () => {
  it('moves every Lambda env value from the fixture into variables', () => {
    const { text, vars } = extractSecrets(raw);
    expect(text).not.toContain('fake-secret-1');
    expect(text).not.toContain('"demo-value"');
    const pw = vars.find(v => v.value === 'fake-secret-1')!;
    expect(pw).toBeDefined();
    expect(pw.address).toBe('aws_lambda_function.r_lambda');
    expect(pw.path).toBe('environment.variables.DB_PASSWORD');
    expect(pw.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(text).toContain(`DB_PASSWORD = var.${pw.name}`);
    expect(vars.map(v => v.path).sort()).toEqual(['environment.variables.APP_MODE', 'environment.variables.DB_PASSWORD']);
  });
  it('fixture: null-valued and excluded keys (http_tokens, *_arn, *_id) are not variables', () => {
    const { vars } = extractSecrets(raw);
    expect(vars.some(v => /http_tokens|password_wo|secret_arn|kms_key_id/.test(v.path))).toBe(false);
  });
  it('extracts a master_password-like key and leaves non-secret strings alone', () => {
    const { text, vars } = extractSecrets(DB);
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ value: 'fake-secret-2', address: 'aws_db_instance.main', path: 'master_password', name: 'main_master_password' });
    expect(text).toContain('master_password = var.main_master_password');
    expect(text).toContain('username        = "demo"');
    expect(text).toContain('http_tokens = "required"');
    expect(text).toContain('description     = "token = \\"not-a-key\\""');
    expect(text).toContain('password        = null # sensitive');
  });
  it('decodes escapes and heredoc values; dedupes names', () => {
    const src = `resource "aws_lambda_function" "f" {
  environment {
    variables = {
      "api-key" = "a\\"b$\${c}"
      CERT      = <<-EOT
        line1
        line2
      EOT
    }
  }
}
resource "aws_lambda_function" "f2" {
  secret = "x"
  secret = "y"
}
`;
    const { text, vars } = extractSecrets(src);
    expect(vars.find(v => v.path === 'environment.variables.api-key')!.value).toBe('a"b${c}');
    expect(vars.find(v => v.path === 'environment.variables.CERT')!.value).toBe('line1\nline2\n');
    expect(text).not.toContain('line1');
    expect(text).not.toContain('EOT');
    const names = vars.filter(v => v.address === 'aws_lambda_function.f2').map(v => v.name);
    expect(names).toEqual(['f2_secret', 'f2_secret_2']);
    expect(new Set(vars.map(v => v.name)).size).toBe(vars.length);
  });
  it('returns the text unchanged when there are no secrets', () => {
    const src = 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n';
    expect(extractSecrets(src)).toEqual({ text: src, vars: [] });
  });
});

describe('variable files', () => {
  const vars = [
    { name: 'f_env_db_password', value: 'p"w\\\n${x}', address: 'aws_lambda_function.f', path: 'environment.variables.DB_PASSWORD' },
    { name: 'db_master_password', value: 'z', address: 'aws_db_instance.db', path: 'master_password' },
  ];
  it('variablesTf declares sensitive variables without defaults', () => {
    const out = variablesTf(vars);
    expect(out.match(/variable "/g)).toHaveLength(2);
    expect(out.match(/sensitive\s*=\s*true/g)).toHaveLength(2);
    expect(out).not.toMatch(/default/);
    expect(out).not.toContain('p"w');
  });
  it('tfvarsExample uses CHANGE_ME only', () => {
    const out = tfvarsExample(vars);
    expect(out).toContain('f_env_db_password = "CHANGE_ME"');
    expect(out).toContain('db_master_password = "CHANGE_ME"');
    expect(out).not.toContain('z"');
  });
  it('secretsTfvars writes real values HCL-escaped', () => {
    const out = secretsTfvars(vars);
    expect(out).toContain('f_env_db_password = "p\\"w\\\\\\n$${x}"');
    expect(out).toContain('db_master_password = "z"');
  });
  it('empty input gives empty strings', () => {
    expect(variablesTf([])).toBe('');
    expect(tfvarsExample([])).toBe('');
    expect(secretsTfvars([])).toBe('');
  });
});

describe('scrubForAi', () => {
  it('leaves no secret value from the fixture or the db block', () => {
    const out = scrubForAi(raw + '\n' + DB);
    expect(out).not.toContain('fake-secret-1');
    expect(out).not.toContain('fake-secret-2');
    expect(out).not.toContain('demo-value');
    expect(out).toContain('DB_PASSWORD = "[숨김]"');
    expect(out).toContain('master_password = "[숨김]"');
    expect(out).toContain('username        = "demo"');
    expect(out.split('\n').length).toBe((raw + '\n' + DB).split('\n').length);
  });
  it('scrubs secret strings inside lists and heredocs', () => {
    const out = scrubForAi('resource "x" "y" {\n  tokens = ["t1", "t2"]\n  api_key = <<EOT\nsecretbody\nEOT\n}\n');
    expect(out).not.toMatch(/t1|t2|secretbody/);
  });
});

describe('scrubValue', () => {
  it('hides values on secret paths and Lambda env paths', () => {
    expect(scrubValue('master_password', 'x')).toBe('[숨김]');
    expect(scrubValue('environment.0.variables.APP_MODE', 'demo')).toBe('[숨김]');
    expect(scrubValue('environment[0].variables', { A: 'x', B: 'y' })).toEqual({ A: '[숨김]', B: '[숨김]' });
    expect(scrubValue('', { environment: [{ variables: { DB_PASSWORD: 'p' } }], name: 'n' })).toEqual({ environment: [{ variables: { DB_PASSWORD: '[숨김]' } }], name: 'n' });
  });
  it('keeps other values', () => {
    expect(scrubValue('tags.Name', 'demo')).toBe('demo');
    expect(scrubValue('metadata_options.0.http_tokens', 'required')).toBe('required');
    expect(scrubValue('password', null)).toBe(null);
  });
});
