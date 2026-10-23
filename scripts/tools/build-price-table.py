#!/usr/bin/env python3
"""Build src/lib/cost-radar/prices.ap-northeast-2.json from AWS's public bulk price lists.
AWS 공개 일괄 가격표(CSV)에서 서울 리전 온디맨드 단가만 추려 JSON으로 만든다. (Pricing API는 SCP로 막혀 있음)

Usage: python3 scripts/tools/build-price-table.py [--cache-dir DIR] [--out FILE]
Stdlib only. CSVs are streamed row by row (EC2 CSV is ~200 MB) and kept in --cache-dir
(default: a fresh temp dir outside the repo) — never commit them.
"""
import argparse, csv, json, os, sys, tempfile, urllib.request

REGION = 'ap-northeast-2'
BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws'
OFFERS = ['AmazonEC2', 'AmazonVPC', 'AWSELB', 'AmazonRDS', 'AmazonElastiCache']
RDS_ENGINES = {  # price list "Database Engine" -> key used by pricing.ts
    'PostgreSQL': 'postgresql', 'MySQL': 'mysql', 'MariaDB': 'mariadb',
    'Aurora PostgreSQL': 'aurora-postgresql', 'Aurora MySQL': 'aurora-mysql',
}


def fetch(offer, cache_dir):
    dest = os.path.join(cache_dir, offer + '.csv')
    if not os.path.exists(dest):
        url = f'{BASE}/{offer}/current/{REGION}/index.csv'
        print('download', url, file=sys.stderr)
        with urllib.request.urlopen(url) as r, open(dest + '.part', 'wb') as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(dest + '.part', dest)
    return dest


def rows(path):
    """Yield (publicationDate, row dict) for OnDemand USD rows / OnDemand 행만 스트리밍."""
    with open(path, newline='', encoding='utf-8') as fh:
        r = csv.reader(fh)
        header, pub = None, None
        for line in r:
            if not line:
                continue
            if line[0] == 'Publication Date':
                pub = line[1]
            if line[0] == 'SKU':
                header = line
                break
        yield pub, None
        for line in r:
            d = dict(zip(header, line))
            if d['TermType'] == 'OnDemand' and d['Currency'] == 'USD':
                yield pub, d


def price(d):
    return float(d['PricePerUnit'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache-dir')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'lib', 'cost-radar', f'prices.{REGION}.json'))
    a = ap.parse_args()
    cache = a.cache_dir or tempfile.mkdtemp(prefix='cost-radar-prices-')
    os.makedirs(cache, exist_ok=True)

    out = {'region': REGION, 'offers': {}, 'ec2': {}, 'ebs': {'gbMonth': {}, 'ioIopsMonth': {}},
           'lbHour': {}, 'rds': {'instances': {}, 'storageGbMonth': {}}, 'elasticache': {}}
    ebs_map = {'gp2': 'gp2', 'gp3': 'gp3', 'io1': 'io1', 'io2': 'io2', 'st1': 'st1', 'sc1': 'sc1', 'standard': 'standard'}

    for offer in OFFERS:
        path = fetch(offer, cache)
        for pub, d in rows(path):
            if d is None:
                out['offers'][offer] = pub
                continue
            u = d['usageType']
            if offer == 'AmazonEC2':
                pf = d['Product Family']
                if (pf == 'Compute Instance' and d['Tenancy'] == 'Shared' and d['Operating System'] == 'Linux'
                        and d['Pre Installed S/W'] == 'NA' and d['CapacityStatus'] == 'Used'
                        and d['License Model'] == 'No License required' and u.startswith('APN2-BoxUsage')):
                    out['ec2'][d['Instance Type']] = price(d)
                elif pf == 'Storage' and u.startswith('APN2-EBS:VolumeUsage'):
                    t = d['Volume API Name']
                    if t in ebs_map:
                        out['ebs']['gbMonth'][t] = price(d)
                elif u == 'APN2-EBS:VolumeP-IOPS.gp3':
                    out['ebs']['gp3IopsMonth'] = price(d)
                elif u == 'APN2-EBS:VolumeP-Throughput.gp3':  # priced per GiB/s-month; we bill per MB/s
                    out['ebs']['gp3ThroughputMbpsMonth'] = round(price(d) / 1024, 6)
                elif u == 'APN2-EBS:VolumeP-IOPS.piops':
                    out['ebs']['ioIopsMonth']['io1'] = price(d)
                elif u == 'APN2-EBS:VolumeP-IOPS.io2':  # first tier only / 첫 구간 단가만
                    out['ebs']['ioIopsMonth']['io2'] = price(d)
                elif u == 'APN2-EBS:SnapshotUsage':
                    out['snapshotGbMonth'] = price(d)
                elif u == 'APN2-NatGateway-Hours':
                    out['natHour'] = price(d)
            elif offer == 'AmazonVPC':
                if u == 'APN2-VpcEndpoint-Hours':
                    out['vpcEndpointHour'] = price(d)
                elif u == 'APN2-PublicIPv4:InUseAddress':
                    out['publicIpv4Hour'] = price(d)
            elif offer == 'AWSELB':
                if u == 'APN2-LoadBalancerUsage':
                    if d['Product Family'] == 'Load Balancer-Application':
                        out['lbHour']['application'] = price(d)
                    elif d['Product Family'] == 'Load Balancer-Network':
                        out['lbHour']['network'] = price(d)
            elif offer == 'AmazonRDS':
                eng = RDS_ENGINES.get(d['Database Engine'])
                pf = d['Product Family']
                if pf == 'Database Instance' and eng and d['License Model'] == 'No license required':
                    idx = 0 if u.startswith('APN2-InstanceUsage:') else 1 if u.startswith('APN2-Multi-AZUsage:') else None
                    if idx is not None:
                        pair = out['rds']['instances'].setdefault(eng, {}).setdefault(d['Instance Type'], [None, None])
                        pair[idx] = price(d)
                        if eng.startswith('aurora-'):  # Aurora has no Multi-AZ SKU: replicas are separate instances
                            pair[1] = pair[0]
                elif pf == 'Database Storage' and d['Database Engine'] in ('Any', 'Aurora PostgreSQL'):
                    stor = {'APN2-RDS:GP2-Storage': ('gp2', 0), 'APN2-RDS:Multi-AZ-GP2-Storage': ('gp2', 1),
                            'APN2-RDS:GP3-Storage': ('gp3', 0), 'APN2-RDS:Multi-AZ-GP3-Storage': ('gp3', 1),
                            'APN2-RDS:PIOPS-Storage': ('io1', 0), 'APN2-RDS:Multi-AZ-PIOPS-Storage': ('io1', 1),
                            'APN2-RDS:StorageUsage': ('standard', 0), 'APN2-RDS:Multi-AZ-StorageUsage': ('standard', 1)}.get(u)
                    if stor and d['Database Engine'] == 'Any':
                        out['rds']['storageGbMonth'].setdefault(stor[0], [None, None])[stor[1]] = price(d)
            elif offer == 'AmazonElastiCache':
                if d['Product Family'] == 'Cache Instance' and d['Cache Engine'] == 'Redis' and u.startswith('APN2-NodeUsage:'):
                    out['elasticache'][d['Instance Type']] = price(d)

    # Drop RDS instance classes missing either price / 한쪽 가격이 없는 클래스 제거
    for eng, classes in out['rds']['instances'].items():
        out['rds']['instances'][eng] = {k: v for k, v in classes.items() if v[0] is not None and v[1] is not None}
    out['asOf'] = min(out['offers'].values())[:10]
    out['ec2'] = dict(sorted(out['ec2'].items()))
    for k in ('natHour', 'vpcEndpointHour', 'publicIpv4Hour', 'snapshotGbMonth'):
        assert k in out, f'missing {k}'
    assert set(out['lbHour']) == {'application', 'network'}
    with open(a.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'), sort_keys=True)
        f.write('\n')
    print('wrote', os.path.abspath(a.out), os.path.getsize(a.out), 'bytes', file=sys.stderr)
    # Client code imports the date from a tiny module, not the whole table. / 클라이언트는 기준일만 import.
    as_of_path = os.path.join(os.path.dirname(os.path.abspath(a.out)), 'price-as-of.ts')
    with open(as_of_path, 'w') as f:
        f.write('// Generated by scripts/tools/build-price-table.py — do not edit by hand.\n'
                '// Price list date, importable by client code without bundling the price table.\n'
                '// build-price-table.py가 생성 — 직접 수정 금지. 가격표 JSON 없이 클라이언트에서 쓰는 기준일.\n'
                f"export const PRICE_AS_OF = '{out['asOf']}';\n")
    print('wrote', as_of_path, file=sys.stderr)


if __name__ == '__main__':
    main()
