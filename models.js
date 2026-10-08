const mongoose = require("mongoose")

const REACTIONS = ["👍", "❤️", "😂", "😮"]
const TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS || 0)

const roomSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxlength: 40 },
  description: { type: String, default: "", maxlength: 80 },
  creatorId: { type: String, default: null, index: true }, // hashed anonymous id
  order: { type: Number, default: -1 },
  createdAt: { type: Date, default: Date.now },
})

const messageSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, index: true },
    authorId: { type: String, required: true }, // hashed anonymous id
    nickname: { type: String, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    replyTo: {
      type: new mongoose.Schema(
        { id: String, authorId: String, nickname: String, text: String },
        { _id: false }
      ),
      default: null,
    },
    // { "👍": [authorId, ...], "❤️": [...] }
    reactions: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
)
messageSchema.index({ room: 1, createdAt: -1 })
if (TTL_DAYS > 0) messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })

module.exports = {
  REACTIONS,
  Room: mongoose.model("Room", roomSchema),
  Message: mongoose.model("Message", messageSchema),
}
