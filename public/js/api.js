'use strict';

// 简单的 REST API 封装
const API = {
  async _fetch(url, opts) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  },

  listProjects() {
    return this._fetch('/api/projects');
  },
  listSessions() {
    return this._fetch('/api/sessions');
  },
  createProject(name, cwd) {
    return this._fetch('/api/projects', { method: 'POST', body: JSON.stringify({ name, cwd }) });
  },
  updateProject(id, data) {
    return this._fetch('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(data) });
  },
  deleteProject(id) {
    return this._fetch('/api/projects/' + id, { method: 'DELETE' });
  },
  createTask(projectId, data) {
    return this._fetch('/api/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify(data) });
  },
  updateTask(taskId, data) {
    return this._fetch('/api/tasks/' + taskId, { method: 'PATCH', body: JSON.stringify(data) });
  },
  deleteTask(taskId) {
    return this._fetch('/api/tasks/' + taskId, { method: 'DELETE' });
  },
  // 浏览服务器目录：不传 path 返回盘符根；返回 { path, parent, dirs:[{name,path}] }
  browseDir(path) {
    const q = path ? ('?path=' + encodeURIComponent(path)) : '';
    return this._fetch('/api/fs' + q);
  },
};
