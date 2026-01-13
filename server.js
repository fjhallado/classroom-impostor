const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const MIN_PLAYERS = 3;

function randomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function uniqueCode() {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  return code;
}
function roomState(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code: room.code,
    started: room.started,
    hostName: room.players.get(room.hostId)?.name || "Host",
    playerCount: room.players.size,
    players: Array.from(room.players.values()).map(p => p.name)
  };
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ hostName, word }, cb) => {
    hostName = String(hostName||"").trim().slice(0,20);
    word = String(word||"").trim().slice(0,30);
    if (!hostName || !word) return cb({ ok: false, error: "Escribe tu nombre y la palabra." });

    const code = uniqueCode();
    const room = {
      code,
      word,
      started: false,
      hostId: socket.id,
      players: new Map([[socket.id, { name: hostName }]])
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    cb({ ok: true, code });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("join_room", ({ code, name }, cb) => {
    code = String(code||"").trim().toUpperCase();
    name = String(name||"").trim().slice(0,20);
    if (!rooms.has(code)) return cb({ ok: false, error: "Código no válido." });
    const room = rooms.get(code);
    if (room.started) return cb({ ok: false, error: "La partida ya empezó." });
    if (!name) return cb({ ok: false, error: "Escribe tu nombre." });

    room.players.set(socket.id, { name });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;

    cb({ ok: true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("start_game", ({ code }, cb) => {
    code = String(code||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:"Sala no encontrada." });
    if (room.players.size < MIN_PLAYERS) return cb({ ok: false, error: "Mínimo 3 jugadores." });

    room.started = true;
    const ids = Array.from(room.players.keys());
    const impostor = ids[Math.floor(Math.random() * ids.length)];

    for (const [sid, p] of room.players.entries()) {
      const shown = sid === impostor ? "IMPOSTOR" : room.word;
      io.to(sid).emit("reveal", { code, name: p.name, shown });
    }
    cb({ ok: true });
  });

  socket.on("leave_room", ({ code }) => {
    code = String(code||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(code);
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
