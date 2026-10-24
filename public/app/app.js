// The web app. Plain DOM, no framework. Untrusted text only reaches the page
// through textContent or renderMarkdown (which escapes first).

import * as api from './api.js'
import { renderMarkdown } from './markdown.js'

const $ = (id) => document.getElementById(id)

// Trusted, constant icon markup.
const ICON = {
  caret: '<svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
  clip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
}

/** Build an element. attrs never include style or on* (CSP and the static test forbid them). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'icon') el.insertAdjacentHTML('afterbegin', ICON[v])
    else if (k === 'click') el.addEventListener('click', v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) if (c != null) el.append(c)
  return el
}

const state = {
  me: null,
  projects: [],
  conversations: [],
  expanded: new Set(['']),
  current: null, // conversation object
  messages: [],
  running: null, // conversation id with a turn streaming from this page
  goals: { goals: [], version: 'none' },
  status: null,
  treeLoaded: false,
  previewPath: '',
}

const MODEL_LABEL = { '': 'Default', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const narrow = window.matchMedia('(max-width: 899.98px)')

// ---------- small helpers ----------

function show(el, on = true) {
  el.hidden = !on
}

function note(el, text) {
  el.textContent = text || ''
  show(el, Boolean(text))
}

function friendly(err, fallback = 'Something went wrong. Try again.') {
  if (!err || err.status === 401) return ''
  if (err.status === 413) return 'That is too large.'
  if (err.status === 404) return 'That is no longer there.'
  if (err.status === 409) return 'That changed somewhere else. Showing the latest.'
  if (err.status === 429) return 'Too many tries. Wait a few minutes.'
  if (err instanceof TypeError) return 'Cannot reach your assistant. Check your connection.'
  return fallback
}

function relTime(ms) {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return min + ' min ago'
  const hrs = Math.round(min / 60)
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago')
  const days = Math.round(hrs / 24)
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago')
  return new Date(ms).toLocaleDateString()
}

function projectName(id) {
  if (!id) return 'General'
  const p = state.projects.find((x) => x.id === id)
  return p ? p.name : 'General'
}

/** Hide file and button markers while a reply is still streaming in. */
function stripMarkers(text) {
  return text.replace(/\[\[[a-z]+:[^\]]*(\]\])?/gi, '').replace(/\[\[?$/, '')
}

// ---------- sign-in ----------

function showSignedOut(message) {
  show($('boot'), false)
  show($('app'), false)
  if ($('settings').open) $('settings').close()
  note($('signin-note'), message)
  show($('signin'))
  document.title = 'Sign in'
}

api.setSignedOutHandler(() => showSignedOut(''))

async function boot() {
  const hash = location.hash || ''
  const m = hash.match(/(?:^#|&)token=([^&]+)/)
  if (m) {
    // Clear the fragment before anything else so the token is not left in history.
    history.replaceState(null, '', location.pathname + location.search)
    state.me = null
    let ok = false
    try {
      ok = await api.exchange(decodeURIComponent(m[1]))
    } catch {
      ok = false
    }
    if (!ok) {
      // A link that already worked once may still have left a valid session.
      try {
        state.me = await api.get('/api/web/me')
      } catch {
        showSignedOut('That link has expired or was already used. Ask for a new one.')
        return
      }
    }
  }
  try {
    state.me = state.me || (await api.get('/api/web/me'))
  } catch (err) {
    if (err.status !== 401) showSignedOut('Cannot reach your assistant right now.')
    return
  }
  start()
}

async function start() {
  const name = state.me.assistantName || 'Assistant'
  $('brand-name').textContent = name
  document.title = name
  $('input').placeholder = 'Message ' + name
  show($('boot'), false)
  show($('signin'), false)
  show($('app'))
  renderMessages()
  if (!narrow.matches && window.innerWidth >= 1280) setFilesOpen(true)
  await Promise.all([loadProjects(), loadGoals(), loadStatus()])
  $('input').focus()
}

// ---------- drawers and files panel ----------

function closeDrawers() {
  $('left').classList.remove('open')
  $('right').classList.remove('open')
  show($('scrim'), false)
}

function openDrawer(which) {
  closeDrawers()
  $(which).classList.add('open')
  show($('scrim'))
  if (which === 'right') ensureTree()
}

function setFilesOpen(open) {
  $('app').classList.toggle('files-open', open)
  $('open-right').setAttribute('aria-pressed', String(open))
  if (open) ensureTree()
}

$('open-left').addEventListener('click', () => openDrawer('left'))
$('open-right').addEventListener('click', () => {
  if (narrow.matches) openDrawer('right')
  else setFilesOpen(!$('app').classList.contains('files-open'))
})
$('scrim').addEventListener('click', closeDrawers)
for (const b of document.querySelectorAll('[data-close-drawer]')) b.addEventListener('click', closeDrawers)
narrow.addEventListener('change', closeDrawers)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('scrim').hidden) closeDrawers()
})

// ---------- projects and chats ----------

async function loadProjects() {
  try {
    const [projects, convs] = await Promise.all([api.get('/api/web/projects'), api.get('/api/web/conversations')])
    state.projects = Array.isArray(projects) ? projects : []
    state.conversations = (convs && convs.conversations) || []
  } catch (err) {
    if (err.status === 401) return
  }
  renderProjects()
}

async function refreshConversations() {
  try {
    const convs = await api.get('/api/web/conversations')
    state.conversations = (convs && convs.conversations) || []
    const fresh = state.current && state.conversations.find((c) => c.id === state.current.id)
    if (fresh) {
      Object.assign(state.current, fresh)
      if (document.activeElement !== $('chat-title')) $('chat-title').value = fresh.title || ''
    }
    renderProjects()
  } catch {
    // keep the list we have
  }
}

function renderProjects() {
  const list = $('projects')
  list.replaceChildren()
  const known = new Set(state.projects.map((p) => p.id))
  for (const p of state.projects) {
    const open = state.expanded.has(p.id)
    const chats = state.conversations.filter((c) => c.projectId === p.id || (p.id === '' && !known.has(c.projectId)))
    const meta = [p.company, p.status].filter(Boolean).join(' \u00b7 ')
    const item = h('li', { class: 'project' + (open ? ' open' : '') })
    const toggle = h(
      'button',
      { type: 'button', class: 'project-toggle', 'aria-expanded': String(open), icon: 'caret', click: () => toggleProject(p.id) },
      h('span', { class: 'project-text' }, h('span', { class: 'project-name', text: p.name }), meta ? h('span', { class: 'project-meta', text: meta }) : null)
    )
    const add = h('button', {
      type: 'button',
      class: 'icon-btn project-new',
      title: 'New chat in ' + p.name,
      'aria-label': 'New chat in ' + p.name,
      icon: 'plus',
      click: () => newChat(p.id),
    })
    item.append(h('div', { class: 'project-row' }, toggle, add))
    if (open) {
      const ul = h('ul', { class: 'chat-list' })
      if (!chats.length) ul.append(h('li', { class: 'chat-empty', text: 'No chats yet.' }))
      for (const c of chats) {
        const current = state.current && state.current.id === c.id
        ul.append(
          h(
            'li',
            { class: 'chat-item' + (current ? ' current' : '') },
            h('button', {
              type: 'button',
              class: 'chat-open',
              text: c.title || 'New chat',
              title: c.title || 'New chat',
              'aria-current': current ? 'true' : null,
              click: () => openConversation(c.id),
            }),
            h('button', {
              type: 'button',
              class: 'icon-btn chat-delete',
              'aria-label': 'Delete chat ' + (c.title || 'New chat'),
              icon: 'trash',
              click: () => deleteChat(c),
            })
          )
        )
      }
      item.append(ul)
    }
    list.append(item)
  }
}

function toggleProject(id) {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
  renderProjects()
}

async function newChat(projectId) {
  try {
    const r = await api.post('/api/web/conversations', { projectId })
    state.conversations.unshift(r.conversation)
    state.expanded.add(projectId)
    setCurrent(r.conversation, [])
    closeDrawers()
    $('input').focus()
  } catch (err) {
    note($('composer-note'), friendly(err, 'Could not start a chat.'))
  }
}

async function deleteChat(c) {
  if (!window.confirm('Delete "' + (c.title || 'New chat') + '"? This cannot be undone.')) return
  try {
    await api.post('/api/web/conversations/' + encodeURIComponent(c.id) + '/delete')
  } catch (err) {
    if (err.status !== 404) return note($('composer-note'), friendly(err, 'Could not delete that chat.'))
  }
  state.conversations = state.conversations.filter((x) => x.id !== c.id)
  if (state.current && state.current.id === c.id) setCurrent(null, [])
  renderProjects()
}

async function openConversation(id) {
  closeDrawers()
  note($('composer-note'), '')
  try {
    const r = await api.get('/api/web/conversations/' + encodeURIComponent(id) + '/messages')
    setCurrent(r.conversation, r.messages || [])
  } catch (err) {
    note($('composer-note'), friendly(err, 'Could not open that chat.'))
    if (err.status === 404) refreshConversations()
  }
}

function setCurrent(conv, messages) {
  state.current = conv
  state.messages = messages
  const has = Boolean(conv)
  $('chat-title').disabled = !has
  $('chat-model').disabled = !has
  $('chat-effort').disabled = !has
  $('chat-title').value = has ? conv.title || '' : ''
  $('chat-model').value = has ? conv.model || '' : ''
  $('chat-effort').value = has ? conv.effort || '' : ''
  $('chat-project').textContent = has ? projectName(conv.projectId) : ''
  if (has) state.expanded.add(conv.projectId)
  renderMessages()
  renderProjects()
  updateRunning()
}

// ---------- chat header ----------

async function saveConversation(fields) {
  const conv = state.current
  if (!conv) return
  try {
    const r = await api.post('/api/web/conversations/' + encodeURIComponent(conv.id), fields)
    Object.assign(conv, r.conversation)
    const listed = state.conversations.find((c) => c.id === conv.id)
    if (listed) Object.assign(listed, r.conversation)
    renderProjects()
  } catch (err) {
    note($('composer-note'), friendly(err, 'Could not save that change.'))
  }
}

$('chat-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    $('chat-title').blur()
  } else if (e.key === 'Escape') {
    $('chat-title').value = (state.current && state.current.title) || ''
    $('chat-title').blur()
  }
})
$('chat-title').addEventListener('change', () => {
  const title = $('chat-title').value.trim()
  if (state.current && title !== (state.current.title || '')) saveConversation({ title })
})
$('chat-model').addEventListener('change', () => saveConversation({ model: $('chat-model').value }))
$('chat-effort').addEventListener('change', () => saveConversation({ effort: $('chat-effort').value }))

// ---------- messages ----------

function fileUrl(messageId, index) {
  return '/api/web/messages/' + encodeURIComponent(messageId) + '/files/' + encodeURIComponent(index)
}

function messageEl(m) {
  const el = h('div', { class: 'msg ' + (m.role === 'user' ? 'user' : 'assistant') })
  const body = h('div', { class: 'msg-body' })
  body.innerHTML = renderMarkdown(m.content || '')
  el.append(body)
  if (m.files && m.files.length) {
    const files = h('div', { class: 'msg-files' })
    for (const f of m.files) {
      const url = fileUrl(m.id, f.index)
      if (f.kind === 'photo') {
        files.append(h('a', { class: 'file-thumb', href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: f.name, loading: 'lazy' })))
      }
      files.append(h('a', { class: 'file-chip', href: url, download: f.name, icon: 'clip' }, h('span', { text: f.name })))
    }
    el.append(files)
  }
  if (m.buttons && m.buttons.length) {
    const row = h('div', { class: 'msg-buttons' })
    for (const label of m.buttons) {
      row.append(h('button', { type: 'button', class: 'reply-btn', text: label, click: () => send(label) }))
    }
    el.append(row)
  }
  return el
}

function renderMessages() {
  const box = $('messages')
  box.replaceChildren()
  if (!state.messages.length) {
    box.append($('empty-template').content.cloneNode(true))
  }
  for (const m of state.messages) box.append(messageEl(m))
  updateReplyButtons()
  scrollDown(true)
}

function scrollDown(force) {
  const box = $('messages')
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160
  if (force || near) box.scrollTop = box.scrollHeight
}

function updateReplyButtons() {
  // Like Telegram's keyboard: only the latest reply's buttons stay live.
  const busy = Boolean(state.running)
  const last = $('messages').lastElementChild
  for (const b of $('messages').querySelectorAll('.reply-btn')) b.disabled = busy || !last || !last.contains(b)
}

function updateRunning() {
  const here = state.current && state.running === state.current.id
  show($('stop'), Boolean(here))
  $('send').disabled = Boolean(here)
  updateReplyButtons()
}

// ---------- sending and streaming ----------

async function ensureConversation() {
  if (state.current) return state.current
  const r = await api.post('/api/web/conversations', { projectId: '' })
  state.conversations.unshift(r.conversation)
  setCurrent(r.conversation, [])
  return r.conversation
}

async function send(text) {
  text = (text || '').trim()
  if (!text) return
  if (state.running) {
    note($('composer-note'), 'Still working on the last message. Wait for it, or press Stop.')
    return
  }
  note($('composer-note'), '')
  let conv
  try {
    conv = await ensureConversation()
  } catch (err) {
    note($('composer-note'), friendly(err, 'Could not start a chat.'))
    return
  }
  const convId = conv.id
  const here = () => state.current && state.current.id === convId

  const userMsg = { id: 0, role: 'user', content: text, files: [], buttons: [] }
  state.messages.push(userMsg)
  const box = $('messages')
  const empty = box.querySelector('.empty')
  if (empty) empty.remove()
  box.append(messageEl(userMsg))

  const reply = h('div', { class: 'msg assistant' })
  const body = h('div', { class: 'msg-body' })
  const status = h('div', { class: 'msg-status' })
  const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
  const setStatus = (label) => {
    status.replaceChildren(dots(), label ? h('span', { text: label }) : '')
  }
  setStatus('')
  reply.append(body, status)
  box.append(reply)
  scrollDown(true)

  state.running = convId
  updateRunning()

  let acc = ''
  let frame = 0
  const paint = () => {
    frame = 0
    body.innerHTML = renderMarkdown(stripMarkers(acc))
    scrollDown(false)
  }

  const finishWith = (msg, cls) => {
    if (!here()) return
    if (msg) {
      state.messages.push(msg)
      reply.replaceWith(messageEl(msg))
    } else {
      reply.remove()
    }
    if (cls) {
      const last = box.lastElementChild
      if (last) last.classList.add(cls)
    }
  }

  try {
    const finished = await api.streamChat(convId, text, {
      onQueued: (ahead) => setStatus(ahead > 0 ? 'Waiting for ' + ahead + (ahead === 1 ? ' earlier request' : ' earlier requests') : ''),
      onDelta: (t) => {
        acc += t
        setStatus('')
        if (!frame) frame = requestAnimationFrame(paint)
      },
      onTool: (tool) => setStatus(tool ? 'Working: ' + tool : 'Working'),
      onDone: (d) => {
        if (d.cancelled) finishWith({ id: 0, role: 'assistant', content: acc ? stripMarkers(acc) + '\n\n*Stopped.*' : '*Stopped.*', files: [], buttons: [] })
        else finishWith(d.message)
      },
      onPaused: (t) => finishWith({ id: 0, role: 'assistant', content: t, files: [], buttons: [] }, 'paused'),
      onError: (t) => finishWith({ id: 0, role: 'assistant', content: t || 'Something went wrong with that reply.', files: [], buttons: [] }, 'error'),
    })
    if (!finished) {
      // Cut off: the box still finishes and stores the reply. Show it when it lands.
      if (here()) setStatus('Connection lost. The reply will appear when it is ready.')
      pollForReply(convId)
    }
  } catch (err) {
    if (err.status === 409) {
      reply.remove()
      note($('composer-note'), 'Still working on an earlier message in this chat. Wait for it, or press Stop.')
      state.running = convId
      updateRunning()
      pollForReply(convId)
      return
    }
    if (here()) {
      reply.remove()
      note($('composer-note'), friendly(err, 'Could not send that message.'))
    }
  } finally {
    if (frame) cancelAnimationFrame(frame)
  }
  if (state.running === convId && !pollers.has(convId)) state.running = null
  updateRunning()
  refreshConversations()
}

const pollers = new Set()

/** After a dropped stream or a busy reply: reload the chat until the last message is the assistant's. */
function pollForReply(convId, tries = 0) {
  pollers.add(convId)
  setTimeout(async () => {
    let done = tries > 120
    try {
      const r = await api.get('/api/web/conversations/' + encodeURIComponent(convId) + '/messages')
      const last = (r.messages || [])[r.messages.length - 1]
      if (last && last.role === 'assistant') done = true
      if (done && state.current && state.current.id === convId) setCurrent(r.conversation, r.messages || [])
    } catch (err) {
      if (err.status === 401 || err.status === 404) done = true
    }
    if (done) {
      pollers.delete(convId)
      if (state.running === convId) state.running = null
      updateRunning()
    } else {
      pollForReply(convId, tries + 1)
    }
  }, 2500)
}

$('stop').addEventListener('click', async () => {
  const id = state.running
  if (!id) return
  $('stop').disabled = true
  try {
    await api.post('/api/web/conversations/' + encodeURIComponent(id) + '/cancel')
  } catch (err) {
    note($('composer-note'), friendly(err, 'Could not stop it.'))
  } finally {
    $('stop').disabled = false
  }
})

$('composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $('input')
  const text = input.value
  if (!text.trim() || state.running) return
  input.value = ''
  send(text)
})

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})

// ---------- uploads ----------

$('attach').addEventListener('click', () => $('attach-input').click())
$('attach-input').addEventListener('change', async () => {
  const files = [...$('attach-input').files]
  $('attach-input').value = ''
  if (!files.length) return
  const input = $('input')
  note($('composer-note'), files.length === 1 ? 'Uploading ' + files[0].name + '...' : 'Uploading ' + files.length + ' files...')
  const failed = []
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) {
      failed.push(f.name + ' is over 25 MB')
      continue
    }
    try {
      const path = await api.upload(f)
      if (path) {
        const line = 'I uploaded ' + path
        input.value = input.value.trim() ? input.value.replace(/\s*$/, '\n') + line : line
      }
    } catch (err) {
      if (err.status === 401) return
      failed.push(f.name + (err.status === 413 ? ' is over 25 MB' : ' did not upload'))
    }
  }
  note($('composer-note'), failed.length ? failed.join('. ') + '.' : '')
  if (state.treeLoaded) loadTree()
  input.focus()
})

// ---------- goals ----------

async function loadGoals() {
  try {
    state.goals = await api.get('/api/web/goals')
  } catch (err) {
    if (err.status === 401) return
    note($('goal-note'), 'Could not load goals.')
  }
  renderGoals()
}

async function goalAction(body) {
  note($('goal-note'), '')
  try {
    state.goals = await api.post('/api/web/goals', { ...body, version: state.goals.version })
    renderGoals()
    return true
  } catch (err) {
    if (err.status === 409 && err.body && Array.isArray(err.body.goals)) {
      state.goals = { goals: err.body.goals, version: err.body.version }
      renderGoals()
      note($('goal-note'), 'Your goals changed somewhere else. Here is the latest. Try again.')
    } else {
      note($('goal-note'), friendly(err, 'Could not save that goal.'))
    }
    return false
  }
}

function goalEl(g) {
  const li = h('li', { class: 'goal' + (g.done ? ' done' : '') })
  const box = h('input', { type: 'checkbox', 'aria-label': (g.done ? 'Mark not done: ' : 'Mark done: ') + g.text })
  box.checked = g.done
  box.addEventListener('change', () => goalAction({ action: 'done', index: g.index, done: box.checked }))
  const text = h('button', { type: 'button', class: 'goal-text', text: g.text, title: 'Edit', click: () => editGoal(li, g) })
  const actions = h(
    'span',
    { class: 'goal-actions' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Edit goal', icon: 'edit', click: () => editGoal(li, g) }),
    h('button', {
      type: 'button',
      class: 'icon-btn chat-delete',
      'aria-label': 'Delete goal',
      icon: 'trash',
      click: () => {
        if (window.confirm('Delete this goal?\n\n' + g.text)) goalAction({ action: 'delete', index: g.index })
      },
    })
  )
  li.append(box, text, actions)
  return li
}

function editGoal(li, g) {
  const input = h('input', { type: 'text', class: 'goal-edit', maxlength: '300', 'aria-label': 'Edit goal' })
  input.value = g.text
  let settled = false
  const finish = async (save) => {
    if (settled) return
    settled = true
    const text = input.value.trim()
    if (save && text && text !== g.text) await goalAction({ action: 'update', index: g.index, text })
    else renderGoals()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  li.replaceChildren(input)
  input.focus()
  input.select()
}

function renderGoals() {
  const list = $('goals')
  list.replaceChildren()
  const goals = state.goals.goals || []
  const open = goals.filter((g) => !g.done)
  const done = goals.filter((g) => g.done)
  if (!goals.length) list.append(h('li', { class: 'goal-empty', text: 'No goals yet. Add the few things that matter most right now.' }))
  for (const g of open) list.append(goalEl(g))
  if (done.length) {
    list.append(h('li', { class: 'goal-divider', text: 'Done' }))
    for (const g of done) list.append(goalEl(g))
  }
}

$('goal-add').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('goal-input')
  const text = input.value.trim()
  if (!text) return
  if (await goalAction({ action: 'add', text })) input.value = ''
})

// ---------- file tree and preview ----------

function ensureTree() {
  if (!state.treeLoaded) loadTree()
}

async function listDir(path) {
  const r = await api.get('/api/web/files?path=' + encodeURIComponent(path))
  return (r && r.entries) || []
}

function treeItems(entries) {
  const frag = document.createDocumentFragment()
  for (const e of entries) {
    if (e.isDir) {
      const li = h('li', { class: 'tree-dir', role: 'treeitem', 'aria-expanded': 'false' })
      const btn = h('button', { type: 'button', class: 'tree-btn', icon: 'folder' }, h('span', { text: e.name }))
      btn.insertAdjacentHTML('afterbegin', ICON.caret)
      btn.addEventListener('click', () => toggleDir(li, e.path))
      li.append(btn)
      frag.append(li)
    } else {
      const btn = h('button', { type: 'button', class: 'tree-btn', icon: 'file', title: e.name, 'data-path': e.path }, h('span', { text: e.name }))
      btn.addEventListener('click', () => preview(e))
      frag.append(h('li', { role: 'treeitem' }, btn))
    }
  }
  return frag
}

async function toggleDir(li, path) {
  const open = li.classList.toggle('open')
  li.setAttribute('aria-expanded', String(open))
  let ul = li.querySelector(':scope > ul')
  if (!open) {
    if (ul) show(ul, false)
    return
  }
  if (ul) return show(ul)
  ul = h('ul', { role: 'group' }, h('li', { class: 'tree-note', text: 'Loading...' }))
  li.append(ul)
  try {
    const entries = await listDir(path)
    ul.replaceChildren(entries.length ? treeItems(entries) : h('li', { class: 'tree-note', text: 'Empty' }))
  } catch (err) {
    ul.replaceChildren(h('li', { class: 'tree-note', text: friendly(err, 'Could not open this folder.') }))
  }
}

async function loadTree() {
  state.treeLoaded = true
  const tree = $('tree')
  tree.replaceChildren(h('li', { class: 'tree-note', text: 'Loading...' }))
  try {
    const entries = await listDir('')
    tree.replaceChildren(entries.length ? treeItems(entries) : h('li', { class: 'tree-note', text: 'No files to show.' }))
  } catch (err) {
    state.treeLoaded = false
    tree.replaceChildren(h('li', { class: 'tree-note', text: friendly(err, 'Could not load files.') }))
  }
}

const TEXT_EXT = new Set(['txt', 'json', 'csv', 'log', 'html', 'htm'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

async function preview(entry) {
  const url = '/api/web/files/raw?path=' + encodeURIComponent(entry.path)
  const ext = (entry.name.split('.').pop() || '').toLowerCase()
  const bodyEl = $('preview-body')
  state.previewPath = entry.path
  for (const b of $('tree').querySelectorAll('.tree-btn.current')) b.classList.remove('current')
  const btn = [...$('tree').querySelectorAll('.tree-btn[data-path]')].find((b) => b.getAttribute('data-path') === entry.path)
  if (btn) btn.classList.add('current')
  $('preview-name').textContent = entry.name
  $('preview-download').href = url
  $('preview-download').setAttribute('download', entry.name)
  show($('preview'))
  bodyEl.replaceChildren(h('p', { class: 'preview-note', text: 'Loading...' }))

  if (IMAGE_EXT.has(ext)) return bodyEl.replaceChildren(h('img', { src: url, alt: entry.name }))
  if (ext === 'pdf') return bodyEl.replaceChildren(h('iframe', { src: url, title: entry.name }))
  if (ext !== 'md' && !TEXT_EXT.has(ext)) {
    return bodyEl.replaceChildren(h('p', { class: 'preview-note', text: 'No preview for this kind of file. Use Download to open it.' }))
  }
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (res.status === 401) return showSignedOut('')
    if (!res.ok) throw Object.assign(new Error('bad'), { status: res.status })
    if (!(res.headers.get('content-type') || '').startsWith('text/plain')) {
      return bodyEl.replaceChildren(h('p', { class: 'preview-note', text: 'This file is too large to preview. Use Download to open it.' }))
    }
    const text = await res.text()
    if (state.previewPath !== entry.path) return
    if (ext === 'md') {
      const md = h('div', { class: 'msg-body' })
      md.innerHTML = renderMarkdown(text)
      bodyEl.replaceChildren(md)
    } else {
      bodyEl.replaceChildren(h('pre', { text }))
    }
  } catch (err) {
    bodyEl.replaceChildren(h('p', { class: 'preview-note', text: friendly(err, 'Could not open this file.') }))
  }
}

$('preview-close').addEventListener('click', () => {
  show($('preview'), false)
  $('preview-body').replaceChildren()
  state.previewPath = ''
  for (const b of $('tree').querySelectorAll('.tree-btn.current')) b.classList.remove('current')
})
$('tree-refresh').addEventListener('click', loadTree)

// ---------- settings ----------

const PILL = { connected: 'Connected', attention: 'Needs attention', off: 'Off' }

function renderConnections(list) {
  const ul = $('connections')
  ul.replaceChildren()
  if (!list.length) ul.append(h('li', { class: 'muted', text: 'Nothing to show.' }))
  for (const c of list) {
    const status = PILL[c.status] ? c.status : 'off'
    ul.append(
      h(
        'li',
        { class: 'conn' },
        h('span', { class: 'conn-name', text: c.name }),
        h('span', { class: 'pill ' + status, text: PILL[status] }),
        c.detail ? h('span', { class: 'conn-detail', text: c.detail }) : null,
        c.next ? h('span', { class: 'conn-next', text: c.next }) : null
      )
    )
  }
}

async function loadConnections(check) {
  const ul = $('connections')
  ul.replaceChildren(h('li', { class: 'muted', text: check ? 'Checking...' : 'Loading...' }))
  $('conn-check').disabled = true
  try {
    const list = check ? await api.post('/api/web/connections/check') : await api.get('/api/web/connections')
    renderConnections(Array.isArray(list) ? list : [])
  } catch (err) {
    ul.replaceChildren(h('li', { class: 'muted', text: friendly(err, 'Could not load connections.') }))
  } finally {
    $('conn-check').disabled = false
  }
}

async function loadDevices() {
  const ul = $('devices')
  ul.replaceChildren(h('li', { class: 'muted', text: 'Loading...' }))
  try {
    const r = await api.get('/api/web/sessions')
    const sessions = (r && r.sessions) || []
    ul.replaceChildren()
    for (const s of sessions) {
      ul.append(
        h(
          'li',
          { class: 'dev' },
          h(
            'div',
            { class: 'dev-text' },
            h('div', { class: 'dev-label', text: s.label || 'Browser' }),
            h('div', { class: 'dev-meta', text: 'Last used ' + relTime(s.lastSeenAt) + '. Signed in ' + new Date(s.createdAt).toLocaleDateString() + '.' })
          ),
          s.current ? h('span', { class: 'dev-tag', text: 'This device' }) : null
        )
      )
    }
    $('dev-others').disabled = sessions.filter((s) => !s.current).length === 0
  } catch (err) {
    ul.replaceChildren(h('li', { class: 'muted', text: friendly(err, 'Could not load devices.') }))
  }
}

$('open-settings').addEventListener('click', () => {
  closeDrawers()
  note($('dev-note'), '')
  const s = state.status
  $('settings-version').textContent = s && s.version ? 'Version ' + s.version : ''
  $('settings').showModal()
  loadConnections(false)
  loadDevices()
})
$('settings-close').addEventListener('click', () => $('settings').close())
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) $('settings').close()
})
$('conn-check').addEventListener('click', () => loadConnections(true))
$('dev-others').addEventListener('click', async () => {
  try {
    const r = await api.post('/api/web/sessions/revoke', { others: true })
    note($('dev-note'), r.revoked ? 'Signed out ' + r.revoked + (r.revoked === 1 ? ' other device.' : ' other devices.') : 'No other devices were signed in.')
    loadDevices()
  } catch (err) {
    note($('dev-note'), friendly(err, 'Could not sign out other devices.'))
  }
})
$('dev-signout').addEventListener('click', async () => {
  try {
    await api.post('/api/web/signout')
  } catch {
    // signed out either way
  }
  state.me = null
  showSignedOut('You are signed out.')
})

// ---------- update notice ----------

async function loadStatus() {
  try {
    state.status = await api.get('/api/web/status')
  } catch {
    return
  }
  const s = state.status
  if (s.updateAvailable && !s.dismissed && s.latestVersion) {
    $('update-text').textContent = 'Version ' + s.latestVersion + ' is available. Send /update to your assistant to install it.'
    show($('update-banner'))
  } else if (s.restartPending) {
    $('update-text').textContent = 'An update is installed and starts on the next restart.'
    show($('update-banner'))
  }
}

$('update-dismiss').addEventListener('click', async () => {
  show($('update-banner'), false)
  const s = state.status
  if (s && s.updateAvailable && s.latestVersion) {
    try {
      await api.post('/api/web/status/dismiss', { version: s.latestVersion })
    } catch {
      // the banner stays hidden for this visit
    }
  }
})

// A new link pasted into an open tab only changes the fragment.
window.addEventListener('hashchange', () => {
  if (/(?:^#|&)token=/.test(location.hash)) boot()
})

boot()
