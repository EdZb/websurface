'use strict';

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const store = require('../server/store');
store.findTask = (id) => ({
  task: { id, name: 'integration-test', kind: 'powershell', cwd: process.cwd() },
});

const sessions = require('../server/sessions');
const server = http.createServer();
sessions(server);

const FNV1A_OFFSET = 0x811c9dc5;

function integrity(text) {
  let checksum = FNV1A_OFFSET;
  const bytes = Buffer.from(text, 'utf8');
  for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
  return {
    textLength: text.length,
    byteLength: bytes.length,
    checksum: checksum.toString(16).padStart(8, '0'),
  };
}

function runTransfer(port, taskId, text, expectedOutput, corruptEnd) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?taskId=${taskId}`);
    const id = `${taskId}-transfer`;
    const expected = integrity(text);
    let output = '';
    let started = false;
    let offset = 0;
    let seq = 0;
    let pendingEnd = 0;
    let complete = false;
    const timer = setTimeout(() => finish(new Error(`transfer timed out: ${taskId}`)), 10000);

    function finish(err) {
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      sessions.killSession(taskId);
      if (err) reject(err);
      else resolve();
    }

    function sendNext() {
      if (offset < text.length) {
        pendingEnd = Math.min(offset + 7, text.length);
        const last = text.charCodeAt(pendingEnd - 1);
        if (pendingEnd < text.length && last >= 0xd800 && last <= 0xdbff) pendingEnd += 1;
        ws.send(JSON.stringify({
          type: 'large_input_chunk', id, seq, data: text.slice(offset, pendingEnd),
        }));
        return;
      }
      const ending = { ...expected };
      if (corruptEnd) ending.checksum = ending.checksum === '00000000' ? '00000001' : '00000000';
      ws.send(JSON.stringify({ type: 'large_input_end', id, ...ending }));
    }

    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', cols: 100, rows: 30 })));
    ws.on('error', finish);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output' || msg.type === 'replay') {
        output += msg.data;
        if (complete && output.includes(expectedOutput)) finish();
        return;
      }
      if (msg.type === 'status' && msg.running && !started) {
        started = true;
        ws.send(JSON.stringify({
          type: 'large_input_start', id, overwrite: true, ...expected,
        }));
        return;
      }
      if (msg.type === 'large_input_ready') {
        assert.strictEqual(msg.expectedSeq, 0);
        sendNext();
        return;
      }
      if (msg.type === 'large_input_ack') {
        assert.strictEqual(msg.seq, seq);
        offset = pendingEnd;
        seq += 1;
        sendNext();
        return;
      }
      if (msg.type === 'large_input_complete') {
        assert.deepStrictEqual(
          { textLength: msg.textLength, byteLength: msg.byteLength, checksum: msg.checksum },
          expected,
        );
        complete = true;
        if (output.includes(expectedOutput)) finish();
        return;
      }
      if (msg.type === 'large_input_error') {
        if (!corruptEnd) return finish(new Error(msg.message));
        assert.match(msg.message, /完整性校验失败/);
        setTimeout(() => {
          try {
            assert.ok(!output.includes(expectedOutput), 'corrupt transfer must not press Enter');
            finish();
          } catch (err) {
            finish(err);
          }
        }, 300);
      }
    });
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    const successCommand = "Write-Output ([string]::Concat('INTEGRITY','_OK')) # 中文🙂";
    await runTransfer(port, 'success-task', successCommand, 'INTEGRITY_OK', false);

    const rejectedCommand = "Write-Output ([string]::Concat('MUST_NOT','_RUN')) # 中文🙂";
    await runTransfer(port, 'rejected-task', rejectedCommand, 'MUST_NOT_RUN', true);
    console.log('large-input integration tests passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
