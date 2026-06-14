## WordPress ({{WP_SITE_URL}})

Read site content, draft blog posts, audit SEO. Never publishes.

### Auth

- Site: `{{WP_SITE_URL}}`
- User: `{{WP_USERNAME}}`
- Application Password: `~/.config/wordpress/app_password` (chmod 600)
- Helper wraps all of this: `bash {{PROJECT_PATH}}/skills/wordpress/wp-api.sh <verb>`

Generate an Application Password in WP-Admin → Users → Your Profile → Application Passwords. Don't use your login password — Application Passwords are revocable per integration.

### Verbs

Read:

- `test` — auth check, returns `{id, username, name, roles}`
- `list-pages [N]` — up to N pages (default 50). Tab-separated `id status slug title`.
- `list-posts [N status]` — default 20, status=any. Same format.
- `get <id>` — full content of a page or post (tries page first, falls back to post)
- `get-by-slug <slug>` — same, by slug
- `seo <id>` — Yoast meta: title, description, robots, schema (requires Yoast plugin)

Write (drafts only):

- `draft-post --title="..." --content=<path|->` — creates a draft blog post. Optional: `--excerpt`, `--tags=ID,ID`, `--categories=ID,ID`. Body can be HTML or Markdown-ish (WP will accept raw HTML).
- `update-draft <id>` — only works if the post is already `status=draft`. Refuses to touch published posts.
- `upload-media <file>` — upload image/PDF. Optional: `--alt=...`, `--title=...`. Returns `{id, source_url, ...}`.

### Elementor caveat — read this before editing pages

If the site is built with Elementor, page layouts live in the `_elementor_data` post-meta field as JSON. Patching that JSON via the REST API is brittle: one malformed widget and the page breaks.

**Rules:**

1. For **blog posts** (standard WP content): `draft-post` and `update-draft` are safe. Use freely.
2. For **Elementor-built pages**: do **not** try to update `content` or `_elementor_data` via API. Instead:
   - Use `get` / `get-by-slug` to read the current copy
   - Propose the rewrite as a diff or as before/after chunks in chat
   - {{OWNER_NAME}} applies changes manually in the Elementor editor
3. If in doubt whether a page is Elementor-built, check for the `_elementor_edit_mode` meta field or just ask.

### Guardrails

- **No publish, no delete.** These verbs do not exist. If {{OWNER_NAME}} asks to publish or delete, return the draft ID + edit link and tell them to do it in wp-admin.
- **Always present drafts for review.** After `draft-post` or `update-draft`, return the edit link (`{{WP_SITE_URL}}/wp-admin/post.php?post=<id>&action=edit`) and let {{OWNER_NAME}} eyeball it before going live.
- **Don't spam drafts.** If iterating on a blog post, use `update-draft <id>` against the same post rather than creating a new draft on each revision.

### Typical flows

**Draft a blog post from a prompt:**
```bash
cat > /tmp/post.html <<'EOF'
<h2>Headline goes here</h2>
<p>Body...</p>
EOF
bash {{PROJECT_PATH}}/skills/wordpress/wp-api.sh draft-post \
  --title="Headline goes here" \
  --content=/tmp/post.html \
  --excerpt="One-line teaser."
```

**Pull current homepage copy for a rewrite proposal:**
```bash
bash {{PROJECT_PATH}}/skills/wordpress/wp-api.sh get-by-slug homepage | jq -r '.content_rendered'
```

**SEO audit of a page:**
```bash
bash {{PROJECT_PATH}}/skills/wordpress/wp-api.sh seo 1234
```

### Known quirks

- Managed WP hosts (GoDaddy, Kinsta, WP Engine, etc.) aggressively cache. REST reads always bypass cache, but if you draft a post and want to preview, use the `edit_link` returned by the helper — don't try to GET the public URL.
- `yoast_head_json` is present on published content; drafts may have a partial version until first save in the editor. Requires the Yoast SEO plugin.
- If the assistant uses a non-Yoast SEO plugin (Rank Math, AIOSEO), the `seo` verb will return empty — fall back to reading raw post meta.

### Out of scope (v1)

- Publishing, deleting, revisions API, multisite, user management
- Patching Elementor JSON directly
- Theme/plugin management
- Custom post types beyond `post` and `page`
