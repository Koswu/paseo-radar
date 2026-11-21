#!/usr/bin/env python3
"""
Paseo Radar Provider JSON-RPC 2.0 SDK (Python >=3.11, zero external dependencies).

Provides a declarative wrapper for building read-only Radar Providers that communicate
over stdio using NDJSON JSON-RPC 2.0 (`provider/initialize`, `provider/sync`,
`provider/checkHealth`, `provider/checkWait`, and `notifications/changed`),
with a built-in CLI fallback when invoked interactively or with `{}` on stdin.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import time
from typing import Any, Callable, Iterable

PROTOCOL_VERSION = "1.0"

ISSUE_KEY_RE = re.compile(r"\b([A-Z]{2,8})-(\d{1,6})\b")
BRANCH_ISSUE_RE = re.compile(r"(?:^|[/_-])([a-z]{2,8})-(\d{1,6})\b", re.I)
NON_ISSUE_PREFIXES = {
    "UTF", "SHA", "MD", "RSA", "AES", "GCM", "GPT", "GLM", "UTC", "GMT", "ISO",
    "CVE", "RFC", "HTTP", "HTTPS", "SSL", "TLS", "SSH", "TCP", "UDP", "DNS",
    "CPU", "GPU", "RAM", "PID", "UID", "API", "SQL", "CLI", "SDK", "RPC", "URL",
    "URI", "DOM", "CSS", "SVG", "PDF", "PNG", "JPG", "SLB", "ECS", "RDS", "SLS",
    "PR", "MR", "ID",
}


def utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def stable_hash(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def dedupe_strs(seq: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(x for x in seq if x))


def expand_repo_cwd(
    url: str,
    repo_map: dict[str, str] | None,
    default_repo: str | None = None,
) -> str | None:
    if repo_map:
        for pattern, local_path in repo_map.items():
            if not pattern or not local_path:
                continue
            expanded = pathlib.Path(local_path).expanduser()
            if pattern in url and expanded.exists():
                return str(expanded)
    if default_repo:
        expanded_default = pathlib.Path(default_repo).expanduser()
        if expanded_default.exists():
            return str(expanded_default)
    return None


def extract_issue_keys(
    text: str,
    allowed_prefixes: set[str] | None = None,
    include_branch_tokens: str = "",
) -> list[str]:
    out: list[str] = []
    if text:
        for prefix, num in ISSUE_KEY_RE.findall(text):
            if prefix in NON_ISSUE_PREFIXES:
                continue
            if allowed_prefixes and prefix not in allowed_prefixes:
                continue
            out.append(f"{prefix}-{num}")
    if include_branch_tokens:
        for m in BRANCH_ISSUE_RE.finditer(include_branch_tokens):
            prefix = m.group(1).upper()
            num = m.group(2)
            if prefix in NON_ISSUE_PREFIXES:
                continue
            if allowed_prefixes and prefix not in allowed_prefixes:
                continue
            out.append(f"{prefix}-{num}")
    return dedupe_strs(out)


def load_env_config_bundle() -> dict[str, Any]:
    for env_key in ("RADAR_PROVIDERS_CONFIG", "RADAR_COLLECTORS_CONFIG"):
        cfg_path = os.environ.get(env_key, "").strip()
        if cfg_path and pathlib.Path(cfg_path).exists():
            try:
                data = json.loads(pathlib.Path(cfg_path).read_text("utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
    return {}


class RadarProvider:
    def __init__(
        self,
        provider_id: str,
        display_name: str,
        description: str | None = None,
        icon: str | None = None,
        config_schema: dict[str, Any] | None = None,
        link_matchers: list[dict[str, Any]] | None = None,
        entity_templates: list[dict[str, Any]] | None = None,
        resource_labels: dict[str, str] | None = None,
        push_capable: bool = False,
    ) -> None:
        self.provider_id = provider_id
        self.display_name = display_name
        self.description = description
        self.icon = icon or provider_id
        self.config_schema = config_schema or {}
        self.link_matchers = list(link_matchers or [])
        self.entity_templates = list(entity_templates or [])
        self.resource_labels = dict(resource_labels or {})
        self.push_capable = push_capable

        self.config: dict[str, Any] = {}
        self.global_config: dict[str, Any] = {}
        self._manifest_builder: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] | None = None
        self._sync_handler: Callable[[dict[str, Any]], dict[str, Any]] | None = None
        self._health_handler: Callable[[dict[str, Any]], dict[str, Any]] | None = None
        self._wait_handler: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] | None = None

    def manifest(
        self, fn: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
    ) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
        """Optional decorator to dynamically customize linkMatchers/entityTemplates on initialize."""
        self._manifest_builder = fn
        return fn

    def sync(self, fn: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[dict[str, Any]], dict[str, Any]]:
        self._sync_handler = fn
        return fn

    def health(self, fn: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[dict[str, Any]], dict[str, Any]]:
        self._health_handler = fn
        return fn

    def wait(
        self, fn: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
    ) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
        self._wait_handler = fn
        return fn

    def _hydrate_config_from_env(self) -> None:
        raw = load_env_config_bundle()
        if not raw:
            return
        if not self.global_config:
            self.global_config = {
                "defaultRepoPath": raw.get("defaultRepoPath") or "",
                "issueTeamPrefixes": raw.get("issueTeamPrefixes") or [],
            }
        if not self.config:
            providers_map = raw.get("providers")
            if isinstance(providers_map, dict) and isinstance(providers_map.get(self.provider_id), dict):
                entry = providers_map[self.provider_id]
                inner_cfg = entry.get("config") if isinstance(entry.get("config"), dict) else entry
                self.config = dict(inner_cfg)
                if "enabled" in entry and "enabled" not in self.config:
                    self.config["enabled"] = entry["enabled"]
            elif isinstance(raw.get(self.provider_id), dict):
                self.config = dict(raw[self.provider_id])

    def build_manifest(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "id": self.provider_id,
            "displayName": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "capabilities": {
                "health": self._health_handler is not None,
                "wait": self._wait_handler is not None,
                "push": bool(self.push_capable),
            },
            "configSchema": self.config_schema,
            "linkMatchers": list(self.link_matchers),
            "entityTemplates": list(self.entity_templates),
            "resourceLabels": dict(self.resource_labels),
        }
        if self._manifest_builder is not None:
            overrides = self._manifest_builder(self.config, self.global_config) or {}
            for k in ("linkMatchers", "entityTemplates", "resourceLabels", "configSchema", "description", "displayName"):
                if k in overrides and overrides[k] is not None:
                    base[k] = overrides[k]
        return base

    def notify_changed(
        self,
        upserts: list[dict[str, Any]] | None = None,
        removed_ids: list[str] | None = None,
        entity_signals: list[dict[str, Any]] | None = None,
    ) -> None:
        msg = {
            "jsonrpc": "2.0",
            "method": "notifications/changed",
            "params": {
                "upserts": upserts or [],
                "removedIds": removed_ids or [],
                "entitySignals": entity_signals or [],
            },
        }
        sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def _normalize_sync_params(self, raw_params: dict[str, Any] | None) -> dict[str, Any]:
        p = dict(raw_params or {})
        self._hydrate_config_from_env()
        global_cfg = dict(self.global_config)
        if isinstance(p.get("globalConfig"), dict):
            for k, v in p["globalConfig"].items():
                if v is not None and v != "" and v != []:
                    global_cfg[k] = v
        self.global_config = global_cfg
        rules = p.get("rules") if isinstance(p.get("rules"), dict) else {}
        return {
            "now": str(p.get("now") or utc_now().isoformat()),
            "timezone": str(p.get("timezone") or "UTC"),
            "cursor": p.get("cursor"),
            "knownHashes": p.get("knownHashes") if isinstance(p.get("knownHashes"), dict) else {},
            "globalConfig": global_cfg,
            "config": dict(self.config),
            "rules": {
                "mutedKeywords": list(rules.get("mutedKeywords") or []),
                "mutedChannels": list(rules.get("mutedChannels") or []),
                "mutedItemIds": list(rules.get("mutedItemIds") or []),
            },
        }

    def _normalize_sync_result(self, raw_res: dict[str, Any] | None) -> dict[str, Any]:
        res = dict(raw_res or {})
        return {
            "isFullSnapshot": bool(res.get("isFullSnapshot", True)),
            "nextCursor": res.get("nextCursor"),
            "items": list(res.get("items") or []),
            "removedIds": list(res.get("removedIds") or []),
            "entitySignals": list(res.get("entitySignals") or []),
            "warnings": [str(w) for w in (res.get("warnings") or []) if w],
        }

    def _handle_rpc_request(self, req: dict[str, Any]) -> dict[str, Any] | None:
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") if isinstance(req.get("params"), dict) else {}

        try:
            if method == "provider/initialize":
                if isinstance(params.get("config"), dict) and params["config"]:
                    self.config = dict(params["config"])
                if isinstance(params.get("globalConfig"), dict) and params["globalConfig"]:
                    self.global_config = dict(params["globalConfig"])
                self._hydrate_config_from_env()
                result = self.build_manifest()
            elif method == "provider/sync":
                if self._sync_handler is None:
                    raise RuntimeError(f"Provider {self.provider_id} does not implement sync")
                norm_params = self._normalize_sync_params(params)
                if self.config.get("enabled") is False:
                    result = self._normalize_sync_result({})
                else:
                    result = self._normalize_sync_result(self._sync_handler(norm_params))
            elif method == "provider/checkHealth":
                if self._health_handler is None:
                    result = {"ok": True, "identity": None, "message": "Health check not implemented", "latencyMs": 0}
                else:
                    self._hydrate_config_from_env()
                    t0 = time.monotonic()
                    try:
                        hres = self._health_handler({"config": dict(self.config), "globalConfig": dict(self.global_config)}) or {}
                        elapsed = int((time.monotonic() - t0) * 1000)
                        result = {
                            "ok": bool(hres.get("ok", True)),
                            "identity": hres.get("identity"),
                            "message": hres.get("message"),
                            "latencyMs": int(hres.get("latencyMs", elapsed)),
                        }
                    except Exception as hexc:
                        elapsed = int((time.monotonic() - t0) * 1000)
                        result = {
                            "ok": False,
                            "identity": None,
                            "message": str(hexc),
                            "latencyMs": elapsed,
                        }
            elif method == "provider/checkWait":
                if self._wait_handler is None:
                    result = {"status": "failed", "note": f"Provider {self.provider_id} does not support wait checks"}
                else:
                    self._hydrate_config_from_env()
                    predicate = params.get("predicate") if isinstance(params.get("predicate"), dict) else {}
                    wres = self._wait_handler(
                        predicate,
                        {"config": dict(self.config), "globalConfig": dict(self.global_config)},
                    ) or {}
                    status = str(wres.get("status") or "pending")
                    if status not in ("ready", "pending", "failed"):
                        status = "pending"
                    result = {"status": status, "note": str(wres.get("note") or "")}
            else:
                if req_id is None:
                    return None
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }

            if req_id is None:
                return None
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as exc:
            if req_id is None:
                return None
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(exc)},
            }

    def run_cli_sync(self, legacy_input: dict[str, Any] | None = None) -> int:
        self._hydrate_config_from_env()
        if self._sync_handler is None:
            sys.stdout.write(json.dumps(self._normalize_sync_result({}), ensure_ascii=False, indent=2) + "\n")
            return 0
        norm_params = self._normalize_sync_params(legacy_input)
        if self.config.get("enabled") is False:
            res = self._normalize_sync_result({})
        else:
            res = self._normalize_sync_result(self._sync_handler(norm_params))
        sys.stdout.write(json.dumps(res, ensure_ascii=False, indent=2) + "\n")
        sys.stdout.flush()
        return 0

    def run(self, argv: list[str] | None = None) -> int:
        args = argv if argv is not None else sys.argv[1:]
        if "--cli-sync" in args:
            return self.run_cli_sync({})
        if "--cli-manifest" in args:
            self._hydrate_config_from_env()
            sys.stdout.write(json.dumps(self.build_manifest(), ensure_ascii=False, indent=2) + "\n")
            return 0
        if "--cli-health" in args:
            resp = self._handle_rpc_request({"jsonrpc": "2.0", "id": 1, "method": "provider/checkHealth", "params": {}})
            sys.stdout.write(json.dumps((resp or {}).get("result"), ensure_ascii=False, indent=2) + "\n")
            return 0

        if sys.stdin.isatty():
            return self.run_cli_sync({})

        first_line = ""
        for line in sys.stdin:
            if line.strip():
                first_line = line.strip()
                break

        if not first_line:
            return self.run_cli_sync({})

        try:
            first_obj = json.loads(first_line)
        except Exception as exc:
            err_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {exc}"},
            }
            sys.stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            return 1

        if not isinstance(first_obj, dict) or first_obj.get("jsonrpc") != "2.0":
            # Legacy stdin JSON or `{}` CLI fallback
            return self.run_cli_sync(first_obj if isinstance(first_obj, dict) else {})

        # Standard NDJSON JSON-RPC 2.0 loop
        resp = self._handle_rpc_request(first_obj)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()

        for raw_line in sys.stdin:
            stripped = raw_line.strip()
            if not stripped:
                continue
            try:
                req = json.loads(stripped)
            except Exception as exc:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {exc}"},
                }
                sys.stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                continue
            if not isinstance(req, dict):
                continue
            resp = self._handle_rpc_request(req)
            if resp is not None:
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

        return 0
