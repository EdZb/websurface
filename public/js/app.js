'use strict';

// ---- 应用状态 ----
const state = {
  projects: [],
  collapsed: {},        // projectId -> true 表示折叠
  activeTaskId: null,
  runningServer: new Set(), // 服务器上正在运行的 taskId（刷新后徽标据此显示）
};

const KIND_LABEL = { claude: 'claude', codex: 'codex', powershell: 'powershell' };

// ---- DOM ----
const el = {
  tree: document.getElementById('tree'),
  sidebar: document.getElementById('sidebar'),
  backdrop: document.getElementById('sidebar-backdrop'),
  toggleSidebar: document.getElementById('btn-toggle-sidebar'),
  newProject: document.getElementById('btn-new-project'),
  topbarTask: document.getElementById('topbar-task'),
  // modal
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalOk: document.getElementById('modal-ok'),
  modalCancel: document.getElementById('modal-cancel'),
};

// ================= 模态框 =================
let modalOnOk = null;

function openModal(title, bodyHtml, onOk) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = bodyHtml;
  modalOnOk = onOk;
  el.modal.hidden = false;
  const first = el.modalBody.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  el.modal.hidden = true;
  el.modalBody.innerHTML = '';
  modalOnOk = null;
}

el.modalCancel.addEventListener('click', closeModal);
el.modalOk.addEventListener('click', async () => {
  if (modalOnOk) {
    const keep = await modalOnOk();
    if (keep === true) return; // 校验失败时保持打开
  }
  closeModal();
});
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modal.hidden) closeModal();
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================= 数据加载与渲染 =================
async function reload() {
  const [data] = await Promise.all([API.listProjects(), refreshSessions()]);
  state.projects = data.projects || [];
  render();
}

// 从服务器拉取正在运行的会话，据此显示徽标（与浏览器状态解耦）
async function refreshSessions() {
  try {
    const s = await API.listSessions();
    state.runningServer = new Set(s.running || []);
  } catch (_) {
    // 拿不到就保持上次结果，不影响使用
  }
}

function render() {
  const tree = el.tree;
  if (state.projects.length === 0) {
    tree.innerHTML = '<div class="empty-hint">还没有项目，点“+ 项目”新建</div>';
    return;
  }
  tree.innerHTML = '';
  for (const p of state.projects) {
    tree.appendChild(renderProject(p));
  }
  updateTopbar();
}

function renderProject(p) {
  const wrap = document.createElement('div');
  wrap.className = 'project';
  const collapsed = !!state.collapsed[p.id];

  const header = document.createElement('div');
  header.className = 'project-header';
  header.innerHTML = `
    <span class="project-caret">${collapsed ? '▶' : '▼'}</span>
    <span class="project-name" title="${esc(p.name)}">${esc(p.name)}</span>
    <span class="row-actions">
      <button class="act-btn" data-act="add-task" title="新建任务">＋</button>
      <button class="act-btn" data-act="rename-project" title="重命名">✎</button>
      <button class="act-btn" data-act="del-project" title="删除">🗑</button>
    </span>`;
  header.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'add-task') return openTaskModal(p.id);
    if (act === 'rename-project') return openRenameProject(p);
    if (act === 'del-project') return confirmDeleteProject(p);
    // 否则切换折叠
    state.collapsed[p.id] = !collapsed;
    render();
  });
  wrap.appendChild(header);

  if (!collapsed) {
    const tasks = document.createElement('div');
    tasks.className = 'tasks';
    for (const t of (p.tasks || [])) {
      tasks.appendChild(renderTask(p, t));
    }
    const add = document.createElement('div');
    add.className = 'add-task';
    add.textContent = '＋ 新建任务';
    add.addEventListener('click', () => openTaskModal(p.id));
    tasks.appendChild(add);
    wrap.appendChild(tasks);
  }
  return wrap;
}

function renderTask(p, t) {
  // 运行状态以服务器为准（刷新页面后仍准确），兼顾前端已连接的实例
  const running = state.runningServer.has(t.id) ||
    (window.Term && window.Term.isRunning && window.Term.isRunning(t.id));
  const node = document.createElement('div');
  node.className = 'task' + (state.activeTaskId === t.id ? ' active' : '');
  node.innerHTML = `
    <span class="task-badge ${running ? 'running' : ''}"></span>
    <span class="task-name" title="${esc(t.name)}${t.cwd ? ' — ' + esc(t.cwd) : ''}">${esc(t.name)}</span>
    <span class="task-kind">${esc(KIND_LABEL[t.kind] || t.kind)}</span>
    <span class="row-actions">
      <button class="act-btn" data-act="edit-task" title="编辑">✎</button>
      <button class="act-btn" data-act="del-task" title="删除">🗑</button>
    </span>`;
  node.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'edit-task') return openTaskModal(p.id, t);
    if (act === 'del-task') return confirmDeleteTask(t);
    selectTask(p, t);
  });
  return node;
}

function updateTopbar() {
  if (!state.activeTaskId) { el.topbarTask.textContent = ''; return; }
  const found = findTaskLocal(state.activeTaskId);
  el.topbarTask.textContent = found ? `${found.project.name} / ${found.task.name}` : '';
}

function findTaskLocal(taskId) {
  for (const p of state.projects) {
    const t = (p.tasks || []).find((x) => x.id === taskId);
    if (t) return { project: p, task: t };
  }
  return null;
}

function findProject(projectId) {
  return state.projects.find((p) => p.id === projectId) || null;
}

// ================= 选择任务（阶段2 接入终端） =================
function selectTask(p, t) {
  state.activeTaskId = t.id;
  render();
  closeDrawer();
  if (window.Term && window.Term.open) {
    window.Term.open(t);
  }
}

// ================= 项目操作 =================
function openNewProject() { openProjectModal(null); }
function openRenameProject(p) { openProjectModal(p); }

// 新建 / 编辑项目（含工作目录，作为其下任务浏览目录的默认起点）
function openProjectModal(project) {
  const isEdit = !!project;
  openModal(isEdit ? '编辑项目' : '新建项目', `
    <label>项目名称</label>
    <input id="mp-name" value="${project ? esc(project.name) : ''}" placeholder="例如：客户官网" />
    <label>工作目录（可选，新建任务时默认从这里开始浏览）</label>
    <div class="cwd-row">
      <input id="mp-cwd" value="${project ? esc(project.cwd || '') : ''}" placeholder="例如：D:\\Projects\\客户官网" />
      <button type="button" class="btn" id="mp-browse">浏览…</button>
    </div>
  `, async () => {
    const name = document.getElementById('mp-name').value.trim();
    const cwd = document.getElementById('mp-cwd').value.trim();
    if (!name) return true;
    if (isEdit) {
      await API.updateProject(project.id, { name, cwd });
    } else {
      await API.createProject(name, cwd);
    }
    await reload();
  });

  const browseBtn = document.getElementById('mp-browse');
  if (browseBtn) {
    browseBtn.addEventListener('click', () => openDirPicker(document.getElementById('mp-cwd')));
  }
}

function confirmDeleteProject(p) {
  const n = (p.tasks || []).length;
  openModal('删除项目',
    `<p>确定删除项目 <b>${esc(p.name)}</b>${n ? ` 及其下 ${n} 个任务` : ''}？此操作不可撤销。</p>`,
    async () => {
      await API.deleteProject(p.id);
      if (state.activeTaskId && (p.tasks || []).some((t) => t.id === state.activeTaskId)) {
        state.activeTaskId = null;
      }
      await reload();
    });
  el.modalOk.classList.add('btn-danger');
  const restore = () => el.modalOk.classList.remove('btn-danger');
  el.modalCancel.addEventListener('click', restore, { once: true });
  el.modalOk.addEventListener('click', restore, { once: true });
}

// ================= 任务操作 =================
function openTaskModal(projectId, task) {
  const isEdit = !!task;
  const project = findProject(projectId);
  const projCwd = (project && project.cwd) || '';
  // 新建任务默认继承项目工作目录；编辑时保持任务自己的 cwd
  const initialCwd = isEdit ? (task.cwd || '') : projCwd;
  const kinds = ['claude', 'codex', 'powershell'];
  const opts = kinds.map((k) =>
    `<option value="${k}" ${task && task.kind === k ? 'selected' : ''}>${k}</option>`).join('');
  openModal(isEdit ? '编辑任务' : '新建任务', `
    <label>任务名称</label>
    <input id="m-name" value="${task ? esc(task.name) : ''}" placeholder="例如：修复登录 bug" />
    <label>工作目录（可手动输入或点“浏览”选择）</label>
    <div class="cwd-row">
      <input id="m-cwd" value="${esc(initialCwd)}" placeholder="例如：D:\\Proj02_WebSurface" />
      <button type="button" class="btn" id="m-browse">浏览…</button>
    </div>
    <label>启动类型</label>
    <select id="m-kind">${opts}</select>
  `, async () => {
    const name = document.getElementById('m-name').value.trim();
    const cwd = document.getElementById('m-cwd').value.trim();
    const kind = document.getElementById('m-kind').value;
    if (!name) return true;
    if (isEdit) {
      await API.updateTask(task.id, { name, cwd, kind });
      await reload();
    } else {
      const created = await API.createTask(projectId, { name, cwd, kind });
      state.collapsed[projectId] = false; // 确保新任务所在项目展开
      await reload();
      // 新建后直接打开该任务的终端
      const found = created && findTaskLocal(created.id);
      if (found) selectTask(found.project, found.task);
    }
  });

  // “浏览…”按钮：打开目录选择器，选中后写回 cwd 输入框
  const browseBtn = document.getElementById('m-browse');
  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      const cwdInput = document.getElementById('m-cwd');
      openDirPicker(cwdInput);
    });
  }
}

function confirmDeleteTask(t) {
  openModal('删除任务',
    `<p>确定删除任务 <b>${esc(t.name)}</b>？</p>`,
    async () => {
      await API.deleteTask(t.id);
      if (state.activeTaskId === t.id) state.activeTaskId = null;
      await reload();
    });
}

// ================= 目录选择器（服务端只读浏览） =================
// 叠在任务弹窗之上，选定后把路径写回目标输入框。
let dirPicker = null; // { overlay, pathEl, listEl, targetInput, cur }

function buildDirPicker() {
  if (dirPicker) return dirPicker;
  const overlay = document.createElement('div');
  overlay.className = 'modal dir-picker';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-card dir-picker-card" role="dialog" aria-modal="true">
      <h2>选择工作目录</h2>
      <div class="dir-cur"><button type="button" class="btn dir-up" title="上级目录">↑ 上级</button>
        <span class="dir-cur-path" title=""></span></div>
      <div class="dir-list"></div>
      <div class="modal-actions">
        <button type="button" class="btn dir-cancel">取消</button>
        <button type="button" class="btn btn-primary dir-choose">选择此目录</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const pathEl = overlay.querySelector('.dir-cur-path');
  const listEl = overlay.querySelector('.dir-list');
  const upBtn = overlay.querySelector('.dir-up');
  const chooseBtn = overlay.querySelector('.dir-choose');

  function close() { overlay.hidden = true; listEl.innerHTML = ''; dirPicker.targetInput = null; }

  overlay.querySelector('.dir-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  upBtn.addEventListener('click', () => { navigate(dirPicker.cur ? dirPicker.cur.parent : ''); });
  chooseBtn.addEventListener('click', () => {
    // 在盘符列表层（path 为空）没有可选目录，禁用选择
    if (!dirPicker.cur || !dirPicker.cur.path) return;
    if (dirPicker.targetInput) dirPicker.targetInput.value = dirPicker.cur.path;
    close();
  });

  async function navigate(p) {
    listEl.innerHTML = '<div class="dir-empty">加载中…</div>';
    let data;
    try { data = await API.browseDir(p); }
    catch (err) { listEl.innerHTML = `<div class="dir-empty">无法打开：${esc(err.message)}</div>`; return; }
    dirPicker.cur = data;
    const atDrives = !data.path;
    pathEl.textContent = atDrives ? '（选择磁盘）' : data.path;
    pathEl.title = data.path || '';
    upBtn.disabled = (data.parent === null); // 盘符列表层没有上级
    chooseBtn.disabled = atDrives;           // 盘符层不能直接选
    listEl.innerHTML = '';
    if (!data.dirs.length) {
      listEl.innerHTML = '<div class="dir-empty">（没有子目录）</div>';
      return;
    }
    for (const d of data.dirs) {
      const row = document.createElement('div');
      row.className = 'dir-item';
      row.innerHTML = `<span class="dir-ico">📁</span><span class="dir-name"></span>`;
      row.querySelector('.dir-name').textContent = d.name;
      row.title = d.path;
      row.addEventListener('click', () => navigate(d.path));
      listEl.appendChild(row);
    }
    listEl.scrollTop = 0;
  }

  dirPicker = { overlay, pathEl, listEl, targetInput: null, cur: null, navigate, close };
  return dirPicker;
}

// 打开目录选择器；startPath 为初始路径（通常是输入框已有值），选定后写回 targetInput
function openDirPicker(targetInput) {
  const dp = buildDirPicker();
  dp.targetInput = targetInput;
  dp.overlay.hidden = false;
  const start = (targetInput && targetInput.value.trim()) || '';
  dp.navigate(start);
}

// Esc 关闭目录选择器（优先于任务弹窗）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dirPicker && !dirPicker.overlay.hidden) {
    e.stopPropagation();
    dirPicker.close();
  }
}, true);

// ================= 移动端抽屉 =================
function openDrawer() {
  el.sidebar.classList.add('open');
  el.backdrop.hidden = false;
}
function closeDrawer() {
  el.sidebar.classList.remove('open');
  el.backdrop.hidden = true;
}
el.toggleSidebar.addEventListener('click', () => {
  if (el.sidebar.classList.contains('open')) closeDrawer(); else openDrawer();
});
el.backdrop.addEventListener('click', closeDrawer);

// ================= 启动 =================
el.newProject.addEventListener('click', openNewProject);

// 通用确认框（复用模态框），供 terminal.js 调用
function confirmDialog(message, onYes) {
  openModal('确认', `<p>${esc(message)}</p>`, async () => {
    if (onYes) await onYes();
  });
  el.modalOk.classList.add('btn-danger');
  const restore = () => el.modalOk.classList.remove('btn-danger');
  el.modalCancel.addEventListener('click', restore, { once: true });
  el.modalOk.addEventListener('click', restore, { once: true });
}

// 供 terminal.js 在状态变化时刷新徽标、弹确认框
window.App = {
  reload, render,
  getActiveTaskId: () => state.activeTaskId,
  confirm: confirmDialog,
};

reload().catch((err) => {
  el.tree.innerHTML = `<div class="empty-hint">加载失败：${esc(err.message)}</div>`;
});

// 定时刷新徽标，保证与服务器真实会话状态一致（每 4 秒）
setInterval(async () => {
  const before = Array.from(state.runningServer).sort().join(',');
  await refreshSessions();
  const after = Array.from(state.runningServer).sort().join(',');
  if (before !== after) render();
}, 4000);
