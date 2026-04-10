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
  // Keep the address bar in sync so users can just copy the URL.
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('planning', id);
    else url.searchParams.delete('planning');
    window.history.replaceState(null, '', url.toString());
  } catch {}
}

// ── TOAST ──────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function sharePlanningUrl() {
  if (!currentPlanningId) {
    showToast('Aucun planning sélectionné');
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set('planning', currentPlanningId);
  // Strip any auth-specific fragments — the share link is read-only.
  const link = url.toString();
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch {}
  if (!copied) {
    // Fallback for older browsers / non-secure contexts.
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copied = true;
    } catch {}
  }
  if (copied) showToast('🔗 Lien de partage copié');
  else prompt('Copiez ce lien :', link);
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
  // Share button is available to anyone logged in, regardless of role.
  $('btn-share-planning').style.display = currentPlanningId ? '' : 'none';

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

// ── PLANNING SETTINGS MODAL (shared by create + edit) ─────────
let planningSettingsMode = null; // 'create' | 'edit'

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Best-effort start-date inference for legacy plannings that were migrated
// from the old single-blob "state" and have no `startDate` field.  Parses
// the J1 cell's "11 avr" + "Samedi" and finds the year whose weekday matches.
const FR_MONTHS = {
  'janv': 0, 'janvier': 0,
  'fevr': 1, 'févr': 1, 'fevrier': 1, 'février': 1,
  'mars': 2,
  'avr': 3, 'avril': 3,
  'mai': 4,
  'juin': 5,
  'juil': 6, 'juillet': 6,
  'aout': 7, 'août': 7,
  'sept': 8, 'septembre': 8,
  'oct': 9, 'octobre': 9,
  'nov': 10, 'novembre': 10,
  'dec': 11, 'déc': 11, 'decembre': 11, 'décembre': 11,
};

function inferStartDateFromState(state) {
  if (!state || !Array.isArray(state.days) || !state.days.length) return '';
  const d1 = state.days[0];
  if (!d1 || typeof d1.date !== 'string') return '';
  const m = /^(\d{1,2})\s+([a-zàâéèêëîïôöùûüçÿ]+)\.?$/i.exec(d1.date.trim());
  if (!m) return '';
  const day = parseInt(m[1], 10);
  const monthKey = m[2].toLowerCase().replace(/\.$/, '');
  const month = FR_MONTHS[monthKey];
  if (month === undefined) return '';
  const expectedWeekday = String(d1.name || '').toLowerCase();
  const fmtWeekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });
  const now = new Date();
  const candidates = [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() - 1];
  const toIso = (y) => `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  for (const year of candidates) {
    const date = new Date(year, month, day);
    if (date.getMonth() !== month || date.getDate() !== day) continue;
    const wd = fmtWeekday.format(date).toLowerCase();
    if (!expectedWeekday || wd === expectedWeekday) return toIso(year);
  }
  return toIso(now.getFullYear());
}

function openPlanningSettingsModal(mode) {
  planningSettingsMode = mode;
  $('planning-settings-title').textContent = mode === 'create'
    ? 'Nouveau planning'
    : 'Modifier le planning';
  $('planning-settings-submit').textContent = mode === 'create' ? 'Créer' : 'Enregistrer';
  $('planning-settings-error').textContent = '';
  $('planning-settings-warning').style.display = 'none';
  $('planning-settings-warning').textContent = '';

  if (mode === 'create') {
    $('planning-settings-name').value = '';
    $('planning-settings-start').value = todayIso();
    $('planning-settings-days').value = '8';
  } else {
    const current = planningsList.find((p) => p.id === currentPlanningId);
    if (!current || !currentState) return;
    $('planning-settings-name').value = current.name || '';
    // Pre-fill from currentState; for legacy plannings (no startDate stored)
    // try to infer it from the J1 label so the user doesn't have to retype.
    $('planning-settings-start').value =
      currentState.startDate || inferStartDateFromState(currentState) || '';
    $('planning-settings-days').value = String(currentState.days.length || 8);
  }
  $('planning-settings-modal').classList.remove('hidden');
  setTimeout(() => $('planning-settings-name').focus(), 50);
}

function closePlanningSettingsModal() {
  $('planning-settings-modal').classList.add('hidden');
  planningSettingsMode = null;
}

function recomputeSettingsWarning() {
  // Only relevant in edit mode: warn if reducing the day count would drop tasks.
  const warnEl = $('planning-settings-warning');
  if (planningSettingsMode !== 'edit' || !currentState) {
    warnEl.style.display = 'none';
    return;
  }
  const newCount = parseInt($('planning-settings-days').value, 10);
  if (!Number.isInteger(newCount) || newCount >= currentState.days.length) {
    warnEl.style.display = 'none';
    return;
  }
  const droppedDays = currentState.days.slice(newCount);
  const droppedIds = new Set(droppedDays.map((d) => d.id));
  const droppedTasks = currentState.tasks.filter((t) => droppedIds.has(t.dayId)).length;
  if (droppedTasks === 0) {
    warnEl.style.display = 'none';
    return;
  }
  warnEl.textContent = `⚠ Réduire à ${newCount} jours supprimera ${droppedTasks} tâche${droppedTasks > 1 ? 's' : ''} sur les jours retirés.`;
  warnEl.style.display = '';
}

async function submitPlanningSettings() {
  const name = $('planning-settings-name').value.trim();
  const startDate = $('planning-settings-start').value;
  const dayCount = parseInt($('planning-settings-days').value, 10);
  const errEl = $('planning-settings-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Nom obligatoire'; return; }
  const dayCountValid = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 31;

  const submit = $('planning-settings-submit');
  submit.disabled = true;

  try {
    if (planningSettingsMode === 'create') {
      // Both required at creation since the planning needs a calendar.
      if (!startDate) { errEl.textContent = 'Date de début obligatoire'; return; }
      if (!dayCountValid) { errEl.textContent = 'Nombre de jours invalide (1 à 31)'; return; }

      const data = await apiFetch(API_PLANNINGS, {
        method: 'POST',
        body: JSON.stringify({ name, startDate, dayCount }),
      });
      await loadPlanningsList();
      rememberPlanningId(data.planning.id);
      await fetchState();
      renderPlanningSelector();
      setSyncStatus('ok', 'Planning créé ✓');
      showToast('Planning créé');
    } else if (planningSettingsMode === 'edit') {
      if (!currentPlanningId || !currentState) throw new Error('Aucun planning sélectionné');
      const current = planningsList.find((p) => p.id === currentPlanningId);
      const nameChanged = !current || current.name !== name;
      const currentStart = currentState.startDate || '';
      const currentCount = currentState.days.length;

      // We only call setSchedule when the user actually wants to change the
      // calendar — otherwise renaming alone is allowed even if the date
      // field is empty (legacy plannings) or unchanged.
      const datesChanged = startDate !== currentStart || dayCount !== currentCount;

      if (datesChanged) {
        if (!startDate) {
          errEl.textContent = 'Date de début obligatoire pour modifier le calendrier';
          return;
        }
        if (!dayCountValid) {
          errEl.textContent = 'Nombre de jours invalide (1 à 31)';
          return;
        }
        // Symmetric with the destructive-delete UX: an extra confirm() if any
        // tasks would actually be lost.
        if (dayCount < currentCount) {
          const droppedDays = currentState.days.slice(dayCount);
          const droppedIds = new Set(droppedDays.map((d) => d.id));
          const droppedTasks = currentState.tasks.filter((t) => droppedIds.has(t.dayId)).length;
          if (droppedTasks > 0 && !confirm(`Réduire à ${dayCount} jours supprimera ${droppedTasks} tâche${droppedTasks > 1 ? 's' : ''}. Continuer ?`)) {
            submit.disabled = false;
            return;
          }
        }
      }

      if (!nameChanged && !datesChanged) {
        // Nothing to do — close silently.
        closePlanningSettingsModal();
        return;
      }

      if (nameChanged) {
        await apiFetch(`${API_PLANNINGS}/${encodeURIComponent(currentPlanningId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
      }
      if (datesChanged) {
        await pushOp({ op: 'setSchedule', startDate, dayCount });
      }
      await loadPlanningsList();
      renderPlanningSelector();
      setSyncStatus('ok', 'Planning mis à jour ✓');
      showToast('Planning mis à jour');
    }
    closePlanningSettingsModal();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  } finally {
    submit.disabled = false;
  }
}

function createPlanningPrompt() { openPlanningSettingsModal('create'); }
function renamePlanningPrompt() { openPlanningSettingsModal('edit'); }

// Type-to-confirm delete: opens a dedicated modal that requires the user to
// type the word "supprimer" before the destructive button is enabled.  This
// is intentionally heavier than a native confirm() because the action is
// irreversible and easy to mis-tap on mobile.
const DELETE_CONFIRM_WORD = 'supprimer';

function deletePlanningPrompt() {
  if (!currentPlanningId) return;
  const current = planningsList.find((p) => p.id === currentPlanningId);
  if (!current) return;
  $('delete-planning-name').textContent = current.name;
  const input = $('delete-planning-confirm');
  input.value = '';
  $('delete-planning-error').textContent = '';
  $('delete-planning-confirm-btn').disabled = true;
  $('delete-planning-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeDeletePlanningModal() {
  $('delete-planning-modal').classList.add('hidden');
  $('delete-planning-confirm').value = '';
  $('delete-planning-confirm-btn').disabled = true;
  $('delete-planning-error').textContent = '';
}

async function confirmDeletePlanning() {
  const input = $('delete-planning-confirm');
  if (input.value.trim().toLowerCase() !== DELETE_CONFIRM_WORD) {
    $('delete-planning-error').textContent = `Tapez exactement « ${DELETE_CONFIRM_WORD} » pour confirmer.`;
    return;
  }
  if (!currentPlanningId) { closeDeletePlanningModal(); return; }
  const btn = $('delete-planning-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Suppression…';
  try {
    await apiFetch(`${API_PLANNINGS}/${encodeURIComponent(currentPlanningId)}`, { method: 'DELETE' });
    rememberPlanningId(null);
    await loadPlanningsList();
    if (planningsList.length) rememberPlanningId(planningsList[0].id);
    if (currentPlanningId) await fetchState();
    else { currentState = null; $('planning-table').innerHTML = ''; updateProgress(); }
    renderPlanningSelector();
    setSyncStatus('ok', 'Planning supprimé ✓');
    closeDeletePlanningModal();
    showToast('Planning supprimé');
  } catch (e) {
    $('delete-planning-error').textContent = e.message || 'Erreur lors de la suppression';
  } finally {
    btn.textContent = 'Supprimer définitivement';
    // Re-enable only if the typed word still matches; otherwise leave disabled.
    btn.disabled = input.value.trim().toLowerCase() !== DELETE_CONFIRM_WORD;
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

// ── USERS MODAL ────────────────────────────────────────────────
async function openUsersModal() {
  $('users-modal').classList.remove('hidden');
  $('users-error').textContent = '';
  $('new-user-name').value = '';
  $('new-user-pwd').value = '';
  $('new-user-role').value = 'validator';
  renderNewUserPlanningPicker();
  await refreshUsersList();
}

function closeUsersModal() {
  $('users-modal').classList.add('hidden');
}

function renderNewUserPlanningPicker() {
  const list = $('new-user-plannings');
  if (!list) return;
  list.innerHTML = '';
  if (!planningsList.length) {
    list.innerHTML = '<li style="color:#888">Aucun planning disponible</li>';
    return;
  }
  for (const p of planningsList) {
    const li = document.createElement('li');
    const checked = p.id === currentPlanningId ? 'checked' : '';
    li.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer">
      <input type="checkbox" value="${escapeHtml(p.id)}" ${checked}>
      <span>${escapeHtml(p.name)}</span>
    </label>`;
    list.appendChild(li);
  }
}

function getSelectedNewUserPlannings() {
  const boxes = document.querySelectorAll('#new-user-plannings input[type="checkbox"]:checked');
  return Array.from(boxes).map((b) => b.value);
}

async function refreshUsersList() {
  const listEl = $('users-list');
  listEl.innerHTML = '<li style="color:#888;justify-content:center">Chargement…</li>';
  try {
    const data = await apiFetch(API_USERS);
    const users = Array.isArray(data.users) ? data.users : [];
    listEl.innerHTML = '';
    if (!users.length) {
      listEl.innerHTML = '<li style="color:#888">Aucun utilisateur</li>';
      return;
    }
    for (const u of users) {
      const li = document.createElement('li');
      li.style.flexDirection = 'column';
      li.style.alignItems = 'stretch';
      li.style.gap = '6px';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '10px';
      const isSelf = currentUser && u.user === currentUser.user;
      const parentLabel = u.parent ? ` <span style="color:#888;font-weight:500;font-size:7pt">(créé par ${escapeHtml(u.parent)})</span>` : '';
      header.innerHTML = `
        <span class="u-name">${escapeHtml(u.user)}${isSelf ? ' <span style="color:#888;font-weight:400">(vous)</span>' : parentLabel}</span>
        <span class="u-role ${u.role}">${u.role === 'editor' ? 'Éditeur' : 'Validateur'}</span>
      `;
      if (!isSelf) {
        const del = document.createElement('button');
        del.className = 'u-delete';
        del.title = 'Supprimer (cascade)';
        del.textContent = '🗑';
        del.addEventListener('click', () => deleteUserAction(u.user));
        header.appendChild(del);
      }
      li.appendChild(header);

      // Planning access checkboxes for this user — only plannings visible to
      // the caller are listed.  The caller can't toggle their own access.
      if (planningsList.length) {
        const access = document.createElement('ul');
        access.className = 'planning-access-list';
        for (const p of planningsList) {
          const row = document.createElement('li');
          const has = Array.isArray(u.plannings) && u.plannings.includes(p.id);
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = has;
          cb.disabled = isSelf;
          cb.addEventListener('change', async () => {
            cb.disabled = true;
            try {
              if (cb.checked) {
                await apiFetch(`${API_USERS}/${encodeURIComponent(u.user)}/plannings`, {
                  method: 'POST',
                  body: JSON.stringify({ planningId: p.id }),
                });
              } else {
                await apiFetch(`${API_USERS}/${encodeURIComponent(u.user)}/plannings/${encodeURIComponent(p.id)}`, {
                  method: 'DELETE',
                });
              }
              $('users-error').textContent = '';
            } catch (e) {
              cb.checked = !cb.checked;
              $('users-error').textContent = e.message || 'Erreur';
            } finally {
              cb.disabled = isSelf ? true : false;
            }
          });
          const label = document.createElement('label');
          label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;flex:1';
          label.appendChild(cb);
          const span = document.createElement('span');
          span.textContent = p.name;
          label.appendChild(span);
          row.appendChild(label);
          access.appendChild(row);
        }
        li.appendChild(access);
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
  const plannings = getSelectedNewUserPlannings();
  const errEl = $('users-error');
  errEl.textContent = '';
  try {
    await apiFetch(API_USERS, {
      method: 'POST',
      body: JSON.stringify({ user, password, role, plannings }),
    });
    $('new-user-name').value = '';
    $('new-user-pwd').value = '';
    await refreshUsersList();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  }
}

async function deleteUserAction(user) {
  if (!confirm(`Supprimer l'utilisateur « ${user} » et tous ses sous-utilisateurs ?`)) return;
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
  if (!currentPlanningId) { currentState = null; renderPlanning(); return null; }
  const state = await apiFetch(withPlanning(API_STATE));
  currentState = state;
  lastVersion = state.version || 0;
  renderPlanning();
  return state;
}

async function poll() {
  if (isSyncing) return;
  if (!currentPlanningId) return;
  try {
    const state = await apiFetch(withPlanning(API_STATE));
    if ((state.version || 0) !== lastVersion) {
      currentState = state;
      renderPlanning();
    }
    failCount = 0;
    setSyncStatus('ok', currentUser ? 'En ligne ✓' : 'Lecture seule');
  } catch (e) {
    failCount++;
    if (failCount >= 3) setSyncStatus('offline', 'Hors ligne');
  }
}

// Pick the active planning given the list the user has access to.
// Priority: URL ?planning=<id> > stored id > first in list.
function pickInitialPlanningId(list) {
  const urlId = new URLSearchParams(window.location.search).get('planning');
  const stored = readStoredPlanningId();
  const ids = list.map((p) => p.id);
  if (urlId && ids.includes(urlId)) return urlId;
  if (stored && ids.includes(stored)) return stored;
  return list[0] ? list[0].id : null;
}

// ── INIT ───────────────────────────────────────────────────────
async function startAuthenticated() {
  hideLoginGate();
  applyUserUI();
  setSyncStatus('syncing', 'Connexion…');
  try {
    await loadPlanningsList();
    const nextId = pickInitialPlanningId(planningsList);
    rememberPlanningId(nextId);
    renderPlanningSelector();
    if (nextId) {
      await fetchState();
      setSyncStatus('ok', 'En ligne ✓');
    } else {
      currentState = null;
      $('planning-table').innerHTML = '';
      updateProgress();
      setSyncStatus('ok', 'Aucun planning — créez-en un');
    }
    failCount = 0;
  } catch (e) {
    setSyncStatus('offline', 'Hors ligne');
  }
  applyUserUI();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

async function startPublic() {
  currentUser = null;
  planningsList = [];
  hideLoginGate();
  applyUserUI();
  setSyncStatus('syncing', 'Chargement…');
  // Anonymous visitors can only view a planning whose id is in the URL
  // (shareable read-only link).  If none, we leave the app empty with a
  // login invitation.
  const urlId = new URLSearchParams(window.location.search).get('planning');
  if (urlId) rememberPlanningId(urlId);
  else {
    const stored = readStoredPlanningId();
    if (stored) rememberPlanningId(stored);
  }
  try {
    if (currentPlanningId) {
      await fetchState();
      setSyncStatus('ok', 'Lecture seule');
    } else {
      currentState = null;
      renderPlanning();
      setSyncStatus('ok', 'Connectez-vous pour voir un planning');
    }
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

  const settingsDays = $('planning-settings-days');
  if (settingsDays) settingsDays.addEventListener('input', recomputeSettingsWarning);

  const delInput = $('delete-planning-confirm');
  const delBtn = $('delete-planning-confirm-btn');
  if (delInput && delBtn) {
    delInput.addEventListener('input', () => {
      delBtn.disabled = delInput.value.trim().toLowerCase() !== DELETE_CONFIRM_WORD;
      $('delete-planning-error').textContent = '';
    });
    delInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !delBtn.disabled) {
        e.preventDefault();
        confirmDeletePlanning();
      } else if (e.key === 'Escape') {
        closeDeletePlanningModal();
      }
    });
  }

  const me = await loadMe();
  if (me) {
    await startAuthenticated();
  } else {
    await startPublic();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
});

// Expose functions used by inline onclick handlers
window.openUsersModal        = openUsersModal;
window.closeUsersModal       = closeUsersModal;
window.submitNewUser         = submitNewUser;
window.closeEditModal        = closeEditModal;
window.resetAll              = resetAll;
window.logout                = logout;
window.openLoginGate         = openLoginGate;
window.closeLoginGate        = closeLoginGate;
window.toggleEditMode        = toggleEditMode;
window.onPlanningSelectChange = onPlanningSelectChange;
window.createPlanningPrompt  = createPlanningPrompt;
window.renamePlanningPrompt  = renamePlanningPrompt;
window.deletePlanningPrompt  = deletePlanningPrompt;
window.closeDeletePlanningModal = closeDeletePlanningModal;
window.confirmDeletePlanning = confirmDeletePlanning;
window.sharePlanningUrl      = sharePlanningUrl;
window.closePlanningSettingsModal = closePlanningSettingsModal;
window.submitPlanningSettings = submitPlanningSettings;

window.addEventListener('DOMContentLoaded', init);
