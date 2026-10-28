// Plan-time snapshot: re-read every target once (state/tags, SG rules and blast radius).
// 계획 시점 스냅샷: 대상마다 지금 상태를 한 번씩 읽는다.
import type { Ec2Reader, ResolvedStep, ResourceSnapshot, Snapshot } from './types';

/** A target is missing or no longer carries awsops:control=allow. Message carries the id only. */
export class SnapshotError extends Error {
  constructor(public readonly resourceId: string, reason: 'missing' | 'untagged') {
    super(reason === 'missing' ? `대상을 찾을 수 없어요: ${resourceId}` : `허용 태그가 없어요: ${resourceId}`);
    this.name = 'SnapshotError';
  }
}

export async function takeSnapshot(steps: ResolvedStep[], r: Ec2Reader): Promise<Snapshot> {
  const targets = new Map<string, ResolvedStep['target']>();
  for (const s of steps) if (!targets.has(s.target.id)) targets.set(s.target.id, s.target);

  const snap: Snapshot = {};
  for (const t of Array.from(targets.values())) {
    const res = t.type === 'instance' ? await r.describeInstance(t.id) : await r.describeSecurityGroup(t.id);
    if (!res) throw new SnapshotError(t.id, 'missing');
    if (res.tags['awsops:control'] !== 'allow') throw new SnapshotError(t.id, 'untagged');
    const entry: ResourceSnapshot = { type: res.type, id: res.id, name: res.name, tags: { ...res.tags } };
    if (res.type === 'instance') {
      entry.state = res.state;
    } else {
      entry.ingress = await r.listIngressRules(t.id);
      const users = await r.listEniUsers(t.id);
      entry.eniCount = users.eniCount;
      entry.attachedInstances = users.instances;
    }
    snap[t.id] = entry;
  }
  return snap;
}
