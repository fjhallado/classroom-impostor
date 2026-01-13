const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const MIN_PLAYERS = 3; // excluding host

function now(){ return Date.now(); }
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
  const players = Array.from(room.players.values()).map(p => p.name);
  return {
    code: room.code,
    started: room.started,
    hostName: room.hostName || "Host",
    playerCount: players.length,
    players
  };
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ hostName, word }, cb) => {
    hostName = String(hostName||"").trim().slice(0, 20);
    word = String(word||"").trim().slice(0, 30);
    if (!hostName || !word) return cb({ ok: false, error: "Escribe tu nombre y la palabra." });

    const code = uniqueCode();
    rooms.set(code, {
      code,
      word,
      started: false,
      hostId: socket.id,
      hostName,
      players: new Map()
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    cb({ ok: true, code });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("join_room", ({ code, name }, cb) => {
    code = String(code||"").trim().toUpperCase();
    name = String(name||"").trim().slice(0, 20);
    if (!rooms.has(code)) return cb({ ok: false, error: "Código no válido." });

    const room = rooms.get(code);
    if (room.started) return cb({ ok: false, error: "La partida ya empezó." });
    if (!name) return cb({ ok: false, error: "Escribe tu nombre." });
    if (socket.id === room.hostId) return cb({ ok:false, error:"El host no participa como jugador." });

    room.players.set(socket.id, { name, joinedAt: now() });
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
    if (socket.id !== room.hostId) return cb?.({ ok:false, error:"Solo el host puede iniciar." });

    const playerIds = Array.from(room.players.keys());
    if (playerIds.length < MIN_PLAYERS) return cb({ ok:false, error:`Mínimo ${MIN_PLAYERS} jugadores (sin contar al host).` });

    room.started = true;

    const impostor = playerIds[Math.floor(Math.random() * playerIds.length)];
    for (const [sid, p] of room.players.entries()) {
      const role = (sid === impostor) ? "IMPOSTOR" : "CREWMATE";
      const shown = (role === "IMPOSTOR") ? "IMPOSTOR" : room.word;
      io.to(sid).emit("reveal", { code, name: p.name, role, shown });
    }

    io.to(room.hostId).emit("host_started", { code, playerCount: playerIds.length });
    cb({ ok:true });

    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("leave_room", ({ code }, cb) => {
    code = String(code||"").trim().toUpperCase();
    leaveInternal(socket, code);
    cb?.({ ok:true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (code) leaveInternal(socket, code);
  });
});

function leaveInternal(socket, code){
  if (!code || !rooms.has(code)) return;
  const room = rooms.get(code);

  if (socket.id === room.hostId){
    rooms.delete(code);
    io.to(code).emit("room_closed");
    return;
  }

  room.players.delete(socket.id);
  io.to(code).emit("room_update", roomState(code));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
