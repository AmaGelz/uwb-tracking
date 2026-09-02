from __future__ import annotations

import base64
from email.message import EmailMessage
from html import escape
import json
import logging
import smtplib
import ssl
from urllib.parse import quote

from config import settings


logger = logging.getLogger(__name__)
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


def _build_account_message(
    recipient: str,
    action_url: str,
    purpose: str,
    sender: str,
) -> EmailMessage:
    activation = purpose == "activation"
    action_th = "เปิดใช้งานบัญชีและตั้งรหัสผ่าน" if activation else "ตั้งรหัสผ่านใหม่"
    intro_th = (
        "ผู้ดูแลระบบได้สร้างบัญชี SUPALAI Tracking ให้คุณแล้ว"
        if activation
        else "มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชี SUPALAI Tracking ของคุณ"
    )
    expires = f"{settings.activation_hours} ชั่วโมง" if activation else f"{settings.password_reset_minutes} นาที"

    message = EmailMessage()
    message["Subject"] = f"{action_th} | SUPALAI Tracking"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        f"{intro_th}\n\nเปิดลิงก์นี้ภายใน {expires}:\n{action_url}\n\n"
        "หากคุณไม่ได้คาดว่าจะได้รับอีเมลนี้ โปรดติดต่อผู้ดูแลระบบ"
    )
    safe_action_url = escape(action_url, quote=True)
    message.add_alternative(
        f"""
        <html><body>
          <p>{intro_th}</p>
          <p><a href="{safe_action_url}">{action_th}</a></p>
          <p>ลิงก์นี้ใช้ได้ภายใน {expires} และใช้ได้เพียงครั้งเดียว</p>
          <p>หากคุณไม่ได้คาดว่าจะได้รับอีเมลนี้ โปรดติดต่อผู้ดูแลระบบ</p>
        </body></html>
        """,
        subtype="html",
    )
    return message


def _gmail_credentials():
    from google.oauth2 import credentials as user_credentials
    from google.oauth2 import service_account

    if settings.google_service_account_json:
        info = json.loads(settings.google_service_account_json)
        return service_account.Credentials.from_service_account_info(
            info,
            scopes=[GMAIL_SEND_SCOPE],
            subject=settings.gmail_sender_email,
        )
    if settings.google_service_account_file:
        return service_account.Credentials.from_service_account_file(
            settings.google_service_account_file,
            scopes=[GMAIL_SEND_SCOPE],
            subject=settings.gmail_sender_email,
        )
    if (
        settings.gmail_oauth_client_id
        and settings.gmail_oauth_client_secret
        and settings.gmail_oauth_refresh_token
    ):
        return user_credentials.Credentials(
            token=None,
            refresh_token=settings.gmail_oauth_refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=settings.gmail_oauth_client_id,
            client_secret=settings.gmail_oauth_client_secret,
            scopes=[GMAIL_SEND_SCOPE],
        )
    return None


def _send_with_gmail_api(message: EmailMessage) -> bool:
    try:
        from google.auth.transport.requests import AuthorizedSession

        credentials = _gmail_credentials()
        if credentials is None:
            logger.error("Gmail API selected but OAuth credentials are not configured")
            return False
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
        user_id = quote(settings.gmail_sender_email, safe="")
        with AuthorizedSession(credentials) as session:
            response = session.post(
                f"https://gmail.googleapis.com/gmail/v1/users/{user_id}/messages/send",
                json={"raw": raw},
                timeout=15,
            )
        if response.status_code >= 400:
            logger.error("Gmail API send failed (%s): %s", response.status_code, response.text[:500])
            return False
        return True
    except Exception:
        logger.exception("Could not send account email through Gmail API")
        return False


def _send_with_smtp(message: EmailMessage) -> bool:
    if not settings.smtp_host or not settings.smtp_from_email:
        return False

    context = ssl.create_default_context()
    try:
        if settings.smtp_use_ssl:
            smtp = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15, context=context)
        else:
            smtp = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
        with smtp:
            if settings.smtp_starttls and not settings.smtp_use_ssl:
                smtp.starttls(context=context)
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)
        return True
    except (OSError, smtplib.SMTPException):
        logger.exception("Could not send account email to %s", message["To"])
        return False


def send_account_email(recipient: str, action_url: str, purpose: str = "reset") -> bool:
    """Send a one-time account link through Gmail API OAuth or SMTP."""
    gmail_configured = bool(
        settings.gmail_sender_email
        and (
            settings.google_service_account_json
            or settings.google_service_account_file
            or (
                settings.gmail_oauth_client_id
                and settings.gmail_oauth_client_secret
                and settings.gmail_oauth_refresh_token
            )
        )
    )
    provider = settings.mail_provider
    if provider == "gmail_api" or (provider == "auto" and gmail_configured):
        return _send_with_gmail_api(
            _build_account_message(recipient, action_url, purpose, settings.gmail_sender_email)
        )
    if provider == "smtp" or (provider == "auto" and settings.smtp_host):
        return _send_with_smtp(
            _build_account_message(recipient, action_url, purpose, settings.smtp_from_email)
        )

    if settings.debug:
        logger.warning("Account %s link for %s: %s", purpose, recipient, action_url)
    else:
        logger.error("Account email requested but Gmail API/SMTP is not configured")
    return False


def send_password_reset_email(recipient: str, reset_url: str) -> bool:
    return send_account_email(recipient, reset_url, "reset")


def send_activation_email(recipient: str, activation_url: str) -> bool:
    return send_account_email(recipient, activation_url, "activation")
