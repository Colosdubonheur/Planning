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
// Per-user expand state in the "Gestion des utilisateurs" modal: by default
// each user row only shows the plannings they're assigned to; expanding a
// row reveals the unassigned ones so the admin can grant new access.
const expandedUserPlannings = new Set();

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
    refreshEmptyState();
    return;
  }
  $('btn-login').style.display = 'none';
  $('user-chip').style.display = '';
  $('user-name').textContent = currentUser.user;
  const roleLabel = currentUser.role === 'directeur' ? 'Directeur' : 'Formateur';
  $('user-role-label').textContent = roleLabel;
  $('btn-logout').style.display = '';
  if (picker) picker.style.display = '';
  // Share button is available to anyone logged in, regardless of role.
  $('btn-share-planning').style.display = currentPlanningId ? '' : 'none';

  // Creating a new planning + managing sub-users: directeur role only.
  $('btn-new-planning').style.display = isDirecteur() ? '' : 'none';
  $('btn-users').style.display = canManageUsers() ? '' : 'none';

  // Edit mode (task content editing) is available to anyone assigned to the
  // current planning — both directeurs and formateurs need it.
  if (canEditContent()) {
    $('btn-edit-mode').style.display = '';
    $('btn-edit-mode').classList.toggle('active', editMode);
    document.body.classList.toggle('edit-mode', editMode);
    if (tip) {
      tip.textContent = editMode
        ? '✎ Mode édition — tapez un item pour le modifier'
        : '💡 Cliquez un item pour le cocher · « ✎ Modifier » pour éditer';
    }
  } else {
    $('btn-edit-mode').style.display = 'none';
    editMode = false;
    document.body.classList.remove('edit-mode');
    if (tip) tip.textContent = '💡 Cliquez un item pour le cocher';
  }

  // Owner-only actions on the current planning: reset, rename, delete.
  // (setSchedule is triggered through the rename/edit modal, same gate.)
  const owner = isOwnerOfCurrent();
  $('btn-reset').style.display = owner ? '' : 'none';
  $('btn-rename-planning').style.display = owner ? '' : 'none';
  $('btn-delete-planning').style.display = owner ? '' : 'none';

  refreshEmptyState();
}

function toggleEditMode() {
  if (!canEditContent()) return;
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('btn-edit-mode').classList.toggle('active', editMode);
  applyUserUI();
  renderPlanning();
  setSyncStatus('ok', editMode ? 'Mode édition ✎' : 'En ligne ✓');
}

// ── PERMISSION HELPERS ──────────────────────────────────────────
// directeur: can create plannings, manage sub-users, and (when owning a
//   planning) modify its dates/name, delete it, reset task state.
// formateur: can only edit task content and tick tasks on plannings they've
//   been assigned to.
function isDirecteur() {
  return !!(currentUser && currentUser.role === 'directeur');
}

// True when the user has an actual grant on the current planning (as opposed
// to viewing it via a public share link).  Used to distinguish "editing
// collaborator" from "read-only viewer".
function hasAccessToCurrent() {
  if (!currentUser || !currentPlanningId) return false;
  return planningsList.some((p) => p.id === currentPlanningId);
}

// Can the current user edit task content on the current planning?  True for
// both directeurs and formateurs as long as they're assigned to it.
function canEditContent() {
  return hasAccessToCurrent();
}

// Is the current user the owner (creator) of the current planning?
// Owner-only gates: rename, delete, reset, setSchedule (dates/duration).
function isOwnerOfCurrent() {
  if (!currentUser || !currentPlanningId) return false;
  const p = planningsList.find((x) => x.id === currentPlanningId);
  return !!(p && p.ownerId === currentUser.user);
}

// Can the current user create sub-users?  Directeur role only.
function canManageUsers() {
  return isDirecteur();
}

// Is the current user the "master" of the hierarchy (the root user with no
// parent)?  Only the master can create directeurs, toggle auto-assign, or
// modify existing users' roles.  Regular directeurs are limited to creating
// formateurs under themselves.
function isMaster() {
  return !!(currentUser && currentUser.isMaster === true);
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

  refreshEmptyState();
}

// Toggle the empty-state card vs the planning table.  Three cases:
//   - logged-in editor with no planning  → empty card with create button
//   - logged-in validator with no planning → empty card explaining they need
//     an editor to grant them access
//   - anonymous viewer with no planning   → invite to log in
function refreshEmptyState() {
  const empty = $('empty-state');
  const tableWrap = $('table-scroll');
  const msg = $('empty-state-message');
  const btn = $('empty-state-create');
  if (!empty || !tableWrap) return;
  const showEmpty = !currentPlanningId;
  empty.classList.toggle('hidden', !showEmpty);
  tableWrap.style.display = showEmpty ? 'none' : '';
  if (!showEmpty) return;

  if (!currentUser) {
    msg.textContent = 'Connectez-vous pour accéder à vos plannings, ou ouvrez un lien de partage en lecture seule.';
    btn.style.display = 'none';
    return;
  }
  if (isDirecteur()) {
    msg.textContent = "Vous n'avez encore aucun planning. Créez-en un pour commencer à organiser votre stage.";
    btn.style.display = '';
    btn.disabled = false;
  } else {
    // Formateurs can't create their own plannings — they need a directeur
    // to grant them access to an existing one.
    msg.textContent = "Aucun planning ne vous a été attribué. Demandez à votre directeur de vous donner accès à un planning existant.";
    btn.style.display = 'none';
  }
}

async function onPlanningSelectChange(id) {
  if (!id || id === currentPlanningId) return;
  rememberPlanningId(id);
  await fetchState();
  renderPlanningSelector();
  // Re-evaluate UI because ownership (and therefore editing rights) depends
  // on which planning is active.
  applyUserUI();
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
  const isEditor = canEditContent();
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
  if (editMode && canEditContent()) {
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
  $('new-user-role').value = 'formateur';
  const autoCb = $('new-user-auto');
  if (autoCb) autoCb.checked = false;
  // Reset the per-row expand state so the modal always opens in compact mode.
  expandedUserPlannings.clear();

  // Gate the role dropdown + auto-assign section on master status.
  // Non-masters can only create formateurs so the dropdown is redundant.
  const roleField = $('new-user-role-field');
  const title = $('new-user-section-title');
  const hint = $('new-user-section-hint');
  if (roleField) roleField.style.display = isMaster() ? '' : 'none';
  if (title) {
    title.textContent = isMaster()
      ? 'Nouveau sous-utilisateur'
      : 'Nouveau formateur';
  }
  if (hint) {
    hint.style.display = isMaster() ? '' : 'none';
  }

  onNewUserRoleChange();
  renderNewUserPlanningPicker();
  await refreshUsersList();
}

// Show/hide the auto-assign checkbox based on the selected role.  It only
// applies to directeurs (formateurs can't own plannings so the flag would
// be a no-op) AND only the master of the hierarchy can flip it.
function onNewUserRoleChange() {
  const field = $('new-user-auto-field');
  const cb = $('new-user-auto');
  if (!field || !cb) return;
  if (isMaster() && $('new-user-role').value === 'directeur') {
    field.style.display = '';
  } else {
    field.style.display = 'none';
    cb.checked = false;
  }
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

// Toggle a user row's "expand" state in the users modal.  Collapsed rows
// only show the user's currently-assigned plannings; expanding reveals the
// unassigned ones so the admin can grant access to more plannings without
// leaving the modal.
function toggleUserPlannings(user) {
  if (expandedUserPlannings.has(user)) expandedUserPlannings.delete(user);
  else expandedUserPlannings.add(user);
  refreshUsersList();
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
      header.style.flexWrap = 'wrap';
      const isSelf = currentUser && u.user === currentUser.user;
      const parentLabel = u.parent ? ` <span style="color:#888;font-weight:500;font-size:7pt">(créé par ${escapeHtml(u.parent)})</span>` : '';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'u-name';
      nameSpan.innerHTML = `${escapeHtml(u.user)}${isSelf ? ' <span style="color:#888;font-weight:400">(vous)</span>' : parentLabel}`;
      header.appendChild(nameSpan);

      const isTargetMaster = u.parent === null;
      const canEditRoles = isMaster();

      // Role control: editable dropdown for the master, static badge for
      // regular directeurs (they can't change roles at all).  Self- and
      // master-editing are always blocked — the master's role is locked
      // and nobody can demote themselves.
      if (canEditRoles && !isSelf && !isTargetMaster) {
        const roleSel = document.createElement('select');
        roleSel.className = `u-role-select ${u.role}`;
        roleSel.title = 'Changer le rôle de cet utilisateur';
        for (const r of ['formateur', 'directeur']) {
          const opt = document.createElement('option');
          opt.value = r;
          opt.textContent = r === 'directeur' ? 'Directeur' : 'Formateur';
          if (u.role === r) opt.selected = true;
          roleSel.appendChild(opt);
        }
        roleSel.addEventListener('change', async () => {
          const previous = u.role;
          const next = roleSel.value;
          roleSel.disabled = true;
          try {
            await apiFetch(`${API_USERS}/${encodeURIComponent(u.user)}`, {
              method: 'PATCH',
              body: JSON.stringify({ role: next }),
            });
            $('users-error').textContent = '';
            await refreshUsersList();
          } catch (e) {
            roleSel.value = previous;
            $('users-error').textContent = e.message || 'Erreur';
            roleSel.disabled = false;
          }
        });
        header.appendChild(roleSel);
      } else {
        const badge = document.createElement('span');
        badge.className = `u-role ${u.role}`;
        badge.textContent = isTargetMaster
          ? 'Maître'
          : (u.role === 'directeur' ? 'Directeur' : 'Formateur');
        if (isTargetMaster) badge.title = "Utilisateur maître de la structure";
        header.appendChild(badge);
      }

      // Auto-assign toggle: master-only control, disabled on self and on
      // the master themselves (whose auto-assign is implicit).  For
      // non-master viewers we still display the current state (read-only)
      // so they can see which directors are super-admins.
      const autoLocked =
        !canEditRoles || isSelf || isTargetMaster || u.role !== 'directeur';
      const autoLbl = document.createElement('label');
      autoLbl.className =
        `u-auto${u.autoAssign ? ' active' : ''}${autoLocked ? ' disabled' : ''}`;
      autoLbl.title = isTargetMaster
        ? "Le maître est toujours auto-assigné"
        : !canEditRoles
        ? "Seul l'utilisateur maître peut modifier l'auto-ajout"
        : isSelf
        ? "Vous ne pouvez pas modifier votre propre auto-ajout"
        : u.role !== 'directeur'
        ? 'Réservé aux directeurs'
        : 'Ajouter automatiquement à tous les nouveaux plannings créés';
      const autoCb = document.createElement('input');
      autoCb.type = 'checkbox';
      autoCb.checked = !!u.autoAssign;
      autoCb.disabled = autoLocked;
      autoCb.addEventListener('change', async () => {
        if (autoLocked) { autoCb.checked = !!u.autoAssign; return; }
        const previous = !!u.autoAssign;
        const next = autoCb.checked;
        autoCb.disabled = true;
        try {
          await apiFetch(`${API_USERS}/${encodeURIComponent(u.user)}`, {
            method: 'PATCH',
            body: JSON.stringify({ autoAssign: next }),
          });
          u.autoAssign = next;
          autoLbl.classList.toggle('active', next);
          $('users-error').textContent = '';
        } catch (e) {
          autoCb.checked = previous;
          $('users-error').textContent = e.message || 'Erreur';
        } finally {
          autoCb.disabled = autoLocked;
        }
      });
      autoLbl.appendChild(autoCb);
      const autoText = document.createElement('span');
      autoText.textContent = '🎯 Auto-ajout';
      autoLbl.appendChild(autoText);
      header.appendChild(autoLbl);

      if (!isSelf) {
        const del = document.createElement('button');
        del.className = 'u-delete';
        del.title = 'Supprimer (cascade)';
        del.textContent = '🗑';
        del.addEventListener('click', () => deleteUserAction(u.user));
        header.appendChild(del);
      }
      li.appendChild(header);

      // Planning access checkboxes.  By default the row is "collapsed" and
      // only shows plannings this user is actually assigned to so the modal
      // stays readable once the structure accumulates dozens of them.  A
      // little "Afficher les N autres" button expands the row and reveals
      // the unassigned plannings as greyed-out checkboxes the admin can
      // click to grant access.
      if (planningsList.length) {
        const access = document.createElement('ul');
        access.className = 'planning-access-list';
        const assignedSet = new Set(
          Array.isArray(u.plannings) ? u.plannings : []
        );
        const expanded = expandedUserPlannings.has(u.user);
        const visiblePlannings = expanded
          ? planningsList
          : planningsList.filter((p) => assignedSet.has(p.id));
        const hiddenCount = planningsList.length - visiblePlannings.length;

        if (visiblePlannings.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'access-empty';
          empty.textContent = "Aucun planning affecté.";
          access.appendChild(empty);
        }

        for (const p of visiblePlannings) {
          const row = document.createElement('li');
          const has = assignedSet.has(p.id);
          if (!has) row.className = 'unassigned';
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
                row.classList.remove('unassigned');
              } else {
                await apiFetch(`${API_USERS}/${encodeURIComponent(u.user)}/plannings/${encodeURIComponent(p.id)}`, {
                  method: 'DELETE',
                });
                row.classList.add('unassigned');
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

        // Expand / collapse toggle.  Only useful when there's actually
        // something to fold or unfold.
        if (expanded || hiddenCount > 0) {
          const toggleRow = document.createElement('li');
          toggleRow.className = 'access-toggle-row';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'access-toggle-btn';
          btn.textContent = expanded
            ? '− Replier (afficher uniquement les plannings affectés)'
            : `+ Afficher les ${hiddenCount} autre${hiddenCount > 1 ? 's' : ''} planning${hiddenCount > 1 ? 's' : ''}`;
          btn.addEventListener('click', () => toggleUserPlannings(u.user));
          toggleRow.appendChild(btn);
          access.appendChild(toggleRow);
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
  // Non-masters can only create formateurs.  We also force that client-side
  // so the UI matches the backend rule and avoids surprise 403s.
  const role = isMaster() ? $('new-user-role').value : 'formateur';
  const autoAssign =
    isMaster() && role === 'directeur' && $('new-user-auto').checked;
  const plannings = getSelectedNewUserPlannings();
  const errEl = $('users-error');
  errEl.textContent = '';
  try {
    await apiFetch(API_USERS, {
      method: 'POST',
      body: JSON.stringify({ user, password, role, autoAssign, plannings }),
    });
    $('new-user-name').value = '';
    $('new-user-pwd').value = '';
    $('new-user-auto').checked = false;
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
      // The big empty-state card carries the call-to-action; the sync badge
      // just states the current condition.
      setSyncStatus('ok', 'En ligne ✓');
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
window.onNewUserRoleChange   = onNewUserRoleChange;
window.toggleUserPlannings   = toggleUserPlannings;
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
