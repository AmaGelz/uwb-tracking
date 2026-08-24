"""Unit tests for backend/backend/security.py password hashing.

No database needed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from security import password_hash, password_verify  # noqa: E402


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
