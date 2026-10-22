import os
import sys
import tempfile

import pytest
from pydantic import ValidationError

# Ensure the backend package is importable when pytest chooses the repository root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Configure before importing the app modules; engine and JWT settings are module-level.
_fd, _db_path = tempfile.mkstemp(prefix="sooshpanel-test-", suffix=".db")
os.close(_fd)
os.environ["DB_PATH"] = _db_path
os.environ["SECRET_KEY"] = "test-only-secret-key-that-is-long-enough"
os.environ["ADMIN_USERNAME"] = "test-admin"
os.environ["ADMIN_PASSWORD"] = "test-password-not-for-production"
os.environ["PUBLIC_DOMAIN"] = "example.test"

from app.models import PanelUser, init_db, engine
from app.routes import UserIn


@pytest.fixture(scope="module", autouse=True)
def database():
    init_db()
    yield
    engine.dispose()
    try:
        os.unlink(_db_path)
    except FileNotFoundError:
        pass


def test_user_input_defaults_and_bounds():
    user = UserIn(username="valid.user-1")
    assert user.traffic_limit_gb == 0
    assert user.device_limit == 2
    assert user.expiry_days == 0


@pytest.mark.parametrize("username", ["", "bad name", "../x", "a" * 65, "a;DROP"])
def test_rejects_invalid_usernames(username):
    with pytest.raises(ValidationError):
        UserIn(username=username)


@pytest.mark.parametrize("limit", [-1, 100001, float("inf"), float("nan")])
def test_rejects_invalid_traffic_limits(limit):
    with pytest.raises(ValidationError):
        UserIn(username="valid", traffic_limit_gb=limit)


@pytest.mark.parametrize("limit", [0, -1, 101])
def test_rejects_invalid_device_limits(limit):
    with pytest.raises(ValidationError):
        UserIn(username="valid", device_limit=limit)


@pytest.mark.parametrize("days", [-1, 3651])
def test_rejects_invalid_expiry_days(days):
    with pytest.raises(ValidationError):
        UserIn(username="valid", expiry_days=days)


def test_quota_is_unlimited_at_zero_and_enforced_at_limit():
    user = PanelUser(username="quota-test", traffic_limit_gb=0, used_uplink=10**12, used_downlink=0, active=True)
    assert user.quota_exceeded is False
    user.traffic_limit_gb = 1
    assert user.quota_exceeded is True
    assert user.is_online_allowed is False


def test_expired_user_is_not_allowed():
    from datetime import datetime, timedelta
    user = PanelUser(username="expired-test", expiry=datetime.utcnow() - timedelta(seconds=1), active=True)
    assert user.expired is True
    assert user.is_online_allowed is False


def test_invalid_inbound_and_path_are_rejected():
    with pytest.raises(ValidationError):
        UserIn(username="valid", inbound="unknown")
    with pytest.raises(ValidationError):
        UserIn(username="valid", path="/ws?x=<script>")
