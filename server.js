const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const drawPlayers = new Map();  // socketId → { nickname, ready }
let drawCountdownTimer = null;
const drawRoundAnswered = new Map();  // room → boolean (라운드당 정답 1회만 허용)

io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  socket.on('join', ({ nickname, room }) => {
    socket.join(room);
    users.set(socket.id, { nickname, room });
    const roomCount = [...users.values()].filter(u => u.room === room).length;
    io.to(room).emit('system', `${nickname}님이 입장했습니다. (${room})`);
    io.to(room).emit('userCount', roomCount);
  });

  // 공개키 교환: 같은 방 상대방에게 전달
  socket.on('publicKey', (jwk) => {
    const user = users.get(socket.id);
    if (user) user.publicKey = jwk;
    if (user) socket.to(user.room).emit('publicKey', { id: socket.id, jwk });
  });

  // 상대방 공개키 요청
  socket.on('requestKeys', () => {
    const me = users.get(socket.id);
    if (!me) return;
    for (const [id, user] of users.entries()) {
      if (id !== socket.id && user.room === me.room && user.publicKey) {
        socket.emit('publicKey', { id, jwk: user.publicKey });
      }
    }
  });

  // 암호화된 메시지 릴레이 (서버는 내용을 볼 수 없음)
  socket.on('chat', (encryptedPayload) => {
    const user = users.get(socket.id);
    const nickname = user ? user.nickname : '익명';
    const room = user ? user.room : null;
    if (room) socket.to(room).emit('chat', {
      nickname,
      encrypted: encryptedPayload,
      time: new Date().toLocaleTimeString('ko-KR')
    });
  });

  function getRoom() { const u = users.get(socket.id); return u ? u.room : null; }
  function getNick() { const u = users.get(socket.id); return u ? u.nickname : '???'; }

  // ===== 오목 =====
  socket.on('gomoku:place', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('gomoku:place', { ...data, from: socket.id });
  });
  socket.on('gomoku:reset', () => {
    const room = getRoom(); if (room) io.to(room).emit('gomoku:reset');
  });

  // ===== 2048 2P =====
  socket.on('2048:update', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('2048:update', { ...data, nickname: getNick() });
  });
  socket.on('2048:reset', () => {
    const room = getRoom(); if (room) io.to(room).emit('2048:reset');
  });

  // ===== 지뢰찾기 2P =====
  socket.on('mine:init', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('mine:init', data);
  });
  socket.on('mine:reveal', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('mine:reveal', { ...data, from: socket.id });
  });
  socket.on('mine:flag', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('mine:flag', { ...data, from: socket.id });
  });
  socket.on('mine:reset', () => {
    const room = getRoom(); if (room) io.to(room).emit('mine:reset');
  });

  // ===== 타자 레이싱 =====
  socket.on('type:start', (data) => { const room = getRoom(); if (room) io.to(room).emit('type:start', data); });
  socket.on('type:progress', (data) => {
    const room = getRoom(); if (room) socket.to(room).emit('type:progress', data);
  });
  socket.on('type:finish', (data) => {
    const room = getRoom(); if (room) io.to(room).emit('type:finish', { ...data, nickname: getNick() });
  });

  // ===== 반응속도 배틀 =====
  socket.on('react:start', (data) => { const room = getRoom(); if (room) io.to(room).emit('react:start', data); });
  socket.on('react:click', (data) => {
    const room = getRoom(); if (room) io.to(room).emit('react:click', { ...data, id: socket.id, nickname: getNick() });
  });

  // ===== 그림 퀴즈 (최대 5인) =====
  socket.on('draw:join', () => {
    const room = getRoom();
    if (!room) return;
    // 방별 drawPlayers 필터
    const roomDrawCount = [...drawPlayers.values()].filter(p => p.room === room).length;
    if (roomDrawCount >= 5) { socket.emit('draw:full'); return; }
    drawPlayers.set(socket.id, { nickname: getNick(), ready: false, room });
    broadcastDrawLobby(room);
  });

  socket.on('draw:leave', () => {
    const room = getRoom();
    drawPlayers.delete(socket.id);
    if (room) broadcastDrawLobby(room);
    if (drawCountdownTimer) { clearInterval(drawCountdownTimer); drawCountdownTimer = null; if (room) io.to(room).emit('draw:countdown', { count: -1 }); }
  });

  socket.on('draw:toggleReady', () => {
    const p = drawPlayers.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastDrawLobby(p.room);
    checkDrawAllReady(p.room);
  });

  function broadcastDrawLobby(room) {
    const list = [];
    for (const [id, p] of drawPlayers) {
      if (p.room === room) list.push({ id, nickname: p.nickname, ready: p.ready });
    }
    io.to(room).emit('draw:lobby', list);
  }

  function checkDrawAllReady(room) {
    if (drawCountdownTimer) return;
    const players = [...drawPlayers.entries()].filter(([, p]) => p.room === room);
    if (players.length < 2) return;
    const allReady = players.every(([, p]) => p.ready);
    if (!allReady) return;

    let count = 5;
    io.to(room).emit('draw:countdown', { count });
    drawCountdownTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(drawCountdownTimer);
        drawCountdownTimer = null;
        const ids = players.map(([id]) => id);
        const drawerId = ids[Math.floor(Math.random() * ids.length)];
        drawRoundAnswered.set(room, false);
        io.to(room).emit('draw:assign', { drawerId });
        for (const [, p] of players) p.ready = false;
      } else {
        const roomPlayers = [...drawPlayers.entries()].filter(([, p]) => p.room === room);
        const stillAllReady = roomPlayers.every(([, p]) => p.ready);
        if (!stillAllReady || roomPlayers.length < 2) {
          clearInterval(drawCountdownTimer);
          drawCountdownTimer = null;
          io.to(room).emit('draw:countdown', { count: -1 });
          return;
        }
        io.to(room).emit('draw:countdown', { count });
      }
    }, 1000);
  }

  socket.on('draw:stroke', (data) => { const room = getRoom(); if (room) socket.to(room).emit('draw:stroke', data); });
  socket.on('draw:clear', () => { const room = getRoom(); if (room) socket.to(room).emit('draw:clear'); });
  socket.on('draw:word', (data) => {
    const room = getRoom();
    if (!room) return;
    drawRoundAnswered.set(room, false);  // 새 라운드 시작 — 정답 플래그 리셋
    socket.to(room).emit('draw:word', data);
  });
  socket.on('draw:guess', (data) => {
    const room = getRoom(); if (room) io.to(room).emit('draw:guess', { ...data, nickname: getNick() });
  });
  socket.on('draw:correct', (data) => {
    const room = getRoom();
    if (!room) return;
    // 라운드당 정답 1회만 허용 — 동시 정답 방지
    if (drawRoundAnswered.get(room)) return;
    drawRoundAnswered.set(room, true);
    io.to(room).emit('draw:correct', data);
  });

  // ===== 색깔 찾기 (1~5인) =====
  socket.on('color:start', (data) => { const room = getRoom(); if (room) io.to(room).emit('color:start', data); });
  socket.on('color:found', (data) => {
    const room = getRoom(); if (room) io.to(room).emit('color:found', { ...data, id: socket.id, nickname: getNick() });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const room = user.room;
      users.delete(socket.id);
      const roomCount = [...users.values()].filter(u => u.room === room).length;
      io.to(room).emit('system', `${user.nickname}님이 퇴장했습니다.`);
      io.to(room).emit('userCount', roomCount);
      io.to(room).emit('peerDisconnected', socket.id);
    }
    // 그림퀴즈 로비에서 제거
    if (drawPlayers.has(socket.id)) {
      const dp = drawPlayers.get(socket.id);
      const room = dp.room;
      drawPlayers.delete(socket.id);
      broadcastDrawLobby(room);
      const roomDrawPlayers = [...drawPlayers.values()].filter(p => p.room === room);
      if (drawCountdownTimer && (roomDrawPlayers.length < 2 || !roomDrawPlayers.every(p => p.ready))) {
        clearInterval(drawCountdownTimer); drawCountdownTimer = null;
        io.to(room).emit('draw:countdown', { count: -1 });
      }
    }
    console.log(`퇴장: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 9999;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`채팅 서버 실행 중: http://localhost:${PORT}`);
  console.log('E2E 암호화 활성화: ECDH P-521 + AES-256-GCM + HKDF-SHA512');
});
