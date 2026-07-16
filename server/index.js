'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('./store');
const apiRouter = require('./routes');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0';

store.ensureLoaded();

const app = express();
app.use(express.json({ limit: '1mb' }));

// REST API
app.use('/api', apiRouter);

// 静态前端
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);

// 阶段2：pty 会话 WebSocket 将挂载到此 server 上
let sessionsMod = null;
try {
  sessionsMod = require('./sessions');
  if (typeof sessionsMod === 'function') {
    sessionsMod(server);
  }
} catch (err) {
  // 阶段1 尚无 sessions.js 或依赖未安装时，忽略，仅提供 CRUD/UI
  console.warn('[sessions] 终端会话模块未启用:', err.message);
}

// 当前正在运行的会话（供前端刷新徽标，与浏览器状态解耦）
app.get('/api/sessions', (req, res) => {
  const running = sessionsMod && sessionsMod.runningTaskIds ? sessionsMod.runningTaskIds() : [];
  res.json({ running });
});

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  WebSurface 已启动');
  console.log('  ----------------------------------------');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  for (const ip of getLanAddresses()) {
    console.log(`  局域网访问: http://${ip}:${PORT}`);
  }
  console.log('  ----------------------------------------');
  console.log('  手机/平板请连接同一局域网(WiFi)后访问上面的“局域网访问”地址');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});
