# Dependency Graph & Impact Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract relationships between 15 AWS resource types from Steampipe. Store them in an in-process PostgreSQL (PGlite) `edges` table. Answer impact questions with recursive CTEs. Show the graph on a new `/dependency-graph` page. Feed the result into the safe-AI-actions card and into a read-only "project cleanup preview".

**Architecture:** `src/lib/dep-graph/` holds:
- pure extractors (Steampipe rows → nodes and edges)
- a PGlite store (schema, bulk load, recursive-CTE walks, atomic pointer swap)
- a pure project-closure engine
- a build loop (60 s after boot, then every 15 min, with a JSON snapshot)

`/api/graph` is GET-only. The page uses React Flow, which is already a dependency. Nothing ever writes to AWS.

**Tech Stack:** Next.js 14 App Router, TypeScript, vitest, `@electric-sql/pglite@0.5.12`, reactflow 11, pg (Steampipe through the existing `batchQuery`).

**Spec:** `docs/superpowers/specs/2026-10-28-dependency-graph-design.md` (the binding authority; read it before any task).

## Global Constraints

- Edge direction: `src → dst` means "src uses / depends on dst". `impact` walks reverse; `dependencies` walks forward.
- Steampipe access only through `batchQuery()` from `@/lib/steampipe`. SELECT only. Never put `$` in SQL. Never select Lambda `tags`. Parse JSONB in TypeScript.
- Every Steampipe query selects `account_id` and `region`. S3 is the exception: it has `region` but its ARN has no account, so it still selects `account_id`.
- Walk depth: `impact` and `dependencies` default 3, range 1–6. `neighborhood` default 2, range 1–3. Out-of-range or non-integer values fall back to the default.
- Result cap is 300 nodes per walk. Over the cap, set `truncated: true`. `search` returns at most 20; `hubs` defaults to 10.
- Snapshot path: `data/graph/latest.json`. Write it to a temp file first, then rename.
- Build loop: production only. First run 60 000 ms after boot, then every 900 000 ms. Never overlapping.
- Error responses and logs carry error names only (`e instanceof Error ? e.name : 'Error'`).
- Never store secrets in `attrs`: no Lambda env vars, no user data, no policy text. Keep at most 50 tags per node, with values truncated to 256 chars.
- UI copy is Korean first. Add every new key to `ko.json`, `en.json` and `zh.json`. The cleanup tab always shows "안내만 해요 — 실제로 지우지 않아요".
- Components use `export default`. Every `fetch()` goes to `/api/*`. Theme colours come from root CLAUDE.md.
- Comment style matches the repo: short English line, then a Korean line where helpful.

## Review Focus

1. One Steampipe query fails (SCP, permission, timeout). The build continues, the query name goes into `warnings`, and the other types still produce nodes and edges. Owned by Task 5.
2. JSONB columns that are null, missing, or the wrong shape (`groups: null`, `Resource` as a string, `policy_std` null). Extractors skip them and never throw. Owned by Tasks 2 and 3.
3. The API is called before any graph exists. The response is `200 {status:'building'}`, never a 500. Owned by Task 7.
4. A security-group cycle (A allows_from B, B allows_from A) makes every walk terminate with the correct minimum depths. Owned by Task 4.
5. A hub such as a VPC with many dependents, at depth 3, is capped at 300 nodes with `truncated: true`, and the UI shows a "일부만 보여요" note. Owned by Tasks 4 and 8.

---

### Task 1: Types, queries, node builder, edge sink

**Files:**
- Create: `src/lib/dep-graph/types.ts`, `src/lib/dep-graph/queries.ts`, `src/lib/dep-graph/nodes.ts`, `src/lib/dep-graph/sink.ts`
- Test: `src/lib/dep-graph/__tests__/nodes.test.ts`, `src/lib/dep-graph/__tests__/queries.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type NodeType = 'vpc'|'subnet'|'eni'|'instance'|'sg'|'lb'|'tg'|'rds'|'lambda'|'role'|'nat'|'eip'|'ebs'|'s3'|'cloudfront';
  export type EdgeType = 'in_vpc'|'in_subnet'|'uses_sg'|'allows_from'|'uses_role'|'uses_volume'|'uses_eni'|'uses_eip'|'forwards_to'|'targets'|'can_access'|'notifies'|'origin';
  export interface GraphNode { arn: string; type: NodeType; id: string; name: string; accountId: string; region: string; attrs: Record<string, unknown> }
  export interface GraphEdge { src: string; dst: string; type: EdgeType }
  export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; dropped: number }
  export type QueryName = 'vpc'|'subnet'|'eni'|'instance'|'sg'|'sgRule'|'alb'|'nlb'|'clb'|'tg'|'rds'|'lambda'|'role'|'policy'|'nat'|'eip'|'ebs'|'s3'|'cloudfront';
  export type Row = Record<string, unknown>;
  export type Rows = Partial<Record<QueryName, Row[]>>;
  export interface BuildStats { builtAt: string; nodeCounts: Partial<Record<NodeType, number>>; edgeCount: number; dropped: number; warnings: string[] }
  export interface WalkNode extends GraphNode { depth: number }
  export interface WalkResult { nodes: WalkNode[]; truncated: boolean }
  export interface Neighborhood { center: GraphNode; nodes: Array<WalkNode & { side: 'center'|'dependent'|'dependency' }>; edges: GraphEdge[]; truncated: boolean }
  ```
- Produces (`queries.ts`): `export const GRAPH_QUERIES: Record<QueryName, string>`. It holds one SELECT per name, and each SELECT lists exactly the columns in the spec's relation table plus the node columns below. The `policy` query is `aws_iam_policy` with `is_aws_managed = false` and columns `arn, account_id, region, policy_std`.
- Produces (`nodes.ts`):
  - `export function buildNodes(rows: Rows): GraphNode[]`
  - `export interface NodeIndex { byArn(arn: string): GraphNode | undefined; byId(accountId: string, id: string): GraphNode | undefined; nodes: GraphNode[] }`
  - `export function buildIndex(nodes: GraphNode[]): NodeIndex`
  - `export function eniArn(partition: string, region: string, accountId: string, id: string): string`
  - Helpers exported for extractors: `asArray(v: unknown): unknown[]` (null or non-array → `[]`, JSON string → parsed array) and `str(v: unknown): string | undefined` (non-empty string or undefined).
- Produces (`sink.ts`): `export class EdgeSink { add(src: string | undefined, dst: string | undefined, type: EdgeType): void; result(): { edges: GraphEdge[]; dropped: number } }`. An undefined end counts one `dropped`. `src === dst` is ignored and not counted. Duplicate (src, dst, type) triples are kept once.

**Node mapping.** Name rule: `tags.Name`, then the natural name, then id.

| Query | type | arn | id | name / attrs |
|---|---|---|---|---|
| vpc | vpc | `arn` | `vpc_id` | attrs `{cidr: cidr_block, isDefault: is_default}` |
| subnet | subnet | `subnet_arn` | `subnet_id` | attrs `{cidr: cidr_block, az: availability_zone}` |
| eni | eni | `eniArn(partition, region, account_id, network_interface_id)` | `network_interface_id` | name falls back to `description`; attrs `{interfaceType: interface_type, status, privateIp: private_ip_address}` |
| instance | instance | `arn` | `instance_id` | attrs `{state: instance_state, instanceType: instance_type, privateIp: private_ip_address}` |
| sg | sg | `arn` | `group_id` | name `group_name`; attrs `{vpcId: vpc_id}` |
| alb, nlb, clb | lb | `arn` | `name` | attrs `{lbType: 'application'\|'network'\|'classic', scheme, dnsName: dns_name}` |
| tg | tg | `target_group_arn` | `target_group_name` | attrs `{targetType: target_type, port, protocol}` |
| rds | rds | `arn` | `db_instance_identifier` | attrs `{engine, class, status}` |
| lambda | lambda | `arn` | `name` | attrs `{runtime, state}` |
| role | role | `arn` | `name` | attrs `{path}` |
| nat | nat | `arn` | `nat_gateway_id` | attrs `{state}` |
| eip | eip | `arn` | `allocation_id` | name falls back to `public_ip`; attrs `{publicIp: public_ip}` |
| ebs | ebs | `arn` | `volume_id` | attrs `{size, volumeType: volume_type, state}` |
| s3 | s3 | `arn` | `name` | attrs `{}` |
| cloudfront | cloudfront | `arn` | `id` | name is `aliases[0]` or `domain_name`; attrs `{domainName: domain_name, enabled}` |

- `sgRule` and `policy` produce no nodes.
- Rows without an ARN or id are skipped.
- Every node except lambda gets `attrs.tags`: object, at most 50 keys, values truncated to 256 chars. Lambda never gets tags.
- Column-shape reference from the live server is in the SDD workspace file `columns.txt`. The controller passes its path.

- [ ] **Step 1: Write failing tests.**
  - `nodes.test.ts`, one test per row of the mapping table using one fixture row:
    - `buildNodes({instance:[{arn:'arn:aws:ec2:ap-northeast-2:111111111111:instance/i-1', instance_id:'i-1', instance_state:'running', instance_type:'t3.micro', private_ip_address:'10.0.0.5', tags:{Name:'web'}, account_id:'111111111111', region:'ap-northeast-2'}]})` equals one node with name `'web'` and `attrs.tags` `{Name:'web'}`.
    - The ENI ARN equals `'arn:aws:ec2:ap-northeast-2:111111111111:network-interface/eni-1'` when `partition:'aws'`.
    - A lambda row with `tags` produces no `attrs.tags`.
    - `byId('111111111111','i-1')` returns the node.
    - A row missing an id is skipped.
    - 60 tags are capped to 50.
  - `sink.test.ts` (in `nodes.test.ts` is fine):
    - `add(undefined,'b','in_vpc')` makes `dropped` equal 1.
    - A duplicate is kept once.
    - A self-loop is ignored.
  - `queries.test.ts`:
    - Every value in `GRAPH_QUERIES` starts with `SELECT` (case-insensitive) and contains no `$`.
    - Every query except `s3` contains `account_id` and `region`.
    - `lambda` does not match `/\btags\b/`.
    - All 19 `QueryName`s are present.
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph`. Expect FAIL (modules missing).
- [ ] **Step 3: Implement** the four files.
- [ ] **Step 4: Run** `npx vitest run src/lib/dep-graph`. Expect PASS. Then run `npx tsc --noEmit`. Expect clean.
- [ ] **Step 5: Commit** `feat(dep-graph): types, Steampipe queries, node builder, edge sink`.

### Task 2: Network and compute extractors

**Files:**
- Create: `src/lib/dep-graph/extract/network.ts`, `src/lib/dep-graph/extract/compute.ts`
- Test: `src/lib/dep-graph/__tests__/extract-network.test.ts`, `src/lib/dep-graph/__tests__/extract-compute.test.ts`

**Interfaces:**
- Consumes: `Rows`, `NodeIndex`, `EdgeSink`, `asArray`, `str` (Task 1).
- Produces:
  - `export function networkEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void` covers subnet→vpc, sg→vpc, sg→sg `allows_from`, eni→subnet, eni→sg, lb→eni (from the ELB description), eni-or-instance→eip, nat→subnet, nat→eni, nat→eip.
  - `export function computeEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void` covers instance→subnet, instance→sg, instance→role, instance→ebs `uses_volume`, instance→eni `uses_eni`, lambda→role, lambda→subnet, lambda→sg.

**Matching rules.** The spec table is authoritative; these rules make it exact.
- **ID references:** resolve with `ix.byId(row.account_id, id)` and use the resulting node's `arn`.
- **SG rules:** only rows with `is_egress === false` and a `referenced_group_id`. `src` is `group_id`, `dst` is `referenced_group_id`, both resolved in the rule row's account.
- **ELB ENI description:** match `/^ELB (app|net)\/([^/]+)\/([0-9a-f]+)$/`. Find the lb node whose ARN ends with `:loadbalancer/<app|net>/<name>/<id>` in the same account. The edge is `lb → eni` `uses_eni`.
- **EIP:** if `network_interface_id` is set, the edge is `eni → eip`. Otherwise, if `instance_id` is set, it is `instance → eip`. Otherwise there is no edge and nothing counts as dropped.
- **Instance → role:** collect the `instance_profile_arns` of every role row into a map from profile ARN to role ARN. Then look up `iam_instance_profile_arn`.
- **Lambda:** `role` is already an ARN, so use `ix.byArn`.
- **Missing values:** empty or null reference fields add nothing (not dropped). A reference that is set but resolves to no node calls `sink.add(..., undefined, ...)` and so counts as dropped.

- [ ] **Step 1: Write failing tests.** Use one fixture per relation from the list above. Each test builds nodes with `buildNodes`, runs the extractor, and asserts the exact `{src, dst, type}` is present. Also cover:
  - `groups: null` on an ENI adds no edges and does not throw.
  - Rows with `security_groups: '[{"GroupId":"sg-1"}]'` (a JSON string) still produce `uses_sg`.
  - An ENI description `'ELB app/my-alb/50dc6c495c0c9188'` links to an lb whose arn ends `loadbalancer/app/my-alb/50dc6c495c0c9188`.
  - An EIP with both `network_interface_id` and `instance_id` links the ENI only.
  - A subnet with an unknown `vpc_id` makes `dropped` equal 1.
  - The sg cycle fixture (A↔B) yields both `allows_from` edges.
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph`. Expect FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expect PASS and clean.
- [ ] **Step 5: Commit** `feat(dep-graph): network and compute relationship extractors`.

### Task 3: Delivery and IAM extractors, plus `extractGraph`

**Files:**
- Create: `src/lib/dep-graph/extract/delivery.ts`, `src/lib/dep-graph/extract/iam.ts`, `src/lib/dep-graph/extract/index.ts`
- Test: `src/lib/dep-graph/__tests__/extract-delivery.test.ts`, `src/lib/dep-graph/__tests__/extract-iam.test.ts`, `src/lib/dep-graph/__tests__/extract-index.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 (`networkEdges` and `computeEdges` signatures).
- Produces:
  - `export function deliveryEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void` covers lb→subnet, lb→sg, lb→tg, tg→instance, tg→lambda, tg→vpc, rds→subnet, rds→sg, s3→lambda, cloudfront→s3, cloudfront→lb.
  - `export function iamEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void` covers role→* `can_access`.
  - `export function policyResourceArns(doc: unknown): string[]` (pure). It returns Allow-statement Resource strings. It accepts a string or array `Resource`, and a `Statement` that is an object or an array.
  - `export function extractGraph(rows: Rows): GraphData` runs `buildNodes`, `buildIndex`, and all four extractors through one `EdgeSink`.

**Matching rules.**
- **lb → subnet:**
  - ALB and NLB: `availability_zones[].SubnetId`.
  - CLB: `subnets[]` strings.
- **lb → sg:** `security_groups[]` is a list of strings for every LB type.
- **lb → tg:** for each tg row, every ARN in `load_balancer_arns[]` gives `lb(arn) → tg`.
- **tg targets:**
  - `target_type === 'instance'`: `Target.Id` is an instance id, resolved with `byId`.
  - `target_type === 'lambda'`: `Target.Id` is an ARN, resolved with `byArn`.
  - `target_type === 'ip'` and `'alb'`: no edge.
- **rds → subnet:** `subnets[].SubnetIdentifier`.
- **rds → sg:** `vpc_security_groups[].VpcSecurityGroupId`.
- **s3 → lambda:** `event_notification_configuration.LambdaFunctionConfigurations[].LambdaFunctionArn`, resolved with `byArn`.
- **CloudFront origins:**
  - Lowercase `origins[].DomainName`.
  - S3 bucket: match `^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$` or `^(.+)\.s3-website[.-][a-z0-9-]+\.amazonaws\.com$`. Then find the s3 node with that `id` in any account (bucket names are global).
  - Otherwise, an lb whose `attrs.dnsName` lowercased equals the domain.
  - No match: no edge, not dropped. Custom origins are normal.
- **IAM:**
  - Documents per role: each `inline_policies_std[].PolicyDocument`, plus the `policy_std` of each `policy` row whose `arn` is in the role's `attached_policy_arns`.
  - For each resource ARN from `policyResourceArns`:
    1. If it contains `*` or `?`, first try the S3 rule: when it matches `^arn:aws[a-z-]*:s3:::([^/*?]+)\/`, use that bucket. Otherwise skip it.
    2. An exact `byArn` match makes an edge.
    3. Anything else is skipped and not dropped. Policies name many non-graph resources.
  - `Effect` other than `Allow` is ignored.
  - A null `policy_std` is ignored.

- [ ] **Step 1: Write failing tests.**
  - One fixture per relation.
  - `policyResourceArns({Statement:{Effect:'Allow',Resource:'arn:aws:s3:::b/*'}})` equals `['arn:aws:s3:::b/*']`.
  - A Deny statement is excluded.
  - An IAM resource `arn:aws:s3:::b/*` links to bucket `b`; `arn:aws:ec2:*:*:instance/*` adds nothing.
  - A CloudFront origin `'b.s3.ap-northeast-2.amazonaws.com'` links to bucket `b`; `'MY-ALB-1.ap-northeast-2.elb.amazonaws.com'` links to the lb with dnsName `my-alb-1.ap-northeast-2.elb.amazonaws.com`.
  - `extractGraph` on a fixture with every type returns nodes for all 15 types and at least one edge of every `EdgeType`.
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expect PASS and clean.
- [ ] **Step 5: Commit** `feat(dep-graph): delivery and IAM-policy extractors, extractGraph`.

### Task 4: PGlite store with recursive-CTE walks

**Files:**
- Modify: `package.json` (add dependency `"@electric-sql/pglite": "0.5.12"`, exact version) and `package-lock.json` (via `npm install @electric-sql/pglite@0.5.12 --save-exact`).
- Modify: `next.config.mjs`: add `'@electric-sql/pglite'` to `serverComponentsExternalPackages`.
- Create: `src/lib/dep-graph/store.ts`
- Test: `src/lib/dep-graph/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `GraphData`, `GraphNode`, `GraphEdge`, `BuildStats`, `WalkResult`, `Neighborhood`.
- Produces:
  ```ts
  export interface GraphStore {
    stats(): BuildStats;
    data(): GraphData;                       // the in-memory data it was loaded from (project engine input)
    node(arn: string): Promise<GraphNode | null>;
    nodeById(id: string, type?: NodeType): Promise<GraphNode | null>;
    search(q: string, opts?: { limit?: number; accountId?: string }): Promise<GraphNode[]>;
    hubs(opts?: { limit?: number; accountId?: string }): Promise<Array<GraphNode & { dependents: number }>>;
    impact(arn: string, depth?: number): Promise<WalkResult>;
    dependencies(arn: string, depth?: number): Promise<WalkResult>;
    neighborhood(arn: string, depth?: number): Promise<Neighborhood | null>;
    close(): Promise<void>;
  }
  export async function createGraphStore(data: GraphData, stats: BuildStats): Promise<GraphStore>;
  export function getCurrentStore(): GraphStore | null;
  export function setCurrentStore(next: GraphStore): void;  // swaps the pointer, then closes the previous store (errors swallowed)
  export const WALK_CAP = 300;
  export function clampDepth(v: unknown, def: number, max: number): number; // integer within 1..max, otherwise def
  ```
- The current-store holder lives on `globalThis.__awsopsDepGraph` (same pattern as `change-timeline/loop.ts`).

**SQL notes.**
- Create the schema exactly as in the spec.
- Bulk load with one parameter each:
  ```sql
  insert into nodes select * from json_to_recordset($1::json) as x(arn text, type text, id text, name text, account_id text, region text, attrs jsonb)
  ```
  Insert edges the same way, with `on conflict do nothing`. Edges whose ends are missing from nodes are filtered before insert.
- Walk shape for `impact` (`dependencies` swaps src and dst):
  ```sql
  with recursive walk(arn, depth) as (
    select $1::text, 0
    union
    select e.src_arn, w.depth + 1 from edges e join walk w on e.dst_arn = w.arn where w.depth < $2
  )
  select n.*, min(w.depth) as depth from walk w join nodes n on n.arn = w.arn
  where w.arn <> $1 group by n.arn order by depth, n.type, n.name limit 301
  ```
  301 rows means `truncated`; return the first 300.
- `neighborhood` runs both walks with the clamped depth (max 3). A node found by both keeps the smaller depth; on a tie it becomes `dependent`. Cap the total at 300 (dependents first, then dependencies, each by depth). Return every edge whose two ends are both in the returned set (center included).
- `search`: `ILIKE` with the pattern built in JS by escaping `%`, `_` and `\` and wrapping in `%…%`, passed as a parameter. Match on name, id or arn. Order exact id/name matches first, then by name.
- `hubs`: count incoming edges per dst, ordered by count desc then name.
- A walk on an unknown ARN returns `{nodes: [], truncated: false}`. `neighborhood` returns `null`.

- [ ] **Step 1: Write failing tests** against a real PGlite. Create one store per `describe` in `beforeAll` and call `close()` in `afterAll`.
  - Chain `lb→tg→instance→subnet→vpc`: `impact(vpc, 3)` returns subnet at depth 1, instance at 2 and tg at 3 (not lb); `impact(vpc, 4)` adds lb at 4.
  - `dependencies(lb, 6)` reaches vpc at depth 4.
  - SG cycle A↔B plus instance→A: `impact(A, 6)` returns B at depth 1 and the instance at depth 1, and terminates.
  - Star of 350 subnets `in_vpc` one vpc: `impact(vpc,1)` returns 300 nodes with `truncated: true`.
  - `neighborhood(instance, 1)`: sides are tg `dependent`, subnet `dependency`, center `center`; edges contain `tg→instance` and `instance→subnet`.
  - `search('WEB')` finds name `web-1`. `search('100%')` does not throw and matches only a literal `%`.
  - `hubs()[0]` is the vpc in the star fixture with `dependents` equal 350.
  - `clampDepth('7', 3, 6)` returns 3; `clampDepth(2, 3, 6)` returns 2; `clampDepth(2.5, 3, 6)` returns 3.
  - `setCurrentStore(b)` after `a` makes `getCurrentStore()` return `b`, and closes `a` (a later query on `a` rejects).
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph/__tests__/store.test.ts`. Expect FAIL.
- [ ] **Step 3: Install, configure and implement.**
- [ ] **Step 4: Run** the store tests and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit** `feat(dep-graph): PGlite store with recursive-CTE impact walks`.

### Task 5: Build, snapshot and loop

**Files:**
- Create: `src/lib/dep-graph/build.ts`, `src/lib/dep-graph/loop.ts`
- Modify: `src/instrumentation.ts`: start the loop after the change-timeline block, wrapped in try/catch with the same shape.
- Test: `src/lib/dep-graph/__tests__/build.test.ts`

**Interfaces:**
- Consumes: `GRAPH_QUERIES`, `extractGraph`, `createGraphStore`, `setCurrentStore`, `getCurrentStore`, `batchQuery` from `@/lib/steampipe`.
- Produces:
  ```ts
  export type BatchRunner = (q: Record<string, string>) => Promise<Record<string, { rows: unknown[]; error?: string }>>;
  export async function collectRows(run?: BatchRunner): Promise<{ rows: Rows; warnings: string[] }>; // warnings = query names whose result had an error
  export function statsFor(data: GraphData, warnings: string[], now?: Date): BuildStats;
  export async function rebuildGraph(deps?: { run?: BatchRunner; snapshotPath?: string; now?: Date }): Promise<BuildStats>;
  export async function loadSnapshot(path?: string): Promise<boolean>;   // true when a store was created from the file
  export async function ensureGraph(deps?: { snapshotPath?: string; rebuild?: () => Promise<unknown> }): Promise<GraphStore | null>;
  export const SNAPSHOT_PATH: string; // path.join(process.cwd(), 'data/graph/latest.json')
  ```
  - `ensureGraph` order:
    1. Return the current store if there is one.
    2. Otherwise try `loadSnapshot`.
    3. Otherwise start `rebuild` once (fire-and-forget, guarded by a module-level in-flight promise) and return `null`.
  - `loop.ts` exports `ensureDepGraphStarted(): void` and `tick(): Promise<void>`. It uses `globalThis.__awsopsDepGraphLoop`, first run after 60 000 ms, then every 900 000 ms, `unref()` on timers, and production only. `tick` never overlaps and logs only error names.
  - The snapshot file is `{ version: 1, stats: BuildStats, data: GraphData }`. `loadSnapshot` rejects other versions and malformed files, returning false.

- [ ] **Step 1: Write failing tests.**
  - A fake `run` returns rows for vpc and subnet, and `{rows: [], error: 'denied'}` for `policy`. `rebuildGraph` then:
    - has `warnings` equal `['policy']`
    - has `nodeCounts` `{vpc:1, subnet:1}` and `edgeCount` 1
    - writes the snapshot to a temp dir
    - sets the current store
  - `loadSnapshot` on that file recreates a store whose `stats().builtAt` matches.
  - `loadSnapshot` on `{version: 2}` returns false.
  - `ensureGraph` with no store and no snapshot calls `rebuild` exactly once across two calls in a row, and returns `null` both times.
  - Not throwing: `run` that rejects entirely makes `rebuildGraph` reject. The loop's `tick` catches it, which you can test by calling `tick` with a mocked module (`vi.mock('../build')`).
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph`. Expect FAIL.
- [ ] **Step 3: Implement.** Write the snapshot with `fs.promises.mkdir(dir, {recursive:true})`, then `writeFile(tmp)`, then `rename`.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit** `feat(dep-graph): build from Steampipe, JSON snapshot, background loop`.

### Task 6: Project cleanup preview engine

**Files:**
- Create: `src/lib/dep-graph/project.ts`
- Test: `src/lib/dep-graph/__tests__/project.test.ts`

**Interfaces:**
- Consumes: `GraphData`, `GraphNode`.
- Produces:
  ```ts
  export type ProjectSeed = { kind: 'tag'; key: string; value: string } | { kind: 'prefix'; prefix: string } | { kind: 'vpc'; arn: string };
  export interface ProjectPreview {
    seedCount: number;
    members: GraphNode[];
    order: Array<{ step: number; arns: string[]; cycle: boolean }>;
    blockers: Array<{ node: GraphNode; uses: string[] }>;  // outside nodes and the member arns they use
    shared: GraphNode[];
  }
  export function previewProject(data: GraphData, seed: ProjectSeed, opts?: { accountId?: string }): ProjectPreview;
  ```

**Algorithm.** Follow spec §2 "프로젝트 정리 미리보기" exactly.
- **Seed matching:**
  - Tag: `attrs.tags[key] === value`.
  - Prefix: `name` starts with the prefix, case-sensitive.
  - VPC: the vpc node plus every node that reaches it by reverse BFS, unbounded depth, visited set.
  - With `accountId`, keep only seeds from that account.
- **Closure:** loop until no change. For each forward dependency `d` of a member that is not a member, add `d` when every node with an edge into `d` is already a member.
- **`shared`:** forward dependencies of members that stayed out.
- **`blockers`:** non-members with an edge into a member.
- **Order:**
  1. Run Tarjan SCC on member-only edges.
  2. Order SCCs so a node comes before the nodes it depends on. Use Kahn's algorithm on the condensation, starting from SCCs with no member dependents.
  3. Each SCC becomes one step. `cycle` is true when the SCC size is above 1.
  4. Within a step, sort arns.

- [ ] **Step 1: Write failing tests.**
  - Prefix `moyeota-` on fixture `instance moyeota-a → sg moyeota-sg`, `instance other → sg moyeota-sg`, `moyeota-a → subnet s`:
    - members are `moyeota-a` and `moyeota-sg`
    - `blockers` is `other` (uses `moyeota-sg`)
    - `shared` is subnet s, because another node also uses it. Add `instance other → subnet s` to the fixture for this.
    - order step 1 is `moyeota-a`, step 2 is `moyeota-sg`
  - Exclusively owned: `instance moyeota-a → ebs v` (no other user) puts `v` in members, after the instance.
  - VPC seed: the vpc plus subnet plus instance in it are all members, ordered instance, subnet, vpc.
  - Cycle: members sg A↔B give one step with `cycle: true` and both arns.
  - Tag seed: `{kind:'tag', key:'Project', value:'x'}` matches only nodes with that tag.
  - An empty seed gives empty members, order, blockers and shared.
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph/__tests__/project.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS, and `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(dep-graph): read-only project cleanup preview engine`.

### Task 7: `/api/graph` route

**Files:**
- Create: `src/lib/dep-graph/api.ts` (pure request parsing and dispatch), `src/app/api/graph/route.ts` (thin)
- Test: `src/lib/dep-graph/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `clampDepth`, `previewProject`, `ensureGraph`.
- Produces:
  ```ts
  export type GraphRequest =
    | { op: 'stats' } | { op: 'hubs'; accountId?: string } | { op: 'search'; q: string; accountId?: string }
    | { op: 'neighborhood' | 'impact' | 'deps'; arn: string; depth: number }
    | { op: 'project'; seed: ProjectSeed; accountId?: string };
  export function parseGraphRequest(p: URLSearchParams): GraphRequest | { error: string };
  export async function handleGraphRequest(req: GraphRequest, store: GraphStore | null): Promise<{ status: number; body: unknown }>;
  ```
- **Validation:** follow the spec's API section.
  - `accountId` must match `/^\d{12}$/`, otherwise it is ignored.
  - Exactly one of `tag`, `prefix` or `vpc` must be present for `project`.
  - A parse error is `400 {error}`, with a Korean message.
- **Responses:**
  - `store === null` gives `200 {status:'building'}`.
  - Every success body includes `builtAt: store.stats().builtAt`.
  - An unknown arn for `neighborhood`, `impact` or `deps` gives `404 {error:'not-found', builtAt}`.
  - Success bodies:
    - `stats`: `{status:'ready', stats}`
    - `hubs`: `{builtAt, hubs}`
    - `search`: `{builtAt, results}`
    - `neighborhood`: `{builtAt, ...Neighborhood}`
    - `impact` / `deps`: `{builtAt, ...WalkResult}`
    - `project`: `{builtAt, ...ProjectPreview}`
- **Route:** `export const dynamic = 'force-dynamic'`, `export const runtime = 'nodejs'`. `GET` parses the request, awaits `ensureGraph()`, calls `handleGraphRequest`, and returns `NextResponse.json(body, {status})`. On a thrown error it returns `500 {error: name}`.

- [ ] **Step 1: Write failing tests** for `parseGraphRequest`:
  - Unknown op is an error.
  - `arn` not starting with `arn:` is an error.
  - `depth=9` for impact becomes 3; `depth=9` for neighborhood becomes 2.
  - `tag=Project=x` parses as key `Project`, value `x`. `tag=noequals` is an error. Both `tag` and `prefix` together is an error.
  - A `q` over 100 chars is an error.
  - `accountId=abc` is dropped.

  For `handleGraphRequest`, use a real store from a small `GraphData` fixture:
  - A null store returns `building`.
  - An unknown arn returns 404.
  - `impact` returns 200 with `builtAt`.
  - `project` prefix returns members.
- [ ] **Step 2: Run** the tests. Expect FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit** `feat(dep-graph): read-only /api/graph route`.

### Task 8: `/dependency-graph` page

**Files:**
- Create: `src/components/dep-graph/layout.ts` (pure), `src/components/dep-graph/DepGraphView.tsx`, `src/components/dep-graph/GraphCanvas.tsx`, `src/components/dep-graph/ImpactPanel.tsx`, `src/components/dep-graph/ProjectPreviewPanel.tsx`, `src/components/dep-graph/CLAUDE.md`
- Create: `src/app/dependency-graph/page.tsx`
- Modify: `src/components/layout/Sidebar.tsx`: add `{ labelKey: 'sidebar.depGraph', href: '/dependency-graph', icon: Share2 }` right after the topology entry in `sidebar.networkCdn`, importing `Share2` from lucide-react.
- Modify: `src/lib/i18n/translations/{ko,en,zh}.json`: add `sidebar.depGraph` and the `depGraph.*` keys.
- Test: `src/components/dep-graph/__tests__/layout.test.ts`

**Interfaces:**
- Consumes: the `/api/graph` response shapes from Task 7; types from `@/lib/dep-graph/types` (types only, never import the store into client code).
- Produces:
  - `export function layoutNeighborhood(nb: { nodes: Array<{arn:string; type:string; name:string; depth:number; side:'center'|'dependent'|'dependency'}> }): Record<string, { x: number; y: number }>`
    - The x column is `0` for the center, `-depth*260` for dependents and `+depth*260` for dependencies.
    - Within a column, sort by type then name. `y = i*80 - (count-1)*40`.
  - `export const TYPE_COLORS: Record<NodeType, string>`, using only theme accents: cyan `#00d4ff`, green `#00ff88`, purple `#a855f7`, orange `#f59e0b`, red `#ef4444`, plus gray `#6b7280`.

**Behaviour.** Follow the spec's 화면 section.
- **Header:** use `Header` from `@/components/layout/Header`. Show the build line `depGraph.builtAgo` with `{minutes}`, plus node and edge counts.
- **Tab 관계 보기:**
  - The search box calls `/api/graph?op=search&q=` (debounced 300 ms) and shows a results dropdown.
  - With no selection, show hub cards (`op=hubs`).
  - Selecting a node fetches `neighborhood` with the depth select (1/2/3, default 2), and fetches `impact` and `deps` at depth 3 for the panel.
  - The React Flow canvas uses `layoutNeighborhood` positions, coloured node boxes like `src/app/topology/page.tsx`'s `makeNode`, and edge labels `t('depGraph.edge.<type>')`.
  - Clicking a node re-centres on it.
  - `truncated` shows `depGraph.truncated` ("일부만 보여요 (최대 300개)").
- **Tab 프로젝트 정리 미리보기:**
  - Seed form: a radio for tag, prefix or VPC. VPC choices come from `op=search` filtered to type vpc, or a text field for the arn.
  - Results: ordered steps list, blockers, shared, and the always-visible `depGraph.project.notice` ("안내만 해요 — 실제로 지우지 않아요").
- **States:**
  - `status:'building'` shows `depGraph.building` and retries every 10 s.
  - Errors show `depGraph.error`.
- Pass `accountId: currentAccountId` from `useAccountContext()` on `search`, `hubs` and `project` calls.
- **i18n keys:** at minimum, `title`, `subtitle`, `builtAgo`, `building`, `error`, `searchPlaceholder`, `hubs`, `depth`, `tabRelations`, `tabProject`, `impactTitle` ("이걸 바꾸거나 지우면 영향 받는 리소스 {count}개"), `depsTitle` ("이 리소스가 쓰는 것 {count}개"), `truncated`, `edge.<each EdgeType>`, `type.<each NodeType>`, `project.notice`, `project.order`, `project.blockers`, `project.shared`, `project.seedTag`, `project.seedPrefix`, `project.seedVpc`, `project.run`, `project.empty`.

- [ ] **Step 1: Write failing tests** for `layoutNeighborhood`:
  - The center is at `{x:0}`.
  - A depth-2 dependent is at `x:-520`.
  - Two dependency nodes at depth 1 get y `-40` and `40`, sorted by type then name.
  - Every input arn has a position.
- [ ] **Step 2: Run** `npx vitest run src/components/dep-graph`. Expect FAIL.
- [ ] **Step 3: Implement** the layout, components, page, sidebar and i18n. Add an i18n parity check to the test: every `depGraph.*` key in ko.json exists in en.json and zh.json.
- [ ] **Step 4: Run** `npx vitest run src/components/dep-graph`, `npx tsc --noEmit` and `npx next build`. Expect PASS, clean, and a successful build that lists the route `/dependency-graph`.
- [ ] **Step 5: Commit** `feat(dep-graph): /dependency-graph page with React Flow view and cleanup preview`.

### Task 9: Safe-AI-actions card integration

**Files:**
- Create: `src/lib/dep-graph/summary.ts`
- Modify: `src/lib/action-plan/types.ts` (add `graphImpact?` to `ActionRequest`), `src/lib/action-plan/handle.ts` (fill it at plan time), `src/lib/action-plan/cards.ts` (`blastLines` adds the line)
- Test: `src/lib/dep-graph/__tests__/summary.test.ts`, and extend `src/lib/action-plan/__tests__/cards.test.ts` (or the existing card test file)

**Interfaces:**
- Produces:
  - `export interface GraphImpact { count: number; sample: string[]; builtAt: string }`, exported from `src/lib/dep-graph/types.ts` (append it there).
  - `export async function impactSummary(resourceId: string, store?: GraphStore | null): Promise<GraphImpact | null>` in `summary.ts`.
    - It uses `store ?? getCurrentStore()` and never triggers a build.
    - It runs `nodeById(resourceId)`, then `impact(arn, 2)`.
    - It counts nodes whose type is not `eni`.
    - `sample` is the first 3 names, ordered by type priority `instance, lb, rds, lambda, nat, sg, tg`, then everything else, then by name.
    - It returns `null` when there is no store, the node is unknown, or anything throws.
  - `ActionRequest.graphImpact?: Record<string, GraphImpact>`, keyed by security-group id.
- **handle.ts:** right after the plan-time snapshot is built, compute `impactSummary(sgId)` for every distinct target id of `sg.*` steps. Store only non-null values. This is informational and must not change policy evaluation or control flow. Wrap it so an exception leaves `graphImpact` undefined.
- **cards.ts `blastLines`:** after each SG's existing line, if `req.graphImpact?.[id]` exists, append:
  `• 그래프로 본 영향(${minutes}분 전 기준): 이 보안그룹을 쓰는 리소스 ${count}개${sample.length ? ` — ${sample.join(', ')}` : ''}${count > sample.length ? ` 외 ${count - sample.length}개` : ''}`
  - `minutes = Math.max(0, Math.round((Date.now() - Date.parse(builtAt)) / 60000))`.
  - Pass names through the existing `safeName` helper.

- [ ] **Step 1: Write failing tests.**
  - `impactSummary('sg-1', store)` on a fixture (sg ← eni ← instance web, sg ← lb alb, sg ← eni2) returns `{count: 2, sample: ['web','alb'], builtAt}`.
  - An unknown id returns `null`. A `null` store returns `null`.
  - The card test: a request with `graphImpact: {'sg-1': {count:4, sample:['a','b','c'], builtAt: <now minus 5 min>}}` contains `그래프로 본 영향(5분 전 기준): 이 보안그룹을 쓰는 리소스 4개 — a, b, c 외 1개`. Without `graphImpact` there is no `그래프로 본 영향` text.
  - The existing action-plan tests stay green. The policy tests must not change.
- [ ] **Step 2: Run** `npx vitest run src/lib/dep-graph src/lib/action-plan`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` (full suite) and `npx tsc --noEmit`. Expect all PASS.
- [ ] **Step 5: Commit** `feat(action-plan): show graph-based impact line on SG cards`.

### Task 10: Docs, ADR-012, CLAUDE.md sync

**Files:**
- Create: `docs/decisions/012-dependency-graph-postgres-cte.md`, `src/lib/dep-graph/CLAUDE.md`
- Modify: root `CLAUDE.md`, `src/lib/CLAUDE.md`, `src/app/CLAUDE.md`, `src/components/CLAUDE.md`, `src/lib/action-plan/CLAUDE.md` (one line on `graphImpact`)

**Content requirements:**
- **ADR-012**, Korean then English in the repo's ADR style (copy the structure of `docs/decisions/011-*.md`).
  - Context: relationships are scattered.
  - Decision: an edges table plus recursive CTE in PGlite.
  - The trade-off table must compare **Postgres recursive CTE (PGlite) vs Neo4j vs writing into Steampipe's Postgres vs in-memory JS graph** across:
    - query expressiveness (Cypher variable-length paths vs CTE)
    - operations (a new server or container vs none)
    - cost
    - testability in vitest
    - consistency with existing stack skills (SQL)
    - scale ceiling (fine for thousands of nodes; Neo4j wins at millions and for deep pattern queries)
  - Consequences: up to 15 minutes stale, display only, policy stays live.
  - When to revisit: more than 100k edges or multi-hop pattern matching needs.
- **`src/lib/dep-graph/CLAUDE.md`:** the role, every file, the direction rule, the relation table summary, the "guidance only, never writes" rule, the loop timings, the snapshot path, and how to add a new extractor. Korean section, then English.
- **Root `CLAUDE.md`:**
  - Stats: pages 44→45, API routes 27→28, routes 71→73, ADRs 11→12 (001-012), and components count +5.
  - Add the `dep-graph/` key-file bullet in both the Korean and the English halves.
  - Add `graph/route.ts` to the API list in both halves.
- **`src/app/CLAUDE.md`:** add `/dependency-graph` and `/api/graph`.
- **`src/components/CLAUDE.md`:** add `dep-graph/`.

- [ ] **Step 1: Write** the docs.
- [ ] **Step 2: Verify** with `npx vitest run`, `npx tsc --noEmit` and `npx next build`. Expect all green.
- [ ] **Step 3: Commit** `docs(dep-graph): ADR-012, CLAUDE.md sync`.
