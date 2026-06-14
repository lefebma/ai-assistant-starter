#!/usr/bin/env bash
# WordPress REST helper
# Auth: Application Password via HTTP Basic Auth
# Creds: ~/.config/wordpress/app_password  (chmod 600)
# All write verbs force status=draft. No publish, no delete.

set -euo pipefail

SITE="{{WP_SITE_URL}}"
USER="{{WP_USERNAME}}"
PW_FILE="$HOME/.config/wordpress/app_password"

if [[ ! -f "$PW_FILE" ]]; then
  echo "error: password file not found at $PW_FILE" >&2
  echo "Generate an Application Password at $SITE/wp-admin/profile.php and save it to $PW_FILE (chmod 600)" >&2
  exit 2
fi
PW=$(cat "$PW_FILE")

api() {
  # api <method> <path> [--data-binary @file | --data '...']
  local method="$1" path="$2"; shift 2
  curl -sS -u "$USER:$PW" -X "$method" \
    -H "Content-Type: application/json" \
    "$SITE/wp-json$path" "$@"
}

usage() {
  cat <<EOF
wp-api.sh <verb> [args]

Read verbs:
  test                         Auth check (GET /users/me)
  list-pages [N]               List up to N pages (default 50)
  list-posts [N] [status]      List up to N posts (default 20, status=any)
  get <id>                     Full page/post content (tries page, falls back to post)
  get-by-slug <slug>           Find page or post by slug, return full content
  seo <id>                     Yoast meta (title, description, robots, schema)

Write verbs (all produce drafts):
  draft-post --title=<t> --content=<file_or_-> [--excerpt=<e>] [--tags=id,id] [--categories=id,id]
  update-draft <id> [--title=<t>] [--content=<file_or_->] [--excerpt=<e>]
  upload-media <file> [--alt=<text>] [--title=<title>]

Examples:
  wp-api.sh test
  wp-api.sh list-pages
  wp-api.sh get-by-slug homepage
  wp-api.sh seo 1234
  wp-api.sh draft-post --title="My new post" --content=/tmp/post.html
EOF
}

case "${1:-}" in
  test)
    api GET "/wp/v2/users/me?context=edit" | jq '{id, username, name, roles}'
    ;;

  list-pages)
    N="${2:-50}"
    api GET "/wp/v2/pages?per_page=$N&status=any&_fields=id,slug,status,title,link,modified" \
      | jq -r '.[] | "\(.id)\t\(.status)\t\(.slug)\t\(.title.rendered)"'
    ;;

  list-posts)
    N="${2:-20}"
    STATUS="${3:-any}"
    api GET "/wp/v2/posts?per_page=$N&status=$STATUS&_fields=id,slug,status,title,link,modified" \
      | jq -r '.[] | "\(.id)\t\(.status)\t\(.slug)\t\(.title.rendered)"'
    ;;

  get)
    ID="${2:?need id}"
    OUT=$(api GET "/wp/v2/pages/$ID?context=edit" || true)
    if echo "$OUT" | jq -e '.id' >/dev/null 2>&1; then
      TYPE=page
    else
      OUT=$(api GET "/wp/v2/posts/$ID?context=edit")
      TYPE=post
    fi
    echo "$OUT" | jq --arg t "$TYPE" '{type: $t, id, slug, status, link, title: .title.rendered, excerpt: .excerpt.raw, content_raw: .content.raw, content_rendered: .content.rendered, modified}'
    ;;

  get-by-slug)
    SLUG="${2:?need slug}"
    PAGE=$(api GET "/wp/v2/pages?slug=$SLUG&context=edit&_fields=id,slug,status,title,link,content,excerpt,modified")
    if [[ "$(echo "$PAGE" | jq 'length')" -gt 0 ]]; then
      echo "$PAGE" | jq '.[0] | {type: "page", id, slug, status, link, title: .title.rendered, excerpt: .excerpt.raw, content_raw: .content.raw, content_rendered: .content.rendered, modified}'
    else
      POST=$(api GET "/wp/v2/posts?slug=$SLUG&context=edit&_fields=id,slug,status,title,link,content,excerpt,modified")
      echo "$POST" | jq '.[0] | {type: "post", id, slug, status, link, title: .title.rendered, excerpt: .excerpt.raw, content_raw: .content.raw, content_rendered: .content.rendered, modified}'
    fi
    ;;

  seo)
    ID="${2:?need id}"
    OUT=$(api GET "/wp/v2/pages/$ID?_fields=yoast_head_json,title" || true)
    if ! echo "$OUT" | jq -e '.yoast_head_json' >/dev/null 2>&1; then
      OUT=$(api GET "/wp/v2/posts/$ID?_fields=yoast_head_json,title")
    fi
    echo "$OUT" | jq '{title: .title.rendered, seo: .yoast_head_json}'
    ;;

  draft-post)
    shift
    TITLE="" CONTENT_SRC="" EXCERPT="" TAGS="" CATS=""
    for arg in "$@"; do
      case "$arg" in
        --title=*)      TITLE="${arg#--title=}" ;;
        --content=*)    CONTENT_SRC="${arg#--content=}" ;;
        --excerpt=*)    EXCERPT="${arg#--excerpt=}" ;;
        --tags=*)       TAGS="${arg#--tags=}" ;;
        --categories=*) CATS="${arg#--categories=}" ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
      esac
    done
    [[ -z "$TITLE" ]] && { echo "--title required" >&2; exit 2; }
    [[ -z "$CONTENT_SRC" ]] && { echo "--content required (path or -)" >&2; exit 2; }
    if [[ "$CONTENT_SRC" == "-" ]]; then
      BODY=$(cat)
    elif [[ -f "$CONTENT_SRC" ]]; then
      BODY=$(cat "$CONTENT_SRC")
    else
      echo "content source not found: $CONTENT_SRC" >&2; exit 2
    fi
    PAYLOAD=$(jq -n \
      --arg title "$TITLE" \
      --arg content "$BODY" \
      --arg excerpt "$EXCERPT" \
      --arg tags "$TAGS" \
      --arg cats "$CATS" \
      '{status: "draft", title: $title, content: $content}
       + (if $excerpt != "" then {excerpt: $excerpt} else {} end)
       + (if $tags != "" then {tags: ($tags | split(",") | map(tonumber))} else {} end)
       + (if $cats != "" then {categories: ($cats | split(",") | map(tonumber))} else {} end)')
    api POST "/wp/v2/posts" --data "$PAYLOAD" \
      | jq --arg site "$SITE" '{id, status, link, edit_link: ($site + "/wp-admin/post.php?post=" + (.id|tostring) + "&action=edit"), title: .title.rendered}'
    ;;

  update-draft)
    ID="${2:?need id}"
    shift 2
    CUR=$(api GET "/wp/v2/posts/$ID?_fields=status,type" || true)
    if ! echo "$CUR" | jq -e '.status' >/dev/null 2>&1; then
      echo "error: post $ID not found (this verb only edits posts, not pages)" >&2; exit 3
    fi
    STATUS=$(echo "$CUR" | jq -r '.status')
    if [[ "$STATUS" != "draft" ]]; then
      echo "error: post $ID has status=$STATUS. Only drafts can be updated via this skill." >&2
      exit 3
    fi
    TITLE="" CONTENT_SRC="" EXCERPT=""
    for arg in "$@"; do
      case "$arg" in
        --title=*)   TITLE="${arg#--title=}" ;;
        --content=*) CONTENT_SRC="${arg#--content=}" ;;
        --excerpt=*) EXCERPT="${arg#--excerpt=}" ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
      esac
    done
    BODY=""
    if [[ -n "$CONTENT_SRC" ]]; then
      if [[ "$CONTENT_SRC" == "-" ]]; then BODY=$(cat)
      elif [[ -f "$CONTENT_SRC" ]]; then BODY=$(cat "$CONTENT_SRC")
      else echo "content source not found: $CONTENT_SRC" >&2; exit 2
      fi
    fi
    PAYLOAD=$(jq -n \
      --arg title "$TITLE" \
      --arg content "$BODY" \
      --arg excerpt "$EXCERPT" \
      '{status: "draft"}
       + (if $title != "" then {title: $title} else {} end)
       + (if $content != "" then {content: $content} else {} end)
       + (if $excerpt != "" then {excerpt: $excerpt} else {} end)')
    api POST "/wp/v2/posts/$ID" --data "$PAYLOAD" \
      | jq --arg site "$SITE" '{id, status, link, edit_link: ($site + "/wp-admin/post.php?post=" + (.id|tostring) + "&action=edit"), title: .title.rendered}'
    ;;

  upload-media)
    FILE="${2:?need file}"; shift 2
    [[ ! -f "$FILE" ]] && { echo "file not found: $FILE" >&2; exit 2; }
    ALT="" MEDIA_TITLE=""
    for arg in "$@"; do
      case "$arg" in
        --alt=*)   ALT="${arg#--alt=}" ;;
        --title=*) MEDIA_TITLE="${arg#--title=}" ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
      esac
    done
    FNAME=$(basename "$FILE")
    MIME=$(file -b --mime-type "$FILE")
    RESP=$(curl -sS -u "$USER:$PW" -X POST \
      -H "Content-Disposition: attachment; filename=\"$FNAME\"" \
      -H "Content-Type: $MIME" \
      --data-binary "@$FILE" \
      "$SITE/wp-json/wp/v2/media")
    MEDIA_ID=$(echo "$RESP" | jq -r '.id // empty')
    if [[ -z "$MEDIA_ID" ]]; then echo "$RESP"; exit 4; fi
    if [[ -n "$ALT" || -n "$MEDIA_TITLE" ]]; then
      META=$(jq -n --arg alt "$ALT" --arg t "$MEDIA_TITLE" \
        '(if $alt != "" then {alt_text: $alt} else {} end)
         + (if $t != "" then {title: $t} else {} end)')
      RESP=$(api POST "/wp/v2/media/$MEDIA_ID" --data "$META")
    fi
    echo "$RESP" | jq '{id, source_url, mime_type, alt_text, title: .title.rendered}'
    ;;

  ""|-h|--help|help) usage ;;
  *) echo "unknown verb: $1" >&2; usage; exit 2 ;;
esac
