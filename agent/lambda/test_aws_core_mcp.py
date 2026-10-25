"""
Unit tests for aws_core_mcp.call_aws read-only guard — no AWS access, stdlib unittest only.
call_aws 읽기 전용 가드 단위 테스트 — AWS 호출 없음 (boto3는 가짜 모듈로 대체).

Run: cd agent/lambda && python3 -m unittest test_aws_core_mcp -v
"""
import json
import sys
import types
import unittest
from unittest import mock

# cross_account imports boto3 at module load; tests never reach AWS. / 테스트는 AWS에 닿지 않는다
sys.modules.setdefault("boto3", types.ModuleType("boto3"))

import aws_core_mcp as core  # noqa: E402


class FakeClient:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def method(**kwargs):
            self.calls.append((name, kwargs))
            return {"ok": name, "ResponseMetadata": {}}
        return method


class ReadOnlyGuardTest(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        patcher = mock.patch.object(core, "get_client", return_value=self.client)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_allows_describe_list_get_and_lookup(self):
        for cmd, action in [
            ("aws ec2 describe-instances", "describe_instances"),
            ("aws rds describe-db-instances", "describe_db_instances"),
            ("aws iam list-roles", "list_roles"),
            ("aws cloudwatch get-metric-data --metric-data-queries []", "get_metric_data"),
            ("aws cloudtrail lookup-events", "lookup_events"),
            ("aws logs filter-log-events --log-group-name g", "filter_log_events"),
        ]:
            self.assertEqual(core.call_aws(cmd), {"ok": action}, cmd)

    def test_blocks_mutating_commands_without_calling_aws(self):
        for cmd in [
            "aws ec2 terminate-instances --instance-ids i-123",
            "aws ec2 stop-instances --instance-ids i-123",
            "aws ec2 authorize-security-group-ingress --group-id sg-1",
            "aws ec2 delete-vpc --vpc-id vpc-1",
            "aws dynamodb delete-table --table-name t",
            "aws eks delete-cluster --name c",
            "aws ecr batch-delete-image --repository-name r",
            "aws logs put-retention-policy --log-group-name g --retention-in-days 1",
            "aws iam create-access-key --user-name u",
            "aws sts assume-role --role-arn x --role-session-name y",
        ]:
            result = core.call_aws(cmd)
            self.assertIn("error", result, cmd)
            self.assertIn("read-only", result["error"], cmd)
        self.assertEqual(self.client.calls, [])

    def test_blocks_reads_that_return_secrets_or_credentials(self):
        for cmd in [
            "aws ssm get-parameter --name /ops/awsops/slack-bot-token --with-decryption",
            "aws ssm get-parameters-by-path --path /ops",
            "aws secretsmanager get-secret-value --secret-id s",
            "aws ecr get-authorization-token",
            "aws ec2 get-password-data --instance-id i-1",
            "aws sts get-session-token",
            "aws s3api get-object --bucket b --key k out",
        ]:
            self.assertIn("error", core.call_aws(cmd), cmd)
        self.assertEqual(self.client.calls, [])

    def test_batch_handler_applies_guard_to_every_command(self):
        resp = core.lambda_handler({"tool_name": "call_aws", "arguments": {
            "cli_command": ["aws ec2 describe-vpcs", "aws ec2 terminate-instances --instance-ids i-1"],
        }}, None)
        body = json.loads(resp["body"])
        self.assertEqual(body[0], {"ok": "describe_vpcs"})
        self.assertIn("error", body[1])
        self.assertEqual([c[0] for c in self.client.calls], ["describe_vpcs"])


if __name__ == "__main__":
    unittest.main()
