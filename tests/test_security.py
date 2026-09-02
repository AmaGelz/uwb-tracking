"""Unit tests for backend/backend/security.py password hashing.

No database needed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from security import (  # noqa: E402
    create_password_reset_token,
    password_hash,
    password_reset_token_hash,
    password_verify,
)


def test_correct_password_verifies():
    encoded = password_hash("hunter2")
    assert password_verify("hunter2", encoded)


def test_wrong_password_fails():
    encoded = password_hash("hunter2")
    assert not password_verify("wrong-password", encoded)


def test_same_password_hashes_differently_each_time():
    # Random salt per call — two hashes of the same password must differ,
    # but both must still verify.
    a = password_hash("1234")
    b = password_hash("1234")
    assert a != b
    assert password_verify("1234", a)
    assert password_verify("1234", b)


def test_garbage_encoded_value_does_not_verify_or_raise():
    assert not password_verify("1234", "not-a-real-hash")
    assert not password_verify("1234", "")
    assert not password_verify("1234", None)


def test_password_reset_token_stores_only_a_stable_digest():
    token, digest = create_password_reset_token()
    assert token != digest
    assert len(token) >= 32
    assert len(digest) == 64
    assert password_reset_token_hash(token) == digest
    assert password_reset_token_hash(token + "changed") != digest
