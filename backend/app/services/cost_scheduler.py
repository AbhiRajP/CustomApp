from __future__ import annotations

from datetime import date, datetime, timezone
import logging
from threading import Event

from fastapi import HTTPException

from app.core.database import SessionLocal
from app.models.auth import AzureAuthSession, CustomerPreference
from app.services.azure_auth import get_arm_access_token_for_record
from app.services.azure_monitoring import customer_cache_id, query_costs

logger = logging.getLogger(__name__)


def collect_current_month_costs() -> None:
    db = SessionLocal()
    processed: set[tuple[str, str, str]] = set()
    try:
        for record in db.query(AzureAuthSession).all():
            expires_at = record.expires_at
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= datetime.now(timezone.utc):
                continue
            preference = db.get(CustomerPreference, record.tenant_id)
            if not preference or not preference.subscription_id:
                continue
            work_key = (record.tenant_id, record.home_account_id, preference.subscription_id)
            if work_key in processed:
                continue
            processed.add(work_key)
            try:
                access_token, auth_session, _ = get_arm_access_token_for_record(record, db)
                customer_id = customer_cache_id(auth_session.tenant_id, auth_session.home_account_id)
                today = date.today()
                query_costs(
                    preference.subscription_id,
                    today.replace(day=1),
                    today,
                    "Monthly",
                    access_token,
                    compare=False,
                    customer_id=customer_id,
                    tenant_id=auth_session.tenant_id,
                    db=db,
                )
            except HTTPException as exc:
                logger.warning(
                    "Scheduled cost collection skipped status=%d source=%s",
                    exc.status_code,
                    exc.headers.get("X-Cost-RateLimit-Source", "backend"),
                )
            except Exception as exc:
                db.rollback()
                logger.error("Scheduled cost collection failed error_type=%s", type(exc).__name__)
    finally:
        db.close()


def run_cost_collection_scheduler(stop_event: Event, interval_seconds: int) -> None:
    while not stop_event.wait(interval_seconds):
        collect_current_month_costs()
