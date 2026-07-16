'use strict';

// xterm.js 终端 + WebSocket 桥接（阶段2/3）
// 会话与页面解耦：切换任务时保留各自的 term 实例与连接。
// 终止进程、聊天式大段输入、断线重连回放。

(function () {
  // taskId -> instance
  // instance: { term, fit, ws, el, screen, toolbar, statusEl, task,
  //             connected, running, exitCode, started, reconnectTimer, manualClosed }
  const instances = new Map();
  let activeTaskId = null;

  const host = document.getElementById('terminal-host');
  const welcome = document.getElementById('welcome');

  function wsUrl(taskId) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws?taskId=${encodeURIComponent(taskId)}`;
  }

  function isRunning(taskId) {
    const inst = instances.get(taskId);
    return !!(inst && inst.running);
  }

  function refreshBadges() {
    if (window.App && window.App.render) window.App.render();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 大文本使用逐块确认协议，避免一次性写入 ConPTY 时丢失中间内容。
  const INPUT_CHUNK_SIZE = 1024;
  const FNV1A_OFFSET = 0x811c9dc5;
  const textEncoder = new TextEncoder();

  function extendIntegrity(current, text) {
    const bytes = textEncoder.encode(text);
    let checksum = current.checksum;
    for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
    return {
      textLength: current.textLength + text.length,
      byteLength: current.byteLength + bytes.length,
      checksum,
    };
  }

  function integrityMessage(integrity) {
    return {
      textLength: integrity.textLength,
      byteLength: integrity.byteLength,
      checksum: integrity.checksum.toString(16).padStart(8, '0'),
    };
  }

  function hasMatchingIntegrity(msg, expected) {
    return Number(msg.textLength) === expected.textLength &&
      Number(msg.byteLength) === expected.byteLength &&
      String(msg.checksum || '').toLowerCase() ===
        expected.checksum.toString(16).padStart(8, '0');
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString('zh-CN');
  }

  function setComposerBusy(inst, busy) {
    inst.composerText.disabled = busy;
    inst.composerSend.disabled = busy;
    inst.composerSend.textContent = busy ? '发送中…' : '发送并提交';
  }

  function setComposerStatus(inst, text, isError) {
    inst.composerStatus.textContent = text || '';
    inst.composerStatus.classList.toggle('is-error', !!isError);
  }

  function updateComposerCount(inst) {
    inst.composerCount.textContent = `${formatCount(inst.composerText.value.length)} 字符`;
  }

  function abortLargeInput(inst, message) {
    if (!inst.largeInput) return;
    inst.largeInput = null;
    setComposerBusy(inst, false);
    setComposerStatus(inst, message || '发送已中断，内容已保留', true);
  }

  function sendNextLargeChunk(inst) {
    const job = inst.largeInput;
    if (!job || job.waiting || !inst.ws || inst.ws.readyState !== WebSocket.OPEN) return;

    if (job.pending) {
      job.waiting = 'ack';
      inst.ws.send(JSON.stringify({
        type: 'large_input_chunk', id: job.id,
        seq: job.pending.seq, data: job.pending.data,
      }));
      return;
    }

    let data = '';
    let endOffset = job.offset;
    if (job.offset < job.text.length) {
      let end = Math.min(job.offset + INPUT_CHUNK_SIZE, job.text.length);
      const last = job.text.charCodeAt(end - 1);
      if (end < job.text.length && last >= 0xD800 && last <= 0xDBFF) end += 1;
      data = job.text.slice(job.offset, end);
      endOffset = end;
    } else {
      job.waiting = 'complete';
      inst.ws.send(JSON.stringify({
        type: 'large_input_end', id: job.id, ...integrityMessage(job.totalIntegrity),
      }));
      return;
    }

    job.pending = {
      seq: job.nextSeq,
      data,
      endOffset,
      integrity: extendIntegrity(job.integrity, data),
    };
    sendNextLargeChunk(inst);
  }

  function startLargeInput(inst) {
    if (inst.largeInput) return;
    const text = inst.composerText.value;
    if (!text.length) {
      setComposerStatus(inst, '请输入内容', true);
      inst.composerText.focus();
      return;
    }
    if (!inst.ws || inst.ws.readyState !== WebSocket.OPEN || !inst.running) {
      setComposerStatus(inst, '终端尚未连接或进程已退出', true);
      return;
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const integrity = { textLength: 0, byteLength: 0, checksum: FNV1A_OFFSET };
    const totalIntegrity = extendIntegrity(integrity, text);
    inst.largeInput = {
      id, text, integrity, totalIntegrity,
      offset: 0, nextSeq: 0, pending: null, waiting: 'ready',
    };
    setComposerBusy(inst, true);
    setComposerStatus(inst, `准备校验并提交 ${formatCount(text.length)} 字符…`);
    inst.ws.send(JSON.stringify({
      type: 'large_input_start',
      id,
      overwrite: inst.task.kind === 'powershell',
      ...integrityMessage(totalIntegrity),
    }));
  }

  function handleLargeInputMessage(inst, msg) {
    const job = inst.largeInput;
    if (!job || msg.id !== job.id) return;

    if (msg.type === 'large_input_ready') {
      const expected = Number(msg.expectedSeq);
      if (job.pending && expected === job.pending.seq + 1) {
        if (!hasMatchingIntegrity(msg, job.pending.integrity)) {
          abortLargeInput(inst, '服务端接收校验不一致；内容已保留，CLI 中保留已输入部分');
          return;
        }
        job.offset = job.pending.endOffset;
        job.integrity = job.pending.integrity;
        job.nextSeq = expected;
        job.pending = null;
      } else if (expected !== job.nextSeq) {
        abortLargeInput(inst, '续传序号不一致，内容已保留，请重新发送');
        return;
      } else if (!hasMatchingIntegrity(msg, job.integrity)) {
        abortLargeInput(inst, '续传完整性校验不一致；内容已保留，CLI 中保留已输入部分');
        return;
      }
      job.waiting = null;
      sendNextLargeChunk(inst);
      return;
    }
    if (msg.type === 'large_input_ack' && job.pending && job.pending.seq === msg.seq) {
      if (!hasMatchingIntegrity(msg, job.pending.integrity)) {
        abortLargeInput(inst, '服务端接收校验不一致；内容已保留，CLI 中保留已输入部分');
        return;
      }
      job.offset = job.pending.endOffset;
      job.integrity = job.pending.integrity;
      job.nextSeq = msg.seq + 1;
      job.pending = null;
      job.waiting = null;
      setComposerStatus(inst, `正在校验 ${formatCount(job.offset)} / ${formatCount(job.text.length)} 字符`);
      sendNextLargeChunk(inst);
      return;
    }
    if (msg.type === 'large_input_complete') {
      if (!hasMatchingIntegrity(msg, job.totalIntegrity)) {
        abortLargeInput(inst, '完成确认的校验值不一致；内容已保留，请检查 CLI 输入区');
        return;
      }
      const sent = job.text.length;
      inst.largeInput = null;
      inst.composerText.value = '';
      setComposerBusy(inst, false);
      updateComposerCount(inst);
      setComposerStatus(inst, `已完整提交 ${formatCount(sent)} 字符`);
      inst.composerText.focus();
      return;
    }
    if (msg.type === 'large_input_error') {
      abortLargeInput(inst, msg.message || '发送失败，内容已保留');
    }
  }

  function focusComposer(taskId) {
    const inst = instances.get(taskId || activeTaskId);
    if (!inst) return;
    inst.composerText.focus();
    const len = inst.composerText.value.length;
    try { inst.composerText.setSelectionRange(len, len); } catch (_) {}
  }

  function setComposerHeight(inst, requested, persist) {
    const toolbarHeight = inst.toolbar.offsetHeight || 40;
    const splitterHeight = inst.splitter.offsetHeight || 7;
    const available = Math.max(240, inst.el.clientHeight - toolbarHeight - splitterHeight);
    const height = Math.round(Math.min(Math.max(120, requested), available - 120));
    inst.el.style.setProperty('--composer-h', `${height}px`);
    if (persist) {
      try { localStorage.setItem('websurface.composerHeight', String(height)); } catch (_) {}
    }
    fitNow(inst);
  }

  function setupSplitter(inst) {
    let dragging = false;

    function move(clientY) {
      const rect = inst.el.getBoundingClientRect();
      setComposerHeight(inst, rect.bottom - clientY, false);
    }
    function stop() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing-terminal');
      const height = inst.composer.getBoundingClientRect().height;
      setComposerHeight(inst, height, true);
    }

    inst.splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      document.body.classList.add('is-resizing-terminal');
      try { inst.splitter.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    inst.splitter.addEventListener('pointermove', (e) => {
      if (dragging) move(e.clientY);
    });
    inst.splitter.addEventListener('pointerup', stop);
    inst.splitter.addEventListener('pointercancel', stop);
    inst.splitter.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const current = inst.composer.getBoundingClientRect().height;
      setComposerHeight(inst, current + (e.key === 'ArrowUp' ? 16 : -16), true);
    });
  }

  // ============ 实例构建 ============
  function createInstance(task) {
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    wrap.style.display = 'none';

    // 工具条
    const toolbar = document.createElement('div');
    toolbar.className = 'term-toolbar';
    toolbar.innerHTML = `
      <span class="term-title">${esc(task.name)}</span>
      <span class="term-status">连接中…</span>
      <span class="term-kind">${esc(task.kind)}</span>
      <span class="term-toolbar-spacer"></span>
      <button class="term-btn term-btn-composer" title="聚焦输入区 (Ctrl+G)">⌨ 输入区</button>
      <button class="term-btn term-btn-kill" title="终止该任务的进程">■ 终止进程</button>`;

    const screen = document.createElement('div');
    screen.className = 'term-screen';

    const splitter = document.createElement('div');
    splitter.className = 'term-splitter';
    splitter.tabIndex = 0;
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-label', '调整终端与输入区高度');
    splitter.setAttribute('aria-orientation', 'horizontal');

    const composer = document.createElement('section');
    composer.className = 'composer-panel';
    composer.innerHTML = `
      <div class="composer-head">
        <span class="composer-title">聊天输入</span>
        <span class="composer-status" aria-live="polite"></span>
        <span class="composer-count">0 字符</span>
      </div>
      <textarea class="composer-text" spellcheck="false"
        placeholder="输入或粘贴内容，Ctrl+Enter 直接提交"></textarea>
      <div class="composer-actions">
        <span class="composer-shortcut">Ctrl+Enter</span>
        <button class="btn btn-primary composer-send" type="button">发送并提交</button>
      </div>`;

    wrap.appendChild(toolbar);
    wrap.appendChild(screen);
    wrap.appendChild(splitter);
    wrap.appendChild(composer);
    host.appendChild(wrap);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      theme: { background: '#11111b', foreground: '#cdd6f4', cursor: '#89b4fa' },
      scrollback: 8000,
      allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(screen);

    const inst = {
      term, fit, ws: null, el: wrap, screen, toolbar, splitter, composer,
      statusEl: toolbar.querySelector('.term-status'),
      composerText: composer.querySelector('.composer-text'),
      composerSend: composer.querySelector('.composer-send'),
      composerStatus: composer.querySelector('.composer-status'),
      composerCount: composer.querySelector('.composer-count'),
      task, connected: false, running: false, exitCode: null,
      started: false, reconnectTimer: null, manualClosed: false, largeInput: null,
    };
    instances.set(task.id, inst);

    let savedHeight = 230;
    try { savedHeight = Number(localStorage.getItem('websurface.composerHeight')) || savedHeight; } catch (_) {}
    wrap.style.setProperty('--composer-h', `${savedHeight}px`);
    setupSplitter(inst);

    if (typeof ResizeObserver !== 'undefined') {
      let fitFrame = null;
      inst.resizeObserver = new ResizeObserver(() => {
        if (fitFrame != null || inst.el.style.display === 'none') return;
        fitFrame = requestAnimationFrame(() => {
          fitFrame = null;
          if (inst.el.style.display !== 'none') fitNow(inst);
        });
      });
      inst.resizeObserver.observe(screen);
    }

    inst.composerText.addEventListener('input', () => {
      updateComposerCount(inst);
      if (!inst.largeInput) setComposerStatus(inst, '');
    });
    inst.composerText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        startLargeInput(inst);
      }
    });
    inst.composerSend.addEventListener('click', () => startLargeInput(inst));

    // 键盘输入 → 后端
    term.onData((data) => {
      if (inst.largeInput) return;
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        inst.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // 尺寸变化 → 通知后端
    term.onResize(({ cols, rows }) => {
      if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
        inst.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Ctrl+G 保留为快速跳转，但不再弹出模态框。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
          (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        focusComposer(task.id);
        return false;
      }
      return true;
    });

    // 工具条按钮
    toolbar.querySelector('.term-btn-composer').addEventListener('click', () => focusComposer(task.id));
    toolbar.querySelector('.term-btn-kill').addEventListener('click', () => confirmKill(inst));

    updateStatus(inst);
    connect(inst);
    return inst;
  }

  function updateStatus(inst) {
    const el = inst.statusEl;
    if (!el) return;
    if (!inst.connected) {
      el.textContent = '● 未连接'; el.className = 'term-status status-off';
    } else if (inst.running) {
      el.textContent = '● 运行中'; el.className = 'term-status status-run';
    } else {
      el.textContent = `● 已退出${inst.exitCode != null ? '（码 ' + inst.exitCode + '）' : ''}`;
      el.className = 'term-status status-off';
    }
  }

  function connect(inst) {
    const task = inst.task;
    // 清理旧连接
    if (inst.ws) {
      try { inst.ws.onclose = null; inst.ws.close(); } catch (_) {}
    }
    const ws = new WebSocket(wsUrl(task.id));
    inst.ws = ws;
    inst.manualClosed = false;

    ws.onopen = () => {
      inst.connected = true;
      inst.term.clear();
      const size = fitNow(inst) || {};
      ws.send(JSON.stringify({ type: 'start', cols: size.cols, rows: size.rows }));
      updateStatus(inst);
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      switch (msg.type) {
        case 'replay':
          inst.term.write(msg.data);
          break;
        case 'output':
          inst.term.write(msg.data);
          break;
        case 'status':
          inst.running = !!msg.running;
          inst.exitCode = msg.exitCode;
          updateStatus(inst);
          refreshBadges();
          if (inst.largeInput && inst.running) {
            inst.largeInput.waiting = 'ready';
            ws.send(JSON.stringify({
              type: 'large_input_start',
              id: inst.largeInput.id,
              overwrite: inst.task.kind === 'powershell',
              ...integrityMessage(inst.largeInput.totalIntegrity),
            }));
          }
          break;
        case 'exit':
          inst.running = false;
          inst.exitCode = msg.code;
          abortLargeInput(inst, '进程已退出，未完成的内容已保留');
          inst.term.write(`\r\n\x1b[90m[进程已退出，退出码 ${msg.code}]\x1b[0m\r\n`);
          updateStatus(inst);
          refreshBadges();
          break;
        case 'error':
          inst.term.write(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m\r\n`);
          break;
        case 'large_input_ready':
        case 'large_input_ack':
        case 'large_input_complete':
        case 'large_input_error':
          handleLargeInputMessage(inst, msg);
          break;
      }
    };

    ws.onclose = () => {
      inst.connected = false;
      if (inst.largeInput) {
        inst.largeInput.waiting = 'resume';
        setComposerStatus(inst, '连接中断，正在续传…', true);
      }
      updateStatus(inst);
      // 非主动关闭且是当前活动任务时，自动重连（服务器会话仍在，重连即回放）
      if (!inst.manualClosed && (activeTaskId === task.id || inst.largeInput)) {
        scheduleReconnect(inst);
      }
    };
    ws.onerror = () => {
      inst.connected = false;
      updateStatus(inst);
    };
  }

  function scheduleReconnect(inst) {
    if (inst.reconnectTimer) return;
    inst.reconnectTimer = setTimeout(() => {
      inst.reconnectTimer = null;
      if ((activeTaskId === inst.task.id || inst.largeInput) &&
          (!inst.ws || inst.ws.readyState === WebSocket.CLOSED)) {
        connect(inst);
      }
    }, 1000);
  }

  function fitNow(inst) {
    try {
      inst.fit.fit();
      return { cols: inst.term.cols, rows: inst.term.rows };
    } catch (_) { return null; }
  }

  // 打开（或切到）某任务的终端
  function open(task) {
    welcome.style.display = 'none';
    activeTaskId = task.id;

    for (const [id, inst] of instances) {
      inst.el.style.display = id === task.id ? 'flex' : 'none';
    }

    let inst = instances.get(task.id);
    if (!inst) {
      inst = createInstance(task);
    } else {
      inst.task = task;
      // 已存在但连接断了：重连（触发回放）
      if (!inst.ws || inst.ws.readyState === WebSocket.CLOSED || inst.ws.readyState === WebSocket.CLOSING) {
        connect(inst);
      }
    }
    inst.el.style.display = 'flex';
    setTimeout(() => {
      const composerHeight = inst.composer.getBoundingClientRect().height || 230;
      setComposerHeight(inst, composerHeight, false);
      inst.term.focus();
    }, 30);
  }

  // 终止进程（带确认）
  function confirmKill(inst) {
    if (!inst.running) return; // 已退出无需确认
    if (window.App && window.App.confirm) {
      window.App.confirm(`确定终止任务「${inst.task.name}」的进程？`, () => doKill(inst));
    } else if (window.confirm(`确定终止任务「${inst.task.name}」的进程？`)) {
      doKill(inst);
    }
  }

  function doKill(inst) {
    if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: 'kill' }));
    }
  }

  function kill(taskId) {
    const inst = instances.get(taskId || activeTaskId);
    if (inst) doKill(inst);
  }

  // 关闭并清理某任务的终端视图（不杀进程）
  function detach(taskId) {
    const inst = instances.get(taskId);
    if (!inst) return;
    inst.manualClosed = true;
    if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
    try { if (inst.ws) inst.ws.close(); } catch (_) {}
    try { if (inst.resizeObserver) inst.resizeObserver.disconnect(); } catch (_) {}
    try { inst.term.dispose(); } catch (_) {}
    inst.el.remove();
    instances.delete(taskId);
    if (activeTaskId === taskId) {
      activeTaskId = null;
      welcome.style.display = '';
    }
  }

  // 供外部按钮调用：聚焦当前任务输入区。
  function openBigInputActive() {
    if (activeTaskId) focusComposer(activeTaskId);
  }

  // 窗口尺寸变化时，重新 fit 当前活动终端
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (activeTaskId) {
        const inst = instances.get(activeTaskId);
        if (inst) {
          const composerHeight = inst.composer.getBoundingClientRect().height || 230;
          setComposerHeight(inst, composerHeight, false);
        }
      }
    }, 120);
  });

  window.Term = { open, kill, detach, isRunning, openBigInput: openBigInputActive };
})();
