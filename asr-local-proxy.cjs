require('dotenv').config({ path: '.env.local' });
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = 8790;
const API_KEY = process.env.DASHSCOPE_API_KEY;

// 新加坡/国际站
//const DASHSCOPE_WS_URL = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/';
// 如果你是北京站，改成下面这一行：
const DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';

if (!API_KEY) {
  throw new Error('缺少环境变量 DASHSCOPE_API_KEY');
}

const app = express();
const server = http.createServer(app);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'funasr-local-proxy',
    port: PORT,
  });
});

const wss = new WebSocket.Server({
  server,
  path: '/asr',
});

wss.on('connection', (clientWs) => {
  console.log('[proxy] 前端已连接');

  const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

  const dashscopeWs = new WebSocket(DASHSCOPE_WS_URL, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  let remoteStarted = false;
  let closed = false;

  function safeSendToClient(obj) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  }

  function cleanup() {
    if (closed) return;
    closed = true;

    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}

    try {
      if (dashscopeWs.readyState === WebSocket.OPEN) dashscopeWs.close();
    } catch {}
  }

  dashscopeWs.on('open', () => {
    console.log('[proxy] 已连接阿里 FunASR');

    const runTask = {
      header: {
        action: 'run-task',
        task_id: taskId,
        streaming: 'duplex',
      },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'fun-asr-realtime',
        parameters: {
          format: 'pcm',
          sample_rate: 16000,
        },
        input: {},
      },
    };

    dashscopeWs.send(JSON.stringify(runTask));
  });

  dashscopeWs.on('message', (msg, isBinary) => {
    if (isBinary) return;

    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.error('[proxy] 阿里返回非 JSON:', err);
      return;
    }

    console.log('[proxy] 阿里返回:', JSON.stringify(data));

    const event = data?.header?.event;

    if (event === 'task-started') {
      remoteStarted = true;
      safeSendToClient({ type: 'task-started' });
      return;
    }

    if (event === 'result-generated') {
      const sentence = data?.payload?.output?.sentence || {};
      const text = sentence?.text || '';

      safeSendToClient({
        type: 'result',
        text,
        isFinal: !!sentence?.end_time,
        raw: data,
      });
      return;
    }

    if (event === 'task-finished') {
      safeSendToClient({ type: 'task-finished' });
      cleanup();
      return;
    }

    if (event === 'task-failed') {
      safeSendToClient({
        type: 'error',
        message: data?.header?.error_message || 'FunASR task failed',
        raw: data,
      });
      cleanup();
    }
  });

  dashscopeWs.on('error', (err) => {
    console.error('[proxy] 阿里连接异常:', err);
    safeSendToClient({
      type: 'error',
      message: String(err),
    });
    cleanup();
  });

  dashscopeWs.on('close', () => {
    console.log('[proxy] 阿里连接已关闭');
  });

  clientWs.on('message', (msg, isBinary) => {
    if (!remoteStarted) return;

    if (isBinary) {
      if (dashscopeWs.readyState === WebSocket.OPEN) {
        dashscopeWs.send(msg, { binary: true });
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data?.type === 'finish') {
      const finishTask = {
        header: {
          action: 'finish-task',
          task_id: taskId,
          streaming: 'duplex',
        },
        payload: {
          input: {},
        },
      };

      if (dashscopeWs.readyState === WebSocket.OPEN) {
        dashscopeWs.send(JSON.stringify(finishTask));
      }
    }
  });

  clientWs.on('close', () => {
    console.log('[proxy] 前端连接已关闭');
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.error('[proxy] 前端连接异常:', err);
    cleanup();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] 已启动: http://127.0.0.1:${PORT}`);
  console.log(`[proxy] WebSocket: ws://127.0.0.1:${PORT}/asr`);
});