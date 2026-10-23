// Idle Resource Scanner Collector
// 유휴/미사용 AWS 리소스 스캔 컬렉터: Steampipe SQL로 낭비 리소스 탐지
import { runQuery } from '@/lib/steampipe';
import {
  SQL_UNATTACHED_EBS, SQL_GP2_VOLUMES, SQL_UNASSOCIATED_EIPS, SQL_STOPPED_INSTANCES,
  SQL_OLD_SNAPSHOTS, SQL_UNUSED_SECURITY_GROUPS,
} from '@/lib/queries/idle-resources';
import { priceEbs, priceSnapshot, pricePublicIp } from '@/lib/cost-radar/pricing';
import type { Collector, CollectorResult, SendFn } from './types';

// ============================================================================
// Cost estimation helpers (Cost Radar price table, so numbers match the Cost Radar page)
// ============================================================================

const numOrNull = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

interface IdleCategory {
  key: string;
  label: string;
  sql: string;
  /** Whether to wrap in try/catch for potentially slow queries */
  fragile?: boolean;
  /** Estimate monthly cost for a single row */
  estimateCost: (row: Record<string, any>) => number;
  costLabel: string;
}

const IDLE_CATEGORIES: IdleCategory[] = [
  {
    key: 'unattachedEbs',
    label: 'Unattached EBS Volumes',
    sql: SQL_UNATTACHED_EBS,
    estimateCost: (row) => priceEbs({ volumeType: String(row.volume_type), sizeGb: Number(row.size) || 0, iops: numOrNull(row.iops), region: String(row.region) }).monthly ?? 0,
    costLabel: 'Cost Radar price table (by volume type)',
  },
  {
    key: 'gp2Volumes',
    label: 'Previous-gen EBS (gp2)',
    sql: SQL_GP2_VOLUMES,
    estimateCost: (row) => (priceEbs({ volumeType: 'gp2', sizeGb: Number(row.size) || 0, region: String(row.region) }).monthly ?? 0) * 0.2, // 20% saving
    costLabel: '20% of gp2 cost saved if migrated to gp3',
  },
  {
    key: 'unassociatedEips',
    label: 'Unassociated Elastic IPs',
    sql: SQL_UNASSOCIATED_EIPS,
    estimateCost: (row) => pricePublicIp({ region: String(row.region) }).monthly ?? 0,
    costLabel: 'public IPv4 hourly rate x 730h each',
  },
  {
    key: 'stoppedInstances',
    label: 'Stopped EC2 Instances',
    sql: SQL_STOPPED_INSTANCES,
    estimateCost: () => 0,
    costLabel: '$0 direct (RI waste risk)',
  },
  {
    key: 'oldSnapshots',
    label: 'Old EBS Snapshots (90+ days)',
    sql: SQL_OLD_SNAPSHOTS,
    estimateCost: (row) => priceSnapshot({ sizeGb: Number(row.volume_size) || 0, region: String(row.region) }).monthly ?? 0,
    costLabel: 'snapshot GB-month rate (upper bound)',
  },
  {
    key: 'unusedSecurityGroups',
    label: 'Unused Security Groups',
    sql: SQL_UNUSED_SECURITY_GROUPS,
    fragile: true,
    estimateCost: () => 0,
    costLabel: '$0 (security hygiene)',
  },
];

// ============================================================================
// Collector implementation
// ============================================================================

interface CategoryResult {
  key: string;
  label: string;
  rows: Record<string, any>[];
  count: number;
  estimatedMonthlyCost: number;
  costLabel: string;
  error?: string;
}

const idleScanCollector: Collector = {
  displayName: 'Idle Resource Scanner',

  async collect(send: SendFn, accountId?: string, isEn?: boolean): Promise<CollectorResult> {
    send('status', { step: 'idle-start', message: isEn
      ? '🔍 Scanning for idle and unused AWS resources...'
      : '🔍 유휴 및 미사용 AWS 리소스 스캔 중...' });

    const queryOpts = accountId ? { accountId } : undefined;

    // Run all 6 queries in parallel
    const results = await Promise.allSettled(
      IDLE_CATEGORIES.map(async (cat) => {
        const result = await runQuery(cat.sql, queryOpts);
        return { cat, result };
      })
    );

    const categories: CategoryResult[] = [];
    let totalMonthlyCost = 0;
    let totalIdleCount = 0;
    const usedTools: string[] = [];
    const queriedResources: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const cat = IDLE_CATEGORIES[i];

      if (r.status === 'fulfilled' && r.value.result.rows && !r.value.result.error) {
        const rows = r.value.result.rows;
        const monthlyCost = rows.reduce((sum: number, row: Record<string, any>) => sum + cat.estimateCost(row), 0);

        categories.push({
          key: cat.key,
          label: cat.label,
          rows,
          count: rows.length,
          estimatedMonthlyCost: monthlyCost,
          costLabel: cat.costLabel,
        });

        totalMonthlyCost += monthlyCost;
        totalIdleCount += rows.length;

        if (rows.length > 0) {
          usedTools.push(`Steampipe: ${cat.label} (${rows.length})`);
          queriedResources.push(cat.key);
        }

        send('status', { step: `idle-${cat.key}`, message: isEn
          ? `✅ ${cat.label}: ${rows.length} found${monthlyCost > 0 ? ` (~$${monthlyCost.toFixed(2)}/mo)` : ''}`
          : `✅ ${cat.label}: ${rows.length}건${monthlyCost > 0 ? ` (~$${monthlyCost.toFixed(2)}/월)` : ''}` });
      } else {
        const errMsg = r.status === 'rejected'
          ? String(r.reason)
          : r.value.result.error || 'unknown error';

        categories.push({
          key: cat.key,
          label: cat.label,
          rows: [],
          count: 0,
          estimatedMonthlyCost: 0,
          costLabel: cat.costLabel,
          error: errMsg,
        });

        send('status', { step: `idle-${cat.key}-err`, message: isEn
          ? `⚠️ ${cat.label}: query failed`
          : `⚠️ ${cat.label}: 쿼리 실패` });
      }
    }

    send('status', { step: 'idle-done', message: isEn
      ? `🏁 Scan complete: ${totalIdleCount} idle resources, ~$${totalMonthlyCost.toFixed(2)}/mo estimated waste`
      : `🏁 스캔 완료: 유휴 리소스 ${totalIdleCount}건, ~$${totalMonthlyCost.toFixed(2)}/월 예상 낭비` });

    return {
      sections: { categories, totalMonthlyCost, totalIdleCount },
      usedTools,
      queriedResources,
      viaSummary: `Idle Resource Scanner (${totalIdleCount} idle, ~$${totalMonthlyCost.toFixed(0)}/mo)`,
    };
  },

  formatContext(data: CollectorResult): string {
    const { categories, totalMonthlyCost, totalIdleCount } = data.sections as {
      categories: CategoryResult[];
      totalMonthlyCost: number;
      totalIdleCount: number;
    };

    if (totalIdleCount === 0 && categories.every(c => c.count === 0 && !c.error)) {
      return '\n\n--- IDLE RESOURCE SCAN: No idle resources found ---';
    }

    const sections: string[] = [];

    // Summary table
    sections.push('## Idle Resource Summary');
    sections.push('| Category | Count | Est. Monthly Cost | Note |');
    sections.push('|----------|------:|------------------:|------|');
    for (const cat of categories) {
      if (cat.error) {
        sections.push(`| ${cat.label} | - | - | Query failed |`);
      } else {
        sections.push(`| ${cat.label} | ${cat.count} | $${cat.estimatedMonthlyCost.toFixed(2)} | ${cat.costLabel} |`);
      }
    }
    sections.push(`| **TOTAL** | **${totalIdleCount}** | **$${totalMonthlyCost.toFixed(2)}** | |`);

    // Per-category details
    for (const cat of categories) {
      if (cat.count === 0) continue;
      sections.push(`\n### ${cat.label} (${cat.count})`);
      sections.push(`\`\`\`json\n${JSON.stringify(cat.rows.slice(0, 50), null, 2)}\n\`\`\``);
    }

    return '\n\n--- IDLE RESOURCE SCAN DATA (collected automatically) ---\n' + sections.join('\n');
  },

  analysisPrompt: `You are an AWS FinOps expert analyzing idle and unused resources.
You have been given REAL data from Steampipe scans of the user's AWS account.

## Analysis Structure

### 1. Executive Summary
- Total estimated monthly waste from idle resources
- Number of idle resources by category
- Quick wins (easy to clean up)

### 2. High Priority (Immediate Action)
- Unattached EBS volumes (wasting money right now)
- Unassociated Elastic IPs ($3.60/month each)
- Old snapshots consuming storage

### 3. Medium Priority (Review Needed)
- Stopped EC2 instances (may have associated EBS, RI waste)
- gp2 -> gp3 migration candidates (cost + performance improvement)

### 4. Low Priority (Hygiene)
- Unused security groups (security posture improvement)

### 5. Remediation Commands
For each finding, provide specific AWS CLI commands:
- \`aws ec2 delete-volume --volume-id vol-xxx\`
- \`aws ec2 release-address --allocation-id eipalloc-xxx\`
- \`aws ec2 modify-volume --volume-type gp3 --volume-id vol-xxx\`

## Rules
- Calculate savings using the cost estimates provided
- Group by account_id if multi-account
- Flag any resources with tags suggesting they may still be needed
- Always respond in the SAME LANGUAGE as the user's question
- Use tables for easy scanning`,
};

export default idleScanCollector;
