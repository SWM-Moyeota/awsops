"""
AWSops Health Watchdog Lambda - out-of-server Slack health alerts
AWSops 헬스 워치독 람다 - 서버 외부에서 동작하는 Slack 헬스 알림

Triggered by EventBridge (schedule every 5 min, EC2 state-change, CloudTrail Stop/Terminate API call).
Detects: EC2 stop/start, dashboard unhealthy behind the ALB, stale in-server heartbeat,
public URL not redirecting to Cognito. Posts to Slack only on state transitions (ok->fail after 2
consecutive failing runs), at most one bundled message per invocation.
EventBridge(5분 주기, EC2 상태 변경, CloudTrail Stop/Terminate API 호출)로 실행되며 상태 전이 시에만
(장애는 연속 2회 실패 시) 실행당 1건으로 묶어 Slack으로 알린다.

Standalone: does NOT import cross_account (packaged alone). boto3 is imported lazily so
decide() can be unit-tested without AWS credentials or boto3.
단독 패키징: cross_account를 import하지 않는다. boto3는 지연 import하여 AWS 없이 decide() 테스트 가능.

Env: INSTANCE_ID, ALB_NAME, DASHBOARD_URL, WEBHOOK_PARAM, STATE_PARAM
"""
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HEARTBEAT_NAMESPACE = "AWSops/Health"
HEARTBEAT_METRIC = "Heartbeat"
HEARTBEAT_STALE_SEC = 900      # heartbeat considered stale beyond 15 min / 15분 초과 시 stale
LAUNCH_GRACE_SEC = 900         # no dashboard/heartbeat/external judgement within 15 min of launch / 기동 후 15분 유예
ACTOR_TTL_SEC = 600            # api-call actor valid for the following state-change / actor 유효시간
STOPPED_STATES = ("stopping", "stopped", "shutting-down", "terminated")
KST = timezone(timedelta(hours=9))


# ---------------------------------------------------------------------------
# Pure decision logic / 순수 판정 로직
# ---------------------------------------------------------------------------
# Same remediation command as REMEDIATION.steampipe in src/lib/health/slack.ts / 서버 내 알림과 동일한 명령
START_CMD = 'SSM 접속 후 `sudo su - ec2-user -c "cd ~/awsops && bash scripts/09-start-all.sh"`'
FAIL_THRESHOLD = 2             # ok|unknown -> fail needs 2 consecutive failing runs / 연속 2회 실패 시 장애
JUDGED_ITEMS = ("dashboard", "heartbeat", "external")
# Observation sentinel: the AWS lookup itself failed (throttling, network, AccessDenied).
# The item is left unchanged — no counter change, no alert. / 조회 자체 실패: 항목 상태를 바꾸지 않음
LOOKUP_ERROR = "lookup-error"


def _fmt_time(now):
    return datetime.fromtimestamp(now, KST).strftime("%Y-%m-%d %H:%M KST")


def _block(emoji, title, cause=None, action=None):
    """One item block, same labels as formatSlackMessage (slack.ts). / slack.ts와 같은 항목 블록"""
    lines = [f"{emoji} [AWSops] {title}"]
    if cause:
        lines.append(f"• 원인: {cause}")
    if action:
        lines.append(f"• 조치: {action}")
    return "\n".join(lines)


def format_message(blocks, now):
    """Bundle all blocks of one run into one Slack text, time + link once at the end (slack.ts layout).
    한 번의 실행에서 나온 블록을 하나의 메시지로 묶는다 (시각·대시보드 링크는 끝에 1회)."""
    lines = []
    for b in blocks:
        lines.append(b)
        lines.append("")
    lines.append(f"🕐 {_fmt_time(now)}")
    link = os.environ.get("DASHBOARD_URL", "")
    if link:
        lines.append(f"🔗 대시보드: {link}")
    return "\n".join(lines)


def _reset_items(state):
    """Forget pre-stop observations on stop/start transitions. / 중지·시작 전이 시 항목 상태·카운터 초기화"""
    for k in JUDGED_ITEMS:
        state[k] = "unknown"
    state["fails"] = {k: 0 for k in JUDGED_ITEMS}


def _judge(state, item, observed, fail_title, fail_cause, fail_action, ok_title, texts):
    """Debounced transition: fail after FAIL_THRESHOLD consecutive failures, recover on 1 success.
    unknown->ok is silent; LOOKUP_ERROR leaves the item untouched. / 디바운스된 전이 판정"""
    if observed == LOOKUP_ERROR:
        return
    fails = state["fails"]
    if observed == "ok":
        fails[item] = 0
        if state[item] == "fail":
            texts.append(_block("🟢", ok_title))
        state[item] = "ok"
        return
    fails[item] = fails.get(item, 0) + 1
    if state[item] != "fail" and fails[item] >= FAIL_THRESHOLD:
        texts.append(_block("🔴", fail_title, fail_cause, fail_action))
        state[item] = "fail"


def decide(prev, obs, now):
    """Return (new_state, slack_blocks) from previous state and current observation.
    이전 상태와 현재 관측값으로 (새 상태, Slack 블록 목록)을 반환. 발송 시 format_message()로 묶는다."""
    state = {
        "server": "unknown",
        "dashboard": "unknown",
        "heartbeat": "unknown",
        "external": "unknown",
    }
    state.update(prev or {})
    fails = {k: 0 for k in JUDGED_ITEMS}
    fails.update((prev or {}).get("fails") or {})
    state["fails"] = fails  # fresh dict: never mutate prev / prev 불변
    texts = []
    source = obs.get("source")

    # api-call: only remember who did it; the state-change message uses it.
    # api-call은 실행자만 기록한다. 이미 중지 상태(state-change 선행)면 아무것도 하지 않는다.
    if source == "api-call":
        if state["server"] != "stopped" and obs.get("actor"):
            state["last_actor"] = obs["actor"]
            state["last_actor_at"] = now
        return state, texts

    ec2_state = obs.get("ec2_state")

    if ec2_state in STOPPED_STATES:
        if state["server"] != "stopped":
            if state["server"] == "running":
                actor = None
                if state.get("last_actor") and now - state.get("last_actor_at", 0) <= ACTOR_TTL_SEC:
                    actor = state["last_actor"]
                cause = "EC2 인스턴스가 중지되었습니다"
                if actor:
                    cause += f" (실행자: {actor})"
                texts.append(_block("🛑", "서버 중지", cause, "의도한 중지가 아니라면 EC2 인스턴스를 시작하세요"))
            _reset_items(state)
        state["server"] = "stopped"
        state.pop("last_actor", None)
        state.pop("last_actor_at", None)
        return state, texts  # other items unchanged and silent while stopped / 중지 중에는 다른 항목 유지·무음

    if ec2_state == "running":
        if state["server"] == "stopped":
            state["server"] = "running"
            _reset_items(state)
            texts.append(_block("▶️", "서버 시작", "EC2 인스턴스가 다시 실행되었습니다", START_CMD))
            return state, texts  # services are not up yet; evaluate from the next run / 서비스 기동 전이므로 다음 실행부터 평가
        state["server"] = "running"
    else:
        # None (describe failed) / pending / unknown state: no judgement
        # 상태를 알 수 없거나 pending이면 판정하지 않는다.
        return state, texts

    # Post-launch grace (or launch time unknown): boot noise is not judged at all.
    # 기동 후 15분 유예(또는 기동 시각 미상) 동안은 대시보드·하트비트·외부 접속을 판정하지 않는다.
    launch = obs.get("launch_epoch")
    if launch is None or now - launch < LAUNCH_GRACE_SEC:
        return state, texts

    # --- Server is running: evaluate the rest / 서버 실행 중: 나머지 항목 평가 ---
    targets = obs.get("targets")
    if targets == LOOKUP_ERROR:
        dash, detail = LOOKUP_ERROR, ""
    else:
        dash = "ok" if targets and all(v == "healthy" for v in targets.values()) else "fail"
        if targets is None:
            detail = "ALB 또는 타겟 그룹을 찾을 수 없음"
        elif not targets:
            detail = "등록된 타겟이 없음"
        else:
            bad = [f"{k}={v}" for k, v in targets.items() if v != "healthy"]
            detail = "unhealthy 타겟: " + ", ".join(bad[:3]) if bad else ""
    _judge(
        state, "dashboard", dash,
        "대시보드 장애", f"ALB 타겟 헬스체크 실패 ({detail})",
        "서버에서 대시보드 프로세스(09-start-all.sh)와 nginx 상태를 확인하세요",
        "대시보드 복구", texts,
    )

    age = obs.get("heartbeat_age_sec")
    if age == LOOKUP_ERROR:
        hb = LOOKUP_ERROR
    else:
        hb = "fail" if (age is None or age > HEARTBEAT_STALE_SEC) else "ok"
    _judge(
        state, "heartbeat", hb,
        "모니터 하트비트 장애", "서버 내부 모니터의 하트비트가 15분 넘게 들어오지 않았습니다",
        "Next.js가 실행되지 않았을 수 있습니다 — 위 09-start-all.sh 명령 실행",
        "모니터 하트비트 복구", texts,
    )

    status = obs.get("url_status")
    ext = "ok" if (status == 302 and "amazoncognito.com" in (obs.get("url_location") or "")) else "fail"
    if status is None:
        ext_cause = "공개 URL 응답 없음 (DNS/인증서/타임아웃)"
    else:
        ext_cause = f"공개 URL이 Cognito 로그인으로 리다이렉트되지 않습니다 (HTTP {status})"
    _judge(
        state, "external", ext,
        "외부 접속 장애", ext_cause,
        "ALB 리스너(authenticate-cognito) 규칙과 Cognito 설정을 확인하세요",
        "외부 접속 복구", texts,
    )

    return state, texts


# ---------------------------------------------------------------------------
# AWS / network helpers (never raise on observation errors) / 관측 헬퍼
# ---------------------------------------------------------------------------
def _log(msg):
    print(f"[health_watchdog] {msg}")


def _client(name):
    import boto3  # lazy: keeps decide() importable without boto3 / 지연 import
    return boto3.client(name)


def _describe_instance(instance_id):
    """Return (state_name, launch_epoch) or (None, None). / (상태, 기동 epoch) 또는 (None, None)"""
    try:
        res = _client("ec2").describe_instances(InstanceIds=[instance_id])
        inst = res["Reservations"][0]["Instances"][0]
        return inst["State"]["Name"], inst["LaunchTime"].timestamp()
    except Exception as e:
        _log(f"describe_instances failed: {type(e).__name__}")
        return None, None


NOT_FOUND_CODES = (
    "LoadBalancerNotFound", "LoadBalancerNotFoundException",
    "TargetGroupNotFound", "TargetGroupNotFoundException",
)


def _error_code(e):
    """botocore ClientError code, or None. / ClientError 코드 추출"""
    resp = getattr(e, "response", None)
    if isinstance(resp, dict):
        return (resp.get("Error") or {}).get("Code")
    return None


def _get_targets(alb_name):
    """Return {tg:target -> state}; None if the ALB/TG does not exist (a real failure);
    LOOKUP_ERROR on any other API error (throttling, network, AccessDenied).
    ALB/TG가 없으면 None(실패), 그 외 API 오류는 LOOKUP_ERROR(판정 보류)."""
    try:
        elbv2 = _client("elbv2")
        lbs = elbv2.describe_load_balancers(Names=[alb_name])["LoadBalancers"]
        if not lbs:
            return None
        tgs = elbv2.describe_target_groups(LoadBalancerArn=lbs[0]["LoadBalancerArn"])["TargetGroups"]
        if not tgs:
            return None
        out = {}
        for tg in tgs:
            descs = elbv2.describe_target_health(TargetGroupArn=tg["TargetGroupArn"])["TargetHealthDescriptions"]
            if not descs:
                out[f"{tg['TargetGroupName']}:none"] = "no-targets"
            for d in descs:
                out[f"{tg['TargetGroupName']}:{d['Target']['Id']}"] = d["TargetHealth"]["State"]
        return out
    except Exception as e:
        code = _error_code(e)
        if code in NOT_FOUND_CODES:
            _log(f"target health lookup: {code}")
            return None
        _log(f"target health lookup failed: {code or type(e).__name__}")
        return LOOKUP_ERROR


def _heartbeat_age(now):
    """Seconds since newest Heartbeat datapoint in the last 20 min; None if there is none;
    LOOKUP_ERROR if the API call failed. / 최신 하트비트 경과 초 (없으면 None, 조회 실패는 LOOKUP_ERROR)"""
    try:
        end = datetime.fromtimestamp(now, timezone.utc)
        res = _client("cloudwatch").get_metric_data(
            MetricDataQueries=[{
                "Id": "hb",
                "MetricStat": {
                    "Metric": {"Namespace": HEARTBEAT_NAMESPACE, "MetricName": HEARTBEAT_METRIC},
                    "Period": 300,
                    "Stat": "Maximum",
                },
                "ReturnData": True,
            }],
            StartTime=end - timedelta(minutes=20),
            EndTime=end,
        )
        stamps = res["MetricDataResults"][0].get("Timestamps") or []
        if not stamps:
            return None
        return max(0.0, now - max(t.timestamp() for t in stamps))
    except Exception as e:
        _log(f"get_metric_data failed: {_error_code(e) or type(e).__name__}")
        return LOOKUP_ERROR


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # surface 3xx as HTTPError instead of following / 리다이렉트를 따라가지 않음


def _check_url(url):
    """GET without following redirects. Return (status, location), or (None, None) when there is no
    HTTP response (DNS/cert/timeout) — a real external failure, judged as such. / 리다이렉트 미추적 GET"""
    if not url:
        return None, None
    try:
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "awsops-health-watchdog"})
        with opener.open(req, timeout=10) as r:
            return r.status, r.headers.get("Location")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Location") if e.headers else None
    except Exception as e:
        _log(f"url check failed: {type(e).__name__}")
        return None, None


# ---------------------------------------------------------------------------
# State / Slack (SSM Parameter Store) / 상태·Slack
# ---------------------------------------------------------------------------
def _load_state(param):
    ssm = _client("ssm")
    try:
        val = ssm.get_parameter(Name=param)["Parameter"]["Value"]
        data = json.loads(val)
        return data if isinstance(data, dict) else {}
    except ssm.exceptions.ParameterNotFound:
        return {}
    except ValueError:
        _log("state parameter is not valid JSON; starting fresh")
        return {}


def _save_state(param, state):
    _client("ssm").put_parameter(Name=param, Value=json.dumps(state), Type="String", Overwrite=True)


def _get_webhook(param):
    try:
        return _client("ssm").get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"].strip()
    except Exception as e:
        _log(f"webhook parameter unavailable: {type(e).__name__}")
        return None


def _post_slack(webhook, text):
    """Never log the webhook URL or exception text (may embed it). / webhook URL·예외 문구는 로그 금지"""
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps({"text": text}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        _log(f"slack post failed: HTTP {e.code}")
    except Exception as e:
        _log(f"slack post failed: {type(e).__name__}")
    return False


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def _parse_event(event, instance_id):
    """Map an EventBridge event to (source, ec2_state, actor); None source = ignore. / 이벤트 해석"""
    event = event if isinstance(event, dict) else {}
    detail = event.get("detail") or {}
    dtype = event.get("detail-type", "")

    if dtype == "EC2 Instance State-change Notification":
        if detail.get("instance-id") != instance_id:
            return None, None, None
        return "state-change", detail.get("state"), None

    if dtype == "AWS API Call via CloudTrail":
        if detail.get("eventName") not in ("StopInstances", "TerminateInstances"):
            return None, None, None
        items = ((detail.get("requestParameters") or {}).get("instancesSet") or {}).get("items") or []
        if instance_id not in [i.get("instanceId") for i in items]:
            return None, None, None
        ident = detail.get("userIdentity") or {}
        actor = ident.get("arn") or ident.get("principalId") or "unknown"
        return "api-call", None, actor

    return "schedule", None, None


def lambda_handler(event, context):
    instance_id = os.environ.get("INSTANCE_ID", "")
    alb_name = os.environ.get("ALB_NAME", "awsops-alb")
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    webhook_param = os.environ.get("WEBHOOK_PARAM", "/awsops/slack-webhook-url")
    state_param = os.environ.get("STATE_PARAM", "/awsops/health/watchdog-state")
    now = time.time()

    source, event_state, actor = _parse_event(event, instance_id)
    if source is None:
        return {"ok": True, "ignored": True}

    obs = {
        "source": source, "ec2_state": None, "launch_epoch": None, "actor": actor,
        "heartbeat_age_sec": None, "targets": None, "url_status": None, "url_location": None,
    }
    if source != "api-call":
        # Prefer the live state: a delayed/stale event must not override what EC2 reports now.
        # 실시간 상태 우선 — 지연된 이벤트가 현재 상태를 덮어쓰지 않도록. describe 실패 시에만 이벤트 상태 사용.
        ec2_state, launch = _describe_instance(instance_id)
        obs["ec2_state"] = ec2_state or event_state
        obs["launch_epoch"] = launch
        if obs["ec2_state"] == "running":
            obs["targets"] = _get_targets(alb_name)
            obs["heartbeat_age_sec"] = _heartbeat_age(now)
            obs["url_status"], obs["url_location"] = _check_url(dashboard_url)

    # A state read error (other than not-found) raises so async invoke retries; never guess state.
    # 상태 읽기 오류는 예외를 올려 재시도시킨다(상태를 추측하지 않음).
    prev = _load_state(state_param)
    new_state, texts = decide(prev, obs, now)

    if texts:
        webhook = _get_webhook(webhook_param)
        if not webhook:
            _log("no webhook; state not saved so alerts are retried on the next run")
            return {"ok": False, "error": "webhook unavailable"}
        # One post per invocation: all-or-nothing, so a retry never re-sends half a batch.
        # 실행당 Slack 1건 — 실패 시 상태를 저장하지 않으므로 다음 실행에서 묶음 전체가 재평가·재발송된다.
        if not _post_slack(webhook, format_message(texts, now)):
            return {"ok": False, "error": "slack post failed"}

    if new_state != prev:
        _save_state(state_param, new_state)
    return {"ok": True, "source": source, "sent": len(texts), "server": new_state.get("server")}
