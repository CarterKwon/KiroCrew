"""``~/.ssh`` is withheld from agent subprocesses on a push-verdict-activated install.

An activated push-verdict installation judges the agent's own visible ``git push`` at the argv
floor, but an opaque subprocess (an interpreter shelling out to git from compiled code) presents
no publish source for the floor to judge. Outside the strict tier ``~/.ssh`` is otherwise
readable, so that subprocess authenticates over SSH and lands a commit the gate never saw.

The sandbox therefore hides ``~/.ssh`` from every agent-tier spawn once gating is activated --
keeping ``~/.ssh/known_hosts`` so legitimate host verification still works -- while the one
gateway-owned publish path stays exempt (``gateway_publish=True``) and keeps its SSH access. A
normal, non-activated install is unchanged: the agent keeps ``~/.ssh``.

Every negative assertion (the mask is NOT applied) is paired with a positive control taken the
same way, so a mask that silently stopped applying could not pass as "not activated".
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

import kiro_crew.sandbox as sandbox_mod
from kiro_crew.security import push_verdict

# ``_build_launcher_script`` builds the Linux namespace launcher and reads ``os.getuid``, which
# does not exist on Windows, so those cases run only on the POSIX lanes. The reduced-scope
# Windows lane skips them; the full POSIX suite exercises them.
_POSIX_ONLY = pytest.mark.skipif(
    sys.platform == "win32",
    reason="_build_launcher_script uses POSIX-only os.getuid",
)


@pytest.fixture(autouse=True)
def _no_host_ssh_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_build_launcher_script`` asks the host ``ssh -V`` for accept-new support.

    The SSH mask decision does not depend on that answer, and a real ``ssh`` spawn is a host
    dependency this module is not about, so the probe is pinned and no binary runs.
    """
    monkeypatch.setattr(sandbox_mod, "_ssh_supports_accept_new", lambda: True)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path))
    return tmp_path


def _write_activation(home: Path, payload: object) -> Path:
    leaf = home / push_verdict.ACTIVATION_LEAF
    leaf.parent.mkdir(parents=True, exist_ok=True)
    leaf.write_text(json.dumps(payload), encoding="utf-8")
    return leaf


def _hide_ssh_line(script: str) -> str:
    for line in script.splitlines():
        if line.startswith("HIDE_SSH = "):
            return line.strip()
    raise AssertionError("launcher script has no HIDE_SSH assignment")


def _env_prefixes(script: str) -> list[str]:
    """The scrubbed-env prefix list the launcher will apply, parsed from ``ENV_PREFIXES``.

    ``SSH_AUTH_SOCK``'s presence here is what withholds the forwarded agent socket from the
    child, so the socket-scrub assertions read this list rather than the ``~/.ssh`` dir hide.
    """
    for line in script.splitlines():
        if line.startswith("ENV_PREFIXES = "):
            return json.loads(line[len("ENV_PREFIXES = ") :])
    raise AssertionError("launcher script has no ENV_PREFIXES assignment")


# ── the activation reader the mask keys off, fail-closed like the argv floor ──


def test_helper_is_false_on_an_install_nobody_activated(home: Path) -> None:
    """No keystone leaf means nobody activated gating: the key stays readable."""
    assert sandbox_mod._push_verdict_masks_ssh() is False


def test_helper_is_true_when_the_keystone_says_activated(home: Path) -> None:
    _write_activation(home, {"enabled": True})
    assert sandbox_mod._push_verdict_masks_ssh() is True


def test_helper_is_false_on_an_explicit_operator_disable(home: Path) -> None:
    """A real JSON ``false`` is an operator's disable, so the key stays readable."""
    _write_activation(home, {"enabled": False})
    assert sandbox_mod._push_verdict_masks_ssh() is False


def test_helper_fails_closed_on_an_unreadable_leaf(home: Path) -> None:
    """A leaf that cannot be parsed is unknown activation, not "off": mask the key."""
    leaf = home / push_verdict.ACTIVATION_LEAF
    leaf.parent.mkdir(parents=True, exist_ok=True)
    leaf.write_text("{not json", encoding="utf-8")
    assert sandbox_mod._push_verdict_masks_ssh() is True


def test_helper_fails_closed_on_a_corrupt_enabled_value(home: Path) -> None:
    """``{"enabled": 1}`` is a corrupted enable; the reader raises and the mask goes on."""
    _write_activation(home, {"enabled": 1})
    assert sandbox_mod._push_verdict_masks_ssh() is True


def test_helper_fails_closed_when_the_reader_raises_unexpectedly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Any unexpected read error masks the key rather than leaving it readable."""

    def _boom() -> bool:
        raise RuntimeError("reader blew up")

    monkeypatch.setattr(push_verdict, "activation_enabled", _boom)
    assert sandbox_mod._push_verdict_masks_ssh() is True


# ── the Linux launcher: HIDE_SSH tracks the mask decision ──


@_POSIX_ONLY
@pytest.mark.parametrize("level", ["standard", "cc"])
def test_launcher_keeps_ssh_on_a_non_activated_install(
    monkeypatch: pytest.MonkeyPatch, level: str
) -> None:
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    script = sandbox_mod._build_launcher_script(level)
    assert _hide_ssh_line(script) == "HIDE_SSH = False"


@_POSIX_ONLY
@pytest.mark.parametrize("level", ["standard", "cc"])
def test_launcher_hides_ssh_on_an_activated_install(
    monkeypatch: pytest.MonkeyPatch, level: str
) -> None:
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    script = sandbox_mod._build_launcher_script(level)
    assert _hide_ssh_line(script) == "HIDE_SSH = True"


@_POSIX_ONLY
def test_launcher_strict_hides_ssh_even_when_not_activated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    script = sandbox_mod._build_launcher_script("strict")
    assert _hide_ssh_line(script) == "HIDE_SSH = True"


@_POSIX_ONLY
def test_launcher_gateway_publish_keeps_ssh_on_an_activated_install(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one gateway-owned publish keeps SSH even while every agent spawn loses it."""
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    agent = sandbox_mod._build_launcher_script("standard")
    gateway = sandbox_mod._build_launcher_script("standard", gateway_publish=True)
    assert _hide_ssh_line(agent) == "HIDE_SSH = True"
    assert _hide_ssh_line(gateway) == "HIDE_SSH = False"


@_POSIX_ONLY
def test_launcher_activated_mask_keeps_known_hosts_readable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mask hides keys but the launcher still copies ``known_hosts`` back in."""
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    script = sandbox_mod._build_launcher_script("standard")
    # The known_hosts carve is gated on HIDE_SSH, so its presence with HIDE_SSH True proves
    # host verification survives the activation mask.
    assert _hide_ssh_line(script) == "HIDE_SSH = True"
    assert 'os.path.join(SSH_DIR, "known_hosts")' in script


# ── the macOS seatbelt profile: same gating, same known_hosts carve ──


def _ssh_denied(profile: str, home: Path) -> bool:
    return f'(deny file-write* (subpath "{home / ".ssh"}"))' in profile


def test_seatbelt_keeps_ssh_on_a_non_activated_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sandbox_mod, "config_dir", lambda: tmp_path)
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    profile = sandbox_mod._build_seatbelt_profile("standard")
    assert not _ssh_denied(profile, tmp_path)


def test_seatbelt_hides_ssh_on_an_activated_install_keeping_known_hosts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sandbox_mod, "config_dir", lambda: tmp_path)
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    profile = sandbox_mod._build_seatbelt_profile("standard")
    assert _ssh_denied(profile, tmp_path)
    # The read deny carves out known_hosts, so host verification still works.
    ssh_kh = tmp_path / ".ssh" / "known_hosts"
    assert f'(require-not (literal "{ssh_kh}"))' in profile


def test_seatbelt_gateway_publish_keeps_ssh_on_an_activated_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sandbox_mod, "config_dir", lambda: tmp_path)
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    agent = sandbox_mod._build_seatbelt_profile("standard")
    gateway = sandbox_mod._build_seatbelt_profile("standard", gateway_publish=True)
    assert _ssh_denied(agent, tmp_path)
    assert not _ssh_denied(gateway, tmp_path)


def test_seatbelt_strict_hides_ssh_even_when_not_activated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sandbox_mod, "config_dir", lambda: tmp_path)
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    profile = sandbox_mod._build_seatbelt_profile("strict")
    assert _ssh_denied(profile, tmp_path)


# ── the gateway publish path marks itself exempt ──


def test_gateway_publish_path_passes_gateway_publish_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gateway's ``_prepare_sandboxed_spawn`` routes git with ``gateway_publish=True``.

    The gateway publish is the single operation trusted to publish on an activated install, so
    it must keep SSH; this pins that its spawn prep marks itself exempt from the agent mask.
    """
    import asyncio

    from kiro_crew.dashboard.handlers import push_verdict as route

    captured: dict[str, object] = {}

    async def _fake_off_loop(fn):  # type: ignore[no-untyped-def]
        # ``fn`` is functools.partial(sandboxed_spawn_argv, argv, ...); read its bound kwargs
        # without running the real sandbox build.
        captured.update(fn.keywords)
        return (["wrapped"], {"env": "scrubbed"}, None)

    monkeypatch.setattr(route, "shielded_prepare_off_loop", _fake_off_loop)

    asyncio.run(route._prepare_sandboxed_spawn(["git", "status"], env={}, visible=("/wt",)))

    assert captured.get("gateway_publish") is True
    assert captured.get("mode") == "standard"


# ── the activation mask ALSO withholds the forwarded SSH agent socket ──
#
# ``forward_ssh_auth_sock=True`` re-admits ``SSH_AUTH_SOCK`` (``_agent_scrub_prefixes`` drops it
# from the default scrub set). The forwarded socket is an equivalent publish credential, so under
# the activation mask an agent subprocess must not keep it: the launcher's ``ENV_PREFIXES`` must
# scrub it back out. Every case here fixes ``forward_ssh_auth_sock=True`` so the socket would be
# KEPT but for the mask; a negative control with the same forwarding proves the scrub is the
# mask's doing, not the forward opt-in silently failing.


@_POSIX_ONLY
@pytest.mark.parametrize("level", ["standard", "cc"])
def test_launcher_activation_mask_scrubs_forwarded_socket(
    monkeypatch: pytest.MonkeyPatch, level: str
) -> None:
    """Activated + non-strict agent tier + forwarding on: the socket is withheld anyway."""
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    script = sandbox_mod._build_launcher_script(level, forward_ssh_auth_sock=True)
    assert "SSH_AUTH_SOCK" in _env_prefixes(script)


@_POSIX_ONLY
@pytest.mark.parametrize("level", ["standard", "cc"])
def test_launcher_non_activated_forwarding_keeps_socket(
    monkeypatch: pytest.MonkeyPatch, level: str
) -> None:
    """A NON-activated install with forwarding on keeps the socket usable (no regression)."""
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    script = sandbox_mod._build_launcher_script(level, forward_ssh_auth_sock=True)
    assert "SSH_AUTH_SOCK" not in _env_prefixes(script)


@_POSIX_ONLY
def test_launcher_gateway_publish_keeps_socket_on_activated_install(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gateway publish path keeps the socket to publish, even under the activation mask."""
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: True)
    script = sandbox_mod._build_launcher_script(
        "standard", forward_ssh_auth_sock=True, gateway_publish=True
    )
    assert "SSH_AUTH_SOCK" not in _env_prefixes(script)


@_POSIX_ONLY
def test_launcher_strict_socket_behavior_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """STRICT with forwarding on keeps the socket usable: the activation-mask scrub is not strict.

    The strict tier hides ``~/.ssh`` but leaves the forwarded socket usable (the 7973-7979
    contract). Only the ACTIVATION mask gains the socket scrub, so a strict, non-activated spawn
    with forwarding on must still keep ``SSH_AUTH_SOCK`` out of the scrub list.
    """
    monkeypatch.setattr(sandbox_mod, "_push_verdict_masks_ssh", lambda: False)
    script = sandbox_mod._build_launcher_script("strict", forward_ssh_auth_sock=True)
    assert "SSH_AUTH_SOCK" not in _env_prefixes(script)
