from __future__ import annotations

import io
import json
import logging
import tempfile
import threading
import time
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import requests
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.services import azure_monitoring


SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111"
START = date(2026, 11, 1)
END = date(2026, 11, 9)


class CostQueryResilienceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "cost-cache.sqlite"
        self.engine = create_engine(
            f"sqlite:///{database_path}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with azure_monitoring._cost_state_lock:
            azure_monitoring._cost_inflight.clear()
            azure_monitoring._cost_throttle_until.clear()
            azure_monitoring._cost_details_cache.clear()
            azure_monitoring._cost_details_inflight.clear()

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_dir.cleanup()

    def test_cost_details_export_returns_requested_report_columns(self) -> None:
        operation_response = requests.Response()
        operation_response.status_code = 200
        operation_response._content = json.dumps(
            {
                "status": "Completed",
                "manifest": {
                    "compressData": False,
                    "blobs": [{"blobLink": "https://reports.blob.core.windows.net/report.csv?sig=test"}],
                },
            }
        ).encode()
        report_response = requests.Response()
        report_response.status_code = 200
        report_response._content = (
            b"Date,ResourceLocation,ResourceGroup,ServiceName,Meter,Cost,Currency\r\n"
            b"20261101,centralindia,GODA_RG,Virtual Machines,VM S,12.5,INR\r\n"
        )

        with (
            patch.object(azure_monitoring, "_cost_details_request", return_value=operation_response) as request,
            patch.object(azure_monitoring.requests, "get", return_value=report_response),
        ):
            report = azure_monitoring.generate_cost_details_csv(
                SUBSCRIPTION_ID,
                date(2026, 11, 1),
                date(2026, 11, 10),
                "test-token",
                customer_id="customer-a",
                tenant_id="tenant-a",
            )

        self.assertEqual(
            report.decode(),
            "UsageDate,ResourceLocation,ResourceGroup,ServiceName,Meter,Cost,Currency\r\n"
            "2026-11-01,centralindia,GODA_RG,Virtual Machines,VM S,12.5,INR\r\n",
        )
        self.assertEqual(request.call_args.kwargs["json_body"], {
            "metric": "ActualCost",
            "timePeriod": {"start": "2026-11-01", "end": "2026-11-10"},
        })

    def test_cost_details_export_rejects_multiple_calendar_months(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            azure_monitoring.generate_cost_details_csv(
                SUBSCRIPTION_ID,
                date(2026, 11, 30),
                date(2026, 12, 1),
                "test-token",
                customer_id="customer-a",
                tenant_id="tenant-a",
            )

        self.assertEqual(raised.exception.status_code, 400)

    def test_cost_details_export_reuses_recent_report_for_same_account_and_dates(self) -> None:
        with patch.object(
            azure_monitoring,
            "_generate_cost_details_csv_uncached",
            return_value=b"UsageDate,Cost\r\n2026-11-01,10\r\n",
        ) as generate:
            first = azure_monitoring.generate_cost_details_csv(
                SUBSCRIPTION_ID,
                date(2026, 11, 1),
                date(2026, 11, 10),
                "test-token",
                customer_id="customer-a",
                tenant_id="tenant-a",
            )
            repeated = azure_monitoring.generate_cost_details_csv(
                SUBSCRIPTION_ID,
                date(2026, 11, 1),
                date(2026, 11, 10),
                "test-token",
                customer_id="customer-a",
                tenant_id="tenant-a",
            )
            another_account = azure_monitoring.generate_cost_details_csv(
                SUBSCRIPTION_ID,
                date(2026, 11, 1),
                date(2026, 11, 10),
                "test-token",
                customer_id="customer-b",
                tenant_id="tenant-a",
            )

        self.assertEqual(first, repeated)
        self.assertEqual(first, another_account)
        self.assertEqual(generate.call_count, 2)

    def _query(
        self,
        db,
        *,
        customer_id: str = "customer-a",
        tenant_id: str = "tenant-a",
        start: date = START,
        end: date = END,
        granularity: str = "Monthly",
        compare: bool = False,
    ):
        return azure_monitoring.query_costs(
            SUBSCRIPTION_ID,
            start,
            end,
            granularity,
            "test-token",
            compare,
            customer_id=customer_id,
            tenant_id=tenant_id,
            db=db,
        )

    def test_retry_after_and_bounded_jittered_retries(self) -> None:
        calls = 0
        sleeps: list[float] = []

        def flaky_request(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls < 2:
                raise HTTPException(429, detail="Azure rate limit")
            return {"ok": True}

        with (
            patch.object(azure_monitoring, "_request_once", side_effect=flaky_request),
            patch.object(azure_monitoring.time_module, "sleep", side_effect=sleeps.append),
            patch.object(azure_monitoring.random, "uniform", return_value=0.1),
        ):
            result = azure_monitoring._request("POST", "https://management.azure.com/test", "test-token")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(calls, azure_monitoring.MAX_THROTTLE_RETRIES + 1)
        self.assertEqual(len(sleeps), azure_monitoring.MAX_THROTTLE_RETRIES)
        self.assertGreaterEqual(sleeps[0], azure_monitoring.RETRY_BACKOFF_BASE_SECONDS)

        with (
            patch.object(
                azure_monitoring,
                "_request_once",
                side_effect=[
                    HTTPException(429, detail="Azure rate limit", headers={"Retry-After": "2"}),
                    {"ok": True},
                ],
            ),
            patch.object(azure_monitoring.time_module, "sleep", side_effect=sleeps.append),
        ):
            before = len(sleeps)
            azure_monitoring._request("POST", "https://management.azure.com/test", "test-token")
        self.assertEqual(sleeps[before], 2)

        with patch.object(
            azure_monitoring,
            "_request_once",
            side_effect=HTTPException(429, detail="Azure rate limit", headers={"Retry-After": "12"}),
        ) as upstream:
            with self.assertRaises(HTTPException) as raised:
                azure_monitoring._request("POST", "https://management.azure.com/test", "test-token")
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.headers["Retry-After"], "12")
        self.assertEqual(upstream.call_count, 1)

    def test_cost_management_retry_headers_control_the_retry_delay(self) -> None:
        sleeps: list[float] = []
        with (
            patch.object(
                azure_monitoring,
                "_request_once",
                side_effect=[
                    HTTPException(
                        429,
                        detail="Azure rate limit",
                        headers={
                            "x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after": "2",
                            "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after": "4",
                        },
                    ),
                    {"ok": True},
                ],
            ),
            patch.object(azure_monitoring.time_module, "sleep", side_effect=sleeps.append),
        ):
            result = azure_monitoring._request("POST", "https://management.azure.com/test", "test-token")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(sleeps, [4])

    def test_cost_query_adds_identification_headers_and_reduces_grouping(self) -> None:
        with patch.object(azure_monitoring, "_request", return_value={"properties": {}}) as request:
            azure_monitoring._cost_query(
                f"/subscriptions/{SUBSCRIPTION_ID}",
                START,
                END,
                "Daily",
                "test-token",
                group_resources=False,
            )

        kwargs = request.call_args.kwargs
        self.assertEqual(
            kwargs["request_headers"],
            {
                "ClientType": azure_monitoring.DEFAULT_COST_CLIENT_TYPE,
                "x-ms-command-name": azure_monitoring.DEFAULT_COST_COMMAND_NAME,
            },
        )
        self.assertEqual(
            kwargs["json_body"]["dataset"]["grouping"],
            [{"type": "Dimension", "name": "ServiceName"}],
        )

    def test_resource_group_is_extracted_from_arm_resource_id_when_missing(self) -> None:
        azure_resource = {
            "id": (
                f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/Prod-RG/"
                "providers/Microsoft.Compute/virtualMachines/app-vm"
            ),
            "name": "app-vm",
            "type": "Microsoft.Compute/virtualMachines",
        }
        with patch.object(azure_monitoring, "_get_pages", return_value=[azure_resource]):
            resources = azure_monitoring.list_resources(SUBSCRIPTION_ID, "test-token")

        self.assertEqual(resources[0]["resourceGroup"], "Prod-RG")

    def test_cache_is_persistent_and_scoped_to_customer_tenant_and_query(self) -> None:
        calls = []

        def fake_query(subscription_id, start, end, granularity, token, compare, comparison_range=None):
            calls.append((subscription_id, start, end, granularity, compare))
            return {"total": 12, "range": {"from": start.isoformat(), "to": end.isoformat()}}

        with patch.object(azure_monitoring, "_query_costs_uncached", side_effect=fake_query):
            with self.sessions() as db:
                result = self._query(db)
            with self.sessions() as db:
                self.assertEqual(self._query(db), result)
                self._query(db, customer_id="customer-b")
                self._query(db, tenant_id="tenant-b")
                self._query(db, start=START, end=date(2026, 11, 8))
                self._query(db, granularity="Daily")
                self._query(db, compare=True)
                azure_monitoring.query_costs(
                    "22222222-2222-2222-2222-222222222222",
                    START,
                    END,
                    "Monthly",
                    "test-token",
                    False,
                    customer_id="customer-a",
                    tenant_id="tenant-a",
                    db=db,
                )

        self.assertEqual(len(calls), 7)

    def test_identical_simultaneous_requests_share_one_upstream_call(self) -> None:
        calls = 0
        barrier = threading.Barrier(2)
        results = []
        failures = []

        def fake_query(subscription_id, start, end, granularity, token, compare, comparison_range=None):
            nonlocal calls
            calls += 1
            time.sleep(0.1)
            return {"total": 12}

        def run_query() -> None:
            try:
                with self.sessions() as db:
                    barrier.wait()
                    results.append(self._query(db))
            except Exception as exc:
                failures.append(exc)

        with patch.object(azure_monitoring, "_query_costs_uncached", side_effect=fake_query):
            workers = [threading.Thread(target=run_query) for _ in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)

        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(calls, 1)

    def test_distinct_customer_queries_obey_global_concurrency_limit(self) -> None:
        active = 0
        max_active = 0
        active_lock = threading.Lock()
        barrier = threading.Barrier(4)
        failures = []

        def fake_query(subscription_id, start, end, granularity, token, compare, comparison_range=None):
            nonlocal active, max_active
            with active_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.1)
            with active_lock:
                active -= 1
            return {"total": 12}

        def run_query(index: int) -> None:
            try:
                with self.sessions() as db:
                    barrier.wait()
                    self._query(
                        db,
                        customer_id=f"customer-{index}",
                        start=START,
                        end=date(2026, 11, 9 - index),
                    )
            except Exception as exc:
                failures.append(exc)

        with patch.object(azure_monitoring, "_query_costs_uncached", side_effect=fake_query):
            workers = [threading.Thread(target=run_query, args=(index,)) for index in range(4)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)

        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(failures, [])
        self.assertEqual(max_active, azure_monitoring.MAX_COST_CONCURRENT_REQUESTS)

    def test_throttle_response_identifies_upstream_and_local_cooldown(self) -> None:
        upstream_calls = 0

        def throttled_query(*args, **kwargs):
            nonlocal upstream_calls
            upstream_calls += 1
            raise HTTPException(
                429,
                detail="Azure rate limit reached. Retry after the indicated interval.",
                headers={"Retry-After": "90"},
            )

        with patch.object(azure_monitoring, "_query_costs_uncached", side_effect=throttled_query):
            with self.sessions() as db:
                with self.assertRaises(HTTPException) as first:
                    self._query(db)
            self.assertEqual(first.exception.headers["X-Cost-RateLimit-Source"], "upstream-azure")
            self.assertEqual(first.exception.headers["Retry-After"], "90")
            self.assertIn("Wait 90 seconds", first.exception.detail)

            with self.sessions() as db:
                with self.assertRaises(HTTPException) as second:
                    self._query(db, end=date(2026, 11, 8))
            self.assertEqual(second.exception.headers["X-Cost-RateLimit-Source"], "local-cooldown")
            self.assertEqual(upstream_calls, 1)

    def test_local_cooldown_isolated_between_customer_accounts(self) -> None:
        upstream_calls = 0

        def query_for_account(subscription_id, start, end, granularity, token, compare, comparison_range=None):
            nonlocal upstream_calls
            upstream_calls += 1
            if upstream_calls == 1:
                raise HTTPException(429, detail="Azure rate limit: Too many requests.")
            return {"total": 42, "range": {"from": start.isoformat(), "to": end.isoformat()}}

        with patch.object(azure_monitoring, "_query_costs_uncached", side_effect=query_for_account):
            with self.sessions() as db:
                with self.assertRaises(HTTPException) as throttled:
                    self._query(db, customer_id="customer-a", tenant_id="tenant-a")
            self.assertEqual(throttled.exception.headers["X-Cost-RateLimit-Source"], "upstream-azure")

            with self.sessions() as db:
                result = self._query(db, customer_id="customer-b", tenant_id="tenant-b")

        self.assertEqual(result["total"], 42)
        self.assertEqual(upstream_calls, 2)

    def test_comparison_uses_one_combined_upstream_cost_query(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            azure_monitoring._query_costs_uncached(
                SUBSCRIPTION_ID,
                START,
                END,
                "Monthly",
                "test-token",
                compare=True,
            )
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Explicit comparison dates are required", raised.exception.detail)

    def test_live_cost_query_groups_daily_costs_by_service_and_resource(self) -> None:
        start = date(2026, 11, 1)
        end = date(2026, 11, 2)
        with patch.object(
            azure_monitoring,
            "_cost_query",
            return_value={
                "properties": {
                    "columns": [
                        {"name": "UsageDate"},
                        {"name": "PreTaxCost"},
                        {"name": "ServiceName"},
                        {"name": "ResourceId"},
                        {"name": "Currency"},
                    ],
                    "rows": [
                        [20261101, 7.5, "Compute", "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1", "USD"],
                    ],
                }
            },
        ) as cost_query:
            response = azure_monitoring._query_costs_uncached(
                SUBSCRIPTION_ID,
                start,
                end,
                "Daily",
                "test-token",
                compare=False,
            )

        self.assertTrue(cost_query.call_args.kwargs.get("group_resources", True))
        self.assertEqual(
            response["serviceResourceTrend"],
            [
                {
                    "period": "2026-11-01",
                    "services": [
                        {
                            "name": "Compute",
                            "resources": [
                                {
                                    "resourceId": (
                                        "/subscriptions/sub/resourceGroups/rg/providers/"
                                        "Microsoft.Compute/virtualMachines/vm1"
                                    ),
                                    "cost": 7.5,
                                }
                            ],
                        }
                    ],
                }
            ],
        )

    def test_comparison_uses_explicit_user_supplied_range(self) -> None:
        requests_seen = []

        def fake_cost_query(scope, start, end, granularity, token):
            requests_seen.append((start, end, granularity))
            rows = [
                [int(date.fromordinal(ordinal).strftime("%Y%m%d")), 1.0, "Compute", "/resource", "USD"]
                for ordinal in range(start.toordinal(), end.toordinal() + 1)
            ]
            return {
                "properties": {
                    "columns": [
                        {"name": "UsageDate"},
                        {"name": "PreTaxCost"},
                        {"name": "ServiceName"},
                        {"name": "ResourceId"},
                        {"name": "Currency"},
                    ],
                    "rows": rows,
                }
            }

        comparison_range = (date(2026, 8, 1), date(2026, 8, 10))
        with patch.object(azure_monitoring, "_cost_query", side_effect=fake_cost_query):
            response = azure_monitoring._query_costs_uncached(
                SUBSCRIPTION_ID,
                START,
                END,
                "Monthly",
                "test-token",
                compare=True,
                comparison_range=comparison_range,
            )

        self.assertEqual(requests_seen, [(comparison_range[0], END, "Daily")])
        self.assertEqual(response["previousRange"], {"from": "2026-08-01", "to": "2026-08-10"})
        self.assertEqual(response["total"], 9)
        self.assertEqual(response["previousTotal"], 10)
        self.assertEqual(response["previousTrend"], [{"period": "2026-08", "cost": 10.0, "from": "2026-08-01", "to": "2026-08-10"}])

    def test_daily_comparison_returns_each_period_date_detail(self) -> None:
        def fake_cost_query(scope, start, end, granularity, token):
            rows = [
                [int(date.fromordinal(ordinal).strftime("%Y%m%d")), 1.0, "Compute", "/resource", "USD"]
                for ordinal in range(start.toordinal(), end.toordinal() + 1)
            ]
            return {
                "properties": {
                    "columns": [
                        {"name": "UsageDate"},
                        {"name": "PreTaxCost"},
                        {"name": "ServiceName"},
                        {"name": "ResourceId"},
                        {"name": "Currency"},
                    ],
                    "rows": rows,
                }
            }

        current_start = date(2026, 11, 1)
        current_end = date(2026, 11, 3)
        comparison_range = (date(2026, 10, 1), date(2026, 10, 2))
        with patch.object(azure_monitoring, "_cost_query", side_effect=fake_cost_query):
            response = azure_monitoring._query_costs_uncached(
                SUBSCRIPTION_ID,
                current_start,
                current_end,
                "Daily",
                "test-token",
                compare=True,
                comparison_range=comparison_range,
            )

        self.assertEqual(
            [row["period"] for row in response["trend"]],
            ["2026-11-01", "2026-11-02", "2026-11-03"],
        )
        self.assertEqual(
            [row["period"] for row in response["previousTrend"]],
            ["2026-10-01", "2026-10-02"],
        )
        self.assertEqual(
            response["resourceTrend"][0],
            {
                "period": "2026-11-01",
                "resources": [{"resourceId": "/resource", "cost": 1.0}],
            },
        )
        self.assertEqual(
            response["serviceTrend"][0],
            {
                "period": "2026-11-01",
                "services": [{"name": "Compute", "cost": 1.0}],
            },
        )
        self.assertEqual(
            response["serviceResourceTrend"][0],
            {
                "period": "2026-11-01",
                "services": [
                    {
                        "name": "Compute",
                        "resources": [{"resourceId": "/resource", "cost": 1.0}],
                    }
                ],
            },
        )
        self.assertEqual(
            response["previousServiceTrend"][0],
            {
                "period": "2026-10-01",
                "services": [{"name": "Compute", "cost": 1.0}],
            },
        )
        self.assertEqual(
            response["previousResourceTrend"][0],
            {
                "period": "2026-10-01",
                "resources": [{"resourceId": "/resource", "cost": 1.0}],
            },
        )

    def test_comparison_ranges_must_be_separate_and_not_future(self) -> None:
        today = date(2026, 11, 9)
        azure_monitoring.validate_cost_date_ranges(
            date(2026, 11, 1),
            today,
            (date(2026, 10, 1), date(2026, 10, 6)),
            today=today,
        )
        with self.assertRaises(HTTPException) as overlap:
            azure_monitoring.validate_cost_date_ranges(
                date(2026, 11, 1),
                today,
                (date(2026, 9, 30), date(2026, 11, 26)),
                today=today,
            )
        self.assertIn("cannot be in the future", overlap.exception.detail)
        with self.assertRaises(HTTPException) as overlap:
            azure_monitoring.validate_cost_date_ranges(
                date(2026, 11, 1),
                today,
                (date(2026, 11, 5), today),
                today=today,
            )
        self.assertIn("must not overlap", overlap.exception.detail)

    def test_throttle_logs_redact_customer_identifiers_and_secrets(self) -> None:
        response = requests.Response()
        response.status_code = 429
        response.reason = "Too Many Requests"
        response._content = json.dumps(
            {
                "error": {
                    "code": "RateLimit",
                    "message": "limit for 11111111-2222-3333-4444-555555555555",
                },
                "tenantId": "sensitive-tenant",
                "accessToken": "sensitive-token",
            }
        ).encode()
        response.headers["Retry-After"] = "60"
        response.headers["x-ms-request-id"] = "request-id"
        response.headers["Set-Cookie"] = "must-not-be-logged"
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        azure_monitoring._logger.addHandler(handler)
        try:
            azure_monitoring._log_azure_throttle(response)
        finally:
            azure_monitoring._logger.removeHandler(handler)

        logged = stream.getvalue()
        self.assertIn("RateLimit", logged)
        self.assertIn("60", logged)
        self.assertIn("request-id", logged)
        self.assertNotIn("sensitive-tenant", logged)
        self.assertNotIn("sensitive-token", logged)
        self.assertNotIn("11111111-2222-3333-4444-555555555555", logged)
        self.assertNotIn("must-not-be-logged", logged)


if __name__ == "__main__":
    unittest.main()
