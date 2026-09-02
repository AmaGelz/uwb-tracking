"""Unit tests for password-reset email delivery (no network required)."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from google.auth.transport import requests as google_transport_requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

import mailer  # noqa: E402


class FakeSMTP:
    calls: list[tuple] = []

    def __init__(self, *args, **kwargs):
        self.calls.append(("connect", args, kwargs))

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def starttls(self, **kwargs):
        self.calls.append(("starttls", kwargs))

    def login(self, username, password):
        self.calls.append(("login", username, password))

    def send_message(self, message):
        self.calls.append(("send", message["To"], message["Subject"]))


class FakeGoogleSession:
    calls: list[tuple] = []

    def __init__(self, credentials):
        self.calls.append(("connect", credentials))

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def post(self, url, json, timeout):
        self.calls.append(("post", url, json, timeout))
        return SimpleNamespace(status_code=200, text="")


class MailerTests(unittest.TestCase):
    def setUp(self):
        FakeSMTP.calls.clear()
        FakeGoogleSession.calls.clear()
        self.settings = SimpleNamespace(
            debug=False,
            activation_hours=24,
            password_reset_minutes=30,
            mail_provider="smtp",
            gmail_sender_email="",
            google_service_account_json="",
            google_service_account_file="",
            gmail_oauth_client_id="",
            gmail_oauth_client_secret="",
            gmail_oauth_refresh_token="",
            smtp_host="smtp.test",
            smtp_port=587,
            smtp_username="user",
            smtp_password="password",
            smtp_from_email="no-reply@test",
            smtp_starttls=True,
            smtp_use_ssl=False,
        )

    def test_sends_reset_email_over_starttls(self):
        with patch.object(mailer, "settings", self.settings), patch.object(mailer.smtplib, "SMTP", FakeSMTP):
            sent = mailer.send_password_reset_email(
                "person@test",
                "https://tracking.test/reset-password.html#token=secret",
            )

        self.assertTrue(sent)
        self.assertEqual(FakeSMTP.calls[0][0], "connect")
        self.assertEqual(FakeSMTP.calls[1][0], "starttls")
        self.assertEqual(FakeSMTP.calls[2], ("login", "user", "password"))
        self.assertEqual(FakeSMTP.calls[3][0:2], ("send", "person@test"))

    def test_sends_activation_email_through_gmail_api_oauth(self):
        self.settings.mail_provider = "gmail_api"
        self.settings.gmail_sender_email = "no-reply@test"
        self.settings.gmail_oauth_refresh_token = "refresh-token"
        with (
            patch.object(mailer, "settings", self.settings),
            patch.object(mailer, "_gmail_credentials", return_value=object()),
            patch.object(google_transport_requests, "AuthorizedSession", FakeGoogleSession),
        ):
            sent = mailer.send_activation_email(
                "person@test",
                "https://tracking.test/reset-password.html#token=secret",
            )

        self.assertTrue(sent)
        self.assertIn("/users/no-reply%40test/messages/send", FakeGoogleSession.calls[1][1])
        self.assertTrue(FakeGoogleSession.calls[1][2]["raw"])


if __name__ == "__main__":
    unittest.main()
