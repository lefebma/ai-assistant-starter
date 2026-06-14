#!/bin/bash
# AI Assistant - Interactive Setup
# Walks a new user through configuring their personal AI assistant.

set -e

echo "============================================"
echo "  AI Assistant Setup"
echo "  Powered by Claude Code"
echo "============================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

prompt() {
  local var_name=$1
  local prompt_text=$2
  local default=$3
  if [ -n "$default" ]; then
    read -p "$(echo -e "${BLUE}${prompt_text}${NC} [${default}]: ")" value
    eval "$var_name=\"${value:-$default}\""
  else
    read -p "$(echo -e "${BLUE}${prompt_text}${NC}: ")" value
    eval "$var_name=\"$value\""
  fi
}

prompt_choice() {
  local var_name=$1
  local prompt_text=$2
  shift 2
  local options=("$@")
  echo -e "${BLUE}${prompt_text}${NC}"
  for i in "${!options[@]}"; do
    echo "  $((i+1)). ${options[$i]}"
  done
  read -p "Choose (1-${#options[@]}): " choice
  eval "$var_name=\"${options[$((choice-1))]}\""
}

prompt_yn() {
  # prompt_yn VAR "Question?" → sets VAR=true if y/Y, false otherwise. Default no.
  local var_name=$1
  local prompt_text=$2
  read -p "$(echo -e "${BLUE}${prompt_text}${NC} (y/N): ")" yn
  if [[ "$yn" =~ ^[Yy] ]]; then
    eval "$var_name=true"
  else
    eval "$var_name=false"
  fi
}

write_secret() {
  # write_secret <path> <value>
  # Refuses to overwrite an existing non-empty file (or a symlink whose target is non-empty).
  # Writes via the resolved path, chmod 600. Logs to stderr.
  local path="$1" value="$2"
  local resolved="$path"
  if [ -L "$path" ]; then
    resolved=$(readlink "$path")
  fi
  if [ -e "$resolved" ] && [ -s "$resolved" ]; then
    echo -e "  ${YELLOW}Skip:${NC} $path already exists (non-empty) — not overwriting"
    return 0
  fi
  mkdir -p "$(dirname "$resolved")"
  printf '%s' "$value" > "$resolved"
  chmod 600 "$resolved"
  echo -e "  ${GREEN}Wrote${NC} $path"
}

echo -e "${GREEN}Let's set up your AI assistant.${NC}"
echo ""

# Basic info
prompt OWNER_NAME "Your name"
prompt ASSISTANT_NAME "Name for your assistant" "Atlas"
prompt TIMEZONE "Your timezone" "America/New_York"
prompt CITY "Your city (for weather)" "New York"

# Platform
echo ""
prompt_choice PLATFORM "Which messaging platform?" "Telegram" "Slack" "Discord" "Teams"

# Personality
echo ""
echo -e "${YELLOW}How should your assistant communicate?${NC}"
echo "  1. Professional and efficient"
echo "  2. Friendly and conversational"
echo "  3. Direct and no-nonsense"
echo "  4. Custom (you'll write it)"
read -p "Choose (1-4): " vibe_choice

case $vibe_choice in
  1) PERSONALITY_VIBE="Professional, efficient, precise. Communicate clearly without unnecessary filler. Prioritize accuracy and actionability." ;;
  2) PERSONALITY_VIBE="Warm but efficient. Conversational tone without being chatty. Personable, remembers context, occasionally lighthearted." ;;
  3) PERSONALITY_VIBE="Direct, sharp, no fluff. Say what needs saying and move on. Push back when something doesn't make sense. Have opinions." ;;
  4) prompt PERSONALITY_VIBE "Describe the vibe in 1-2 sentences" ;;
esac

# Bio
echo ""
echo -e "${YELLOW}Tell the assistant about yourself (1-3 sentences).${NC}"
echo "Include: your role, your business/industry, what kind of help you need."
read -p "> " OWNER_BIO

# Email
echo ""
prompt_choice EMAIL_PROVIDER "Email provider?" "Gmail" "Outlook/Microsoft 365" "Both" "Skip for now"

INSTALLED_SKILLS="weather"
GMAIL_ADDRESS_2=""
OUTLOOK_ADDRESS_2=""

case $EMAIL_PROVIDER in
  "Gmail")
    prompt GMAIL_ADDRESS "Gmail address"
    EMAIL_ADDRESS="$GMAIL_ADDRESS"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail"
    prompt_yn ADD_SECOND_GMAIL "Add a second Gmail account?"
    if [ "$ADD_SECOND_GMAIL" = true ]; then
      prompt GMAIL_ADDRESS_2 "Second Gmail address"
      INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail-secondary"
    fi
    ;;
  "Outlook/Microsoft 365")
    prompt OUTLOOK_ADDRESS "Outlook email address"
    EMAIL_ADDRESS="$OUTLOOK_ADDRESS"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, outlook"
    prompt_yn ADD_SECOND_OUTLOOK "Add a second Outlook account?"
    if [ "$ADD_SECOND_OUTLOOK" = true ]; then
      prompt OUTLOOK_ADDRESS_2 "Second Outlook email address"
      INSTALLED_SKILLS="$INSTALLED_SKILLS, outlook-secondary"
    fi
    ;;
  "Both")
    prompt GMAIL_ADDRESS "Gmail address"
    prompt OUTLOOK_ADDRESS "Outlook email address"
    EMAIL_ADDRESS="$GMAIL_ADDRESS"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail, outlook"
    prompt_yn ADD_SECOND_GMAIL "Add a second Gmail account?"
    if [ "$ADD_SECOND_GMAIL" = true ]; then
      prompt GMAIL_ADDRESS_2 "Second Gmail address"
      INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail-secondary"
    fi
    prompt_yn ADD_SECOND_OUTLOOK "Add a second Outlook account?"
    if [ "$ADD_SECOND_OUTLOOK" = true ]; then
      prompt OUTLOOK_ADDRESS_2 "Second Outlook email address"
      INSTALLED_SKILLS="$INSTALLED_SKILLS, outlook-secondary"
    fi
    ;;
  "Skip for now")
    EMAIL_ADDRESS=""
    ;;
esac

# Email signature
echo ""
prompt EMAIL_SIG_NAME "Name for email signature" "$OWNER_NAME"
prompt EMAIL_SIG_TITLE "Title/role" ""
prompt EMAIL_SIG_PHONE "Phone" ""
prompt EMAIL_SIG_EMAIL "Email" "$EMAIL_ADDRESS"

EMAIL_SIGNATURE="${EMAIL_SIG_NAME}"
[ -n "$EMAIL_SIG_TITLE" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_TITLE}"
[ -n "$EMAIL_SIG_PHONE" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_PHONE}"
[ -n "$EMAIL_SIG_EMAIL" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_EMAIL}"

# Location for weather
echo ""
echo -e "${YELLOW}Setting up weather skill...${NC}"
echo "Look up your coordinates at: https://www.latlong.net/"
prompt LATITUDE "Latitude" "40.71"
prompt LONGITUDE "Longitude" "-74.01"
prompt_choice TEMP_UNIT "Temperature unit?" "celsius" "fahrenheit"

# Web research (Perplexity)
echo ""
echo -e "${YELLOW}Web research skill (Perplexity)?${NC}"
echo "Adds three-tier web research (quick / medium / deep) with citations."
echo "Requires a Perplexity API key — get one at https://www.perplexity.ai/settings/api"
read -p "Enable web-research skill? (y/N): " WEB_RESEARCH_CHOICE
if [[ "$WEB_RESEARCH_CHOICE" =~ ^[Yy] ]]; then
  ENABLE_WEB_RESEARCH=true
  INSTALLED_SKILLS="$INSTALLED_SKILLS, web-research"
  prompt PERPLEXITY_API_KEY "Perplexity API key (leave blank to fill in later)" ""
else
  ENABLE_WEB_RESEARCH=false
fi

# Apollo.io
echo ""
echo -e "${YELLOW}Apollo.io skill?${NC}"
echo "Company/person/domain lookups and active-sequence reports against the Apollo API."
echo "Requires an Apollo API key — get one at https://app.apollo.io/#/settings/integrations/api"
prompt_yn ENABLE_APOLLO "Enable Apollo skill?"
if [ "$ENABLE_APOLLO" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, apollo"
  prompt APOLLO_API_KEY "Apollo API key (leave blank to fill in later)" ""
fi

# Wordsmith (Gemini)
echo ""
echo -e "${YELLOW}Wordsmith skill (Gemini prose delegation)?${NC}"
echo "Delegates email/newsletter/copy drafting to Gemini 2.5. The assistant orchestrates, Gemini writes."
echo "Requires a Google AI Studio API key — get one at https://aistudio.google.com/app/apikey"
prompt_yn ENABLE_WORDSMITH "Enable Wordsmith skill?"
if [ "$ENABLE_WORDSMITH" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, wordsmith"
  prompt GOOGLE_API_KEY "Google API key (leave blank to fill in later)" ""
fi

# Anti-library (Obsidian)
echo ""
echo -e "${YELLOW}Anti-library skill (Obsidian knowledge base)?${NC}"
echo "Lets the assistant maintain a structured wiki in an Obsidian vault — ingest, query, lint."
prompt_yn ENABLE_ANTILIBRARY "Enable Anti-library skill?"
if [ "$ENABLE_ANTILIBRARY" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, antilibrary"
  prompt OBSIDIAN_VAULT_PATH "Obsidian vault path (full path)" "$HOME/Documents/Knowledge"
fi

# Notion
echo ""
echo -e "${YELLOW}Notion skill?${NC}"
echo "Read/search/create pages and databases via the Notion API."
echo "Requires a Notion integration token — get one at https://www.notion.so/profile/integrations"
prompt_yn ENABLE_NOTION "Enable Notion skill?"
if [ "$ENABLE_NOTION" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, notion"
  prompt NOTION_TOKEN "Notion integration token (leave blank to fill in later)" ""
fi

# Kanban Zone
echo ""
echo -e "${YELLOW}Kanban Zone skill?${NC}"
echo "Read board state, create/move/update cards, add comments via the Kanban Zone Public API."
echo "Requires a Kanban Zone API key from your account settings."
prompt_yn ENABLE_KANBANZONE "Enable Kanban Zone skill?"
if [ "$ENABLE_KANBANZONE" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, kanbanzone"
  prompt KZ_API_KEY "Kanban Zone API key (leave blank to fill in later)" ""
  prompt KZ_DEFAULT_BOARD_ID "Default board ID (optional, can set later)" ""
fi

# WordPress
echo ""
echo -e "${YELLOW}WordPress skill (drafts-only)?${NC}"
echo "Read site content, draft blog posts, audit SEO. Never publishes."
echo "Requires a WP Application Password — generate at <site>/wp-admin/profile.php"
prompt_yn ENABLE_WORDPRESS "Enable WordPress skill?"
if [ "$ENABLE_WORDPRESS" = true ]; then
  INSTALLED_SKILLS="$INSTALLED_SKILLS, wordpress"
  prompt WP_SITE_URL "WordPress site URL (no trailing slash)" "https://example.com"
  prompt WP_USERNAME "WordPress username"
  prompt WP_APP_PASSWORD "Application Password (leave blank to fill in later)" ""
fi

# Project path
PROJECT_PATH="$(pwd)"

echo ""
echo -e "${GREEN}Generating configuration files...${NC}"

# Generate CLAUDE.md
TEMPLATE_DIR="$(cd "$(dirname "$0")" && pwd)/templates"

# Determine platform format notes
case $PLATFORM in
  "Telegram")
    PLATFORM_FORMAT_NOTES="- Telegram supports limited HTML formatting (bold, italic, code, links)"
    HOST_OS="Mac"
    ;;
  "Slack")
    PLATFORM_FORMAT_NOTES="- Slack supports mrkdwn formatting (bold, italic, code blocks, links, lists)"
    HOST_OS="Mac"
    ;;
  "Discord")
    PLATFORM_FORMAT_NOTES="- Discord supports Markdown formatting (bold, italic, code blocks, embeds)"
    HOST_OS="Mac"
    ;;
  "Teams")
    PLATFORM_FORMAT_NOTES="- Teams supports Adaptive Cards and basic Markdown"
    HOST_OS="Mac"
    ;;
esac

# Generate CLAUDE.md from template
sed \
  -e "s|{{ASSISTANT_NAME}}|${ASSISTANT_NAME}|g" \
  -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
  -e "s|{{PLATFORM}}|${PLATFORM}|g" \
  -e "s|{{HOST_OS}}|${HOST_OS}|g" \
  -e "s|{{PERSONALITY_VIBE}}|${PERSONALITY_VIBE}|g" \
  -e "s|{{TIMEZONE}}|${TIMEZONE}|g" \
  -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
  -e "s|{{INSTALLED_SKILLS}}|${INSTALLED_SKILLS}|g" \
  -e "s|{{PLATFORM_FORMAT_NOTES}}|${PLATFORM_FORMAT_NOTES}|g" \
  -e "s|{{OWNER_BIO}}|${OWNER_BIO}|g" \
  -e "s|{{CUSTOM_RULES}}||g" \
  -e "s|{{EMAIL_SIGNATURE}}|${EMAIL_SIGNATURE}|g" \
  "${TEMPLATE_DIR}/CLAUDE.md.template" > CLAUDE.md

echo -e "  ${GREEN}Created${NC} CLAUDE.md"

# Copy and configure skills
mkdir -p skills

# Weather skill
cp -r "${TEMPLATE_DIR}/skills/weather" skills/
sed -i '' \
  -e "s|{{LATITUDE}}|${LATITUDE}|g" \
  -e "s|{{LONGITUDE}}|${LONGITUDE}|g" \
  -e "s|{{TEMP_UNIT}}|${TEMP_UNIT}|g" \
  -e "s|{{TIMEZONE}}|${TIMEZONE}|g" \
  -e "s|{{CITY}}|${CITY}|g" \
  skills/weather/manifest.json 2>/dev/null || true

echo -e "  ${GREEN}Created${NC} skills/weather/"

# Gmail skill (primary)
if [[ ", $INSTALLED_SKILLS, " == *", gmail, "* ]]; then
  cp -r "${TEMPLATE_DIR}/skills/gmail" skills/
  GMAIL_ADDR="${GMAIL_ADDRESS:-$EMAIL_ADDRESS}"
  sed -i '' "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDR}|g" skills/gmail/SKILL.md 2>/dev/null || true
  sed -i '' "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDR}|g" skills/gmail/manifest.json 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/gmail/ ($GMAIL_ADDR)"
fi

# Gmail skill (secondary, optional)
if [[ ", $INSTALLED_SKILLS, " == *", gmail-secondary, "* ]] && [ -n "${GMAIL_ADDRESS_2:-}" ]; then
  cp -r "${TEMPLATE_DIR}/skills/gmail" skills/gmail-secondary
  sed -i '' "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDRESS_2}|g" skills/gmail-secondary/SKILL.md 2>/dev/null || true
  sed -i '' \
    -e "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDRESS_2}|g" \
    -e 's|"id": "gmail"|"id": "gmail-secondary"|' \
    -e 's|"name": "Gmail & Google Calendar"|"name": "Gmail \& Google Calendar (secondary)"|' \
    skills/gmail-secondary/manifest.json 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/gmail-secondary/ ($GMAIL_ADDRESS_2)"
fi

# Outlook skill (primary)
if [[ ", $INSTALLED_SKILLS, " == *", outlook, "* ]]; then
  cp -r "${TEMPLATE_DIR}/skills/outlook" skills/
  OUTLOOK_ADDR="${OUTLOOK_ADDRESS:-$EMAIL_ADDRESS}"
  sed -i '' "s|{{EMAIL_ADDRESS}}|${OUTLOOK_ADDR}|g" skills/outlook/SKILL.md 2>/dev/null || true
  sed -i '' "s|{{EMAIL_ADDRESS}}|${OUTLOOK_ADDR}|g" skills/outlook/manifest.json 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/outlook/ ($OUTLOOK_ADDR)"
fi

# Outlook skill (secondary, optional)
if [[ ", $INSTALLED_SKILLS, " == *", outlook-secondary, "* ]] && [ -n "${OUTLOOK_ADDRESS_2:-}" ]; then
  cp -r "${TEMPLATE_DIR}/skills/outlook" skills/outlook-secondary
  sed -i '' "s|{{EMAIL_ADDRESS}}|${OUTLOOK_ADDRESS_2}|g" skills/outlook-secondary/SKILL.md 2>/dev/null || true
  sed -i '' \
    -e "s|{{EMAIL_ADDRESS}}|${OUTLOOK_ADDRESS_2}|g" \
    -e 's|"id": "outlook"|"id": "outlook-secondary"|' \
    -e 's|"name": "Outlook Email & Calendar"|"name": "Outlook Email \& Calendar (secondary)"|' \
    skills/outlook-secondary/manifest.json 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/outlook-secondary/ ($OUTLOOK_ADDRESS_2)"
fi

# Web research skill
if [ "$ENABLE_WEB_RESEARCH" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/web-research" skills/
  sed -i '' \
    -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
    -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
    -e "s|{{OWNER_BIO}}|${OWNER_BIO}|g" \
    skills/web-research/SKILL.md 2>/dev/null || true
  sed -i '' \
    -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
    skills/web-research/manifest.json 2>/dev/null || true
  chmod +x skills/web-research/research.sh
  mkdir -p research

  if [ -n "$PERPLEXITY_API_KEY" ]; then
    write_secret "$HOME/.perplexity-api-key" "$PERPLEXITY_API_KEY"
  else
    echo -e "  ${YELLOW}Note:${NC} write your Perplexity API key to ~/.perplexity-api-key before using the skill"
  fi
  echo -e "  ${GREEN}Created${NC} skills/web-research/"
fi

# Apollo skill
if [ "${ENABLE_APOLLO:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/apollo" skills/
  sed -i '' -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" skills/apollo/SKILL.md 2>/dev/null || true
  sed -i '' -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" skills/apollo/manifest.json 2>/dev/null || true
  chmod +x skills/apollo/apollo-lookup.sh
  if [ -n "$APOLLO_API_KEY" ]; then
    write_secret "$HOME/.apollo-api-key" "$APOLLO_API_KEY"
  else
    echo -e "  ${YELLOW}Note:${NC} write your Apollo API key to ~/.apollo-api-key before using the skill"
  fi
  echo -e "  ${GREEN}Created${NC} skills/apollo/"
fi

# Wordsmith skill
if [ "${ENABLE_WORDSMITH:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/wordsmith" skills/
  sed -i '' -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" skills/wordsmith/SKILL.md 2>/dev/null || true
  sed -i '' -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" skills/wordsmith/manifest.json 2>/dev/null || true
  chmod +x skills/wordsmith/wordsmith.sh
  if [ -n "$GOOGLE_API_KEY" ]; then
    # Append to project .env (created later); also remember for now
    WORDSMITH_GOOGLE_API_KEY="$GOOGLE_API_KEY"
  else
    echo -e "  ${YELLOW}Note:${NC} add GOOGLE_API_KEY=... to your .env before using Wordsmith"
  fi
  echo -e "  ${GREEN}Created${NC} skills/wordsmith/"
fi

# Anti-library skill
if [ "${ENABLE_ANTILIBRARY:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/antilibrary" skills/
  sed -i '' \
    -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
    -e "s|{{OBSIDIAN_VAULT_PATH}}|${OBSIDIAN_VAULT_PATH}|g" \
    skills/antilibrary/SKILL.md 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/antilibrary/ (vault: $OBSIDIAN_VAULT_PATH)"
fi

# Notion skill
if [ "${ENABLE_NOTION:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/notion" skills/
  sed -i '' -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" skills/notion/SKILL.md 2>/dev/null || true
  if [ -n "$NOTION_TOKEN" ]; then
    write_secret "$HOME/.config/notion/api_key" "$NOTION_TOKEN"
  else
    echo -e "  ${YELLOW}Note:${NC} write your Notion integration token to ~/.config/notion/api_key before using the skill"
  fi
  echo -e "  ${GREEN}Created${NC} skills/notion/"
fi

# Kanban Zone skill
if [ "${ENABLE_KANBANZONE:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/kanbanzone" skills/
  sed -i '' -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" skills/kanbanzone/manifest.json 2>/dev/null || true
  chmod +x skills/kanbanzone/scripts/kz.py
  if [ -n "$KZ_API_KEY" ]; then
    KZ_CONFIG_JSON="{
  \"api_key\": \"${KZ_API_KEY}\"$( [ -n "$KZ_DEFAULT_BOARD_ID" ] && printf ',\n  \"default_board_id\": \"%s\"' "$KZ_DEFAULT_BOARD_ID" )
}"
    write_secret "$HOME/.config/kanbanzone/config.json" "$KZ_CONFIG_JSON"
  else
    echo -e "  ${YELLOW}Note:${NC} set KZ_API_KEY or write ~/.config/kanbanzone/config.json before using the skill"
  fi
  echo -e "  ${GREEN}Created${NC} skills/kanbanzone/"
fi

# WordPress skill
if [ "${ENABLE_WORDPRESS:-false}" = true ]; then
  cp -r "${TEMPLATE_DIR}/skills/wordpress" skills/
  sed -i '' \
    -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
    -e "s|{{WP_SITE_URL}}|${WP_SITE_URL}|g" \
    -e "s|{{WP_USERNAME}}|${WP_USERNAME}|g" \
    -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
    skills/wordpress/SKILL.md 2>/dev/null || true
  sed -i '' \
    -e "s|{{WP_SITE_URL}}|${WP_SITE_URL}|g" \
    -e "s|{{WP_USERNAME}}|${WP_USERNAME}|g" \
    -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
    skills/wordpress/manifest.json 2>/dev/null || true
  sed -i '' \
    -e "s|{{WP_SITE_URL}}|${WP_SITE_URL}|g" \
    -e "s|{{WP_USERNAME}}|${WP_USERNAME}|g" \
    skills/wordpress/wp-api.sh 2>/dev/null || true
  chmod +x skills/wordpress/wp-api.sh
  if [ -n "$WP_APP_PASSWORD" ]; then
    write_secret "$HOME/.config/wordpress/app_password" "$WP_APP_PASSWORD"
  else
    echo -e "  ${YELLOW}Note:${NC} write your WP Application Password to ~/.config/wordpress/app_password before using the skill"
  fi
  echo -e "  ${GREEN}Created${NC} skills/wordpress/"
fi

# Create .env template
if [ ! -f .env ]; then
  cat > .env << ENVEOF
# AI Assistant Configuration
# Generated by setup.sh

# Platform credentials (fill in after creating your bot)
ENVEOF

  case $PLATFORM in
    "Telegram")
      cat >> .env << ENVEOF
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=
ENVEOF
      ;;
    "Slack")
      cat >> .env << ENVEOF
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_ALLOWED_USERS=
ENVEOF
      ;;
    "Discord")
      cat >> .env << ENVEOF
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USERS=
ENVEOF
      ;;
    "Teams")
      cat >> .env << ENVEOF
TEAMS_APP_ID=
TEAMS_APP_SECRET=
TEAMS_TENANT_ID=
ENVEOF
      ;;
  esac

  if [ -n "${WORDSMITH_GOOGLE_API_KEY:-}" ]; then
    printf '\n# Wordsmith (Gemini)\nGOOGLE_API_KEY=%s\n' "$WORDSMITH_GOOGLE_API_KEY" >> .env
  elif [ "${ENABLE_WORDSMITH:-false}" = true ]; then
    printf '\n# Wordsmith (Gemini) — fill in before using\nGOOGLE_API_KEY=\n' >> .env
  fi

  echo -e "  ${GREEN}Created${NC} .env (fill in your credentials)"
fi

# Create projects folder
mkdir -p projects
echo -e "  ${GREEN}Created${NC} projects/"

# Create store folder
mkdir -p store
echo -e "  ${GREEN}Created${NC} store/"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Fill in your bot credentials in .env"
echo "     (See SETUP-GUIDE.md for platform-specific instructions)"
echo ""

if [[ ", $INSTALLED_SKILLS, " == *", gmail, "* ]]; then
  echo "  2. Authenticate Gmail:"
  echo "     brew install gogcli"
  echo "     gog auth add ${GMAIL_ADDR:-$EMAIL_ADDRESS} --services gmail,calendar"
  if [[ ", $INSTALLED_SKILLS, " == *", gmail-secondary, "* ]] && [ -n "${GMAIL_ADDRESS_2:-}" ]; then
    echo "     gog auth add ${GMAIL_ADDRESS_2} --services gmail,calendar"
  fi
  echo ""
fi

if [[ ", $INSTALLED_SKILLS, " == *", outlook, "* ]]; then
  echo "  2. Set up Microsoft 365 credentials in .env"
  echo "     (See SETUP-GUIDE.md > Outlook Setup)"
  if [[ ", $INSTALLED_SKILLS, " == *", outlook-secondary, "* ]] && [ -n "${OUTLOOK_ADDRESS_2:-}" ]; then
    echo "     A second Outlook account ($OUTLOOK_ADDRESS_2) is configured as outlook-secondary"
  fi
  echo ""
fi

echo "  3. Install and build:"
echo "     npm install && npm run build"
echo ""
echo "  4. Test locally:"
echo "     node dist/src/index.js"
echo ""
echo "  5. Set up as a persistent service:"
echo "     (See SETUP-GUIDE.md > Step 6)"
echo ""
echo "  6. Message your bot and say hello!"
echo ""
