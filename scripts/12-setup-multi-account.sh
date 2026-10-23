#!/bin/bash
set -e
set -o pipefail
################################################################################
#                                                                              #
#   Step 12: Multi-Account Setup                                               #
#                                                                              #
#   Actions:                                                                   #
#     1. Validate prerequisites (Steampipe, host account)                      #
#     2. Add target account Steampipe connections (.spc)                       #
#     3. Create aggregator connection for cross-account queries                #
#     4. Update data/config.json with accounts array                           #
#     5. Restart Steampipe service                                             #
#     6. Verify cross-account connectivity                                     #
#                                                                              #
#   Prerequisites:                                                             #
#     - Host account: Steampipe running (Step 2)                               #
#     - Target accounts: IAM role deployed via cfn-target-account-role.yaml    #
#     - Host EC2 instance profile must allow sts:AssumeRole                    #
#                                                                              #
#   Architecture (Steampipe Aggregator Pattern):                               #
#     aws (aggregator) = aws_111111111111 + aws_222222222222 + ...             #
#     Each connection uses AssumeRole to query a different account             #
#     search_path selects which connection to query:                           #
#       - All Accounts: public, aws (aggregator)                               #
#       - Single: public, aws_123456789012, kubernetes, trivy                  #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
HOST_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")
STEAMPIPE_CONFIG_DIR="$HOME/.steampipe/config"
EXTERNAL_ID="${AWSOPS_EXTERNAL_ID:-}"
ROLE_NAME="${AWSOPS_ROLE_NAME:-AWSopsReadOnlyRole}"
CONFIG_FILE="$WORK_DIR/data/config.json"
# 환경변수가 없으면 config.json에 저장된 External ID 사용 (add 시 저장됨)
# Fall back to the External ID stored in config.json by a previous `add`
if [ -z "$EXTERNAL_ID" ] && [ -f "$CONFIG_FILE" ]; then
    EXTERNAL_ID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('crossAccountExternalId',''))" "$CONFIG_FILE" 2>/dev/null || echo "")
fi

cd "$WORK_DIR"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 12: Multi-Account Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

# -- Usage / help -------------------------------------------------------------
usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  add    <account_id> <alias> [region]  Add a target account"
    echo "  remove <account_id>                    Remove a target account"
    echo "  list                                   List configured accounts"
    echo "  init                                   Initialize host account as first entry"
    echo "  apply                                  Regenerate Steampipe configs & restart"
    echo "  verify                                 Test connectivity to all accounts"
    echo "  cfn    <account_id>                    Print CFN deploy command for target account"
    echo ""
    echo "Environment variables:"
    echo "  AWSOPS_EXTERNAL_ID   External ID for STS AssumeRole (default: empty/disabled)"
    echo "  AWSOPS_ROLE_NAME     IAM role name in target accounts (default: AWSopsReadOnlyRole)"
    echo ""
    echo "Examples:"
    echo "  $0 init                                # Register host account"
    echo "  $0 add 222222222222 Staging             # Add staging account"
    echo "  $0 add 333333333333 Production us-east-1 # Add production (different region)"
    echo "  $0 apply                                # Apply changes & restart Steampipe"
    echo "  $0 verify                               # Test all account connections"
    exit 1
}

[ $# -lt 1 ] && usage

# -- Helper: read/write config.json via Python --------------------------------
read_config() {
    python3 -c "
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except:
    cfg = {}
json.dump(cfg, sys.stdout)
" "$CONFIG_FILE"
}

write_config() {
    local json_str="$1"
    mkdir -p "$WORK_DIR/data"
    echo "$json_str" | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
json.dump(cfg, open(sys.argv[1], 'w'), indent=2)
" "$CONFIG_FILE"
}

get_accounts_json() {
    python3 -c "
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    accounts = cfg.get('accounts', [])
except:
    accounts = []
print(json.dumps(accounts))
" "$CONFIG_FILE"
}

# -- Command: init (register host account) ------------------------------------
cmd_init() {
    echo -e "${CYAN}[1/2] Registering host account...${NC}"

    if [ "$HOST_ACCOUNT_ID" = "unknown" ]; then
        echo -e "${RED}ERROR: Cannot determine host account ID. Check AWS credentials.${NC}"
        exit 1
    fi

    local host_alias="${2:-Host}"
    local host_region="${REGION}"

    echo "  Account ID: $HOST_ACCOUNT_ID"
    echo "  Alias:      $host_alias"
    echo "  Region:     $host_region"
    echo "  Role:       (direct — no AssumeRole needed for host)"

    # Check if already registered
    local existing
    existing=$(python3 -c "
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    accounts = cfg.get('accounts', [])
    found = any(a['accountId'] == sys.argv[2] for a in accounts)
    print('yes' if found else 'no')
except:
    print('no')
" "$CONFIG_FILE" "$HOST_ACCOUNT_ID")

    if [ "$existing" = "yes" ]; then
        echo -e "  ${YELLOW}Host account already registered. Updating...${NC}"
    fi

    # Update config.json
    echo -e "${CYAN}[2/2] Updating config.json...${NC}"
    python3 -c "
import json, sys

config_file = sys.argv[1]
host_account_id = sys.argv[2]
host_alias = sys.argv[3]
host_region = sys.argv[4]

try:
    cfg = json.load(open(config_file))
except:
    cfg = {}

accounts = cfg.get('accounts', [])

# Remove existing entry for this account
accounts = [a for a in accounts if a['accountId'] != host_account_id]

# Add host account
accounts.insert(0, {
    'accountId': host_account_id,
    'alias': host_alias,
    'connectionName': 'aws_' + host_account_id,
    'region': host_region,
    'isHost': True,
    'features': {
        'costEnabled': cfg.get('costEnabled', True),
        'eksEnabled': True,
        'k8sEnabled': True
    }
})

cfg['accounts'] = accounts
json.dump(cfg, open(config_file, 'w'), indent=2)
print('  Host account registered successfully.')
" "$CONFIG_FILE" "$HOST_ACCOUNT_ID" "$host_alias" "$host_region"

    echo ""
    echo -e "${GREEN}Host account initialized. Run '$0 apply' to generate Steampipe configs.${NC}"
}

# -- Command: add (add target account) ----------------------------------------
cmd_add() {
    local target_id="$2"
    local target_alias="$3"
    local target_region="${4:-$REGION}"

    if [ -z "$target_id" ] || [ -z "$target_alias" ]; then
        echo -e "${RED}ERROR: Usage: $0 add <account_id> <alias> [region]${NC}"
        exit 1
    fi

    # Validate account ID format
    if ! echo "$target_id" | grep -qP '^\d{12}$'; then
        echo -e "${RED}ERROR: Account ID must be exactly 12 digits.${NC}"
        exit 1
    fi

    if [ "$target_id" = "$HOST_ACCOUNT_ID" ]; then
        echo -e "${RED}ERROR: Cannot add host account as target. Use 'init' instead.${NC}"
        exit 1
    fi

    echo -e "${CYAN}Adding target account...${NC}"
    echo "  Account ID: $target_id"
    echo "  Alias:      $target_alias"
    echo "  Region:     $target_region"
    echo "  Role ARN:   arn:aws:iam::${target_id}:role/${ROLE_NAME}"
    echo "  External ID: $EXTERNAL_ID"

    # Test AssumeRole before adding
    echo ""
    echo -e "${CYAN}Testing cross-account AssumeRole...${NC}"
    if aws sts assume-role \
        --role-arn "arn:aws:iam::${target_id}:role/${ROLE_NAME}" \
        --role-session-name "awsops-test-$(date +%s)" \
        --external-id "$EXTERNAL_ID" \
        --query 'Credentials.AccessKeyId' \
        --output text > /dev/null 2>&1; then
        echo -e "  ${GREEN}AssumeRole successful${NC}"
    else
        echo -e "  ${RED}AssumeRole FAILED. Ensure the IAM role exists in account $target_id.${NC}"
        echo -e "  ${YELLOW}Deploy the role first:${NC}"
        echo -e "  ${YELLOW}  $0 cfn $target_id${NC}"
        exit 1
    fi

    # Detect Cost Explorer availability in target account
    echo ""
    echo -e "${CYAN}Detecting Cost Explorer availability in target account...${NC}"
    local cost_enabled="false"

    # Get temporary credentials
    local creds
    creds=$(aws sts assume-role \
        --role-arn "arn:aws:iam::${target_id}:role/${ROLE_NAME}" \
        --role-session-name "awsops-cost-check" \
        --external-id "$EXTERNAL_ID" \
        --output json 2>/dev/null)

    if [ -n "$creds" ]; then
        local ak sk st
        ak=$(echo "$creds" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['Credentials']['AccessKeyId'])")
        sk=$(echo "$creds" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['Credentials']['SecretAccessKey'])")
        st=$(echo "$creds" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['Credentials']['SessionToken'])")

        if AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$st" \
            aws ce get-cost-and-usage \
            --time-period "Start=$(date -d '-1 day' +%Y-%m-%d),End=$(date +%Y-%m-%d)" \
            --granularity DAILY --metrics BlendedCost \
            --region us-east-1 \
            --output text > /dev/null 2>&1; then
            cost_enabled="true"
            echo -e "  ${GREEN}Cost Explorer available${NC}"
        else
            echo -e "  ${YELLOW}Cost Explorer not available (SCP or not enabled)${NC}"
        fi
    fi

    # Update config.json
    python3 -c "
import json, sys

config_file = sys.argv[1]
target_id = sys.argv[2]
target_alias = sys.argv[3]
target_region = sys.argv[4]
cost_enabled = sys.argv[5] == 'true'

try:
    cfg = json.load(open(config_file))
except:
    cfg = {}

accounts = cfg.get('accounts', [])

# Remove existing entry
accounts = [a for a in accounts if a['accountId'] != target_id]

# Add target account
accounts.append({
    'accountId': target_id,
    'alias': target_alias,
    'connectionName': 'aws_' + target_id,
    'region': target_region,
    'isHost': False,
    'features': {
        'costEnabled': cost_enabled,
        'eksEnabled': False,
        'k8sEnabled': False
    },
    'profile': None
})

cfg['accounts'] = accounts
# 대시보드의 연결 테스트·이후 apply가 쓰도록 External ID 보관 / keep the External ID for the UI test and later applies
external_id = sys.argv[6]
if external_id:
    cfg['crossAccountExternalId'] = external_id
json.dump(cfg, open(config_file, 'w'), indent=2)
print(f'  Account {target_id} ({target_alias}) added.')
" "$CONFIG_FILE" "$target_id" "$target_alias" "$target_region" "$cost_enabled" "$EXTERNAL_ID"

    echo ""
    echo -e "${GREEN}Account added. Run '$0 apply' to generate Steampipe configs and restart.${NC}"
}

# -- Command: remove (remove target account) -----------------------------------
cmd_remove() {
    local target_id="$2"

    if [ -z "$target_id" ]; then
        echo -e "${RED}ERROR: Usage: $0 remove <account_id>${NC}"
        exit 1
    fi

    python3 -c "
import json, sys

config_file = sys.argv[1]
target_id = sys.argv[2]

try:
    cfg = json.load(open(config_file))
except:
    print('  No config found.')
    exit(0)

accounts = cfg.get('accounts', [])
before = len(accounts)
accounts = [a for a in accounts if a['accountId'] != target_id]
after = len(accounts)

if before == after:
    print(f'  Account {target_id} not found.')
else:
    cfg['accounts'] = accounts
    json.dump(cfg, open(config_file, 'w'), indent=2)
    print(f'  Account {target_id} removed.')
" "$CONFIG_FILE" "$target_id"

    echo -e "${GREEN}Run '$0 apply' to update Steampipe configs and restart.${NC}"
}

# -- Command: list (list configured accounts) ----------------------------------
cmd_list() {
    echo -e "${CYAN}Configured accounts:${NC}"
    echo ""

    python3 -c "
import json, sys

config_file = sys.argv[1]
try:
    cfg = json.load(open(config_file))
    accounts = cfg.get('accounts', [])
except:
    accounts = []

if not accounts:
    print('  (none configured)')
    print('  Run: init   # to register host account')
    exit(0)

print(f'  Total: {len(accounts)} account(s)')
print()
print(f'  {\"ID\":>14s}  {\"Alias\":<16s} {\"Region\":<16s} {\"Host\":>5s} {\"Cost\":>5s} {\"EKS\":>5s}')
print(f'  {\"-\"*14}  {\"-\"*16} {\"-\"*16} {\"-\"*5} {\"-\"*5} {\"-\"*5}')
for a in accounts:
    f = a.get('features', {})
    print(f'  {a[\"accountId\"]:>14s}  {a[\"alias\"]:<16s} {a.get(\"region\",\"??\"):<16s} {\"Y\" if a.get(\"isHost\") else \"N\":>5s} {\"Y\" if f.get(\"costEnabled\") else \"N\":>5s} {\"Y\" if f.get(\"eksEnabled\") else \"N\":>5s}')
" "$CONFIG_FILE"
}

# -- Command: apply (generate Steampipe configs & restart) ---------------------
cmd_apply() {
    echo -e "${CYAN}[1/4] Reading account configuration...${NC}"

    local accounts_json
    accounts_json=$(get_accounts_json)
    local count
    count=$(echo "$accounts_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")

    if [ "$count" -eq 0 ]; then
        echo -e "${RED}ERROR: No accounts configured. Run '$0 init' first.${NC}"
        exit 1
    fi

    echo "  $count account(s) configured"

    # -- [2/4] Generate per-account Steampipe connection files ------------------
    echo ""
    echo -e "${CYAN}[2/4] Generating Steampipe connection configs...${NC}"

    mkdir -p "$STEAMPIPE_CONFIG_DIR"

    # Generate individual .spc files for each account
    export _SP_CONFIG_DIR="$STEAMPIPE_CONFIG_DIR"
    export _SP_HOST_ACCOUNT="$HOST_ACCOUNT_ID"
    export _SP_EXTERNAL_ID="$EXTERNAL_ID"
    export _SP_ROLE_NAME="$ROLE_NAME"
    echo "$accounts_json" | python3 -c "
import json, sys, os

accounts = json.load(sys.stdin)
config_dir = os.environ['_SP_CONFIG_DIR']
host_account = os.environ['_SP_HOST_ACCOUNT']
external_id = os.environ['_SP_EXTERNAL_ID']
role_name = os.environ['_SP_ROLE_NAME']

AWS_CONFIG = os.path.expanduser('~/.aws/config')

def write_aws_profile(profile, role_arn, external_id, region):
    # ~/.aws/config에 대상 계정 프로필을 멱등하게 기록
    # Steampipe AWS 플러그인은 role_arn/external_id 인자를 지원하지 않으므로
    # 자격증명은 AWS CLI 프로필로 위임한다. 소스는 EC2 인스턴스 역할.
    block = [f'[profile {profile}]', f'role_arn = {role_arn}']
    if external_id:
        block.append(f'external_id = {external_id}')
    block += ['credential_source = Ec2InstanceMetadata', f'region = {region}', '']
    block_text = chr(10).join(block)

    os.makedirs(os.path.dirname(AWS_CONFIG), exist_ok=True)
    existing = open(AWS_CONFIG).read() if os.path.exists(AWS_CONFIG) else ''

    # 같은 프로필이 있으면 그 블록만 교체 / replace only that block if present
    out, skip = [], False
    for line in existing.split(chr(10)):
        if line.strip().startswith('['):
            skip = line.strip() == f'[profile {profile}]'
        if not skip:
            out.append(line)
    cleaned = chr(10).join(out).rstrip(chr(10))
    with open(AWS_CONFIG, 'w') as f:
        f.write((cleaned + chr(10)*2 if cleaned else '') + block_text)
    print(f'  AWS profile: {profile}')

for acc in accounts:
    acct_id = acc['accountId']
    conn_name = acc['connectionName']
    region = acc.get('region', 'ap-northeast-2')
    is_host = acc.get('isHost', False)

    spc_path = f'{config_dir}/{conn_name}.spc'

    ignore_codes = '''  ignore_error_codes = [
    \"AccessDenied\",
    \"AccessDeniedException\",
    \"NotAuthorized\",
    \"UnauthorizedOperation\",
    \"UnrecognizedClientException\",
    \"AuthorizationError\"
  ]'''

    if is_host:
        # Host account: direct connection (no AssumeRole)
        content = f'''connection \"{conn_name}\" {{
  plugin = \"aws\"
  regions = [\"{region}\"]
{ignore_codes}
}}
'''
    else:
        # Target account: AWS CLI 프로필 경유 AssumeRole
        # (Steampipe AWS 플러그인은 role_arn/external_id 인자를 받지 않는다 —
        #  ~/.aws/config 프로필에 정의하고 profile 인자로 참조한다)
        role_arn = f'arn:aws:iam::{acct_id}:role/{role_name}'
        write_aws_profile(conn_name, role_arn, external_id, region)
        content = f'''connection \"{conn_name}\" {{
  plugin = \"aws\"
  profile = \"{conn_name}\"
  regions = [\"{region}\"]
{ignore_codes}
}}
'''

    with open(spc_path, 'w') as f:
        f.write(content)
    print(f'  Generated: {spc_path}')
"

    # -- [3/4] Generate aggregator connection -----------------------------------
    echo ""
    echo -e "${CYAN}[3/4] Generating aggregator connection (aws.spc)...${NC}"

    echo "$accounts_json" | python3 -c "
import json, sys, os

accounts = json.load(sys.stdin)
config_dir = os.environ['_SP_CONFIG_DIR']

conn_names = [a['connectionName'] for a in accounts]

if len(accounts) == 1:
    # Single account: aws is just an alias
    conn = accounts[0]
    region = conn.get('region', 'ap-northeast-2')
    is_host = conn.get('isHost', False)

    ignore_codes = '''  ignore_error_codes = [
    \"AccessDenied\",
    \"AccessDeniedException\",
    \"NotAuthorized\",
    \"UnauthorizedOperation\",
    \"UnrecognizedClientException\",
    \"AuthorizationError\"
  ]'''

    if is_host:
        content = f'''# AWSops aggregator — single account mode
connection \"aws\" {{
  plugin = \"aws\"
  regions = [\"{region}\"]
{ignore_codes}
}}
'''
    else:
        # Shouldn't happen but handle gracefully
        content = f'''# AWSops aggregator — single account mode
connection \"aws\" {{
  plugin = \"aws\"
  regions = [\"{region}\"]
{ignore_codes}
}}
'''
else:
    # Multi-account: aggregator
    conn_list = ', '.join(f'\"{c}\"' for c in conn_names)
    content = f'''# AWSops aggregator — multi-account mode ({len(accounts)} accounts)
# Queries against \"aws\" connection return merged results from all accounts.
# Use search_path to scope to a specific account: SET search_path = 'public, aws_123456789012';
connection \"aws\" {{
  plugin    = \"aws\"
  type      = \"aggregator\"
  connections = [{conn_list}]
}}
'''

spc_path = f'{config_dir}/aws.spc'
with open(spc_path, 'w') as f:
    f.write(content)
print(f'  Generated: {spc_path}')
print(f'  Mode: {\"aggregator\" if len(accounts) > 1 else \"single\"}')
if len(accounts) > 1:
    print(f'  Connections: {conn_list}')
"

    # -- [4/4] Restart Steampipe ------------------------------------------------
    echo ""
    echo -e "${CYAN}[4/4] Restarting Steampipe service...${NC}"

    steampipe service stop --force 2>/dev/null || true
    sleep 2
    steampipe service start --database-listen network --database-port 9193

    SP_PASSWORD=$(steampipe service status --show-password 2>&1 | grep Password | awk '{print $2}')
    echo "  Steampipe restarted. Password: ${SP_PASSWORD:0:4}****"

    # Update password in config.json
    python3 -c "
import json, sys
config_file = sys.argv[1]
sp_password = sys.argv[2]
try:
    cfg = json.load(open(config_file))
except:
    cfg = {}
cfg['steampipePassword'] = sp_password
json.dump(cfg, open(config_file, 'w'), indent=2)
" "$CONFIG_FILE" "$SP_PASSWORD"

    echo ""
    echo -e "${GREEN}Multi-account configuration applied successfully.${NC}"
    echo -e "${GREEN}Run '$0 verify' to test connectivity.${NC}"
    echo -e "${GREEN}Run 'npm run build && npm start' to restart the dashboard.${NC}"
}

# -- Command: verify (test connectivity) ---------------------------------------
cmd_verify() {
    echo -e "${CYAN}Verifying cross-account connectivity...${NC}"
    echo ""
    # psql은 호스트에 설치돼 있지 않다 — 대시보드 API(localhost:3000)로 계정별 조회를 확인한다
    # psql is not installed on the host; query each account through the dashboard API instead
    if ! curl -s -o /dev/null --max-time 5 http://localhost:3000/; then
        echo -e "  ${RED}FAIL${NC} dashboard not reachable on :3000 — run scripts/09-start-all.sh first"
        return 1
    fi

    get_accounts_json | python3 -c "
import json, sys, time, urllib.request

accounts = json.load(sys.stdin)
if not accounts:
    print('  No accounts configured.')
    sys.exit(0)

def query(sql, account_id=None):
    # 고유 주석으로 5분 결과 캐시를 우회 / unique comment bypasses the 5-min result cache
    body = {'queries': {'q': f'{sql} /* verify {time.time_ns()} */'}}
    if account_id:
        body['accountId'] = account_id
    req = urllib.request.Request('http://localhost:3000/api/steampipe', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=90) as r:
        res = json.load(r)['q']
    if res.get('error'):
        raise RuntimeError(res['error'][:80])
    return res.get('rows', [])

ok = fail = 0
for acc in accounts:
    acct_id, alias = acc['accountId'], acc['alias']
    try:
        rows = query('SELECT account_id FROM aws_account LIMIT 1', acct_id)
        got = rows[0]['account_id'] if rows else ''
        if got == acct_id:
            print(f'  {acct_id} ({alias:16s}): \033[0;32mOK\033[0m')
            ok += 1
        else:
            shown = got or 'no rows'
            print(f'  {acct_id} ({alias:16s}): \033[0;31mFAIL\033[0m (returned: {shown})')
            fail += 1
    except Exception as e:
        print(f'  {acct_id} ({alias:16s}): \033[0;31mFAIL\033[0m ({e})')
        fail += 1

print()
print(f'  Results: {ok} OK, {fail} FAILED, {len(accounts)} total')
print()
try:
    ids = sorted({r['account_id'] for r in query('SELECT DISTINCT account_id FROM aws_account')})
    print(f'  Aggregator: \033[0;32mOK\033[0m ({len(ids)} account(s) visible)')
    for i in ids:
        print(f'    - {i}')
except Exception as e:
    print(f'  Aggregator: \033[0;31mFAIL\033[0m ({e})')
    fail += 1
sys.exit(1 if fail else 0)
"
}

# -- Command: cfn (print CloudFormation deploy command) ------------------------
cmd_cfn() {
    local target_id="$2"

    if [ -z "$target_id" ]; then
        echo -e "${RED}ERROR: Usage: $0 cfn <target_account_id>${NC}"
        exit 1
    fi

    echo -e "${CYAN}CloudFormation deployment command for account ${target_id}:${NC}"
    echo ""
    echo "  1. Switch to target account credentials (profile or SSO):"
    echo "     export AWS_PROFILE=<target-account-profile>"
    echo ""
    echo "  2. Deploy the IAM role stack:"
    echo "     aws cloudformation deploy \\"
    echo "       --template-file $(realpath "$WORK_DIR/infra-cdk/cfn-target-account-role.yaml") \\"
    echo "       --stack-name awsops-cross-account-role \\"
    echo "       --parameter-overrides \\"
    echo "         HostAccountId=${HOST_ACCOUNT_ID} \\"
    echo "         ExternalId=${EXTERNAL_ID} \\"
    echo "         RoleName=${ROLE_NAME} \\"
    echo "       --capabilities CAPABILITY_NAMED_IAM \\"
    echo "       --region ${REGION}"
    echo ""
    echo "  3. After deployment, return to host account and add:"
    echo "     $0 add ${target_id} <alias> [region]"
    echo ""
    echo "  Template: infra-cdk/cfn-target-account-role.yaml"
}

# -- Route command -------------------------------------------------------------
case "$1" in
    init)   cmd_init "$@" ;;
    add)    cmd_add "$@" ;;
    remove) cmd_remove "$@" ;;
    list)   cmd_list ;;
    apply)  cmd_apply ;;
    verify) cmd_verify ;;
    cfn)    cmd_cfn "$@" ;;
    *)      usage ;;
esac
