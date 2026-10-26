import type { ChangeRecord } from '../types';

export const rec = (id: string, time: string, over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  id, eventId: id, eventName: 'RunInstances', accountId: '111111111111', region: 'ap-northeast-2', time,
  kind: 'create', resourceType: 'ec2-instance', resourceId: `i-${id}`, resourceName: `name-${id}`,
  actor: { kind: 'person', name: 'sungyoon' }, tool: 'console', ...over,
});
