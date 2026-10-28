// Replay-test scenarios for the suspect ranker, written before any scoring code.
// 용의자 순위 재현 시험 시나리오 — 점수식 구현 전에, 운영자 관점에서 정답을 정해 두고 쓴다.
import type { EdgeType, GraphEdge, GraphNode, NodeType } from '@/lib/dep-graph/types';
import type { GraphSnapshot, Scenario } from '../types';

type Obj = Record<string, unknown>;

// ---------- deterministic ids / 결정적 ID ----------

// FNV-1a 32-bit hash. / 같은 시드는 항상 같은 값.
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
// Hex string of `len` chars from a seed. / 시드로 만든 16진 문자열.
function hex(seed: string, len: number): string {
  let out = '';
  for (let i = 0; out.length < len; i++) out += fnv(`${seed}#${i}`).toString(16).padStart(8, '0');
  return out.slice(0, len);
}
// UUID v4-shaped id from a seed. / 시드로 만든 UUID 모양 ID.
function uuid(seed: string): string {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const up = (s: string): string => s.toUpperCase();

// ---------- time / 시간 ----------

// ISO time `min` minutes from `start` (negative = before). / 시작 기준 분 단위 상대 시각.
const rel = (start: string, min: number): string => new Date(Date.parse(start) + Math.round(min * 60_000)).toISOString();
// CloudTrail eventTime format (no millis). / CloudTrail eventTime 형식(밀리초 없음).
const ctTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------- accounts, regions / 계정·리전 ----------

const ACC = {
  commerce: '304955781126',
  platform: '512873360947',
  data: '729104558832',
  global: '846215390071',
  payments: '183740926655',
  staging: '650318274409',
  ingest: '927461035518',
} as const;
const SEOUL = 'ap-northeast-2';
const TOKYO = 'ap-northeast-1';
const VIRGINIA = 'us-east-1';
const OREGON = 'us-west-2';

// ---------- graph builder / 그래프 빌더 ----------

// Small GraphData builder with real ARN formats and dep-graph edge directions (src uses dst).
// 실제 ARN 형식과 dep-graph 간선 방향(src가 dst를 쓴다)을 따르는 작은 그래프 빌더.
class Topo {
  private byKey = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private hosts = new Map<string, number>();
  constructor(readonly account: string, readonly region: string) {}

  private h(k: string, n: number): string { return hex(`${this.account}/${this.region}/${k}`, n); }
  private put(key: string, type: NodeType, id: string, arn: string, name: string, attrs: Obj, region = this.region): string {
    if (this.byKey.has(key)) throw new Error(`duplicate key ${key}`);
    this.byKey.set(key, { arn, type, id, name, accountId: this.account, region, attrs });
    return arn;
  }
  n(key: string): GraphNode {
    const node = this.byKey.get(key);
    if (!node) throw new Error(`unknown key ${key}`);
    return node;
  }
  arn(key: string): string { return this.n(key).arn; }
  id(key: string): string { return this.n(key).id; }
  ip(key: string): string { return String(this.n(key).attrs.privateIp); }

  edge(src: string, dst: string, type: EdgeType): void {
    const s = this.arn(src), d = this.arn(dst);
    if (!this.edges.some(e => e.src === s && e.dst === d && e.type === type)) this.edges.push({ src: s, dst: d, type });
  }
  unedge(src: string, dst: string, type: EdgeType): void {
    const s = this.arn(src), d = this.arn(dst);
    const before = this.edges.length;
    this.edges = this.edges.filter(e => !(e.src === s && e.dst === d && e.type === type));
    if (this.edges.length === before) throw new Error(`no edge ${src} -${type}-> ${dst}`);
  }
  attr(key: string, k: string, v: unknown): void { this.n(key).attrs[k] = v; }
  // Deep copy so later edits do not leak into earlier snapshots. / 깊은 복사 — 뒤의 수정이 앞 스냅샷에 새지 않게.
  snapshot(builtAt: string): GraphSnapshot {
    const data = { nodes: Array.from(this.byKey.values()), edges: this.edges, dropped: 0 };
    return { builtAt, data: JSON.parse(JSON.stringify(data)) };
  }

  private nextIp(subnet: string): string {
    const base = String(this.n(subnet).attrs.cidr).split('/')[0].split('.').slice(0, 3).join('.');
    const host = (this.hosts.get(subnet) ?? 10) + 1;
    this.hosts.set(subnet, host);
    return `${base}.${host}`;
  }

  vpc(key: string, name: string, cidr: string): string {
    const id = `vpc-${this.h(key, 17)}`;
    return this.put(key, 'vpc', id, `arn:aws:ec2:${this.region}:${this.account}:vpc/${id}`, name, { cidr, isDefault: false, tags: { Name: name } });
  }
  subnet(key: string, vpc: string, name: string, cidr: string, az: string): string {
    const id = `subnet-${this.h(key, 17)}`;
    const arn = this.put(key, 'subnet', id, `arn:aws:ec2:${this.region}:${this.account}:subnet/${id}`, name, { cidr, az, tags: { Name: name } });
    this.edge(key, vpc, 'in_vpc');
    return arn;
  }
  sg(key: string, vpc: string, groupName: string): string {
    const id = `sg-${this.h(key, 17)}`;
    const arn = this.put(key, 'sg', id, `arn:aws:ec2:${this.region}:${this.account}:security-group/${id}`, groupName, { vpcId: this.id(vpc) });
    this.edge(key, vpc, 'in_vpc');
    return arn;
  }
  // `group` has an inbound rule referencing `from`. / group의 인바운드 규칙이 from을 참조한다.
  allow(group: string, from: string): void { this.edge(group, from, 'allows_from'); }
  eni(key: string, subnet: string, sgs: string[], opts: { desc?: string; iface?: string; managed?: boolean } = {}): string {
    const id = `eni-${this.h(key, 17)}`;
    const name = opts.desc || id;
    const arn = this.put(key, 'eni', id, `arn:aws:ec2:${this.region}:${this.account}:network-interface/${id}`, name, {
      interfaceType: opts.iface ?? 'interface', status: 'in-use', privateIp: this.nextIp(subnet), requesterManaged: opts.managed === true,
    });
    this.edge(key, subnet, 'in_subnet');
    for (const g of sgs) this.edge(key, g, 'uses_sg');
    return arn;
  }
  // Instance with its primary ENI (`<key>.eni`) and optional role / root volume. / 기본 ENI 포함 인스턴스.
  instance(key: string, subnet: string, sgs: string[], o: { name: string; type?: string; role?: string; volume?: number; state?: string }): string {
    const id = `i-${this.h(key, 17)}`;
    this.eni(`${key}.eni`, subnet, sgs);
    const arn = this.put(key, 'instance', id, `arn:aws:ec2:${this.region}:${this.account}:instance/${id}`, o.name, {
      state: o.state ?? 'running', instanceType: o.type ?? 'm7g.large', privateIp: this.ip(`${key}.eni`), tags: { Name: o.name },
    });
    this.edge(key, subnet, 'in_subnet');
    for (const g of sgs) this.edge(key, g, 'uses_sg');
    this.edge(key, `${key}.eni`, 'uses_eni');
    if (o.role) this.edge(key, o.role, 'uses_role');
    if (o.volume) {
      const vid = `vol-${this.h(`${key}.vol`, 17)}`;
      this.put(`${key}.vol`, 'ebs', vid, `arn:aws:ec2:${this.region}:${this.account}:volume/${vid}`, vid, { size: o.volume, volumeType: 'gp3', state: 'in-use' });
      this.edge(key, `${key}.vol`, 'uses_volume');
    }
    return arn;
  }
  // ALB/NLB with one ELB-managed ENI per subnet. / 서브넷마다 ELB 관리 ENI가 붙은 로드밸런서.
  lb(key: string, name: string, kind: 'app' | 'net', subnets: string[], sgs: string[], scheme: 'internet-facing' | 'internal' = 'internet-facing'): string {
    const tail = `${kind}/${name}/${this.h(key, 16)}`;
    const dns = kind === 'app'
      ? `${scheme === 'internal' ? 'internal-' : ''}${name}-${fnv(key + this.account) % 2_000_000_000}.${this.region}.elb.amazonaws.com`
      : `${name}-${this.h(`${key}.dns`, 16)}.elb.${this.region}.amazonaws.com`;
    const arn = this.put(key, 'lb', name, `arn:aws:elasticloadbalancing:${this.region}:${this.account}:loadbalancer/${tail}`, name, {
      lbType: kind === 'app' ? 'application' : 'network', scheme, dnsName: dns,
    });
    subnets.forEach((s, i) => {
      this.edge(key, s, 'in_subnet');
      const eni = `${key}.eni${i}`;
      this.eni(eni, s, sgs, { desc: `ELB ${tail}`, managed: true });
      this.edge(key, eni, 'uses_eni');
    });
    for (const g of sgs) this.edge(key, g, 'uses_sg');
    return arn;
  }
  listener(lb: string, port: number): string {
    return `${this.arn(lb).replace(':loadbalancer/', ':listener/')}/${this.h(`${lb}:${port}`, 16)}`;
  }
  rule(lb: string, port: number, n: number): string {
    return `${this.listener(lb, port).replace(':listener/', ':listener-rule/')}/${this.h(`${lb}:${port}:rule${n}`, 16)}`;
  }
  tg(key: string, name: string, vpc: string, lbs: string[], targets: string[], o: { port: number; protocol?: string; targetType?: 'instance' | 'lambda' }): string {
    const arn = this.put(key, 'tg', name, `arn:aws:elasticloadbalancing:${this.region}:${this.account}:targetgroup/${name}/${this.h(key, 16)}`, name, {
      targetType: o.targetType ?? 'instance', port: o.targetType === 'lambda' ? null : o.port, protocol: o.targetType === 'lambda' ? null : o.protocol ?? 'HTTP',
    });
    for (const l of lbs) this.edge(l, key, 'forwards_to');
    this.edge(key, vpc, 'in_vpc');
    for (const t of targets) this.edge(key, t, 'targets');
    return arn;
  }
  role(key: string, name: string): string {
    return this.put(key, 'role', name, `arn:aws:iam::${this.account}:role/${name}`, name, { path: '/' }, 'global');
  }
  s3(key: string, bucket: string): string {
    return this.put(key, 's3', bucket, `arn:aws:s3:::${bucket}`, bucket, {});
  }
  access(role: string, s3: string): void { this.edge(role, s3, 'can_access'); }
  // RDS with its RDSNetworkInterface ENI (`<key>.eni`). / RDS와 그 ENI.
  rds(key: string, ident: string, subnets: string[], sgs: string[], engine: string, cls: string): string {
    const arn = this.put(key, 'rds', ident, `arn:aws:rds:${this.region}:${this.account}:db:${ident}`, ident, { engine, class: cls, status: 'available' });
    for (const s of subnets) this.edge(key, s, 'in_subnet');
    for (const g of sgs) this.edge(key, g, 'uses_sg');
    this.eni(`${key}.eni`, subnets[0], sgs, { desc: 'RDSNetworkInterface', managed: true });
    this.edge(key, `${key}.eni`, 'uses_eni');
    return arn;
  }
  // Lambda, optionally in a VPC with a Hyperplane ENI (`<key>.eni`). / VPC 람다면 Hyperplane ENI 포함.
  lambda(key: string, name: string, role: string, o: { runtime: string; subnets?: string[]; sgs?: string[] }): string {
    const arn = this.put(key, 'lambda', name, `arn:aws:lambda:${this.region}:${this.account}:function:${name}`, name, { runtime: o.runtime, state: 'Active' });
    this.edge(key, role, 'uses_role');
    if (o.subnets && o.sgs) {
      for (const s of o.subnets) this.edge(key, s, 'in_subnet');
      for (const g of o.sgs) this.edge(key, g, 'uses_sg');
      this.eni(`${key}.eni`, o.subnets[0], o.sgs, { desc: `AWS Lambda VPC ENI-${name}`, iface: 'lambda', managed: true });
      this.edge(key, `${key}.eni`, 'uses_eni');
    }
    return arn;
  }
  nat(key: string, subnet: string, name: string): string {
    const id = `nat-${this.h(key, 17)}`;
    const arn = this.put(key, 'nat', id, `arn:aws:ec2:${this.region}:${this.account}:natgateway/${id}`, name, { state: 'available', tags: { Name: name } });
    const alloc = `eipalloc-${this.h(`${key}.eip`, 17)}`;
    const pub = `13.${fnv(key) % 200 + 20}.${fnv(`${key}b`) % 250}.${fnv(`${key}c`) % 250}`;
    this.put(`${key}.eip`, 'eip', alloc, `arn:aws:ec2:${this.region}:${this.account}:elastic-ip/${alloc}`, pub, { publicIp: pub });
    this.eni(`${key}.eni`, subnet, [], { desc: `Interface for NAT Gateway ${id}`, iface: 'nat_gateway', managed: true });
    this.edge(key, subnet, 'in_subnet');
    this.edge(key, `${key}.eni`, 'uses_eni');
    this.edge(key, `${key}.eip`, 'uses_eip');
    return arn;
  }
}

// Common web tier: VPC, 2 public + 2 app subnets, LB → TG → instances → ENI → SG.
// 흔한 웹 계층 — 키: vpc, pub-a/pub-b, app-a/app-b, sg-lb, sg-app, lb, tg, web1..N, role.
interface Web { prefix: string; octet: number; count: number; port: number; kind?: 'app' | 'net'; protocol?: string; tgName?: string; role?: string; type?: string }
function webTier(g: Topo, w: Web): void {
  const [z1, z2] = g.region.startsWith('ap-northeast') ? ['a', 'c'] : ['a', 'b'];
  const kind = w.kind ?? 'app';
  g.vpc('vpc', `${w.prefix}-prod-vpc`, `10.${w.octet}.0.0/16`);
  g.subnet('pub-a', 'vpc', `${w.prefix}-public-${z1}`, `10.${w.octet}.0.0/24`, `${g.region}${z1}`);
  g.subnet('pub-b', 'vpc', `${w.prefix}-public-${z2}`, `10.${w.octet}.1.0/24`, `${g.region}${z2}`);
  g.subnet('app-a', 'vpc', `${w.prefix}-private-${z1}`, `10.${w.octet}.10.0/24`, `${g.region}${z1}`);
  g.subnet('app-b', 'vpc', `${w.prefix}-private-${z2}`, `10.${w.octet}.11.0/24`, `${g.region}${z2}`);
  g.sg('sg-app', 'vpc', `${w.prefix}-app-sg`);
  if (kind === 'app') {
    g.sg('sg-lb', 'vpc', `${w.prefix}-alb-sg`);
    g.allow('sg-app', 'sg-lb');
    g.lb('lb', `${w.prefix}-alb`, 'app', ['pub-a', 'pub-b'], ['sg-lb']);
  } else {
    g.lb('lb', `${w.prefix}-nlb`, 'net', ['pub-a', 'pub-b'], []);
  }
  if (w.role) g.role('role', w.role);
  const targets: string[] = [];
  for (let i = 1; i <= w.count; i++) {
    const k = `web${i}`;
    g.instance(k, i % 2 ? 'app-a' : 'app-b', ['sg-app'], { name: `${w.prefix}-web-${String(i).padStart(2, '0')}`, type: w.type, role: w.role ? 'role' : undefined, volume: 30 });
    targets.push(k);
  }
  g.tg('tg', w.tgName ?? `${w.prefix}-tg`, 'vpc', ['lb'], targets, { port: w.port, protocol: w.protocol ?? (kind === 'app' ? 'HTTP' : 'TCP') });
}

// ---------- CloudTrail identities and tools / 주체와 도구 ----------

interface Who { identity: Obj; ua: string; ip: string; console?: boolean }

const UA = {
  console: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  consoleWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  cli: (cmd: string) => `aws-cli/2.18.4 md/awscrt#0.22.0 ua/2.0 os/macos#24.0.0 md/arch#arm64 lang/python#3.12.6 md/pyimpl#CPython cfg/retry-mode#standard md/installer#exe md/prompt#off md/command#${cmd}`,
  tf: (api: string) => `APN/1.0 HashiCorp/1.0 Terraform/1.9.8 (+https://www.terraform.io) terraform-provider-aws/5.72.1 (+https://registry.terraform.io/providers/hashicorp/aws) aws-sdk-go-v2/1.32.2 ua/2.1 os/linux lang/go#1.23.2 md/GOOS#linux md/GOARCH#amd64 api/${api}`,
  boto: 'Boto3/1.35.44 md/Botocore#1.35.44 ua/2.0 os/linux#6.1.112-124.190.amzn2023.x86_64 md/arch#x86_64 lang/python#3.12.7 md/pyimpl#CPython cfg/retry-mode#legacy Botocore/1.35.44',
  sdkJs: (api: string) => `aws-sdk-js/3.658.1 ua/2.1 os/linux#6.1.112-124.190.amzn2023.aarch64 lang/js md/nodejs#20.18.0 api/${api}#3.658.1`,
  ssm: 'aws-sdk-go/1.44.302 (go1.22.5; linux; arm64) amazon-ssm-agent/3.3.987.0',
  lambdaLogs: 'awslambda-worker/1.0 rusoto/0.48.0 rust/1.79.0 linux',
};

function iamUser(acct: string, user: string): Obj {
  return { type: 'IAMUser', principalId: `AIDA${up(hex(`${acct}:${user}`, 17))}`, arn: `arn:aws:iam::${acct}:user/${user}`, accountId: acct, accessKeyId: `AKIA${up(hex(`${acct}:${user}:key`, 16))}`, userName: user };
}
function assumed(acct: string, roleName: string, session: string, o: { path?: string; invokedBy?: string; sourceIdentity?: string } = {}): Obj {
  const rid = `AROA${up(hex(`${acct}:${roleName}`, 17))}`;
  const ctx: Obj = {
    sessionIssuer: { type: 'Role', principalId: rid, arn: `arn:aws:iam::${acct}:role/${o.path ?? ''}${roleName}`, accountId: acct, userName: roleName },
    attributes: { creationDate: '', mfaAuthenticated: 'false' },
  };
  if (o.sourceIdentity) ctx.sourceIdentity = o.sourceIdentity;
  const id: Obj = { type: 'AssumedRole', principalId: `${rid}:${session}`, arn: `arn:aws:sts::${acct}:assumed-role/${roleName}/${session}`, accountId: acct, accessKeyId: `ASIA${up(hex(`${acct}:${roleName}:${session}`, 16))}`, sessionContext: ctx };
  if (o.invokedBy) id.invokedBy = o.invokedBy;
  return id;
}
// IAM Identity Center (SSO) user session. / SSO 사용자 세션.
function sso(acct: string, email: string, perm = 'AdministratorAccess'): Obj {
  return assumed(acct, `AWSReservedSSO_${perm}_${hex(`${acct}:${perm}`, 16)}`, email, { path: `aws-reserved/sso.amazonaws.com/${SEOUL}/` });
}

const viaConsole = (identity: Obj, ip: string, ua = UA.console): Who => ({ identity, ua, ip, console: true });
const viaCli = (identity: Obj, ip: string, cmd: string): Who => ({ identity, ua: UA.cli(cmd), ip });
const viaTf = (identity: Obj, ip: string, api: string): Who => ({ identity, ua: UA.tf(api), ip });
const viaBoto = (identity: Obj, ip: string): Who => ({ identity, ua: UA.boto, ip });
const viaService = (identity: Obj, host: string): Who => ({ identity, ua: host, ip: host });

// CDK deploy through CloudFormation. / CDK 배포(CloudFormation 실행 역할).
const cfn = (acct: string, region = SEOUL): Who => viaService(
  assumed(acct, `cdk-hnb659fds-cfn-exec-role-${acct}-${region}`, 'AWSCloudFormation', { invokedBy: 'cloudformation.amazonaws.com' }), 'cloudformation.amazonaws.com');
// GitHub Actions OIDC role running terraform. / GitHub Actions에서 terraform 실행.
const gha = (acct: string, api: string): Who => viaTf(assumed(acct, 'github-actions-deploy', 'GitHubActions'), '192.0.2.47', api);
// AWSops Slack-approved control (ADR-010). / AWSops Slack 승인 제어.
const awsops = (acct: string, slackUser: string, api: string): Who => ({
  identity: assumed(acct, 'AWSopsSlackControlRole', `awsops-slack-control-${hex(slackUser, 8)}`, { sourceIdentity: slackUser }), ua: UA.sdkJs(api), ip: '3.39.107.21',
});
const autoscaling = (acct: string): Who => viaService(
  assumed(acct, 'AWSServiceRoleForAutoScaling', 'AutoScaling', { path: 'aws-service-role/autoscaling.amazonaws.com/', invokedBy: 'autoscaling.amazonaws.com' }), 'autoscaling.amazonaws.com');
const codedeploy = (acct: string): Who => viaService(
  assumed(acct, 'CodeDeployServiceRole', `CodeDeploy-d-${up(hex(acct, 9))}`, { path: 'service-role/', invokedBy: 'codedeploy.amazonaws.com' }), 'codedeploy.amazonaws.com');
const backup = (acct: string): Who => viaService(
  assumed(acct, 'AWSBackupDefaultServiceRole', `AWSBackup-${hex(acct, 12)}`, { path: 'service-role/', invokedBy: 'backup.amazonaws.com' }), 'backup.amazonaws.com');

// ---------- CloudTrail event builder / 이벤트 빌더 ----------

interface Ev {
  t: number;            // minutes from startedAt (negative = before) / 시작 기준 분
  name: string;
  source: string;
  who: Who;
  req: Obj | null;
  resp?: Obj | null;
  err?: [string, string];
  region?: string;
  resources?: Array<{ ARN: string; type: string; accountId?: string }>;
}
const GLOBAL_SOURCES = new Set(['iam.amazonaws.com', 'route53.amazonaws.com']);

// Builds raw CloudTrail events (the parsed CloudTrailEvent JSON of LookupEvents).
// LookupEvents의 CloudTrailEvent JSON을 파싱한 모양 그대로 만든다.
class Trail {
  readonly events: Obj[] = [];
  private n = 0;
  constructor(private sid: string, private acct: string, private region: string, private start: string) {}

  add(e: Ev): string {
    const k = this.n++;
    const seed = `${this.sid}:${k}`;
    // Up to 40 s earlier so times are not on the minute. / 정각을 피하려고 최대 40초 앞당긴다.
    const ms = Date.parse(this.start) + Math.round(e.t * 60_000) - (fnv(seed) % 41) * 1000;
    const eventID = uuid(`${seed}:event`);
    const requestID = uuid(`${seed}:request`);
    const identity = JSON.parse(JSON.stringify(e.who.identity)) as Obj;
    const attrs = (identity.sessionContext as Obj | undefined)?.attributes as Obj | undefined;
    if (attrs) attrs.creationDate = ctTime(ms - (20 + (fnv(seed) % 30)) * 60_000);
    const region = e.region ?? (GLOBAL_SOURCES.has(e.source) ? VIRGINIA : this.region);
    const resp = e.err ? null : e.resp !== undefined ? e.resp : e.source === 'ec2.amazonaws.com' ? { requestId: requestID, _return: true } : null;
    const ev: Obj = {
      eventVersion: '1.10', userIdentity: identity, eventTime: ctTime(ms), eventSource: e.source, eventName: e.name, awsRegion: region,
      sourceIPAddress: e.who.ip, userAgent: e.who.ua,
    };
    if (e.err) { ev.errorCode = e.err[0]; ev.errorMessage = e.err[1]; }
    Object.assign(ev, { requestParameters: e.req, responseElements: resp, requestID, eventID, readOnly: false });
    if (e.resources) ev.resources = e.resources.map(r => ({ accountId: r.accountId ?? this.acct, type: r.type, ARN: r.ARN }));
    Object.assign(ev, { eventType: 'AwsApiCall', managementEvent: true, recipientAccountId: this.acct, eventCategory: 'Management' });
    if (e.who.console) ev.sessionCredentialFromConsole = 'true';
    this.events.push(ev);
    return eventID;
  }

  // Background noise: SSM agent heartbeats and Lambda log streams, spread over [from, to] minutes.
  // 배경 잡음 — SSM 에이전트 하트비트와 람다 로그 스트림을 [from, to] 분에 고르게 뿌린다.
  noise(o: { count: number; from: number; to: number; instances?: Array<[string, string, string]>; lambdas?: Array<[string, string]> }): void {
    const inst = o.instances ?? [], fns = o.lambdas ?? [];
    const total = inst.length + fns.length;
    if (total === 0) throw new Error('noise needs sources');
    for (let i = 0; i < o.count; i++) {
      const t = o.from + ((o.to - o.from) * (i + 0.5)) / o.count;
      const pick = i % total;
      if (pick < inst.length) {
        const [instanceId, roleName, ip] = inst[pick];
        this.add({
          t, name: 'UpdateInstanceInformation', source: 'ssm.amazonaws.com',
          who: { identity: assumed(this.acct, roleName, instanceId), ua: UA.ssm, ip },
          req: { instanceId, agentVersion: '3.3.987.0', agentStatus: 'Active', platformType: 'Linux', platformName: 'Amazon Linux', platformVersion: '2023', iPAddress: ip, computerName: `ip-${ip.replace(/\./g, '-')}.${this.region}.compute.internal`, agentName: 'amazon-ssm-agent', availabilityZone: `${this.region}a`, availabilityZoneId: `${this.region.slice(0, 2)}${this.region.includes('northeast') ? 'ne' : this.region.slice(3, 5)}${this.region.slice(-1)}-az1` },
          resp: null,
        });
      } else {
        const [fn, roleName] = fns[pick - inst.length];
        const day = new Date(Date.parse(this.start) + t * 60_000).toISOString().slice(0, 10).replace(/-/g, '/');
        this.add({
          t, name: 'CreateLogStream', source: 'logs.amazonaws.com',
          who: { identity: assumed(this.acct, roleName, fn), ua: UA.lambdaLogs, ip: '198.51.100.23' },
          req: { logGroupName: `/aws/lambda/${fn}`, logStreamName: `${day}/[$LATEST]${hex(`${this.sid}:${i}:stream`, 32)}` },
          resp: null,
        });
      }
    }
  }
}

// ---------- request shape helpers / 요청 모양 도우미 ----------

const items = <T>(xs: T[]): { items: T[] } => ({ items: xs });
const sgPerm = (port: number, from: { groupId?: string; cidr?: string; desc?: string }, proto = 'tcp'): Obj => ({
  ipProtocol: proto, fromPort: port, toPort: port,
  groups: from.groupId ? items([{ groupId: from.groupId, ...(from.desc ? { description: from.desc } : {}) }]) : {},
  ipRanges: from.cidr ? items([{ cidrIp: from.cidr, ...(from.desc ? { description: from.desc } : {}) }]) : {},
  ipv6Ranges: {}, prefixListIds: {},
});
const instSet = (...ids: string[]) => items(ids.map(instanceId => ({ instanceId })));
const stateChange = (ids: string[], prev: [number, string], cur: [number, string]): Obj => ({
  instancesSet: items(ids.map(instanceId => ({ instanceId, currentState: { code: cur[0], name: cur[1] }, previousState: { code: prev[0], name: prev[1] } }))),
});
const tagSet = (ids: string[], tags: Record<string, string>): Obj => ({
  resourcesSet: items(ids.map(resourceId => ({ resourceId }))), tagSet: items(Object.entries(tags).map(([key, value]) => ({ key, value }))),
});
const elbTags = (arns: string[], tags: Record<string, string>): Obj => ({ resourceArns: arns, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) });
const UNAUTH = (who: string, action: string): [string, string] => ['Client.UnauthorizedOperation', `You are not authorized to perform this operation. User: ${who} is not authorized to perform: ${action} because no identity-based policy allows the ${action} action. Encoded authorization failure message: ${hex(who + action, 48)}`];
const ACCESS_DENIED = (who: string, action: string): [string, string] => ['AccessDenied', `User: ${who} is not authorized to perform: ${action} because no identity-based policy allows the ${action} action`];
// UpdateFunctionConfiguration responseElements (FunctionConfiguration). / 람다 설정 변경 응답.
const lambdaConfig = (g: Topo, key: string, at: string, o: { timeout: number; memorySize: number; role: string; vpc?: { subnets: string[]; sgs: string[]; vpcId: string } }): Obj => ({
  functionName: g.id(key), functionArn: g.arn(key), runtime: String(g.n(key).attrs.runtime), role: o.role, handler: 'index.handler',
  codeSize: 1_843_211, description: '', timeout: o.timeout, memorySize: o.memorySize, lastModified: at.replace('Z', '+0000'), codeSha256: `${hex(key, 43)}=`, version: '$LATEST',
  ...(o.vpc ? { vpcConfig: { subnetIds: o.vpc.subnets, securityGroupIds: o.vpc.sgs, vpcId: o.vpc.vpcId } } : {}),
  tracingConfig: { mode: 'PassThrough' }, revisionId: uuid(`${key}:rev`), state: 'Active', lastUpdateStatus: 'InProgress', packageType: 'Zip', architectures: ['arm64'],
});

// SSM noise sources for instance keys. / 인스턴스 키로 SSM 잡음 출처 만들기.
const ssmOf = (g: Topo, keys: string[], roleName: string): Array<[string, string, string]> => keys.map(k => [g.id(k), roleName, g.ip(k)]);
const LAMBDA = 'lambda.amazonaws.com', EC2 = 'ec2.amazonaws.com', ELB = 'elasticloadbalancing.amazonaws.com', IAM = 'iam.amazonaws.com', RDS = 'rds.amazonaws.com', S3 = 's3.amazonaws.com';
// Real CloudTrail Lambda event names carry an API-version suffix. / 실제 람다 이벤트 이름에는 API 버전 접미사가 붙는다.
const L_CONFIG = 'UpdateFunctionConfiguration20150331v2', L_CODE = 'UpdateFunctionCode20150331v2', L_TAG = 'TagResource20170331v2';

// ---------- scenarios: SG inbound revoke / 보안그룹 인바운드 삭제 ----------

// The app SG loses its inbound rule from the ALB SG; ALB returns 502/504.
// 앱 SG에서 ALB SG 인바운드 규칙이 지워져 ALB가 502/504를 낸다.
function sgRevokeShop(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-03T02:14:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'shop', octet: 10, count: 3, port: 8080, role: 'shop-web-ec2-role' });
  g.s3('assets', `shop-prod-assets-${acct}`);
  g.access('role', 'assets');
  g.sg('sg-bastion', 'vpc', 'shop-bastion-sg');
  g.instance('bastion', 'pub-a', ['sg-bastion'], { name: 'shop-bastion', type: 't4g.micro' });
  const before = g.snapshot(rel(start, -31));
  g.unedge('sg-app', 'sg-lb', 'allows_from');
  const after = g.snapshot(rel(start, -4));

  const tr = new Trail('sg-revoke-shop', acct, region, start);
  const minji = sso(acct, 'minji.lee@example.com');
  const answer = tr.add({
    t: -12, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(minji, '203.0.113.24'),
    req: { groupId: g.id('sg-app'), ipPermissions: items([sgPerm(8080, { groupId: g.id('sg-lb'), desc: 'from shop-alb' })]) },
    resp: { requestId: uuid('sgr-shop-resp'), _return: true, revokedSecurityGroupRuleSet: items([{ groupId: g.id('sg-app'), securityGroupRuleId: `sgr-${hex('shop-rule', 17)}`, isEgress: false, ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, referencedGroupId: g.id('sg-lb') }]) },
  });
  tr.add({
    t: -3, name: 'AuthorizeSecurityGroupIngress', source: EC2, who: viaCli(iamUser(acct, 'jaehyun.park'), '198.51.100.77', 'ec2.authorize-security-group-ingress'),
    req: { groupId: g.id('sg-bastion'), ipPermissions: items([sgPerm(22, { cidr: '198.51.100.77/32', desc: 'jaehyun home' })]) },
    resp: { requestId: uuid('bastion-auth'), _return: true, securityGroupRuleSet: items([{ groupId: g.id('sg-bastion'), securityGroupRuleId: `sgr-${hex('bastion-rule', 17)}`, isEgress: false, ipProtocol: 'tcp', fromPort: 22, toPort: 22, cidrIpv4: '198.51.100.77/32' }]) },
  });
  tr.add({ t: -6, name: 'AddTags', source: ELB, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('lb')], { CostCenter: 'commerce-web', ManagedBy: 'terraform' }) });
  tr.add({
    t: -9, name: 'ModifyLoadBalancerAttributes', source: ELB, who: viaConsole(iamUser(acct, 'dohyun.kim'), '192.0.2.140'),
    req: { loadBalancerArn: g.arn('lb'), attributes: [{ key: 'idle_timeout.timeout_seconds', value: '180' }] },
    err: ACCESS_DENIED(`arn:aws:iam::${acct}:user/dohyun.kim`, 'elasticloadbalancing:ModifyLoadBalancerAttributes'),
  });
  tr.noise({ count: 9, from: -50, to: 3, instances: ssmOf(g, ['web1', 'web2', 'web3'], 'shop-web-ec2-role') });
  return { id: 'sg-revoke-shop-alb-to-app', title: 'shop-alb 5xx — app SG lost its 8080 rule from the ALB SG', category: 'sg-revoke', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// The DB SG loses 5432 from the app SG (terraform plan drift); deep health check fails.
// DB SG에서 앱 SG의 5432가 지워져(terraform 드리프트) 깊은 헬스 체크가 실패한다.
function sgRevokeApiDb(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-05T11:40:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'api', octet: 20, count: 2, port: 8000, role: 'api-ec2-role' });
  g.sg('sg-db', 'vpc', 'api-prod-pg-sg');
  g.allow('sg-db', 'sg-app');
  g.rds('db', 'api-prod-pg', ['app-a', 'app-b'], ['sg-db'], 'postgres', 'db.r6g.xlarge');
  g.sg('sg-bi', 'vpc', 'bi-tools-sg');
  g.sg('sg-analytics', 'vpc', 'analytics-replica-sg');
  g.allow('sg-analytics', 'sg-bi');
  g.rds('replica', 'analytics-replica', ['app-a', 'app-b'], ['sg-analytics'], 'postgres', 'db.r6g.large');
  g.role('mailer-role', 'api-report-mailer-role');
  g.lambda('mailer', 'api-report-mailer', 'mailer-role', { runtime: 'python3.12' });
  const before = g.snapshot(rel(start, -40));
  g.unedge('sg-db', 'sg-app', 'allows_from');
  const after = g.snapshot(rel(start, -10));

  const tr = new Trail('sg-revoke-api-db', acct, region, start);
  const answer = tr.add({
    t: -25, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'ec2#1.187.0'),
    req: { groupId: g.id('sg-db'), ipPermissions: items([sgPerm(5432, { groupId: g.id('sg-app') })]) },
  });
  const yuna = sso(acct, 'yuna.kang@example.com', 'PowerUserAccess');
  const at4 = ctTime(Date.parse(rel(start, -4)));
  tr.add({
    t: -4, name: L_CONFIG, source: LAMBDA, who: viaConsole(yuna, '203.0.113.191'),
    req: { functionName: g.id('mailer'), timeout: 120 },
    resp: lambdaConfig(g, 'mailer', at4, { timeout: 120, memorySize: 256, role: g.arn('mailer-role') }),
  });
  tr.add({
    t: -10, name: 'ModifyDBInstance', source: RDS, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'rds.modify-db-instance'),
    req: { dBInstanceIdentifier: 'analytics-replica', masterUserPassword: 'HIDDEN_DUE_TO_SECURITY_REASONS', applyImmediately: true },
    resp: { dBInstanceIdentifier: 'analytics-replica', dBInstanceClass: 'db.r6g.large', engine: 'postgres', dBInstanceStatus: 'available', pendingModifiedValues: { masterUserPassword: '****' }, dBInstanceArn: g.arn('replica') },
  });
  tr.add({ t: -15, name: 'AddTags', source: ELB, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('tg')], { Service: 'api', Tier: 'backend' }) });
  tr.noise({ count: 7, from: -55, to: 2, instances: ssmOf(g, ['web1', 'web2'], 'api-ec2-role') });
  return { id: 'sg-revoke-api-db-5432', title: 'api-tg unhealthy — DB SG lost 5432 from the app SG', category: 'sg-revoke', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// NLB targets lose their CIDR inbound on 9092; producers time out and targets go unhealthy.
// NLB 대상의 9092 CIDR 인바운드가 지워져 대상이 비정상이 된다.
function sgRevokeIngestCidr(): Scenario {
  const acct = ACC.ingest, region = OREGON, start = '2026-10-07T19:05:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'ingest', octet: 40, count: 3, port: 9092, kind: 'net', type: 'r7g.xlarge', role: 'ingest-broker-role' });
  g.sg('sg-mon', 'vpc', 'monitoring-sg');
  g.instance('prom', 'app-a', ['sg-mon'], { name: 'prometheus-01', type: 'm7g.xlarge', volume: 200 });
  g.s3('archive', `ingest-archive-${acct}`);
  const snapOld = g.snapshot(rel(start, -29));
  const snap = g.snapshot(rel(start, -14));

  const tr = new Trail('sg-revoke-ingest', acct, region, start);
  const answer = tr.add({
    t: -7, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaCli(iamUser(acct, 'sangwoo.han'), '203.0.113.88', 'ec2.revoke-security-group-ingress'),
    req: { groupId: g.id('sg-app'), ipPermissions: items([sgPerm(9092, { cidr: '10.40.0.0/16' })]) },
  });
  tr.add({
    t: -5, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'),
    req: { groupId: g.id('sg-mon'), ipPermissions: items([sgPerm(9100, { cidr: '0.0.0.0/0', desc: 'temp node exporter' })]) },
  });
  tr.add({
    t: -3, name: 'PutBucketLifecycle', source: S3, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 's3#1.65.0'),
    req: { bucketName: `ingest-archive-${acct}`, Host: `ingest-archive-${acct}.s3.${region}.amazonaws.com`, lifecycle: '', LifecycleConfiguration: { Rule: { ID: 'expire-90d', Status: 'Enabled', Filter: { Prefix: 'raw/' }, Expiration: { Days: 90 } } } },
  });
  tr.add({
    t: -2, name: 'StopInstances', source: EC2, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { instancesSet: instSet(g.id('web2')), force: false }, err: UNAUTH(`arn:aws:iam::${acct}:user/intern-readonly`, 'ec2:StopInstances'),
  });
  tr.noise({ count: 8, from: -45, to: 4, instances: ssmOf(g, ['web1', 'web2', 'web3'], 'ingest-broker-role') });
  return { id: 'sg-revoke-ingest-nlb-cidr', title: 'ingest-tg unhealthy — broker SG lost 9092 from the VPC CIDR', category: 'sg-revoke', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [snapOld, snap], events: tr.events, answer };
}

// ---------- scenarios: TG deregister / 대상 그룹에서 서버 빼기 ----------

// Both API targets are deregistered by hand; ALB answers 503.
// API 대상 두 대를 손으로 빼서 ALB가 503을 낸다.
function tgDeregisterPay(): Scenario {
  const acct = ACC.payments, region = SEOUL, start = '2026-10-08T06:30:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'pay', octet: 50, count: 2, port: 8443, protocol: 'HTTPS', tgName: 'pay-api-tg' });
  g.instance('admin1', 'app-a', ['sg-app'], { name: 'pay-admin-01' });
  g.tg('tg-admin', 'pay-admin-tg', 'vpc', ['lb'], [], { port: 8443, protocol: 'HTTPS' });
  const before = g.snapshot(rel(start, -26));
  g.unedge('tg', 'web1', 'targets');
  g.unedge('tg', 'web2', 'targets');
  g.edge('tg-admin', 'admin1', 'targets');
  const after = g.snapshot(rel(start, -1));

  const tr = new Trail('tg-deregister-pay', acct, region, start);
  const seojun = sso(acct, 'seojun.choi@example.com');
  const answer = tr.add({
    t: -18, name: 'DeregisterTargets', source: ELB, who: viaCli(seojun, '203.0.113.61', 'elbv2.deregister-targets'),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: g.id('web1'), port: 8443 }, { id: g.id('web2'), port: 8443 }] },
  });
  tr.add({
    t: -3, name: 'RegisterTargets', source: ELB, who: viaCli(seojun, '203.0.113.61', 'elbv2.register-targets'),
    req: { targetGroupArn: g.arn('tg-admin'), targets: [{ id: g.id('admin1'), port: 8443 }] },
  });
  tr.add({ t: -8, name: 'AddTags', source: ELB, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'), req: elbTags([g.arn('lb')], { 'pci-scope': 'true' }) });
  tr.add({
    t: -20, name: 'ModifyTargetGroupAttributes', source: ELB, who: viaCli(seojun, '203.0.113.61', 'elbv2.modify-target-group-attributes'),
    req: { targetGroupArn: g.arn('tg'), attributes: [{ key: 'deregistration_delay.timeout_seconds', value: '4000' }] },
    err: ['ValidationError', "'4000' must be an integer between 0 and 3600"],
  });
  tr.noise({ count: 8, from: -58, to: 3, instances: ssmOf(g, ['web1', 'web2', 'admin1'], 'pay-ec2-ssm-role') });
  return { id: 'tg-deregister-pay-api', title: 'pay-alb 503 — every pay-api-tg target was deregistered', category: 'tg-deregister', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// A CDK deploy drops two of three search nodes from the TG; the last one is overloaded.
// CDK 배포가 검색 노드 3대 중 2대를 대상 그룹에서 빼서 남은 1대가 과부하로 비정상이 된다.
function tgDeregisterSearchCfn(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-10T14:50:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'search', octet: 21, count: 3, port: 9200, type: 'r7g.2xlarge', role: 'search-node-role' });
  g.sg('sg-batch', 'vpc', 'search-batch-sg');
  g.instance('batch', 'app-a', ['sg-batch'], { name: 'search-batch-01', type: 'c7g.xlarge' });
  const before = g.snapshot(rel(start, -45));
  g.unedge('tg', 'web2', 'targets');
  g.unedge('tg', 'web3', 'targets');
  g.attr('batch', 'state', 'stopped');
  const after = g.snapshot(rel(start, -18));

  const tr = new Trail('tg-deregister-search', acct, region, start);
  const answer = tr.add({
    t: -33, name: 'DeregisterTargets', source: ELB, who: cfn(acct),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: g.id('web2') }, { id: g.id('web3') }] },
  });
  tr.add({
    t: -31, name: 'DeregisterTargets', source: ELB, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'elbv2.deregister-targets'),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: g.id('web1') }] },
    err: ACCESS_DENIED(`arn:aws:iam::${acct}:user/dohyun.kim`, 'elasticloadbalancing:DeregisterTargets'),
  });
  tr.add({
    t: -10, name: 'StopInstances', source: EC2, who: viaBoto(iamUser(acct, 'batch-scheduler'), '10.21.10.200'),
    req: { instancesSet: instSet(g.id('batch')), force: false }, resp: stateChange([g.id('batch')], [16, 'running'], [64, 'stopping']),
  });
  tr.add({ t: -15, name: 'CreateTags', source: EC2, who: autoscaling(acct), req: tagSet([g.id('web1')], { 'aws:autoscaling:groupName': 'search-nodes-asg' }) });
  tr.add({ t: -2, name: 'PutRetentionPolicy', source: 'logs.amazonaws.com', who: viaConsole(sso(acct, 'yuna.kang@example.com', 'PowerUserAccess'), '203.0.113.191'), req: { logGroupName: '/search/slowlog', retentionInDays: 30 } });
  tr.noise({ count: 9, from: -57, to: 4, instances: ssmOf(g, ['web1', 'web2', 'web3'], 'search-node-role') });
  return { id: 'tg-deregister-search-cfn', title: 'search-tg unhealthy — a CDK deploy deregistered 2 of 3 nodes', category: 'tg-deregister', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// ---------- scenarios: instance stop / 서버 정지 ----------

// The only admin box is stopped through the Slack-approved AWSops control.
// 하나뿐인 관리 서버를 AWSops Slack 승인 제어로 꺼 버렸다.
function stopAdminSlack(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-12T00:20:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'admin', octet: 11, count: 1, port: 3000, role: 'admin-ec2-role' });
  g.sg('sg-dev', 'vpc', 'dev-sandbox-sg');
  g.instance('dev', 'app-b', ['sg-dev'], { name: 'dev-sandbox-01', type: 't4g.large', state: 'stopped' });
  const before = g.snapshot(rel(start, -20));
  g.attr('web1', 'state', 'stopped');
  g.attr('dev', 'state', 'running');
  const after = g.snapshot(rel(start, -3));

  const tr = new Trail('stop-admin-slack', acct, region, start);
  const answer = tr.add({
    t: -9, name: 'StopInstances', source: EC2, who: awsops(acct, 'slack:U04QK7LMN2P', 'ec2'),
    req: { instancesSet: instSet(g.id('web1')), force: false }, resp: stateChange([g.id('web1')], [16, 'running'], [64, 'stopping']),
  });
  const yuna = sso(acct, 'yuna.kang@example.com', 'PowerUserAccess');
  tr.add({
    t: -4, name: 'StartInstances', source: EC2, who: viaConsole(yuna, '203.0.113.191'),
    req: { instancesSet: instSet(g.id('dev')) }, resp: stateChange([g.id('dev')], [80, 'stopped'], [0, 'pending']),
  });
  tr.add({ t: -15, name: 'CreateTags', source: EC2, who: viaConsole(yuna, '203.0.113.191'), req: tagSet([g.id('web1')], { Owner: 'commerce-backoffice', 'awsops:control': 'allow' }) });
  tr.add({
    t: -6, name: 'ModifyInstanceAttribute', source: EC2, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'ec2.modify-instance-attribute'),
    req: { instanceId: g.id('web1'), instanceType: { value: 'm7g.xlarge' } },
    err: ['Client.IncorrectInstanceState', `The instance '${g.id('web1')}' is not in the 'stopped' state.`],
  });
  tr.noise({ count: 7, from: -52, to: 2, instances: ssmOf(g, ['web1', 'dev'], 'admin-ec2-role') });
  return { id: 'instance-stop-admin-slack', title: 'admin-tg unhealthy — the only admin instance was stopped via Slack control', category: 'instance-stop', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// One of two CMS web servers is stopped in the console; a staging box with the same name pattern is stopped later.
// CMS 웹 서버 2대 중 1대가 콘솔에서 꺼졌다. 비슷한 이름의 스테이징 서버도 나중에 꺼졌다.
function stopCmsConsole(): Scenario {
  const acct = ACC.global, region = TOKYO, start = '2026-10-14T09:10:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'cms', octet: 60, count: 2, port: 80, role: 'cms-web-role' });
  g.vpc('stg-vpc', 'cms-staging-vpc', '10.160.0.0/16');
  g.subnet('stg-a', 'stg-vpc', 'cms-staging-private-a', '10.160.10.0/24', `${region}a`);
  g.sg('sg-stg', 'stg-vpc', 'cms-staging-web-sg');
  g.instance('stg1', 'stg-a', ['sg-stg'], { name: 'cms-staging-01', type: 't4g.medium' });
  const before = g.snapshot(rel(start, -40));
  g.attr('web2', 'state', 'stopped');
  const after = g.snapshot(rel(start, -10));

  const tr = new Trail('stop-cms-console', acct, region, start);
  const kenta = iamUser(acct, 'kenta.sato');
  const answer = tr.add({
    t: -27, name: 'StopInstances', source: EC2, who: viaConsole(kenta, '203.0.113.212'),
    req: { instancesSet: instSet(g.id('web2')), force: false }, resp: stateChange([g.id('web2')], [16, 'running'], [64, 'stopping']),
  });
  tr.add({
    t: -5, name: 'StopInstances', source: EC2, who: viaConsole(sso(acct, 'yuki.tanaka@example.com'), '203.0.113.213'),
    req: { instancesSet: instSet(g.id('stg1')), force: false }, resp: stateChange([g.id('stg1')], [16, 'running'], [64, 'stopping']),
  });
  tr.add({ t: -12, name: 'AddTags', source: ELB, who: viaConsole(kenta, '203.0.113.212'), req: elbTags([g.arn('tg')], { Team: 'cms' }) });
  tr.add({
    t: -1, name: 'RebootInstances', source: EC2, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { instancesSet: instSet(g.id('web1')) }, err: UNAUTH(`arn:aws:iam::${acct}:user/intern-readonly`, 'ec2:RebootInstances'),
  });
  tr.noise({ count: 6, from: -55, to: 3, instances: ssmOf(g, ['web1', 'web2'], 'cms-web-role') });
  return { id: 'instance-stop-cms-console', title: 'cms-tg below 2 healthy — cms-web-02 was stopped in the console', category: 'instance-stop', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// The PgBouncer box the app talks to is stopped as "an old server"; the app fails its DB health check.
// 앱이 붙는 PgBouncer 서버를 "오래된 서버"로 알고 꺼서 앱 DB 헬스 체크가 실패한다.
function stopPgbouncer(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-29T06:40:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'wallet', octet: 22, count: 2, port: 8080, role: 'wallet-ec2-role' });
  g.sg('sg-pgb', 'vpc', 'wallet-pgbouncer-sg');
  g.allow('sg-pgb', 'sg-app');
  g.instance('pgb', 'app-a', ['sg-pgb'], { name: 'pgbouncer-01', type: 'c7g.large', role: 'role' });
  g.sg('sg-db', 'vpc', 'wallet-pg-sg');
  g.allow('sg-db', 'sg-pgb');
  g.rds('db', 'wallet-pg', ['app-a', 'app-b'], ['sg-db'], 'postgres', 'db.r6g.large');
  const before = g.snapshot(rel(start, -44));
  g.attr('pgb', 'state', 'stopped');
  const after = g.snapshot(rel(start, -14));

  const tr = new Trail('stop-pgbouncer', acct, region, start);
  const yuna = sso(acct, 'yuna.kang@example.com', 'PowerUserAccess');
  tr.add({ t: -33, name: 'CreateTags', source: EC2, who: viaConsole(yuna, '203.0.113.191'), req: tagSet([g.id('pgb')], { decommission: 'candidate' }) });
  const answer = tr.add({
    t: -31, name: 'StopInstances', source: EC2, who: viaConsole(yuna, '203.0.113.191'),
    req: { instancesSet: instSet(g.id('pgb')), force: false }, resp: stateChange([g.id('pgb')], [16, 'running'], [64, 'stopping']),
  });
  tr.add({ t: -6, name: 'CreateTags', source: EC2, who: viaConsole(sso(acct, 'seojun.choi@example.com'), '203.0.113.61'), req: tagSet([g.id('web1')], { Name: 'wallet-web-01a' }) });
  tr.add({
    t: -10, name: 'ModifyDBInstance', source: RDS, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'rds#1.88.0'),
    req: { dBInstanceIdentifier: 'wallet-pg', backupRetentionPeriod: 14, applyImmediately: false },
    resp: { dBInstanceIdentifier: 'wallet-pg', dBInstanceClass: 'db.r6g.large', engine: 'postgres', dBInstanceStatus: 'available', backupRetentionPeriod: 7, pendingModifiedValues: { backupRetentionPeriod: 14 }, dBInstanceArn: g.arn('db') },
  });
  tr.add({
    t: -20, name: 'RebootInstances', source: EC2, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { instancesSet: instSet(g.id('web2')) }, err: UNAUTH(`arn:aws:iam::${acct}:user/intern-readonly`, 'ec2:RebootInstances'),
  });
  tr.noise({ count: 8, from: -58, to: 2, instances: ssmOf(g, ['web1', 'web2'], 'wallet-ec2-role') });
  return { id: 'instance-stop-pgbouncer', title: 'wallet-tg unhealthy — pgbouncer-01 (between app and DB) was stopped', category: 'instance-stop', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// ---------- scenarios: listener / rule change / 리스너·규칙 변경 ----------

// The HTTPS default action is pointed at the empty canary TG.
// HTTPS 기본 동작이 비어 있는 카나리 대상 그룹으로 바뀌었다.
function listenerMallCanary(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-15T23:45:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'mall', octet: 12, count: 2, port: 8080 });
  g.tg('canary', 'mall-canary-tg', 'vpc', ['lb'], [], { port: 8080 });
  g.sg('sg-int', 'vpc', 'mall-internal-alb-sg');
  g.lb('int', 'mall-internal-alb', 'app', ['app-a', 'app-b'], ['sg-int'], 'internal');
  g.sg('sg-worker', 'vpc', 'mall-worker-sg');
  g.allow('sg-worker', 'sg-int');
  g.instance('worker', 'app-b', ['sg-worker'], { name: 'mall-worker-01' });
  g.tg('int-tg', 'mall-internal-tg', 'vpc', ['int'], ['worker'], { port: 9000 });
  const snap = g.snapshot(rel(start, -22));
  const snap2 = g.snapshot(rel(start, -7));

  const tr = new Trail('listener-mall', acct, region, start);
  const answer = tr.add({
    t: -14, name: 'ModifyListener', source: ELB, who: viaTf(iamUser(acct, 'terraform-deployer'), '192.0.2.18', 'elasticloadbalancingv2#1.40.1'),
    req: { listenerArn: g.listener('lb', 443), defaultActions: [{ type: 'forward', targetGroupArn: g.arn('canary'), forwardConfig: { targetGroups: [{ targetGroupArn: g.arn('canary'), weight: 1 }], targetGroupStickinessConfig: { enabled: false } } }] },
    resp: { listeners: [{ listenerArn: g.listener('lb', 443), loadBalancerArn: g.arn('lb'), port: 443, protocol: 'HTTPS', sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', defaultActions: [{ type: 'forward', targetGroupArn: g.arn('canary') }] }] },
  });
  tr.add({
    t: -5, name: 'ModifyRule', source: ELB, who: viaConsole(sso(acct, 'minji.lee@example.com'), '203.0.113.24'),
    req: { ruleArn: g.rule('int', 80, 1), conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/jobs/*'] } }], actions: [{ type: 'forward', targetGroupArn: g.arn('int-tg') }] },
  });
  tr.add({ t: -2, name: 'AddTags', source: ELB, who: viaTf(iamUser(acct, 'terraform-deployer'), '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('lb')], { Release: '2026.10.15-2' }) });
  tr.add({
    t: -16, name: 'ModifyListener', source: ELB, who: viaConsole(sso(acct, 'minji.lee@example.com'), '203.0.113.24'),
    req: { listenerArn: g.listener('lb', 443), certificates: [{ certificateArn: `arn:aws:acm:${region}:${acct}:certificate/${uuid('mall-cert')}` }] },
    err: ['CertificateNotFound', `Certificate 'arn:aws:acm:${region}:${acct}:certificate/${uuid('mall-cert')}' not found`],
  });
  tr.noise({ count: 6, from: -50, to: 4, instances: ssmOf(g, ['web1', 'web2', 'worker'], 'mall-ssm-role') });
  return { id: 'listener-mall-forward-canary', title: 'mall-alb 503 — HTTPS default action now forwards to the empty canary TG', category: 'listener-rule', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [snap, snap2], events: tr.events, answer };
}

// The /v2/* rule shifts 100% to the green TG whose box has no app deployed yet.
// /v2/* 규칙이 앱이 아직 없는 green 대상 그룹으로 100% 넘어갔다.
function ruleGatewayGreen(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-17T05:02:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'gw', octet: 23, count: 2, port: 8080, tgName: 'gw-blue-tg', role: 'gw-ec2-role' });
  g.instance('green1', 'app-a', ['sg-app'], { name: 'gw-green-01', role: 'role' });
  g.tg('green', 'gw-green-tg', 'vpc', ['lb'], ['green1'], { port: 8080 });
  g.role('ship-role', 'gw-log-shipper-role');
  g.lambda('shipper', 'gw-log-shipper', 'ship-role', { runtime: 'nodejs20.x' });
  const snap = g.snapshot(rel(start, -16));

  const tr = new Trail('rule-gw-green', acct, region, start);
  const seojun = sso(acct, 'seojun.choi@example.com');
  const answer = tr.add({
    t: -6, name: 'ModifyRule', source: ELB, who: viaConsole(seojun, '203.0.113.61'),
    req: { ruleArn: g.rule('lb', 443, 1), actions: [{ type: 'forward', forwardConfig: { targetGroups: [{ targetGroupArn: g.arn('tg'), weight: 0 }, { targetGroupArn: g.arn('green'), weight: 100 }] } }] },
    resp: { rules: [{ ruleArn: g.rule('lb', 443, 1), priority: '10', conditions: [{ field: 'path-pattern', values: ['/v2/*'] }], isDefault: false }] },
  });
  tr.add({ t: -3, name: 'AddTags', source: ELB, who: viaConsole(seojun, '203.0.113.61'), req: elbTags([g.arn('tg')], { Slot: 'blue', Retire: '2026-10-24' }) });
  const at1 = ctTime(Date.parse(rel(start, -1)));
  tr.add({
    t: -1, name: L_CONFIG, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('shipper'), memorySize: 512 }, resp: lambdaConfig(g, 'shipper', at1, { timeout: 60, memorySize: 512, role: g.arn('ship-role') }),
  });
  tr.add({
    t: -8, name: 'DeleteRule', source: ELB, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { ruleArn: g.rule('lb', 443, 2) }, err: ACCESS_DENIED(`arn:aws:iam::${acct}:user/intern-readonly`, 'elasticloadbalancing:DeleteRule'),
  });
  tr.noise({ count: 7, from: -45, to: 4, instances: ssmOf(g, ['web1', 'web2', 'green1'], 'gw-ec2-role') });
  return { id: 'rule-gw-weighted-green', title: 'gw-alb 5xx — /v2/* rule shifted 100% to the empty green TG', category: 'listener-rule', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// Maintenance fixed-response 503 is left on the HTTPS listener; traffic picks up later.
// 점검용 고정 응답 503이 HTTPS 리스너에 남아 있었고, 나중에 트래픽이 늘며 알람이 울렸다.
function listenerMemberMaintenance(): Scenario {
  const acct = ACC.payments, region = SEOUL, start = '2026-10-18T01:30:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'member', octet: 51, count: 2, port: 8080, role: 'member-ec2-role' });
  const old = g.snapshot(rel(start, -55));
  const snap = g.snapshot(rel(start, -25));

  const tr = new Trail('listener-member', acct, region, start);
  const dohyun = iamUser(acct, 'dohyun.kim');
  const answer = tr.add({
    t: -38, name: 'ModifyListener', source: ELB, who: viaCli(dohyun, '192.0.2.140', 'elbv2.modify-listener'),
    req: { listenerArn: g.listener('lb', 443), defaultActions: [{ type: 'fixed-response', fixedResponseConfig: { statusCode: '503', contentType: 'text/html', messageBody: '<h1>점검 중입니다</h1>' } }] },
  });
  tr.add({
    t: -12, name: 'ModifyListener', source: ELB, who: viaCli(dohyun, '192.0.2.140', 'elbv2.modify-listener'),
    req: { listenerArn: g.listener('lb', 80), defaultActions: [{ type: 'redirect', redirectConfig: { protocol: 'HTTPS', port: '443', host: '#{host}', path: '/#{path}', query: '#{query}', statusCode: 'HTTP_302' } }] },
  });
  tr.add({ t: -4, name: 'AddTags', source: ELB, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'), req: elbTags([g.arn('lb')], { Oncall: 'member-squad' }) });
  tr.add({
    t: -20, name: 'SetSecurityGroups', source: ELB, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'),
    req: { loadBalancerArn: g.arn('lb'), securityGroups: [g.id('sg-lb'), g.id('sg-app')] },
    err: ['InvalidConfigurationRequest', 'A load balancer cannot be attached to multiple security groups with conflicting rules'],
  });
  tr.noise({ count: 8, from: -59, to: 3, instances: ssmOf(g, ['web1', 'web2'], 'member-ec2-role') });
  return { id: 'listener-member-maintenance-left-on', title: 'member-alb 5xx — maintenance fixed-response 503 left on the HTTPS listener', category: 'listener-rule', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [old, snap], events: tr.events, answer };
}

// ---------- scenarios: Lambda config / 람다 설정 변경 ----------

// ALB → lambda TG → notify-sender; its timeout drops from 30 s to 3 s and the ALB returns 502.
// ALB 뒤 람다의 제한 시간이 30초에서 3초로 줄어 ALB가 502를 낸다.
function lambdaNotifyTimeout(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-19T08:15:00.000Z';
  const g = new Topo(acct, region);
  g.vpc('vpc', 'notify-prod-vpc', '10.24.0.0/16');
  g.subnet('pub-a', 'vpc', 'notify-public-a', '10.24.0.0/24', `${region}a`);
  g.subnet('pub-c', 'vpc', 'notify-public-c', '10.24.1.0/24', `${region}c`);
  g.sg('sg-lb', 'vpc', 'notify-alb-sg');
  g.lb('lb', 'notify-alb', 'app', ['pub-a', 'pub-c'], ['sg-lb']);
  g.role('sender-role', 'notify-sender-role');
  g.lambda('sender', 'notify-sender', 'sender-role', { runtime: 'nodejs20.x' });
  g.s3('tpl', `notify-templates-${acct}`);
  g.access('sender-role', 'tpl');
  g.tg('tg', 'notify-sender-tg', 'vpc', ['lb'], ['sender'], { port: 0, targetType: 'lambda' });
  g.role('digest-role', 'notify-digest-role');
  g.lambda('digest', 'notify-digest', 'digest-role', { runtime: 'nodejs20.x' });
  const snap = g.snapshot(rel(start, -19));

  const tr = new Trail('lambda-notify', acct, region, start);
  const hana = sso(acct, 'hana.jung@example.com');
  const at11 = ctTime(Date.parse(rel(start, -11)));
  const answer = tr.add({
    t: -11, name: L_CONFIG, source: LAMBDA, who: viaConsole(hana, '203.0.113.5'),
    req: { functionName: 'notify-sender', timeout: 3 }, resp: lambdaConfig(g, 'sender', at11, { timeout: 3, memorySize: 1024, role: g.arn('sender-role') }),
  });
  const at4 = ctTime(Date.parse(rel(start, -4)));
  tr.add({
    t: -4, name: L_CONFIG, source: LAMBDA, who: viaConsole(hana, '203.0.113.5'),
    req: { functionName: 'notify-digest', memorySize: 512 }, resp: lambdaConfig(g, 'digest', at4, { timeout: 300, memorySize: 512, role: g.arn('digest-role') }),
  });
  tr.add({ t: -2, name: L_TAG, source: LAMBDA, who: viaConsole(hana, '203.0.113.5'), req: { resource: g.arn('sender'), tags: { owner: 'notify-squad', reviewed: '2026-10' } } });
  tr.add({
    t: -10, name: L_CODE, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('sender'), publish: false, dryRun: false, s3Bucket: `notify-artifacts-${acct}`, s3Key: 'notify-sender/7f3c2a1.zip' },
    err: ['ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${g.arn('sender')}`],
  });
  tr.noise({ count: 10, from: -55, to: 4, lambdas: [['notify-sender', 'notify-sender-role'], ['notify-digest', 'notify-digest-role']] });
  return { id: 'lambda-notify-sender-timeout', title: 'notify-alb 502 — notify-sender timeout cut from 30 s to 3 s', category: 'lambda-config', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// order-consumer's VPC SG is swapped to a new SG the DB does not allow.
// order-consumer의 VPC 보안그룹이 DB가 허용하지 않는 새 SG로 바뀌었다.
function lambdaOrderVpcSg(): Scenario {
  const acct = ACC.payments, region = SEOUL, start = '2026-10-20T13:25:00.000Z';
  const g = new Topo(acct, region);
  g.vpc('vpc', 'orders-prod-vpc', '10.52.0.0/16');
  g.subnet('app-a', 'vpc', 'orders-private-a', '10.52.10.0/24', `${region}a`);
  g.subnet('app-c', 'vpc', 'orders-private-c', '10.52.11.0/24', `${region}c`);
  g.sg('sg-fn', 'vpc', 'order-consumer-sg');
  g.sg('sg-fn2', 'vpc', 'order-consumer-v2-sg');
  g.sg('sg-db', 'vpc', 'orders-pg-sg');
  g.allow('sg-db', 'sg-fn');
  g.rds('db', 'orders-pg', ['app-a', 'app-c'], ['sg-db'], 'postgres', 'db.r6g.xlarge');
  g.sg('sg-legacy', 'vpc', 'legacy-batch-db-sg');
  g.rds('legacy', 'legacy-batch-db', ['app-a', 'app-c'], ['sg-legacy'], 'mysql', 'db.t4g.medium');
  g.role('fn-role', 'order-consumer-role');
  g.lambda('fn', 'order-consumer', 'fn-role', { runtime: 'java21', subnets: ['app-a', 'app-c'], sgs: ['sg-fn'] });
  const before = g.snapshot(rel(start, -35));
  g.unedge('fn', 'sg-fn', 'uses_sg');
  g.unedge('fn.eni', 'sg-fn', 'uses_sg');
  g.edge('fn', 'sg-fn2', 'uses_sg');
  g.edge('fn.eni', 'sg-fn2', 'uses_sg');
  const after = g.snapshot(rel(start, -8));

  const tr = new Trail('lambda-order-vpc', acct, region, start);
  const vpc = { subnets: [g.id('app-a'), g.id('app-c')], vpcId: g.id('vpc') };
  tr.add({
    t: -24, name: L_CONFIG, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('fn'), vpcConfig: { subnetIds: vpc.subnets, securityGroupIds: [g.id('sg-fn2')] } },
    err: ['ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${g.arn('fn')}`],
  });
  const at22 = ctTime(Date.parse(rel(start, -22)));
  const answer = tr.add({
    t: -22, name: L_CONFIG, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('fn'), vpcConfig: { subnetIds: vpc.subnets, securityGroupIds: [g.id('sg-fn2')] } },
    resp: lambdaConfig(g, 'fn', at22, { timeout: 60, memorySize: 2048, role: g.arn('fn-role'), vpc: { ...vpc, sgs: [g.id('sg-fn2')] } }),
  });
  tr.add({ t: -5, name: L_TAG, source: LAMBDA, who: viaConsole(sso(acct, 'seojun.choi@example.com'), '203.0.113.61'), req: { resource: g.arn('fn'), tags: { 'cost-center': 'orders' } } });
  tr.add({
    t: -9, name: 'ModifyDBInstance', source: RDS, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'rds.modify-db-instance'),
    req: { dBInstanceIdentifier: 'legacy-batch-db', backupRetentionPeriod: 14, applyImmediately: true },
    resp: { dBInstanceIdentifier: 'legacy-batch-db', dBInstanceClass: 'db.t4g.medium', engine: 'mysql', dBInstanceStatus: 'modifying', backupRetentionPeriod: 14, dBInstanceArn: g.arn('legacy') },
  });
  tr.add({
    t: -1, name: 'PutBucketVersioning', source: S3, who: gha(acct, 's3#1.65.0'),
    req: { bucketName: `orders-exports-${acct}`, Host: `orders-exports-${acct}.s3.${region}.amazonaws.com`, versioning: '', VersioningConfiguration: { Status: 'Enabled', xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' } },
  });
  tr.noise({ count: 9, from: -56, to: 4, lambdas: [['order-consumer', 'order-consumer-role']] });
  return { id: 'lambda-order-consumer-vpc-sg', title: 'order-consumer Errors alarm — VPC SG swapped to one the DB does not allow', category: 'lambda-config', accountId: acct, region, targetArn: g.arn('fn'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// A cost script cuts thumbnail-maker memory from 1024 MB to 128 MB; it runs out of memory.
// 비용 절감 스크립트가 thumbnail-maker 메모리를 1024MB에서 128MB로 줄여 메모리 부족으로 실패한다.
function lambdaThumbMemory(): Scenario {
  const acct = ACC.global, region = TOKYO, start = '2026-10-29T08:50:00.000Z';
  const g = new Topo(acct, region);
  g.role('thumb-role', 'thumbnail-maker-role');
  g.lambda('thumb', 'thumbnail-maker', 'thumb-role', { runtime: 'python3.12' });
  g.s3('uploads', `media-uploads-${acct}`);
  g.s3('thumbs', `media-thumbs-${acct}`);
  g.edge('uploads', 'thumb', 'notifies');
  g.access('thumb-role', 'uploads');
  g.access('thumb-role', 'thumbs');
  g.role('dev-role', 'thumbnail-maker-dev-role');
  g.lambda('dev', 'thumbnail-maker-dev', 'dev-role', { runtime: 'python3.12' });
  g.s3('logs', `access-logs-archive-${acct}`);
  const snap = g.snapshot(rel(start, -12));

  const tr = new Trail('lambda-thumb', acct, region, start);
  const script = viaBoto(iamUser(acct, 'ops-script'), '192.0.2.201');
  const at5 = ctTime(Date.parse(rel(start, -5)));
  const answer = tr.add({
    t: -5, name: L_CONFIG, source: LAMBDA, who: script,
    req: { functionName: 'thumbnail-maker', memorySize: 128 }, resp: lambdaConfig(g, 'thumb', at5, { timeout: 60, memorySize: 128, role: g.arn('thumb-role') }),
  });
  const at2 = ctTime(Date.parse(rel(start, -2)));
  tr.add({
    t: -2, name: L_CONFIG, source: LAMBDA, who: script,
    req: { functionName: 'thumbnail-maker-dev', memorySize: 256 }, resp: lambdaConfig(g, 'dev', at2, { timeout: 60, memorySize: 256, role: g.arn('dev-role') }),
  });
  tr.add({ t: -1, name: L_TAG, source: LAMBDA, who: viaConsole(sso(acct, 'yuki.tanaka@example.com'), '203.0.113.213'), req: { resource: g.arn('thumb'), tags: { 'finops:reviewed': 'true' } } });
  tr.add({
    t: -7, name: 'PutBucketNotificationConfiguration', source: S3, who: viaConsole(sso(acct, 'yuki.tanaka@example.com'), '203.0.113.213'),
    req: { bucketName: `access-logs-archive-${acct}`, Host: `access-logs-archive-${acct}.s3.${region}.amazonaws.com`, notification: '', NotificationConfiguration: { xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/' } },
  });
  tr.add({
    t: -12, name: L_CODE, source: LAMBDA, who: script,
    req: { functionName: 'thumbnail-maker', publish: true, zipFile: 'HIDDEN_DUE_TO_SECURITY_REASONS' },
    err: ['CodeStorageExceededException', 'Code storage limit exceeded.'],
  });
  tr.noise({ count: 10, from: -50, to: 4, lambdas: [['thumbnail-maker', 'thumbnail-maker-role'], ['thumbnail-maker-dev', 'thumbnail-maker-dev-role']] });
  return { id: 'lambda-thumbnail-memory-cut', title: 'thumbnail-maker Errors alarm — memory cut from 1024 MB to 128 MB by a cost script', category: 'lambda-config', accountId: acct, region, targetArn: g.arn('thumb'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// ---------- scenarios: IAM detach (events in us-east-1) / IAM 정책 떼기 ----------

// The image API role loses its bucket policy; the API returns 500 on S3 AccessDenied.
// 이미지 API 역할에서 버킷 정책이 떨어져 API가 S3 AccessDenied로 500을 낸다.
function iamDetachImg(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-21T04:40:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'img', octet: 13, count: 2, port: 8080, role: 'img-api-role' });
  g.s3('orig', `img-originals-${acct}`);
  g.access('role', 'orig');
  g.role('legacy', 'legacy-ci-role');
  const before = g.snapshot(rel(start, -28));
  g.unedge('role', 'orig', 'can_access');
  const after = g.snapshot(rel(start, -5));

  const tr = new Trail('iam-detach-img', acct, region, start);
  const minji = sso(acct, 'minji.lee@example.com');
  const answer = tr.add({
    t: -16, name: 'DetachRolePolicy', source: IAM, who: viaConsole(minji, '203.0.113.24'),
    req: { roleName: 'img-api-role', policyArn: `arn:aws:iam::${acct}:policy/img-originals-rw` },
  });
  tr.add({
    t: -6, name: 'DetachRolePolicy', source: IAM, who: viaConsole(minji, '203.0.113.24'),
    req: { roleName: 'legacy-ci-role', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' },
  });
  tr.add({ t: -3, name: 'TagRole', source: IAM, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'iam#1.37.2'), req: { roleName: 'img-api-role', tags: [{ key: 'Service', value: 'img-api' }] } });
  tr.add({
    t: -12, name: 'PutBucketPolicy', source: S3, who: viaCli(iamUser(acct, 'jaehyun.park'), '198.51.100.77', 's3api.put-bucket-policy'),
    req: { bucketName: `img-originals-${acct}`, Host: `img-originals-${acct}.s3.${region}.amazonaws.com`, policy: '', bucketPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: g.arn('role') }, Action: 's3:GetObject', Resource: `arn:aws:s3:::img-originals-${acct}/*` }] } },
    err: ['AccessDenied', 'Access Denied'],
  });
  tr.noise({ count: 8, from: -55, to: 4, instances: ssmOf(g, ['web1', 'web2'], 'img-api-role') });
  return { id: 'iam-detach-img-originals', title: 'img-alb 5xx — img-api-role lost its img-originals-rw policy', category: 'iam-detach', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// A CDK deploy detaches AWSLambdaVPCAccessExecutionRole from the settlement batch role.
// CDK 배포가 정산 배치 역할에서 AWSLambdaVPCAccessExecutionRole을 떼어 냈다.
function iamDetachSettlement(): Scenario {
  const acct = ACC.payments, region = SEOUL, start = '2026-10-22T15:00:00.000Z';
  const g = new Topo(acct, region);
  g.vpc('vpc', 'settlement-prod-vpc', '10.53.0.0/16');
  g.subnet('app-a', 'vpc', 'settlement-private-a', '10.53.10.0/24', `${region}a`);
  g.subnet('app-c', 'vpc', 'settlement-private-c', '10.53.11.0/24', `${region}c`);
  g.sg('sg-fn', 'vpc', 'settlement-batch-sg');
  g.role('fn-role', 'settlement-batch-role');
  g.lambda('fn', 'settlement-batch', 'fn-role', { runtime: 'python3.12', subnets: ['app-a', 'app-c'], sgs: ['sg-fn'] });
  g.s3('reports', `settlement-reports-${acct}`);
  g.access('fn-role', 'reports');
  g.role('partner', 'partner-sync-role');
  const snap = g.snapshot(rel(start, -40));
  const snap2 = g.snapshot(rel(start, -10));

  const tr = new Trail('iam-detach-settlement', acct, region, start);
  const answer = tr.add({
    t: -29, name: 'DetachRolePolicy', source: IAM, who: cfn(acct),
    req: { roleName: 'settlement-batch-role', policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole' },
  });
  tr.add({
    t: -10, name: 'PutRolePolicy', source: IAM, who: cfn(acct),
    req: { roleName: 'partner-sync-role', policyName: 'partner-sftp-read', policyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::partner-drop-${acct}/*` }] }) },
  });
  tr.add({ t: -4, name: L_TAG, source: LAMBDA, who: cfn(acct), req: { resource: g.arn('fn'), tags: { 'aws:cloudformation:stack-name': 'SettlementStack' } } });
  tr.add({
    t: -2, name: L_CONFIG, source: LAMBDA, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'),
    req: { functionName: 'settlement-batch', timeout: 900 },
    err: ['ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${g.arn('fn')}`],
  });
  tr.noise({ count: 9, from: -58, to: 4, lambdas: [['settlement-batch', 'settlement-batch-role']] });
  return { id: 'iam-detach-settlement-vpc-access', title: 'settlement-batch Errors alarm — VPC access policy detached by a CDK deploy', category: 'iam-detach', accountId: acct, region, targetArn: g.arn('fn'), startedAt: start, graphs: [snap, snap2], events: tr.events, answer };
}

// ---------- scenarios: RDS modify / RDS 설정 변경 ----------

// booking-pg is downsized with applyImmediately; the instance restarts and the app returns 5xx.
// booking-pg를 즉시 적용으로 작게 바꿔 DB가 재시작되고 앱이 5xx를 낸다.
function rdsBookingClass(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-23T10:10:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'booking', octet: 25, count: 2, port: 8080, role: 'booking-ec2-role' });
  g.sg('sg-db', 'vpc', 'booking-pg-sg');
  g.allow('sg-db', 'sg-app');
  g.rds('db', 'booking-pg', ['app-a', 'app-b'], ['sg-db'], 'postgres', 'db.r6g.large');
  const before = g.snapshot(rel(start, -30));
  g.attr('db', 'status', 'modifying');
  const after = g.snapshot(rel(start, -15));

  const tr = new Trail('rds-booking', acct, region, start);
  const yuna = sso(acct, 'yuna.kang@example.com', 'PowerUserAccess');
  const answer = tr.add({
    t: -19, name: 'ModifyDBInstance', source: RDS, who: viaConsole(yuna, '203.0.113.191'),
    req: { dBInstanceIdentifier: 'booking-pg', dBInstanceClass: 'db.t4g.medium', applyImmediately: true },
    resp: { dBInstanceIdentifier: 'booking-pg', dBInstanceClass: 'db.r6g.large', engine: 'postgres', dBInstanceStatus: 'available', pendingModifiedValues: { dBInstanceClass: 'db.t4g.medium' }, multiAZ: false, dBInstanceArn: g.arn('db') },
  });
  tr.add({
    t: -7, name: 'ModifyDBParameterGroup', source: RDS, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'rds.modify-db-parameter-group'),
    req: { dBParameterGroupName: 'reporting-pg16', parameters: [{ parameterName: 'work_mem', parameterValue: '65536', applyMethod: 'immediate' }] },
    resp: { dBParameterGroupName: 'reporting-pg16' },
  });
  tr.add({ t: -3, name: 'AddTagsToResource', source: RDS, who: viaConsole(yuna, '203.0.113.191'), req: { resourceName: g.arn('db'), tags: [{ key: 'finops', value: 'rightsized-2026-10' }] } });
  tr.add({
    t: -14, name: 'RebootDBInstance', source: RDS, who: viaCli(iamUser(acct, 'dohyun.kim'), '192.0.2.140', 'rds.reboot-db-instance'),
    req: { dBInstanceIdentifier: 'booking-pg', forceFailover: false }, err: ['InvalidDBInstanceState', 'Instance booking-pg is not currently in the available state.'],
  });
  tr.noise({ count: 8, from: -50, to: 3, instances: ssmOf(g, ['web1', 'web2'], 'booking-ec2-role') });
  return { id: 'rds-booking-class-downsize', title: 'booking-alb 5xx — booking-pg downsized with applyImmediately', category: 'rds-modify', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// terraform swaps ledger-pg's SG to a new one with no rule for the app SG.
// terraform이 ledger-pg의 SG를 앱 SG 규칙이 없는 새 SG로 바꿨다.
function rdsLedgerSg(): Scenario {
  const acct = ACC.data, region = VIRGINIA, start = '2026-10-24T18:35:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'ledger', octet: 70, count: 2, port: 8080, role: 'ledger-ec2-role' });
  g.sg('sg-db', 'vpc', 'ledger-pg-sg');
  g.allow('sg-db', 'sg-app');
  g.sg('sg-db-new', 'vpc', 'ledger-pg-sg-v2');
  g.rds('db', 'ledger-pg', ['app-a', 'app-b'], ['sg-db'], 'postgres', 'db.r6g.2xlarge');
  g.sg('sg-vpn', 'vpc', 'ledger-vpn-sg');
  const before = g.snapshot(rel(start, -50));
  g.unedge('db', 'sg-db', 'uses_sg');
  g.unedge('db.eni', 'sg-db', 'uses_sg');
  g.edge('db', 'sg-db-new', 'uses_sg');
  g.edge('db.eni', 'sg-db-new', 'uses_sg');
  const after = g.snapshot(rel(start, -20));

  const tr = new Trail('rds-ledger', acct, region, start);
  const ci = iamUser(acct, 'ci-terraform');
  const answer = tr.add({
    t: -35, name: 'ModifyDBInstance', source: RDS, who: viaTf(ci, '192.0.2.18', 'rds#1.88.0'),
    req: { dBInstanceIdentifier: 'ledger-pg', vpcSecurityGroupIds: [g.id('sg-db-new')], applyImmediately: true },
    resp: { dBInstanceIdentifier: 'ledger-pg', dBInstanceClass: 'db.r6g.2xlarge', engine: 'postgres', dBInstanceStatus: 'available', vpcSecurityGroups: [{ vpcSecurityGroupId: g.id('sg-db-new'), status: 'adding' }, { vpcSecurityGroupId: g.id('sg-db'), status: 'removing' }], dBInstanceArn: g.arn('db') },
  });
  tr.add({
    t: -5, name: 'CreateDBSnapshot', source: RDS, who: backup(acct),
    req: { dBSnapshotIdentifier: `awsbackup:job-${uuid('ledger-backup')}`, dBInstanceIdentifier: 'ledger-pg' },
    resp: { dBSnapshotIdentifier: `awsbackup:job-${uuid('ledger-backup')}`, dBInstanceIdentifier: 'ledger-pg', status: 'creating', engine: 'postgres' },
  });
  tr.add({
    t: -12, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'),
    req: { groupId: g.id('sg-vpn'), ipPermissions: items([sgPerm(1194, { cidr: '0.0.0.0/0' }, 'udp')]) },
  });
  tr.add({ t: -20, name: 'AddTags', source: ELB, who: viaTf(ci, '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('tg')], { Service: 'ledger' }) });
  tr.noise({ count: 8, from: -58, to: 4, instances: ssmOf(g, ['web1', 'web2'], 'ledger-ec2-role') });
  return { id: 'rds-ledger-sg-swap-terraform', title: 'ledger-tg unhealthy — ledger-pg moved to an SG with no app rule', category: 'rds-modify', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// ---------- scenarios: SG swapped on an ENI / ENI 보안그룹 바꿔 끼우기 ----------

// chat-ws-01's ENI gets only a temporary debug SG; the old app SG link is gone from the newer graph.
// chat-ws-01 ENI에 임시 디버그 SG만 남아, 새 그래프에서는 기존 앱 SG 연결이 사라졌다.
function eniSwapChat(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-25T07:55:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'chat', octet: 14, count: 2, port: 8081, role: 'chat-ws-role' });
  g.sg('sg-debug', 'vpc', 'chat-temp-debug');
  g.sg('sg-ops', 'vpc', 'chat-ops-tools-sg');
  g.instance('ops', 'app-b', ['sg-ops'], { name: 'chat-ops-01', type: 't4g.small' });
  const before = g.snapshot(rel(start, -24));
  g.unedge('web1.eni', 'sg-app', 'uses_sg');
  g.unedge('web1', 'sg-app', 'uses_sg');
  g.edge('web1.eni', 'sg-debug', 'uses_sg');
  g.edge('web1', 'sg-debug', 'uses_sg');
  const after = g.snapshot(rel(start, -9));

  const tr = new Trail('eni-swap-chat', acct, region, start);
  const jaehyun = iamUser(acct, 'jaehyun.park');
  const answer = tr.add({
    t: -13, name: 'ModifyNetworkInterfaceAttribute', source: EC2, who: viaConsole(jaehyun, '198.51.100.77'),
    req: { networkInterfaceId: g.id('web1.eni'), groupSet: items([{ groupId: g.id('sg-debug') }]) },
  });
  tr.add({ t: -4, name: 'CreateTags', source: EC2, who: viaConsole(jaehyun, '198.51.100.77'), req: tagSet([g.id('web1')], { debug: 'ws-handshake' }) });
  tr.add({
    t: -7, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(sso(acct, 'minji.lee@example.com'), '203.0.113.24'),
    req: { groupId: g.id('sg-ops'), ipPermissions: items([sgPerm(3389, { cidr: '10.14.0.0/16' })]) },
  });
  tr.add({
    t: -15, name: 'ModifyInstanceAttribute', source: EC2, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { instanceId: g.id('web1'), groupSet: items([{ groupId: g.id('sg-debug') }]) }, err: UNAUTH(`arn:aws:iam::${acct}:user/intern-readonly`, 'ec2:ModifyInstanceAttribute'),
  });
  tr.noise({ count: 7, from: -50, to: 3, instances: ssmOf(g, ['web1', 'web2', 'ops'], 'chat-ws-role') });
  return { id: 'eni-swap-chat-debug-sg', title: 'chat-tg unhealthy — chat-web-01 ENI left with only a debug SG', category: 'eni-sg-swap', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// Merges two single-account snapshots taken at the same time (aggregator view). / 같은 시각 두 계정 스냅샷 합치기.
function combine(a: GraphSnapshot, b: GraphSnapshot): GraphSnapshot {
  return { builtAt: a.builtAt, data: { nodes: [...a.data.nodes, ...b.data.nodes], edges: [...a.data.edges, ...b.data.edges], dropped: 0 } };
}

// The MQTT broker ENI is switched to the VPC default SG. The aggregator graph also holds a staging
// account with the same names (default SG, mqtt-web-01), which must not be confused with prod.
// MQTT 브로커 ENI가 VPC 기본 SG로 바뀌었다. 같은 이름의 스테이징 계정 노드도 그래프에 있다.
function eniSwapMqtt(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-26T03:20:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'mqtt', octet: 26, count: 1, port: 8883, kind: 'net', role: 'mqtt-broker-role' });
  g.sg('sg-default', 'vpc', 'default');
  const twin = new Topo(ACC.staging, region);
  twin.vpc('vpc', 'mqtt-staging-vpc', '10.126.0.0/16');
  twin.subnet('app-a', 'vpc', 'mqtt-staging-private-a', '10.126.10.0/24', `${region}a`);
  twin.sg('sg-default', 'vpc', 'default');
  twin.instance('web1', 'app-a', ['sg-default'], { name: 'mqtt-web-01', type: 't4g.small' });
  const before = combine(g.snapshot(rel(start, -15)), twin.snapshot(rel(start, -15)));
  g.unedge('web1.eni', 'sg-app', 'uses_sg');
  g.unedge('web1', 'sg-app', 'uses_sg');
  g.edge('web1.eni', 'sg-default', 'uses_sg');
  g.edge('web1', 'sg-default', 'uses_sg');
  const after = combine(g.snapshot(rel(start, -1)), twin.snapshot(rel(start, -1)));

  const tr = new Trail('eni-swap-mqtt', acct, region, start);
  const seojun = sso(acct, 'seojun.choi@example.com');
  const answer = tr.add({
    t: -4, name: 'ModifyNetworkInterfaceAttribute', source: EC2, who: viaCli(seojun, '203.0.113.61', 'ec2.modify-network-interface-attribute'),
    req: { networkInterfaceId: g.id('web1.eni'), groupSet: items([{ groupId: g.id('sg-default') }]) },
  });
  tr.add({
    t: -2, name: 'AuthorizeSecurityGroupIngress', source: EC2, who: viaCli(seojun, '203.0.113.61', 'ec2.authorize-security-group-ingress'),
    req: { groupId: g.id('sg-app'), ipPermissions: items([sgPerm(8883, { cidr: '10.26.0.0/16', desc: 'mqtt from vpc' })]) },
  });
  tr.add({ t: -9, name: 'AddTags', source: ELB, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'), req: elbTags([g.arn('tg')], { Protocol: 'mqtts' }) });
  tr.add({
    t: -3, name: 'ModifyInstanceAttribute', source: EC2, who: viaCli(seojun, '203.0.113.61', 'ec2.modify-instance-attribute'),
    req: { instanceId: g.id('web1'), disableApiTermination: { value: true } }, err: UNAUTH(String(seojun.arn), 'ec2:ModifyInstanceAttribute'),
  });
  tr.noise({ count: 6, from: -45, to: 4, instances: ssmOf(g, ['web1'], 'mqtt-broker-role') });
  return { id: 'eni-swap-mqtt-default-sg', title: 'mqtt-tg unhealthy — broker ENI switched to the VPC default SG', category: 'eni-sg-swap', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// ---------- scenarios: noise-heavy / 잡음만 많은 경우 ----------

// The console's "delete rule" (by rule id) removes the ALB → app rule among 36 heartbeat events.
// 하트비트 36건 사이에서, 콘솔 "규칙 삭제"(규칙 ID 방식)로 ALB → 앱 규칙이 지워졌다.
function noiseEventSg(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-27T12:00:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'event', octet: 15, count: 4, port: 8080, role: 'event-web-role' });
  g.role('ingest-role', 'event-ingest-role');
  g.lambda('ingest', 'event-ingest', 'ingest-role', { runtime: 'python3.12' });
  g.role('fanout-role', 'event-fanout-role');
  g.lambda('fanout', 'event-fanout', 'fanout-role', { runtime: 'python3.12' });
  g.s3('raw', `event-raw-${acct}`);
  g.edge('raw', 'ingest', 'notifies');
  const before = g.snapshot(rel(start, -22));
  g.unedge('sg-app', 'sg-lb', 'allows_from');
  const after = g.snapshot(rel(start, -3));

  const tr = new Trail('noise-event-sg', acct, region, start);
  const hana = sso(acct, 'hana.jung@example.com');
  const rule = `sgr-${hex('event-alb-rule', 17)}`;
  tr.add({
    t: -11, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(hana, '203.0.113.5'),
    req: { groupId: g.id('sg-app'), securityGroupRuleIds: items([{ securityGroupRuleId: `sgr-${hex('event-wrong-rule', 17)}` }]) },
    err: ['Client.InvalidSecurityGroupRuleId.NotFound', `The security group rule ID 'sgr-${hex('event-wrong-rule', 17)}' does not exist`],
  });
  const answer = tr.add({
    t: -10, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(hana, '203.0.113.5'),
    req: { groupId: g.id('sg-app'), securityGroupRuleIds: items([{ securityGroupRuleId: rule }]) },
    resp: { requestId: uuid('event-revoke'), _return: true, revokedSecurityGroupRuleSet: items([{ groupId: g.id('sg-app'), securityGroupRuleId: rule, isEgress: false, ipProtocol: 'tcp', fromPort: 8080, toPort: 8080, referencedGroupId: g.id('sg-lb') }]) },
  });
  tr.add({ t: -1, name: 'AddTags', source: ELB, who: viaConsole(hana, '203.0.113.5'), req: elbTags([g.arn('lb')], { Incident: 'none' }) });
  const at5 = ctTime(Date.parse(rel(start, -5)));
  tr.add({
    t: -5, name: L_CONFIG, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('fanout'), timeout: 30 }, resp: lambdaConfig(g, 'fanout', at5, { timeout: 30, memorySize: 512, role: g.arn('fanout-role') }),
  });
  tr.noise({
    count: 36, from: -58, to: 5, instances: ssmOf(g, ['web1', 'web2', 'web3', 'web4'], 'event-web-role'),
    lambdas: [['event-ingest', 'event-ingest-role'], ['event-fanout', 'event-fanout-role']],
  });
  return { id: 'noise-heavy-event-sg-rule-id', title: 'event-alb 5xx — app SG rule from the ALB deleted by rule id, inside heavy noise', category: 'noise-heavy', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// A nightly-stop script with a wrong tag filter stops every prod stream node.
// 태그 필터가 틀린 야간 정지 스크립트가 운영 스트림 노드를 모두 껐다.
function noiseStreamStop(): Scenario {
  const acct = ACC.data, region = VIRGINIA, start = '2026-10-28T09:30:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'stream', octet: 71, count: 3, port: 8080, role: 'stream-node-role' });
  g.sg('sg-dev', 'vpc', 'stream-dev-sg');
  g.instance('dev', 'app-b', ['sg-dev'], { name: 'stream-dev-01', type: 't4g.large', role: 'role' });
  const before = g.snapshot(rel(start, -35));
  for (const k of ['web1', 'web2', 'web3']) g.attr(k, 'state', 'stopped');
  const after = g.snapshot(rel(start, -6));

  const tr = new Trail('noise-stream-stop', acct, region, start);
  const ids = [g.id('web1'), g.id('web2'), g.id('web3')];
  const answer = tr.add({
    t: -21, name: 'StopInstances', source: EC2, who: viaBoto(iamUser(acct, 'ops-script'), '10.71.10.250'),
    req: { instancesSet: instSet(...ids), force: false }, resp: stateChange(ids, [16, 'running'], [64, 'stopping']),
  });
  tr.add({
    t: -2, name: 'StopInstances', source: EC2, who: viaBoto(iamUser(acct, 'dev-scheduler'), '10.71.10.251'),
    req: { instancesSet: instSet(g.id('dev')), force: false }, resp: stateChange([g.id('dev')], [16, 'running'], [64, 'stopping']),
  });
  tr.add({ t: -9, name: 'CreateTags', source: EC2, who: viaBoto(iamUser(acct, 'ops-script'), '10.71.10.250'), req: tagSet(ids, { 'nightly-stop': 'done-2026-10-28' }) });
  tr.add({
    t: -16, name: 'StartInstances', source: EC2, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { instancesSet: instSet(g.id('web2')) }, err: UNAUTH(`arn:aws:iam::${acct}:user/intern-readonly`, 'ec2:StartInstances'),
  });
  tr.noise({ count: 40, from: -59, to: 5, instances: ssmOf(g, ['web1', 'web2', 'web3', 'dev'], 'stream-node-role') });
  return { id: 'noise-heavy-stream-nightly-stop', title: 'stream-tg unhealthy — nightly-stop script stopped all prod nodes, inside heavy noise', category: 'noise-heavy', accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// A host-header typo on the checkout rule sends traffic to the default 503 action.
// checkout 규칙의 host-header 오타로 트래픽이 기본 503 동작으로 빠진다.
function noiseCheckoutRule(): Scenario {
  const acct = ACC.payments, region = SEOUL, start = '2026-10-28T22:10:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'checkout', octet: 54, count: 3, port: 8080, role: 'checkout-ec2-role' });
  g.role('ev-role', 'checkout-events-role');
  g.lambda('events', 'checkout-events', 'ev-role', { runtime: 'nodejs20.x' });
  g.role('rc-role', 'checkout-reconcile-role');
  g.lambda('reconcile', 'checkout-reconcile', 'rc-role', { runtime: 'nodejs20.x' });
  const snap = g.snapshot(rel(start, -25));
  const snap2 = g.snapshot(rel(start, -10));

  const tr = new Trail('noise-checkout-rule', acct, region, start);
  const conditions = [{ field: 'host-header', hostHeaderConfig: { values: ['checkout.exmaple.com'] } }];
  tr.add({
    t: -18, name: 'ModifyRule', source: ELB, who: gha(acct, 'elasticloadbalancingv2#1.40.1'),
    req: { ruleArn: g.rule('lb', 443, 1), conditions: [{ field: 'host-header', values: ['checkout.exmaple.com'], hostHeaderConfig: { values: ['checkout.exmaple.com'] } }] },
    err: ['ValidationError', "A condition cannot have both 'Values' and 'HostHeaderConfig' specified"],
  });
  const answer = tr.add({
    t: -17, name: 'ModifyRule', source: ELB, who: gha(acct, 'elasticloadbalancingv2#1.40.1'),
    req: { ruleArn: g.rule('lb', 443, 1), conditions, actions: [{ type: 'forward', targetGroupArn: g.arn('tg') }] },
    resp: { rules: [{ ruleArn: g.rule('lb', 443, 1), priority: '10', conditions, isDefault: false }] },
  });
  tr.add({ t: -3, name: 'AddTags', source: ELB, who: gha(acct, 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('tg')], { Release: 'checkout-2026.10.28' }) });
  const at6 = ctTime(Date.parse(rel(start, -6)));
  tr.add({
    t: -6, name: L_CONFIG, source: LAMBDA, who: gha(acct, 'lambda#1.64.0'),
    req: { functionName: g.arn('events'), memorySize: 1024 }, resp: lambdaConfig(g, 'events', at6, { timeout: 30, memorySize: 1024, role: g.arn('ev-role') }),
  });
  tr.noise({
    count: 34, from: -57, to: 5, instances: ssmOf(g, ['web1', 'web2', 'web3'], 'checkout-ec2-role'),
    lambdas: [['checkout-events', 'checkout-events-role'], ['checkout-reconcile', 'checkout-reconcile-role']],
  });
  return { id: 'noise-heavy-checkout-host-typo', title: 'checkout-alb 5xx — host-header typo on the checkout rule, inside heavy noise', category: 'noise-heavy', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [snap, snap2], events: tr.events, answer };
}

// ---------- scenario: CodeDeploy in-place deregister / CodeDeploy 배포 중 빼기 ----------

// An AllAtOnce in-place CodeDeploy deployment blocks traffic on every instance.
// AllAtOnce 현장 배포가 모든 인스턴스의 트래픽을 막았다.
function tgDeregisterDealCodeDeploy(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-29T03:05:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'deal', octet: 16, count: 2, port: 8080, role: 'deal-ec2-role' });
  g.sg('sg-cache', 'vpc', 'deal-cache-sg');
  g.allow('sg-cache', 'sg-app');
  const before = g.snapshot(rel(start, -14));
  g.unedge('tg', 'web1', 'targets');
  g.unedge('tg', 'web2', 'targets');
  const after = g.snapshot(rel(start, -1));

  const tr = new Trail('tg-deregister-deal', acct, region, start);
  const answer = tr.add({
    t: -3, name: 'DeregisterTargets', source: ELB, who: codedeploy(acct),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: g.id('web1') }, { id: g.id('web2') }] },
  });
  tr.add({
    t: -2, name: 'RegisterTargets', source: ELB, who: viaConsole(sso(acct, 'minji.lee@example.com'), '203.0.113.24'),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: 'i-0deal0web0001', port: 8080 }] },
    err: ['InvalidTarget', "The following targets are not valid instances: 'i-0deal0web0001'"],
  });
  tr.add({
    t: -8, name: 'AuthorizeSecurityGroupIngress', source: EC2, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'ec2#1.187.0'),
    req: { groupId: g.id('sg-cache'), ipPermissions: items([sgPerm(6379, { groupId: g.id('sg-app') })]) },
  });
  tr.add({ t: -12, name: 'AddTags', source: ELB, who: viaTf(iamUser(acct, 'ci-terraform'), '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('lb')], { Deploy: 'codedeploy' }) });
  tr.noise({ count: 6, from: -50, to: 4, instances: ssmOf(g, ['web1', 'web2'], 'deal-ec2-role') });
  return { id: 'tg-deregister-deal-codedeploy', title: 'deal-alb 503 — CodeDeploy AllAtOnce deregistered both instances', category: 'tg-deregister', accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [before, after], events: tr.events, answer };
}

// ---------- known limits: cause outside the 15 node types / 알려진 한계: 15종 밖 ----------

// The private route table's default route is replaced with a dead ENI; outbound calls to the PG fail.
// 사설 라우팅 테이블의 기본 경로가 죽은 ENI로 바뀌어 외부 결제 호출이 실패한다.
function knownRouteBlackhole(): Scenario {
  const acct = ACC.commerce, region = SEOUL, start = '2026-10-11T16:20:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'pgw', octet: 17, count: 2, port: 8080, role: 'pgw-ec2-role' });
  g.nat('nat', 'pub-a', 'pgw-nat-a');
  const snap = g.snapshot(rel(start, -18));

  const tr = new Trail('known-route', acct, region, start);
  const minji = sso(acct, 'minji.lee@example.com');
  const answer = tr.add({
    t: -8, name: 'ReplaceRoute', source: EC2, who: viaConsole(minji, '203.0.113.24'),
    req: { routeTableId: `rtb-${hex('pgw-private-rtb', 17)}`, destinationCidrBlock: '0.0.0.0/0', networkInterfaceId: `eni-${hex('pgw-old-proxy', 17)}` },
  });
  tr.add({
    t: -3, name: 'AuthorizeSecurityGroupIngress', source: EC2, who: viaConsole(minji, '203.0.113.24'),
    req: { groupId: g.id('sg-app'), ipPermissions: items([sgPerm(9100, { cidr: '10.17.0.0/16', desc: 'node exporter' })]) },
  });
  tr.add({ t: -5, name: 'CreateTags', source: EC2, who: viaConsole(minji, '203.0.113.24'), req: tagSet([g.id('web1')], { Patch: '2026-10-11' }) });
  tr.add({
    t: -12, name: 'ModifyListener', source: ELB, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { listenerArn: g.listener('lb', 443), sslPolicy: 'ELBSecurityPolicy-TLS13-1-3-2021-06' }, err: ACCESS_DENIED(`arn:aws:iam::${acct}:user/intern-readonly`, 'elasticloadbalancing:ModifyListener'),
  });
  tr.noise({ count: 7, from: -50, to: 3, instances: ssmOf(g, ['web1', 'web2'], 'pgw-ec2-role') });
  return { id: 'known-limit-route-blackhole', title: 'pgw-alb 5xx — default route replaced with a dead ENI (route table is not a graph node)', category: 'route-change', knownLimit: true, accountId: acct, region, targetArn: g.arn('lb'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// A NACL entry on the app subnets now denies 8080 from the public subnets.
// 앱 서브넷 NACL 항목이 공개 서브넷의 8080을 막도록 바뀌었다.
function knownNaclDeny(): Scenario {
  const acct = ACC.platform, region = SEOUL, start = '2026-10-13T20:45:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'cart', octet: 27, count: 3, port: 8080, role: 'cart-ec2-role' });
  g.sg('sg-misc', 'vpc', 'cart-cron-sg');
  const snap = g.snapshot(rel(start, -28));

  const tr = new Trail('known-nacl', acct, region, start);
  const ci = iamUser(acct, 'ci-terraform');
  const answer = tr.add({
    t: -15, name: 'ReplaceNetworkAclEntry', source: EC2, who: viaTf(ci, '192.0.2.18', 'ec2#1.187.0'),
    req: { networkAclId: `acl-${hex('cart-app-nacl', 17)}`, ruleNumber: 100, egress: false, ruleAction: 'deny', icmpTypeCode: {}, portRange: { from: 8080, to: 8080 }, aclProtocol: '6', cidrBlock: '10.27.0.0/23' },
  });
  tr.add({
    t: -4, name: 'RevokeSecurityGroupIngress', source: EC2, who: viaConsole(sso(acct, 'yuna.kang@example.com', 'PowerUserAccess'), '203.0.113.191'),
    req: { groupId: g.id('sg-misc'), ipPermissions: items([sgPerm(22, { cidr: '10.0.0.0/8' })]) },
  });
  tr.add({ t: -9, name: 'AddTags', source: ELB, who: viaTf(ci, '192.0.2.18', 'elasticloadbalancingv2#1.40.1'), req: elbTags([g.arn('tg')], { Service: 'cart' }) });
  tr.add({
    t: -20, name: 'ModifyTargetGroupAttributes', source: ELB, who: viaTf(ci, '192.0.2.18', 'elasticloadbalancingv2#1.40.1'),
    req: { targetGroupArn: g.arn('tg'), attributes: [{ key: 'stickiness.type', value: 'app_cookie' }] },
    err: ['ValidationError', "The 'stickiness.app_cookie.cookie_name' attribute is required when stickiness type is app_cookie"],
  });
  tr.noise({ count: 8, from: -55, to: 4, instances: ssmOf(g, ['web1', 'web2', 'web3'], 'cart-ec2-role') });
  return { id: 'known-limit-nacl-deny', title: 'cart-tg unhealthy — NACL entry now denies 8080 from the public subnets (NACL is not a graph node)', category: 'nacl-change', knownLimit: true, accountId: acct, region, targetArn: g.arn('tg'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// A Route 53 UPSERT points api.pay at the old ALB whose TG has no targets.
// Route 53 UPSERT가 api.pay를 대상이 없는 옛 ALB로 돌렸다.
function knownDnsOldAlb(): Scenario {
  const acct = ACC.data, region = VIRGINIA, start = '2026-10-16T12:30:00.000Z';
  const g = new Topo(acct, region);
  webTier(g, { prefix: 'payapi', octet: 72, count: 2, port: 8080, role: 'payapi-ec2-role' });
  g.sg('sg-old', 'vpc', 'payapi-old-alb-sg');
  g.lb('old', 'payapi-old-alb', 'app', ['pub-a', 'pub-b'], ['sg-old']);
  g.tg('old-tg', 'payapi-old-tg', 'vpc', ['old'], [], { port: 8080 });
  const snap = g.snapshot(rel(start, -20));

  const tr = new Trail('known-dns', acct, region, start);
  const answer = tr.add({
    t: -9, name: 'ChangeResourceRecordSets', source: 'route53.amazonaws.com', who: viaCli(sso(acct, 'hana.jung@example.com'), '203.0.113.5', 'route53.change-resource-record-sets'),
    req: { hostedZoneId: 'Z0812345ABCDEFGHIJKLM', changeBatch: { changes: [{ action: 'UPSERT', resourceRecordSet: { name: 'api.pay.example.com', type: 'A', aliasTarget: { hostedZoneId: 'Z35SXDOTRQ7X7K', dNSName: String(g.n('old').attrs.dnsName), evaluateTargetHealth: true } } }] } },
    resp: { changeInfo: { id: `/change/C${up(hex('dns-change', 20))}`, status: 'PENDING', submittedAt: 'Oct 16, 2026, 12:20:55 PM' } },
  });
  tr.add({ t: -2, name: 'AddTags', source: ELB, who: viaConsole(sso(acct, 'hana.jung@example.com'), '203.0.113.5'), req: elbTags([g.arn('old')], { Retire: 'true' }) });
  tr.add({
    t: -5, name: 'DeregisterTargets', source: ELB, who: viaCli(iamUser(acct, 'sangwoo.han'), '203.0.113.88', 'elbv2.deregister-targets'),
    req: { targetGroupArn: g.arn('tg'), targets: [{ id: g.id('web2'), port: 8080 }] },
  });
  tr.add({
    t: -12, name: 'ModifyLoadBalancerAttributes', source: ELB, who: viaConsole(iamUser(acct, 'intern-readonly'), '203.0.113.140', UA.consoleWin),
    req: { loadBalancerArn: g.arn('old'), attributes: [{ key: 'deletion_protection.enabled', value: 'false' }] },
    err: ACCESS_DENIED(`arn:aws:iam::${acct}:user/intern-readonly`, 'elasticloadbalancing:ModifyLoadBalancerAttributes'),
  });
  tr.noise({ count: 7, from: -55, to: 4, instances: ssmOf(g, ['web1', 'web2'], 'payapi-ec2-role') });
  return { id: 'known-limit-dns-old-alb', title: 'payapi-old-alb 5xx — Route 53 alias moved to the retired ALB (Route 53 is not a graph node)', category: 'dns-change', knownLimit: true, accountId: acct, region, targetArn: g.arn('old'), startedAt: start, graphs: [snap], events: tr.events, answer };
}

// ---------- export / 내보내기 ----------

// Answers are the operator's judgment, fixed before the ranker exists. Do not edit to fit a score.
// 정답은 순위 코드보다 먼저 정한 운영자 판단이다. 점수에 맞추려고 고치지 않는다.
export const SCENARIOS: Scenario[] = [
  sgRevokeShop(), sgRevokeApiDb(), sgRevokeIngestCidr(),
  tgDeregisterPay(), tgDeregisterSearchCfn(), tgDeregisterDealCodeDeploy(),
  stopAdminSlack(), stopCmsConsole(), stopPgbouncer(),
  listenerMallCanary(), ruleGatewayGreen(), listenerMemberMaintenance(),
  lambdaNotifyTimeout(), lambdaOrderVpcSg(), lambdaThumbMemory(),
  iamDetachImg(), iamDetachSettlement(),
  rdsBookingClass(), rdsLedgerSg(),
  eniSwapChat(), eniSwapMqtt(),
  noiseEventSg(), noiseStreamStop(), noiseCheckoutRule(),
  knownRouteBlackhole(), knownNaclDeny(), knownDnsOldAlb(),
];
