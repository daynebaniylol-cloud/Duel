const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── БД в памяти ──
const users = new Map();      // username -> { passwordHash, stats }
const sessions = new Map();   // token -> username
const queue = [];             // очередь матчмейкинга
const rooms = new Map();      // roomId -> { p1, p2, state }

function hash(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}
function genRoomId() {
  return crypto.randomBytes(6).toString('hex');
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AIM DUEL SERVER OK');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.player = null; // { username, token, roomId, side }

  ws.send(JSON.stringify({ type: 'connected' }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── РЕГИСТРАЦИЯ ──
      case 'register': {
        const { username, password } = msg;
        if (!username || !password || username.length < 2 || username.length > 20) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Ник 2-20 символов' }));
        }
        if (users.has(username.toLowerCase())) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Ник занят' }));
        }
        users.set(username.toLowerCase(), {
          username,
          passwordHash: hash(password),
          stats: { kills: 0, deaths: 0, wins: 0, losses: 0 }
        });
        const token = genToken();
        sessions.set(token, username.toLowerCase());
        ws.player = { username, token };
        ws.send(JSON.stringify({ type: 'auth_ok', username, token, stats: users.get(username.toLowerCase()).stats }));
        break;
      }

      // ── ЛОГИН ──
      case 'login': {
        const { username, password } = msg;
        const user = users.get(username?.toLowerCase());
        if (!user || user.passwordHash !== hash(password)) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Неверный ник или пароль' }));
        }
        const token = genToken();
        sessions.set(token, username.toLowerCase());
        ws.player = { username: user.username, token };
        ws.send(JSON.stringify({ type: 'auth_ok', username: user.username, token, stats: user.stats }));
        break;
      }

      // ── МАТЧМЕЙКИНГ ──
      case 'find_match': {
        if (!ws.player) return ws.send(JSON.stringify({ type: 'error', text: 'Не авторизован' }));

        // Убрать из очереди если был
        const qi = queue.findIndex(q => q.ws === ws);
        if (qi !== -1) queue.splice(qi, 1);

        // Ищем соперника
        if (queue.length > 0) {
          const opponent = queue.shift();
          const roomId = genRoomId();

          ws.player.roomId = roomId;
          ws.player.side = 'p2';
          opponent.ws.player.roomId = roomId;
          opponent.ws.player.side = 'p1';

          const room = {
            id: roomId,
            p1: opponent.ws,
            p2: ws,
            state: { p1HP: 100, p2HP: 100, p1Score: 0, p2Score: 0, timeLeft: 60 }
          };
          rooms.set(roomId, room);

          // Уведомить обоих
          opponent.ws.send(JSON.stringify({
            type: 'match_found',
            roomId,
            side: 'p1',
            opponentName: ws.player.username
          }));
          ws.send(JSON.stringify({
            type: 'match_found',
            roomId,
            side: 'p2',
            opponentName: opponent.ws.player.username
          }));

          // Таймер раунда
          startRoundTimer(roomId);
        } else {
          queue.push({ ws, username: ws.player.username });
          ws.send(JSON.stringify({ type: 'in_queue', queueSize: queue.length }));
        }
        break;
      }

      // ── ОТМЕНА ОЧЕРЕДИ ──
      case 'cancel_queue': {
        const qi = queue.findIndex(q => q.ws === ws);
        if (qi !== -1) queue.splice(qi, 1);
        ws.send(JSON.stringify({ type: 'queue_cancelled' }));
        break;
      }

      // ── ДВИЖЕНИЕ ИГРОКА ──
      case 'player_move': {
        if (!ws.player?.roomId) return;
        const room = rooms.get(ws.player.roomId);
        if (!room) return;
        const opponent = ws.player.side === 'p1' ? room.p2 : room.p1;
        if (opponent.readyState === 1) {
          opponent.send(JSON.stringify({
            type: 'opponent_move',
            x: msg.x, y: msg.y, z: msg.z,
            yaw: msg.yaw, pitch: msg.pitch
          }));
        }
        break;
      }

      // ── ВЫСТРЕЛ ──
      case 'player_shoot': {
        if (!ws.player?.roomId) return;
        const room = rooms.get(ws.player.roomId);
        if (!room) return;
        const opponent = ws.player.side === 'p1' ? room.p2 : room.p1;
        if (opponent.readyState === 1) {
          opponent.send(JSON.stringify({
            type: 'opponent_shoot',
            dirX: msg.dirX, dirY: msg.dirY, dirZ: msg.dirZ
          }));
        }
        break;
      }

      // ── ПОПАДАНИЕ (сервер авторитарный) ──
      case 'hit': {
        if (!ws.player?.roomId) return;
        const room = rooms.get(ws.player.roomId);
        if (!room) return;

        const myState = ws.player.side === 'p1' ? 'p2HP' : 'p1HP';
        const damage = Math.max(0, Math.min(100, msg.damage || 0));
        room.state[myState] = Math.max(0, room.state[myState] - damage);

        const opponent = ws.player.side === 'p1' ? room.p2 : room.p1;

        // Отправить урон жертве
        if (opponent.readyState === 1) {
          opponent.send(JSON.stringify({
            type: 'take_damage',
            damage,
            isHeadshot: msg.isHeadshot || false,
            hp: room.state[myState]
          }));
        }

        // Смерть?
        if (room.state[myState] <= 0) {
          handleKill(room, ws.player.side);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // Убрать из очереди
    const qi = queue.findIndex(q => q.ws === ws);
    if (qi !== -1) queue.splice(qi, 1);

    // Уведомить соперника
    if (ws.player?.roomId) {
      const room = rooms.get(ws.player.roomId);
      if (room) {
        const opponent = ws.player.side === 'p1' ? room.p2 : room.p1;
        if (opponent && opponent.readyState === 1) {
          opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
        }
        rooms.delete(ws.player.roomId);
      }
    }

    if (ws.player?.token) sessions.delete(ws.player.token);
  });
});

function handleKill(room, killerSide) {
  if (killerSide === 'p1') {
    room.state.p1Score++;
    room.state.p2HP = 100;
    room.state.p1HP = 100;
    const kName = room.p1.player?.username || 'P1';
    const vName = room.p2.player?.username || 'P2';
    broadcastRoom(room, { type: 'kill', killerSide, killerName: kName, victimName: vName, scores: { p1: room.state.p1Score, p2: room.state.p2Score } });
  } else {
    room.state.p2Score++;
    room.state.p2HP = 100;
    room.state.p1HP = 100;
    const kName = room.p2.player?.username || 'P2';
    const vName = room.p1.player?.username || 'P1';
    broadcastRoom(room, { type: 'kill', killerSide, killerName: kName, victimName: vName, scores: { p1: room.state.p1Score, p2: room.state.p2Score } });
  }
}

function startRoundTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.state.timeLeft = 60;

  const interval = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r) return clearInterval(interval);
    r.state.timeLeft--;
    broadcastRoom(r, { type: 'timer', timeLeft: r.state.timeLeft });

    if (r.state.timeLeft <= 0) {
      clearInterval(interval);
      const winner = r.state.p1Score > r.state.p2Score ? 'p1' :
                     r.state.p2Score > r.state.p1Score ? 'p2' : 'draw';
      broadcastRoom(r, { type: 'round_end', winner, scores: { p1: r.state.p1Score, p2: r.state.p2Score } });

      // Обновить статы
      updateStats(r, winner);
      rooms.delete(roomId);
    }
  }, 1000);
}

function updateStats(room, winner) {
  const u1 = users.get(room.p1.player?.username?.toLowerCase());
  const u2 = users.get(room.p2.player?.username?.toLowerCase());
  if (u1) {
    u1.stats.kills += room.state.p1Score;
    u1.stats.deaths += room.state.p2Score;
    if (winner === 'p1') u1.stats.wins++; else if (winner === 'p2') u1.stats.losses++;
  }
  if (u2) {
    u2.stats.kills += room.state.p2Score;
    u2.stats.deaths += room.state.p1Score;
    if (winner === 'p2') u2.stats.wins++; else if (winner === 'p1') u2.stats.losses++;
  }
}

function broadcastRoom(room, msg) {
  const s = JSON.stringify(msg);
  if (room.p1.readyState === 1) room.p1.send(s);
  if (room.p2.readyState === 1) room.p2.send(s);
}

server.listen(PORT, () => {
  console.log(`AIM DUEL server running on port ${PORT}`);
});
