'use strict';

// pty 会话管理 + WebSocket 桥接
// 每个 task 最多一个活动会话；会话由服务器持有，与浏览器解耦。
// 关闭/刷新网页后会话继续运行，重连时先回放缓冲。

const { WebSocketServer } = require('ws');
const os = require('os');
const store = require('./store');

let pty = null;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (err) {
  console.warn('[sessions] 无法加载 node-pty，请先完成其原生二进制安装:', err.message);
}

// 每个会话保留的回放缓冲上限（按输出块累计的字符数近似 5000 行）
const SCROLLBACK_LIMIT = 200000; // 约 5000 行 * 40 字符
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const LARGE_INPUT_CHUNK_LIMIT = 1025; // 1024 code units，允许末尾补齐一个代理对
const LARGE_INPUT_PACE_MS = 10;
const LARGE_INPUT_TTL_MS = 60000;
const TUI_SUBMIT_DELAY_MS = 500;
const FNV1A_OFFSET = 0x811c9dc5;

function extendChecksum(checksum, text) {
  for (const byte of Buffer.from(text, 'utf8')) {
    checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
  }
  return checksum;
}

function checksumText(checksum) {
  return checksum.toString(16).padStart(8, '0');
}

function transferProgress(transfer) {
  return {
    textLength: transfer.textLength,
    byteLength: transfer.byteLength,
    checksum: checksumText(transfer.checksum),
  };
}

function validIntegrityMetadata(msg) {
  return Number.isSafeInteger(msg.textLength) && msg.textLength >= 0 &&
    Number.isSafeInteger(msg.byteLength) && msg.byteLength >= 0 &&
    typeof msg.checksum === 'string' && /^[0-9a-f]{8}$/i.test(msg.checksum);
}

// taskId -> session
// session: { taskId, proc, buffer:[], bufferLen, cols, rows, clients:Set<ws>, running,
//            exitCode, largeInput, completedLargeInputs:Map }
const sessions = new Map();

const SHELL = 'powershell.exe';

function launchCommandFor(kind) {
  if (kind === 'claude') return 'claude\r';
  if (kind === 'codex') return 'codex\r';
  return null; // 纯 powershell 不追加命令
}

function getSession(taskId) {
  return sessions.get(taskId) || null;
}

function isRunning(taskId) {
  const s = sessions.get(taskId);
  return !!(s && s.running);
}

// 返回当前正在运行的 taskId 列表（供前端刷新徽标，与浏览器状态解耦）
function runningTaskIds() {
  const ids = [];
  for (const [taskId, s] of sessions) {
    if (s.running) ids.push(taskId);
  }
  return ids;
}

function appendBuffer(session, data) {
  session.buffer.push(data);
  session.bufferLen += data.length;
  while (session.bufferLen > SCROLLBACK_LIMIT && session.buffer.length > 1) {
    const removed = session.buffer.shift();
    session.bufferLen -= removed.length;
  }
}

function broadcast(session, msg) {
  const text = JSON.stringify(msg);
  for (const ws of session.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(text); } catch (_) {}
    }
  }
}

function sendJson(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch (_) {}
}

function cleanLargeInputState(session) {
  const now = Date.now();
  if (session.largeInput && now - session.largeInput.lastSeen > LARGE_INPUT_TTL_MS) {
    session.largeInput = null;
  }
  for (const [id, completed] of session.completedLargeInputs) {
    if (now - completed.completedAt > LARGE_INPUT_TTL_MS) session.completedLargeInputs.delete(id);
  }
}

function largeInputError(ws, id, message) {
  sendJson(ws, { type: 'large_input_error', id, message });
}

function failLargeInput(session, ws, id, message) {
  if (session.largeInput && session.largeInput.submitTimer) {
    clearTimeout(session.largeInput.submitTimer);
  }
  session.largeInput = null;
  largeInputError(ws, id, message);
}

function completeLargeInput(session, transfer) {
  if (!session.largeInput || session.largeInput !== transfer || !session.running) return;
  try {
    session.proc.write('\r');
  } catch (_) {
    return failLargeInput(session, transfer.owner, transfer.id,
      '文本完整但提交回车写入失败；聊天内容已保留');
  }
  session.largeInput = null;
  const actual = transferProgress(transfer);
  const completed = { completedAt: Date.now(), ...actual };
  session.completedLargeInputs.set(transfer.id, completed);
  sendJson(transfer.owner, { type: 'large_input_complete', id: transfer.id, ...actual });
}

function startLargeInput(session, ws, msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  if (!id || id.length > 100) return largeInputError(ws, id, '无效的发送标识');
  if (!validIntegrityMetadata(msg)) return largeInputError(ws, id, '缺少有效的文本完整性信息');
  cleanLargeInputState(session);

  if (session.completedLargeInputs.has(id)) {
    sendJson(ws, { type: 'large_input_complete', id, ...session.completedLargeInputs.get(id) });
    return;
  }
  if (session.largeInput && session.largeInput.id !== id) {
    largeInputError(ws, id, '该终端正在接收另一段文本，请稍后重试');
    return;
  }
  if (session.largeInput) {
    if (session.largeInput.expectedTextLength !== msg.textLength ||
        session.largeInput.expectedByteLength !== msg.byteLength ||
        session.largeInput.expectedChecksum !== msg.checksum.toLowerCase()) {
      return failLargeInput(session, ws, id, '恢复发送时的完整性信息不一致；未提交，CLI 中保留已输入部分');
    }
    session.largeInput.owner = ws;
    session.largeInput.lastSeen = Date.now();
    // TUI 正在等待延迟提交时只更新连接归属；原定时器会向新连接发送完成确认。
    if (session.largeInput.submitting) return;
    sendJson(ws, {
      type: 'large_input_ready', id, expectedSeq: session.largeInput.expectedSeq,
      ...transferProgress(session.largeInput),
    });
    return;
  }

  session.largeInput = {
    id,
    expectedSeq: 0,
    owner: ws,
    lastSeen: Date.now(),
    expectedTextLength: msg.textLength,
    expectedByteLength: msg.byteLength,
    expectedChecksum: msg.checksum.toLowerCase(),
    textLength: 0,
    byteLength: 0,
    checksum: FNV1A_OFFSET,
  };
  // PowerShell 的独立输入区不应与提示符上已键入的内容拼接。只在首次开始时清行。
  if (msg.overwrite && session.kind === 'powershell') {
    try { session.proc.write('\x1b'); } catch (_) {}
  }
  setTimeout(() => {
    if (session.largeInput && session.largeInput.id === id) {
      sendJson(ws, {
        type: 'large_input_ready', id, expectedSeq: 0,
        ...transferProgress(session.largeInput),
      });
    }
  }, LARGE_INPUT_PACE_MS);
}

function acceptLargeInputChunk(session, ws, msg) {
  const transfer = session.largeInput;
  const id = typeof msg.id === 'string' ? msg.id : '';
  if (!transfer || transfer.id !== id) return largeInputError(ws, id, '发送事务不存在或已过期');
  if (transfer.owner !== ws) return largeInputError(ws, id, '请先恢复发送事务');
  if (!Number.isInteger(msg.seq) || msg.seq < 0 || typeof msg.data !== 'string' ||
      !msg.data.length || msg.data.length > LARGE_INPUT_CHUNK_LIMIT) {
    return largeInputError(ws, id, '文本块格式或大小无效');
  }

  transfer.lastSeen = Date.now();
  if (msg.seq < transfer.expectedSeq) {
    sendJson(ws, { type: 'large_input_ack', id, seq: msg.seq, ...transferProgress(transfer) });
    return;
  }
  if (msg.seq > transfer.expectedSeq) {
    largeInputError(ws, id, `文本块顺序错误，应为 ${transfer.expectedSeq}`);
    return;
  }

  try {
    session.proc.write(msg.data);
  } catch (_) {
    return failLargeInput(session, ws, id,
      '写入终端失败；未提交，聊天内容已保留，CLI 中保留已输入部分');
  }
  transfer.textLength += msg.data.length;
  transfer.byteLength += Buffer.byteLength(msg.data, 'utf8');
  transfer.checksum = extendChecksum(transfer.checksum, msg.data);
  transfer.expectedSeq += 1;
  setTimeout(() => {
    if (session.running) {
      sendJson(ws, { type: 'large_input_ack', id, seq: msg.seq, ...transferProgress(transfer) });
    }
  }, LARGE_INPUT_PACE_MS);
}

function finishLargeInput(session, ws, msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  cleanLargeInputState(session);
  if (session.completedLargeInputs.has(id)) {
    sendJson(ws, { type: 'large_input_complete', id, ...session.completedLargeInputs.get(id) });
    return;
  }
  if (!session.largeInput || session.largeInput.id !== id || session.largeInput.owner !== ws) {
    largeInputError(ws, id, '发送事务不存在或尚未恢复');
    return;
  }
  const transfer = session.largeInput;
  if (transfer.submitting) return;
  const actual = transferProgress(transfer);
  const matchesStart = transfer.textLength === transfer.expectedTextLength &&
    transfer.byteLength === transfer.expectedByteLength &&
    actual.checksum === transfer.expectedChecksum;
  const matchesEnd = validIntegrityMetadata(msg) &&
    transfer.textLength === msg.textLength && transfer.byteLength === msg.byteLength &&
    actual.checksum === msg.checksum.toLowerCase();
  if (!matchesStart || !matchesEnd) {
    return failLargeInput(session, ws, id,
      '文本完整性校验失败；未提交，聊天内容已保留，CLI 中保留已输入部分');
  }

  // Codex/Claude TUI 需要时间消费最后一批按键；过早写入回车会被 TUI 忽略。
  const submitDelay = session.kind === 'powershell' ? 0 : TUI_SUBMIT_DELAY_MS;
  transfer.submitting = true;
  transfer.lastSeen = Date.now();
  if (submitDelay) {
    transfer.submitTimer = setTimeout(() => completeLargeInput(session, transfer), submitDelay);
  } else {
    completeLargeInput(session, transfer);
  }
}

// 创建或返回已有会话
function ensureSession(task, cols, rows) {
  let session = sessions.get(task.id);
  if (session && session.running) return session;

  if (!pty) throw new Error('node-pty 未安装，无法启动终端会话');

  const cwd = task.cwd && task.cwd.trim() ? task.cwd : os.homedir();
  let proc;
  try {
    proc = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: cols || DEFAULT_COLS,
      rows: rows || DEFAULT_ROWS,
      cwd,
      env: process.env,
    });
  } catch (err) {
    // cwd 不存在等情况，退回到用户目录再试一次
    proc = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: cols || DEFAULT_COLS,
      rows: rows || DEFAULT_ROWS,
      cwd: os.homedir(),
      env: process.env,
    });
  }

  session = {
    taskId: task.id,
    kind: task.kind,
    proc,
    buffer: [],
    bufferLen: 0,
    cols: cols || DEFAULT_COLS,
    rows: rows || DEFAULT_ROWS,
    clients: new Set(),
    running: true,
    exitCode: null,
    largeInput: null,
    completedLargeInputs: new Map(),
  };
  sessions.set(task.id, session);

  proc.onData((data) => {
    appendBuffer(session, data);
    broadcast(session, { type: 'output', data });
  });

  proc.onExit(({ exitCode }) => {
    session.running = false;
    session.exitCode = exitCode;
    session.largeInput = null;
    broadcast(session, { type: 'exit', code: exitCode });
  });

  // 若为 claude/codex，pty 建好后自动写入命令
  const cmd = launchCommandFor(task.kind);
  if (cmd) {
    // 稍等 shell 就绪再发送
    setTimeout(() => {
      if (session.running) {
        try { proc.write(cmd); } catch (_) {}
      }
    }, 600);
  }

  return session;
}

function killSession(taskId) {
  const session = sessions.get(taskId);
  if (!session) return false;
  if (session.proc && session.running) {
    try {
      // node-pty 的 kill 在 Windows 上会终止整个进程树
      session.proc.kill();
    } catch (err) {
      console.warn('[sessions] kill 失败:', err.message);
    }
  }
  return true;
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // 从查询串取 taskId： /ws?taskId=t_xxx
    let taskId = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      taskId = url.searchParams.get('taskId');
    } catch (_) {}

    if (!taskId) {
      ws.send(JSON.stringify({ type: 'error', message: '缺少 taskId' }));
      ws.close();
      return;
    }

    const found = store.findTask(taskId);
    if (!found) {
      ws.send(JSON.stringify({ type: 'error', message: '任务不存在' }));
      ws.close();
      return;
    }
    const task = found.task;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.type === 'start') {
        // 建立/复用会话并把该 ws 加入订阅，回放缓冲
        let session;
        try {
          session = ensureSession(task, msg.cols, msg.rows);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
          return;
        }
        session.clients.add(ws);
        ws._taskId = taskId;

        // 先发状态，再回放缓冲
        ws.send(JSON.stringify({ type: 'status', running: session.running, exitCode: session.exitCode }));
        if (session.buffer.length) {
          ws.send(JSON.stringify({ type: 'replay', data: session.buffer.join('') }));
        }
        // 用客户端尺寸同步一次
        if (msg.cols && msg.rows && session.running) {
          try { session.proc.resize(msg.cols, msg.rows); session.cols = msg.cols; session.rows = msg.rows; } catch (_) {}
        }
        return;
      }

      const session = sessions.get(taskId);

      if (msg.type === 'large_input_start') {
        if (session && session.running) startLargeInput(session, ws, msg);
        else largeInputError(ws, msg.id, '终端进程未运行');
        return;
      }

      if (msg.type === 'large_input_chunk') {
        if (session && session.running) acceptLargeInputChunk(session, ws, msg);
        else largeInputError(ws, msg.id, '终端进程未运行');
        return;
      }

      if (msg.type === 'large_input_end') {
        if (session && session.running) finishLargeInput(session, ws, msg);
        else largeInputError(ws, msg.id, '终端进程未运行');
        return;
      }

      if (msg.type === 'input') {
        if (session && session.running && typeof msg.data === 'string') {
          cleanLargeInputState(session);
          if (session.largeInput) return;
          try { session.proc.write(msg.data); } catch (_) {}
        }
        return;
      }

      if (msg.type === 'resize') {
        if (session && session.running && msg.cols && msg.rows) {
          try {
            session.proc.resize(msg.cols, msg.rows);
            session.cols = msg.cols;
            session.rows = msg.rows;
          } catch (_) {}
        }
        return;
      }

      if (msg.type === 'kill') {
        killSession(taskId);
        return;
      }
    });

    ws.on('close', () => {
      const session = sessions.get(taskId);
      if (session) session.clients.delete(ws);
      // 注意：不因为客户端断开而结束会话（会话与浏览器解耦）
    });

    ws.on('error', () => {
      const session = sessions.get(taskId);
      if (session) session.clients.delete(ws);
    });
  });

  console.log('[sessions] 终端 WebSocket 已就绪 (path=/ws)');
}

// 导出给 index.js 的 attach 函数；同时暴露状态查询
module.exports = attach;
module.exports.isRunning = isRunning;
module.exports.runningTaskIds = runningTaskIds;
module.exports.getSession = getSession;
module.exports.killSession = killSession;
