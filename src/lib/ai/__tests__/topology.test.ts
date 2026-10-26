// topologyContent pins current output / 현재 출력을 고정한다
import { describe, it, expect } from 'vitest';
import { topologyContent } from '../topology';

const vpcs = [
  { vpc_id: 'vpc-1', name: 'main', cidr: '10.0.0.0/16' },
  { vpc_id: 'vpc-2', name: null, cidr: '10.1.0.0/16' },
];

describe('topologyContent', () => {
  it('error, English and Korean', () => {
    expect(topologyContent(null, [], true, 'boom')).toBe('Could not load the VPC list (boom). Please open the Topology View tab directly: [/topology-view](/topology-view)');
    expect(topologyContent(null, [], false, 'boom')).toBe('VPC 목록을 불러오지 못했습니다 (boom). 토폴로지뷰 탭에서 직접 확인해주세요: [/topology-view](/topology-view)');
  });
  it('resolved VPC, English', () => {
    const p = { vpcId: 'vpc-1', vpcName: 'main', vpcCidr: '10.0.0.0/16', includeEmpty: false };
    expect(topologyContent(p, vpcs, true)).toBe('Prepared the AWSops topology for **main** (10.0.0.0/16).\n\n➡️ [Open Topology View](/topology-view?vpc=vpc-1)');
  });
  it('resolved VPC with empty subnets, Korean', () => {
    const p = { vpcId: 'vpc-1', vpcName: 'main', vpcCidr: null, includeEmpty: true };
    expect(topologyContent(p, vpcs, false)).toBe('**main** () AWSops 토폴로지를 준비했습니다. 빈 서브넷도 포함했습니다.\n\n➡️ [토폴로지뷰 열기](/topology-view?vpc=vpc-1&empty=1)');
  });
  it('lists VPCs when none resolved', () => {
    const out = topologyContent({ vpcId: null, vpcName: null, vpcCidr: null, includeEmpty: false }, vpcs, true);
    expect(out).toContain('Multiple VPCs found');
    expect(out).toContain('| main | `vpc-1` | 10.0.0.0/16 | [Open](/topology-view?vpc=vpc-1) |');
    expect(out).toContain('| - | `vpc-2` | 10.1.0.0/16 | [Open](/topology-view?vpc=vpc-2) |');
    expect(topologyContent(null, vpcs, false)).toContain('여러 VPC가 있습니다');
  });
});
