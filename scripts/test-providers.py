#!/usr/bin/env python3
"""
Self-test for radar_provider.py SDK and the 4 built-in generic providers:
github.py, gitlab.py, linear.py, slack.py.

Verifies:
1. All 4 providers respond to JSON-RPC 2.0 `provider/initialize` with a valid ProviderManifest
   (protocolVersion="1.0", capabilities.health=True, capabilities.wait=True, configSchema,
   linkMatchers / entityTemplates).
2. `linear.py` dynamically builds `issue:` entityTemplates with `orgSlug` and `teamPrefixes`.
3. Disabled providers (`enabled: False`) return an empty `provider/sync` result cleanly.
4. CLI fallback (`{}` on stdin or `--cli-manifest`) works without error.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

COLLECTORS_DIR = pathlib.Path(__file__).resolve().parent / "collectors"
PROVIDERS = ["github", "gitlab", "linear", "slack"]


def run_rpc_session(script_path: pathlib.Path, requests: list[dict]) -> list[dict]:
    payload = "\n".join(json.dumps(r, ensure_ascii=False) for r in requests) + "\n"
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, f"{script_path.name} exited with {proc.returncode}: {proc.stderr}"
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == len(requests), (
        f"Expected {len(requests)} NDJSON responses from {script_path.name}, got {len(lines)}: {proc.stdout}"
    )
    return [json.loads(line) for line in lines]


def test_providers_handshake_and_disabled_sync() -> None:
    for pid in PROVIDERS:
        script = COLLECTORS_DIR / f"{pid}.py"
        assert script.exists(), f"Missing provider script: {script}"

        init_params = {
            "protocolVersion": "1.0",
            "config": {"enabled": False, "orgSlug": "acme", "teamPrefixes": ["ENG", "OPS"]},
            "globalConfig": {"defaultRepoPath": "/tmp", "issueTeamPrefixes": ["ENG"]},
        }
        responses = run_rpc_session(
            script,
            [
                {"jsonrpc": "2.0", "id": 1, "method": "provider/initialize", "params": init_params},
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "provider/sync",
                    "params": {
                        "now": "2026-11-21T00:00:00Z",
                        "timezone": "UTC",
                        "knownHashes": {},
                        "rules": {"mutedKeywords": [], "mutedChannels": [], "mutedItemIds": []},
                    },
                },
            ],
        )

        init_resp, sync_resp = responses
        assert init_resp.get("jsonrpc") == "2.0" and init_resp.get("id") == 1
        manifest = init_resp.get("result")
        assert isinstance(manifest, dict), f"Invalid manifest from {pid}: {init_resp}"
        assert manifest.get("protocolVersion") == "1.0"
        assert manifest.get("id") == pid
        assert isinstance(manifest.get("displayName"), str) and manifest["displayName"]
        caps = manifest.get("capabilities") or {}
        assert caps.get("health") is True, f"{pid} must declare capabilities.health=True"
        assert caps.get("wait") is True, f"{pid} must declare capabilities.wait=True"
        assert isinstance(manifest.get("configSchema"), dict) and manifest["configSchema"]
        assert isinstance(manifest.get("linkMatchers"), list) and len(manifest["linkMatchers"]) >= 1

        if pid == "linear":
            templates = manifest.get("entityTemplates") or []
            assert len(templates) == 1
            tpl = templates[0]
            assert tpl.get("entityPrefix") == "issue"
            assert tpl.get("urlTemplate") == "https://linear.app/acme/issue/$1_upper"
            assert "ENG|OPS" in (tpl.get("tokenRegex") or "")

        assert sync_resp.get("jsonrpc") == "2.0" and sync_resp.get("id") == 2
        sync_res = sync_resp.get("result")
        assert isinstance(sync_res, dict)
        assert sync_res.get("items") == []
        assert sync_res.get("entitySignals") == []
        print(f"[PASS] {pid}.py initialize & disabled sync verified (displayName={manifest['displayName']})")


def test_cli_fallback() -> None:
    for pid in PROVIDERS:
        script = COLLECTORS_DIR / f"{pid}.py"
        proc = subprocess.run(
            [sys.executable, str(script), "--cli-manifest"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert proc.returncode == 0
        manifest = json.loads(proc.stdout)
        assert manifest["id"] == pid
    print("[PASS] CLI --cli-manifest fallback verified for all 4 providers")


if __name__ == "__main__":
    test_providers_handshake_and_disabled_sync()
    test_cli_fallback()
    print("ALL PROVIDER SELF-TESTS PASSED.")
