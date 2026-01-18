const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// Expose runtime config to the frontend (so we don't hardcode secrets into index.html)
app.get("/config.js", (req, res) => {
  res.type("application/javascript");
  res.send(`window.__APP_CONFIG__ = { GOOGLE_CLIENT_ID: ${JSON.stringify(GOOGLE_CLIENT_ID)} };`);
});

const googleClient = new OAuth2Client();

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
function token6(){ return randomCode(6); }

function normalizeEmail(email){
  return String(email||"").trim().toLowerCase();
}

function publicPlayers(room){
  return Array.from(room.players.values()).map(p => ({ name: p.name, token: p.token }));
}
function roomState(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code: room.code,
    started: room.started,
    hostName: room.hostName || "Host",
    playerCount: room.players.size,
    players: publicPlayers(room),
    voteOpen: !!room.voteOpen
  };
}
function voteState(room){
  const players = publicPlayers(room);
  const counts = {};
  for (const p of players) counts[p.token] = 0;
  for (const v of room.votes.values()){
    if (counts[v] !== undefined) counts[v] += 1;
  }
  return { players, counts, totalVotes: room.votes.size };
}
function leaderboard(room){
  const out = [];
  for (const [email, s] of room.scores.entries()){
    out.push({
      email,
      displayName: s.displayName || s.lastName || email,
      accuserWins: s.accuserWins || 0,
      impostorWins: s.impostorWins || 0,
      totalWins: (s.accuserWins || 0) + (s.impostorWins || 0)
    });
  }
  out.sort((a,b)=> b.totalWins - a.totalWins || b.accuserWins - a.accuserWins || a.displayName.localeCompare(b.displayName));
  return out;
}

async function verifyGoogleCredential(credential){
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID no configurado en el servidor.");
  }
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();
  // payload: { email, email_verified, sub, name, given_name, family_name, picture, ... }
  const email = normalizeEmail(payload?.email);
  const sub = String(payload?.sub || "");
  if (!email || !sub) throw new Error("Token inválido.");
  // If you want to enforce verified emails:
  // if (!payload?.email_verified) throw new Error("Correo no verificado.");
  return { email, sub, name: payload?.name || "", picture: payload?.picture || "" };
}

io.on("connection", (socket) => {

  // --- Google auth (required for players) ---
  socket.on("google_auth", async ({ credential }, cb) => {
    try {
      const user = await verifyGoogleCredential(credential);
      socket.data.user = user;
      cb?.({ ok:true, email: user.email, name: user.name });
    } catch (e) {
      cb?.({ ok:false, error: e?.message || "No se pudo verificar Google." });
    }
  });

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
      players: new Map(),       // socketId -> {name, email, token}
      voteOpen: false,
      votes: new Map(),         // voterSocketId -> targetToken
      impostorToken: null,      // token string
      scores: new Map()         // email -> {accuserWins, impostorWins, lastName, displayName}
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    cb({ ok: true, code });
    io.to(code).emit("room_update", roomState(code));
  });

  // Players must have authenticated via google_auth first
  socket.on("join_room", ({ code, name }, cb) => {
    code = String(code||"").trim().toUpperCase();
    name = String(name||"").trim().slice(0, 20);

    if (!rooms.has(code)) return cb({ ok: false, error: "Código no válido." });
    const room = rooms.get(code);
    if (room.started) return cb({ ok: false, error: "La partida ya empezó." });
    if (!name) return cb({ ok: false, error: "Escribe tu nombre." });
    if (socket.id === room.hostId) return cb({ ok:false, error:"El host no participa como jugador." });

    const user = socket.data.user;
    if (!user?.email) return cb({ ok:false, error:"Primero inicia sesión con Google." });
    const email = user.email;

    // Prevent duplicate emails in same room
    for (const p of room.players.values()){
      if (p.email === email) return cb({ ok:false, error:"Este correo ya está dentro de la sala." });
    }

    let t;
    do { t = token6(); } while ([...room.players.values()].some(p => p.token === t));

    room.players.set(socket.id, { name, email, token: t, joinedAt: now() });

    if (!room.scores.has(email)){
      room.scores.set(email, { accuserWins: 0, impostorWins: 0, lastName: name, displayName: name });
    } else {
      const s = room.scores.get(email);
      s.lastName = name;
      s.displayName = name;
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;

    cb({ ok: true, email });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("start_game", ({ code }, cb) => {
    code = String(code||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:"Sala no encontrada." });
    if (socket.id !== room.hostId) return cb?.({ ok:false, error:"Solo el host puede iniciar." });

    if (room.players.size < MIN_PLAYERS) return cb({ ok:false, error:`Mínimo ${MIN_PLAYERS} jugadores (sin contar al host).` });

    room.started = true;
    room.voteOpen = false;
    room.votes = new Map();

    const playerTokens = Array.from(room.players.values()).map(p => p.token);
    room.impostorToken = playerTokens[Math.floor(Math.random() * playerTokens.length)];

    for (const [sid, p] of room.players.entries()) {
      const role = (p.token === room.impostorToken) ? "IMPOSTOR" : "CREWMATE";
      const shown = (role === "IMPOSTOR") ? "IMPOSTOR" : room.word;
      io.to(sid).emit("reveal", { code, name: p.name, role, shown });
    }

    io.to(room.hostId).emit("host_started", { code, playerCount: room.players.size });
    cb({ ok:true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("open_vote", ({ code }, cb) => {
    code = String(code||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:"Sala no encontrada." });
    if (socket.id !== room.hostId) return cb?.({ ok:false, error:"Solo el host puede abrir la votación." });
    if (!room.started) return cb?.({ ok:false, error:"Primero inicia la partida." });

    room.voteOpen = true;
    room.votes = new Map();

    io.to(code).emit("vote_open", { code, ...voteState(room) });
    cb?.({ ok:true });
    io.to(code).emit("room_update", roomState(code));
  });

  socket.on("cast_vote", ({ code, targetToken }, cb) => {
    code = String(code||"").trim().toUpperCase();
    targetToken = String(targetToken||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:"Sala no encontrada." });
    if (!room.voteOpen) return cb?.({ ok:false, error:"La votación no está abierta." });
    if (socket.id === room.hostId) return cb?.({ ok:false, error:"El host no vota." });
    if (!room.players.has(socket.id)) return cb?.({ ok:false, error:"No estás en la sala." });

    const me = room.players.get(socket.id);
    if (me.token === targetToken) return cb?.({ ok:false, error:"No puedes votarte a ti mismo." });
    if (![...room.players.values()].some(p => p.token === targetToken)) return cb?.({ ok:false, error:"Objetivo no válido." });

    room.votes.set(socket.id, targetToken);
    cb?.({ ok:true });
    io.to(code).emit("vote_update", { code, ...voteState(room) });
  });

  socket.on("close_vote", ({ code }, cb) => {
    code = String(code||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:"Sala no encontrada." });
    if (socket.id !== room.hostId) return cb?.({ ok:false, error:"Solo el host puede cerrar." });

    room.voteOpen = false;

    const vs = voteState(room);
    const counts = vs.counts;
    const maxVotes = Math.max(0, ...Object.values(counts));
    const topTokens = Object.entries(counts).filter(([t,c])=>c===maxVotes && maxVotes>0).map(([t])=>t);

    const impostorToken = room.impostorToken;
    const impostorPlayer = [...room.players.values()].find(p => p.token === impostorToken);
    const impostorName = impostorPlayer ? impostorPlayer.name : "???";

    const caught = topTokens.includes(impostorToken);

    if (caught){
      for (const [voterSid, target] of room.votes.entries()){
        if (target === impostorToken && room.players.has(voterSid)){
          const p = room.players.get(voterSid);
          const s = room.scores.get(p.email);
          if (s) s.accuserWins = (s.accuserWins||0) + 1;
        }
      }
    } else {
      if (impostorPlayer){
        const s = room.scores.get(impostorPlayer.email);
        if (s) s.impostorWins = (s.impostorWins||0) + 1;
      }
    }

    const lb = leaderboard(room);

    io.to(code).emit("vote_closed", {
      code,
      ...vs,
      impostorName,
      impostorToken,
      caught,
      maxVotes,
      topTokens,
      leaderboard: lb
    });

    cb?.({ ok:true });
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
  room.votes.delete(socket.id);
  io.to(code).emit("room_update", roomState(code));

  if (room.voteOpen){
    io.to(code).emit("vote_update", { code, ...voteState(room) });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
