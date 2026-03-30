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

io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  socket.on('join', (nickname) => {
    users.set(socket.id, { nickname });
    io.emit('system', `${nickname}님이 입장했습니다.`);
    io.emit('userCount', users.size);
  });

  // 공개키 교환: 상대방에게 전달
  socket.on('publicKey', (jwk) => {
    const user = users.get(socket.id);
    if (user) user.publicKey = jwk;
    socket.broadcast.emit('publicKey', { id: socket.id, jwk });
  });

  // 상대방 공개키 요청
  socket.on('requestKeys', () => {
    for (const [id, user] of users.entries()) {
      if (id !== socket.id && user.publicKey) {
        socket.emit('publicKey', { id, jwk: user.publicKey });
      }
    }
  });

  // 암호화된 메시지 릴레이 (서버는 내용을 볼 수 없음)
  socket.on('chat', (encryptedPayload) => {
    const user = users.get(socket.id);
    const nickname = user ? user.nickname : '익명';
    socket.broadcast.emit('chat', {
      nickname,
      encrypted: encryptedPayload,
      time: new Date().toLocaleTimeString('ko-KR')
    });
  });

  // ===== 오목 =====
  socket.on('gomoku:place', (data) => {
    socket.broadcast.emit('gomoku:place', { ...data, from: socket.id });
  });

  socket.on('gomoku:reset', () => {
    io.emit('gomoku:reset');
  });

  // ===== 2048 2P =====
  socket.on('2048:update', (data) => {
    const user = users.get(socket.id);
    socket.broadcast.emit('2048:update', { ...data, nickname: user ? user.nickname : '???' });
  });
  socket.on('2048:reset', () => {
    io.emit('2048:reset');
  });

  // ===== 지뢰찾기 2P =====
  socket.on('mine:init', (data) => {
    // 호스트가 보드 생성 후 공유
    socket.broadcast.emit('mine:init', data);
  });
  socket.on('mine:reveal', (data) => {
    socket.broadcast.emit('mine:reveal', { ...data, from: socket.id });
  });
  socket.on('mine:flag', (data) => {
    socket.broadcast.emit('mine:flag', { ...data, from: socket.id });
  });
  socket.on('mine:reset', () => {
    io.emit('mine:reset');
  });

  // ===== 타자 레이싱 =====
  socket.on('type:start', (data) => { io.emit('type:start', data); });
  socket.on('type:progress', (data) => {
    socket.broadcast.emit('type:progress', data);
  });
  socket.on('type:finish', (data) => {
    const user = users.get(socket.id);
    io.emit('type:finish', { ...data, nickname: user ? user.nickname : '???' });
  });

  // ===== 반응속도 배틀 =====
  socket.on('react:start', (data) => { io.emit('react:start', data); });
  socket.on('react:click', (data) => {
    const user = users.get(socket.id);
    io.emit('react:click', { ...data, id: socket.id, nickname: user ? user.nickname : '???' });
  });

  // ===== 그림 퀴즈 (최대 5인) =====
  socket.on('draw:join', () => {
    if (drawPlayers.size >= 5) { socket.emit('draw:full'); return; }
    const user = users.get(socket.id);
    drawPlayers.set(socket.id, { nickname: user ? user.nickname : '???', ready: false });
    broadcastDrawLobby();
  });

  socket.on('draw:leave', () => {
    drawPlayers.delete(socket.id);
    broadcastDrawLobby();
    // 카운트다운 중이면 취소
    if (drawCountdownTimer) { clearInterval(drawCountdownTimer); drawCountdownTimer = null; io.emit('draw:countdown', { count: -1 }); }
  });

  socket.on('draw:toggleReady', () => {
    const p = drawPlayers.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastDrawLobby();
    checkDrawAllReady();
  });

  function broadcastDrawLobby() {
    const list = [];
    for (const [id, p] of drawPlayers) list.push({ id, nickname: p.nickname, ready: p.ready });
    io.emit('draw:lobby', list);
  }

  function checkDrawAllReady() {
    if (drawCountdownTimer) return; // 이미 카운트다운 중
    const players = [...drawPlayers.entries()];
    if (players.length < 2) return;
    const allReady = players.every(([, p]) => p.ready);
    if (!allReady) return;

    // 5초 카운트다운 시작
    let count = 5;
    io.emit('draw:countdown', { count });
    drawCountdownTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(drawCountdownTimer);
        drawCountdownTimer = null;
        // 랜덤 출제자 지정
        const ids = [...drawPlayers.keys()];
        const drawerId = ids[Math.floor(Math.random() * ids.length)];
        io.emit('draw:assign', { drawerId });
        // 레디 초기화
        for (const p of drawPlayers.values()) p.ready = false;
      } else {
        // 중간에 누가 레디 해제하면 취소
        const stillAllReady = [...drawPlayers.values()].every(p => p.ready);
        if (!stillAllReady || drawPlayers.size < 2) {
          clearInterval(drawCountdownTimer);
          drawCountdownTimer = null;
          io.emit('draw:countdown', { count: -1 }); // 취소
          return;
        }
        io.emit('draw:countdown', { count });
      }
    }, 1000);
  }

  socket.on('draw:stroke', (data) => { socket.broadcast.emit('draw:stroke', data); });
  socket.on('draw:clear', () => { socket.broadcast.emit('draw:clear'); });
  socket.on('draw:word', (data) => { socket.broadcast.emit('draw:word', data); });
  socket.on('draw:guess', (data) => {
    const user = users.get(socket.id);
    io.emit('draw:guess', { ...data, nickname: user ? user.nickname : '???' });
  });
  socket.on('draw:correct', (data) => { io.emit('draw:correct', data); });

  // ===== 색깔 찾기 =====
  socket.on('color:start', (data) => { io.emit('color:start', data); });
  socket.on('color:found', (data) => {
    const user = users.get(socket.id);
    io.emit('color:found', { ...data, id: socket.id, nickname: user ? user.nickname : '???' });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('system', `${user.nickname}님이 퇴장했습니다.`);
      io.emit('userCount', users.size);
      io.emit('peerDisconnected', socket.id);
    }
    // 그림퀴즈 로비에서 제거
    if (drawPlayers.has(socket.id)) {
      drawPlayers.delete(socket.id);
      broadcastDrawLobby();
      if (drawCountdownTimer && (drawPlayers.size < 2 || ![...drawPlayers.values()].every(p => p.ready))) {
        clearInterval(drawCountdownTimer); drawCountdownTimer = null;
        io.emit('draw:countdown', { count: -1 });
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
