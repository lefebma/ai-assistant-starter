#!/usr/bin/env python3
"""Generate AI Assistant User Manual PDF with ELS Partners branding."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    KeepTogether, HRFlowable
)
from reportlab.platypus.flowables import Flowable
import os

# ── ELS Brand Colors ──
ELS_NAVY = HexColor("#1a2744")
ELS_BLUE = HexColor("#2563eb")
ELS_LIGHT_BLUE = HexColor("#dbeafe")
ELS_ACCENT = HexColor("#3b82f6")
ELS_GRAY = HexColor("#64748b")
ELS_LIGHT_GRAY = HexColor("#f1f5f9")
ELS_DARK = HexColor("#0f172a")
ELS_WHITE = white
TEXT_COLOR = HexColor("#1e293b")
MUTED = HexColor("#475569")

WIDTH, HEIGHT = letter
MARGIN = 0.75 * inch

# ── Custom Flowables ──

class ColorBar(Flowable):
    """A colored bar across the page."""
    def __init__(self, width, height, color):
        Flowable.__init__(self)
        self.width = width
        self.height = height
        self.color = color

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.rect(0, 0, self.width, self.height, fill=1, stroke=0)


class RoundedBox(Flowable):
    """A rounded rectangle with text inside."""
    def __init__(self, width, height, text, bg_color, text_color=white, font_size=11):
        Flowable.__init__(self)
        self.width = width
        self.height = height
        self.text = text
        self.bg_color = bg_color
        self.text_color = text_color
        self.font_size = font_size

    def draw(self):
        self.canv.setFillColor(self.bg_color)
        self.canv.roundRect(0, 0, self.width, self.height, 6, fill=1, stroke=0)
        self.canv.setFillColor(self.text_color)
        self.canv.setFont("Helvetica-Bold", self.font_size)
        self.canv.drawCentredString(self.width / 2, self.height / 2 - 4, self.text)


# ── Styles ──

def make_styles():
    s = {}
    s['title'] = ParagraphStyle('Title', fontName='Helvetica-Bold', fontSize=32,
                                 leading=38, textColor=ELS_NAVY, alignment=TA_LEFT,
                                 spaceAfter=6)
    s['subtitle'] = ParagraphStyle('Subtitle', fontName='Helvetica', fontSize=14,
                                    leading=20, textColor=ELS_GRAY, alignment=TA_LEFT,
                                    spaceAfter=20)
    s['h1'] = ParagraphStyle('H1', fontName='Helvetica-Bold', fontSize=22,
                              leading=28, textColor=ELS_NAVY, spaceBefore=20, spaceAfter=10)
    s['h2'] = ParagraphStyle('H2', fontName='Helvetica-Bold', fontSize=16,
                              leading=22, textColor=ELS_BLUE, spaceBefore=14, spaceAfter=8)
    s['h3'] = ParagraphStyle('H3', fontName='Helvetica-Bold', fontSize=13,
                              leading=18, textColor=ELS_DARK, spaceBefore=10, spaceAfter=6)
    s['body'] = ParagraphStyle('Body', fontName='Helvetica', fontSize=11,
                                leading=16, textColor=TEXT_COLOR, spaceAfter=8)
    s['body_indent'] = ParagraphStyle('BodyIndent', fontName='Helvetica', fontSize=11,
                                       leading=16, textColor=TEXT_COLOR, spaceAfter=6,
                                       leftIndent=20)
    s['bullet'] = ParagraphStyle('Bullet', fontName='Helvetica', fontSize=11,
                                  leading=16, textColor=TEXT_COLOR, spaceAfter=4,
                                  leftIndent=20, bulletIndent=8, bulletFontSize=11)
    s['code'] = ParagraphStyle('Code', fontName='Courier', fontSize=9.5,
                                leading=14, textColor=HexColor("#1e40af"),
                                backColor=ELS_LIGHT_GRAY, spaceAfter=8,
                                leftIndent=16, rightIndent=16,
                                borderPadding=(8, 8, 8, 8))
    s['note'] = ParagraphStyle('Note', fontName='Helvetica-Oblique', fontSize=10,
                                leading=15, textColor=ELS_GRAY, spaceAfter=8,
                                leftIndent=20, rightIndent=20)
    s['footer'] = ParagraphStyle('Footer', fontName='Helvetica', fontSize=8,
                                  leading=10, textColor=ELS_GRAY, alignment=TA_CENTER)
    s['toc'] = ParagraphStyle('TOC', fontName='Helvetica', fontSize=12,
                               leading=22, textColor=ELS_NAVY, leftIndent=10)
    s['toc_sub'] = ParagraphStyle('TOCSub', fontName='Helvetica', fontSize=11,
                                   leading=20, textColor=MUTED, leftIndent=30)
    return s


# ── Page Templates ──

def cover_page_template(canvas, doc):
    canvas.saveState()
    # Navy header band
    canvas.setFillColor(ELS_NAVY)
    canvas.rect(0, HEIGHT - 2.5 * inch, WIDTH, 2.5 * inch, fill=1, stroke=0)
    # Blue accent stripe
    canvas.setFillColor(ELS_BLUE)
    canvas.rect(0, HEIGHT - 2.55 * inch, WIDTH, 0.05 * inch, fill=1, stroke=0)
    # ELS Partners logo text
    canvas.setFillColor(ELS_WHITE)
    canvas.setFont("Helvetica-Bold", 18)
    canvas.drawString(MARGIN, HEIGHT - 1.2 * inch, "ELS PARTNERS")
    canvas.setFont("Helvetica", 11)
    canvas.drawString(MARGIN, HEIGHT - 1.5 * inch, "Agile Transformation  |  AI Automation")
    # Footer
    canvas.setFillColor(ELS_GRAY)
    canvas.setFont("Helvetica", 9)
    canvas.drawCentredString(WIDTH / 2, 0.5 * inch, "els-partners.com  |  marc.l@els-partners.com  |  (647) 407-9473")
    canvas.restoreState()


def normal_page_template(canvas, doc):
    canvas.saveState()
    # Top accent bar
    canvas.setFillColor(ELS_NAVY)
    canvas.rect(0, HEIGHT - 0.35 * inch, WIDTH, 0.35 * inch, fill=1, stroke=0)
    canvas.setFillColor(ELS_WHITE)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN, HEIGHT - 0.24 * inch, "AI Assistant  |  User Manual")
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(WIDTH - MARGIN, HEIGHT - 0.24 * inch, "ELS Partners")
    # Bottom bar
    canvas.setFillColor(ELS_BLUE)
    canvas.rect(0, 0, WIDTH, 0.06 * inch, fill=1, stroke=0)
    # Page number
    canvas.setFillColor(ELS_GRAY)
    canvas.setFont("Helvetica", 9)
    canvas.drawCentredString(WIDTH / 2, 0.25 * inch, f"Page {doc.page}")
    canvas.restoreState()


# ── Content Builders ──

def build_cover(story, S):
    story.append(Spacer(1, 2.8 * inch))
    story.append(Paragraph("AI Assistant", S['title']))
    story.append(Paragraph("User Manual", ParagraphStyle('TitleLine2',
        fontName='Helvetica', fontSize=28, leading=34, textColor=ELS_BLUE, spaceAfter=12)))
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="40%", thickness=2, color=ELS_BLUE,
                             spaceAfter=16, hAlign='LEFT'))
    story.append(Paragraph(
        "Your personal AI assistant powered by Claude Code. "
        "This guide covers installation, daily usage, commands, skills, "
        "scheduled tasks, and troubleshooting.",
        S['body']))
    story.append(Spacer(1, 30))
    # Info box
    info_data = [
        ["Version", "1.0"],
        ["Date", "May 2026"],
        ["Platform", "macOS"],
        ["Prepared by", "ELS Partners"],
    ]
    info_table = Table(info_data, colWidths=[1.4 * inch, 3 * inch])
    info_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 11),
        ('TEXTCOLOR', (0, 0), (0, -1), ELS_NAVY),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, ELS_LIGHT_BLUE),
    ]))
    story.append(info_table)
    story.append(PageBreak())


def build_toc(story, S):
    story.append(Paragraph("Contents", S['h1']))
    story.append(Spacer(1, 10))
    toc_items = [
        ("1.", "What Is Your AI Assistant?"),
        ("2.", "Installation"),
        ("3.", "Getting Started"),
        ("4.", "Commands Reference"),
        ("5.", "Skills System"),
        ("6.", "Scheduled Tasks"),
        ("7.", "Email & Calendar"),
        ("8.", "Customizing Your Assistant"),
        ("9.", "Troubleshooting"),
        ("10.", "Support"),
    ]
    for num, title in toc_items:
        story.append(Paragraph(f"<b>{num}</b>  {title}", S['toc']))
    story.append(PageBreak())


def build_section_1(story, S):
    story.append(Paragraph("1. What Is Your AI Assistant?", S['h1']))
    story.append(Paragraph(
        "Your AI assistant is a personal digital helper that lives on your computer and connects "
        "to your phone via Telegram (or Slack, Discord, Teams). It can:",
        S['body']))
    features = [
        "Answer questions and carry out tasks using natural language",
        "Read and summarize your email (Gmail, Outlook, or both)",
        "Check your calendar and create events",
        "Run scheduled tasks automatically (morning briefings, reminders)",
        "Learn new capabilities through a drop-in skills system",
        "Process voice messages and respond with voice",
        "Automate web tasks using browser control",
        "Remember context across conversations",
    ]
    for f in features:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{f}", S['bullet']))
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "The assistant runs as a persistent background service on your Mac. You interact with it "
        "by messaging your Telegram bot, just like texting a person. It uses Anthropic's Claude AI "
        "to understand your requests and take action.",
        S['body']))
    story.append(Paragraph(
        "Think of it as a smart intern who is always online, never forgets, and gets better "
        "the more you use it.",
        S['note']))


def build_section_2(story, S):
    story.append(PageBreak())
    story.append(Paragraph("2. Installation", S['h1']))
    story.append(Paragraph(
        "Installation takes about 15-20 minutes. You will need your Mac, an internet connection, "
        "and a Telegram account on your phone.",
        S['body']))

    story.append(Paragraph("Step 1: Install Homebrew", S['h2']))
    story.append(Paragraph(
        "Homebrew is a package manager for macOS that makes it easy to install developer tools. "
        "Open <b>Terminal</b> (search for it in Spotlight with Cmd+Space) and paste:",
        S['body']))
    story.append(Paragraph(
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        S['code']))
    story.append(Paragraph(
        "Follow the on-screen instructions. When it finishes, it may tell you to run two commands "
        "to add brew to your PATH. Run those commands, then close and reopen Terminal.",
        S['body']))

    story.append(Paragraph("Step 2: Install Node.js and Claude Code", S['h2']))
    story.append(Paragraph("brew install node", S['code']))
    story.append(Paragraph("npm install -g @anthropic-ai/claude-code", S['code']))

    story.append(Paragraph("Step 3: Download the Project", S['h2']))
    story.append(Paragraph(
        "Download from GitHub (no account needed), unzip, and run setup:",
        S['body']))
    story.append(Paragraph(
        "curl -L https://github.com/lefebma/ai-assistant-starter/archive/refs/heads/main.zip -o assistant.zip\n"
        "unzip assistant.zip\n"
        "mv ai-assistant-starter-main my-assistant\n"
        "cd my-assistant\n"
        "npm install\n"
        "npm run setup",
        S['code']))
    story.append(Paragraph(
        "The setup wizard will ask your name, your assistant's name, your city, and walk you "
        "through creating a Telegram bot.",
        S['body']))

    story.append(Paragraph("Step 4: Create Your Telegram Bot", S['h2']))
    steps = [
        "Open Telegram on your phone, search for <b>@BotFather</b>",
        "Send <b>/newbot</b> and follow the prompts to name your bot",
        "Copy the token BotFather gives you (the setup wizard will ask for it)",
        "After setup, message your bot and send <b>/chatid</b>",
        "Open <b>.env</b> in TextEdit and paste your chat ID into ALLOWED_CHAT_ID",
    ]
    for i, step in enumerate(steps, 1):
        story.append(Paragraph(f"<bullet>{i}.</bullet>{step}", S['bullet']))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "To open .env in TextEdit from Terminal:",
        S['body']))
    story.append(Paragraph("open -a TextEdit .env", S['code']))

    story.append(Paragraph("Step 5: Run", S['h2']))
    story.append(Paragraph("npm start", S['code']))
    story.append(Paragraph(
        "Message your bot on Telegram. If it replies, you are live.",
        S['body']))


def build_section_3(story, S):
    story.append(PageBreak())
    story.append(Paragraph("3. Getting Started", S['h1']))
    story.append(Paragraph(
        "Once your assistant is running, try these first messages to verify everything works:",
        S['body']))

    tests = [
        ("<b>\"Hello\"</b> - Verify the assistant responds with its configured personality",),
        ("<b>\"What's the weather?\"</b> - Test the weather skill (if configured)",),
        ("<b>\"Check my email\"</b> - Test email integration (if connected)",),
        ("<b>\"What time is it?\"</b> - Verify timezone is set correctly",),
    ]
    for t in tests:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{t[0]}", S['bullet']))

    story.append(Spacer(1, 10))
    story.append(Paragraph("Tips for Talking to Your Assistant", S['h2']))
    tips = [
        "Talk naturally, like you would to a person. No special syntax needed.",
        "Be specific about what you want. \"Check my email for anything from the bank\" works better than \"check email.\"",
        "You can send voice messages. The assistant will transcribe and respond.",
        "Your assistant remembers previous conversations. You can refer back to earlier topics.",
        "If the assistant misunderstands, just clarify. It learns from corrections.",
    ]
    for tip in tips:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{tip}", S['bullet']))


def build_section_4(story, S):
    story.append(PageBreak())
    story.append(Paragraph("4. Commands Reference", S['h1']))
    story.append(Paragraph(
        "These slash commands are available in addition to natural language:",
        S['body']))

    commands = [
        ["/help", "Show available commands and features"],
        ["/newchat", "Start a fresh conversation (clears context)"],
        ["/chatid", "Display your Telegram chat ID"],
        ["/memory", "View what the assistant remembers about you"],
        ["/voice on|off", "Toggle voice responses on/off"],
        ["/skill list", "Show all installed skills"],
        ["/skill reload", "Reload skills after adding new ones"],
        ["/skill enable <id>", "Enable a disabled skill"],
        ["/skill disable <id>", "Disable a skill"],
        ["/schedule create", "Create a scheduled task (see Section 6)"],
        ["/schedule list", "List all scheduled tasks"],
        ["/schedule pause <id>", "Pause a scheduled task"],
        ["/schedule resume <id>", "Resume a paused task"],
        ["/schedule delete <id>", "Delete a scheduled task"],
    ]

    cmd_table = Table(commands, colWidths=[2.2 * inch, 4.3 * inch])
    cmd_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Courier'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('TEXTCOLOR', (0, 0), (0, -1), ELS_BLUE),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, ELS_LIGHT_BLUE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    story.append(cmd_table)


def build_section_5(story, S):
    story.append(PageBreak())
    story.append(Paragraph("5. Skills System", S['h1']))
    story.append(Paragraph(
        "Skills are drop-in modules that give your assistant new capabilities. Each skill is a "
        "folder inside the <font face='Courier' color='#1e40af'>skills/</font> directory containing two files:",
        S['body']))

    skill_files = [
        ["manifest.json", "Defines triggers (keywords), priority, and enabled/disabled state"],
        ["SKILL.md", "Instructions the AI follows when this skill activates"],
    ]
    sf_table = Table(skill_files, colWidths=[1.8 * inch, 4.7 * inch])
    sf_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Courier'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 11),
        ('TEXTCOLOR', (0, 0), (0, -1), ELS_BLUE),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, ELS_LIGHT_BLUE),
    ]))
    story.append(sf_table)

    story.append(Spacer(1, 10))
    story.append(Paragraph("Adding a New Skill", S['h2']))
    steps = [
        "Create a new folder inside <font face='Courier'>skills/</font> (e.g., <font face='Courier'>skills/my-skill/</font>)",
        "Add a <font face='Courier'>manifest.json</font> with trigger keywords",
        "Add a <font face='Courier'>SKILL.md</font> with instructions for the AI",
        "Tell your bot <font face='Courier'>/skill reload</font> to pick it up",
    ]
    for i, step in enumerate(steps, 1):
        story.append(Paragraph(f"<bullet>{i}.</bullet>{step}", S['bullet']))

    story.append(Spacer(1, 10))
    story.append(Paragraph("Example manifest.json", S['h3']))
    story.append(Paragraph(
        '{\n'
        '  "id": "weather",\n'
        '  "name": "Weather",\n'
        '  "triggers": ["weather", "forecast", "temperature"],\n'
        '  "priority": 10,\n'
        '  "enabled": true\n'
        '}',
        S['code']))

    story.append(Paragraph("Common Skills", S['h2']))
    common = [
        ["Weather", "Current conditions and forecasts for your city"],
        ["Gmail", "Read, search, and draft emails via Gmail"],
        ["Outlook", "Read and manage Outlook/Microsoft 365 email"],
        ["Calendar", "View and create calendar events"],
        ["CRM", "Customer relationship management integration"],
        ["Project Tracking", "Track project status and tasks"],
    ]
    cs_table = Table(common, colWidths=[1.8 * inch, 4.7 * inch])
    cs_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 11),
        ('TEXTCOLOR', (0, 0), (0, -1), ELS_NAVY),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, ELS_LIGHT_BLUE),
    ]))
    story.append(cs_table)


def build_section_6(story, S):
    story.append(PageBreak())
    story.append(Paragraph("6. Scheduled Tasks", S['h1']))
    story.append(Paragraph(
        "Your assistant can run tasks automatically on a schedule. This is useful for morning "
        "briefings, periodic email checks, reminders, and monitoring.",
        S['body']))

    story.append(Paragraph("Creating a Scheduled Task", S['h2']))
    story.append(Paragraph(
        '/schedule create "Your prompt here" "cron expression" --name "Task Name"',
        S['code']))

    story.append(Paragraph("Cron Expression Quick Reference", S['h2']))
    cron_examples = [
        ["0 7 * * *", "Every day at 7:00 AM"],
        ["0 9 * * 1", "Every Monday at 9:00 AM"],
        ["0 */4 * * *", "Every 4 hours"],
        ["*/30 * * * *", "Every 30 minutes"],
        ["0 18 * * 1-5", "Weekdays at 6:00 PM"],
        ["0 9,17 * * *", "Twice daily at 9 AM and 5 PM"],
    ]
    cron_table = Table(
        [["Expression", "Meaning"]] + cron_examples,
        colWidths=[2.2 * inch, 4.3 * inch]
    )
    cron_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (0, -1), 'Courier'),
        ('FONTNAME', (1, 1), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('TEXTCOLOR', (0, 0), (-1, 0), ELS_WHITE),
        ('BACKGROUND', (0, 0), (-1, 0), ELS_NAVY),
        ('TEXTCOLOR', (0, 1), (0, -1), ELS_BLUE),
        ('TEXTCOLOR', (1, 1), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 1), (-1, -1), 0.5, ELS_LIGHT_BLUE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    story.append(cron_table)

    story.append(Spacer(1, 10))
    story.append(Paragraph("Example: Morning Briefing", S['h2']))
    story.append(Paragraph(
        '/schedule create "Morning briefing: weather, calendar, urgent emails" "0 7 * * *" --name "Morning Briefing"',
        S['code']))
    story.append(Paragraph(
        "This creates a task that runs every morning at 7 AM. The assistant will check the weather, "
        "your calendar, and any urgent emails, then send you a summary on Telegram.",
        S['body']))

    story.append(Paragraph("Adding --silent Flag", S['h3']))
    story.append(Paragraph(
        "Add <font face='Courier'>--silent</font> to suppress output when there is nothing to report. "
        "The task still runs, but only messages you if something actionable is found.",
        S['body']))


def build_section_7(story, S):
    story.append(PageBreak())
    story.append(Paragraph("7. Email & Calendar", S['h1']))
    story.append(Paragraph(
        "Your assistant can connect to Gmail, Outlook, or both. Email setup requires creating "
        "API credentials and adding them to your <font face='Courier'>.env</font> file.",
        S['body']))

    story.append(Paragraph("Gmail Setup", S['h2']))
    gmail_steps = [
        "Go to the Google Cloud Console and create a project",
        "Enable the Gmail API",
        "Create OAuth 2.0 credentials (Desktop app type)",
        "Download the credentials JSON file",
        "Add the credentials path to your .env file",
        "Run the authentication flow when prompted",
    ]
    for i, step in enumerate(gmail_steps, 1):
        story.append(Paragraph(f"<bullet>{i}.</bullet>{step}", S['bullet']))

    story.append(Paragraph("Outlook Setup", S['h2']))
    outlook_steps = [
        "Register an app in Azure Active Directory",
        "Add Mail.Read and Calendars.Read permissions",
        "Use device code flow for authentication",
        "Add the client ID to your .env file",
    ]
    for i, step in enumerate(outlook_steps, 1):
        story.append(Paragraph(f"<bullet>{i}.</bullet>{step}", S['bullet']))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Detailed setup instructions for both providers are in "
        "<font face='Courier'>docs/SETUP-GUIDE.md</font> inside your project folder.",
        S['note']))

    story.append(Paragraph("What You Can Do", S['h2']))
    email_features = [
        "\"Check my email\" - Get a summary of recent messages",
        "\"Any emails from John?\" - Search by sender",
        "\"Draft a reply to that last email\" - Compose responses",
        "\"What's on my calendar today?\" - View upcoming events",
        "\"Schedule a meeting for Friday at 2pm\" - Create events",
    ]
    for f in email_features:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{f}", S['bullet']))


def build_section_8(story, S):
    story.append(PageBreak())
    story.append(Paragraph("8. Customizing Your Assistant", S['h1']))
    story.append(Paragraph(
        "Your assistant's personality, rules, and context are defined in "
        "<font face='Courier'>CLAUDE.md</font> at the root of your project. This is a Markdown "
        "file that the AI reads at the start of every conversation.",
        S['body']))

    story.append(Paragraph("What You Can Customize", S['h2']))
    customs = [
        ("<b>Name</b> - Give your assistant a unique name",),
        ("<b>Personality</b> - Define tone, style, and communication preferences",),
        ("<b>Rules</b> - Set boundaries (e.g., always ask before sending emails)",),
        ("<b>Your info</b> - Name, timezone, role, preferences",),
        ("<b>Context</b> - Background info the assistant should always know",),
    ]
    for c in customs:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{c[0]}", S['bullet']))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Edit CLAUDE.md with any text editor. Changes take effect on the next conversation "
        "(or after <font face='Courier'>/newchat</font>).",
        S['body']))

    story.append(Paragraph("Project Structure", S['h2']))
    structure = [
        ["CLAUDE.md", "Assistant personality, rules, and context"],
        [".env", "API keys and credentials (never shared)"],
        ["skills/", "Drop-in skill folders"],
        ["projects/", "Project state tracking (STATE.md files)"],
        ["src/", "Engine source code (TypeScript)"],
        ["store/", "SQLite database (auto-created)"],
    ]
    st_table = Table(structure, colWidths=[2 * inch, 4.5 * inch])
    st_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Courier'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 11),
        ('TEXTCOLOR', (0, 0), (0, -1), ELS_BLUE),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, ELS_LIGHT_BLUE),
    ]))
    story.append(st_table)


def build_section_9(story, S):
    story.append(PageBreak())
    story.append(Paragraph("9. Troubleshooting", S['h1']))

    problems = [
        ("Bot does not respond",
         "Make sure the service is running (<font face='Courier'>npm start</font>). "
         "Check that your ALLOWED_CHAT_ID in .env matches your Telegram chat ID. "
         "Try <font face='Courier'>/chatid</font> to verify."),
        ("\"Command not found\" errors",
         "Close and reopen Terminal. If brew was just installed, you may need to add it to your PATH. "
         "The installer usually prints the commands to do this."),
        ("Email integration not working",
         "Verify your API credentials in .env. Try re-running the authentication flow. "
         "Check that the required API scopes are enabled in your Google/Azure console."),
        ("Skills not loading",
         "Run <font face='Courier'>/skill reload</font>. Check that your skill folder has both "
         "<font face='Courier'>manifest.json</font> and <font face='Courier'>SKILL.md</font>. "
         "Verify the manifest JSON is valid."),
        ("Scheduled tasks not firing",
         "Check <font face='Courier'>/schedule list</font> to verify the task exists and is not paused. "
         "Make sure your Mac is not in sleep mode at the scheduled time."),
        ("Voice messages not working",
         "Voice support requires additional configuration. Check that your .env has the required "
         "voice API credentials."),
        ("\"Permission denied\" errors",
         "You may need to grant Terminal access to your files in System Preferences > "
         "Security & Privacy > Privacy > Full Disk Access."),
    ]

    for title, solution in problems:
        story.append(Paragraph(title, S['h3']))
        story.append(Paragraph(solution, S['body_indent']))
        story.append(Spacer(1, 4))


def build_section_10(story, S):
    story.append(PageBreak())
    story.append(Paragraph("10. Support", S['h1']))
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "Setup assistance and custom skill development are available from ELS Partners.",
        S['body']))
    story.append(Spacer(1, 16))

    # Contact card
    contact_data = [
        ["", ""],
        ["Marc Lefebvre", ""],
        ["Principal Consultant", ""],
        ["", ""],
        ["Phone", "(647) 407-9473"],
        ["Email", "marc.l@els-partners.com"],
        ["Web", "www.els-partners.com"],
        ["", ""],
    ]
    contact_table = Table(contact_data, colWidths=[1.6 * inch, 3.5 * inch])
    contact_table.setStyle(TableStyle([
        ('FONTNAME', (0, 1), (-1, 1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 1), (-1, 1), 16),
        ('TEXTCOLOR', (0, 1), (-1, 1), ELS_NAVY),
        ('FONTNAME', (0, 2), (-1, 2), 'Helvetica'),
        ('FONTSIZE', (0, 2), (-1, 2), 12),
        ('TEXTCOLOR', (0, 2), (-1, 2), ELS_GRAY),
        ('FONTNAME', (0, 4), (0, -2), 'Helvetica-Bold'),
        ('FONTNAME', (1, 4), (1, -2), 'Helvetica'),
        ('FONTSIZE', (0, 4), (-1, -2), 11),
        ('TEXTCOLOR', (0, 4), (0, -2), ELS_NAVY),
        ('TEXTCOLOR', (1, 4), (1, -2), TEXT_COLOR),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('SPAN', (0, 1), (1, 1)),
        ('SPAN', (0, 2), (1, 2)),
        ('LINEBELOW', (0, 2), (-1, 2), 1, ELS_BLUE),
        ('LINEBELOW', (0, 4), (-1, -2), 0.5, ELS_LIGHT_BLUE),
        ('BOX', (0, 0), (-1, -1), 1, ELS_LIGHT_BLUE),
        ('BACKGROUND', (0, 0), (-1, -1), ELS_LIGHT_GRAY),
    ]))
    story.append(contact_table)

    story.append(Spacer(1, 30))
    story.append(Paragraph("Services We Offer", S['h2']))
    services = [
        "<b>Initial Setup</b> - Complete installation and configuration on your Mac",
        "<b>Custom Skills</b> - Build integrations specific to your business tools",
        "<b>Training</b> - Learn how to get the most from your assistant",
        "<b>Ongoing Support</b> - Updates, troubleshooting, and enhancements",
        "<b>AI Automation Consulting</b> - Broader AI strategy for your business",
    ]
    for svc in services:
        story.append(Paragraph(f"<bullet>&bull;</bullet>{svc}", S['bullet']))


# ── Main ──

def main():
    output_path = os.path.join(os.path.dirname(__file__), "AI-Assistant-User-Manual.pdf")

    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=1.0 * inch,
        bottomMargin=0.75 * inch,
    )

    S = make_styles()
    story = []

    build_cover(story, S)
    build_toc(story, S)
    build_section_1(story, S)
    build_section_2(story, S)
    build_section_3(story, S)
    build_section_4(story, S)
    build_section_5(story, S)
    build_section_6(story, S)
    build_section_7(story, S)
    build_section_8(story, S)
    build_section_9(story, S)
    build_section_10(story, S)

    doc.build(
        story,
        onFirstPage=cover_page_template,
        onLaterPages=normal_page_template,
    )
    print(f"PDF generated: {output_path}")


if __name__ == "__main__":
    main()
