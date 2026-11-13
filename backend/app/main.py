from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import os
import secrets
from datetime import date, datetime, timedelta, timezone
from threading import Event, Thread
from typing import Literal

import msal
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.database import SessionLocal, init_db
from app.models.auth import AzureAuthSession, CustomerPreference
from app.services.azure_auth import (
    SESSION_COOKIE,
    STATE_COOKIE,
    create_authorization_url,
    create_msal_app,
    decrypt_cache,
    encrypt_cache,
    get_arm_access_token,
    get_oauth_config,
    require_config,
)
from app.services.cost_scheduler import run_cost_collection_scheduler
from app.services.azure_monitoring import (
    customer_cache_id,
    generate_cost_details_csv,
    list_resources,
    list_subscriptions,
    query_costs,
    validate_cost_date_ranges,
    validate_subscription_id,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    interval_seconds = int(os.getenv("COST_COLLECTION_INTERVAL_SECONDS", "0"))
    if interval_seconds < 0:
        raise RuntimeError("COST_COLLECTION_INTERVAL_SECONDS must be zero or a positive number.")
    stop_event = Event()
    worker = None
    if interval_seconds:
        worker = Thread(
            target=run_cost_collection_scheduler,
            args=(stop_event, interval_seconds),
            name="azure-cost-collection",
            daemon=True,
        )
        worker.start()
        logger.info("Scheduled cost collection enabled interval_seconds=%d", interval_seconds)
    try:
        yield
    finally:
        if worker:
            stop_event.set()
            worker.join(timeout=5)


app = FastAPI(title="Azure Cloud Monitoring & Cost Intelligence", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("APP_ORIGIN", "http://127.0.0.1:3000").rstrip("/")],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type"],
)

init_db()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class CustomerSettings(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    subscription_id: str | None = Field(default=None, alias="subscriptionId", max_length=80)


def _preference_for(tenant_id: str, db: Session) -> CustomerPreference:
    preference = db.get(CustomerPreference, tenant_id)
    if preference is None:
        preference = CustomerPreference(tenant_id=tenant_id)
        db.add(preference)
        db.commit()
        db.refresh(preference)
    return preference


def _serialize_preferences(preference: CustomerPreference) -> dict[str, object]:
    return {"subscriptionId": preference.subscription_id}


@app.get("/api/health")
def health() -> dict[str, object]:
    oauth_configured = get_oauth_config() is not None
    return {
        "status": "ok",
        "service": "azure-cloud-monitoring-api",
        "azureOAuthConfigured": oauth_configured,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/api/auth/status")
def auth_status(request: Request, db: Session = Depends(get_db)) -> dict[str, object]:
    oauth_configured = get_oauth_config() is not None
    session_id = request.cookies.get(SESSION_COOKIE)
    record = db.get(AzureAuthSession, session_id) if session_id else None
    if record:
        expiry = record.expires_at
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(timezone.utc):
            db.delete(record)
            db.commit()
            record = None
    return {
        "configured": oauth_configured,
        "connected": record is not None,
        "tenantId": record.tenant_id if record else None,
        "costCacheScope": (
            customer_cache_id(record.tenant_id, record.home_account_id) if record else None
        ),
    }


@app.get("/api/auth/login")
def auth_login(response: Response) -> Response:
    oauth_config = require_config()
    authorization_url, state = create_authorization_url(oauth_config)
    response = RedirectResponse(authorization_url, status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        httponly=True,
        secure=oauth_config.secure_cookie,
        samesite="lax",
        max_age=600,
        path="/",
    )
    return response


@app.get("/api/auth/callback")
def auth_callback(
    request: Request,
    response: Response,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    oauth_config = require_config()
    expected_state = request.cookies.get(STATE_COOKIE)
    if not expected_state:
        raise HTTPException(
            status_code=400,
            detail=(
                "The Azure sign-in state cookie is missing or expired. Open the app and start sign-in again "
                "using the same hostname throughout (for example, always use localhost, not a mix of localhost and 127.0.0.1)."
            ),
        )
    if not state or not secrets.compare_digest(state, expected_state):
        raise HTTPException(status_code=400, detail="Invalid or expired Microsoft sign-in state. Start sign-in again.")
    if error:
        logger.warning("Microsoft sign-in was rejected by the identity provider.")
        raise HTTPException(status_code=401, detail="Microsoft sign-in could not be completed. Start Azure sign-in again.")
    if not code:
        raise HTTPException(
            status_code=400,
            detail="Microsoft did not return the sign-in code. Start a new Azure sign-in.",
        )

    cache = msal.SerializableTokenCache()
    client = create_msal_app(oauth_config, cache)
    result = client.acquire_token_by_authorization_code(
        code,
        scopes=["https://management.azure.com/user_impersonation"],
        redirect_uri=oauth_config.redirect_uri,
    )
    if "access_token" not in result:
        logger.warning("Microsoft token exchange failed.")
        raise HTTPException(status_code=401, detail="Could not complete Azure sign-in. Start a new sign-in.")

    accounts = client.get_accounts()
    if not accounts:
        raise HTTPException(status_code=401, detail="Microsoft sign-in completed without an account.")
    claims = result.get("id_token_claims") or {}
    tenant_id = claims.get("tid")
    home_account_id = accounts[0].get("home_account_id")
    if not tenant_id or not home_account_id:
        raise HTTPException(status_code=401, detail="Microsoft did not return the required tenant/account identifiers.")

    session_id = secrets.token_urlsafe(32)
    db.add(
        AzureAuthSession(
            id=session_id,
            tenant_id=tenant_id,
            home_account_id=home_account_id,
            encrypted_token_cache=encrypt_cache(oauth_config, cache.serialize()),
            expires_at=datetime.now(timezone.utc) + timedelta(days=14),
        )
    )
    db.commit()

    redirect = RedirectResponse(f"{oauth_config.frontend_origin}/connect-azure?connected=1", status_code=303)
    redirect.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        secure=oauth_config.secure_cookie,
        samesite="lax",
        max_age=14 * 24 * 60 * 60,
        path="/",
    )
    redirect.delete_cookie(STATE_COOKIE, path="/")
    return redirect


@app.post("/api/auth/logout")
def auth_logout(request: Request, db: Session = Depends(get_db)) -> Response:
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        record = db.get(AzureAuthSession, session_id)
        if record:
            db.delete(record)
            db.commit()
    oauth_config = get_oauth_config()
    response = Response(status_code=204)
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        secure=oauth_config.secure_cookie if oauth_config else False,
        httponly=True,
        samesite="lax",
    )
    return response


@app.get("/api/subscriptions")
def get_subscriptions(request: Request, db: Session = Depends(get_db)) -> dict[str, object]:
    access_token, _, _ = get_arm_access_token(request, db)
    return {"items": list_subscriptions(access_token)}


@app.get("/api/resources")
def get_resources(
    subscription_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    access_token, _, _ = get_arm_access_token(request, db)
    items = list_resources(subscription_id, access_token)
    return {"items": items, "total": len(items)}


@app.get("/api/cost-details")
def get_cost_details(
    subscription_id: str,
    start_date: date,
    end_date: date,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    if end_date > date.today():
        raise HTTPException(status_code=400, detail="Cost Details reports cannot include future dates.")
    access_token, auth_session, _ = get_arm_access_token(request, db)
    report_csv = generate_cost_details_csv(
        subscription_id,
        start_date,
        end_date,
        access_token,
        customer_id=customer_cache_id(auth_session.tenant_id, auth_session.home_account_id),
        tenant_id=auth_session.tenant_id,
    )
    filename = f"azure-cost-details-{start_date.isoformat()}-to-{end_date.isoformat()}.csv"
    return Response(
        content=report_csv,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/preferences")
def get_preferences(request: Request, db: Session = Depends(get_db)) -> dict[str, object]:
    _, auth_session, _ = get_arm_access_token(request, db)
    return _serialize_preferences(_preference_for(auth_session.tenant_id, db))


@app.put("/api/preferences")
def save_preferences(
    settings: CustomerSettings,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _, auth_session, _ = get_arm_access_token(request, db)
    if settings.subscription_id:
        settings.subscription_id = validate_subscription_id(settings.subscription_id)
    preference = _preference_for(auth_session.tenant_id, db)
    preference.subscription_id = settings.subscription_id
    db.commit()
    db.refresh(preference)
    return _serialize_preferences(preference)


@app.get("/api/costs")
def get_costs(
    subscription_id: str,
    start_date: date,
    end_date: date,
    request: Request,
    granularity: Literal["Daily", "Monthly"] = "Monthly",
    compare: bool = True,
    comparison_start_date: date | None = None,
    comparison_end_date: date | None = None,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if (comparison_start_date is None) != (comparison_end_date is None):
        raise HTTPException(
            status_code=400,
            detail="Provide both comparison_start_date and comparison_end_date.",
        )
    if compare and comparison_start_date is None:
        raise HTTPException(
            status_code=400,
            detail="Set comparison_start_date and comparison_end_date to compare explicit periods.",
        )
    if not compare and comparison_start_date:
        raise HTTPException(
            status_code=400,
            detail="Comparison dates require compare=true.",
        )
    validate_cost_date_ranges(
        start_date,
        end_date,
        (comparison_start_date, comparison_end_date)
        if comparison_start_date and comparison_end_date
        else None,
    )
    access_token, auth_session, _ = get_arm_access_token(request, db)
    customer_id = customer_cache_id(auth_session.tenant_id, auth_session.home_account_id)
    return query_costs(
        subscription_id,
        start_date,
        end_date,
        granularity,
        access_token,
        compare,
        customer_id=customer_id,
        tenant_id=auth_session.tenant_id,
        db=db,
        comparison_range=(
            (comparison_start_date, comparison_end_date)
            if comparison_start_date and comparison_end_date
            else None
        ),
    )


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "Azure Cloud Monitoring & Cost Intelligence API is running."}
