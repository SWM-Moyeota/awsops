"""
Unit tests for health_watchdog.decide() — no AWS access, stdlib unittest only.
health_watchdog.decide() 단위 테스트 — AWS 호출 없음, stdlib unittest 전용.

Run: cd agent/lambda && python3 -m unittest test_health_watchdog -v
"""
import unittest

import health_watchdog as hw

NOW = 1_800_000_000.0  # arbitrary fixed epoch
GOOD_TARGETS = {"tg-1:i-abc": "healthy"}


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
        "url_location": "https://auth.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize?x=1",
    }
    o.update(kw)
    return o


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

    def test_running_after_stop_alerts_with_start_hint(self):
        st, texts = hw.decide(prev_state(server="stopped"), obs(source="state-change", ec2_state="running", launch_epoch=NOW - 5), NOW)
        self.assertEqual(st["server"], "running")
        self.assertEqual(len(texts), 1)
        self.assertIn("▶️", texts[0])
        self.assertIn("09-start-all.sh 실행 필요", texts[0])

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
        # exactly at the 900s boundary the grace period is over
        st, texts = hw.decide(prev_state(), obs(launch_epoch=NOW - 900, heartbeat_age_sec=None), NOW)
        self.assertEqual(st["heartbeat"], "fail")
        self.assertEqual(len(texts), 1)

    def test_heartbeat_stale_alerts_once_then_recovers(self):
        st, texts = hw.decide(prev_state(), obs(heartbeat_age_sec=1200.0), NOW)
        self.assertEqual(st["heartbeat"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("🔴", texts[0])
        st, texts = hw.decide(st, obs(heartbeat_age_sec=1500.0), NOW + 300)
        self.assertEqual(texts, [])
        st, texts = hw.decide(st, obs(heartbeat_age_sec=60.0), NOW + 600)
        self.assertEqual(st["heartbeat"], "ok")
        self.assertEqual(len(texts), 1)
        self.assertIn("🟢", texts[0])

    def test_missing_target_group_is_dashboard_fail(self):
        st, texts = hw.decide(prev_state(), obs(targets=None), NOW)
        self.assertEqual(st["dashboard"], "fail")
        self.assertEqual(len(texts), 1)
        self.assertIn("🔴", texts[0])
        st, texts = hw.decide(st, obs(targets={"tg-1:i-abc": "unhealthy"}), NOW + 300)
        self.assertEqual(texts, [])
        st, texts = hw.decide(st, obs(), NOW + 600)
        self.assertEqual(st["dashboard"], "ok")
        self.assertIn("🟢", texts[0])

    def test_external_requires_302_to_cognito(self):
        st, texts = hw.decide(prev_state(), obs(url_status=200, url_location=None), NOW)
        self.assertEqual(st["external"], "fail")
        self.assertEqual(len(texts), 1)
        st, texts = hw.decide(prev_state(), obs(url_status=302, url_location="https://evil.example.com/login"), NOW)
        self.assertEqual(st["external"], "fail")
        self.assertEqual(len(texts), 1)
        st, texts = hw.decide(prev_state(), obs(url_status=None, url_location=None), NOW)
        self.assertEqual(st["external"], "fail")
        st, texts = hw.decide(prev_state(), obs(), NOW)
        self.assertEqual(st["external"], "ok")
        self.assertEqual(texts, [])

    def test_first_run_unknown_to_ok_is_silent(self):
        st, texts = hw.decide({}, obs(), NOW)
        self.assertEqual(texts, [])
        self.assertEqual(st["server"], "running")
        self.assertEqual(st["dashboard"], "ok")

    def test_prev_not_mutated(self):
        p = prev_state()
        snapshot = dict(p)
        hw.decide(p, obs(targets=None), NOW)
        self.assertEqual(p, snapshot)

    def test_message_has_kst_time(self):
        # 1_800_000_000 = 2027-01-15 08:00:00 UTC = 17:00 KST
        _, texts = hw.decide(prev_state(), obs(source="state-change", ec2_state="stopped"), NOW)
        self.assertIn("2027-01-15 17:00 KST", texts[0])


if __name__ == "__main__":
    unittest.main()
