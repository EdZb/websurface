'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const router = express.Router();

const MAX_ENTRIES = 2000; // 单个目录最多返回的子目录数，避免超大目录拖垮响应

// 惰性拿到会话模块的 killSession（pty 未装时安全降级为 no-op）
function killSession(taskId) {
  try {
    const sessions = require('./sessions');
    if (sessions && typeof sessions.killSession === 'function') {
      sessions.killSession(taskId);
    }
  } catch (_) { /* 会话模块不可用时忽略 */ }
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}
function notFound(res, msg) {
  return res.status(404).json({ error: msg || 'not found' });
}

// 列出全部项目（含任务）
router.get('/projects', (req, res) => {
  res.json({ projects: store.getProjects() });
});

// 新建项目
router.post('/projects', (req, res) => {
  const { name, cwd } = req.body || {};
  if (!name || !String(name).trim()) return badRequest(res, 'name 必填');
  res.status(201).json(store.createProject(name, cwd));
});

// 更新项目（名称 / 工作目录，任一可选）
router.patch('/projects/:projectId', (req, res) => {
  const { name, cwd } = req.body || {};
  if (name !== undefined && !String(name).trim()) return badRequest(res, 'name 不能为空');
  const p = store.updateProject(req.params.projectId, { name, cwd });
  if (!p) return notFound(res, '项目不存在');
  res.json(p);
});

// 删除项目（同时终止其下所有任务正在运行的会话）
router.delete('/projects/:projectId', (req, res) => {
  const removed = store.deleteProject(req.params.projectId);
  if (!removed) return notFound(res, '项目不存在');
  for (const t of removed.tasks || []) killSession(t.id);
  res.json({ ok: true, removed });
});

// 在项目下新建任务
router.post('/projects/:projectId/tasks', (req, res) => {
  const { name, cwd, kind } = req.body || {};
  if (!name || !String(name).trim()) return badRequest(res, 'name 必填');
  if (kind && !store.VALID_KINDS.includes(kind)) return badRequest(res, 'kind 非法');
  const task = store.createTask(req.params.projectId, { name, cwd, kind });
  if (!task) return notFound(res, '项目不存在');
  res.status(201).json(task);
});

// 更新任务
router.patch('/tasks/:taskId', (req, res) => {
  const { name, cwd, kind } = req.body || {};
  if (kind && !store.VALID_KINDS.includes(kind)) return badRequest(res, 'kind 非法');
  const task = store.updateTask(req.params.taskId, { name, cwd, kind });
  if (!task) return notFound(res, '任务不存在');
  res.json(task);
});

// 删除任务（同时终止其正在运行的会话，避免遗留孤儿进程）
router.delete('/tasks/:taskId', (req, res) => {
  const removed = store.deleteTask(req.params.taskId);
  if (!removed) return notFound(res, '任务不存在');
  killSession(req.params.taskId);
  res.json({ ok: true, removed });
});

// ============ 只读目录浏览（任务弹窗里“浏览目录”用） ============
// 安全说明：只列出子目录名、只读；不返回文件、不读文件内容、无任何写操作。
// 纯局域网自用，符合“不做鉴权”的项目定位，但严格限制为“列目录项”。

// 列出 Windows 盘符（C:\ ~ Z:\ 中真实存在的）
function listDrives() {
  const dirs = [];
  for (let i = 67; i <= 90; i++) { // 'C'..'Z'（A/B 一般是软驱，跳过）
    const root = String.fromCharCode(i) + ':\\';
    try { fs.accessSync(root); dirs.push({ name: root, path: root }); }
    catch (_) { /* 该盘符不存在 */ }
  }
  return dirs;
}

router.get('/fs', (req, res) => {
  const raw = req.query.path;

  // 无 path：返回盘符列表（浏览的起点）。parent=null 表示已在最顶层。
  if (!raw || !String(raw).trim()) {
    return res.json({ path: '', parent: null, dirs: listDrives() });
  }

  let target;
  try { target = path.resolve(String(raw)); }
  catch (_) { return badRequest(res, '路径非法'); }

  let stat;
  try { stat = fs.statSync(target); }
  catch (_) { return notFound(res, '路径不存在或无法访问'); }
  if (!stat.isDirectory()) return badRequest(res, '不是目录');

  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); }
  catch (_) { return res.status(403).json({ error: '无法读取该目录（权限不足？）' }); }

  const dirs = [];
  for (const ent of entries) {
    if (dirs.length >= MAX_ENTRIES) break;
    let isDir = false;
    try {
      isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) { // 符号链接：跟随判断目标是否为目录
        try { isDir = fs.statSync(path.join(target, ent.name)).isDirectory(); }
        catch (_) { isDir = false; }
      }
    } catch (_) { isDir = false; }
    if (isDir) dirs.push({ name: ent.name, path: path.join(target, ent.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  // 计算上级：到达盘符根（如 D:\）时 dirname 不再变化，此时上级为盘符列表（空串）。
  const up = path.dirname(target);
  const parent = (up === target) ? '' : up;

  res.json({ path: target, parent, dirs });
});

module.exports = router;
