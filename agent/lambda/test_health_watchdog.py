"""
Unit tests for health_watchdog — no AWS access, stdlib unittest only.
health_watchdog 단위 테스트 — AWS 호출 없음, stdlib unittest 전용 (boto3 클라이언트는 가짜 객체로 대체).

Run: cd agent/lambda && python3 -m unittest test_health_watchdog -v
"""
import os
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

import health_watchdog as hw

NOW = 1_800_000_000.0  # arbitrary fixed epoch
GOOD_TARGETS = {"tg-1:i-abc": "healthy"}
COGNITO = "https://auth.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize?x=1"
START_CMD = 'SSM 접속 후 `sudo su - ec2-user -c "cd ~/awsops && bash scripts/09-start-all.sh"`'


def prev_state(**kw):
    s = {"server": "running", "dashboard": "ok", "heartbeat": "ok", "external": "ok"}
    s.update(kw)
    return s


def obs(**kw):
    o = {
        "source": "schedule",
        "ec2_state": "running",
        "launch_epoch": NOW - 7 * 86400,
        "actor": None,
        "heartbeat_age_sec": 120.0,
        "targets": dict(GOOD_TARGETS),
        "url_status": 302,
        "url_location": COGNITO,
    }
    o.update(kw)
    return o


def run_seq(state, observations, start=NOW, step=300):
    """Feed observations 5 min apart; return (final_state, all_texts)."""
    texts = []
    t = start
    for o in observations:
        state, out = hw.decide(state, o, t)
        texts.extend(out)
        t += step
    return state, texts


class DecideTest(unittest.TestCase):
    def test_stopping_then_stopped_alerts_once(self):
        st, texts = hw.decide(prev_state(), obs(source="state-change", ec2_state="stopping"), NOW)
        self.assertEqual(st["server"], "stopped")
        self.assertEqual(len(texts), 1)
        self.assertIn("🛑", texts[0])
        self.assertIn("[AWSops]", texts[0])
        st2, texts2 = hw.decide(st, obs(source="state-change", ec2_state="stopped"), NOW + 30)
        self.assertEqual(st2["server"], "stopped")
        self.assertEqual(texts2, [])

    def test_terminated_and_shutting_down_map_to_stopped(self):
        for s in ("terminated", "shutting-down"):
            st, texts = hw.decide(prev_state(), obs(source="state-change", ec2_state=s), NOW)
            self.assertEqual(st["server"], "stopped", s)
            self.assertEqual(len(texts), 1, s)
            self.assertIn("🛑", texts[0])

    def test_stop_includes_actor_from_prior_api_call(self):
        st, texts = hw.decide(prev_state(), obs(source="api-call", ec2_state=None, actor="arn:aws:iam::1:user/kim"), NOW)
        self.assertEqual(texts, [])
        self.assertEqual(st["server"], "running")
        st, texts = hw.decide(st, obs(source="state-change", ec2_state="stopping"), NOW + 60)
        self.assertEqual(len(texts), 1)
        self.assertIn("arn:aws:iam::1:user/kim", texts[0])

    def test_api_call_after_state_change_emits_nothing(self):
        st, _ = hw.decide(prev_state(), obs(source="state-change", ec2_state="stopping"), NOW)
        st2, texts = hw.decide(st, obs(source="api-call", ec2_state=None, actor="someone"), NOW + 300)
        self.assertEqual(texts, [])
        self.assertEqual(st2["server"], "stopped")

    def test_running_after_stop_alerts_with_full_start_command(self):
        st, texts = hw.decide(prev_state(server="stopped"), obs(source="state-change", ec2_state="running", launch_epoch=NOW - 5), NOW)
        self.assertEqual(st["server"], "running")
        self.assertEqual(len(texts), 1)
        self.assertIn("▶️", texts[0])
        self.assertIn(START_CMD, texts[0])

    def test_quiet_while_stopped(self):
        p = prev_state(server="stopped")
        st, texts = hw.decide(
            p,
            obs(ec2_state="stopped", targets=None, heartbeat_age_sec=None, url_status=503, url_location=None),
            NOW,
        )
        self.assertEqual(texts, [])
        self.assertEqual(st["server"], "stopped")
        for k in ("dashboard", "heartbeat", "external"):
            self.assertEqual(st[k], p[k])

    def test_heartbeat_grace_period_after_launch(self):
        st, texts = hw.decide(prev_state(), obs(launch_epoch=NOW - 600, heartbeat_age_sec=None), NOW)
        self.assertEqual(texts, [])
        self.assertNotEqual(st["heartbeat"], "fail")
        # exactly at the 900s boundary the grace period is over: two failing runs -> alert
        st, texts = run_seq(prev_state(), [obs(launch_epoch=NOW - 900, heartbeat_age_sec=None)] * 2)
        self.assertEqual(st["heartbeat"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("Next.js가 실행되지 않았을 수 있습니다 — 위 09-start-all.sh 명령 실행", texts[0])

    def test_heartbeat_age_900_is_ok_901_is_stale(self):
        st, texts = run_seq(prev_state(), [obs(heartbeat_age_sec=900.0)] * 3)
        self.assertEqual(st["heartbeat"], "ok")
        self.assertEqual(texts, [])
        st, texts = run_seq(prev_state(), [obs(heartbeat_age_sec=901.0)] * 2)
        self.assertEqual(st["heartbeat"], "fail")

    def test_heartbeat_stale_alerts_once_then_recovers(self):
        st, texts = hw.decide(prev_state(), obs(heartbeat_age_sec=1200.0), NOW)
        self.assertEqual(texts, [])  # 1st failing observation: debounced
        st, texts = hw.decide(st, obs(heartbeat_age_sec=1500.0), NOW + 300)
        self.assertEqual(st["heartbeat"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("🔴", texts[0])
        st, texts = hw.decide(st, obs(heartbeat_age_sec=1800.0), NOW + 600)
        self.assertEqual(texts, [])
        st, texts = hw.decide(st, obs(heartbeat_age_sec=60.0), NOW + 900)
        self.assertEqual(st["heartbeat"], "ok")
        self.assertEqual(len(texts), 1)
        self.assertIn("🟢", texts[0])

    def test_debounce_one_fail_no_alert_two_fails_alert(self):
        for item, bad in (
            ("dashboard", {"targets": {"tg-1:i-abc": "unhealthy"}}),
            ("heartbeat", {"heartbeat_age_sec": None}),
            ("external", {"url_status": 502, "url_location": None}),
        ):
            st, texts = hw.decide(prev_state(), obs(**bad), NOW)
            self.assertEqual(texts, [], item)
            self.assertEqual(st[item], "ok", item)
            # an ok in between resets the counter
            st, texts = hw.decide(st, obs(), NOW + 300)
            st, texts = hw.decide(st, obs(**bad), NOW + 600)
            self.assertEqual(texts, [], item)
            st, texts = hw.decide(st, obs(**bad), NOW + 900)
            self.assertEqual(st[item], "fail", item)
            self.assertEqual(len(texts), 1, item)
            self.assertIn("장애", texts[0])

    def test_unknown_to_fail_also_needs_two(self):
        st, texts = hw.decide({}, obs(targets={"tg-1:i-abc": "unhealthy"}), NOW)
        self.assertEqual(texts, [])
        self.assertEqual(st["dashboard"], "unknown")
        st, texts = hw.decide(st, obs(targets={"tg-1:i-abc": "unhealthy"}), NOW + 300)
        self.assertEqual(st["dashboard"], "fail")
        self.assertEqual(len(texts), 1)

    def test_missing_target_group_is_dashboard_fail(self):
        st, texts = run_seq(prev_state(), [obs(targets=None)] * 2)
        self.assertEqual(st["dashboard"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("🔴", texts[0])
        self.assertIn("ALB 또는 타겟 그룹을 찾을 수 없음", texts[0])
        st, texts = hw.decide(st, obs(targets={"tg-1:i-abc": "unhealthy"}), NOW + 600)
        self.assertEqual(texts, [])
        st, texts = hw.decide(st, obs(), NOW + 900)
        self.assertEqual(st["dashboard"], "ok")
        self.assertIn("🟢", texts[0])

    def test_lookup_error_leaves_state_unchanged(self):
        # one real failure, then lookup errors: counter must not advance, no alert
        st, _ = hw.decide(prev_state(), obs(targets=None, heartbeat_age_sec=None), NOW)
        before = {k: st[k] for k in ("dashboard", "heartbeat")}
        fails_before = dict(st["fails"])
        for i in range(1, 4):
            st, texts = hw.decide(st, obs(targets=hw.LOOKUP_ERROR, heartbeat_age_sec=hw.LOOKUP_ERROR), NOW + 300 * i)
            self.assertEqual(texts, [])
        self.assertEqual({k: st[k] for k in ("dashboard", "heartbeat")}, before)
        self.assertEqual(st["fails"]["dashboard"], fails_before["dashboard"])
        self.assertEqual(st["fails"]["heartbeat"], fails_before["heartbeat"])
        # a failing item stays fail during lookup errors (no false recovery)
        st, _ = run_seq(prev_state(), [obs(targets=None)] * 2)
        st, texts = hw.decide(st, obs(targets=hw.LOOKUP_ERROR), NOW + 3000)
        self.assertEqual(st["dashboard"], "fail")
        self.assertEqual(texts, [])

    def test_external_requires_302_to_cognito(self):
        st, texts = run_seq(prev_state(), [obs(url_status=200, url_location=None)] * 2)
        self.assertEqual(st["external"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("HTTP 200", texts[0])
        st, texts = run_seq(prev_state(), [obs(url_status=302, url_location="https://evil.example.com/login")] * 2)
        self.assertEqual(st["external"], "fail")
        self.assertEqual(len(texts), 1)
        st, texts = run_seq(prev_state(), [obs(url_status=None, url_location=None)] * 2)
        self.assertEqual(st["external"], "fail")
        self.assertIn("응답 없음 (DNS/인증서/타임아웃)", texts[0])
        self.assertNotIn("HTTP None", texts[0])
        st, texts = hw.decide(prev_state(), obs(), NOW)
        self.assertEqual(st["external"], "ok")
        self.assertEqual(texts, [])

    def test_dashboard_and_external_grace_after_launch(self):
        bad = dict(targets={"tg-1:i-abc": "unhealthy"}, heartbeat_age_sec=None, url_status=502, url_location=None)
        st, texts = run_seq(prev_state(), [obs(launch_epoch=NOW - 60, **bad)] * 3, step=200)
        self.assertEqual(texts, [])
        for k in ("dashboard", "heartbeat", "external"):
            self.assertEqual(st[k], "ok", k)
            self.assertEqual(st.get("fails", {}).get(k, 0), 0, k)
        # launch time unknown (describe failed) -> no judgement either
        st, texts = run_seq(prev_state(), [obs(launch_epoch=None, **bad)] * 3)
        self.assertEqual(texts, [])

    def test_counters_reset_across_stop_start(self):
        # one failing observation before the stop must not combine with one after the start
        st, _ = hw.decide(prev_state(), obs(targets={"tg-1:i-abc": "unhealthy"}), NOW)
        self.assertEqual(st["fails"]["dashboard"], 1)
        st, texts = hw.decide(st, obs(source="state-change", ec2_state="stopping"), NOW + 60)
        self.assertEqual(len(texts), 1)
        for k in ("dashboard", "heartbeat", "external"):
            self.assertEqual(st[k], "unknown", k)
            self.assertEqual(st["fails"][k], 0, k)
        launch = NOW + 600
        st, texts = hw.decide(st, obs(source="state-change", ec2_state="running", launch_epoch=launch), launch)
        self.assertIn("▶️", texts[0])
        for k in ("dashboard", "heartbeat", "external"):
            self.assertEqual(st[k], "unknown", k)
            self.assertEqual(st["fails"][k], 0, k)
        st, texts = hw.decide(st, obs(targets={"tg-1:i-abc": "unhealthy"}, launch_epoch=launch), launch + 900)
        self.assertEqual(texts, [])
        self.assertEqual(st["fails"]["dashboard"], 1)

    def test_normal_stop_start_cycle_yields_only_stop_and_start(self):
        # spec §7#3: stop -> start, 09-start-all.sh run within 15 min -> exactly 🛑 then ▶️
        texts = []
        st, out = hw.decide(prev_state(), obs(source="api-call", ec2_state=None, actor="arn:aws:iam::1:user/kim"), NOW)
        texts += out
        st, out = hw.decide(st, obs(source="state-change", ec2_state="stopping"), NOW + 5)
        texts += out
        st, out = hw.decide(st, obs(source="state-change", ec2_state="stopped"), NOW + 60)
        texts += out
        stopped_bad = dict(ec2_state="stopped", targets=None, heartbeat_age_sec=None, url_status=503, url_location=None)
        st, out = run_seq(st, [obs(**stopped_bad)] * 3, start=NOW + 300)
        texts += out
        launch = NOW + 1200
        st, out = hw.decide(st, obs(source="state-change", ec2_state="pending", launch_epoch=launch), launch)
        texts += out
        st, out = hw.decide(st, obs(source="state-change", ec2_state="running", launch_epoch=launch), launch + 20)
        texts += out
        boot = dict(launch_epoch=launch, targets={"tg-1:i-abc": "unhealthy"}, heartbeat_age_sec=None,
                    url_status=502, url_location=None)
        # boot noise for ~12 min, then 09-start-all.sh fixes everything
        st, out = run_seq(st, [obs(**boot)] * 3, start=launch + 60, step=240)
        texts += out
        st, out = run_seq(st, [obs(launch_epoch=launch)] * 6, start=launch + 780)
        texts += out
        self.assertEqual(len(texts), 2, texts)
        self.assertIn("🛑", texts[0])
        self.assertIn("▶️", texts[1])
        for k in ("dashboard", "heartbeat", "external"):
            self.assertEqual(st[k], "ok", k)

    def test_first_run_unknown_to_ok_is_silent(self):
        st, texts = hw.decide({}, obs(), NOW)
        self.assertEqual(texts, [])
        self.assertEqual(st["server"], "running")
        self.assertEqual(st["dashboard"], "ok")

    def test_prev_not_mutated(self):
        p = prev_state(fails={"dashboard": 1, "heartbeat": 0, "external": 0})
        snapshot = {**p, "fails": dict(p["fails"])}
        hw.decide(p, obs(targets=None), NOW)
        self.assertEqual(p, snapshot)


class FormatTest(unittest.TestCase):
    def test_message_layout_matches_in_server_format(self):
        # 1_800_000_000 = 2027-01-15 08:00:00 UTC = 17:00 KST
        _, blocks = hw.decide(prev_state(), obs(source="state-change", ec2_state="stopped"), NOW)
        with mock.patch.dict(os.environ, {"DASHBOARD_URL": "https://awsops.moyeota.co.kr/"}):
            text = hw.format_message(blocks, NOW)
        lines = text.split("\n")
        self.assertEqual(lines[0], "🛑 [AWSops] 서버 중지")
        self.assertTrue(lines[1].startswith("• 원인: "))
        self.assertTrue(lines[2].startswith("• 조치: "))
        self.assertEqual(lines[3], "")
        self.assertEqual(lines[4], "🕐 2027-01-15 17:00 KST")
        self.assertEqual(lines[5], "🔗 대시보드: https://awsops.moyeota.co.kr/")

    def test_bundles_blocks_with_one_time_and_link(self):
        st = prev_state(dashboard="fail", external="fail")
        _, blocks = hw.decide(st, obs(), NOW)
        self.assertEqual(len(blocks), 2)
        text = hw.format_message(blocks, NOW)
        self.assertEqual(text.count("🟢"), 2)
        self.assertEqual(text.count("🕐"), 1)


# ---------------------------------------------------------------------------
# Handler-level tests with fake boto3 clients / 가짜 boto3 클라이언트로 핸들러 테스트
# ---------------------------------------------------------------------------
class FakeClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeSSM:
    class exceptions:  # noqa: N801 — mimics boto3 client.exceptions
        class ParameterNotFound(Exception):
            pass

    def __init__(self, state_json=None):
        self.params = {"/awsops/slack-webhook-url": "https://hooks.slack.com/services/T/B/SECRET"}
        if state_json is not None:
            self.params["/awsops/health/watchdog-state"] = state_json
        self.puts = []

    def get_parameter(self, Name, WithDecryption=False):  # noqa: N803
        if Name not in self.params:
            raise self.exceptions.ParameterNotFound()
        return {"Parameter": {"Value": self.params[Name]}}

    def put_parameter(self, Name, Value, Type, Overwrite):  # noqa: N803
        self.params[Name] = Value
        self.puts.append(Value)


class FakeEC2:
    def __init__(self, state, launch_epoch):
        self.state, self.launch = state, launch_epoch

    def describe_instances(self, InstanceIds):  # noqa: N803
        if self.state is None:
            raise FakeClientError("RequestLimitExceeded")
        return {"Reservations": [{"Instances": [{
            "State": {"Name": self.state},
            "LaunchTime": datetime.fromtimestamp(self.launch, timezone.utc),
        }]}]}


class FakeELB:
    def __init__(self, error=None):
        self.error = error

    def describe_load_balancers(self, Names):  # noqa: N803
        if self.error:
            raise self.error
        return {"LoadBalancers": [{"LoadBalancerArn": "arn:lb"}]}

    def describe_target_groups(self, LoadBalancerArn):  # noqa: N803
        return {"TargetGroups": [{"TargetGroupArn": "arn:tg", "TargetGroupName": "tg-1"}]}

    def describe_target_health(self, TargetGroupArn):  # noqa: N803
        return {"TargetHealthDescriptions": [{"Target": {"Id": "i-abc"}, "TargetHealth": {"State": "healthy"}}]}


class FakeCW:
    def __init__(self, error=None):
        self.error = error

    def get_metric_data(self, **kw):
        if self.error:
            raise self.error
        return {"MetricDataResults": [{"Timestamps": [datetime.fromtimestamp(time.time() - 60, timezone.utc)]}]}


ENV = {
    "INSTANCE_ID": "i-0806bafeb330307d5",
    "ALB_NAME": "awsops-alb",
    "DASHBOARD_URL": "https://awsops.moyeota.co.kr/",
    "WEBHOOK_PARAM": "/awsops/slack-webhook-url",
    "STATE_PARAM": "/awsops/health/watchdog-state",
}


def state_change(state):
    return {"detail-type": "EC2 Instance State-change Notification",
            "detail": {"instance-id": ENV["INSTANCE_ID"], "state": state}}


class HandlerTest(unittest.TestCase):
    def run_handler(self, event, ssm, ec2, elb=None, cw=None, url=(302, COGNITO)):
        clients = {"ssm": ssm, "ec2": ec2, "elbv2": elb or FakeELB(), "cloudwatch": cw or FakeCW()}
        posts = []
        with mock.patch.dict(os.environ, ENV), \
                mock.patch.object(hw, "_client", side_effect=lambda n: clients[n]), \
                mock.patch.object(hw, "_check_url", return_value=url), \
                mock.patch.object(hw, "_post_slack", side_effect=lambda w, t: posts.append(t) or True):
            res = hw.lambda_handler(event, None)
        return res, posts

    def test_stale_stopped_event_after_restart_does_not_alert(self):
        import json
        ssm = FakeSSM(json.dumps(prev_state()))
        ec2 = FakeEC2("running", time.time() - 3600)
        res, posts = self.run_handler(state_change("stopped"), ssm, ec2)
        self.assertEqual(posts, [])
        self.assertEqual(res["server"], "running")

    def test_event_state_used_when_describe_fails(self):
        import json
        ssm = FakeSSM(json.dumps(prev_state()))
        ec2 = FakeEC2(None, 0)
        res, posts = self.run_handler(state_change("stopping"), ssm, ec2)
        self.assertEqual(res["server"], "stopped")
        self.assertEqual(len(posts), 1)
        self.assertIn("🛑", posts[0])

    def test_one_slack_post_per_invocation(self):
        import json
        ssm = FakeSSM(json.dumps(prev_state(dashboard="fail", external="fail")))
        ec2 = FakeEC2("running", time.time() - 3600)
        res, posts = self.run_handler({"detail-type": "Scheduled Event"}, ssm, ec2)
        self.assertEqual(res["sent"], 2)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].count("🟢"), 2)
        self.assertNotIn("SECRET", posts[0])

    def test_throttled_lookups_leave_state_unchanged(self):
        import json
        ssm = FakeSSM(json.dumps(prev_state()))
        ec2 = FakeEC2("running", time.time() - 3600)
        for _ in range(3):
            res, posts = self.run_handler(
                {"detail-type": "Scheduled Event"}, ssm, ec2,
                elb=FakeELB(FakeClientError("Throttling")), cw=FakeCW(FakeClientError("AccessDenied")),
            )
            self.assertEqual(posts, [])
        saved = json.loads(ssm.params["/awsops/health/watchdog-state"])
        self.assertEqual(saved["dashboard"], "ok")
        self.assertEqual(saved["heartbeat"], "ok")
        self.assertEqual(saved.get("fails", {}).get("dashboard", 0), 0)


class LookupTest(unittest.TestCase):
    def test_get_targets_not_found_is_none_other_errors_are_lookup_error(self):
        for code in ("LoadBalancerNotFound", "TargetGroupNotFound"):
            with mock.patch.object(hw, "_client", return_value=FakeELB(FakeClientError(code))):
                self.assertIsNone(hw._get_targets("awsops-alb"), code)
        for err in (FakeClientError("Throttling"), FakeClientError("AccessDenied"), OSError("network")):
            with mock.patch.object(hw, "_client", return_value=FakeELB(err)):
                self.assertEqual(hw._get_targets("awsops-alb"), hw.LOOKUP_ERROR)

    def test_heartbeat_age_error_is_lookup_error(self):
        with mock.patch.object(hw, "_client", return_value=FakeCW(FakeClientError("Throttling"))):
            self.assertEqual(hw._heartbeat_age(time.time()), hw.LOOKUP_ERROR)


if __name__ == "__main__":
    unittest.main()
