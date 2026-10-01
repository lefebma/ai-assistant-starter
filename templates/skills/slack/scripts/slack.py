#!/usr/bin/env python3
"""slack.py: post and read in Slack as the Umi bot (not as Marc).

Token: SLACK_BOT_TOKEN env var, else SLACK_BOT_TOKEN in the project .env.
Never prints the token. Bot token starts with xoxb-.

Commands:
  whoami                               Show which bot/workspace the token belongs to.
  channels [--all]                     List channels the bot is in (--all: every public channel).
  users [--query TEXT]                 List workspace members (optionally filter by name/email).
  post --channel ID|#name --text TEXT [--thread TS]
                                       Post a message as the bot.
  dm --user U123 --text TEXT           Open a DM with a user and post as the bot.
  read --channel ID [--limit N]        Read recent messages (channels the bot is in only).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://slack.com/api/"
ROOT = Path(__file__).resolve().parents[3]


def token() -> str:
    t = os.environ.get("SLACK_BOT_TOKEN", "").strip().strip("'\"")
    if not t:
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("SLACK_BOT_TOKEN="):
                    t = line.split("=", 1)[1].strip().strip("'\"")
    if not t:
        sys.exit("SLACK_BOT_TOKEN is not set (env or .env). See skills/slack/SKILL.md for setup.")
    if not t.startswith("xoxb-"):
        sys.exit("SLACK_BOT_TOKEN must be a bot token (xoxb-...). Refusing to use another token type.")
    return t


def call(method: str, **params):
    data = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}).encode()
    req = urllib.request.Request(
        API + method, data=data,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.load(r)
    if not body.get("ok"):
        hint = ""
        if body.get("error") == "not_in_channel":
            hint = " (invite the bot to the channel: /invite @Umi)"
        sys.exit(f"Slack error from {method}: {body.get('error')}{hint}")
    return body


def resolve_channel(ch: str) -> str:
    if not ch.startswith("#"):
        return ch
    name, cursor = ch[1:], None
    while True:
        b = call("conversations.list", types="public_channel,private_channel", limit=200, cursor=cursor, exclude_archived="true")
        for c in b["channels"]:
            if c["name"] == name:
                return c["id"]
        cursor = b.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            sys.exit(f"No channel named {ch} visible to the bot (is it invited?)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    c = sub.add_parser("channels"); c.add_argument("--all", action="store_true")
    u = sub.add_parser("users"); u.add_argument("--query")
    po = sub.add_parser("post"); po.add_argument("--channel", required=True); po.add_argument("--text", required=True); po.add_argument("--thread")
    d = sub.add_parser("dm"); d.add_argument("--user", required=True); d.add_argument("--text", required=True)
    r = sub.add_parser("read"); r.add_argument("--channel", required=True); r.add_argument("--limit", type=int, default=20)
    a = p.parse_args()

    if a.cmd == "whoami":
        b = call("auth.test")
        print(f"bot={b['user']} user_id={b['user_id']} workspace={b['team']} url={b['url']}")
    elif a.cmd == "channels":
        if a.all:
            b = call("conversations.list", types="public_channel", limit=200, exclude_archived="true")
            for c in b["channels"]:
                print(f"{c['id']}\t#{c['name']}\tmember={c.get('is_member')}")
        else:
            b = call("users.conversations", types="public_channel,private_channel", limit=200, exclude_archived="true")
            for c in b["channels"]:
                print(f"{c['id']}\t#{c['name']}")
    elif a.cmd == "users":
        b = call("users.list", limit=200)
        q = (a.query or "").lower()
        for m in b["members"]:
            if m.get("deleted") or m.get("is_bot"):
                continue
            pr = m.get("profile", {})
            line = f"{m['id']}\t{m.get('real_name','')}\t{pr.get('email','')}"
            if not q or q in line.lower():
                print(line)
    elif a.cmd == "post":
        b = call("chat.postMessage", channel=resolve_channel(a.channel), text=a.text, thread_ts=a.thread)
        print(f"posted ts={b['ts']} channel={b['channel']}")
    elif a.cmd == "dm":
        ch = call("conversations.open", users=a.user)["channel"]["id"]
        b = call("chat.postMessage", channel=ch, text=a.text)
        print(f"dm sent ts={b['ts']} channel={ch}")
    elif a.cmd == "read":
        b = call("conversations.history", channel=resolve_channel(a.channel), limit=a.limit)
        for m in reversed(b["messages"]):
            print(f"[{m['ts']}] {m.get('user') or m.get('bot_id','?')}: {m.get('text','')}")


if __name__ == "__main__":
    main()
