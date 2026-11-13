from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet
from fastapi import HTTPException

from app.models.auth import AzureAuthSession
from app.services.azure_auth import (
    config_for_tenant,
    decrypt_cache,
    encrypt_cache,
    get_arm_access_token_for_record,
    get_oauth_config,
    validate_tenant_id,
    validate_tenant_claims,
)


TENANT_ID = "a1111111-2222-3333-4444-555555555555"


class SharedMultitenantAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {
                "AZURE_CLIENT_ID": "shared-client-id",
                "AZURE_CLIENT_SECRET": "shared-client-secret",
                "AZURE_TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=True,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_default_authority_uses_shared_common_endpoint(self) -> None:
        config = get_oauth_config()

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.authority, "https://login.microsoftonline.com/common")
        self.assertEqual(config.redirect_uri, "http://127.0.0.1:3000/api/auth/callback")

    def test_tenant_id_is_normalized_and_used_for_arm_authority(self) -> None:
        config = get_oauth_config()
        assert config is not None

        tenant_config = config_for_tenant(config, TENANT_ID.upper())

        self.assertEqual(tenant_config.authority, f"https://login.microsoftonline.com/{TENANT_ID}")
        self.assertEqual(tenant_config.client_id, config.client_id)
        self.assertEqual(tenant_config.client_secret, config.client_secret)

    def test_invalid_tenant_id_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            validate_tenant_id("common")

        self.assertEqual(raised.exception.status_code, 401)

    def test_tenant_claims_require_matching_microsoft_issuer(self) -> None:
        claims = {
            "tid": TENANT_ID,
            "iss": f"https://login.microsoftonline.com/{TENANT_ID}/v2.0",
        }

        self.assertEqual(validate_tenant_claims(claims), TENANT_ID)

        claims["iss"] = "https://login.microsoftonline.com/aaaaaaaa-2222-3333-4444-555555555555/v2.0"
        with self.assertRaises(HTTPException):
            validate_tenant_claims(claims)

    def test_tenant_claims_reject_missing_issuer(self) -> None:
        with self.assertRaises(HTTPException):
            validate_tenant_claims({"tid": TENANT_ID})

    def test_customer_specific_authority_is_rejected(self) -> None:
        os.environ["AZURE_AUTHORITY"] = f"https://login.microsoftonline.com/{TENANT_ID}"

        with self.assertRaises(HTTPException) as raised:
            get_oauth_config()

        self.assertEqual(raised.exception.status_code, 500)

    def test_production_requires_https_and_secure_cookies(self) -> None:
        os.environ.update(
            {
                "APP_ENV": "production",
                "APP_ORIGIN": "https://app.example.test",
                "AZURE_REDIRECT_URI": "https://app.example.test/api/auth/callback",
                "APP_COOKIE_SECURE": "false",
            }
        )

        with self.assertRaises(HTTPException) as raised:
            get_oauth_config()

        self.assertEqual(raised.exception.status_code, 500)

    def test_token_cache_is_encrypted_with_the_shared_backend_key(self) -> None:
        config = get_oauth_config()
        assert config is not None
        token_cache = '{"AccessToken":"tenant-specific-token"}'

        encrypted = encrypt_cache(config, token_cache)

        self.assertNotIn("tenant-specific-token", encrypted)
        self.assertEqual(decrypt_cache(config, encrypted), token_cache)

    def test_api_token_acquisition_uses_the_session_tenant_authority(self) -> None:
        config = get_oauth_config()
        assert config is not None
        record = AzureAuthSession(
            id="session",
            tenant_id=TENANT_ID,
            home_account_id="account",
            encrypted_token_cache=encrypt_cache(config, "{}"),
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        client = Mock()
        client.get_accounts.return_value = [{"home_account_id": "account"}]
        client.acquire_token_silent.return_value = {"access_token": "access-token"}

        with patch("app.services.azure_auth.create_msal_app", return_value=client) as create_app:
            access_token, auth_session, _ = get_arm_access_token_for_record(record, Mock())

        self.assertEqual(access_token, "access-token")
        self.assertIs(auth_session, record)
        tenant_config = create_app.call_args.args[0]
        self.assertEqual(tenant_config.authority, f"https://login.microsoftonline.com/{TENANT_ID}")

    def test_two_tenant_sessions_use_distinct_encrypted_caches_and_accounts(self) -> None:
        config = get_oauth_config()
        assert config is not None
        tenant_b = "b1111111-2222-3333-4444-555555555555"
        records = [
            AzureAuthSession(
                id=f"session-{index}",
                tenant_id=tenant_id,
                home_account_id=account_id,
                encrypted_token_cache=encrypt_cache(config, cache_value),
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
            for index, (tenant_id, account_id, cache_value) in enumerate(
                [
                    (TENANT_ID, "account-a", '{"cache":"a"}'),
                    (tenant_b, "account-b", '{"cache":"b"}'),
                ]
            )
        ]

        class FakeCache:
            has_state_changed = False

            def __init__(self) -> None:
                self.serialized: str | None = None

            def deserialize(self, value: str) -> None:
                self.serialized = value

        caches = [FakeCache(), FakeCache()]
        clients = []
        expected = [
            (TENANT_ID, "account-a", "tenant-a-access-token"),
            (tenant_b, "account-b", "tenant-b-access-token"),
        ]
        for _, account_id, token in expected:
            client = Mock()
            client.get_accounts.return_value = [{"home_account_id": account_id}]
            client.acquire_token_silent.return_value = {"access_token": token}
            clients.append(client)

        with (
            patch("app.services.azure_auth.msal.SerializableTokenCache", side_effect=caches),
            patch("app.services.azure_auth.create_msal_app", side_effect=clients) as create_app,
        ):
            results = [
                get_arm_access_token_for_record(record, Mock())[0]
                for record in records
            ]

        self.assertEqual(results, ["tenant-a-access-token", "tenant-b-access-token"])
        self.assertEqual([cache.serialized for cache in caches], ['{"cache":"a"}', '{"cache":"b"}'])
        self.assertIsNot(create_app.call_args_list[0].args[1], create_app.call_args_list[1].args[1])
        self.assertEqual(
            [call.args[0].authority for call in create_app.call_args_list],
            [
                f"https://login.microsoftonline.com/{TENANT_ID}",
                f"https://login.microsoftonline.com/{tenant_b}",
            ],
        )
