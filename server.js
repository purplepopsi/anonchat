require("dotenv").config()
const path = require("path")
const http = require("http")
const crypto = require("crypto")
const express = require("express")
const mongoose = require("mongoose")
const { Server } = require("socket.io")
const { Room, Message, REACTIONS } = require("./models")

const PORT = process.env.PORT || 3000
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/anonchat"
const ID_SALT = process.env.ID_SALT || "dev-only-salt"
const MAX_MESSAGE_LENGTH = 1000
const HISTORY_LIMIT = 100

const DEFAULT_ROOMS = [
  ["late-night", "Late night", "Thoughts that only show up after dark."],
  ["music", "Music", "Songs, sounds, and everything in between."],
  ["relationships", "Relationships", "The good, the messy, the in-between."],
  ["gaming", "Gaming", "Games are better together."],
  ["movies", "Movies & TV", "Stay a little longer after the credits."],
  ["books", "Books", "One more chapter, one more conversation."],
  ["tech", "Tech", "For the endlessly curious."],
  ["sports", "Sports", "Every game has a story."],
]

const app = express()
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 1e5 })

app.use(express.static(path.join(__dirname, "public")))
app.get("/health", (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }))

/* ---------- helpers ---------- */
class UserError extends Error {}
const fail = (message) => { throw new UserError(message) }
const roomKey = (slug) => `room:${slug}`
const hashId = (clientId) =>
  crypto.createHmac("sha256", ID_SALT).update(clientId).digest("hex").slice(0, 16)

const NAMES = ["QuietPine", "SoftEcho", "MossMoon", "FernFox", "CloudAtlas"]
const randomNick = () =>
  `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(10 + Math.random() * 90)}`
const validNick = (n) => typeof n === "string" && /^[A-Za-z0-9]{3,24}$/.test(n)
const clean = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""

const serializeRoom = (r) => ({
  id: r.slug,
  name: r.name,
  description: r.description,
  creatorId: r.creatorId || null,
})

const serializeMessage = (m) => {
  const reactions = {}
  for (const emoji of REACTIONS) {
    const users = m.reactions?.[emoji]
    if (users?.length) reactions[emoji] = users
  }
  return {
    id: String(m._id),
    roomId: m.room,
    authorId: m.authorId,
    nickname: m.nickname,
    text: m.text,
    createdAt: m.createdAt,
    replyTo: m.replyTo ? { ...m.replyTo } : null,
    reactions,
  }
}

/* ---------- presence (unique users per room) ---------- */
const presence = new Map() // slug -> Map(userId -> open tabs)
function presenceAdd(slug, userId) {
  if (!presence.has(slug)) presence.set(slug, new Map())
  const users = presence.get(slug)
  users.set(userId, (users.get(userId) || 0) + 1)
}
function presenceRemove(slug, userId) {
  const users = presence.get(slug)
  if (!users) return
  const left = (users.get(userId) || 1) - 1
  if (left <= 0) users.delete(userId)
  else users.set(userId, left)
  if (users.size === 0) presence.delete(slug)
}
const presenceSnapshot = () =>
  Object.fromEntries([...presence].map(([slug, users]) => [slug, users.size]))
let presenceTimer = null
function broadcastPresence() {
  if (presenceTimer) return
  presenceTimer = setTimeout(() => {
    presenceTimer = null
    io.emit("presence", presenceSnapshot())
  }, 150)
}

function leaveCurrentRoom(socket) {
  const slug = socket.data.roomId
  if (!slug) return
  socket.leave(roomKey(slug))
  presenceRemove(slug, socket.data.userId)
  socket.data.roomId = null
  broadcastPresence()
}

/* ---------- socket auth ---------- */
io.use((socket, next) => {
  const { clientId, nickname } = socket.handshake.auth || {}
  if (typeof clientId !== "string" || clientId.length < 16 || clientId.length > 64) {
    return next(new Error("invalid client id"))
  }
  socket.data.userId = hashId(clientId)
  socket.data.nickname = validNick(nickname) ? nickname : randomNick()
  socket.data.sent = []
  next()
})

// wraps a handler: runs it, acks the result, turns UserErrors into friendly acks
function handle(socket, event, fn) {
  socket.on(event, async (...args) => {
    const ack = typeof args[args.length - 1] === "function" ? args.pop() : () => {}
    try {
      ack((await fn(...args)) ?? { ok: true })
    } catch (err) {
      if (err instanceof UserError) return ack({ ok: false, error: err.message })
      console.error(`[${event}]`, err)
      ack({ ok: false, error: "Something went wrong. Try again." })
    }
  })
}

io.on("connection", (socket) => {
  const { userId, nickname } = socket.data
  socket.emit("identity", { userId, nickname })

  handle(socket, "rooms:list", async () => {
    const rooms = await Room.find().sort({ order: 1, createdAt: -1 }).lean()
    return { ok: true, rooms: rooms.map(serializeRoom), presence: presenceSnapshot() }
  })

  handle(socket, "room:join", async (slug) => {
    const room = typeof slug === "string" ? await Room.findOne({ slug }).lean() : null
    if (!room) fail("That room no longer exists.")
    leaveCurrentRoom(socket)
    socket.join(roomKey(room.slug))
    socket.data.roomId = room.slug
    presenceAdd(room.slug, userId)
    broadcastPresence()
    const recent = await Message.find({ room: room.slug })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean()
    return { ok: true, messages: recent.reverse().map(serializeMessage) }
  })

  handle(socket, "room:leave", async () => leaveCurrentRoom(socket))

  handle(socket, "message:send", async (payload) => {
    const slug = socket.data.roomId
    if (!slug) fail("Join a room first.")

    // rate limit: 6 messages / 8 seconds
    const now = Date.now()
    socket.data.sent = socket.data.sent.filter((t) => now - t < 8000)
    if (socket.data.sent.length >= 6) fail("You're sending messages too fast.")

    const text = typeof payload?.text === "string" ? payload.text.trim().replace(/\n{3,}/g, "\n\n") : ""
    if (!text) fail("Message is empty.")
    if (text.length > MAX_MESSAGE_LENGTH) fail(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`)
    socket.data.sent.push(now) // only valid messages count toward the rate limit

    let replyTo = null
    if (payload.replyTo && mongoose.isValidObjectId(payload.replyTo)) {
      const parent = await Message.findOne({ _id: payload.replyTo, room: slug }).lean()
      if (parent) {
        replyTo = {
          id: String(parent._id),
          authorId: parent.authorId,
          nickname: parent.nickname,
          text: parent.text.slice(0, 140),
        }
      }
    }

    const doc = await Message.create({ room: slug, authorId: userId, nickname, text, replyTo })
    io.to(roomKey(slug)).emit("message:new", serializeMessage(doc.toObject()))
  })

  handle(socket, "message:react", async (payload) => {
    const slug = socket.data.roomId
    if (!slug) fail("Join a room first.")
    const { id, emoji } = payload || {}
    if (!REACTIONS.includes(emoji) || !mongoose.isValidObjectId(id)) fail("Invalid reaction.")

    const existing = await Message.findOne({ _id: id, room: slug }).lean()
    if (!existing) fail("Message not found.")
    const already = (existing.reactions?.[emoji] || []).includes(userId)
    const updated = await Message.findByIdAndUpdate(
      id,
      already
        ? { $pull: { [`reactions.${emoji}`]: userId } }
        : { $addToSet: { [`reactions.${emoji}`]: userId } },
      { new: true }
    ).lean()
    io.to(roomKey(slug)).emit("message:updated", serializeMessage(updated))
  })

  handle(socket, "typing", async () => {
    const slug = socket.data.roomId
    if (slug) socket.to(roomKey(slug)).volatile.emit("typing", { userId, nickname })
  })

  handle(socket, "message:delete", async (id) => {
    const slug = socket.data.roomId
    if (!slug || !mongoose.isValidObjectId(id)) fail("Message not found.")
    const res = await Message.deleteOne({ _id: id, room: slug, authorId: userId })
    if (!res.deletedCount) fail("You can only delete your own messages.")
    io.to(roomKey(slug)).emit("message:deleted", { id, roomId: slug })
  })

  handle(socket, "room:create", async (payload) => {
    const name = clean(payload?.name, 40)
    const description = clean(payload?.description, 80) || "A new space for an open conversation."
    if (name.length < 2) fail("Room name must be at least 2 characters.")
    if (await Room.exists({ creatorId: userId })) fail("You already have a room. Delete it to create another.")

    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "room"
    const slug = `${base}-${crypto.randomBytes(3).toString("hex")}`
    const room = await Room.create({ slug, name, description, creatorId: userId })
    const data = serializeRoom(room)
    io.emit("room:created", data)
    return { ok: true, room: data }
  })

  handle(socket, "room:delete", async (slug) => {
    const room = typeof slug === "string" ? await Room.findOne({ slug }) : null
    if (!room) fail("That room no longer exists.")
    if (room.creatorId !== userId) fail("Only the creator can delete this room.")

    await Promise.all([Message.deleteMany({ room: slug }), room.deleteOne()])
    const inside = await io.in(roomKey(slug)).fetchSockets()
    inside.forEach((s) => { s.leave(roomKey(slug)); s.data.roomId = null })
    presence.delete(slug)
    io.emit("room:deleted", { id: slug })
    broadcastPresence()
  })

  socket.on("disconnect", () => leaveCurrentRoom(socket))
})

/* ---------- boot ---------- */
async function seedRooms() {
  await Promise.all(
    DEFAULT_ROOMS.map(([slug, name, description], order) =>
      Room.updateOne({ slug }, { $setOnInsert: { name, description, order, creatorId: null } }, { upsert: true })
    )
  )
}

async function main() {
  await mongoose.connect(MONGODB_URI)
  console.log("MongoDB connected")
  if (ID_SALT === "dev-only-salt") console.warn("Set ID_SALT in .env before deploying.")
  await seedRooms()
  server.listen(PORT, () => console.log(`Anonchat running on http://localhost:${PORT}`))
}

main().catch((err) => {
  console.error("Failed to start:", err.message)
  process.exit(1)
})