const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/**
 * Classroom Impostor (Kahoot-like rooms)
 * - Host creates a room with a secret word
 * - App generates a 6-char code
 * - Players join with code + name
 * - Host starts: exactly 1 impostor gets "IMPOSTOR", others get the secret word
 * - Real-time lobby updates
 *
 * Notes:
 * - In-memory rooms (simple for class). Restarting server clears rooms.
 */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_PLAYERS = 3;

function now() { return Date.now(); }

function cleanupRooms() {
  const t = now();
  for (const [code, room] of rooms.entries()) {
    if (t - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function uniqueCode() {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  return code;
}

function sanitizeName(s) {
  return String(s || "").trim().slice(0, 20);
}

function sanitizeWord(s) {
  return String(s || "").trim().slice(0, 30);
}

function roomState(code) {
  const room = rooms.get(code);
  if (!room) return null;
  const hostName = room.players.get(room.hostId)?.name || "Host";
  const players = Array.from(room.players.values())
    .sort((a,b)=>a.joinedAt-b.joinedAt)
    .map(p => p.name);
  return {
    code: room.code,
    started: room.started,
    hostName,
    playerCount: players.length,
    players
  };
}

io.on("connection", (socket) => {
  cleanupRooms();

  socket.on("create_room", ({ hostName, word }, cb) => {
    hostName = sanitizeName(hostName);
    word = sanitizeWord(word);

    if (!hostName || !word) return cb?.({ ok: false, error: "Pon tu nombre y la palabra." });

    const code = uniqueCode();
    const room = {
      code,
      word,
      createdAt: now(),
      started: false,
      hostId: socket.id,
      impostorId: null,
      players: new Map()
    };
    room.players.set(socket.id, { name: hostName, joinedAt: now() });
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    cb?.({ ok: true, code, isHost: true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("join_room", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = sanitizeName(name);

    if (!rooms.has(code)) return cb?.({ ok: false, error: "Código no válido." });
    const room = rooms.get(code);
    if (room.started) return cb?.({ ok: false, error: "La partida ya empezó. Pide al host una nueva sala." });
    if (!name) return cb?.({ ok: false, error: "Pon tu nombre." });

    room.players.set(socket.id, { name, joinedAt: now() });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;

    cb?.({ ok: true, code, isHost: room.hostId === socket.id });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("start_game", ({ code }, cb) => {
    code = String(code || "").trim().toUpperCase();
    if (!rooms.has(code)) return cb?.({ ok: false, error: "Sala no encontrada." });

    const room = rooms.get(code);
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "Solo el host puede iniciar." });

    if (room.players.size < MIN_PLAYERS) {
      return cb?.({ ok: false, error: `Mínimo ${MIN_PLAYERS} jugadores.` });
    }

    room.started = true;
    const ids = Array.from(room.players.keys());
    room.impostorId = ids[Math.floor(Math.random() * ids.length)];

    for (const [sid, p] of room.players.entries()) {
      const shown = (sid === room.impostorId) ? "IMPOSTOR" : room.word;
      io.to(sid).emit("reveal", { code: room.code, name: p.name, shown });
    }

    cb?.({ ok: true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("new_round", ({ code, word }, cb) => {
    code = String(code || "").trim().toUpperCase();
    word = sanitizeWord(word);
    if (!rooms.has(code)) return cb?.({ ok: false, error: "Sala no encontrada." });

    const room = rooms.get(code);
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "Solo el host puede preparar nueva ronda." });
    if (!word) return cb?.({ ok: false, error: "Escribe una nueva palabra." });

    room.word = word;
    room.started = false;
    room.impostorId = null;

    cb?.({ ok: true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("leave_room", ({ code }, cb) => {
    code = String(code || "").trim().toUpperCase();
    leaveInternal(socket, code);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (code) leaveInternal(socket, code);
  });
});

function leaveInternal(socket, code) {
  if (!code || !rooms.has(code)) return;

  const room = rooms.get(code);
  room.players.delete(socket.id);
  socket.leave(code);

  if (room.hostId === socket.id || room.players.size === 0) {
    rooms.delete(code);
    io.to(code).emit("room_closed");
    return;
  }

  io.to(code).emit("room_update", roomState(code));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Classroom Impostor running on port", PORT));
