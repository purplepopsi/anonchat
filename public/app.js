/* ---------- identity (anonymous, stored only in this browser) ---------- */
const store = {
  get: (key) => { try { return localStorage.getItem(key) } catch { return null } },
  set: (key, value) => { try { localStorage.setItem(key, value) } catch {} },
}
const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")
const NAMES = ["QuietPine", "SoftEcho", "MossMoon", "FernFox", "CloudAtlas"]

let clientId = store.get("anonchat:clientId")
if (!clientId) { clientId = uuid(); store.set("anonchat:clientId", clientId) }
let nickname = store.get("anonchat:nickname")
if (!nickname) {
  nickname = `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(10 + Math.random() * 90)}`
  store.set("anonchat:nickname", nickname)
}

/* ---------- state ---------- */
const REACTIONS = ["👍", "❤️", "😂", "😮"]
const MAX_MESSAGES_IN_MEMORY = 300
const state = {
  userId: null,
  rooms: [],
  presence: {},
  messages: [],
  activeRoom: null,
  replyingTo: null,
  screen: "home",
  loading: false,
  query: "",
  unread: 0,
  newCount: 0,
}
const typers = new Map()

const $ = (selector) => document.querySelector(selector)
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character])

const app = $("#app")
const screens = { home: $("#homeScreen"), rooms: $("#roomsScreen"), chat: $("#chatScreen") }
$("#nickname").textContent = nickname

/* ---------- socket ---------- */
const socket = io({ auth: { clientId, nickname } })

let toastTimer
function toast(message) {
  const el = $("#toast")
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 3500)
}

const isMine = (room) => Boolean(room.creatorId) && room.creatorId === state.userId
const onlineIn = (id) => state.presence[id] || 0

function upsertRoom(room) {
  const index = state.rooms.findIndex((item) => item.id === room.id)
  if (index === -1) state.rooms.unshift(room)
  else state.rooms[index] = room
}

socket.on("identity", ({ userId }) => {
  state.userId = userId
  renderRooms()
})

socket.on("connect", () => {
  $("#connectionBanner").hidden = true
  socket.emit("rooms:list", (res) => {
    if (!res?.ok) return
    state.rooms = res.rooms
    state.presence = res.presence
    renderRooms()
    updateOnline()
    // after a reconnect, rejoin the room we were in and refresh history
    if (state.activeRoom) {
      if (state.rooms.some((room) => room.id === state.activeRoom.id)) joinActiveRoom()
      else leaveDeletedRoom()
    }
  })
})
socket.on("disconnect", () => {
  $("#connectionBanner").textContent = "Reconnecting…"
  $("#connectionBanner").hidden = false
})
socket.on("connect_error", () => {
  $("#connectionBanner").textContent = "Can't reach the server. Retrying…"
  $("#connectionBanner").hidden = false
})

socket.on("presence", (presence) => {
  state.presence = presence
  if (state.screen === "rooms") renderRooms()
  updateOnline()
})
socket.on("room:created", (room) => {
  upsertRoom(room)
  if (state.screen === "rooms") renderRooms()
})
socket.on("room:deleted", ({ id }) => {
  state.rooms = state.rooms.filter((room) => room.id !== id)
  if (state.activeRoom?.id === id) {
    leaveDeletedRoom()
    toast("This room was deleted by its creator.")
  }
  if (state.screen === "rooms") renderRooms()
})
socket.on("message:new", (message) => {
  if (message.roomId !== state.activeRoom?.id) return
  if (state.messages.some((item) => item.id === message.id)) return
  state.messages.push(message)
  if (state.messages.length > MAX_MESSAGES_IN_MEMORY) state.messages.shift()
  typers.delete(message.authorId)
  renderTyping()
  if (document.hidden && message.authorId !== state.userId) document.title = `(${++state.unread}) Anonchat`
  appendMessage(message)
})
socket.on("message:updated", (message) => {
  if (message.roomId !== state.activeRoom?.id) return
  const index = state.messages.findIndex((item) => item.id === message.id)
  if (index === -1) return
  state.messages[index] = message
  replaceMessageElement(message)
})

/* ---------- navigation ---------- */
function showScreen(name) {
  if (name !== "chat" && state.activeRoom) {
    socket.emit("room:leave")
    state.activeRoom = null
    state.messages = []
    state.replyingTo = null
    updateReplyBanner()
    typers.clear()
    renderTyping()
  }
  state.screen = name
  Object.entries(screens).forEach(([key, element]) => { element.hidden = key !== name })
  app.className = `app app-${name}`
  $("#backButton").hidden = name === "home"
  $("#backButton span").textContent = name === "chat" ? "Rooms" : "Home"
  if (name === "rooms") renderRooms()
}

function leaveDeletedRoom() {
  state.activeRoom = null
  state.messages = []
  showScreen("rooms")
}

/* ---------- rooms ---------- */
function arrow() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"></path></svg>`
}

const rc = { mine: "", all: "" } // cached markup: skip re-render (and replayed animations) when only counts change
function renderRooms() {
  const q = state.query
  const mine = state.rooms.filter(isMine)
  const everyone = state.rooms.filter((r) => !isMine(r) && (!q || `${r.name} ${r.description}`.toLowerCase().includes(q)))
  $("#myRoomCount").textContent = mine.length
  $("#publicRoomCount").textContent = everyone.length
  $("#createRoomButton").hidden = mine.length > 0
  const live = (id) => `<span data-online="${escapeHtml(id)}">0</span> online`

  const myHtml = mine.map((room) => `
    <div class="personal-room-shell">
      <button class="personal-room-card" data-room="${escapeHtml(room.id)}">
        <span class="personal-room-topline"><span class="owned-label">CREATED BY YOU</span>${arrow()}</span>
        <span class="personal-room-name">${escapeHtml(room.name)}</span>
        <span class="personal-room-description">${escapeHtml(room.description)}</span>
        <span class="personal-room-online"><i></i>${live(room.id)}</span>
      </button>
      <button class="delete-room-button" data-delete-room="${escapeHtml(room.id)}" aria-label="Delete ${escapeHtml(room.name)}">Delete</button>
    </div>`).join("")
  const allHtml = everyone.length ? everyone.map((room, index) => `
    <button class="room-row" data-room="${escapeHtml(room.id)}">
      <span class="room-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="room-details"><span class="room-name">${escapeHtml(room.name)}</span><span class="room-description">${escapeHtml(room.description)}</span></span>
      <span class="room-online"><i></i>${live(room.id)}</span>
    </button>`).join("") : `<p class="no-rooms">No rooms match “${escapeHtml(q)}”.</p>`

  if (myHtml !== rc.mine) $("#myRooms").innerHTML = rc.mine = myHtml
  if (allHtml !== rc.all) $("#publicRooms").innerHTML = rc.all = allHtml
  document.querySelectorAll("[data-online]").forEach((el) => { el.textContent = onlineIn(el.dataset.online) })
}

function updateOnline() {
  if (!state.activeRoom) return
  $("#chatOnline").textContent = `${onlineIn(state.activeRoom.id)} online`
}

function openRoom(id) {
  const room = state.rooms.find((item) => item.id === id)
  if (!room) return
  state.activeRoom = room
  state.replyingTo = null
  state.messages = []
  state.loading = true
  typers.clear()
  renderTyping()
  updateReplyBanner()
  $("#chatRoomName").textContent = room.name
  $("#messageInput").placeholder = `Message #${room.name.toLowerCase().replace(/\s+/g, "-")}`
  updateOnline()
  renderMessages(false)
  showScreen("chat")
  joinActiveRoom()
}

function joinActiveRoom() {
  const room = state.activeRoom
  if (!room) return
  socket.emit("room:join", room.id, (res) => {
    if (state.activeRoom?.id !== room.id) return
    state.loading = false
    if (!res?.ok) {
      toast(res?.error || "Couldn't join that room.")
      leaveDeletedRoom()
      return
    }
    // keep anything that arrived live while history was loading
    const last = res.messages.at(-1)?.createdAt ?? ""
    const seen = new Set(res.messages.map((m) => m.id))
    state.messages = [...res.messages, ...state.messages.filter((m) => !seen.has(m.id) && m.createdAt > last)]
    renderMessages(false)
    if (matchMedia("(hover: hover)").matches) $("#messageInput").focus({ preventScroll: true })
  })
}

/* ---------- messages ---------- */
const formatTime = (iso) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(iso))

function messageHtml(message) {
  const mine = message.authorId === state.userId
  const author = mine ? "You" : message.nickname
  const quote = message.replyTo
    ? `<div class="reply-quote"><span>Replying to ${message.replyTo.authorId === state.userId ? "You" : escapeHtml(message.replyTo.nickname)}</span><p>${escapeHtml(message.replyTo.text)}</p></div>`
    : ""
  const chips = REACTIONS.filter((emoji) => message.reactions[emoji]?.length)
    .map((emoji) => {
      const active = message.reactions[emoji].includes(state.userId) ? " active" : ""
      return `<button class="${active.trim()}" data-action="react" data-id="${escapeHtml(message.id)}" data-reaction="${emoji}">${emoji}<span>${message.reactions[emoji].length}</span></button>`
    }).join("")
  const options = REACTIONS.map((emoji) => {
    const active = message.reactions[emoji]?.includes(state.userId) ? " active" : ""
    return `<button class="reaction-option${active}" data-action="react" data-id="${escapeHtml(message.id)}" data-reaction="${emoji}" aria-label="React with ${emoji}">${emoji}</button>`
  }).join("")

  return `
    <article class="message${mine ? " message-self" : ""}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-content">
        <div class="message-meta"><strong>${escapeHtml(author)}</strong><time>${escapeHtml(formatTime(message.createdAt))}</time></div>
        <div class="message-bubble" role="button" tabindex="0" data-action="menu" data-id="${escapeHtml(message.id)}" aria-expanded="false" aria-label="Reply or react to this message">${quote}${escapeHtml(message.text)}</div>
        ${chips ? `<div class="message-reactions">${chips}</div>` : ""}
        <div class="message-controls">
          <div class="message-actions">
            <button data-action="reply" data-id="${escapeHtml(message.id)}">Reply</button><button data-action="copy" data-id="${escapeHtml(message.id)}">Copy</button>${mine ? `<button data-action="delete" data-id="${escapeHtml(message.id)}">Delete</button>` : ""}<span></span>
            ${options}
            <button class="message-actions-close" data-action="close" aria-label="Close reactions">×</button>
          </div>
        </div>
      </div>
    </article>`
}

function renderMessages(animate = true) {
  const chat = $("#chatMessages")
  chat.classList.toggle("no-message-motion", !animate)
  state.newCount = 0
  $("#jumpBottom").hidden = true
  chat.innerHTML = `
    <div class="privacy-note"><span></span>Messages stay anonymous</div>
    ${state.loading ? `<div class="empty-chat"><span class="empty-dot"></span><p>Loading messages…</p></div>` : state.messages.length === 0 ? `<div class="empty-chat"><span class="empty-dot"></span><h2>No messages yet</h2><p>Start the conversation.</p></div>` : ""}
    ${state.messages.map(messageHtml).join("")}
  `
  requestAnimationFrame(() => chat.scrollTo({ top: chat.scrollHeight, behavior: "auto" }))
}

function appendMessage(message) {
  const chat = $("#chatMessages")
  chat.querySelector(".empty-chat")?.remove()
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140
  chat.insertAdjacentHTML("beforeend", messageHtml(message))
  if (message.authorId === state.userId || nearBottom) {
    requestAnimationFrame(() => chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" }))
  } else {
    state.newCount++
    showJump()
  }
}

function replaceMessageElement(message) {
  const old = $("#chatMessages").querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)
  if (!old) return
  const template = document.createElement("template")
  template.innerHTML = messageHtml(message).trim()
  const element = template.content.firstElementChild
  element.classList.add("no-motion")
  if (old.querySelector(".message-controls.actions-open")) {
    element.querySelector(".message-controls").classList.add("actions-open")
    element.querySelector(".message-bubble").setAttribute("aria-expanded", "true")
  }
  old.replaceWith(element)
}

function updateReplyBanner() {
  const reply = state.replyingTo
  $("#replyBanner").hidden = !reply
  $("#replyText").textContent = reply?.text || ""
  $("#replyAuthor").textContent = reply ? (reply.authorId === state.userId ? "You" : reply.nickname) : "You"
}

function closeMessageMenus() {
  document.querySelectorAll(".message-controls.actions-open").forEach((controls) => {
    controls.classList.remove("actions-open")
    controls.closest(".message-content")?.querySelector(".message-bubble")?.setAttribute("aria-expanded", "false")
  })
}

/* ---------- events ---------- */
$("#homeButton").addEventListener("click", () => showScreen("home"))
$("#enterButton").addEventListener("click", () => showScreen("rooms"))
$("#backButton").addEventListener("click", () => showScreen(state.screen === "chat" ? "rooms" : "home"))

$("#roomsScreen").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-room]")
  if (deleteButton) {
    const id = deleteButton.dataset.deleteRoom
    const room = state.rooms.find((item) => item.id === id)
    if (!room || !window.confirm(`Delete "${room.name}"? This cannot be undone.`)) return
    socket.emit("room:delete", id, (res) => { if (!res?.ok) toast(res?.error || "Couldn't delete the room.") })
    return
  }
  const button = event.target.closest("[data-room]")
  if (button) openRoom(button.dataset.room)
})

$("#createRoomButton").addEventListener("click", () => {
  $("#roomModal").hidden = false
  $("#roomName").focus()
})
$("#closeModal").addEventListener("click", () => { $("#roomModal").hidden = true })
$("#roomModal").addEventListener("click", (event) => {
  if (event.target === $("#roomModal")) $("#roomModal").hidden = true
})
$("#roomForm").addEventListener("submit", (event) => {
  event.preventDefault()
  const name = $("#roomName").value.trim()
  if (!name) return
  socket.emit("room:create", { name, description: $("#roomDescription").value.trim() }, (res) => {
    if (!res?.ok) return toast(res?.error || "Couldn't create the room.")
    upsertRoom(res.room)
    $("#roomForm").reset()
    $("#roomModal").hidden = true
    renderRooms()
    openRoom(res.room.id)
  })
})

$("#messageInput").addEventListener("input", (event) => {
  $("#sendButton").disabled = !event.target.value.trim()
  event.target.style.height = "auto"
  event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`
})
$("#messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    $("#composer").requestSubmit()
  }
})
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault()
  const input = $("#messageInput")
  const text = input.value.trim()
  if (!text || !state.activeRoom) return
  if (!socket.connected) return toast("You're offline. Reconnecting…")

  const replyTo = state.replyingTo?.id || null
  input.value = ""
  input.style.height = "auto"
  updateCount()
  $("#sendButton").disabled = true
  state.replyingTo = null
  updateReplyBanner()

  socket.emit("message:send", { text, replyTo }, (res) => {
    if (res?.ok) return
    toast(res?.error || "Message failed to send.")
    if (!input.value) { // put the text back so nothing is lost
      input.value = text
      $("#sendButton").disabled = false
    }
  })
})

$("#chatMessages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]")
  if (!button) return
  const id = button.dataset.id
  const action = button.dataset.action
  if (action === "menu") {
    const controls = button.closest(".message-content").querySelector(".message-controls")
    const shouldOpen = !controls.classList.contains("actions-open")
    closeMessageMenus()
    if (shouldOpen) {
      controls.classList.add("actions-open")
      button.setAttribute("aria-expanded", "true")
    }
    return
  }
  if (action === "close") return closeMessageMenus()
  if (action === "copy") {
    const msg = state.messages.find((m) => m.id === id)
    navigator.clipboard?.writeText(msg?.text || "").then(() => toast("Copied"), () => toast("Couldn't copy."))
    return closeMessageMenus()
  }
  if (action === "delete") {
    closeMessageMenus()
    return socket.emit("message:delete", id, (res) => { if (!res?.ok) toast(res?.error || "Couldn't delete.") })
  }
  if (action === "react") {
    socket.emit("message:react", { id, emoji: button.dataset.reaction }, (res) => {
      if (!res?.ok) toast(res?.error || "Couldn't add reaction.")
    })
  }
  if (action === "reply") {
    state.replyingTo = state.messages.find((message) => message.id === id) || null
    updateReplyBanner()
    closeMessageMenus()
    $("#messageInput").focus()
  }
})
$("#chatMessages").addEventListener("keydown", (event) => {
  const bubble = event.target.closest('.message-bubble[data-action="menu"]')
  if (bubble && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault()
    bubble.click()
  }
})
$("#cancelReply").addEventListener("click", () => {
  state.replyingTo = null
  updateReplyBanner()
})

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMessageMenus()
    $("#roomModal").hidden = true
    $("#nickModal").hidden = true
  }
})
document.addEventListener("click", (event) => {
  if (!event.target.closest(".message-content")) closeMessageMenus()
})

/* ---------- extras: typing, deletes, scroll pill, nickname, search ---------- */
function updateCount() {
  const len = $("#messageInput").value.length
  const el = $("#charCount")
  el.textContent = len > 800 ? `${len}/1000` : ""
  el.classList.toggle("warn", len > 950)
}
let lastTyping = 0
$("#messageInput").addEventListener("input", (event) => {
  updateCount()
  const now = Date.now()
  if (event.target.value.trim() && socket.connected && now - lastTyping > 2000) {
    lastTyping = now
    socket.emit("typing")
  }
})
function renderTyping() {
  const names = [...typers.values()].map((t) => t.nickname)
  const el = $("#typing")
  el.hidden = names.length === 0
  el.textContent = names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : names.length ? "Several people are typing…" : ""
}
socket.on("typing", ({ userId, nickname }) => {
  if (userId === state.userId || !state.activeRoom) return
  clearTimeout(typers.get(userId)?.timer)
  typers.set(userId, { nickname, timer: setTimeout(() => { typers.delete(userId); renderTyping() }, 3500) })
  renderTyping()
})
socket.on("message:deleted", ({ id, roomId }) => {
  if (roomId !== state.activeRoom?.id) return
  state.messages = state.messages.filter((m) => m.id !== id)
  const el = $("#chatMessages").querySelector(`[data-message-id="${CSS.escape(id)}"]`)
  if (!el) return
  el.classList.add("leaving")
  setTimeout(() => { el.remove(); if (!state.messages.length) renderMessages(false) }, 220)
})

const chatBox = $("#chatMessages")
function showJump() {
  const b = $("#jumpBottom")
  b.hidden = false
  b.textContent = `↓ ${state.newCount} new message${state.newCount > 1 ? "s" : ""}`
}
chatBox.addEventListener("scroll", () => {
  if (chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 140) {
    state.newCount = 0
    $("#jumpBottom").hidden = true
  }
}, { passive: true })
$("#jumpBottom").addEventListener("click", () => chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" }))
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { state.unread = 0; document.title = "Anonchat" }
})

$("#roomSearch").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); renderRooms() })

$("#identityButton").addEventListener("click", () => {
  $("#nickInput").value = nickname
  $("#nickModal").hidden = false
  $("#nickInput").select()
})
$("#closeNick").addEventListener("click", () => { $("#nickModal").hidden = true })
$("#nickModal").addEventListener("click", (e) => { if (e.target === $("#nickModal")) $("#nickModal").hidden = true })
$("#nickForm").addEventListener("submit", (e) => {
  e.preventDefault()
  const next = $("#nickInput").value.trim()
  if (!/^[A-Za-z0-9]{3,24}$/.test(next)) return toast("Use 3–24 letters or numbers.")
  $("#nickModal").hidden = true
  if (next === nickname) return
  nickname = next
  store.set("anonchat:nickname", next)
  $("#nickname").textContent = next
  socket.auth = { clientId, nickname } // reconnect so the server uses the new name; the room is rejoined automatically
  socket.disconnect().connect()
})

renderRooms()