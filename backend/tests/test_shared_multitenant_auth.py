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

    def test_customer_specific_authority_is_rejected(self) -> None:
        os.environ["AZURE_AUTHORITY"] = f"https://login.microsoftonline.com/{TENANT_ID}"

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
