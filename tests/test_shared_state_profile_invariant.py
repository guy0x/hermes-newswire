"""Shared-state invariance across profiles (profile-scoping bug).

Hermes agent/cron sessions export ``HERMES_HOME=<root>/profiles/<p>`` (profile-aware), but
the newswire DB and the fleet cron-root are SHARED fleet state living under the DEFAULT home
(``<root>/state/newswire/newswire.db`` and ``<root>/cron`` + ``<root>/profiles/*/cron``),
not per-profile stores. The plugin's fleet paths must therefore resolve through the shared
home resolver (``hermes_constants.get_default_hermes_root()`` / ``_shared_home``) so the
board keeps reading/writing the SAME store no matter which profile is active.

Contract under test: running the plugin with ``HERMES_HOME=<default home>`` and with
``HERMES_HOME=<default home>/profiles/<p>`` resolves the SAME newswire DB path and the SAME
cron-dir root — two homes A -> B -> A collapse to one shared path. This is an
invariant/relationship assertion, deliberately NOT a literal-path frozen change-detector.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from conftest import load_plugin


@pytest.mark.parametrize("profile", [False, True])
def test_shared_state_is_profile_invariant(monkeypatch, tmp_path, profile):
    default_home = tmp_path / "shared"          # the DEFAULT/shared Hermes home
    default_home.mkdir()
    profile_root = default_home / "profiles" / "darren-athens"
    profile_root.mkdir(parents=True)

    # A) resolve with HERMES_HOME = default home; B) resolve with a profile-root home.
    mod_default = load_plugin(monkeypatch, default_home)
    hermes_home = profile_root if profile else default_home
    mod_profile = load_plugin(monkeypatch, hermes_home)

    # A -> B -> A: the newswire DB collapses to ONE shared path.
    assert mod_default._db_path() == mod_profile._db_path()
    # The shared store must not be profile-local.
    assert str(profile_root) not in str(mod_profile._db_path())
    # And it must sit under <shared>/state/newswire/newswire.db.
    assert mod_profile._db_path().parent.name == "newswire"
    assert mod_profile._db_path().parent.parent.name == "state"

    # The two homes enumerate the SAME cron-dir root (shared fleet cron), never an empty set.
    cron_default = mod_default._profile_cron_dirs()
    cron_profile = mod_profile._profile_cron_dirs()
    assert cron_default == cron_profile
    assert cron_profile, "active profile must never blank the shared cron surface"
    # One of the enumerated dirs is <shared>/cron (the shared root, not the profile root).
    shared_root = mod_profile._shared_home()
    assert Path(str(shared_root)) / "cron" in cron_profile
