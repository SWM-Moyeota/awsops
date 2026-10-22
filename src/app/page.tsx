'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import SystemHealthCard from '@/components/dashboard/SystemHealthCard';
import PieChartCard from '@/components/charts/PieChartCard';
import BarChartCard from '@/components/charts/BarChartCard';
import {
  Server, Database, DollarSign, Box, Shield, Network,
  Bell, ShieldCheck, AlertTriangle, Zap, Table,
  FileSearch, Globe, Package, HardDrive, Radio, Search, RefreshCw,
} from 'lucide-react';
import { queries as ec2Q } from '@/lib/queries/ec2';
import { queries as s3Q } from '@/lib/queries/s3';
import { queries as rdsQ } from '@/lib/queries/rds';
import { queries as lambdaQ } from '@/lib/queries/lambda';
import { queries as vpcQ } from '@/lib/queries/vpc';
import { queries as iamQ } from '@/lib/queries/iam';
import { queries as cwQ } from '@/lib/queries/cloudwatch';
import { queries as ecsQ } from '@/lib/queries/ecs';
import { queries as dynamoQ } from '@/lib/queries/dynamodb';
import { queries as costQ } from '@/lib/queries/cost';
import { queries as k8sQ } from '@/lib/queries/k8s';
import { queries as secQ } from '@/lib/queries/security';
import { queries as ecacheQ } from '@/lib/queries/elasticache';
import { queries as ctQ } from '@/lib/queries/cloudtrail';
import { queries as cfQ } from '@/lib/queries/cloudfront';
import { queries as wafQ } from '@/lib/queries/waf';
import { queries as ecrQ } from '@/lib/queries/ecr';
import { queries as ebsQ } from '@/lib/queries/ebs';
import { queries as mskQ } from '@/lib/queries/msk';
import { queries as osQ } from '@/lib/queries/opensearch';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';


interface DashboardData {
  [key: string]: { rows: Record<string, unknown>[]; error?: string };
}

// Clickable card wrapper / 클릭 가능한 카드 래퍼
function CardLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  const router = useRouter();
  return (
    <div onClick={() => router.push(href)}
      className={`cursor-pointer transition-all hover:scale-[1.02] hover:border-accent-cyan/30 ${className}`}>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();

  const [data, setData] = useState<DashboardData>({});
  const [loading, setLoading] = useState(true);
  const [costAvailable, setCostAvailable] = useState<boolean | null>(null);
  const [cacheStatus, setCacheStatus] = useState<any>(null);

  const fetchData = useCallback(async (bustCache = false) => {
    setLoading(true);
    try {
      const url = bustCache ? '/api/steampipe?bustCache=true' : '/api/steampipe';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: currentAccountId,
          saveInventory: true,
          queries: {
            ec2Status: ec2Q.statusCount,
            ec2Types: ec2Q.typeDistribution,
            s3Summary: s3Q.summary,
            rdsSummary: rdsQ.summary,
            lambdaSummary: lambdaQ.summary,
            vpcSummary: vpcQ.summary,
            iamSummary: iamQ.summary,
            cwSummary: cwQ.summary,
            ecsSummary: ecsQ.summary,
            dynamoSummary: dynamoQ.summary,
            ...(costAvailable !== false ? {
              costSummary: costQ.summary,
              costDetail: costQ.dashboardDetail,
            } : {}),
            k8sNodes: k8sQ.nodeSummary,
            k8sPods: k8sQ.podSummary,
            k8sDeploy: k8sQ.deploymentSummary,
            secSummary: secQ.summary,
            ecacheSummary: ecacheQ.summary,
            ctSummary: ctQ.summary,
            cfSummary: cfQ.summary,
            wafSummary: wafQ.summary,
            ecrSummary: ecrQ.summary,
            ebsSummary: ebsQ.summary,
            mskSummary: mskQ.summary,
            osSummary: osQ.summary,
            k8sWarnings: k8sQ.warningEvents,
          },
        }),
      });
      setData(await res.json());
      // Refresh cache status after data load / 데이터 로드 후 캐시 상태 갱신
      fetch('/api/steampipe?action=cache-status').then(r => r.json()).then(d => setCacheStatus(d)).catch(() => {});
    } catch {} finally { setLoading(false); }
  }, [costAvailable, currentAccountId]);

  // Cost Explorer 가용성 선 확인 / Pre-check cost availability
  useEffect(() => {
    const acctQ = currentAccountId && currentAccountId !== '__all__' ? `&accountId=${currentAccountId}` : '';
    fetch(`/api/steampipe?action=cost-check${acctQ}`)
      .then(r => r.json())
      .then(d => setCostAvailable(d.available !== false))
      .catch(() => setCostAvailable(false));
    // Cache warmer status / 캐시 워머 상태 조회
    fetch('/api/steampipe?action=cache-status')
      .then(r => r.json())
      .then(d => setCacheStatus(d))
      .catch(() => {});
  }, [currentAccountId]);

  // cost-check 완료 후 fetchData 실행 / Run fetchData after cost-check resolves
  useEffect(() => {
    if (costAvailable === null) return;
    fetchData();
  }, [costAvailable, fetchData]);

  const get = (key: string) => data[key]?.rows || [];
  const getFirst = (key: string) => get(key)[0] || {};

  const ec2States = get('ec2Status');
  const running = ec2States.find((r: any) => r.name === 'running');
  const totalEC2 = ec2States.reduce((sum: number, r: any) => sum + (Number(r.value) || 0), 0);
  const s3 = getFirst('s3Summary') as any;
  const rds = getFirst('rdsSummary') as any;
  const lambda = getFirst('lambdaSummary') as any;
  const vpc = getFirst('vpcSummary') as any;
  const iam = getFirst('iamSummary') as any;
  const cw = getFirst('cwSummary') as any;
  const ecs = getFirst('ecsSummary') as any;
  const dynamo = getFirst('dynamoSummary') as any;
  const cost = getFirst('costSummary') as any;
  const costDtl = getFirst('costDetail') as any;
  const k8sNodes = getFirst('k8sNodes') as any;
  const k8sDeploy = getFirst('k8sDeploy') as any;
  const sec = getFirst('secSummary') as any;
  const ecache = getFirst('ecacheSummary') as any;
  const ct = getFirst('ctSummary') as any;
  const cf = getFirst('cfSummary') as any;
  const waf = getFirst('wafSummary') as any;
  const ecrSum = getFirst('ecrSummary') as any;
  const ebs = getFirst('ebsSummary') as any;
  const msk = getFirst('mskSummary') as any;
  const os = getFirst('osSummary') as any;
  const podSum = getFirst('k8sPods') as any;
  const totalPods = Number(podSum?.total_pods) || 0;

  // CIS benchmark cached result / CIS 벤치마크 캐시 결과
  const [cisSummary, setCisSummary] = useState<any>(null);
  useEffect(() => {
    fetch('/api/benchmark?benchmark=cis_v400&action=status')
      .then(r => r.json())
      .then(s => {
        // hasResult가 true면 결과 파일 존재 (status가 done이 아니어도)
        if (s.hasResult) {
          fetch('/api/benchmark?benchmark=cis_v400&action=result')
            .then(r => r.json())
            .then(d => {
              // summary.status.ok/alarm/skip/error 구조
              const st = d?.summary?.status;
              if (st) setCisSummary(st);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Security issues / 보안 이슈 합산
  const pubBuckets = Number(sec?.public_buckets) || 0;
  const openSgs = Number(sec?.open_sgs) || 0;
  const unencVols = Number(sec?.unencrypted_volumes) || 0;
  const totalIssues = pubBuckets + openSgs + unencVols;
  const secDetails = [
    pubBuckets > 0 ? `${pubBuckets} ${t('dashboard.publicS3')}` : '',
    openSgs > 0 ? `${openSgs} ${t('dashboard.openSG')}` : '',
    unencVols > 0 ? `${unencVols} ${t('dashboard.unencryptedEBS')}` : '',
  ].filter(Boolean).join(', ');

  // Warnings / 경고
  const warnings: { icon: React.ElementType; text: string; severity: string; href: string }[] = [];
  if (pubBuckets > 0) warnings.push({ icon: Database, text: t('dashboard.publicS3Buckets', { count: pubBuckets }), severity: 'error', href: '/s3' });
  if (Number(iam?.mfa_not_enabled) > 0) warnings.push({ icon: Shield, text: t('dashboard.iamWithoutMfa', { count: iam.mfa_not_enabled }), severity: 'warning', href: '/iam' });
  if (Number(cw?.alarm_count) > 0) warnings.push({ icon: Bell, text: t('dashboard.cloudwatchAlarms', { count: cw.alarm_count }), severity: 'error', href: '/cloudwatch' });
  if (openSgs > 0) warnings.push({ icon: ShieldCheck, text: t('dashboard.openSecurityGroups', { count: openSgs }), severity: 'warning', href: '/security' });
  const k8sWarnings = get('k8sWarnings');
  if (k8sWarnings.length > 0) warnings.push({ icon: Box, text: t('dashboard.k8sWarningEvents', { count: k8sWarnings.length }), severity: 'warning', href: '/k8s' });

  // Resource bar chart data / 리소스 바 차트 데이터
  const resourceCounts = [
    { name: 'EC2', value: totalEC2 },
    { name: 'Lambda', value: Number(lambda?.total_functions) || 0 },
    { name: 'S3', value: Number(s3?.total_buckets) || 0 },
    { name: 'RDS', value: Number(rds?.total_instances) || 0 },
    { name: t('dashboard.ecsTasks'), value: Number(ecs?.total_tasks) || 0 },
    { name: 'DynamoDB', value: Number(dynamo?.total_tables) || 0 },
    { name: t('dashboard.k8sPods'), value: totalPods },
  ].filter(r => r.value > 0);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <Header title={t('dashboard.title')} onRefresh={() => fetchData(true)} />

      {/* Loading progress bar / 로딩 프로그레스 바 */}
      {loading && (
        <div className="w-full h-1 bg-navy-700 rounded-full overflow-hidden">
          <div className="h-full bg-accent-cyan rounded-full animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      {/* Row 1: Compute & Containers (6) / 컴퓨팅 & 컨테이너 */}
      <div>
        <h2 className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-3">{t('dashboard.computeContainers')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <CardLink href="/ec2">
            <StatsCard label={t('dashboard.ec2Label')} value={totalEC2} icon={Server} color="cyan"
              change={t('dashboard.ec2Change', { running: Number(running?.value) || 0, stopped: totalEC2 - (Number(running?.value) || 0) })} />
          </CardLink>
          <CardLink href="/lambda">
            <StatsCard label={t('dashboard.lambdaLabel')} value={Number(lambda?.total_functions) || 0} icon={Zap} color="purple"
              change={t('dashboard.lambdaChange', { runtimes: Number(lambda?.unique_runtimes) || 0, longTimeout: Number(lambda?.long_timeout_functions) || 0 })} />
          </CardLink>
          <SystemHealthCard />
          <CardLink href="/ecr">
            <StatsCard label={t('dashboard.ecrLabel')} value={Number(ecrSum?.total_repos) || 0} icon={Package} color="green"
              change={t('dashboard.ecrChange', { scan: Number(ecrSum?.scan_enabled) || 0, immutable: Number(ecrSum?.immutable_tags) || 0 })} />
          </CardLink>
          <CardLink href="/k8s">
            <StatsCard label={t('dashboard.eksLabel')} value={Number(k8sNodes?.total_nodes) || 0} icon={Box} color="pink"
              change={t('dashboard.eksChange', { ready: Number(k8sNodes?.ready_nodes) || 0, pods: totalPods, deploy: Number(k8sDeploy?.total_deployments) || 0 })} />
          </CardLink>
          <CardLink href="/cloudfront-cdn">
            <StatsCard label={t('dashboard.cloudfrontLabel')} value={Number(cf?.total_distributions) || 0} icon={Globe} color="cyan"
              change={t('dashboard.cloudfrontChange', { enabled: Number(cf?.enabled_count) || 0, http: Number(cf?.http_allowed) || 0 })} />
          </CardLink>
        </div>
      </div>

      {/* Row 2: Network & Data (6) / 네트워크 & 데이터 */}
      <div>
        <h2 className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-3">{t('dashboard.networkStorage')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-4">
          <CardLink href="/vpc">
            <StatsCard label={t('dashboard.vpcsLabel')} value={Number(vpc?.vpc_count) || 0} icon={Network} color="orange"
              change={t('dashboard.vpcsChange', { subnets: vpc?.subnet_count || 0, nat: Number(vpc?.nat_gateway_count) || 0, tgw: Number(vpc?.tgw_count) || 0 })} />
          </CardLink>
          <CardLink href="/waf">
            <StatsCard label={t('dashboard.wafLabel')} value={Number(waf?.total_web_acls) || 0} icon={Shield} color="purple"
              change={t('dashboard.wafChange', { rules: Number(waf?.total_rule_groups) || 0, ipSets: Number(waf?.total_ip_sets) || 0 })} />
          </CardLink>
          <CardLink href="/ebs">
            <StatsCard label={t('dashboard.ebsLabel')} value={Number(ebs?.total_volumes) || 0} icon={HardDrive} color="cyan"
              change={t('dashboard.ebsChange', { size: Number(ebs?.total_size_gb) || 0, unenc: Number(ebs?.unencrypted_count) || 0 })} />
          </CardLink>
          <CardLink href="/s3">
            <StatsCard label={t('dashboard.s3Label')} value={Number(s3?.total_buckets) || 0} icon={Database} color="green"
              change={pubBuckets > 0 ? t('dashboard.s3ChangePublic', { public: pubBuckets, private: Number(s3?.total_buckets) - pubBuckets }) : t('dashboard.s3ChangePrivate')} />
          </CardLink>
          <CardLink href="/rds">
            <StatsCard label={t('dashboard.rdsLabel')} value={Number(rds?.total_instances) || 0} icon={Database} color="cyan"
              change={t('dashboard.rdsChange', { storage: Number(rds?.total_storage_gb) || 0, multiAz: Number(rds?.multi_az_count) || 0 })} />
          </CardLink>
          <CardLink href="/dynamodb">
            <StatsCard label={t('dashboard.dynamoLabel')} value={Number(dynamo?.total_tables) || 0} icon={Table} color="purple"
              change={Number(dynamo?.total_tables) > 0 ? t('dashboard.dynamoChange') : undefined} />
          </CardLink>
          <CardLink href="/elasticache">
            <StatsCard label={t('dashboard.elasticacheLabel')} value={Number(ecache?.total_clusters) || 0} icon={Database} color="orange"
              change={t('dashboard.elasticacheChange', { redis: Number(ecache?.redis_count) || 0, memcached: Number(ecache?.memcached_count) || 0, nodes: Number(ecache?.total_nodes) || 0 })} />
          </CardLink>
          <CardLink href="/opensearch">
            <StatsCard label={t('dashboard.opensearchLabel')} value={Number(os?.total_domains) || 0} icon={Search} color="purple"
              change={t('dashboard.opensearchChange', { vpc: Number(os?.vpc_domains) || 0, encrypted: Number(os?.node_encrypted) || 0 })} />
          </CardLink>
          <CardLink href="/msk">
            <StatsCard label={t('dashboard.mskLabel')} value={Number(msk?.total_clusters) || 0} icon={Radio} color="green"
              change={t('dashboard.mskChange', { active: Number(msk?.active_clusters) || 0 })} />
          </CardLink>
        </div>
      </div>

      {/* Row 3: Security, Monitoring & Cost / 보안, 모니터링 & 비용 */}
      <div>
        <h2 className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-3">{t('dashboard.securityMonitoringCost')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 auto-rows-fr gap-4">
          <CardLink href="/security" className={totalIssues > 0 ? 'ring-1 ring-accent-red/30 rounded-lg' : ''}>
            <StatsCard label={t('dashboard.securityIssues')} value={totalIssues} icon={ShieldCheck}
              color={totalIssues > 0 ? 'red' : 'green'} highlight
              change={totalIssues > 0 ? secDetails : `✓ ${t('dashboard.allClear')}`} />
          </CardLink>
          <CardLink href="/iam">
            <StatsCard label={t('dashboard.iamUsers')} value={Number(iam?.total_users) || 0} icon={Shield} color="purple"
              change={`${t('dashboard.iamChange', { roles: Number(iam?.total_roles) || 0, groups: Number(iam?.total_groups) || 0 })}${Number(iam?.mfa_not_enabled) > 0 ? ` · ${t('dashboard.iamNoMfa', { count: iam.mfa_not_enabled })}` : ''}`} />
          </CardLink>
          <CardLink href="/cloudwatch">
            <StatsCard label={t('dashboard.cwAlarms')} value={Number(cw?.alarm_count) || 0} icon={Bell}
              color={Number(cw?.alarm_count) > 0 ? 'red' : 'green'}
              change={t('dashboard.cwChange', { metrics: Number(cw?.metric_count) || 0, logGroups: Number(cw?.log_group_count) || 0 })} />
          </CardLink>
          <CardLink href="/cloudtrail">
            <StatsCard label={t('dashboard.cloudtrailLabel')} value={`${Number(ct?.total_trails) || 0} ${t('dashboard.trails')}`} icon={FileSearch} color="cyan"
              change={t('dashboard.cloudtrailChange', { active: Number(ct?.active_trails) || 0, multiRegion: Number(ct?.multi_region_trails) || 0, validated: Number(ct?.log_validated_trails) || 0 })} />
          </CardLink>
          <CardLink href="/compliance">
            {(() => {
              const cisOk = Number(cisSummary?.ok) || 0;
              const cisAlarm = Number(cisSummary?.alarm) || 0;
              const cisSkip = Number(cisSummary?.skip) || 0;
              const cisError = Number(cisSummary?.error) || 0;
              const cisTotal = cisOk + cisAlarm + cisSkip + cisError;
              const passRate = cisTotal > 0 ? ((cisOk / cisTotal) * 100).toFixed(1) : null;
              return (
                <StatsCard label={t('dashboard.cisCompliance')}
                  value={passRate ? `${passRate}%` : t('dashboard.cisNotScanned')}
                  icon={ShieldCheck}
                  color={passRate ? (Number(passRate) >= 80 ? 'green' : Number(passRate) >= 50 ? 'orange' : 'red') : 'purple'}
                  change={passRate ? t('dashboard.cisChange', { alarm: cisAlarm, skip: cisSkip, error: cisError }) : t('dashboard.cisRunBenchmark')} />
              );
            })()}
          </CardLink>
          <CardLink href={costAvailable === false ? '/inventory' : '/cost'}>
            {(() => {
              if (costAvailable === false) {
                return (
                  <StatsCard label={t('dashboard.monthlyCost')} value="N/A"
                    icon={DollarSign} color="purple"
                    change={t('dashboard.costUnavailable')} />
                );
              }
              const thisM = Number(costDtl?.this_month) || 0;
              const lastM = Number(costDtl?.last_month) || 0;
              const daily = Number(costDtl?.daily_avg) || 0;
              const mom = lastM > 0 ? ((thisM - lastM) / lastM * 100).toFixed(0) : '0';
              return (
                <StatsCard label={t('dashboard.monthlyCost')} value={cost?.total_cost ? `$${Number(cost.total_cost).toLocaleString()}` : '$--'}
                  icon={DollarSign} color="orange"
                  change={`$${daily.toFixed(0)}/${t('dashboard.costChange').includes('/일') ? '일' : 'day'} · ${t('cost.lastMonth')} $${lastM.toLocaleString()} · ${Number(mom) > 0 ? '+' : ''}${mom}% MoM`} />
              );
            })()}
          </CardLink>
        </div>
      </div>

      {/* Warnings / 경고 */}
      {warnings.length > 0 && (
        <div className="bg-navy-800 rounded-lg border border-navy-600 p-4">
          <h3 className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-3">
            <AlertTriangle size={12} className="inline mr-1 text-accent-orange" />
            {t('dashboard.activeWarnings')} ({warnings.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {warnings.map((w, i) => (
              <div key={i} onClick={() => router.push(w.href)}
                className="flex items-center gap-3 p-2.5 rounded bg-navy-900 cursor-pointer hover:bg-navy-700 transition-colors">
                <w.icon size={16} className={w.severity === 'error' ? 'text-accent-red' : 'text-accent-orange'} />
                <span className="text-sm">{w.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts / 차트 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BarChartCard title={t('dashboard.resourceDistribution')} data={resourceCounts} />
        <PieChartCard title={t('dashboard.ec2InstanceTypes')} data={get('ec2Types').map((r: any) => ({ name: String(r.name), value: Number(r.value) || 0 })).slice(0, 8)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PieChartCard title={t('dashboard.k8sPodStatus')} data={[
          { name: t('common.running'), value: Number(podSum?.running_pods) || 0 },
          { name: t('common.pending'), value: Number(podSum?.pending_pods) || 0 },
          { name: t('common.failed'), value: Number(podSum?.failed_pods) || 0 },
          { name: t('common.succeeded'), value: Number(podSum?.succeeded_pods) || 0 },
        ].filter(d => d.value > 0)} />
        {/* K8s Warning Events / K8s 경고 이벤트 */}
        <div className="bg-navy-800 rounded-lg border border-navy-600 p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <AlertTriangle size={14} className="text-accent-orange" />
            {t('dashboard.recentK8sEvents')}
          </h3>
          {k8sWarnings.length === 0 && !loading ? (
            <p className="text-gray-500 text-sm">{t('dashboard.noWarningEvents')}</p>
          ) : (
            <div className="space-y-1 max-h-52 overflow-y-auto">
              {k8sWarnings.slice(0, 8).map((ev: any, i: number) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded bg-navy-900 text-xs">
                  <AlertTriangle size={11} className="text-accent-orange mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="text-gray-400">{String(ev.namespace)}/{String(ev.name)}</span>
                    <span className="text-gray-600 ml-2">{String(ev.reason)}</span>
                    <p className="text-gray-300 mt-0.5">{String(ev.message).slice(0, 100)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cache Warmer Status Bar / 캐시 워머 상태 바 */}
      {cacheStatus && (
        <div className="flex items-center gap-4 px-4 py-2.5 rounded-lg bg-navy-800/60 border border-navy-600/50 text-[11px] font-mono text-gray-500">
          <div className="flex items-center gap-1.5">
            <RefreshCw size={12} className={cacheStatus.isRunning ? 'text-accent-cyan animate-spin' : 'text-gray-600'} />
            <span className="text-gray-400">{t('dashboard.cacheWarmer')}</span>
          </div>
          {cacheStatus.lastWarmedAt && (
            <>
              <span>{t('dashboard.lastCached')}: <span className="text-accent-green">{getTimeAgo(cacheStatus.lastWarmedAt, t)}</span></span>
              <span className="text-gray-600">|</span>
              <span>{t('dashboard.duration')}: <span className="text-accent-cyan">{cacheStatus.lastDurationSec}s</span></span>
              <span className="text-gray-600">|</span>
              <span>{t('dashboard.queries')}: <span className="text-gray-300">{cacheStatus.dashboardQueries + cacheStatus.monitoringQueries}</span></span>
              <span className="text-gray-600">|</span>
              <span>{t('dashboard.refreshCycle')}: <span className="text-gray-300">{cacheStatus.intervalMin}{t('dashboard.min')}</span></span>
              <span className="text-gray-600">|</span>
              <span>{t('dashboard.warmCount')}: <span className="text-accent-purple">{cacheStatus.warmCount}</span></span>
            </>
          )}
          {cacheStatus.isRunning && (
            <span className="text-accent-cyan">{t('dashboard.warming')}</span>
          )}
          {!cacheStatus.lastWarmedAt && !cacheStatus.isRunning && (
            <span className="text-gray-600">{t('dashboard.waitingFirstWarm')}</span>
          )}
          {cacheStatus.lastError && (
            <span className="text-accent-red">Error: {cacheStatus.lastError}</span>
          )}
        </div>
      )}
    </div>
  );
}

// Helper: relative time display / 상대 시간 표시
function getTimeAgo(isoString: string, t: (key: string, params?: any) => string): string {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return t('dashboard.secondsAgo', { count: diff });
  if (diff < 3600) return t('dashboard.minutesAgo', { count: Math.floor(diff / 60) });
  return t('dashboard.hoursAgo', { count: Math.floor(diff / 3600) });
}
