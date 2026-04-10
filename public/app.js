// ═══════════════════════════════════════════════════════════════
//   Planning BAFA — Frontend
//   Dynamic rendering, authentication, role-based editing, realtime sync
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ─────────────────────────────────────────────────────
const API_STATE = '/api/state';
const API_LOGIN = '/api/auth/login';
const API_LOGOUT = '/api/auth/logout';
const API_ME = '/api/auth/me';
const API_USERS = '/api/users';
const POLL_MS = 2000;

// ── STATE ──────────────────────────────────────────────────────
let currentState = null;  // { days, slots, tasks, version, lastUpdated }
let currentUser = null;   // { user, role }
let pollTimer = null;
let failCount = 0;
let isSyncing = false;
let lastVersion = 0;

// ── UTILS ──────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setSyncStatus(status, label) {
  const badge = $('sync-badge');
  const text = $('sync-text');
  if (!badge || !text) return;
  badge.className = 'sync-badge ' + status;
  text.textContent = label;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── AUTH ───────────────────────────────────────────────────────
async function loadMe() {
  try {
    const me = await apiFetch(API_ME);
    currentUser = me;
    return me;
  } catch (e) {
    currentUser = null;
    return null;
  }
}

async function login(user, password) {
  const data = await apiFetch(API_LOGIN, {
    method: 'POST',
    body: JSON.stringify({ user, password }),
  });
  currentUser = data;
  return data;
}

async function logout() {
  try { await apiFetch(API_LOGOUT, { method: 'POST' }); } catch {}
  currentUser = null;
  await startPublic();
}

function openLoginGate() {
  $('login-gate').classList.remove('hidden');
  $('login-error').textContent = '';
  $('login-user').value = '';
  $('login-password').value = '';
  setTimeout(() => $('login-user').focus(), 50);
}

function closeLoginGate() {
  $('login-gate').classList.add('hidden');
}

// Alias for backwards compatibility
function showLoginGate() { openLoginGate(); }
function hideLoginGate() { closeLoginGate(); }

function applyUserUI() {
  const tip = $('legend-tip');
  if (!currentUser) {
    // Public / read-only mode
    $('user-chip').style.display = 'none';
    $('btn-users').style.display = 'none';
    $('btn-reset').style.display = 'none';
    $('btn-logout').style.display = 'none';
    $('btn-login').style.display = '';
    if (tip) tip.textContent = '👁 Lecture seule — connectez-vous pour modifier';
    return;
  }
  $('btn-login').style.display = 'none';
  $('user-chip').style.display = '';
  $('user-name').textContent = currentUser.user;
  const roleLabel = currentUser.role === 'editor' ? 'Éditeur' : 'Validateur';
  $('user-role-label').textContent = roleLabel;
  $('btn-logout').style.display = '';
  if (currentUser.role === 'editor') {
    $('btn-users').style.display = '';
    $('btn-reset').style.display = '';
    if (tip) tip.textContent = '💡 Cliquez un item pour cocher · « ⋯ » pour éditer';
  } else {
    $('btn-users').style.display = 'none';
    $('btn-reset').style.display = 'none';
    if (tip) tip.textContent = '💡 Cliquez un item pour le cocher';
  }
}

// ── PROGRESS ───────────────────────────────────────────────────
function updateProgress() {
  if (!currentState) return;
  const all = currentState.tasks.length;
  const done = currentState.tasks.filter((t) => t.done).length;
  const pct = all ? Math.round((done / all) * 100) : 0;
  const bar = $('progress-bar');
  const txt = $('progress-text');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = done + ' / ' + all;
}

// ── RENDER ─────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPlanning() {
  if (!currentState) return;
  closeTaskMenu();

  const { days, slots, tasks } = currentState;
  const isEditor = currentUser && currentUser.role === 'editor';
  const table = $('planning-table');

  // Header row
  let html = '<thead><tr class="col-headers"><th class="corner"></th>';
  for (const d of days) {
    const cls = d.weekend ? 'weekend' : '';
    html += `<th class="${cls}">
      <span class="day-j">${escapeHtml(d.short || '')}</span>
      <span class="day-name">${escapeHtml(d.name || '')}</span>
      <span class="day-date">${escapeHtml(d.date || '')}</span>
    </th>`;
  }
  html += '</tr></thead><tbody>';

  // Body rows, one per slot
  for (const slot of slots) {
    const rowClass = 'row-' + slot.id;
    const slotCls = 'sl-' + slot.id;
    html += `<tr class="${rowClass}"><td class="slot-label ${slotCls}">${escapeHtml(slot.label)}</td>`;
    for (const d of days) {
      html += `<td class="cell" data-day="${escapeHtml(d.id)}" data-slot="${escapeHtml(slot.id)}">`;
      if (slot.id === 'repas') {
        html += '<div class="repas-content">🍽&nbsp;Repas</div>';
      } else {
        const cellTasks = tasks
          .filter((t) => t.dayId === d.id && t.slotId === slot.id)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        html += '<ul class="tasks">';
        for (const t of cellTasks) {
          const doneCls = t.done ? ' done' : '';
          const menuBtn = isEditor
            ? `<button class="task-menu-btn" data-action="menu" data-task-id="${escapeHtml(t.id)}" type="button" aria-label="Actions">⋯</button>`
            : '';
          html += `<li class="task${doneCls}" data-task-id="${escapeHtml(t.id)}">
            <span class="chk"></span>
            <span class="task-text">${escapeHtml(t.text)}</span>
            ${menuBtn}
          </li>`;
        }
        html += '</ul>';
        if (isEditor) {
          html += `<button class="btn-add-task" data-action="add" data-day="${escapeHtml(d.id)}" data-slot="${escapeHtml(slot.id)}" type="button">+ Ajouter</button>`;
        }
      }
      html += '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  updateProgress();
  lastVersion = currentState.version || 0;
}

// ── EVENT DELEGATION ───────────────────────────────────────────
function onTableClick(e) {
  const menuBtn = e.target.closest('[data-action="menu"]');
  if (menuBtn) {
    e.stopPropagation();
    openTaskMenu(menuBtn.dataset.taskId, menuBtn);
    return;
  }
  const addBtn = e.target.closest('[data-action="add"]');
  if (addBtn) {
    e.stopPropagation();
    openAddTaskModal(addBtn.dataset.day, addBtn.dataset.slot);
    return;
  }
  const li = e.target.closest('li.task');
  if (li) {
    const taskId = li.dataset.taskId;
    toggleTask(taskId, li);
  }
}

// ── OPS ────────────────────────────────────────────────────────
async function pushOp(op) {
  setSyncStatus('syncing', 'Sauvegarde…');
  isSyncing = true;
  try {
    const next = await apiFetch(API_STATE, {
      method: 'POST',
      body: JSON.stringify(op),
    });
    currentState = next;
    renderPlanning();
    failCount = 0;
    setSyncStatus('ok', 'Synchronisé ✓');
    return next;
  } catch (e) {
    failCount++;
    if (e.status === 401) {
      currentUser = null;
      applyUserUI();
      openLoginGate();
    } else if (e.status === 403) {
      setSyncStatus('error', 'Permission refusée');
    } else {
      setSyncStatus('error', 'Erreur de sync');
    }
    // Re-render to roll back optimistic UI changes.
    renderPlanning();
    throw e;
  } finally {
    isSyncing = false;
  }
}

async function toggleTask(taskId, li) {
  if (!currentUser) {
    // Public / read-only mode — invite the user to log in.
    openLoginGate();
    return;
  }
  const task = currentState && currentState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const nextDone = !task.done;
  // Optimistic UI
  if (li) li.classList.toggle('done', nextDone);
  try {
    await pushOp({ op: 'toggle', taskId, done: nextDone });
  } catch (e) {
    // rolled back by renderPlanning in pushOp catch
  }
}

// ── TASK MENU ──────────────────────────────────────────────────
let openMenuEl = null;

function closeTaskMenu() {
  if (openMenuEl && openMenuEl.parentNode) {
    openMenuEl.parentNode.removeChild(openMenuEl);
  }
  openMenuEl = null;
}

function openTaskMenu(taskId, anchor) {
  closeTaskMenu();
  const task = currentState && currentState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const column = currentState.tasks
    .filter((t) => t.dayId === task.dayId && t.slotId === task.slotId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = column.findIndex((t) => t.id === taskId);
  const canUp = idx > 0;
  const canDown = idx >= 0 && idx < column.length - 1;

  const menu = document.createElement('div');
  menu.className = 'task-menu';
  let html = '<button type="button" data-menu-action="rename">✎ Renommer</button>';
  if (canUp)   html += '<button type="button" data-menu-action="up">↑ Monter</button>';
  if (canDown) html += '<button type="button" data-menu-action="down">↓ Descendre</button>';
  html += '<button type="button" data-menu-action="move">⇄ Déplacer ailleurs</button>';
  html += '<button type="button" class="danger" data-menu-action="remove">🗑 Supprimer</button>';
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(
    window.innerWidth - menu.offsetWidth - 8,
    window.scrollX + rect.left
  )) + 'px';
  openMenuEl = menu;

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-menu-action]');
    if (!btn) return;
    const action = btn.dataset.menuAction;
    closeTaskMenu();
    const t = currentState.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (action === 'rename') openEditModal(t);
    else if (action === 'move') openMoveModal(t);
    else if (action === 'remove') confirmRemove(t);
    else if (action === 'up' || action === 'down') {
      try { await pushOp({ op: 'reorder', taskId, direction: action }); }
      catch (err) { alert(err.message || 'Erreur'); }
    }
  });
}

document.addEventListener('click', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeTaskMenu();
});

// ── EDIT MODAL (rename + move + add) ───────────────────────────
let editMode = null; // 'rename' | 'move' | 'add'
let editTaskId = null;
let editAddContext = null; // { dayId, slotId }

function openEditModal(task) {
  editMode = 'rename';
  editTaskId = task.id;
  $('edit-modal-title').textContent = 'Renommer la tâche';
  $('edit-text').value = task.text;
  $('edit-location').style.display = 'none';
  $('edit-error').textContent = '';
  $('edit-modal').classList.remove('hidden');
  setTimeout(() => $('edit-text').focus(), 50);
}

function openMoveModal(task) {
  editMode = 'move';
  editTaskId = task.id;
  $('edit-modal-title').textContent = 'Déplacer la tâche';
  $('edit-text').value = task.text;
  $('edit-text').disabled = true;
  populateLocationSelects(task.dayId, task.slotId);
  $('edit-location').style.display = '';
  $('edit-error').textContent = '';
  $('edit-modal').classList.remove('hidden');
}

function openAddTaskModal(dayId, slotId) {
  editMode = 'add';
  editTaskId = null;
  editAddContext = { dayId, slotId };
  $('edit-modal-title').textContent = 'Nouvelle tâche';
  $('edit-text').value = '';
  $('edit-text').disabled = false;
  populateLocationSelects(dayId, slotId);
  $('edit-location').style.display = '';
  $('edit-error').textContent = '';
  $('edit-modal').classList.remove('hidden');
  setTimeout(() => $('edit-text').focus(), 50);
}

function populateLocationSelects(dayId, slotId) {
  const daySel = $('edit-day');
  const slotSel = $('edit-slot');
  daySel.innerHTML = '';
  for (const d of currentState.days) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.short || ''} – ${d.name || ''}`;
    if (d.id === dayId) opt.selected = true;
    daySel.appendChild(opt);
  }
  slotSel.innerHTML = '';
  for (const s of currentState.slots) {
    if (s.id === 'repas') continue;
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === slotId) opt.selected = true;
    slotSel.appendChild(opt);
  }
}

function closeEditModal() {
  $('edit-modal').classList.add('hidden');
  $('edit-text').disabled = false;
  editMode = null;
  editTaskId = null;
  editAddContext = null;
}

async function submitEditModal() {
  const text = $('edit-text').value.trim();
  const errEl = $('edit-error');
  errEl.textContent = '';
  try {
    if (editMode === 'rename') {
      if (!text) { errEl.textContent = 'Texte vide'; return; }
      await pushOp({ op: 'edit', taskId: editTaskId, text });
    } else if (editMode === 'add') {
      if (!text) { errEl.textContent = 'Texte vide'; return; }
      const dayId = $('edit-day').value;
      const slotId = $('edit-slot').value;
      await pushOp({ op: 'add', dayId, slotId, text });
    } else if (editMode === 'move') {
      const dayId = $('edit-day').value;
      const slotId = $('edit-slot').value;
      await pushOp({ op: 'move', taskId: editTaskId, dayId, slotId });
    }
    closeEditModal();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  }
}

async function confirmRemove(task) {
  if (!confirm(`Supprimer définitivement la tâche « ${task.text} » ?`)) return;
  try {
    await pushOp({ op: 'remove', taskId: task.id });
  } catch (e) {
    alert(e.message || 'Erreur lors de la suppression');
  }
}

// ── RESET ──────────────────────────────────────────────────────
async function resetAll() {
  if (!confirm('Décocher toutes les tâches pour tout le monde ?')) return;
  try {
    await pushOp({ op: 'reset' });
  } catch (e) {
    alert(e.message || 'Erreur');
  }
}

// ── USERS MODAL ────────────────────────────────────────────────
async function openUsersModal() {
  $('users-modal').classList.remove('hidden');
  $('users-error').textContent = '';
  $('new-user-name').value = '';
  $('new-user-pwd').value = '';
  $('new-user-role').value = 'validator';
  await refreshUsersList();
}

function closeUsersModal() {
  $('users-modal').classList.add('hidden');
}

async function refreshUsersList() {
  const listEl = $('users-list');
  listEl.innerHTML = '<li style="color:#888;justify-content:center">Chargement…</li>';
  try {
    const data = await apiFetch(API_USERS);
    listEl.innerHTML = '';
    for (const u of data.users) {
      const li = document.createElement('li');
      const isSelf = currentUser && u.user === currentUser.user;
      li.innerHTML = `
        <span class="u-name">${escapeHtml(u.user)}${isSelf ? ' <span style="color:#888;font-weight:400">(vous)</span>' : ''}</span>
        <span class="u-role ${u.role}">${u.role === 'editor' ? 'Éditeur' : 'Validateur'}</span>
      `;
      if (!isSelf) {
        const del = document.createElement('button');
        del.className = 'u-delete';
        del.title = 'Supprimer';
        del.textContent = '🗑';
        del.addEventListener('click', () => deleteUserAction(u.user));
        li.appendChild(del);
      }
      listEl.appendChild(li);
    }
  } catch (e) {
    listEl.innerHTML = `<li style="color:#D33">${escapeHtml(e.message || 'Erreur')}</li>`;
  }
}

async function submitNewUser() {
  const user = $('new-user-name').value.trim();
  const password = $('new-user-pwd').value;
  const role = $('new-user-role').value;
  const errEl = $('users-error');
  errEl.textContent = '';
  try {
    await apiFetch(API_USERS, {
      method: 'POST',
      body: JSON.stringify({ user, password, role }),
    });
    $('new-user-name').value = '';
    $('new-user-pwd').value = '';
    await refreshUsersList();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  }
}

async function deleteUserAction(user) {
  if (!confirm(`Supprimer l'utilisateur « ${user} » ?`)) return;
  const errEl = $('users-error');
  errEl.textContent = '';
  try {
    await apiFetch(`${API_USERS}/${encodeURIComponent(user)}`, { method: 'DELETE' });
    await refreshUsersList();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  }
}

// ── FETCH + POLL ───────────────────────────────────────────────
async function fetchState() {
  const state = await apiFetch(API_STATE);
  currentState = state;
  lastVersion = state.version || 0;
  renderPlanning();
  return state;
}

async function poll() {
  if (isSyncing) return;
  try {
    const state = await apiFetch(API_STATE);
    if ((state.version || 0) !== lastVersion) {
      currentState = state;
      renderPlanning();
    }
    failCount = 0;
    setSyncStatus('ok', currentUser ? 'En ligne ✓' : 'Lecture seule');
  } catch (e) {
    // GET /api/state is public now, so a 401 here means the server is
    // misconfigured — just treat it as a transient error.
    failCount++;
    if (failCount >= 3) setSyncStatus('offline', 'Hors ligne');
  }
}

// ── INIT ───────────────────────────────────────────────────────
async function startAuthenticated() {
  hideLoginGate();
  applyUserUI();
  setSyncStatus('syncing', 'Connexion…');
  try {
    await fetchState();
    setSyncStatus('ok', 'En ligne ✓');
    failCount = 0;
  } catch (e) {
    setSyncStatus('offline', 'Hors ligne');
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

async function startPublic() {
  currentUser = null;
  hideLoginGate();
  applyUserUI();
  setSyncStatus('syncing', 'Chargement…');
  try {
    await fetchState();
    setSyncStatus('ok', 'Lecture seule');
    failCount = 0;
  } catch (e) {
    setSyncStatus('offline', 'Hors ligne');
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

async function init() {
  const table = $('planning-table');
  table.addEventListener('click', onTableClick);

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = $('login-user').value.trim();
    const password = $('login-password').value;
    const errEl = $('login-error');
    const submit = $('login-submit');
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Connexion…';
    try {
      await login(user, password);
      await startAuthenticated();
    } catch (e) {
      errEl.textContent = e.message || 'Erreur de connexion';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Se connecter';
    }
  });

  $('edit-save-btn').addEventListener('click', submitEditModal);
  $('edit-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitEditModal();
    }
  });

  const me = await loadMe();
  if (me) {
    await startAuthenticated();
  } else {
    await startPublic();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) poll();
});

// Expose functions used by inline onclick handlers
window.openUsersModal = openUsersModal;
window.closeUsersModal = closeUsersModal;
window.submitNewUser = submitNewUser;
window.closeEditModal = closeEditModal;
window.resetAll = resetAll;
window.logout = logout;
window.openLoginGate = openLoginGate;
window.closeLoginGate = closeLoginGate;

window.addEventListener('DOMContentLoaded', init);
