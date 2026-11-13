from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import msal
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.models.auth import AzureAuthSession

SESSION_COOKIE = "azure_session"
STATE_COOKIE = "azure_oauth_state"
ARM_SCOPE = "https://management.azure.com/user_impersonation"
SCOPES = [ARM_SCOPE]


@dataclass(frozen=True)
class AzureOAuthConfig:
    client_id: str
    client_secret: str
    authority: str
    redirect_uri: str
    frontend_origin: str
    encryption_key: bytes
    secure_cookie: bool


def get_oauth_config() -> AzureOAuthConfig | None:
    client_id = os.getenv("AZURE_CLIENT_ID")
    client_secret = os.getenv("AZURE_CLIENT_SECRET")
    encryption_key = os.getenv("AZURE_TOKEN_ENCRYPTION_KEY")
    if not client_id or not client_secret or not encryption_key:
        return None

    authority = os.getenv(
        "AZURE_AUTHORITY",
        "https://login.microsoftonline.com/common",
    ).rstrip("/")
    parsed_authority = urlparse(authority)
    if (
        parsed_authority.scheme != "https"
        or parsed_authority.netloc.lower() != "login.microsoftonline.com"
        or parsed_authority.path not in {"/common", "/organizations"}
        or parsed_authority.query
        or parsed_authority.fragment
    ):
        raise HTTPException(
            status_code=500,
            detail="AZURE_AUTHORITY must use the shared Microsoft Entra common or organizations endpoint.",
        )

    try:
        Fernet(encryption_key.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail="AZURE_TOKEN_ENCRYPTION_KEY must be a valid Fernet key.",
        ) from exc

    redirect_uri = os.getenv(
        "AZURE_REDIRECT_URI",
        "http://127.0.0.1:3000/api/auth/callback",
    )
    frontend_origin = os.getenv("APP_ORIGIN", "http://127.0.0.1:3000").rstrip("/")
    secure_cookie = os.getenv(
        "APP_COOKIE_SECURE",
        "true"
        if frontend_origin.startswith("https://") or redirect_uri.startswith("https://")
        else "false",
    ).lower() == "true"
    if os.getenv("APP_ENV", "development").lower() in {"prod", "production"}:
        if (
            not secure_cookie
            or not frontend_origin.startswith("https://")
            or not redirect_uri.startswith("https://")
        ):
            raise HTTPException(
                status_code=500,
                detail="Production requires HTTPS APP_ORIGIN and AZURE_REDIRECT_URI with APP_COOKIE_SECURE=true.",
            )

    return AzureOAuthConfig(
        client_id=client_id,
        client_secret=client_secret,
        authority=authority,
        redirect_uri=redirect_uri,
        frontend_origin=frontend_origin,
        encryption_key=encryption_key.encode("ascii"),
        secure_cookie=secure_cookie,
    )


def create_msal_app(config: AzureOAuthConfig, cache: msal.SerializableTokenCache) -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        config.client_id,
        authority=config.authority,
        client_credential=config.client_secret,
        token_cache=cache,
    )


def encrypt_cache(config: AzureOAuthConfig, serialized_cache: str) -> str:
    return Fernet(config.encryption_key).encrypt(serialized_cache.encode("utf-8")).decode("ascii")


def decrypt_cache(config: AzureOAuthConfig, ciphertext: str) -> str:
    try:
        return Fernet(config.encryption_key).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeEncodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail="The saved Azure token cache cannot be decrypted. Check AZURE_TOKEN_ENCRYPTION_KEY.",
        ) from exc


def require_config() -> AzureOAuthConfig:
    config = get_oauth_config()
    if config is None:
        raise HTTPException(
            status_code=503,
            detail="Azure sign-in is not configured. Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, and AZURE_TOKEN_ENCRYPTION_KEY.",
        )
    return config


def get_session_record(request: Request, db: Session) -> AzureAuthSession:
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        raise HTTPException(status_code=401, detail="Connect a Microsoft Azure account first.")
    record = db.get(AzureAuthSession, session_id)
    if record is None:
        raise HTTPException(status_code=401, detail="Your Azure session has expired. Connect again.")
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        db.delete(record)
        db.commit()
        raise HTTPException(status_code=401, detail="Your Azure session has expired. Connect again.")
    return record


def get_arm_access_token(
    request: Request,
    db: Session,
) -> tuple[str, AzureAuthSession, dict[str, Any]]:
    record = get_session_record(request, db)
    return get_arm_access_token_for_record(record, db)


def get_arm_access_token_for_record(
    record: AzureAuthSession,
    db: Session,
) -> tuple[str, AzureAuthSession, dict[str, Any]]:
    config = require_config()
    tenant_config = config_for_tenant(config, record.tenant_id)
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Your Azure session has expired. Connect again.")
    cache = msal.SerializableTokenCache()
    cache.deserialize(decrypt_cache(config, record.encrypted_token_cache))
    client = create_msal_app(tenant_config, cache)
    account = next(
        (
            candidate
            for candidate in client.get_accounts()
            if candidate.get("home_account_id") == record.home_account_id
        ),
        None,
    )
    if account is None:
        raise HTTPException(status_code=401, detail="The Azure account session expired. Connect again.")

    result = client.acquire_token_silent(SCOPES, account=account)
    if not result or "access_token" not in result:
        raise HTTPException(status_code=401, detail="Azure authorization expired. Reconnect your Azure account.")

    if cache.has_state_changed:
        record.encrypted_token_cache = encrypt_cache(config, cache.serialize())
        db.commit()
    return result["access_token"], record, account


def create_authorization_url(config: AzureOAuthConfig) -> tuple[str, str]:
    state = secrets.token_urlsafe(32)
    app = create_msal_app(config, msal.SerializableTokenCache())
    url = app.get_authorization_request_url(
        SCOPES,
        state=state,
        redirect_uri=config.redirect_uri,
        prompt="consent",
    )
    return url, state


def validate_tenant_id(tenant_id: Any) -> str:
    if not isinstance(tenant_id, str):
        raise HTTPException(status_code=401, detail="Microsoft did not return a valid organization tenant.")
    try:
        return str(UUID(tenant_id))
    except ValueError as exc:
        raise HTTPException(
            status_code=401,
            detail="Microsoft did not return a valid organization tenant.",
        ) from exc


def validate_tenant_claims(claims: Any) -> str:
    if not isinstance(claims, dict):
        raise HTTPException(status_code=401, detail="Microsoft did not return valid organization claims.")
    tenant_id = validate_tenant_id(claims.get("tid"))
    issuer = claims.get("iss")
    expected_issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    if not isinstance(issuer, str) or issuer.rstrip("/").lower() != expected_issuer.lower():
        raise HTTPException(status_code=401, detail="Microsoft returned an invalid organization token issuer.")
    return tenant_id


def config_for_tenant(config: AzureOAuthConfig, tenant_id: Any) -> AzureOAuthConfig:
    validated_tenant_id = validate_tenant_id(tenant_id)
    return replace(
        config,
        authority=f"https://login.microsoftonline.com/{validated_tenant_id}",
    )
