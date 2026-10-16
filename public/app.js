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
  $('btn-anima-sync').style.display = owner ? '' : 'none';
  $('btn-history').style.display = owner ? '' : 'none';

  refreshEmptyState();
}

function toggleEditMode() {
  if (!canEditContent()) return;
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('btn-edit-mode').classList.toggle('active', editMode);
  initDragAndDrop();
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
  document.title = current ? current.name : 'Planning';
  $('planning-subtitle').textContent = current
    ? `Planning synchronisé · ${planningsList.length} disponible${planningsList.length > 1 ? 's' : ''}`
    : 'Aucun planning accessible';

  // Only the owner may rename/delete.
  const canOwn = current && currentUser && current.ownerId === currentUser.user;
  $('btn-rename-planning').style.display = canOwn ? '' : 'none';
  $('btn-delete-planning').style.display = canOwn ? '' : 'none';
  $('btn-anima-sync').style.display = canOwn ? '' : 'none';
  $('btn-history').style.display = canOwn ? '' : 'none';

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
  // Keep the empty-state card / table visibility in sync with the current
  // selection.  Without this, opening a share link as an anonymous visitor
  // leaves the "Aucun planning" card visible on top of the freshly loaded
  // table, because startPublic() shows the empty-state before the URL's
  // planning id has been applied and nothing refreshes it afterwards.
  refreshEmptyState();
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
            <span class="task-text">${escapeHtml(t.text)}${taskBadges(t)}</span>
            ${showDetailsButton(t) ? `<button type="button" class="task-info" data-action="details" title="Fiche du module" aria-label="Fiche du module">›</button>` : ''}
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

  renderDayView();
  updateProgress();
  lastVersion = currentState.version || 0;
  initDragAndDrop();
  refreshDetailsModal();
}

// ── MOBILE DAY VIEW ────────────────────────────────────────────
// On a phone the 8-column table is unreadable: one day at a time, with
// day tabs, big tap targets and the advised time of each module.
const MOBILE_MQ = window.matchMedia('(max-width: 720px)');
let dayViewDayId = null;
const DV_SLOT_ICON = { matin: '☀️', aprem: '🌤', veillee: '🌙' };

function horaireOf(t) {
  const m = /Horaire conseillé : ([^\n(,]+)/.exec((t.details && t.details.deroule) || '');
  return m ? m[1].trim() : '';
}

function dayStorageKey() { return 'pb-day-' + (currentPlanningId || ''); }

function defaultDayId() {
  const days = currentState.days;
  try {
    const saved = localStorage.getItem(dayStorageKey());
    if (saved && days.some((d) => d.id === saved)) return saved;
  } catch {}
  const start = currentState.startDate || inferStartDateFromState(currentState);
  if (start) {
    const i = Math.round((new Date(todayIso() + 'T12:00:00') - new Date(start + 'T12:00:00')) / 86400000);
    if (i >= 0 && i < days.length) return days[i].id;
  }
  return days[0] && days[0].id;
}

function todayDayId() {
  const start = currentState.startDate || inferStartDateFromState(currentState);
  if (!start) return null;
  const i = Math.round((new Date(todayIso() + 'T12:00:00') - new Date(start + 'T12:00:00')) / 86400000);
  return currentState.days[i] ? currentState.days[i].id : null;
}

function setDayViewDay(id) {
  dayViewDayId = id;
  try { localStorage.setItem(dayStorageKey(), id); } catch {}
  renderDayView();
  const dv = $('day-view');
  if (dv) window.scrollTo({ top: Math.max(0, dv.getBoundingClientRect().top + window.scrollY - 4) });
}

function renderDayView() {
  const dv = $('day-view');
  if (!dv) return;
  if (!currentState || !currentState.days.length) { dv.innerHTML = ''; return; }
  const { days, slots, tasks } = currentState;
  if (!days.some((d) => d.id === dayViewDayId)) dayViewDayId = defaultDayId();
  const today = todayDayId();
  const isEditor = canEditContent();
  let html = '<div class="dv-tabs" role="tablist">';
  for (const d of days) {
    const cls = (d.id === dayViewDayId ? ' active' : '') + (d.id === today ? ' today' : '');
    html += `<button type="button" class="dv-tab${cls}" data-dv-day="${escapeHtml(d.id)}" role="tab">
      <small>${escapeHtml(d.short || '')}</small><b>${escapeHtml((d.name || '').slice(0, 3))}</b><small>${escapeHtml(d.date || '')}</small></button>`;
  }
  html += '</div><div class="dv-day">';
  const day = days.find((d) => d.id === dayViewDayId);
  html += `<div class="dv-title">${escapeHtml(day.short || '')} · ${escapeHtml(day.name || '')} ${escapeHtml(day.date || '')}</div>`;
  for (const slot of slots) {
    if (slot.id === 'repas') { html += '<div class="dv-repas">🍽 Repas</div>'; continue; }
    const list = tasks.filter((t) => t.dayId === day.id && t.slotId === slot.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!list.length && !(isEditor && editMode)) continue;
    html += `<section class="dv-slot sl-${escapeHtml(slot.id)}"><h3>${DV_SLOT_ICON[slot.id] || ''} ${escapeHtml(slot.label)}</h3><ul class="tasks">`;
    for (const t of list) {
      const h = horaireOf(t);
      html += `<li class="task${t.done ? ' done' : ''}" data-task-id="${escapeHtml(t.id)}">
        <span class="chk" role="checkbox" aria-checked="${t.done ? 'true' : 'false'}" aria-label="Fait"></span>
        <span class="task-text">${h ? `<span class="dv-time">${escapeHtml(h)}</span>` : ''}${escapeHtml(t.text)}${taskBadges(t)}</span>
        ${showDetailsButton(t) ? '<span class="dv-go" aria-hidden="true">›</span>' : ''}
      </li>`;
    }
    html += '</ul>';
    if (isEditor) html += `<button class="btn-add-task" data-action="add" data-day="${escapeHtml(day.id)}" data-slot="${escapeHtml(slot.id)}" type="button">+ Ajouter</button>`;
    html += '</section>';
  }
  const idx = days.findIndex((d) => d.id === day.id);
  html += '<div class="dv-nav">'
    + (idx > 0 ? `<button type="button" data-dv-day="${escapeHtml(days[idx - 1].id)}">‹ ${escapeHtml(days[idx - 1].short)} ${escapeHtml(days[idx - 1].name)}</button>` : '<span></span>')
    + (idx < days.length - 1 ? `<button type="button" data-dv-day="${escapeHtml(days[idx + 1].id)}">${escapeHtml(days[idx + 1].short)} ${escapeHtml(days[idx + 1].name)} ›</button>` : '<span></span>')
    + '</div></div>';
  dv.innerHTML = html;
  const active = dv.querySelector('.dv-tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function onDayViewClick(e) {
  const tab = e.target.closest('[data-dv-day]');
  if (tab) { setDayViewDay(tab.dataset.dvDay); return; }
  onTableClick(e);
}

// Swipe left / right on the day to change day.
let dvTouch = null;
function onDayViewTouchStart(e) {
  if (e.target.closest('.dv-tabs')) { dvTouch = null; return; }
  const t = e.changedTouches[0];
  dvTouch = { x: t.clientX, y: t.clientY };
}
function onDayViewTouchEnd(e) {
  if (!dvTouch || !currentState) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - dvTouch.x, dy = t.clientY - dvTouch.y;
  dvTouch = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const days = currentState.days;
  const i = days.findIndex((d) => d.id === dayViewDayId) + (dx < 0 ? 1 : -1);
  if (days[i]) setDayViewDay(days[i].id);
}

// ── DRAG & DROP (edit mode) ────────────────────────────────────
// Uses SortableJS (loaded from cdnjs in index.html) because native HTML5
// drag & drop does not work with touch on iPhone.  Active only in edit
// mode so a simple tap still ticks a task.  On touch devices a short press
// (200 ms) starts the drag, so scrolling the table keeps working.
let sortables = [];
let isDragging = false;

function initDragAndDrop() {
  for (const s of sortables) { try { s.destroy(); } catch {} }
  sortables = [];
  if (typeof Sortable === 'undefined') return;
  if (!editMode || !canEditContent()) return;
  document.querySelectorAll('#planning-table td.cell ul.tasks').forEach((ul) => {
    sortables.push(Sortable.create(ul, {
      group: 'tasks',
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onStart() { isDragging = true; closeTaskMenu(); },
      async onEnd(evt) {
        isDragging = false;
        const taskId = evt.item && evt.item.dataset.taskId;
        const cell = evt.to && evt.to.closest('td.cell');
        if (!taskId || !cell) return;
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        try {
          await pushOp({
            op: 'move',
            taskId,
            dayId: cell.dataset.day,
            slotId: cell.dataset.slot,
            index: evt.newIndex,
          });
        } catch (err) {
          showToast(err.message || 'Déplacement impossible');
          renderPlanning();
        }
      },
    }));
  });
}

// ── EVENT DELEGATION ───────────────────────────────────────────
function onTableClick(e) {
  const infoBtn = e.target.closest('[data-action="details"]');
  if (infoBtn) {
    e.stopPropagation();
    const li = infoBtn.closest('li.task');
    if (li) openDetailsModal(li.dataset.taskId);
    return;
  }
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
    return;
  }
  // The box ticks the module; the rest of the line opens its fiche (when
  // there is one to read), which is what people want on a phone.
  if (e.target.closest('.chk')) { toggleTask(taskId, li); return; }
  const t = currentState && currentState.tasks.find((x) => x.id === taskId);
  if (t && showDetailsButton(t)) { openDetailsModal(taskId); return; }
  if (currentUser) toggleTask(taskId, li);
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
  let html = '<button type="button" data-menu-action="details">📋 Fiche du module</button>';
  html += '<button type="button" data-menu-action="rename">✎ Renommer</button>';
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
    if (action === 'details') openDetailsModal(t.id);
    else if (action === 'rename') openEditModal(t);
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
  if (isSyncing || isDragging) return;
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
  // Prefer the planning in progress today (latest start if several overlap).
  const today = todayIso();
  let current = null;
  for (const p of list) {
    const start = p.startDate || (p.firstDay ? inferStartDateFromState({ days: [p.firstDay] }) : '');
    if (!start || !p.dayCount) continue;
    const end = new Date(start + 'T12:00:00');
    end.setDate(end.getDate() + p.dayCount - 1);
    const endIso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    if (start <= today && today <= endIso && (!current || start > current.start)) current = { id: p.id, start };
  }
  if (current) return current.id;
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
    // A shared link pointed to a planning we can't load (deleted, wrong id,
    // etc.).  Clear the stale id so the empty-state card shows, then
    // override the message to tell the visitor exactly what happened — the
    // default "Connectez-vous..." text is misleading in this case.
    if (e && (e.status === 404 || e.status === 400)) {
      rememberPlanningId(null);
      currentState = null;
      renderPlanning();
      const msg = $('empty-state-message');
      if (msg) msg.textContent = "Ce lien de partage n'est plus valide : le planning est introuvable ou a été supprimé.";
      setSyncStatus('ok', 'Lecture seule');
    } else {
      setSyncStatus('offline', 'Hors ligne');
    }
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

async function init() {
  const table = $('planning-table');
  table.addEventListener('click', onTableClick);
  const dv = $('day-view');
  if (dv) {
    dv.addEventListener('click', onDayViewClick);
    dv.addEventListener('touchstart', onDayViewTouchStart, { passive: true });
    dv.addEventListener('touchend', onDayViewTouchEnd, { passive: true });
  }

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
  const inviteId = new URLSearchParams(window.location.search).get('invite');
  if (inviteId) openJoinModal(inviteId);
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

// ── SYNCHRO ANIMA ──────────────────────────────────────────────
// Generates a bookmarklet bound to the current planning.  The bookmarklet
// runs on plateforme.anima-lorraine.fr and loads /anima-sync.js, which
// compares both plannings and pushes in the direction chosen by the user.
async function openAnimaSyncModal() {
  if (!currentPlanningId) return;
  $('anima-sync-error').textContent = '';
  $('anima-sync-link-wrap').style.display = 'none';
  $('anima-sync-modal').classList.remove('hidden');
  try {
    const data = await apiFetch('/api/auth/sync-token', {
      method: 'POST',
      body: JSON.stringify({ planningId: currentPlanningId }),
    });
    const cfg = { api: window.location.origin, planningId: currentPlanningId, token: data.token };
    const code = 'javascript:(function(){window.__PLANNING_BAFA=' + JSON.stringify(cfg)
      + ';var s=document.createElement("script");s.charset="utf-8";s.src=' + JSON.stringify(window.location.origin + '/anima-sync.js?v=')
      + '+Date.now();document.body.appendChild(s);})();';
    const a = $('anima-sync-link');
    a.setAttribute('href', code);
    const current = planningsList.find((p) => p.id === currentPlanningId);
    a.textContent = '🔄 Synchro ' + (current ? current.name : 'planning');
    $('anima-sync-code').value = code;
    $('anima-sync-expiry').textContent = data.expiresInDays + ' jours';
    $('anima-sync-link-wrap').style.display = '';
  } catch (e) {
    $('anima-sync-error').textContent = e.message || 'Erreur';
  }
}

function closeAnimaSyncModal() { $('anima-sync-modal').classList.add('hidden'); }

async function copyAnimaSyncCode() {
  const ta = $('anima-sync-code');
  try { await navigator.clipboard.writeText(ta.value); showToast('Code du favori copié'); }
  catch { ta.select(); document.execCommand('copy'); showToast('Code du favori copié'); }
}

// ── HISTORIQUE DES VERSIONS ────────────────────────────────────
const SLOT_LABELS = { matin: 'Matin', aprem: 'Après-midi', apm: 'Après-midi', veillee: 'Veillée' };

async function openHistoryModal() {
  if (!currentPlanningId) return;
  $('history-modal').classList.remove('hidden');
  $('history-detail').innerHTML = '';
  const list = $('history-list');
  list.innerHTML = '<em>Chargement…</em>';
  try {
    const { versions } = await apiFetch('/api/history?planning=' + encodeURIComponent(currentPlanningId));
    if (!versions.length) {
      list.innerHTML = '<em>Aucune version enregistrée pour l\'instant. Une copie est faite automatiquement à chaque synchro avec Anima et avant chaque restauration.</em>';
      return;
    }
    list.innerHTML = versions.map((v) => `<div class="history-row">
        <span class="history-src ${v.source}">${v.source === 'anima' ? 'Anima' : 'planning-bafa'}</span>
        <span class="history-date">${escapeHtml(new Date(v.at).toLocaleString('fr-FR'))}</span>
        <button type="button" class="modal-btn ghost" onclick="showHistoryVersion('${escapeHtml(v.id)}')">Voir</button>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = '<span class="modal-error">' + escapeHtml(e.message || 'Erreur') + '</span>';
  }
}

function closeHistoryModal() { $('history-modal').classList.add('hidden'); }

let historyCurrent = null;

// Turn either kind of snapshot into [{ day, slot, items: [text] }].
function snapshotCells(snap) {
  const cells = [];
  if (snap.source === 'anima') {
    const { jours = {}, titles = {} } = snap.data || {};
    for (const [key, arr] of Object.entries(jours)) {
      const m = /^(j\d+)_(matin|apm|veillee)$/.exec(key);
      if (!m || !Array.isArray(arr) || !arr.length) continue;
      cells.push({
        day: m[1], slot: m[2],
        items: arr.map((e) => {
          const id = typeof e === 'string' ? e : e && e.id;
          return titles[id] || id;
        }),
      });
    }
  } else {
    const tasks = (snap.data && snap.data.tasks) || [];
    const map = {};
    for (const t of tasks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const k = t.dayId + '|' + t.slotId;
      (map[k] = map[k] || { day: t.dayId, slot: t.slotId, items: [] }).items.push(t.text);
    }
    cells.push(...Object.values(map));
  }
  const n = (d) => parseInt(String(d).slice(1), 10) || 0;
  const o = (s) => ['matin', 'aprem', 'apm', 'veillee'].indexOf(s);
  return cells.sort((a, b) => n(a.day) - n(b.day) || o(a.slot) - o(b.slot));
}

async function showHistoryVersion(id) {
  const box = $('history-detail');
  box.innerHTML = '<em>Chargement…</em>';
  try {
    const { snapshot } = await apiFetch('/api/history?planning=' + encodeURIComponent(currentPlanningId) + '&id=' + encodeURIComponent(id));
    historyCurrent = snapshot;
    const cells = snapshotCells(snapshot);
    const title = (snapshot.source === 'anima' ? 'Copie Anima' : 'Copie planning-bafa')
      + ' du ' + new Date(snapshot.at).toLocaleString('fr-FR')
      + (snapshot.label ? ' (' + snapshot.label + ')' : '');
    let html = `<h4>${escapeHtml(title)}</h4><div class="history-cells">`;
    for (const c of cells) {
      html += `<div class="history-cell"><b>${escapeHtml(c.day.toUpperCase())} · ${escapeHtml(SLOT_LABELS[c.slot] || c.slot)}</b><ul>`
        + c.items.map((t) => `<li>${escapeHtml(t)}</li>`).join('') + '</ul></div>';
    }
    html += '</div><div class="modal-actions">'
      + '<button type="button" class="modal-btn ghost" onclick="downloadHistoryVersion()">⬇ Télécharger</button>'
      + '<button type="button" class="modal-btn primary" onclick="restoreHistoryVersion()">↺ Restaurer dans planning-bafa</button>'
      + '</div><div class="modal-error" id="history-error"></div>';
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<span class="modal-error">' + escapeHtml(e.message || 'Erreur') + '</span>';
  }
}

function downloadHistoryVersion() {
  if (!historyCurrent) return;
  const blob = new Blob([JSON.stringify(historyCurrent, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `planning-${currentPlanningId}-${historyCurrent.source}-${historyCurrent.id}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Restore a version into planning-bafa (the current content is saved as a
// new version first, server side).  An Anima copy can be pushed back to
// Anima afterwards with the bookmarklet ("planning-bafa → Anima").
async function restoreHistoryVersion() {
  if (!historyCurrent || !currentState) return;
  const dayIds = new Set(currentState.days.map((d) => d.id));
  const tasks = [];
  if (historyCurrent.source === 'anima') {
    const { jours = {}, titles = {} } = historyCurrent.data || {};
    for (const [key, arr] of Object.entries(jours)) {
      const m = /^(j\d+)_(matin|apm|veillee)$/.exec(key);
      if (!m || !dayIds.has(m[1]) || !Array.isArray(arr)) continue;
      const slotId = m[2] === 'apm' ? 'aprem' : m[2];
      for (const e of arr) {
        const id = typeof e === 'string' ? e : e && e.id;
        if (!id) continue;
        tasks.push({ dayId: m[1], slotId, text: String(titles[id] || id).slice(0, 300), animaId: id });
      }
    }
  } else {
    const snapTasks = ((historyCurrent.data && historyCurrent.data.tasks) || [])
      .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const t of snapTasks) {
      if (!dayIds.has(t.dayId)) continue;
      tasks.push({ dayId: t.dayId, slotId: t.slotId, text: t.text, ...(t.animaId ? { animaId: t.animaId } : {}) });
    }
  }
  try {
    await pushOp({ op: 'replaceAll', tasks, reason: 'Avant restauration d\'une version' });
    showToast('Version restaurée');
    closeHistoryModal();
  } catch (e) {
    const err = $('history-error');
    if (err) err.textContent = e.message || 'Erreur';
  }
}


// ── FICHE DU MODULE (détails collaboratifs) ────────────────────
// Each module can carry a "fiche" prepared by the team: formateurs, durée,
// objectifs, déroulé, matériel, notes internes, statut de préparation and a
// short text for the trainees (the only part shown on the public link).
// Saving sends only the fields changed in this modal, so two people editing
// different fields of the same module never overwrite each other; a field
// changed remotely while open is refreshed unless you are editing it.
const DETAIL_FIELDS = ['resume', 'duree', 'objectifs', 'deroule', 'materiel', 'notes'];
const STATUS_LABELS = { a_preparer: 'À préparer', en_cours: 'En cours', pret: 'Prêt' };
let detailsTaskId = null;
let detailsBase = null; // values when the modal was opened / last synced

function taskBadges(t) {
  const d = t.details;
  if (!d) return '';
  let out = '';
  if (d.statut) out += `<span class="badge-status st-${escapeHtml(d.statut)}" title="${escapeHtml(STATUS_LABELS[d.statut] || '')}"></span>`;
  if (Array.isArray(d.formateurs) && d.formateurs.length) {
    out += `<span class="badge-who">${escapeHtml(d.formateurs.map((n) => n.split(/\s+/)[0]).join(', '))}</span>`;
  }
  if (d.duree) out += `<span class="badge-dur">${escapeHtml(d.duree)}</span>`;
  return out ? `<span class="task-badges">${out}</span>` : '';
}

function showDetailsButton(t) {
  if (canEditContent()) return true;
  return !!(t.details && (t.details.resume || t.details.duree));
}

function detailsValues(t) {
  const d = (t && t.details) || {};
  const v = { statut: d.statut || '', formateurs: (d.formateurs || []).join(', ') };
  for (const f of DETAIL_FIELDS) v[f] = d[f] || '';
  return v;
}

function knownFormateurs() {
  const set = new Set();
  for (const t of (currentState && currentState.tasks) || []) {
    for (const n of (t.details && t.details.formateurs) || []) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
}

function openDetailsModal(taskId) {
  const t = currentState && currentState.tasks.find((x) => x.id === taskId);
  if (!t) return;
  closeTaskMenu();
  detailsTaskId = taskId;
  detailsBase = detailsValues(t);
  const editable = canEditContent();
  const day = currentState.days.find((d) => d.id === t.dayId);
  const slot = currentState.slots.find((x) => x.id === t.slotId);
  $('details-title').textContent = t.text;
  $('details-where').textContent = [day && `${day.short} ${day.name} ${day.date}`, slot && slot.label].filter(Boolean).join(' · ');
  for (const f of DETAIL_FIELDS) {
    const el = $('det-' + f);
    el.value = detailsBase[f];
    el.readOnly = !editable;
  }
  $('det-formateurs').value = detailsBase.formateurs;
  $('det-formateurs').readOnly = !editable;
  $('det-statut').value = detailsBase.statut;
  $('det-statut').disabled = !editable;
  $('det-formateurs-list').innerHTML = knownFormateurs().map((n) => `<option value="${escapeHtml(n)}">`).join('');
  // Team-only sections are hidden for anonymous viewers (the server does
  // not send them anyway).
  document.querySelectorAll('#details-modal .team-only').forEach((el) => { el.style.display = editable ? '' : 'none'; });
  const fiche = (t.details && t.details.ficheAnima) || '';
  $('det-fiche-wrap').style.display = editable && fiche ? '' : 'none';
  $('det-fiche').textContent = fiche;
  $('details-save').style.display = editable ? '' : 'none';
  $('details-edit').style.display = editable ? '' : 'none';
  $('details-error').textContent = '';
  updateDetailsMeta(t);
  renderDetailsRead(t);
  setDetailsMode('read');
  $('details-modal').classList.remove('hidden');
  const card = $('details-modal').querySelector('.modal-card');
  if (card) card.scrollTop = 0;
}

// Read view of a fiche: formatted text and clickable links, which is what a
// formateur needs on a phone.  "Modifier" switches to the form.
function setDetailsMode(mode) {
  const m = $('details-modal');
  m.classList.toggle('reading', mode !== 'edit');
  m.classList.toggle('editing', mode === 'edit');
}

function richText(s) {
  return String(s || '').split('\n').map((line) => {
    const ln = /^(\s*[•\-]\s*)(.+?)\s:\s(https?:\/\/\S+)\s*$/.exec(line);
    if (ln) return escapeHtml(ln[1]) + `<a href="${escapeHtml(ln[3])}" target="_blank" rel="noopener">${escapeHtml(ln[2])}</a>`;
    return escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 40 ? u.slice(0, 40) + '…' : u}</a>`);
  }).join('\n');
}

function renderDetailsRead(t) {
  const d = t.details || {};
  const chips = [];
  const h = horaireOf(t);
  if (h) chips.push(`<span class="dr-chip time">🕘 ${escapeHtml(h)}</span>`);
  if (d.duree) chips.push(`<span class="dr-chip">⏱ ${escapeHtml(d.duree)}</span>`);
  if (Array.isArray(d.formateurs) && d.formateurs.length) chips.push(`<span class="dr-chip">👤 ${escapeHtml(d.formateurs.join(', '))}</span>`);
  if (d.statut) chips.push(`<span class="dr-chip">${escapeHtml(STATUS_LABELS[d.statut] || d.statut)}</span>`);
  const deroule = String(d.deroule || '').replace(/^Horaire conseillé : [^\n]*\n*/, '').replace(/^Déroulé :\s*\n/, '');
  const materiel = String(d.materiel || '').replace(/^Ressources Anima :\s*\n/, '');
  const secs = [
    ['Pour les stagiaires', d.resume],
    ['Ce qu\'on présente', d.objectifs],
    ['Déroulé', deroule],
    ['Matériel et ressources', materiel],
    ['Notes de l\'équipe', d.notes],
  ].filter(([, v]) => v && String(v).trim());
  let html = chips.length ? `<div class="dr-chips">${chips.join('')}</div>` : '';
  for (const [title, v] of secs) html += `<div class="dr-sec"><h4>${escapeHtml(title)}</h4><div class="dr-body">${richText(String(v).trim())}</div></div>`;
  if (d.ficheAnima && canEditContent()) html += `<div class="dr-sec"><details><summary>Fiche Anima</summary><div class="dr-body">${richText(d.ficheAnima)}</div></details></div>`;
  if (!secs.length && !d.ficheAnima) html += '<div class="dr-empty">Pas encore de contenu pour ce temps.</div>';
  $('details-read').innerHTML = html;
}

function updateDetailsMeta(t) {
  const d = t.details || {};
  $('details-meta').textContent = d.updatedBy
    ? `Dernière modification : ${d.updatedBy}, ${new Date(d.updatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`
    : '';
}

function closeDetailsModal() {
  $('details-modal').classList.add('hidden');
  detailsTaskId = null;
  detailsBase = null;
}

function readDetailsForm() {
  const v = { statut: $('det-statut').value, formateurs: $('det-formateurs').value };
  for (const f of DETAIL_FIELDS) v[f] = $('det-' + f).value;
  return v;
}

// Called after every render: merge remote changes into the open modal.
function refreshDetailsModal() {
  if (!detailsTaskId || $('details-modal').classList.contains('hidden')) return;
  const t = currentState && currentState.tasks.find((x) => x.id === detailsTaskId);
  if (!t) { closeDetailsModal(); showToast('Ce module a été supprimé'); return; }
  const remote = detailsValues(t);
  const local = readDetailsForm();
  const changedRemotely = [];
  for (const k of Object.keys(remote)) {
    if (remote[k] === detailsBase[k]) continue;
    // Not touched locally: take the remote value.
    if (local[k] === detailsBase[k]) {
      const el = k === 'statut' ? $('det-statut') : k === 'formateurs' ? $('det-formateurs') : $('det-' + k);
      el.value = remote[k];
      changedRemotely.push(k);
    }
    detailsBase[k] = remote[k];
  }
  $('details-title').textContent = t.text;
  updateDetailsMeta(t);
  if ($('details-modal').classList.contains('reading')) renderDetailsRead(t);
  if (changedRemotely.length && t.details && t.details.updatedBy !== (currentUser && currentUser.user)) {
    showToast(`Fiche mise à jour par ${t.details.updatedBy}`);
  }
}

async function saveDetails() {
  if (!detailsTaskId) return;
  const now = readDetailsForm();
  const patch = {};
  for (const k of Object.keys(now)) {
    if (now[k] === detailsBase[k]) continue;
    patch[k] = k === 'formateurs'
      ? now[k].split(',').map((x) => x.trim()).filter(Boolean)
      : now[k];
  }
  if (!Object.keys(patch).length) { closeDetailsModal(); return; }
  const btn = $('details-save');
  btn.disabled = true;
  try {
    await pushOp({ op: 'setDetails', taskId: detailsTaskId, details: patch });
    showToast('Fiche enregistrée');
    closeDetailsModal();
  } catch (e) {
    $('details-error').textContent = e.message || 'Erreur';
  } finally {
    btn.disabled = false;
  }
}


// ── INVITATIONS ────────────────────────────────────────────────
// The owner creates a link (valid 14 days, usable by several people) and
// sends it, e.g. on WhatsApp.  Whoever opens it picks an identifiant and a
// password (or joins with their existing account) and gets formateur access
// to the planning.
function inviteUrl(id) {
  return window.location.origin + '/?invite=' + encodeURIComponent(id);
}

// ── ÉQUIPE DU PLANNING ─────────────────────────────────────────
// One place to see who works on the current planning, invite people with a
// link, add someone who already has an account, or remove access.  The old
// all-accounts view stays reachable as "Gestion avancée des comptes".
const ROLE_DESC = {
  directeur: 'Directeur · gère le planning',
  formateur: 'Formateur · modifie le planning et les fiches',
};

async function openTeamModal() {
  if (!currentPlanningId) { openUsersModal(); return; }
  const current = planningsList.find((p) => p.id === currentPlanningId);
  $('team-planning-name').textContent = current ? current.name : '';
  $('team-error').textContent = '';
  $('invite-error').textContent = '';
  const owner = isOwnerOfCurrent();
  $('team-invite-section').style.display = owner ? '' : 'none';
  $('team-add-section').style.display = owner ? '' : 'none';
  $('team-advanced-btn').style.display = canManageUsers() ? '' : 'none';
  $('team-modal').classList.remove('hidden');
  await refreshTeam();
  if (owner) await refreshInviteList();
}

function closeTeamModal() { $('team-modal').classList.add('hidden'); }

// Kept for compatibility with older links/buttons.
function openInviteModal() { return openTeamModal(); }
function closeInviteModal() { closeTeamModal(); }

let teamMembers = [];

async function refreshTeam() {
  const list = $('team-list');
  list.innerHTML = '<li><em>Chargement…</em></li>';
  try {
    const { members } = await apiFetch('/api/plannings/' + encodeURIComponent(currentPlanningId) + '/members');
    teamMembers = members;
    const owner = isOwnerOfCurrent();
    const me = currentUser && currentUser.user;
    list.innerHTML = members.map((m) => {
      const desc = (ROLE_DESC[m.role] || m.role)
        + (m.allPlannings ? ' · accès à tous les plannings' : '')
        + (m.invitedBy && !m.isOwner ? ` · ajouté par ${m.invitedBy}` : '');
      const canRemove = owner && !m.isOwner && m.user !== me;
      return `<li>
        <span class="team-avatar">${escapeHtml(m.user.charAt(0).toUpperCase())}</span>
        <span class="team-who">
          <span class="team-name">${escapeHtml(m.user)}</span>${m.isOwner ? '<span class="team-tag owner">Responsable</span>' : ''}${m.user === me ? '<span class="team-tag me">Vous</span>' : ''}
          <div class="team-desc">${escapeHtml(desc)}</div>
        </span>
        ${canRemove ? `<button type="button" class="team-remove" onclick="removeMember('${escapeHtml(m.user)}')">Retirer</button>` : ''}
      </li>`;
    }).join('');
    if (owner) await refreshAddableAccounts();
  } catch (e) {
    list.innerHTML = '';
    $('team-error').textContent = e.message || 'Erreur';
  }
}

async function refreshAddableAccounts() {
  const sel = $('team-add-select');
  try {
    const data = await apiFetch(API_USERS);
    const inTeam = new Set(teamMembers.map((m) => m.user));
    const addable = (data.users || []).filter((u) => !inTeam.has(u.user));
    sel.innerHTML = addable.length
      ? '<option value="">Choisir un compte…</option>' + addable.map((u) => `<option value="${escapeHtml(u.user)}">${escapeHtml(u.user)} (${u.role === 'directeur' ? 'directeur' : 'formateur'})</option>`).join('')
      : '<option value="">Tous vos comptes ont déjà accès</option>';
    sel.disabled = !addable.length;
  } catch {
    $('team-add-section').style.display = 'none';
  }
}

async function addExistingMember() {
  const user = $('team-add-select').value;
  if (!user) return;
  $('team-error').textContent = '';
  try {
    await apiFetch(API_USERS + '/' + encodeURIComponent(user) + '/plannings', {
      method: 'POST',
      body: JSON.stringify({ planningId: currentPlanningId }),
    });
    showToast(user + ' a maintenant accès au planning');
    await refreshTeam();
  } catch (e) {
    $('team-error').textContent = e.message || 'Erreur';
  }
}

async function removeMember(user) {
  const li = [...document.querySelectorAll('#team-list li')].find((x) => x.querySelector('.team-name')?.textContent === user);
  const btn = li && li.querySelector('.team-remove');
  if (btn && btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Confirmer ?';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Retirer'; } }, 4000);
    return;
  }
  $('team-error').textContent = '';
  try {
    await apiFetch(API_USERS + '/' + encodeURIComponent(user) + '/plannings/' + encodeURIComponent(currentPlanningId), { method: 'DELETE' });
    showToast(user + " n'a plus accès à ce planning");
    await refreshTeam();
  } catch (e) {
    $('team-error').textContent = e.message || 'Erreur';
  }
}

async function refreshInviteList() {
  const box = $('invite-list');
  box.innerHTML = '<em>Chargement…</em>';
  try {
    const { invites } = await apiFetch('/api/invites?planning=' + encodeURIComponent(currentPlanningId));
    const active = invites.filter((i) => i.status === 'valide');
    const joined = invites.flatMap((i) => i.uses || []);
    let html = '';
    if (!active.length) {
      html += '<p class="invite-empty">Aucun lien actif pour le moment.</p>';
    }
    for (const inv of active) {
      const url = inviteUrl(inv.id);
      html += `<div class="invite-row">
        <input readonly value="${escapeHtml(url)}" onclick="this.select()">
        <div class="invite-actions">
          <button type="button" class="modal-btn ghost" onclick="copyText('${escapeHtml(url)}')">Copier</button>
          <a class="modal-btn whatsapp" target="_blank" rel="noopener" href="${escapeHtml(whatsappLink(url))}">WhatsApp</a>
          <button type="button" class="modal-btn ghost" onclick="revokeInvite('${escapeHtml(inv.id)}')">Désactiver</button>
        </div>
        <div class="invite-meta">Valable jusqu'au ${escapeHtml(new Date(inv.expiresAt).toLocaleDateString('fr-FR'))}</div>
      </div>`;
    }
    if (joined.length) {
      html += '<div class="invite-joined"><b>Ont rejoint :</b> ' + joined
        .map((u) => escapeHtml(u.user) + (u.created ? ' (nouveau compte)' : '')).join(', ') + '</div>';
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '';
    $('invite-error').textContent = e.message || 'Erreur';
  }
}

function whatsappLink(url) {
  const current = planningsList.find((p) => p.id === currentPlanningId);
  const name = current ? current.name : 'le planning';
  const text = `Rejoins le planning « ${name} » pour qu'on prépare les temps ensemble : ${url}`;
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('Lien copié'); }
  catch { showToast('Copie impossible, sélectionne le lien'); }
}

async function createInviteLink() {
  $('invite-error').textContent = '';
  try {
    await apiFetch('/api/invites', { method: 'POST', body: JSON.stringify({ planningId: currentPlanningId }) });
    await refreshInviteList();
  } catch (e) {
    $('invite-error').textContent = e.message || 'Erreur';
  }
}

async function revokeInvite(id) {
  try {
    await apiFetch('/api/invites?id=' + encodeURIComponent(id), { method: 'DELETE' });
    await refreshInviteList();
  } catch (e) {
    $('invite-error').textContent = e.message || 'Erreur';
  }
}

// Landing for someone who opened an invitation link.
let joinInviteId = null;

async function openJoinModal(id) {
  joinInviteId = id;
  $('join-error').textContent = '';
  $('join-modal').classList.remove('hidden');
  $('join-form').style.display = 'none';
  $('join-logged').style.display = 'none';
  $('join-title').textContent = 'Invitation';
  $('join-submit').style.display = 'none';
  try {
    const info = await apiFetch('/api/invites?id=' + encodeURIComponent(id));
    if (info.status !== 'valide') {
      $('join-intro').textContent = info.status === 'expire'
        ? "Ce lien d'invitation a expiré. Demande un nouveau lien."
        : "Ce lien d'invitation n'est plus valide. Demande un nouveau lien.";
      return;
    }
    $('join-title').textContent = info.planningName || 'Planning';
    $('join-intro').textContent = `${info.invitedBy} t'invite à préparer ce planning avec l'équipe.`;
    $('join-submit').style.display = '';
    if (currentUser) {
      $('join-logged-name').textContent = currentUser.user;
      $('join-logged').style.display = '';
    } else {
      $('join-form').style.display = '';
      setTimeout(() => $('join-user').focus(), 50);
    }
  } catch (e) {
    $('join-intro').textContent = "Ce lien d'invitation n'est pas valide.";
  }
}

function closeJoinModal() {
  $('join-modal').classList.add('hidden');
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  history.replaceState(null, '', url.toString());
}

async function submitJoin(e) {
  if (e) e.preventDefault();
  const btn = $('join-submit');
  const body = { id: joinInviteId };
  if (!currentUser) {
    body.user = $('join-user').value.trim();
    body.password = $('join-password').value;
    if ($('join-password2').value !== body.password) {
      $('join-error').textContent = 'Les deux mots de passe sont différents';
      return;
    }
  }
  btn.disabled = true;
  $('join-error').textContent = '';
  try {
    const res = await apiFetch('/api/invites/accept', { method: 'POST', body: JSON.stringify(body) });
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    url.searchParams.set('planning', res.planningId);
    history.replaceState(null, '', url.toString());
    $('join-modal').classList.add('hidden');
    await loadMe();
    await startAuthenticated();
    showToast(res.created ? 'Compte créé, bienvenue !' : 'Planning ajouté à ton compte');
  } catch (err) {
    $('join-error').textContent = err.message || 'Erreur';
  } finally {
    btn.disabled = false;
  }
}
