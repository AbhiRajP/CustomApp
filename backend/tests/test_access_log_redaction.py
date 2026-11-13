from __future__ import annotations

import logging
import unittest

from app.main import AccessLogQueryFilter


class AccessLogRedactionTests(unittest.TestCase):
    def test_removes_query_parameters_from_access_log_path(self) -> None:
        record = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            "",
            0,
            '%s - "%s %s HTTP/%s" %d',
            (
                "127.0.0.1:1234",
                "GET",
                "/api/auth/callback?code=private&state=private",
                "1.1",
                200,
            ),
            None,
        )

        AccessLogQueryFilter().filter(record)

        self.assertIn("/api/auth/callback", record.getMessage())
        self.assertNotIn("private", record.getMessage())
