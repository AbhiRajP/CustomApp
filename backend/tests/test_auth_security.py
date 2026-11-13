from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet
from fastapi import HTTPException, Response
from starlette.requests import Request

from app.main import auth_callback, auth_login, auth_status
from app.models.auth import AzureAuthSession
from app.services.azure_auth import AzureOAuthConfig


TENANT_ID = "a1111111-2222-3333-4444-555555555555"


def request_with_cookie(cookie: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/auth/callback",
            "headers": [(b"cookie", cookie.encode("ascii"))],
            "query_string": b"",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
            "scheme": "http",
        }
    )


def oauth_config() -> AzureOAuthConfig:
    return AzureOAuthConfig(
        client_id="shared-client-id",
        client_secret="shared-client-secret",
        authority="https://login.microsoftonline.com/common",
        redirect_uri="https://app.example.test/api/auth/callback",
        frontend_origin="https://app.example.test",
        encryption_key=Fernet.generate_key(),
        secure_cookie=True,
    )


class OAuthSecurityTests(unittest.TestCase):
    def test_login_sets_secure_http_only_state_cookie(self) -> None:
        config = oauth_config()
        with (
            patch("app.main.require_config", return_value=config),
            patch(
                "app.main.create_authorization_url",
                return_value=("https://login.microsoftonline.com/common/authorize", "random-state"),
            ),
        ):
            response = auth_login(Response())

        cookie = response.headers["set-cookie"]
        self.assertIn("azure_oauth_state=", cookie)
        self.assertIn("httponly", cookie.lower())
        self.assertIn("secure", cookie.lower())
        self.assertIn("samesite=lax", cookie.lower())

    def test_callback_rejects_mismatched_oauth_state(self) -> None:
        with patch("app.main.require_config", return_value=oauth_config()):
            with self.assertRaises(HTTPException) as raised:
                auth_callback(
                    request_with_cookie("azure_oauth_state=expected"),
                    Response(),
                    code="authorization-code",
                    state="attacker-state",
                    db=Mock(),
                )

        self.assertEqual(raised.exception.status_code, 400)

    def test_auth_status_does_not_return_token_or_secret_fields(self) -> None:
        record = AzureAuthSession(
            id="opaque-session",
            tenant_id=TENANT_ID,
            home_account_id="tenant-account",
            encrypted_token_cache="encrypted-private-token-cache",
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        db = Mock()
        db.get.return_value = record

        with patch("app.main.get_oauth_config", return_value=oauth_config()):
            payload = auth_status(
                request_with_cookie("azure_session=opaque-session"),
                db,
            )

        self.assertEqual(
            set(payload),
            {"configured", "connected", "tenantId", "costCacheScope"},
        )
        self.assertNotIn("encrypted_token_cache", payload)
        self.assertNotIn("client_secret", payload)
        self.assertNotIn("access_token", payload)
        self.assertNotIn("refresh_token", payload)
