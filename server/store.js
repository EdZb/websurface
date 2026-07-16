'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'projects.json');

let state = { projects: [] };
let writeTimer = null;

function ensureLoaded() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) {
        state = parsed;
      }
    } else {
      persistNow();
    }
  } catch (err) {
    console.error('[store] 读取 projects.json 失败，使用空数据:', err.message);
    state = { projects: [] };
  }
}

function persistNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[store] 写入 projects.json 失败:', err.message);
  }
}

// 防抖写盘，避免频繁 IO
function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow();
  }, 150);
}

function genId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36);
  return `${prefix}_${t}${rand}`;
}

// ---- 查询 ----
function getProjects() {
  return state.projects;
}

function findProject(projectId) {
  return state.projects.find((p) => p.id === projectId) || null;
}

function findTask(taskId) {
  for (const p of state.projects) {
    const t = (p.tasks || []).find((x) => x.id === taskId);
    if (t) return { project: p, task: t };
  }
  return null;
}

// ---- 项目 CRUD ----
function createProject(name, cwd) {
  const project = {
    id: genId('p'),
    name: String(name || '未命名项目').trim() || '未命名项目',
    cwd: String(cwd || '').trim(),
    tasks: [],
  };
  state.projects.push(project);
  persist();
  return project;
}

// 更新项目名称 / 工作目录（任一字段可选）
function updateProject(projectId, patch) {
  const p = findProject(projectId);
  if (!p) return null;
  patch = patch || {};
  if (patch.name !== undefined) p.name = String(patch.name).trim() || p.name;
  if (patch.cwd !== undefined) p.cwd = String(patch.cwd).trim();
  persist();
  return p;
}

function deleteProject(projectId) {
  const idx = state.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) return null;
  const [removed] = state.projects.splice(idx, 1);
  persist();
  return removed;
}

// ---- 任务 CRUD ----
const VALID_KINDS = ['claude', 'codex', 'powershell'];

function createTask(projectId, { name, cwd, kind }) {
  const p = findProject(projectId);
  if (!p) return null;
  const task = {
    id: genId('t'),
    name: String(name || '未命名任务').trim() || '未命名任务',
    cwd: String(cwd || '').trim(),
    kind: VALID_KINDS.includes(kind) ? kind : 'powershell',
  };
  if (!Array.isArray(p.tasks)) p.tasks = [];
  p.tasks.push(task);
  persist();
  return task;
}

function updateTask(taskId, patch) {
  const found = findTask(taskId);
  if (!found) return null;
  const { task } = found;
  if (patch.name !== undefined) task.name = String(patch.name).trim() || task.name;
  if (patch.cwd !== undefined) task.cwd = String(patch.cwd).trim();
  if (patch.kind !== undefined && VALID_KINDS.includes(patch.kind)) task.kind = patch.kind;
  persist();
  return task;
}

function deleteTask(taskId) {
  for (const p of state.projects) {
    const idx = (p.tasks || []).findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      const [removed] = p.tasks.splice(idx, 1);
      persist();
      return removed;
    }
  }
  return null;
}

module.exports = {
  ensureLoaded,
  getProjects,
  findProject,
  findTask,
  createProject,
  updateProject,
  deleteProject,
  createTask,
  updateTask,
  deleteTask,
  VALID_KINDS,
};
