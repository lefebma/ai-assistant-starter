#!/usr/bin/env python3
"""kz.py — thin CLI wrapper over the Kanban Zone Public API v1.3.

Generic, multi-board client. Pass --board ID on any command to target a
specific board, or set KZ_DEFAULT_BOARD_ID / config to make calls implicit.

Commands:
  list-boards                  List every board accessible to the API key.
  verify [--board ID]          Check API key + board access; cache board metadata.
  refresh-cache [--board ID]   Re-fetch board metadata (columns, labels) into cache.
  list-cards [--board ID]      List cards on the board; optional --column filter.
  find [--board ID] --title TEXT
                               Find card(s) matching title (substring, case-insensitive).
  create-card [--board ID] --stage NAME --title TEXT [--description TEXT] [--label NAME]
              [--owner EMAIL] [--due YYYY-MM-DD] [--priority low|normal|high|critical]
  bulk-create [--board ID] --from PATH
                               Create multiple cards from a CSV
                               (columns: title,description,stage,label,owner).
  move-card [--board ID] --id N --stage NAME
                               Move card to a target column by canonical column name.
  update-card [--board ID] --id N [--title ...] [--description ...] [--label ...]
              [--owner ...] [--due ...] [--priority ...] [--block REASON] [--unblock]
              [--custom-field "name=value"] (repeatable)
  comment [--board ID] --id N --text TEXT
                               Add a comment to a card's activity log.
  dump [--board ID] PATH       GET an arbitrary API path (debug).
  diagnose                     Try each known auth form and report which works.

Config (in order):
  1. CLI flag (--board)
  2. Env vars: KZ_API_KEY, KZ_DEFAULT_BOARD_ID (or legacy KZ_BOARD_ID)
  3. ~/.config/kanbanzone/config.json
       ({"api_key": "...", "default_board_id": "..."})

Never prints the API key. Never deletes cards.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def _encode_key(key: str) -> str:
    """Base64-encode the raw Kanban Zone API key.

    The Kanban Zone docs require the key to be base64-encoded before use as
    either an Authorization: Basic header or an api_token query param.
    If the caller has already encoded it (KZ_KEY_PREENCODED=1), return as-is.
    """
    if os.environ.get("KZ_KEY_PREENCODED") == "1":
        return key
    return base64.b64encode(key.encode("utf-8")).decode("ascii")


def _ssl_context() -> ssl.SSLContext:
    """Build an SSL context that prefers certifi's bundle when available.

    macOS Python installs often ship without root CAs configured, causing
    CERTIFICATE_VERIFY_FAILED. If certifi is installed, use it. Otherwise
    rely on the system default and surface a helpful error later if it fails.
    """
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL_CTX = _ssl_context()

API_BASE = "https://integrations.kanbanzone.io/v1"
CONFIG_DIR = Path.home() / ".config" / "kanbanzone"
CONFIG_FILE = CONFIG_DIR / "config.json"
CACHE_DIR = CONFIG_DIR / "boards"


# ---------- config ----------

def _load_config_file() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except json.JSONDecodeError:
            sys.exit(f"Config file {CONFIG_FILE} is not valid JSON.")
    return {}


def load_api_key() -> str:
    """Resolve the API key from env or config. Errors if missing."""
    key = os.environ.get("KZ_API_KEY")
    if key:
        return key
    data = _load_config_file()
    key = data.get("api_key")
    if not key:
        sys.exit(
            "Missing API key. Set KZ_API_KEY env var or add 'api_key' to "
            f"{CONFIG_FILE}. See references/setup.md."
        )
    return key


def resolve_board(board_override: str | None) -> str:
    """Resolve the board ID: CLI flag > env > config. Errors if missing."""
    if board_override:
        return board_override
    env = os.environ.get("KZ_DEFAULT_BOARD_ID") or os.environ.get("KZ_BOARD_ID")
    if env:
        return env
    data = _load_config_file()
    board = data.get("default_board_id") or data.get("board_id")
    if not board:
        sys.exit(
            "No board specified. Pass --board ID, set KZ_DEFAULT_BOARD_ID, or "
            f"add 'default_board_id' to {CONFIG_FILE}. Run `kz list-boards` to "
            "discover board IDs."
        )
    return board


def load_config(board_override: str | None = None) -> tuple[str, str]:
    """Convenience: return (api_key, board_id) using full precedence rules."""
    return load_api_key(), resolve_board(board_override)


# ---------- HTTP ----------

def _request(method: str, path: str, api_key: str, body: Any = None,
             query: dict | None = None) -> Any:
    # Per Kanban Zone docs: base64-encode the key, send as "Authorization: Basic {encoded}"
    # OR as "?api_token={encoded}". Default is the header form.
    style = os.environ.get("KZ_AUTH_STYLE", "basic").lower()
    encoded = _encode_key(api_key)
    url = API_BASE + path
    q = dict(query or {})
    headers = {"Accept": "application/json"}
    if style == "query":
        q["api_token"] = encoded
    elif style == "bearer":
        headers["Authorization"] = f"Bearer {encoded}"
    elif style == "raw":
        headers["Authorization"] = encoded  # legacy: raw encoded value, no scheme
    else:  # "basic" / default
        headers["Authorization"] = f"Basic {encoded}"
    if q:
        url += "?" + urllib.parse.urlencode(q)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            content_type = resp.headers.get("Content-Type", "")
            status = resp.status
            stripped = raw.strip()
            if not stripped:
                return {}
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                snippet = stripped[:500].replace("\n", " ")
                sys.exit(
                    f"Got HTTP {status} on {method} {path} but response was not JSON.\n"
                    f"  Content-Type: {content_type}\n"
                    f"  Final URL:    {resp.geturl()}\n"
                    f"  Body (first 500 chars): {snippet}\n"
                    f"\n"
                    f"Common causes:\n"
                    f"  - API key missing required encoding / wrong header form\n"
                    f"  - Endpoint redirected to a login or marketing page\n"
                    f"  - API access not enabled on your Kanban Zone plan"
                )
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        sys.exit(f"HTTP {e.code} on {method} {path}: {msg}")
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if "CERTIFICATE_VERIFY_FAILED" in reason:
            py_ver = f"{sys.version_info.major}.{sys.version_info.minor}"
            sys.exit(
                f"SSL certificate verification failed on {method} {path}.\n"
                f"This is typically a Python install missing its root CA bundle.\n"
                f"Fix (pick one):\n"
                f"  1. Run:  /Applications/Python\\ {py_ver}/Install\\ Certificates.command\n"
                f"  2. Install certifi:  pip install certifi\n"
                f"Then retry."
            )
        sys.exit(f"Network error on {method} {path}: {reason}")


def get(path, api_key, **query): return _request("GET", path, api_key, query=query or None)
def post(path, api_key, body): return _request("POST", path, api_key, body=body)
def put(path, api_key, body): return _request("PUT", path, api_key, body=body)


# ---------- board cache (per-board) ----------

def _cache_path(board_id: str) -> Path:
    return CACHE_DIR / f"{board_id}.json"


def load_cache(board_id: str) -> dict | None:
    path = _cache_path(board_id)
    if path.exists():
        return json.loads(path.read_text())
    return None


def _unwrap_board(resp: Any) -> dict:
    """The /board/{board} endpoint returns {count, boards: [{BoardItem: {...}}]}.
    Peel the envelope and return the inner BoardItem dict.
    """
    if isinstance(resp, dict) and "boards" in resp and isinstance(resp["boards"], list) and resp["boards"]:
        first = resp["boards"][0]
        if isinstance(first, dict):
            return first.get("BoardItem", first)
    if isinstance(resp, dict) and "BoardItem" in resp:
        return resp["BoardItem"]
    return resp if isinstance(resp, dict) else {}


def save_cache(board_resp: Any, board_id: str) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    inner = _unwrap_board(board_resp)
    raw_cols = inner.get("columns") or inner.get("Columns") or []
    columns = []
    for wrapper in raw_cols:
        # Each column is wrapped: {"ColumnItem": {...}}
        col = wrapper.get("ColumnItem", wrapper) if isinstance(wrapper, dict) else {}
        if not col:
            continue
        columns.append({
            "columnId": col.get("columnId") or col.get("id") or col.get("publicId"),
            "title": (col.get("title") or col.get("name") or "").strip(),
            "parentId": col.get("parent") or col.get("parentColumnId") or col.get("parentId"),
            "parentTitle": col.get("parentTitle"),
            "columnState": col.get("columnState"),
        })
    labels = []
    for l in (inner.get("labels") or inner.get("Labels") or []):
        n = l.get("name") if isinstance(l, dict) else None
        if n:
            labels.append(n)
    cache = {
        "board_id": board_id,
        "name": inner.get("name") or inner.get("Name"),
        "columns": columns,
        "labels": labels,
        "cached_at": int(time.time()),
    }
    path = _cache_path(board_id)
    path.write_text(json.dumps(cache, indent=2))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def ensure_cache(api_key: str, board_id: str) -> dict:
    cache = load_cache(board_id)
    if cache and cache.get("board_id") == board_id and cache.get("columns"):
        return cache
    board = get(f"/board/{board_id}", api_key, includeColumns="true", includeCustomFields="true")
    save_cache(board, board_id)
    return load_cache(board_id) or {}


def _col_label(c: dict) -> str:
    """Human-readable label for a column, including parent when present."""
    title = (c.get("title") or "").strip()
    parent = (c.get("parentTitle") or "").strip()
    return f"{parent} / {title}" if parent else title


def resolve_column(cache: dict, stage: str) -> str:
    """Return columnId for a given column name. Supports 'Title' or 'Parent / Title' forms.

    Duplicate titles (e.g., multiple 'Waiting' sub-rows under different parents)
    are disambiguated by accepting 'Parent / Title' as input.
    """
    stage_l = stage.strip().lower()
    cols = cache.get("columns", [])

    # 1. Exact match against "Parent / Title"
    for c in cols:
        if _col_label(c).lower() == stage_l:
            return c["columnId"]
    # 2. Exact match against just title
    title_matches = [c for c in cols if (c.get("title") or "").strip().lower() == stage_l]
    if len(title_matches) == 1:
        return title_matches[0]["columnId"]
    if len(title_matches) > 1:
        hints = ", ".join(_col_label(c) for c in title_matches)
        sys.exit(
            f"'{stage}' is ambiguous — multiple columns share that title: {hints}.\n"
            f"Use the 'Parent / Title' form (e.g., 'Proposal / Waiting')."
        )
    # 3. Substring match across "Parent / Title"
    matches = [c for c in cols if stage_l in _col_label(c).lower()]
    if len(matches) == 1:
        return matches[0]["columnId"]
    if not matches:
        available = ", ".join(sorted(_col_label(c) for c in cols))
        sys.exit(f"No column matching '{stage}'. Available: {available}")
    hints = ", ".join(_col_label(c) for c in matches)
    sys.exit(f"'{stage}' matches multiple columns: {hints}. Be more specific.")


# ---------- commands ----------

def cmd_diagnose(args):
    """Try each known auth form against GET /boards and report which works."""
    api_key = load_api_key()
    encoded = _encode_key(api_key)
    attempts = [
        ("Authorization: Basic {base64(key)}  [docs-default]",
         {"Authorization": f"Basic {encoded}"}, {}),
        ("?api_token={base64(key)}",
         {}, {"api_token": encoded}),
        ("Authorization: Bearer {base64(key)}",
         {"Authorization": f"Bearer {encoded}"}, {}),
        ("Authorization: {base64(key)}   (no scheme)",
         {"Authorization": encoded}, {}),
        ("Authorization: Basic {raw-key}  (sanity: expected to fail)",
         {"Authorization": f"Basic {api_key}"}, {}),
    ]
    print("Probing GET /boards with each auth form...\n")
    for label, headers, query in attempts:
        url = API_BASE + "/boards"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers={**headers, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
                raw = resp.read().decode("utf-8", errors="replace").strip()
                try:
                    parsed = json.loads(raw)
                    count = len(parsed) if isinstance(parsed, list) else "?"
                    print(f"  OK    {label}  (HTTP {resp.status}, {count} boards)")
                except json.JSONDecodeError:
                    print(f"  FAIL  {label}  (HTTP {resp.status}, body: {raw[:80]!r})")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:80]
            print(f"  FAIL  {label}  (HTTP {e.code}, body: {body!r})")
        except urllib.error.URLError as e:
            print(f"  FAIL  {label}  (network: {e.reason})")
    print("\nDefault auth style is 'basic' (Authorization: Basic {base64(key)}).")
    print("Override with KZ_AUTH_STYLE if your instance wants a different form:")
    print('  export KZ_AUTH_STYLE="basic"    # Authorization: Basic {encoded}   (default)')
    print('  export KZ_AUTH_STYLE="query"    # ?api_token={encoded}')
    print('  export KZ_AUTH_STYLE="bearer"   # Authorization: Bearer {encoded}')
    print('  export KZ_AUTH_STYLE="raw"      # Authorization: {encoded}  (no scheme)')
    print('If your key is already base64-encoded, set KZ_KEY_PREENCODED=1.')


def cmd_list_boards(args):
    api_key = load_api_key()
    resp = get("/boards", api_key)
    if isinstance(resp, list):
        raw = resp
    elif isinstance(resp, dict):
        raw = resp.get("boards") or resp.get("data") or []
    else:
        raw = []
    boards = []
    for w in raw:
        b = w.get("BoardItem", w) if isinstance(w, dict) else {}
        if not b:
            continue
        boards.append({
            "publicId": b.get("publicId") or b.get("id"),
            "name": b.get("name") or b.get("Name") or "",
            "isArchived": bool(b.get("isArchived")),
            "cardCount": b.get("cardCount") or b.get("totalCards"),
        })
    if args.json:
        print(json.dumps(boards, indent=2, default=str))
        return
    if not boards:
        print("No boards found for this API key.")
        return
    width = max(len(b["publicId"] or "") for b in boards)
    for b in boards:
        flag = " (archived)" if b["isArchived"] else ""
        count = f"  ({b['cardCount']} cards)" if b.get("cardCount") is not None else ""
        print(f"  {(b['publicId'] or '?').ljust(width)}  {b['name']}{count}{flag}")


def cmd_verify(args):
    api_key, board_id = load_config(args.board)
    get("/boards", api_key)  # auth check
    print("API reachable")
    board = get(f"/board/{board_id}", api_key, includeColumns="true", includeCustomFields="true")
    save_cache(board, board_id)
    cache = load_cache(board_id) or {}
    cols = cache.get("columns", [])
    parents = sorted({c.get("parentTitle") for c in cols if c.get("parentTitle")})
    print(f'Board "{cache.get("name")}" resolved')
    print(f"   Columns discovered: {len(cols)}")
    if parents:
        print(f"   Parent groups: {', '.join(parents)}")
    if cache.get("labels"):
        print(f"   Labels: {', '.join(cache['labels'])}")


def cmd_refresh_cache(args):
    api_key, board_id = load_config(args.board)
    board = get(f"/board/{board_id}", api_key, includeColumns="true", includeCustomFields="true")
    save_cache(board, board_id)
    print(f"Cache refreshed at {_cache_path(board_id)}")


def _unwrap_card(item: Any) -> dict:
    """Kanban Zone wraps cards as {"CardItem": {...}}. Peel the envelope."""
    if isinstance(item, dict):
        if "CardItem" in item and isinstance(item["CardItem"], dict):
            return item["CardItem"]
        return item
    return {}


def _all_cards(api_key: str, board_id: str) -> list[dict]:
    out, page = [], 1
    while True:
        resp = get("/cards", api_key, board=board_id, page=page, count=100)
        if isinstance(resp, list):
            batch_raw = resp
        elif isinstance(resp, dict):
            batch_raw = resp.get("cards") or resp.get("data") or []
        else:
            batch_raw = []
        batch = [_unwrap_card(x) for x in batch_raw]
        batch = [b for b in batch if b]
        if not batch:
            break
        out.extend(batch)
        if len(batch_raw) < 100:
            break
        page += 1
    return out


def _days_since(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        from datetime import datetime, timezone
        s = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).days
    except Exception:
        return None


def cmd_list_cards(args):
    api_key, board_id = load_config(args.board)
    cache = ensure_cache(api_key, board_id)
    cards = _all_cards(api_key, board_id)
    if args.debug and cards:
        print(f"[debug] First card keys: {sorted(cards[0].keys())}", file=sys.stderr)
        print(f"[debug] First card sample: {json.dumps(cards[0], default=str)[:400]}", file=sys.stderr)
    col_names = {c["columnId"]: _col_label(c) for c in cache.get("columns", []) if c.get("columnId")}
    rows = []
    for c in cards:
        col_id = c.get("columnId") or c.get("ColumnId")
        col_name = c.get("columnTitle") or c.get("columnName") or col_names.get(col_id, "?")
        if args.column and args.column.lower() not in col_name.lower():
            continue
        label = c.get("label")
        if isinstance(label, dict):
            label = label.get("name") or label.get("title")
        owner = c.get("owner")
        if isinstance(owner, dict):
            owner = owner.get("email") or owner.get("name")
        rows.append({
            "id": c.get("number") or c.get("id") or c.get("cardNumber"),
            "title": c.get("title"),
            "column": col_name,
            "label": label,
            "owner": owner,
            "daysSinceActivity": _days_since(c.get("lastActionAt")),
            "dueAt": c.get("dueAt"),
        })
    if args.json:
        print(json.dumps(rows, indent=2, default=str))
        return
    grouped: dict[str, list[dict]] = {}
    for r in rows:
        grouped.setdefault(r["column"], []).append(r)
    for col in sorted(grouped):
        print(f"\n=== {col} ({len(grouped[col])}) ===")
        for r in grouped[col]:
            label = f" [{r['label']}]" if r.get("label") else ""
            age = r.get("daysSinceActivity")
            age_str = f"  ({age}d idle)" if age is not None else ""
            due = f"  due {r['dueAt'][:10]}" if r.get("dueAt") else ""
            print(f"  #{r['id']}  {r['title']}{label}{age_str}{due}")


def cmd_find(args):
    api_key, board_id = load_config(args.board)
    cards = _all_cards(api_key, board_id)
    q = args.title.lower()
    hits = [c for c in cards if q in (c.get("title") or "").lower()]
    if not hits:
        print(f"No cards matching '{args.title}'")
        return
    for c in hits:
        print(f"#{c.get('number') or c.get('id')}  {c.get('title')}  "
              f"({c.get('columnTitle') or c.get('columnName') or c.get('columnId')})")


def _parse_due(due: str | None) -> str | None:
    if not due:
        return None
    if "T" in due:
        return due
    return f"{due}T00:00:00Z"


def cmd_create_card(args):
    api_key, board_id = load_config(args.board)
    cache = ensure_cache(api_key, board_id)
    body = {
        "board": board_id,
        "title": args.title,
        "columnId": resolve_column(cache, args.stage),
    }
    if args.description:
        body["description"] = args.description
    if args.label:
        body["label"] = args.label
    if args.owner:
        body["owner"] = args.owner
    if args.due:
        body["dueAt"] = _parse_due(args.due)
    if args.priority:
        body["priority"] = args.priority
    card_item = {k: v for k, v in body.items() if k != "board"}
    resp = post("/cards", api_key, {"board": board_id, "cards": [card_item]})
    if isinstance(resp, list):
        raw = resp
    elif isinstance(resp, dict):
        raw = resp.get("cards") or resp.get("created") or []
    else:
        raw = []
    created = [_unwrap_card(x) for x in raw if x]
    created = [c for c in created if c]
    if created:
        c = created[0]
        num = c.get("number") or c.get("id") or c.get("cardNumber")
        print(f"Created #{num}: {args.title}")
        print(f"  https://kanbanzone.io/b/{board_id}/c/{num}")
    else:
        print(f"Created: {args.title}  (no card returned in response)")
        if args.debug:
            print(f"  raw response: {json.dumps(resp, default=str)[:500]}", file=sys.stderr)


def cmd_bulk_create(args):
    api_key, board_id = load_config(args.board)
    cache = ensure_cache(api_key, board_id)
    path = Path(args.from_)
    if not path.exists():
        sys.exit(f"CSV not found: {path}")
    cards = []
    with path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            if not row.get("title") or not row.get("stage"):
                continue
            item = {
                "title": row["title"],
                "columnId": resolve_column(cache, row["stage"]),
            }
            for k_csv, k_api in [("description", "description"), ("label", "label"), ("owner", "owner")]:
                v = row.get(k_csv)
                if v:
                    item[k_api] = v
            cards.append(item)
    if not cards:
        sys.exit("No rows to create.")
    resp = post("/cards", api_key, {"board": board_id, "cards": cards})
    created = resp if isinstance(resp, list) else resp.get("cards") or resp.get("created") or []
    print(f"Bulk-created {len(created)} cards.")
    for c in created:
        inner = _unwrap_card(c)
        print(f"  #{inner.get('number') or inner.get('id')}  {inner.get('title')}")


def cmd_move_card(args):
    api_key, board_id = load_config(args.board)
    cache = ensure_cache(api_key, board_id)
    col_id = resolve_column(cache, args.stage)
    post(f"/cards/{args.id}/move", api_key, {"columnId": col_id, "board": board_id})
    print(f"Moved #{args.id} → {args.stage}")


def cmd_update_card(args):
    api_key, board_id = load_config(args.board)
    body: dict[str, Any] = {"board": board_id}
    if args.title:
        body["title"] = args.title
    if args.description:
        body["description"] = args.description
    if args.label:
        body["label"] = args.label
    if args.owner:
        body["owner"] = args.owner
    if args.due:
        body["dueAt"] = _parse_due(args.due)
    if args.priority:
        body["priority"] = args.priority
    if args.block:
        body["blocked"] = True
        body["blockedReason"] = args.block
    if args.unblock:
        body["blocked"] = False
    if args.custom_field:
        body["customFields"] = []
        for cf in args.custom_field:
            if "=" not in cf:
                sys.exit(f"--custom-field must be name=value; got {cf!r}")
            name, _, value = cf.partition("=")
            body["customFields"].append({"name": name.strip(), "value": value.strip()})
    if len(body) == 1:
        sys.exit("Nothing to update — specify at least one field.")
    put(f"/cards/{args.id}", api_key, body)
    fields = sorted(k for k in body if k != "board")
    print(f"Updated #{args.id}: {', '.join(fields)}")


def cmd_dump(args):
    """Fetch an arbitrary GET path and print the raw JSON. For debugging."""
    api_key, board_id = load_config(args.board)
    path = args.path
    path = path.replace("{board}", board_id)
    if not path.startswith("/"):
        path = "/" + path
    resp = get(path, api_key)
    print(json.dumps(resp, indent=2, default=str))


def cmd_comment(args):
    api_key, board_id = load_config(args.board)
    body: dict[str, Any] = {"board": board_id, "text": args.text}
    post(f"/cards/{args.id}/comments", api_key, body)
    print(f"Commented on #{args.id}: {args.text[:80]}")


# ---------- argparse ----------

def main():
    # Parent parser holds --board so subcommands inherit it. This means
    # both `kz --board ID list-cards` and `kz list-cards --board ID` work.
    board_parent = argparse.ArgumentParser(add_help=False)
    board_parent.add_argument("--board", help="Board public ID (overrides KZ_DEFAULT_BOARD_ID/config)")

    p = argparse.ArgumentParser(prog="kz", description="Kanban Zone CLI (multi-board)",
                                parents=[board_parent])
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("verify", parents=[board_parent],
                   help="Check credentials and cache board metadata").set_defaults(func=cmd_verify)
    sub.add_parser("diagnose", help="Try each auth form and report which works").set_defaults(func=cmd_diagnose)
    sub.add_parser("refresh-cache", parents=[board_parent],
                   help="Refresh board metadata cache").set_defaults(func=cmd_refresh_cache)

    lb = sub.add_parser("list-boards", help="List every board accessible to the API key")
    lb.add_argument("--json", action="store_true", help="Output JSON")
    lb.set_defaults(func=cmd_list_boards)

    lc = sub.add_parser("list-cards", parents=[board_parent], help="List cards on the board")
    lc.add_argument("--column", help="Filter by column name (substring)")
    lc.add_argument("--json", action="store_true", help="Output JSON")
    lc.add_argument("--debug", action="store_true", help="Print first card keys/sample to stderr")
    lc.set_defaults(func=cmd_list_cards)

    fc = sub.add_parser("find", parents=[board_parent], help="Find cards by title substring")
    fc.add_argument("--title", required=True)
    fc.set_defaults(func=cmd_find)

    cc = sub.add_parser("create-card", parents=[board_parent], help="Create a single card")
    cc.add_argument("--stage", required=True, help="Target column name (or 'Parent / Title')")
    cc.add_argument("--title", required=True)
    cc.add_argument("--description")
    cc.add_argument("--label")
    cc.add_argument("--owner")
    cc.add_argument("--due")
    cc.add_argument("--priority")
    cc.add_argument("--debug", action="store_true", help="Print raw response on unexpected shape")
    cc.set_defaults(func=cmd_create_card)

    bc = sub.add_parser("bulk-create", parents=[board_parent], help="Bulk-create from CSV")
    bc.add_argument("--from", dest="from_", required=True, help="Path to CSV")
    bc.set_defaults(func=cmd_bulk_create)

    mc = sub.add_parser("move-card", parents=[board_parent], help="Move a card to another column")
    mc.add_argument("--id", required=True)
    mc.add_argument("--stage", required=True, help="Target column name (or 'Parent / Title')")
    mc.set_defaults(func=cmd_move_card)

    uc = sub.add_parser("update-card", parents=[board_parent], help="Update card fields")
    uc.add_argument("--id", required=True)
    uc.add_argument("--title")
    uc.add_argument("--description")
    uc.add_argument("--label")
    uc.add_argument("--owner")
    uc.add_argument("--due")
    uc.add_argument("--priority")
    uc.add_argument("--block", help="Block the card with this reason")
    uc.add_argument("--unblock", action="store_true")
    uc.add_argument("--custom-field", action="append", help='"name=value" (repeatable)')
    uc.set_defaults(func=cmd_update_card)

    dp = sub.add_parser("dump", parents=[board_parent],
                        help="GET an arbitrary API path and print raw JSON (debug)")
    dp.add_argument("path", help='API path, e.g. "/boards" or "/board/{board}"')
    dp.set_defaults(func=cmd_dump)

    cm = sub.add_parser("comment", parents=[board_parent], help="Add a comment to a card")
    cm.add_argument("--id", required=True)
    cm.add_argument("--text", required=True, help="Comment body")
    cm.set_defaults(func=cmd_comment)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
