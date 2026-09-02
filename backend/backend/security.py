from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta
from typing import Any

from config import settings
from utils import utc_now


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256$120000${salt}${digest.hex()}"


def password_verify(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def create_password_reset_token() -> tuple[str, str]:
    """Return a public reset token and the SHA-256 digest stored in Postgres."""
    token = secrets.token_urlsafe(32)
    return token, password_reset_token_hash(token)


def password_reset_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "employee_id": user["employee_id"],
        "email": user["email"],
        "role": user["role"],
        "position": user["position"],
        "first_th": user["first_th"],
        "last_th": user["last_th"],
        "first_en": user["first_en"],
        "last_en": user["last_en"],
        "tag_id": user.get("tag_id"),
        "account_status": user.get("account_status", "active"),
        "google_linked": bool(user.get("google_sub")),
    }


def create_token(user_id: str) -> str:
    from db import db  # local import avoids a circular import with db.py at module load

    token = secrets.token_urlsafe(32)
    expires_at = utc_now() + timedelta(hours=settings.session_hours)
    db.execute(
        """
        INSERT INTO sessions (token, user_id, expires_at)
        VALUES (%s, %s, %s)
        ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at
        """,
        (token, user_id, expires_at),
    )
    return token
