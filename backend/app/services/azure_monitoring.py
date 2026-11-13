from __future__ import annotations

from concurrent.futures import Future, TimeoutError as FutureTimeoutError
import csv
from datetime import date, datetime, time, timezone
from email.utils import parsedate_to_datetime
import gzip
from hashlib import sha256
from io import StringIO
import json
import logging
import random
import re
import time as time_module
from copy import deepcopy
from threading import BoundedSemaphore, Lock
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import requests
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cost_query_cache import CostQueryCache

ARM_ENDPOINT = "https://management.azure.com"
API_VERSIONS = {
    "subscriptions": "2022-12-01",
    "resources": "2021-04-01",
    "cost": "2023-11-01",
    "cost_details": "2023-03-01",
}
MAX_COST_DETAILS_WAIT_SECONDS = 300
COST_DETAILS_CACHE_TTL_SECONDS = 300
MAX_COST_DETAILS_CACHE_ENTRIES = 32
MAX_THROTTLE_RETRIES = 1
MAX_INLINE_RETRY_DELAY_SECONDS = 5
RETRY_BACKOFF_BASE_SECONDS = 10
RETRY_BACKOFF_MAX_SECONDS = 30
DEFAULT_COST_CLIENT_TYPE = "MyCustomFinOpsAppV1"
DEFAULT_COST_COMMAND_NAME = "CustomFinOps.CostManagement.Query"
COST_CACHE_TTL_SECONDS = 300
DEFAULT_COST_THROTTLE_DELAY_SECONDS = 60
MAX_COST_CONCURRENT_REQUESTS = 2
MAX_COST_QUEUED_REQUESTS = 8
COST_QUERY_QUEUE_TIMEOUT_SECONDS = 30
COST_QUERY_WAIT_TIMEOUT_SECONDS = 180
_logger = logging.getLogger(__name__)
_cost_state_lock = Lock()
_cost_query_semaphore = BoundedSemaphore(MAX_COST_CONCURRENT_REQUESTS)
_cost_queue_slots = BoundedSemaphore(MAX_COST_QUEUED_REQUESTS)
_cost_inflight: dict[str, Future[dict[str, Any]]] = {}
_cost_throttle_until: dict[tuple[str, str, str], float] = {}
_cost_details_cache: dict[str, tuple[float, bytes]] = {}
_cost_details_inflight: dict[str, Future[bytes]] = {}

_SENSITIVE_LOG_KEY = re.compile(
    r"(access.?token|refresh.?token|client.?secret|password|authorization|"
    r"subscription.?id|tenant.?id|customer|resource.?id|account.?id|email)",
    re.IGNORECASE,
)
_LOG_REDACTIONS = (
    (re.compile(r"(?i)bearer\s+\S+"), "Bearer [REDACTED]"),
    (re.compile(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b", re.IGNORECASE), "[GUID]"),
    (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "[EMAIL]"),
    (re.compile(r"(?i)/subscriptions/[^/\s\"']+"), "/subscriptions/[REDACTED]"),
)
_LOGGED_AZURE_HEADERS = (
    "Retry-After",
    "x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after",
    "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after",
    "x-ms-request-id",
    "x-ms-correlation-request-id",
    "x-ms-routing-request-id",
    "x-ms-ratelimit-remaining-subscription-reads",
    "x-ms-ratelimit-remaining-tenant-reads",
)


def customer_cache_id(tenant_id: str, account_id: str) -> str:
    identity = f"azure-cost-cache\0{tenant_id}\0{account_id}"
    return sha256(identity.encode("utf-8")).hexdigest()


def _sanitize_log_text(value: str) -> str:
    sanitized = value
    for pattern, replacement in _LOG_REDACTIONS:
        sanitized = pattern.sub(replacement, sanitized)
    return sanitized[:2000]


def _sanitize_log_value(value: Any, key: str = "") -> Any:
    if _SENSITIVE_LOG_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(item_key): _sanitize_log_value(item, str(item_key)) for item_key, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_log_value(item) for item in value[:50]]
    if isinstance(value, str):
        return _sanitize_log_text(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _sanitize_log_text(str(value))


def _safe_azure_error_body(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return _sanitize_log_text(response.text)
    try:
        return json.dumps(_sanitize_log_value(body), ensure_ascii=True)[:2000]
    except (TypeError, ValueError):
        return "[unserializable Azure error response]"


def _log_azure_throttle(response: requests.Response) -> None:
    relevant_headers = {
        name: response.headers[name]
        for name in _LOGGED_AZURE_HEADERS
        if name in response.headers
    }
    _logger.warning(
        "Azure Cost Management throttled request status=%d response_body=%s response_headers=%s",
        response.status_code,
        _safe_azure_error_body(response),
        relevant_headers,
    )


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def _request_once(
    method: str,
    url: str,
    access_token: str,
    *,
    params: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    request_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        response = requests.request(
            method,
            url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                **(request_headers or {}),
            },
            params=params,
            json=json_body,
            timeout=45,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not reach the Azure management API.") from exc

    if not response.ok:
        if response.status_code == 401:
            raise HTTPException(status_code=401, detail="Azure authorization expired. Reconnect your Azure account.")
        if response.status_code == 403:
            raise HTTPException(
                status_code=403,
                detail="Azure denied this request. Verify the required read permissions for this subscription.",
            )
        if response.status_code == 429:
            _log_azure_throttle(response)
            headers = {
                name.lower(): response.headers[name]
                for name in (
                    "Retry-After",
                    "x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after",
                    "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after",
                )
                if name in response.headers
            }
            raise HTTPException(
                status_code=429,
                detail="Azure rate limit reached. Retry after the indicated interval.",
                headers=headers,
            )
        raise HTTPException(
            status_code=502,
            detail=f"Azure API request failed ({response.status_code}).",
        )

    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Azure returned an invalid response.") from exc


def _request(
    method: str,
    url: str,
    access_token: str,
    *,
    params: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    request_headers: dict[str, str] | None = None,
    retry_on_throttle: bool = True,
) -> dict[str, Any]:
    for attempt in range(MAX_THROTTLE_RETRIES + 1):
        try:
            return _request_once(
                method,
                url,
                access_token,
                params=params,
                json_body=json_body,
                request_headers=request_headers,
            )
        except HTTPException as exc:
            if exc.status_code != 429:
                raise
            if not retry_on_throttle:
                raise
            response_headers = {
                name.lower(): value
                for name, value in (exc.headers or {}).items()
            }
            retry_values = [
                _retry_after_seconds(response_headers.get(name))
                for name in (
                    "x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after",
                    "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after",
                    "retry-after",
                )
                if response_headers.get(name)
            ]
            retry_values = [value for value in retry_values if value is not None]
            retry_delay = max(retry_values) if retry_values else None
            retry_after = str(max(1, int(retry_delay + 0.999))) if retry_delay is not None else None
            if retry_delay is None:
                if attempt == MAX_THROTTLE_RETRIES:
                    headers = {"Retry-After": str(DEFAULT_COST_THROTTLE_DELAY_SECONDS)}
                    raise HTTPException(
                        status_code=429,
                        detail=f"Azure rate limit after {MAX_THROTTLE_RETRIES} retries: {exc.detail}",
                        headers=headers,
                    ) from exc
                retry_delay = min(RETRY_BACKOFF_MAX_SECONDS, RETRY_BACKOFF_BASE_SECONDS * (2**attempt))
                retry_delay += random.uniform(0, retry_delay * 0.25)
            if attempt == MAX_THROTTLE_RETRIES or (retry_after and retry_delay > MAX_INLINE_RETRY_DELAY_SECONDS):
                retry_seconds = max(1, int(retry_delay + 0.999))
                headers = {"Retry-After": str(retry_seconds)}
                raise HTTPException(
                    status_code=429,
                    detail=f"Azure rate limit: {exc.detail}",
                    headers=headers,
                ) from exc
            time_module.sleep(retry_delay)
    raise HTTPException(status_code=429, detail="Azure is rate-limiting requests. Please retry shortly.")


def _get_pages(path: str, api_version: str, access_token: str) -> list[dict[str, Any]]:
    url = f"{ARM_ENDPOINT}{path}"
    params: dict[str, str] | None = {"api-version": api_version}
    values: list[dict[str, Any]] = []
    while url:
        result = _request("GET", url, access_token, params=params)
        values.extend(result.get("value", []))
        next_link = result.get("nextLink")
        if next_link:
            parsed = urlparse(next_link)
            if parsed.scheme != "https" or parsed.netloc.lower() != "management.azure.com":
                raise HTTPException(status_code=502, detail="Azure returned an unexpected pagination URL.")
        url = next_link
        params = None
    return values


def list_subscriptions(access_token: str) -> list[dict[str, Any]]:
    return [
        {
            "id": item["subscriptionId"],
            "name": item["displayName"],
            "state": item.get("state", "Unknown"),
            "tenantId": item.get("tenantId"),
        }
        for item in _get_pages("/subscriptions", API_VERSIONS["subscriptions"], access_token)
    ]


def validate_subscription_id(subscription_id: str) -> str:
    try:
        return str(UUID(subscription_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="A valid Azure subscription ID is required.") from exc


def validate_cost_date_ranges(
    start: date,
    end: date,
    comparison_range: tuple[date, date] | None = None,
    *,
    today: date | None = None,
) -> None:
    current_date = today or date.today()
    if end < start:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")
    if end > current_date:
        raise HTTPException(status_code=400, detail="Cost period dates cannot be in the future.")
    if comparison_range is None:
        return
    comparison_start, comparison_end = comparison_range
    if comparison_end < comparison_start:
        raise HTTPException(status_code=400, detail="Comparison end date must be on or after its start date.")
    if comparison_end > current_date:
        raise HTTPException(status_code=400, detail="Comparison period dates cannot be in the future.")
    if not (end < comparison_start or comparison_end < start):
        raise HTTPException(status_code=400, detail="Cost and comparison date ranges must not overlap.")


def _scope(subscription_id: str) -> str:
    return f"/subscriptions/{validate_subscription_id(subscription_id)}"


def list_resources(subscription_id: str, access_token: str) -> list[dict[str, Any]]:
    scope = _scope(subscription_id)
    resources = _get_pages(f"{scope}/resources", API_VERSIONS["resources"], access_token)
    normalized_resources = []
    for item in resources:
        resource_id = item["id"]
        id_parts = resource_id.strip("/").split("/")
        resource_group_from_id = next(
            (
                id_parts[index + 1]
                for index, part in enumerate(id_parts[:-1])
                if part.lower() == "resourcegroups"
            ),
            "",
        )
        normalized_resources.append(
            {
                "id": resource_id,
                "name": item["name"],
                "type": item.get("type", ""),
                "resourceGroup": item.get("resourceGroup") or resource_group_from_id,
                "location": item.get("location", ""),
                "sku": item.get("sku", {}).get("name") if isinstance(item.get("sku"), dict) else None,
                "tags": item.get("tags", {}),
                "kind": item.get("kind"),
            }
        )
    return normalized_resources


def _utc_range(start: date, end: date) -> tuple[datetime, datetime]:
    if end < start:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")
    if (end - start).days > 730:
        raise HTTPException(status_code=400, detail="Date range cannot exceed two years.")
    return (
        datetime.combine(start, time.min, tzinfo=timezone.utc),
        datetime.combine(end, time(23, 59, 59), tzinfo=timezone.utc),
    )


def _cost_query(
    scope: str,
    start: date,
    end: date,
    granularity: str,
    access_token: str,
    *,
    group_resources: bool = True,
) -> dict[str, Any]:
    start_time, end_time = _utc_range(start, end)
    body = {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {
            "from": start_time.isoformat().replace("+00:00", "Z"),
            "to": end_time.isoformat().replace("+00:00", "Z"),
        },
        "dataset": {
            "granularity": granularity,
            "aggregation": {"totalCost": {"name": "PreTaxCost", "function": "Sum"}},
            "grouping": [
                {"type": "Dimension", "name": "ServiceName"},
                *(
                    [{"type": "Dimension", "name": "ResourceId"}]
                    if group_resources
                    else []
                ),
            ],
        },
    }
    return _request(
        "POST",
        f"{ARM_ENDPOINT}{scope}/providers/Microsoft.CostManagement/query",
        access_token,
        params={"api-version": API_VERSIONS["cost"]},
        json_body=body,
        request_headers={
            "ClientType": DEFAULT_COST_CLIENT_TYPE,
            "x-ms-command-name": DEFAULT_COST_COMMAND_NAME,
        },
    )


def _cost_details_request(
    method: str,
    url: str,
    access_token: str | None = None,
    *,
    json_body: dict[str, Any] | None = None,
) -> requests.Response:
    headers = {"Accept": "application/json"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    try:
        response = requests.request(
            method,
            url,
            headers=headers,
            json=json_body,
            timeout=45,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not reach the Azure Cost Details API.") from exc

    if response.status_code in {401, 403, 429}:
        if response.status_code == 429:
            _log_azure_throttle(response)
        try:
            body = response.json()
            error = body.get("error", {}) if isinstance(body, dict) else {}
            message = error.get("message", response.reason) if isinstance(error, dict) else response.reason
        except ValueError:
            message = response.reason
        if response.status_code == 401:
            raise HTTPException(status_code=401, detail=f"Azure authorization expired: {message}")
        if response.status_code == 403:
            raise HTTPException(
                status_code=403,
                detail=f"Azure denied the Cost Details request. Check Cost Management read permissions: {message}",
            )
        retry_headers = {
            name.lower(): response.headers[name]
            for name in (
                "Retry-After",
                "x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after",
                "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after",
            )
            if name in response.headers
        }
        raise HTTPException(
            status_code=429,
            detail=f"Azure rate limit: {message}",
            headers=retry_headers,
        )
    return response


def _cost_details_error(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.reason
    error = body.get("error", {}) if isinstance(body, dict) else {}
    if isinstance(error, dict):
        return str(error.get("message") or response.reason)
    return response.reason


def _cost_details_csv_bytes(
    blobs: list[dict[str, Any]],
    compressed: bool,
) -> bytes:
    columns = [
        ("UsageDate", ("usagedate", "date")),
        ("ResourceLocation", ("resourcelocation",)),
        ("ResourceGroup", ("resourcegroup", "resourcegroupname")),
        ("ServiceName", ("servicename",)),
        ("Meter", ("meter", "metername")),
        ("Cost", ("cost", "costinbillingcurrency", "pretaxcost")),
        ("Currency", ("currency", "billingcurrency")),
    ]
    output = StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow([column[0] for column in columns])
    has_rows = False

    for blob in blobs:
        blob_url = urlparse(str(blob.get("blobLink", "")))
        if (
            blob_url.scheme != "https"
            or not blob_url.hostname
            or not (
                blob_url.hostname.endswith(".blob.core.windows.net")
                or blob_url.hostname.endswith(".blob.core.usgovcloudapi.net")
            )
            or blob_url.username
            or blob_url.password
        ):
            raise HTTPException(status_code=502, detail="Azure returned an invalid Cost Details download URL.")
        try:
            response = requests.get(str(blob["blobLink"]), timeout=60, allow_redirects=False)
        except (requests.RequestException, KeyError) as exc:
            raise HTTPException(status_code=502, detail="Could not download the Azure Cost Details report.") from exc
        if not response.ok:
            raise HTTPException(status_code=502, detail="Azure Cost Details report download failed.")

        content = response.content
        if compressed or content.startswith(b"\x1f\x8b"):
            try:
                content = gzip.decompress(content)
            except OSError as exc:
                raise HTTPException(status_code=502, detail="Azure returned an invalid compressed Cost Details report.") from exc
        try:
            text = content.decode("utf-8-sig")
            reader = csv.DictReader(StringIO(text, newline=""))
            source_headers = {
                str(name).strip().lower(): name
                for name in (reader.fieldnames or [])
                if name is not None
            }
            source_columns: list[str] = []
            for output_name, aliases in columns:
                source_name = next((source_headers[alias] for alias in aliases if alias in source_headers), None)
                if source_name is None:
                    missing = output_name
                    raise HTTPException(
                        status_code=502,
                        detail=f"Azure Cost Details report is missing the required {missing} column.",
                    )
                source_columns.append(source_name)

            for source_row in reader:
                output_row = [source_row.get(source_name, "") or "" for source_name in source_columns]
                raw_date = output_row[0].strip()
                if raw_date.isdigit() and len(raw_date) == 8:
                    output_row[0] = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
                writer.writerow(output_row)
                has_rows = True
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=502, detail="Azure returned a non-UTF-8 Cost Details report.") from exc

    if not has_rows and not blobs:
        return output.getvalue().encode("utf-8")
    return output.getvalue().encode("utf-8")


def _generate_cost_details_csv_uncached(
    subscription_id: str,
    start: date,
    end: date,
    access_token: str,
) -> bytes:
    subscription_id = validate_subscription_id(subscription_id)
    if end < start:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")
    if (start.year, start.month) != (end.year, end.month):
        raise HTTPException(
            status_code=400,
            detail="Azure Cost Details exports must be limited to a single calendar month.",
        )

    scope = _scope(subscription_id)
    operation_url = (
        f"{ARM_ENDPOINT}{scope}/providers/Microsoft.CostManagement/"
        f"generateCostDetailsReport?api-version={API_VERSIONS['cost_details']}"
    )
    response = _cost_details_request(
        "POST",
        operation_url,
        access_token,
        json_body={
            "metric": "ActualCost",
            "timePeriod": {"start": start.isoformat(), "end": end.isoformat()},
        },
    )
    if response.status_code == 204:
        return _cost_details_csv_bytes([], False)
    if response.status_code not in {200, 202}:
        raise HTTPException(
            status_code=502,
            detail=f"Azure Cost Details request failed ({response.status_code}): {_cost_details_error(response)}",
        )

    operation_result = response
    location = response.headers.get("Location")
    deadline = time_module.monotonic() + MAX_COST_DETAILS_WAIT_SECONDS
    while operation_result.status_code == 202:
        if not location:
            raise HTTPException(status_code=502, detail="Azure Cost Details operation did not provide a polling URL.")
        parsed_location = urlparse(location)
        expected_prefix = (
            f"{scope}/providers/Microsoft.CostManagement/costDetailsOperationResults/"
        ).lower()
        if (
            parsed_location.scheme != "https"
            or parsed_location.hostname != urlparse(ARM_ENDPOINT).hostname
            or not parsed_location.path.lower().startswith(expected_prefix)
            or parsed_location.username
            or parsed_location.password
        ):
            raise HTTPException(status_code=502, detail="Azure returned an invalid Cost Details operation URL.")
        remaining = deadline - time_module.monotonic()
        if remaining <= 0:
            raise HTTPException(status_code=504, detail="Azure Cost Details report generation timed out.")
        retry_after = _retry_after_seconds(operation_result.headers.get("Retry-After"))
        wait_seconds = min(retry_after if retry_after is not None else 5, remaining)
        time_module.sleep(wait_seconds)
        operation_result = _cost_details_request("GET", location, access_token)
        location = operation_result.headers.get("Location", location)
        if operation_result.status_code not in {200, 202, 204}:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Azure Cost Details operation failed ({operation_result.status_code}): "
                    f"{_cost_details_error(operation_result)}"
                ),
            )
        if operation_result.status_code == 204:
            return _cost_details_csv_bytes([], False)

    try:
        result = operation_result.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Azure returned an invalid Cost Details operation result.") from exc
    if result.get("status") != "Completed":
        raise HTTPException(
            status_code=502,
            detail=f"Azure Cost Details operation did not complete successfully: {result.get('status', 'Unknown')}.",
        )
    manifest = result.get("manifest")
    if not isinstance(manifest, dict):
        raise HTTPException(status_code=502, detail="Azure Cost Details operation returned no report manifest.")
    blobs = manifest.get("blobs", [])
    if not isinstance(blobs, list):
        raise HTTPException(status_code=502, detail="Azure Cost Details manifest contains an invalid blob list.")
    return _cost_details_csv_bytes(blobs, bool(manifest.get("compressData")))


def generate_cost_details_csv(
    subscription_id: str,
    start: date,
    end: date,
    access_token: str,
    *,
    customer_id: str,
    tenant_id: str,
) -> bytes:
    subscription_id = validate_subscription_id(subscription_id)
    if end < start:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")
    if (start.year, start.month) != (end.year, end.month):
        raise HTTPException(
            status_code=400,
            detail="Azure Cost Details exports must be limited to a single calendar month.",
        )

    cache_key = sha256(
        json.dumps(
            {
                "tenant_id": tenant_id,
                "customer_id": customer_id,
                "subscription_id": subscription_id,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with _cost_state_lock:
        now = time_module.monotonic()
        cached = _cost_details_cache.get(cache_key)
        if cached is not None and cached[0] > now:
            _cost_details_cache[cache_key] = (cached[0], cached[1])
            return cached[1]
        if cached is not None:
            del _cost_details_cache[cache_key]

        future = _cost_details_inflight.get(cache_key)
        is_leader = future is None
        if future is None:
            future = Future()
            _cost_details_inflight[cache_key] = future

    if not is_leader:
        try:
            return future.result(timeout=MAX_COST_DETAILS_WAIT_SECONDS + 120)
        except FutureTimeoutError as exc:
            raise HTTPException(
                status_code=503,
                detail="An identical Cost Details export is still being generated. Please retry shortly.",
                headers={"Retry-After": "30"},
            ) from exc

    try:
        report = _generate_cost_details_csv_uncached(subscription_id, start, end, access_token)
        expires_at = time_module.monotonic() + COST_DETAILS_CACHE_TTL_SECONDS
        with _cost_state_lock:
            _cost_details_cache[cache_key] = (expires_at, report)
            while len(_cost_details_cache) > MAX_COST_DETAILS_CACHE_ENTRIES:
                oldest_key = next(iter(_cost_details_cache))
                del _cost_details_cache[oldest_key]
        future.set_result(report)
        return report
    except Exception as exc:
        future.set_exception(exc)
        raise
    finally:
        with _cost_state_lock:
            if _cost_details_inflight.get(cache_key) is future:
                del _cost_details_inflight[cache_key]


def _cost_usage_date(value: Any) -> date:
    raw_date = str(value)
    if raw_date.isdigit() and len(raw_date) == 8:
        return datetime.strptime(raw_date, "%Y%m%d").date()
    try:
        return date.fromisoformat(raw_date[:10])
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Azure Cost Management returned an invalid usage date.") from exc


def _parse_cost_rows(
    result: dict[str, Any],
    start: date,
    end: date,
    granularity: str,
) -> dict[str, Any]:
    columns = [column.get("name", "").lower() for column in result.get("properties", {}).get("columns", [])]
    rows = result.get("properties", {}).get("rows", [])
    cost_index = next((i for i, name in enumerate(columns) if name in {"pretaxcost", "totalcost"}), None)
    date_index = next((i for i, name in enumerate(columns) if name in {"usagedate", "date"}), None)
    service_index = next((i for i, name in enumerate(columns) if name in {"servicename", "service"}), None)
    resource_index = next((i for i, name in enumerate(columns) if name == "resourceid"), None)
    currency_index = next((i for i, name in enumerate(columns) if name in {"currency", "billingcurrency"}), None)
    if cost_index is None:
        raise HTTPException(status_code=502, detail="Azure Cost Management returned no cost column.")
    if date_index is None:
        raise HTTPException(status_code=502, detail="Azure Cost Management returned no usage date for the selected range.")

    trend: dict[str, dict[str, Any]] = {}
    service_trend: dict[str, dict[str, float]] = {}
    service_resource_trend: dict[str, dict[str, dict[str, dict[str, float]]]] = {}
    resource_trend: dict[str, dict[str, float]] = {}
    services: dict[str, float] = {}
    resources: dict[str, float] = {}
    total = 0.0
    currency = "—"
    for row in rows:
        usage_date = _cost_usage_date(row[date_index])
        if usage_date < start or usage_date > end:
            continue
        amount = float(row[cost_index] or 0)
        total += amount
        period = usage_date.isoformat() if granularity == "Daily" else usage_date.strftime("%Y-%m")
        period_data = trend.setdefault(period, {"cost": 0.0, "from": usage_date, "to": usage_date})
        period_data["cost"] += amount
        period_data["from"] = min(period_data["from"], usage_date)
        period_data["to"] = max(period_data["to"], usage_date)
        if service_index is not None:
            service = str(row[service_index] or "Other")
            services[service] = services.get(service, 0.0) + amount
            period_services = service_trend.setdefault(period, {})
            period_services[service] = period_services.get(service, 0.0) + amount
            if resource_index is not None:
                resource_id = str(row[resource_index] or "Unassigned")
                period_service_resources = service_resource_trend.setdefault(period, {})
                service_resources = period_service_resources.setdefault(service, {})
                service_resources[resource_id] = service_resources.get(resource_id, 0.0) + amount
        if resource_index is not None:
            resource = str(row[resource_index] or "Unassigned")
            resources[resource] = resources.get(resource, 0.0) + amount
            period_resources = resource_trend.setdefault(period, {})
            period_resources[resource] = period_resources.get(resource, 0.0) + amount
        if currency_index is not None and row[currency_index]:
            currency = str(row[currency_index])

    return {
        "total": total,
        "currency": currency,
        "trend": [
            {
                "period": key,
                "cost": value["cost"],
                "from": value["from"].isoformat(),
                "to": value["to"].isoformat(),
            }
            for key, value in sorted(trend.items())
        ],
        "serviceTrend": [
            {
                "period": period,
                "services": [
                    {"name": service, "cost": amount}
                    for service, amount in sorted(
                        period_services.items(),
                        key=lambda item: item[1],
                        reverse=True,
                    )
                ],
            }
            for period, period_services in sorted(service_trend.items())
        ],
        "serviceResourceTrend": [
            {
                "period": period,
                "services": [
                    {
                        "name": service,
                        "resources": [
                            {"resourceId": resource_id, "cost": amount}
                            for resource_id, amount in sorted(
                                service_resources.items(),
                                key=lambda item: item[1],
                                reverse=True,
                            )
                        ],
                    }
                    for service, service_resources in sorted(period_services.items())
                ],
            }
            for period, period_services in sorted(service_resource_trend.items())
        ],
        "resourceTrend": [
            {
                "period": period,
                "resources": [
                    {"resourceId": resource_id, "cost": amount}
                    for resource_id, amount in sorted(
                        period_resources.items(),
                        key=lambda item: item[1],
                        reverse=True,
                    )
                ],
            }
            for period, period_resources in sorted(resource_trend.items())
        ],
        "byService": [{"name": key, "cost": value} for key, value in sorted(services.items(), key=lambda item: item[1], reverse=True)],
        "byResource": [{"resourceId": key, "cost": value} for key, value in sorted(resources.items(), key=lambda item: item[1], reverse=True)],
    }


def _read_cached_cost_result(db: Session, cache_key: str) -> dict[str, Any] | None:
    cached = db.get(CostQueryCache, cache_key)
    if cached is None:
        return None
    try:
        response_data = json.loads(cached.response_json)
    except json.JSONDecodeError:
        response_data = None
    if cached.expires_at <= time_module.time() or not isinstance(response_data, dict):
        db.delete(cached)
        db.commit()
        return None
    return response_data


def _query_costs_uncached(
    subscription_id: str,
    start: date,
    end: date,
    granularity: str,
    access_token: str,
    compare: bool = True,
    comparison_range: tuple[date, date] | None = None,
) -> dict[str, Any]:
    scope = _scope(subscription_id)
    if not compare:
        current_result = _cost_query(
            scope,
            start,
            end,
            "Daily",
            access_token,
        )
        current = _parse_cost_rows(current_result, start, end, granularity)
        return {
            **current,
            "previousTotal": None,
            "previousByService": [],
            "serviceComparison": [],
            "resourceComparison": [],
            "change": None,
            "changePercent": None,
            "previousRange": None,
            "previousTrend": [],
            "previousServiceTrend": [],
            "previousServiceResourceTrend": [],
            "previousResourceTrend": [],
            "range": {"from": start.isoformat(), "to": end.isoformat()},
            "granularity": granularity,
            "comparisonEnabled": False,
        }

    if comparison_range is None:
        raise HTTPException(
            status_code=400,
            detail="Explicit comparison dates are required; automatic comparison periods are disabled.",
        )
    previous_start, previous_end = comparison_range
    if previous_end < previous_start:
        raise HTTPException(status_code=400, detail="Comparison end date must be on or after its start date.")
    query_start = min(start, previous_start)
    query_end = max(end, previous_end)
    combined_result = _cost_query(scope, query_start, query_end, "Daily", access_token)
    current = _parse_cost_rows(combined_result, start, end, granularity)
    previous = _parse_cost_rows(combined_result, previous_start, previous_end, granularity)
    change = current["total"] - previous["total"]
    change_percent = (change / previous["total"] * 100) if previous["total"] else None
    previous_services = {item["name"]: item["cost"] for item in previous["byService"]}
    current_services = {item["name"]: item["cost"] for item in current["byService"]}
    previous_resources = {item["resourceId"]: item["cost"] for item in previous["byResource"]}
    current_resources = {item["resourceId"]: item["cost"] for item in current["byResource"]}
    service_comparison = [
        {
            "name": name,
            "current": current_services.get(name, 0.0),
            "previous": previous_services.get(name, 0.0),
            "change": current_services.get(name, 0.0) - previous_services.get(name, 0.0),
        }
        for name in sorted(current_services.keys() | previous_services.keys())
    ]
    resource_comparison = [
        {
            "resourceId": resource_id,
            "current": current_resources.get(resource_id, 0.0),
            "previous": previous_resources.get(resource_id, 0.0),
            "change": current_resources.get(resource_id, 0.0) - previous_resources.get(resource_id, 0.0),
        }
        for resource_id in current_resources.keys() | previous_resources.keys()
    ]
    return {
        **current,
        "previousTotal": previous["total"],
        "previousTrend": previous["trend"],
        "previousServiceTrend": previous["serviceTrend"],
        "previousServiceResourceTrend": previous["serviceResourceTrend"],
        "previousResourceTrend": previous["resourceTrend"],
        "previousByService": previous["byService"],
        "serviceComparison": sorted(service_comparison, key=lambda item: item["current"], reverse=True),
        "resourceComparison": sorted(
            resource_comparison,
            key=lambda item: (item["current"], item["previous"], item["resourceId"]),
            reverse=True,
        ),
        "change": change,
        "changePercent": change_percent,
        "previousRange": {"from": previous_start.isoformat(), "to": previous_end.isoformat()},
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "granularity": granularity,
        "comparisonEnabled": True,
    }


def query_costs(
    subscription_id: str,
    start: date,
    end: date,
    granularity: str,
    access_token: str,
    compare: bool = True,
    *,
    customer_id: str,
    tenant_id: str,
    db: Session,
    comparison_range: tuple[date, date] | None = None,
) -> dict[str, Any]:
    subscription_id = validate_subscription_id(subscription_id)
    key_data = {
        "response_version": 6,
        "customer_id": customer_id,
        "tenant_id": tenant_id,
        "subscription_id": subscription_id,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "granularity": granularity,
        "compare": compare,
        "comparison_start_date": comparison_range[0].isoformat() if comparison_range else None,
        "comparison_end_date": comparison_range[1].isoformat() if comparison_range else None,
    }
    cache_key = sha256(json.dumps(key_data, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    throttle_key = (customer_id, tenant_id, subscription_id)
    cached_result = _read_cached_cost_result(db, cache_key)
    if cached_result is not None:
        return cached_result

    with _cost_state_lock:
        future = _cost_inflight.get(cache_key)
        is_leader = future is None
        if future is None:
            future = Future()
            _cost_inflight[cache_key] = future

    if not is_leader:
        try:
            return deepcopy(future.result(timeout=COST_QUERY_WAIT_TIMEOUT_SECONDS))
        except FutureTimeoutError as exc:
            raise HTTPException(
                status_code=503,
                detail="An identical cost query is still running. Please retry shortly.",
                headers={"Retry-After": "5"},
            ) from exc

    try:
        cached_result = _read_cached_cost_result(db, cache_key)
        if cached_result is not None:
            future.set_result(cached_result)
            return deepcopy(cached_result)

        with _cost_state_lock:
            throttle = _cost_throttle_until.get(throttle_key)
            if throttle and throttle > time_module.monotonic():
                retry_after = max(1, int(throttle - time_module.monotonic() + 0.999))
                raise HTTPException(
                    status_code=429,
                    detail=f"Azure throttling cooldown is active. Please retry in {retry_after} seconds.",
                    headers={
                        "Retry-After": str(retry_after),
                        "X-Cost-RateLimit-Source": "local-cooldown",
                    },
                )

        if not _cost_queue_slots.acquire(blocking=False):
            raise HTTPException(
                status_code=503,
                detail="The cost query queue is full. Please retry shortly.",
                headers={"Retry-After": "10"},
            )
        try:
            if not _cost_query_semaphore.acquire(timeout=COST_QUERY_QUEUE_TIMEOUT_SECONDS):
                raise HTTPException(
                    status_code=503,
                    detail="Cost query capacity is busy. Please retry shortly.",
                    headers={"Retry-After": "10"},
                )
            try:
                try:
                    result = _query_costs_uncached(
                        subscription_id,
                        start,
                        end,
                        granularity,
                        access_token,
                        compare,
                        comparison_range,
                    )
                except HTTPException as exc:
                    if exc.status_code == 429:
                        retry_after_header = exc.headers.get("Retry-After") if exc.headers else None
                        upstream_delay = _retry_after_seconds(retry_after_header)
                        retry_after = max(1, int(upstream_delay + 0.999)) if upstream_delay is not None else DEFAULT_COST_THROTTLE_DELAY_SECONDS
                        with _cost_state_lock:
                            _cost_throttle_until[throttle_key] = time_module.monotonic() + retry_after
                        raise HTTPException(
                            status_code=429,
                            detail=(
                                f"Azure returned HTTP 429: {exc.detail} "
                                f"Wait {retry_after} seconds before retrying."
                            ),
                            headers={
                                "Retry-After": str(retry_after),
                                "X-Cost-RateLimit-Source": "upstream-azure",
                            },
                        ) from exc
                    raise
            finally:
                _cost_query_semaphore.release()
        finally:
            _cost_queue_slots.release()

        try:
            serialized_response = json.dumps(result, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=500, detail="Azure cost data could not be cached safely.") from exc
        try:
            cache_record = db.get(CostQueryCache, cache_key)
            if cache_record is None:
                cache_record = CostQueryCache(cache_key=cache_key, response_json=serialized_response)
                db.add(cache_record)
            else:
                cache_record.response_json = serialized_response
            cache_record.expires_at = time_module.time() + COST_CACHE_TTL_SECONDS
            db.query(CostQueryCache).filter(CostQueryCache.expires_at <= time_module.time()).delete(
                synchronize_session=False
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            _logger.error("Could not persist successful Azure cost result (%s).", type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail="Azure returned cost data, but the result could not be saved for reuse.",
            ) from exc

        with _cost_state_lock:
            _cost_throttle_until.pop(throttle_key, None)
        future.set_result(deepcopy(result))
        return result
    except Exception as exc:
        if not future.done():
            future.set_exception(exc)
        raise
    finally:
        with _cost_state_lock:
            if _cost_inflight.get(cache_key) is future:
                del _cost_inflight[cache_key]
