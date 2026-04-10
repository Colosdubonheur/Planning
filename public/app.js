// ═══════════════════════════════════════════════════════════════
//   Planning BAFA — Frontend (multi-planning + hiérarchie)
//   Dynamic rendering, auth, role-based editing, realtime sync
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ─────────────────────────────────────────────────────
const API_STATE     = '/api/state';
const API_LOGIN     = '/api/auth/login';
const API_LOGOUT    = '/api/auth/logout';
const API_ME        = '/api/auth/me';
const API_USERS     = '/api/users';
const API_PLANNINGS = '/api/plannings';
const POLL_MS = 2000;
const STORAGE_PLANNING_KEY = 'planning:currentId';

// ── STATE ──────────────────────────────────────────────────────
let currentState    = null;  // { days, slots, tasks, version, lastUpdated, planningId, planningName }
let currentUser     = null;  // { user, role }
let currentPlanningId = null;
let planningsList   = [];    // [{ id, name, ownerId, createdAt, lastUpdated }]
let pollTimer       = null;
let failCount       = 0;
let isSyncing       = false;
let lastVersion     = 0;
let editMode        = false;

// ── UTILS ──────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function withPlanning(url, planningId) {
  const id = planningId || currentPlanningId;
  if (!id) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}planning=${encodeURIComponent(id)}`;
}

function rememberPlanningId(id) {
  currentPlanningId = id;
  try {
    if (id) localStorage.setItem(STORAGE_PLANNING_KEY, id);
    else localStorage.removeItem(STORAGE_PLANNING_KEY);
  } catch {}
}

function readStoredPlanningId() {
  try { return localStorage.getItem(STORAGE_PLANNING_KEY); } catch { return null; }
}

// ── AUTH ───────────────────────────────────────────────────────
async function loadMe() {
  try {
    const me = await apiFetch(API_ME);
    currentUser = me;
    return me;
  } catch {
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
  planningsList = [];
  rememberPlanningId(null);
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

function showLoginGate() { openLoginGate(); }
function hideLoginGate() { closeLoginGate(); }

function applyUserUI() {
  const tip = $('legend-tip');
  const picker = $('planning-picker');
  if (!currentUser) {
    $('user-chip').style.display = 'none';
    $('btn-users').style.display = 'none';
    $('btn-reset').style.display = 'none';
    $('btn-logout').style.display = 'none';
    $('btn-edit-mode').style.display = 'none';
    $('btn-login').style.display = '';
    if (picker) picker.style.display = 'none';
    editMode = false;
    document.body.classList.remove('edit-mode');
    if (tip) tip.textContent = '👁 Lecture seule — connectez-vous pour modifier';
    return;
  }
  $('btn-login').style.display = 'none';
  $('user-chip').style.display = '';
  $('user-name').textContent = currentUser.user;
  const roleLabel = currentUser.role === 'editor' ? 'Éditeur' : 'Validateur';
  $('user-role-label').textContent = roleLabel;
  $('btn-logout').style.display = '';
  if (picker) picker.style.display = planningsList.length ? '' : '';
  if (currentUser.role === 'editor') {
    $('btn-edit-mode').style.display = '';
    $('btn-users').style.display = '';
    $('btn-reset').style.display = '';
    $('btn-new-planning').style.display = '';
    $('btn-rename-planning').style.display = '';
    $('btn-delete-planning').style.display = '';
    $('btn-edit-mode').classList.toggle('active', editMode);
    document.body.classList.toggle('edit-mode', editMode);
    if (tip) {
      tip.textContent = editMode
        ? '✎ Mode édition — tapez un item pour le modifier'
        : '💡 Cliquez un item pour le cocher · « ✎ Modifier » pour éditer';
    }
  } else {
    $('btn-edit-mode').style.display = 'none';
    $('btn-users').style.display = 'none';
    $('btn-reset').style.display = 'none';
    $('btn-new-planning').style.display = 'none';
    $('btn-rename-planning').style.display = 'none';
    $('btn-delete-planning').style.display = 'none';
    editMode = false;
    document.body.classList.remove('edit-mode');
    if (tip) tip.textContent = '💡 Cliquez un item pour le cocher';
  }
}

function toggleEditMode() {
  if (!currentUser || currentUser.role !== 'editor') return;
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('btn-edit-mode').classList.toggle('active', editMode);
  applyUserUI();
  renderPlanning();
  setSyncStatus('ok', editMode ? 'Mode édition ✎' : 'En ligne ✓');
}

// ── PLANNINGS (list, create, rename, delete, switch) ───────────
async function loadPlanningsList() {
  if (!currentUser) { planningsList = []; return planningsList; }
  try {
    const data = await apiFetch(API_PLANNINGS);
    planningsList = Array.isArray(data.plannings) ? data.plannings : [];
  } catch (e) {
    planningsList = [];
  }
  return planningsList;
}

function renderPlanningSelector() {
  const sel = $('planning-select');
  if (!sel) return;
  sel.innerHTML = '';
  if (!planningsList.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(aucun)';
    sel.appendChild(opt);
  } else {
    for (const p of planningsList) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === currentPlanningId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const current = planningsList.find((p) => p.id === currentPlanningId);
  $('planning-title').textContent = current ? current.name : 'Planning';
  $('planning-subtitle').textContent = current
    ? `Planning synchronisé · ${planningsList.length} disponible${planningsList.length > 1 ? 's' : ''}`
    : 'Aucun planning accessible';

  // Only the owner may rename/delete.
  const canOwn = current && currentUser && current.ownerId === currentUser.user;
  $('btn-rename-planning').style.display = canOwn ? '' : 'none';
  $('btn-delete-planning').style.display = canOwn ? '' : 'none';
}

async function onPlanningSelectChange(id) {
  if (!id || id === currentPlanningId) return;
  rememberPlanningId(id);
  await fetchState();
  renderPlanningSelector();
  setSyncStatus('ok', 'En ligne ✓');
}

async function createPlanningPrompt() {
  const name = prompt('Nom du nouveau planning :');
  if (!name || !name.trim()) return;
  try {
    const data = await apiFetch(API_PLANNINGS, {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadPlanningsList();
    rememberPlanningId(data.planning.id);
    await fetchState();
    renderPlanningSelector();
    setSyncStatus('ok', 'Planning créé ✓');
  } catch (e) {
    alert(e.message || 'Erreur lors de la création du planning');
  }
}

async function renamePlanningPrompt() {
  if (!currentPlanningId) return;
  const current = planningsList.find((p) => p.id === currentPlanningId);
  const name = prompt('Nouveau nom :', current ? current.name : '');
  if (!name || !name.trim()) return;
  try {
    await apiFetch(`${API_PLANNINGS}/${encodeURIComponent(currentPlanningId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadPlanningsList();
    renderPlanningSelector();
    setSyncStatus('ok', 'Planning renommé ✓');
  } catch (e) {
    alert(e.message || 'Erreur lors du renommage');
  }
}

async function deletePlanningPrompt() {
  if (!currentPlanningId) return;
  const current = planningsList.find((p) => p.id === currentPlanningId);
  const label = current ? current.name : currentPlanningId;
  if (!confirm(`Supprimer définitivement le planning « ${label} » ? Cette action est irréversible.`)) return;
  try {
    await apiFetch(`${API_PLANNINGS}/${encodeURIComponent(currentPlanningId)}`, { method: 'DELETE' });
    rememberPlanningId(null);
    await loadPlanningsList();
    if (planningsList.length) rememberPlanningId(planningsList[0].id);
    if (currentPlanningId) await fetchState();
    else { currentState = null; $('planning-table').innerHTML = ''; updateProgress(); }
    renderPlanningSelector();
    setSyncStatus('ok', 'Planning supprimé ✓');
  } catch (e) {
    alert(e.message || 'Erreur lors de la suppression');
  }
}

// ── PROGRESS ───────────────────────────────────────────────────
function updateProgress() {
  const bar = $('progress-bar');
  const txt = $('progress-text');
  if (!currentState) {
    if (bar) bar.style.width = '0%';
    if (txt) txt.textContent = '0 / 0';
    return;
  }
  const all = currentState.tasks.length;
  const done = currentState.tasks.filter((t) => t.done).length;
  const pct = all ? Math.round((done / all) * 100) : 0;
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = done + ' / ' + all;
}

// ── RENDER ─────────────────────────────────────────────────────
function renderPlanning() {
  const table = $('planning-table');
  if (!currentState) {
    if (table) table.innerHTML = '';
    updateProgress();
    return;
  }
  closeTaskMenu();

  const { days, slots, tasks } = currentState;
  const isEditor = currentUser && currentUser.role === 'editor';
  if (!table) return;

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
          html += `<li class="task${doneCls}" data-task-id="${escapeHtml(t.id)}">
            <span class="chk"></span>
            <span class="task-text">${escapeHtml(t.text)}</span>
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
  const addBtn = e.target.closest('[data-action="add"]');
  if (addBtn) {
    e.stopPropagation();
    openAddTaskModal(addBtn.dataset.day, addBtn.dataset.slot);
    return;
  }
  const li = e.target.closest('li.task');
  if (!li) return;
  const taskId = li.dataset.taskId;
  if (editMode && currentUser && currentUser.role === 'editor') {
    e.stopPropagation();
    openTaskMenu(taskId, li);
  } else {
    toggleTask(taskId, li);
  }
}

// ── OPS ────────────────────────────────────────────────────────
async function pushOp(op) {
  if (!currentPlanningId) {
    setSyncStatus('error', 'Aucun planning sélectionné');
    throw new Error('Aucun planning sélectionné');
  }
  setSyncStatus('syncing', 'Sauvegarde…');
  isSyncing = true;
  try {
    const next = await apiFetch(withPlanning(API_STATE), {
      method: 'POST',
      body: JSON.stringify({ ...op, planningId: currentPlanningId }),
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
    renderPlanning();
    throw e;
  } finally {
    isSyncing = false;
  }
}

async function toggleTask(taskId, li) {
  if (!currentUser) {
    openLoginGate();
    return;
  }
  const task = currentState && currentState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const nextDone = !task.done;
  if (li) li.classList.toggle('done', nextDone);
  try {
    await pushOp({ op: 'toggle', taskId, done: nextDone });
  } catch {
    /* rolled back by renderPlanning in pushOp catch */
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
let modalMode = null; // 'rename' | 'move' | 'add'
let editTaskId = null;
let editAddContext = null; // { dayId, slotId }

function openEditModal(task) {
  modalMode = 'rename';
  editTaskId = task.id;
  $('edit-modal-title').textContent = 'Renommer la tâche';
  $('edit-text').value = task.text;
  $('edit-text').disabled = false;
  $('edit-location').style.display = 'none';
  $('edit-error').textContent = '';
  $('edit-modal').classList.remove('hidden');
  setTimeout(() => $('edit-text').focus(), 50);
}

function openMoveModal(task) {
  modalMode = 'move';
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
  modalMode = 'add';
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
  if (!currentState) return;
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
  modalMode = null;
  editTaskId = null;
  editAddContext = null;
}

async function submitEditModal() {
  const text = $('edit-text').value.trim();
  const errEl = $('edit-error');
  errEl.textContent = '';
  try {
    if (modalMode === 'rename') {
      if (!text) { errEl.textContent = 'Texte vide'; return; }
      await pushOp({ op: 'edit', taskId: editTaskId, text });
    } else if (modalMode === 'add') {
      if (!text) { errEl.textContent = 'Texte vide'; return; }
      const dayId = $('edit-day').value;
      const slotId = $('edit-slot').value;
      await pushOp({ op: 'add', dayId, slotId, text });
    } else if (modalMode === 'move') {
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

// === PART 3 END — users modal + fetchState + poll + init in 4/4 ===
