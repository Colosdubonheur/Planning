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
function showToast(message, action) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = () => { el.classList.remove('show'); action.run(); };
    el.appendChild(btn);
  }
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 2200);
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
    $('btn-trash').style.display = 'none';
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
  $('btn-trash').style.display = canEditContent() ? '' : 'none';
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
  $('btn-asm-sync').style.display = owner || (currentUser && currentUser.role === 'directeur') ? '' : 'none';
  $('btn-history').style.display = owner ? '' : 'none';
  $('btn-batch').style.display = owner || (currentUser && currentUser.role === 'directeur') ? '' : 'none';

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
  $('btn-asm-sync').style.display = canOwn || (currentUser && currentUser.role === 'directeur') ? '' : 'none';
  $('btn-history').style.display = canOwn ? '' : 'none';
  $('btn-batch').style.display = canOwn || (currentUser && currentUser.role === 'directeur') ? '' : 'none';

  refreshEmptyState();
}

// Toggle the empty-state card vs the planning table.  Three cases:
//   - logged-in editor with no planning  → empty card with create button
//   - logged-in validator with no planning → empty card explaining they need
//     an editor to grant them access
//   - anonymous viewer with no planning   → invite to log in
// True until the first planning (or the lack of one) is known, and while
// switching planning: the page shows "Chargement du planning…" instead of
// the "Aucun planning" card, which used to flash on every opening.
let planningLoading = true;

function setPlanningLoading(on) {
  planningLoading = !!on;
  refreshEmptyState();
}

function refreshEmptyState() {
  const empty = $('empty-state');
  const tableWrap = $('table-scroll');
  const msg = $('empty-state-message');
  const btn = $('empty-state-create');
  const loading = $('loading-state');
  const search = $('search-bar');
  if (!empty || !tableWrap) return;
  if (loading) loading.classList.toggle('hidden', !planningLoading);
  if (search) search.style.display = !planningLoading && currentState ? '' : 'none';
  if (planningLoading) {
    empty.classList.add('hidden');
    tableWrap.style.display = 'none';
    document.body.classList.add('planning-loading');
    return;
  }
  document.body.classList.remove('planning-loading');
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
  setPlanningLoading(true);
  try { await fetchState(); } finally { setPlanningLoading(false); }
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
// ── TYPES DE TEMPS (couleurs du planning) ──────────────────────
// Deduced from the title, in this order: "Prépa du forum" is a prep time,
// "Grand jeu 2" a big game, "Débrief de la veillée" a regular session.
const CATEGORY_RULES = [
  ['pause', /^pause\b/],
  ['prepa', /^(prepa|preparation)\b|\bprepa(ration)? (des?|du|de la|grands?)\b|cahier des charges/],
  ['forum', /\bforum\b/],
  ['haj', /\bhaj\b/],
  ['grandjeu', /\bgrands? jeux?\b/],
  ['veillee', /^veillee\b/],
  ['kermesse', /kermesse|auberge espagnole/],
  ['intervention', /unicef|intervenant|intervention/],
];
const CATEGORY_LABELS = {
  forum: 'Forum', haj: 'HAJ', prepa: 'Temps de prépa', grandjeu: 'Grands jeux', apport: 'Apports',
  intervention: 'Intervention', veillee: 'Veillée', kermesse: 'Kermesse',
};

function taskCategory(t) {
  const txt = String(t.text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(txt)) return cat;
  return 'apport';
}

// "12h00 - 13h00" between the end of the morning and the start of the afternoon.
function repasHoraire(dayId) {
  const times = (slotId) => currentState.tasks
    .filter((t) => t.dayId === dayId && t.slotId === slotId)
    .map((t) => parseHoraire(horaireOf(t))).filter(Boolean);
  const m = times('matin'), a = times('aprem');
  if (!m.length || !a.length) return '';
  const end = Math.max(...m.map((h) => (h.end != null ? h.end : h.start + 30)));
  const start = Math.min(...a.map((h) => h.start));
  return start > end ? `${fmtHoraire(end)} - ${fmtHoraire(start)}` : '';
}

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

  // One independent column per day (cards), like the printed planning:
  // each day flows on its own instead of aligning the slots across days.
  let html = '';
  for (const d of days) {
    html += `<section class="day-col${d.weekend ? ' weekend' : ''}" data-day="${escapeHtml(d.id)}">
      <div class="day-head">
        <span class="day-name">${escapeHtml(d.name || '')}</span>
        <span class="day-date">${escapeHtml(d.date || '')}</span>
        <span class="day-j">${escapeHtml(d.short || '')}</span>
      </div>`;
    for (const slot of slots) {
      const slotCls = 'sl-' + slot.id;
      if (slot.id === 'repas') {
        const rh = repasHoraire(d.id);
        html += `<div class="cell ${slotCls}" data-day="${escapeHtml(d.id)}" data-slot="repas"><div class="repas-content">Repas${rh ? ` <span class="repas-time">${escapeHtml(rh)}</span>` : ''}</div></div>`;
        continue;
      }
      const cellTasks = tasks
        .filter((t) => t.dayId === d.id && t.slotId === slot.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      html += `<div class="cell ${slotCls}${cellTasks.length ? '' : ' empty'}" data-day="${escapeHtml(d.id)}" data-slot="${escapeHtml(slot.id)}">
        <div class="slot-cap">${escapeHtml(slot.label)}</div><ul class="tasks">`;
      for (const t of cellTasks) {
        const doneCls = t.done ? ' done' : '';
        const th = horaireOf(t);
        html += `<li class="task${doneCls} cat-${taskCategory(t)}" data-task-id="${escapeHtml(t.id)}">
          <span class="chk"></span>
          <span class="task-text">${th ? `<span class="t-time">${escapeHtml(th)}</span>` : ''}<span class="t-title">${escapeHtml(t.text)}</span>${taskBadges(t)}</span>
          ${showDetailsButton(t) ? `<button type="button" class="task-info" data-action="details" title="Fiche du module" aria-label="Fiche du module">›</button>` : ''}
        </li>`;
      }
      html += '</ul>';
      if (isEditor) {
        html += `<button class="btn-add-task" data-action="add" data-day="${escapeHtml(d.id)}" data-slot="${escapeHtml(slot.id)}" type="button">+ Ajouter</button>`;
      }
      html += '</div>';
    }
    html += '</section>';
  }
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

// "9h30 - 11h15" -> { start: 570, end: 675 } (minutes); end may be null.
function parseHoraire(h) {
  const m = /(\d{1,2})\s*h\s*(\d{2})?(?:\s*[-–à]+\s*(\d{1,2})\s*h\s*(\d{2})?)?/i.exec(h || '');
  if (!m) return null;
  const start = +m[1] * 60 + (+m[2] || 0);
  const end = m[3] !== undefined ? +m[3] * 60 + (+m[4] || 0) : null;
  return { start, end };
}
const fmtHoraire = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
const toTimeInput = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromTimeInput = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };

// After a move, offer to adjust the time: starts when the previous block
// ends and keeps the block's duration.  Skipped when nothing has a time.
let horaireTaskId = null;
function offerHoraire(taskId, force) {
  if (!currentState) return;
  const t = currentState.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const col = currentState.tasks
    .filter((x) => x.dayId === t.dayId && x.slotId === t.slotId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = col.findIndex((x) => x.id === taskId);
  const own = parseHoraire(horaireOf(t));
  const prev = i > 0 ? parseHoraire(horaireOf(col[i - 1])) : null;
  const next = i < col.length - 1 ? parseHoraire(horaireOf(col[i + 1])) : null;
  if (!own && !prev && !next && !force) return;
  const dur = own && own.end != null && own.end > own.start ? own.end - own.start : 30;
  // Asked from the menu: start from its own time; after a move: follow the previous block.
  let start = force && own ? own.start
    : prev ? (prev.end != null ? prev.end : prev.start + 30) : next ? next.start : own ? own.start : 9 * 60;
  start = Math.max(0, Math.min(start, 24 * 60 - dur));
  horaireTaskId = taskId;
  $('horaire-task').textContent = t.text;
  $('horaire-current').textContent = horaireOf(t) ? `Horaire actuel : ${horaireOf(t)}` : 'Pas encore d\'horaire';
  $('horaire-start').value = toTimeInput(start);
  $('horaire-end').value = toTimeInput(start + dur);
  $('horaire-error').textContent = '';
  // Blocks after this one in the same slot that can be pushed back too.
  horaireFollowers = own && own.end != null
    ? col.slice(i + 1).map((x) => ({ t: x, h: parseHoraire(horaireOf(x)) }))
      .filter((x) => x.h && x.h.end != null && x.h.start >= own.end - 1)
    : [];
  horaireOldEnd = own && own.end != null ? own.end : null;
  $('horaire-shift').checked = true;
  updateHoraireShift();
  $('horaire-modal').classList.remove('hidden');
}

// Moving the start keeps the duration: the end follows.
function onHoraireStartInput(el) {
  const prev = fromTimeInput(el.dataset.prev), now = fromTimeInput(el.value), end = fromTimeInput($('horaire-end').value);
  if (prev != null && now != null && end != null) {
    const e2 = Math.min(24 * 60 - 1, Math.max(now + 5, end + now - prev));
    $('horaire-end').value = toTimeInput(e2);
  }
  el.dataset.prev = el.value;
  updateHoraireShift();
}

let horaireFollowers = [];
let horaireOldEnd = null;
function horaireDelta() {
  const end = fromTimeInput($('horaire-end').value);
  return end != null && horaireOldEnd != null ? end - horaireOldEnd : 0;
}
function updateHoraireShift() {
  const d = horaireDelta();
  const show = horaireFollowers.length && d !== 0;
  $('horaire-shift-wrap').style.display = show ? '' : 'none';
  if (show) {
    const n = horaireFollowers.length;
    $('horaire-shift-label').textContent = `${d > 0 ? 'Retarder' : 'Avancer'} aussi ${n === 1 ? 'le temps suivant' : `les ${n} temps suivants`} de ${Math.abs(d)} min`;
  }
}

function closeHoraireModal() {
  $('horaire-modal').classList.add('hidden');
  horaireTaskId = null;
}

async function saveHoraire() {
  const t = currentState && currentState.tasks.find((x) => x.id === horaireTaskId);
  if (!t) { closeHoraireModal(); return; }
  const start = fromTimeInput($('horaire-start').value);
  const end = fromTimeInput($('horaire-end').value);
  if (start == null || end == null || end <= start) { $('horaire-error').textContent = 'La fin doit être après le début'; return; }
  const items = [{ taskId: t.id, start, end }];
  const d = horaireDelta();
  if (d && $('horaire-shift').checked && $('horaire-shift-wrap').style.display !== 'none') {
    for (const f of horaireFollowers) {
      const s2 = f.h.start + d, e2 = f.h.end + d;
      if (s2 < 0 || e2 > 24 * 60) { $('horaire-error').textContent = 'Le décalage sort de la journée'; return; }
      items.push({ taskId: f.t.id, start: s2, end: e2 });
    }
  }
  try {
    await pushOp({ op: 'setHoraires', items });
    closeHoraireModal();
    showToast(items.length > 1 ? `Horaires mis à jour (${items.length} temps)` : 'Horaire mis à jour');
  } catch (e) {
    $('horaire-error').textContent = e.message || 'Erreur';
  }
}

function dayStorageKey() { return 'pb-day-' + (currentPlanningId || ''); }

// Today, or tomorrow once today's last timed block is over (or after 22h
// when today has no times): in the evening the useful day is the next one.
function dayIsOver(dayId) {
  const m = nowMinutes();
  const ends = currentState.tasks
    .filter((t) => t.dayId === dayId)
    .map((t) => parseHoraire(horaireOf(t)))
    .filter(Boolean)
    .map((h) => (h.end != null ? h.end : h.start + 30));
  return ends.length ? m >= Math.max(...ends) : m >= 22 * 60;
}

function liveDayId() {
  const today = todayDayId();
  if (!today || !dayIsOver(today)) return today;
  const i = currentState.days.findIndex((d) => d.id === today);
  const next = currentState.days[i + 1];
  return next ? next.id : today;
}

function defaultDayId() {
  const days = currentState.days;
  // During the stage, open on the day in progress (tomorrow once today is
  // over); otherwise on the last day viewed.
  const live = liveDayId();
  if (live) return live;
  try {
    const saved = localStorage.getItem(dayStorageKey());
    if (saved && days.some((d) => d.id === saved)) return saved;
  } catch {}
  return days[0] && days[0].id;
}

// ── "EN COURS" ─────────────────────────────────────────────────
// Today's block whose time covers now (else the next one), from the
// "Horaire conseillé" of each fiche.  Without times, falls back to the slot
// matching the hour.
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

function currentTaskIds() {
  const today = currentState && todayDayId();
  if (!today) return { now: null, next: null };
  const order = new Map(currentState.slots.map((s, i) => [s.id, i]));
  const list = currentState.tasks
    .filter((t) => t.dayId === today)
    .map((t) => ({ t, h: parseHoraire(horaireOf(t)) }))
    .filter((x) => x.h)
    .sort((a, b) => a.h.start - b.h.start || (order.get(a.t.slotId) - order.get(b.t.slotId)));
  const m = nowMinutes();
  const now = list.find((x) => x.h.start <= m && m < (x.h.end != null ? x.h.end : x.h.start + 30));
  const next = list.find((x) => x.h.start > m);
  return { now: now ? now.t.id : null, next: next ? next.t.id : null };
}

function slotForNow() {
  const m = nowMinutes();
  return m < 12 * 60 + 15 ? 'matin' : m < 13 * 60 + 30 ? 'repas' : m < 19 * 60 ? 'aprem' : 'veillee';
}

function markNow() {
  const { now } = currentTaskIds();
  document.querySelectorAll('li.task.is-now').forEach((li) => { if (li.dataset.taskId !== now) li.classList.remove('is-now'); });
  if (now) document.querySelectorAll(`li.task[data-task-id="${CSS.escape(now)}"]`).forEach((li) => li.classList.add('is-now'));
}
setInterval(markNow, 60000);

// On opening a planning during the stage, scroll the day view to what's on now.
let dvAutoScrolledFor = null;
function scrollDayViewToNow() {
  if (dvAutoScrolledFor === currentPlanningId) return;
  const dv = $('day-view');
  if (!dv || !dv.offsetParent || !currentState) return;
  dvAutoScrolledFor = currentPlanningId;
  if (dayViewDayId !== todayDayId()) {
    // Opened on tomorrow because today is over: start at the top of the day.
    if (dayViewDayId === liveDayId()) window.scrollTo({ top: 0 });
    return;
  }
  const { now, next } = currentTaskIds();
  const id = now || next;
  let target = id && dv.querySelector(`li.task[data-task-id="${CSS.escape(id)}"]`);
  if (!target) target = dv.querySelector(`.dv-slot.sl-${slotForNow()}`) || (slotForNow() === 'repas' && dv.querySelector('.dv-repas'));
  if (!target) return;
  const bar = dv.querySelector('.dv-bar');
  const top = target.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - 12;
  window.scrollTo({ top: Math.max(0, top) });
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
  initDragAndDrop();
  const dv = $('day-view');
  // Only bring the day back into view if the user had scrolled past its top,
  // so the header menu stays reachable.
  if (dv && dv.getBoundingClientRect().top < 0) window.scrollTo({ top: dv.getBoundingClientRect().top + window.scrollY });
}

function renderDayView() {
  const dv = $('day-view');
  if (!dv) return;
  if (!currentState || !currentState.days.length) { dv.innerHTML = ''; return; }
  const { days, slots, tasks } = currentState;
  if (!days.some((d) => d.id === dayViewDayId)) dayViewDayId = defaultDayId();
  const today = todayDayId();
  const isEditor = canEditContent();
  let html = '<div class="dv-bar">';
  if (isEditor) html += `<button type="button" class="dv-edit${editMode ? ' active' : ''}" onclick="toggleEditMode()" title="Modifier" aria-pressed="${editMode}">✎<small>${editMode ? 'Fini' : 'Modifier'}</small></button>`;
  html += '<div class="dv-tabs" role="tablist">';
  for (const d of days) {
    const cls = (d.id === dayViewDayId ? ' active' : '') + (d.id === today ? ' today' : '');
    html += `<button type="button" class="dv-tab${cls}" data-dv-day="${escapeHtml(d.id)}" role="tab">
      <small>${escapeHtml(d.short || '')}</small><b>${escapeHtml((d.name || '').slice(0, 3))}</b><small>${escapeHtml(d.date || '')}</small></button>`;
  }
  html += '</div></div><div class="dv-day">';
  const day = days.find((d) => d.id === dayViewDayId);
  html += `<div class="dv-title">${escapeHtml(day.short || '')} · ${escapeHtml(day.name || '')} ${escapeHtml(day.date || '')}</div>`;
  for (const slot of slots) {
    if (slot.id === 'repas') {
      const rh = repasHoraire(day.id);
      html += `<div class="dv-repas">Repas${rh ? ` <span class="repas-time">${escapeHtml(rh)}</span>` : ''}</div>`;
      continue;
    }
    const list = tasks.filter((t) => t.dayId === day.id && t.slotId === slot.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!list.length && !(isEditor && editMode)) continue;
    html += `<section class="dv-slot sl-${escapeHtml(slot.id)}"><h3>${DV_SLOT_ICON[slot.id] || ''} ${escapeHtml(slot.label)}</h3><ul class="tasks" data-day="${escapeHtml(day.id)}" data-slot="${escapeHtml(slot.id)}">`;
    for (const t of list) {
      const h = horaireOf(t);
      html += `<li class="task${t.done ? ' done' : ''} cat-${taskCategory(t)}" data-task-id="${escapeHtml(t.id)}">
        <span class="chk" role="checkbox" aria-checked="${t.done ? 'true' : 'false'}" aria-label="Fait"></span>
        <span class="task-text">${h ? `<span class="dv-time"${isEditor ? ' data-action="horaire" role="button" title="Changer l\'horaire"' : ''}>${escapeHtml(h)}${isEditor ? ' <span class="dv-time-edit">✎</span>' : ''}<span class="dv-now-badge">En cours</span></span>` : (isEditor && editMode ? '<span class="dv-time dv-time-add" data-action="horaire" role="button">🕘 Ajouter un horaire</span>' : '')}${escapeHtml(t.text)}${taskBadges(t)}</span>
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
  applySearchHighlight();
  // Center the active tab by scrolling the tab strip only: scrollIntoView
  // would also scroll the page wrapper vertically and hide the header.
  const tabs = dv.querySelector('.dv-tabs');
  const active = dv.querySelector('.dv-tab.active');
  if (tabs && active) tabs.scrollLeft = active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
  markNow();
  scrollDayViewToNow();
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
  if (!dvTouch || !currentState || isDragging) return;
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
  // Table on desktop, day view on phones (its lists carry data-day / data-slot).
  document.querySelectorAll('#planning-table .cell ul.tasks, #day-view ul.tasks[data-slot]').forEach((ul) => {
    sortables.push(Sortable.create(ul, {
      group: 'tasks',
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onStart() { isDragging = true; dvTouch = null; closeTaskMenu(); },
      async onEnd(evt) {
        isDragging = false;
        const taskId = evt.item && evt.item.dataset.taskId;
        const cell = evt.to && (evt.to.closest('.cell') || evt.to);
        if (!taskId || !cell || !cell.dataset.slot) return;
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        try {
          await pushOp({
            op: 'move',
            taskId,
            dayId: cell.dataset.day,
            slotId: cell.dataset.slot,
            index: evt.newIndex,
          });
          offerHoraire(taskId);
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
  const horaireBtn = e.target.closest('[data-action="horaire"]');
  if (horaireBtn) {
    e.stopPropagation();
    const li = horaireBtn.closest('li.task');
    if (li) offerHoraire(li.dataset.taskId, true);
    return;
  }
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
  html += '<button type="button" data-menu-action="horaire">🕘 Changer l\'horaire</button>';
  html += '<button type="button" data-menu-action="merge">⊕ Fusionner avec…</button>';
  html += '<button type="button" class="danger" data-menu-action="remove">🗑 Mettre à la corbeille</button>';
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
    else if (action === 'horaire') offerHoraire(t.id, true);
    else if (action === 'merge') openMergeModal(t);
    else if (action === 'up' || action === 'down') {
      try { await pushOp({ op: 'reorder', taskId, direction: action }); offerHoraire(taskId); }
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
      const movedId = editTaskId;
      closeEditModal();
      offerHoraire(movedId);
      return;
    }
    closeEditModal();
  } catch (e) {
    errEl.textContent = e.message || 'Erreur';
  }
}

async function confirmRemove(task) {
  if (!confirm(`Mettre « ${task.text} » à la corbeille ?\n\nSa fiche est gardée : vous pourrez le restaurer depuis ♻ Corbeille.`)) return;
  try {
    await pushOp({ op: 'remove', taskId: task.id });
    showToast('Mis à la corbeille', { label: 'Annuler', run: () => restoreFromTrash(task.id) });
  } catch (e) {
    alert(e.message || 'Erreur lors de la suppression');
  }
}

// ── FUSION ─────────────────────────────────────────────────────
// Two blocks become one; both fiches are kept, one after the other, and
// the absorbed block goes to the corbeille (it can be put back).
let mergeTaskId = null;
function openMergeModal(task) {
  mergeTaskId = task.id;
  const { slots, tasks, days } = currentState;
  const day = days.find((d) => d.id === task.dayId);
  $('merge-title').textContent = `Fusionner « ${task.text} » avec…`;
  let html = '';
  for (const slot of slots) {
    const list = tasks.filter((t) => t.dayId === task.dayId && t.slotId === slot.id && t.id !== task.id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!list.length) continue;
    html += `<div class="merge-slot">${escapeHtml(slot.label)}</div>`;
    for (const t of list) {
      const h = horaireOf(t);
      html += `<label class="merge-opt"><input type="radio" name="merge-other" value="${escapeHtml(t.id)}">
        <span>${h ? `<b>${escapeHtml(h)}</b> ` : ''}${escapeHtml(t.text)}</span></label>`;
    }
  }
  $('merge-list').innerHTML = html || `<em>Aucun autre temps le ${escapeHtml(day ? day.name : 'même jour')}.</em>`;
  $('merge-text').value = task.text;
  $('merge-error').textContent = '';
  $('merge-list').onchange = () => {
    const other = tasks.find((t) => t.id === mergeOtherId());
    if (other) $('merge-text').value = `${task.text} + ${other.text}`.slice(0, 300);
  };
  $('merge-modal').classList.remove('hidden');
}
function mergeOtherId() {
  const r = document.querySelector('#merge-list input[name="merge-other"]:checked');
  return r ? r.value : null;
}
function closeMergeModal() { $('merge-modal').classList.add('hidden'); mergeTaskId = null; }
async function saveMerge() {
  const otherId = mergeOtherId();
  if (!otherId) { $('merge-error').textContent = 'Choisissez le temps à fusionner'; return; }
  const text = $('merge-text').value.trim();
  if (!text) { $('merge-error').textContent = 'Donnez un titre'; return; }
  const taskId = mergeTaskId;
  try {
    await pushOp({ op: 'merge', taskId, otherId, text });
    closeMergeModal();
    showToast('Temps fusionnés, les deux fiches sont gardées', { label: 'Voir la fiche', run: () => openDetailsModal(taskId) });
  } catch (e) {
    $('merge-error').textContent = e.message || 'Erreur';
  }
}

// ── CORBEILLE ──────────────────────────────────────────────────
function openTrashModal() {
  renderTrash();
  $('trash-modal').classList.remove('hidden');
}
function closeTrashModal() { $('trash-modal').classList.add('hidden'); }
function renderTrash() {
  const list = (currentState && currentState.trash) || [];
  const dayName = (id) => { const d = currentState.days.find((x) => x.id === id); return d ? `${d.short} ${d.name}` : 'jour retiré'; };
  const slotName = (id) => { const sl = currentState.slots.find((x) => x.id === id); return sl ? sl.label : id; };
  $('trash-list').innerHTML = !list.length
    ? '<em>La corbeille est vide.</em>'
    : list.map((t) => {
      const d = t.details || {};
      const body = ['resume', 'objectifs', 'deroule', 'materiel', 'notes'].map((k) => d[k]).filter(Boolean).join('\n\n');
      return `<div class="trash-row">
        <div class="trash-main">
          <b>${escapeHtml(t.text)}</b>
          <small>${escapeHtml(dayName(t.dayId))} · ${escapeHtml(slotName(t.slotId))} — ${escapeHtml(t.reason || 'Supprimé')}, ${escapeHtml(new Date(t.deletedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }))}${t.deletedBy ? ' par ' + escapeHtml(t.deletedBy) : ''}</small>
          ${body ? `<details><summary>Voir la fiche</summary><div class="dr-body">${richText(body)}</div></details>` : ''}
        </div>
        <button type="button" class="modal-btn primary" onclick="restoreFromTrash('${escapeHtml(t.id)}')">Restaurer</button>
      </div>`;
    }).join('');
}
async function restoreFromTrash(taskId) {
  try {
    await pushOp({ op: 'restore', taskId });
    showToast('Restauré à sa place');
    if (!$('trash-modal').classList.contains('hidden')) renderTrash();
  } catch (e) {
    alert(e.message || 'Erreur');
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
  setPlanningLoading(true);
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
  setPlanningLoading(false);
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
  setPlanningLoading(false);
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

// ── SYNCHRO ANIMA STAGES MANAGER ───────────────────────────────
// Server to server through /api/asm (the bridge token stays on Netlify).
// Same comparison as the Anima bookmarklet; "pull" goes through the usual
// replaceAll op, which keeps a copy in the history (🕘) before replacing.
const ASM_STAGE_KEY = 'asm-stage:';
let asmBusy = false;

function asmStageId() { return $('asm-stage').value; }

function asmSetBusy(busy) {
  asmBusy = busy;
  $('asm-pull').disabled = busy || !asmStageId();
  $('asm-push').disabled = busy || !asmStageId();
}

function asmShowConnect(show) {
  $('asm-connect').style.display = show ? '' : 'none';
  $('asm-stage-row').style.display = show ? 'none' : '';
  $('asm-pull').style.display = show ? 'none' : '';
  $('asm-push').style.display = show ? 'none' : '';
  if (show) { $('asm-diff').innerHTML = ''; $('asm-status').innerHTML = ''; }
}

function asmConnect() {
  window.location.href = '/api/asm?op=connect&planning=' + encodeURIComponent(currentPlanningId || '');
}

async function asmDisconnect() {
  if (!confirm("Déconnecter planning-bafa de l'outil ? Il faudra cliquer à nouveau sur « Connecter » pour synchroniser.")) return;
  try {
    await apiFetch('/api/asm', { method: 'POST', body: JSON.stringify({ op: 'disconnect' }) });
    showToast("planning-bafa est déconnecté de l'outil");
    asmShowConnect(true);
  } catch (e) {
    $('asm-error').textContent = e.message || 'Erreur';
  }
}

async function openAsmModal() {
  if (!currentPlanningId) return;
  $('asm-error').textContent = '';
  $('asm-confirm').innerHTML = '';
  $('asm-status').innerHTML = '';
  $('asm-diff').textContent = 'Chargement…';
  $('asm-stage').innerHTML = '';
  asmShowConnect(false);
  $('asm-modal').classList.remove('hidden');
  asmSetBusy(true);
  try {
    const status = await apiFetch('/api/asm?op=status');
    if (!status.connected) { asmShowConnect(true); return; }
    if (status.source === 'app') {
      const when = status.at ? new Date(status.at).toLocaleDateString('fr-FR') : '';
      $('asm-status').innerHTML = 'Connecté' + (status.by ? ' par ' + escapeHtml(status.by) : '') + (when ? ' le ' + escapeHtml(when) : '')
        + ' · <button type="button" onclick="asmDisconnect()">Déconnecter</button>';
    }
    const data = await apiFetch('/api/asm?op=stages');
    const stages = data.stages || [];
    if (!stages.length) {
      $('asm-diff').textContent = "Aucun stage n'est ouvert dans l'outil pour l'instant.";
      return;
    }
    let saved = '';
    try { saved = localStorage.getItem(ASM_STAGE_KEY + currentPlanningId) || ''; } catch {}
    $('asm-stage').innerHTML = stages.map((st) =>
      '<option value="' + escapeHtml(st.id) + '">' + escapeHtml(st.label || st.id) + '</option>').join('');
    if (stages.some((st) => st.id === saved)) $('asm-stage').value = saved;
    await asmPreview();
  } catch (e) {
    $('asm-diff').textContent = '';
    if (e.data && e.data.notConnected) asmShowConnect(true);
    $('asm-error').textContent = e.message || 'Erreur';
  } finally {
    asmSetBusy(false);
  }
}

// Back from anima.lcdb-dev.eu after "Autoriser planning-bafa".
function asmHandleReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('asm');
  if (!result) return;
  const msg = params.get('msg');
  params.delete('asm'); params.delete('msg');
  const q = params.toString();
  history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
  if (result === 'connected') {
    showToast('planning-bafa est connecté à Anima Stages Manager');
    const tryOpen = (n) => { if (currentPlanningId) openAsmModal(); else if (n > 0) setTimeout(() => tryOpen(n - 1), 500); };
    tryOpen(10);
  } else {
    showToast("Connexion à l'outil impossible" + (msg ? ' : ' + msg : ''));
  }
}
window.addEventListener('DOMContentLoaded', asmHandleReturn);

function closeAsmModal() { $('asm-modal').classList.add('hidden'); }

async function onAsmStageChange() {
  try { localStorage.setItem(ASM_STAGE_KEY + currentPlanningId, asmStageId()); } catch {}
  $('asm-confirm').innerHTML = '';
  asmSetBusy(true);
  try { await asmPreview(); } finally { asmSetBusy(false); }
}

function asmCellLabel(key) {
  const [day, slot] = key.split('|');
  return 'J' + day.slice(1) + ' · ' + (SLOT_LABELS[slot] || slot);
}

async function asmPreview() {
  $('asm-error').textContent = '';
  $('asm-diff').textContent = 'Comparaison…';
  const data = await apiFetch('/api/asm', {
    method: 'POST',
    body: JSON.stringify({ op: 'preview', planningId: currentPlanningId, stageId: asmStageId() }),
  });
  const cells = data.cells || [];
  const list = (items) => (items && items.length ? items.map(escapeHtml).join(' · ') : '<i>vide</i>');
  let html = '';
  if (!cells.length) {
    html = '<p class="asm-same">✓ Les deux plannings sont identiques.</p>';
  } else {
    html = '<p>' + cells.length + ' créneau' + (cells.length > 1 ? 'x' : '') + ' différent' + (cells.length > 1 ? 's' : '') + ' :</p>'
      + cells.slice(0, 40).map((c) => '<div class="asm-cell"><b>' + escapeHtml(asmCellLabel(c.key)) + '</b>'
        + (c.outOfRange
          ? '<span class="asm-side">Outil : ' + list(c.outil) + ' (jour absent de planning-bafa, conservé dans l\'outil)</span>'
          : '<span class="asm-side">Outil : ' + list(c.outil) + '</span><br><span class="asm-side">planning-bafa : ' + list(c.planning) + '</span>')
        + '</div>').join('')
      + (cells.length > 40 ? '<p>… et ' + (cells.length - 40) + ' autre(s).</p>' : '');
  }
  if (data.ignoredDays && data.ignoredDays.length) {
    html += '<p class="asm-side">Jours de planning-bafa absents du stage (non envoyés) : '
      + data.ignoredDays.map((d) => 'J' + d.slice(1)).join(', ') + '.</p>';
  }
  $('asm-diff').innerHTML = html;
}

function asmAsk(direction) {
  if (asmBusy || !asmStageId()) return;
  const text = direction === 'push'
    ? "Remplacer le planning de l'outil par celui-ci ? L'outil garde une copie, et l'équipe verra « modifié par planning-bafa »."
    : "Remplacer ce planning par celui de l'outil ? Une copie de la version actuelle est gardée (🕘).";
  $('asm-confirm').innerHTML = escapeHtml(text)
    + '<button class="modal-btn primary" type="button" id="asm-yes">Oui, remplacer</button>'
    + '<button class="modal-btn ghost" type="button" id="asm-no">Annuler</button>';
  $('asm-no').onclick = () => { $('asm-confirm').innerHTML = ''; };
  $('asm-yes').onclick = () => { $('asm-confirm').innerHTML = ''; asmRun(direction); };
}

async function asmPullInto(reason) {
  const data = await apiFetch('/api/asm', {
    method: 'POST',
    body: JSON.stringify({ op: 'pull', planningId: currentPlanningId, stageId: asmStageId() }),
  });
  await pushOp({ op: 'replaceAll', tasks: data.tasks || [], reason });
}

async function asmRun(direction) {
  $('asm-error').textContent = '';
  asmSetBusy(true);
  try {
    if (direction === 'pull') {
      await asmPullInto("Avant import depuis Anima Stages Manager");
      showToast('Planning récupéré depuis l\'outil');
    } else {
      const res = await apiFetch('/api/asm', {
        method: 'POST',
        body: JSON.stringify({ op: 'push', planningId: currentPlanningId, stageId: asmStageId() }),
      });
      // Blocks typed by hand that matched the Anima catalog or a group of the
      // stage: record the link on OUR blocks (text, time and fiche unchanged),
      // so the next syncs match by id rather than by title.
      if (res.links && res.links.length) {
        const link = {};
        res.links.forEach((l) => { link[l.taskId] = l; });
        const slotOrder = (currentState.slots || []).map((sl) => sl.id);
        const dayOrder = (currentState.days || []).map((d) => d.id);
        const tasks = currentState.tasks.slice()
          .filter((t) => t.slotId !== 'repas')
          .sort((a, b) => dayOrder.indexOf(a.dayId) - dayOrder.indexOf(b.dayId)
            || slotOrder.indexOf(a.slotId) - slotOrder.indexOf(b.slotId) || (a.order || 0) - (b.order || 0))
          .map((t) => {
            const out = { id: t.id, dayId: t.dayId, slotId: t.slotId, text: t.text };
            const l = link[t.id];
            // several Anima modules for one block (« Santé : registre, PAI… ») : animaIds
            if (l && Array.isArray(l.animaIds) && l.animaIds.length > 1) out.animaIds = l.animaIds;
            else if (l && l.animaId) out.animaId = l.animaId;
            else if (Array.isArray(t.animaIds) && t.animaIds.length > 1) out.animaIds = t.animaIds;
            else if (t.animaId) out.animaId = t.animaId;
            return out;
          });
        await pushOp({ op: 'replaceAll', tasks, reason: 'Avant liaison au catalogue Anima et aux groupes' });
      }
      showToast('Planning envoyé vers l\'outil' + (res.relinked ? ' (' + res.relinked + ' temps reliés au catalogue Anima)' : ''));
    }
    await asmPreview();
  } catch (e) {
    $('asm-error').textContent = e.message || 'Erreur';
  } finally {
    asmSetBusy(false);
  }
}

window.openAsmModal = openAsmModal;
window.closeAsmModal = closeAsmModal;
window.onAsmStageChange = onAsmStageChange;
window.asmAsk = asmAsk;
window.asmConnect = asmConnect;
window.asmDisconnect = asmDisconnect;

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
  // The time lives on the first line of the déroulé: edit it in its own fields.
  const h = parseHoraire(horaireOf(t || {}));
  v.deroule = v.deroule.replace(/^Horaire conseillé : [^\n]*\n*/, '');
  v.hdebut = h ? toTimeInput(h.start) : '';
  v.hfin = h && h.end != null ? toTimeInput(h.end) : '';
  v.titre = (t && t.text) || '';
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
  for (const k of ['hdebut', 'hfin', 'titre']) { $('det-' + k).value = detailsBase[k]; $('det-' + k).readOnly = !editable; }
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
    if (ln) return escapeHtml(ln[1]) + `<a href="${escapeHtml(ln[3])}"${docKind(ln[3]) ? ' class="doc-link"' : ''} target="_blank" rel="noopener">${escapeHtml(ln[2])}</a>`;
    return escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 40 ? u.slice(0, 40) + '…' : u}</a>`);
  }).join('\n');
}

function renderDetailsRead(t) {
  const d = t.details || {};
  const chips = [];
  const h = horaireOf(t);
  if (canEditContent()) chips.push(`<button type="button" class="dr-chip time" onclick="offerHoraire('${escapeHtml(t.id)}', true)">🕘 ${h ? escapeHtml(h) + ' ✎' : 'Ajouter un horaire'}</button>`);
  else if (h) chips.push(`<span class="dr-chip time">🕘 ${escapeHtml(h)}</span>`);
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
  v.hdebut = $('det-hdebut').value;
  v.hfin = $('det-hfin').value;
  v.titre = $('det-titre').value;
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
    if (now[k] === detailsBase[k] || ['hdebut', 'hfin', 'titre'].includes(k)) continue;
    patch[k] = k === 'formateurs'
      ? now[k].split(',').map((x) => x.trim()).filter(Boolean)
      : now[k];
  }
  // Time and déroulé are stored together: rebuild the déroulé if either changed.
  const hChanged = now.hdebut !== detailsBase.hdebut || now.hfin !== detailsBase.hfin;
  if (hChanged || 'deroule' in patch) {
    const start = fromTimeInput(now.hdebut);
    const end = fromTimeInput(now.hfin);
    if ((now.hdebut || now.hfin) && (start == null || end == null || end <= start)) {
      $('details-error').textContent = 'Horaire : la fin doit être après le début';
      return;
    }
    const line = start != null ? `Horaire conseillé : ${fmtHoraire(start)} - ${fmtHoraire(end)}` : '';
    patch.deroule = [line, now.deroule.trim()].filter(Boolean).join('\n\n');
  }
  const titre = now.titre.trim();
  const renamed = titre && titre !== detailsBase.titre;
  if (!Object.keys(patch).length && !renamed) { closeDetailsModal(); return; }
  const btn = $('details-save');
  btn.disabled = true;
  try {
    if (renamed) await pushOp({ op: 'edit', taskId: detailsTaskId, text: titre });
    if (Object.keys(patch).length) await pushOp({ op: 'setDetails', taskId: detailsTaskId, details: patch });
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

// ── RECHERCHE ──────────────────────────────────────────────────
// Searches task titles and the fiche fields the viewer can see (the public
// share link only receives the public part).  Accents and case are ignored.
const SEARCH_FIELDS = [
  ['resume', 'Pour les stagiaires'], ['objectifs', 'Ce qu\'on présente'], ['deroule', 'Déroulé'],
  ['materiel', 'Matériel et ressources'], ['notes', 'Notes'], ['ficheAnima', 'Fiche Anima'],
];
let searchQuery = '';
// Where to search: 'title' (default), 'details' (fiche content) or 'both'.
let searchScope = (() => { try { return localStorage.getItem('planning.searchScope') || 'title'; } catch { return 'title'; } })();
if (!['title', 'details', 'both'].includes(searchScope)) searchScope = 'title';

function foldText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Highlight `terms` in `text` (accent-insensitive), escaping the rest.
function markTerms(text, terms) {
  const src = String(text || '');
  const folded = foldText(src);
  const ranges = [];
  for (const term of terms) {
    let i = folded.indexOf(term);
    while (i !== -1 && term) { ranges.push([i, i + term.length]); i = folded.indexOf(term, i + term.length); }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += escapeHtml(src.slice(pos, a)) + '<mark>' + escapeHtml(src.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + escapeHtml(src.slice(pos));
}

function searchTasks(query) {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (!terms.length || !currentState) return { terms, results: [] };
  const dayIdx = new Map(currentState.days.map((d, i) => [d.id, i]));
  const slotIdx = new Map(currentState.slots.map((s, i) => [s.id, i]));
  const results = [];
  for (const t of currentState.tasks) {
    const d = t.details || {};
    const inTitle = searchScope !== 'details';
    const inDetails = searchScope !== 'title';
    const parts = [];
    if (inTitle) parts.push(t.text);
    if (inDetails) parts.push(...SEARCH_FIELDS.map(([f]) => d[f]));
    const haystack = foldText(parts.join('\n'));
    if (!terms.every((term) => haystack.includes(term))) continue;
    let snippet = '';
    if (inDetails && !(inTitle && terms.every((term) => foldText(t.text).includes(term)))) {
      for (const [f, label] of SEARCH_FIELDS) {
        const v = String(d[f] || '');
        const fv = foldText(v);
        const hit = terms.map((term) => fv.indexOf(term)).filter((i) => i !== -1).sort((a, b) => a - b)[0];
        if (hit === undefined) continue;
        const start = Math.max(0, v.lastIndexOf('\n', hit) + 1, hit - 60);
        let end = v.indexOf('\n', hit); if (end === -1 || end - hit > 110) end = Math.min(v.length, hit + 110);
        snippet = `${label} : ${start > 0 && v[start - 1] !== '\n' ? '…' : ''}${v.slice(start, end).trim()}${end < v.length && v[end] !== '\n' ? '…' : ''}`;
        break;
      }
    }
    results.push({ t, snippet, rank: [terms.every((term) => foldText(t.text).includes(term)) ? 0 : 1, dayIdx.get(t.dayId) ?? 99, slotIdx.get(t.slotId) ?? 99, t.order ?? 0] });
  }
  results.sort((a, b) => { for (let i = 0; i < 4; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]; return 0; });
  return { terms, results };
}

function renderSearchResults() {
  const box = $('search-results');
  if (!box) return;
  $('search-clear').style.display = searchQuery ? '' : 'none';
  if (!searchQuery.trim()) { box.style.display = 'none'; box.innerHTML = ''; applySearchHighlight(); return; }
  const { terms, results } = searchTasks(searchQuery);
  const days = new Map(currentState.days.map((d) => [d.id, d]));
  const slots = new Map(currentState.slots.map((s) => [s.id, s]));
  let html = `<div class="sr-count">${results.length} résultat${results.length > 1 ? 's' : ''}</div>`;
  if (!results.length) {
    const hint = searchScope === 'title' ? ' dans les titres. Essayez « Fiche » ou « Les deux ».'
      : searchScope === 'details' ? ' dans les fiches. Essayez « Titre » ou « Les deux ».' : '.';
    html += `<div class="sr-empty">Aucun temps ne correspond à cette recherche${hint}</div>`;
  }
  for (const { t, snippet } of results.slice(0, 60)) {
    const d = days.get(t.dayId), sl = slots.get(t.slotId), h = horaireOf(t);
    const where = [d && `${d.short} ${d.name}`, sl && sl.label, h].filter(Boolean).join(' · ');
    html += `<button type="button" class="sr-item" data-search-task="${escapeHtml(t.id)}">
      <span class="sr-where">${escapeHtml(where)}</span>
      <span class="sr-text">${markTerms(t.text, terms)}</span>
      ${snippet ? `<span class="sr-snippet">${markTerms(snippet, terms)}</span>` : ''}
    </button>`;
  }
  box.innerHTML = html;
  box.style.display = '';
  applySearchHighlight();
}

// Dims the tasks that do not match, in the table and in the day view.
function applySearchHighlight() {
  const active = !!searchQuery.trim() && !!currentState;
  document.body.classList.toggle('searching', active);
  const ids = active ? new Set(searchTasks(searchQuery).results.map((r) => r.t.id)) : new Set();
  document.querySelectorAll('li.task[data-task-id]').forEach((li) => li.classList.toggle('search-hit', ids.has(li.dataset.taskId)));
}

function goToSearchResult(taskId) {
  const t = currentState && currentState.tasks.find((x) => x.id === taskId);
  if (!t) return;
  $('search-results').style.display = 'none';
  if (showDetailsButton(t)) { openDetailsModal(taskId); return; }
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  if (mobile && t.dayId !== dayViewDayId) setDayViewDay(t.dayId);
  const scope = mobile ? '#day-view' : '#planning-table';
  const li = document.querySelector(`${scope} li.task[data-task-id="${CSS.escape(taskId)}"]`);
  if (li) li.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}

function renderSearchScope() {
  document.querySelectorAll('#search-scope [data-scope]').forEach((b) => {
    const on = b.dataset.scope === searchScope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function clearSearch() {
  searchQuery = '';
  const input = $('search-input');
  if (input) input.value = '';
  renderSearchResults();
}

function initSearch() {
  const input = $('search-input');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { searchQuery = input.value; renderSearchResults(); }, 120);
  });
  input.addEventListener('focus', () => { if (searchQuery.trim()) renderSearchResults(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { clearSearch(); input.blur(); }
    if (e.key === 'Enter') {
      const first = $('search-results').querySelector('[data-search-task]');
      if (first) { e.preventDefault(); input.blur(); goToSearchResult(first.dataset.searchTask); }
    }
  });
  $('search-clear').addEventListener('click', () => { clearSearch(); input.focus(); });
  renderSearchScope();
  $('search-scope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    searchScope = b.dataset.scope;
    try { localStorage.setItem('planning.searchScope', searchScope); } catch {}
    renderSearchScope();
    renderSearchResults();
  });
  $('search-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-search-task]');
    if (b) goToSearchResult(b.dataset.searchTask);
  });
  // Close the result list when tapping elsewhere (the highlight stays).
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-bar')) $('search-results').style.display = 'none';
  });
}

// ── VISIONNEUSE DE DOCUMENTS ───────────────────────────────────
// Opens the Anima resources linked in a fiche inside the app.  PDFs are
// fetched through /api/doc (Anima's servers do not let other sites read
// them) and drawn with pdf.js, which also works on phones; images and
// videos load directly; Office files use Microsoft's online viewer.
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
let pdfjsPromise = null;
let docViewerToken = 0;

function docKind(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const name = (u.searchParams.get('name') || u.pathname).toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'office';
  return null;
}

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

function docMessage(html) {
  $('doc-body').innerHTML = `<div class="doc-msg">${html}</div>`;
}

async function renderPdfInto(url, token) {
  const body = $('doc-body');
  docMessage('<div class="spinner"></div><p style="margin-top:12px">Chargement du document…</p>');
  const res = await fetch('/api/doc?url=' + encodeURIComponent(url), { credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Document indisponible');
  const [lib, data] = await Promise.all([loadPdfJs(), res.arrayBuffer()]);
  if (token !== docViewerToken) return;
  const pdf = await lib.getDocument({ data }).promise;
  if (token !== docViewerToken) return;
  body.innerHTML = '';
  const width = Math.max(280, body.clientWidth - 16);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let i = 1; i <= pdf.numPages; i++) {
    if (token !== docViewerToken) return;
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    body.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
}

async function openDocViewer(url, title) {
  const kind = docKind(url);
  if (!kind) { window.open(url, '_blank', 'noopener'); return; }
  const token = ++docViewerToken;
  $('doc-title').textContent = title || 'Document';
  $('doc-open').href = url;
  $('doc-modal').classList.remove('hidden');
  const body = $('doc-body');
  body.scrollTop = 0;
  try {
    if (kind === 'pdf') {
      await renderPdfInto(url, token);
    } else if (kind === 'image') {
      body.innerHTML = '';
      const img = document.createElement('img');
      img.alt = title || '';
      img.src = url;
      body.appendChild(img);
    } else if (kind === 'video') {
      body.innerHTML = '';
      const v = document.createElement('video');
      v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      body.appendChild(v);
    } else {
      body.innerHTML = '';
      const f = document.createElement('iframe');
      f.title = title || 'Document';
      f.src = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url);
      body.appendChild(f);
    }
  } catch (e) {
    if (token !== docViewerToken) return;
    docMessage(`Impossible d'afficher ce document ici (${escapeHtml(e.message || 'erreur')}).<br><br><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir le document à part ↗</a>`);
  }
}

function closeDocViewer() {
  docViewerToken++;
  $('doc-modal').classList.add('hidden');
  $('doc-body').innerHTML = '';
}

function initDocViewer() {
  const read = $('details-read');
  if (read) {
    read.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a || !docKind(a.href)) return;
      e.preventDefault();
      openDocViewer(a.href, a.textContent.trim());
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('doc-modal').classList.contains('hidden')) closeDocViewer();
  });
}

window.closeDocViewer = closeDocViewer;
window.addEventListener('DOMContentLoaded', () => { initSearch(); initDocViewer(); });


// ── Appliquer des modifications ────────────────────────────────────────
// The owner pastes a block of changes (prepared by Claude, for instance),
// checks the list of what will change, then applies it.  Each change goes
// through the normal API with the owner's own session, one op at a time.
//
// Format:
// { "titre": "…", "modifs": [
//   { "type": "renommer",  "tache": "Titre actuel", "jour": "J1", "titre": "Nouveau titre" },
//   { "type": "fiche",     "tache": "…", "fiche": { "horaire": "9h50 - 10h45 (55 min)", "objectifs": "…" } },
//   { "type": "ajouter",   "jour": "J1", "creneau": "aprem", "titre": "…", "apres": "Titre voisin", "fiche": { … } },
//   { "type": "deplacer",  "tache": "…", "vers": { "jour": "J2", "creneau": "matin", "apres": "…" } },
//   { "type": "supprimer", "tache": "…" } ] }
// "tache" is matched on the title (accents and case ignored): exact title
// first, then the beginning of the title, then any part of it.  "jour"
// narrows the search to one day.  "apres" places the block after another
// one of the same cell ("debut" puts it first); default: end of the cell.

const BATCH_FICHE_FIELDS = ['resume', 'duree', 'objectifs', 'deroule', 'materiel', 'notes', 'ficheAnima', 'statut', 'formateurs'];
let batchPlan = null;

function openBatchModal() {
  if (!currentState) return;
  $('batch-modal').classList.remove('hidden');
  $('batch-error').textContent = '';
  $('batch-preview').innerHTML = '';
  $('batch-input-wrap').style.display = '';
  $('batch-check').style.display = '';
  $('batch-apply').disabled = true;
  batchPlan = null;
}

function closeBatchModal() { $('batch-modal').classList.add('hidden'); }

function batchDayId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const k = foldText(raw).replace(/\s+/g, '');
  const d = currentState.days.find((x) => x.id === k || foldText(x.short) === k || foldText(x.name) === k);
  if (!d) throw new Error('Jour inconnu : ' + raw);
  return d.id;
}

function batchSlotId(raw) {
  const k = foldText(raw).replace(/[\s-]+/g, '');
  const map = { matin: 'matin', aprem: 'aprem', apresmidi: 'aprem', veillee: 'veillee', soir: 'veillee' };
  if (!map[k]) throw new Error('Créneau inconnu : ' + raw + ' (matin, aprem ou veillee)');
  return map[k];
}

function batchFind(tasks, title, dayId) {
  const q = foldText(title).trim();
  if (!q) throw new Error('Titre de tâche manquant');
  const pool = tasks.filter((t) => !dayId || t.dayId === dayId);
  for (const test of [(t) => t === q, (t) => t.startsWith(q), (t) => t.includes(q)]) {
    const hits = pool.filter((t) => test(foldText(t.text).trim()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error('« ' + title + ' » correspond à ' + hits.length + ' temps, précisez le jour ou le titre');
  }
  throw new Error('Temps introuvable : « ' + title + ' »' + (dayId ? ' (' + dayId.toUpperCase() + ')' : ''));
}

function batchCell(tasks, dayId, slotId, exceptId) {
  return tasks.filter((t) => t.dayId === dayId && t.slotId === slotId && t.id !== exceptId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Index in the destination cell (without the moved block) for "apres".
function batchIndex(tasks, dayId, slotId, apres, exceptId) {
  const cell = batchCell(tasks, dayId, slotId, exceptId);
  if (apres === undefined || apres === null || apres === '') return cell.length;
  if (foldText(apres) === 'debut') return 0;
  const ref = batchFind(cell, apres, null);
  return cell.indexOf(ref) + 1;
}

function batchPlace(tasks, task, dayId, slotId, index) {
  const cell = batchCell(tasks, dayId, slotId, task.id);
  task.dayId = dayId; task.slotId = slotId;
  cell.splice(index, 0, task);
  cell.forEach((t, i) => { t.order = i; });
}

function batchFichePatch(fiche, current) {
  if (!fiche || typeof fiche !== 'object') throw new Error('« fiche » doit être un objet');
  const patch = {};
  for (const [k, v] of Object.entries(fiche)) {
    if (k === 'horaire') continue;
    if (!BATCH_FICHE_FIELDS.includes(k)) throw new Error('Champ de fiche inconnu : ' + k);
    patch[k] = v;
  }
  if (fiche.horaire) {
    const line = 'Horaire conseillé : ' + String(fiche.horaire).trim();
    const base = patch.deroule !== undefined ? String(patch.deroule) : String((current && current.deroule) || '');
    patch.deroule = /^Horaire conseillé/.test(base) ? base.replace(/^[^\n]*/, line) : (base ? line + '\n\n' + base : line);
  }
  return patch;
}

// Resolve every change against a copy of the planning, in order, so a
// later change can refer to a block renamed or added by an earlier one.
function buildBatchPlan(data) {
  if (!data || !Array.isArray(data.modifs) || !data.modifs.length) throw new Error('Aucune modification (« modifs » vide)');
  if (data.modifs.length > 200) throw new Error('Trop de modifications d\'un coup (200 maximum)');
  const sim = currentState.tasks.map((t) => ({ id: t.id, text: t.text, dayId: t.dayId, slotId: t.slotId, order: t.order, details: t.details }));
  let tmp = 0;
  const steps = data.modifs.flatMap((m, i) => {
    const step = { n: i + 1, raw: m, label: '', detail: '', error: null };
    try {
      const type = foldText(m.type || '');
      if (type === 'remplacer') return batchReplaceSteps(sim, m, () => 'new:' + (++tmp));
      if (type === 'renommer') {
        const t = batchFind(sim, m.tache, batchDayId(m.jour));
        const text = String(m.titre || '').trim();
        if (!text) throw new Error('Nouveau titre manquant');
        step.label = 'Renommer « ' + t.text + ' »';
        step.detail = '→ « ' + text + ' »';
        step.op = { kind: 'edit', ref: t.id, text };
        t.text = text;
        if (m.fiche) { step.patch = batchFichePatch(m.fiche, t.details); step.detail += ' + fiche (' + Object.keys(step.patch).join(', ') + ')'; }
      } else if (type === 'fiche') {
        const t = batchFind(sim, m.tache, batchDayId(m.jour));
        step.patch = batchFichePatch(m.fiche, t.details);
        step.label = 'Fiche de « ' + t.text + ' »';
        step.detail = 'Champs : ' + Object.keys(step.patch).join(', ');
        step.op = { kind: 'fiche', ref: t.id };
        t.details = { ...(t.details || {}), ...step.patch };
      } else if (type === 'ajouter') {
        const dayId = batchDayId(m.jour);
        if (!dayId) throw new Error('Jour manquant');
        const slotId = batchSlotId(m.creneau || '');
        const text = String(m.titre || '').trim();
        if (!text) throw new Error('Titre manquant');
        const index = batchIndex(sim, dayId, slotId, m.apres, null);
        const t = { id: 'new:' + (++tmp), text, dayId, slotId, order: 0 };
        sim.push(t);
        batchPlace(sim, t, dayId, slotId, index);
        if (m.fiche) step.patch = batchFichePatch(m.fiche, null);
        step.label = 'Ajouter « ' + text + ' »';
        step.detail = dayId.toUpperCase() + ' ' + slotId + (m.apres ? ', après « ' + m.apres + ' »' : '') + (step.patch ? ' + fiche' : '');
        step.op = { kind: 'add', ref: t.id, text, dayId, slotId, index };
      } else if (type === 'deplacer') {
        const t = batchFind(sim, m.tache, batchDayId(m.jour));
        const to = m.vers || {};
        const dayId = batchDayId(to.jour) || t.dayId;
        const slotId = to.creneau ? batchSlotId(to.creneau) : t.slotId;
        const index = batchIndex(sim, dayId, slotId, to.apres, t.id);
        step.label = 'Déplacer « ' + t.text + ' »';
        step.detail = '→ ' + dayId.toUpperCase() + ' ' + slotId + (to.apres ? ', après « ' + to.apres + ' »' : '');
        step.op = { kind: 'move', ref: t.id, dayId, slotId, index };
        batchPlace(sim, t, dayId, slotId, index);
      } else if (type === 'supprimer') {
        const t = batchFind(sim, m.tache, batchDayId(m.jour));
        step.label = 'Supprimer « ' + t.text + ' »';
        step.detail = t.dayId.toUpperCase() + ' ' + t.slotId;
        step.op = { kind: 'remove', ref: t.id };
        sim.splice(sim.indexOf(t), 1);
        batchCell(sim, t.dayId, t.slotId).forEach((x, k) => { x.order = k; });
      } else {
        throw new Error('Type inconnu : « ' + (m.type || '') + ' » (renommer, fiche, ajouter, deplacer, supprimer, remplacer)');
      }
    } catch (e) {
      step.error = e.message;
    }
    return step;
  });
  steps.forEach((st, k) => { st.n = k + 1; });
  return { titre: String(data.titre || ''), steps };
}

// « remplacer » : the content of one slot of one day becomes the given list,
// in order.  A block already there under the same title is kept (its fiche,
// its "done" state) and moved into place; new titles are added; the others
// go to the trash (restorable).  Each "temps" may carry an "horaire".
function batchReplaceSteps(sim, m, newRef) {
  const fail = (msg) => [{ n: 0, raw: m, label: '', detail: '', error: msg }];
  let dayId, slotId;
  try {
    dayId = batchDayId(m.jour);
    if (!dayId) throw new Error('Jour manquant');
    slotId = batchSlotId(m.creneau || '');
  } catch (e) { return fail(e.message); }
  if (!Array.isArray(m.temps)) return fail('« temps » doit être une liste');
  if (m.temps.length > 40) return fail('Trop de temps dans un créneau (40 maximum)');
  const where = dayId.toUpperCase() + ' ' + slotId;
  const items = [];
  for (const it of m.temps) {
    const text = String((it && it.titre) || '').trim();
    if (!text) return fail(where + ' : titre manquant');
    items.push({ text, horaire: it.horaire, fiche: it.fiche });
  }
  const cell = batchCell(sim, dayId, slotId);
  const used = new Set();
  for (const it of items) {
    const k = foldText(it.text).trim();
    it.keep = cell.find((t) => !used.has(t.id) && foldText(t.text).trim() === k) || null;
    if (it.keep) used.add(it.keep.id);
  }
  const steps = [];
  for (const t of cell) {
    if (used.has(t.id)) continue;
    steps.push({ raw: m, label: 'Retirer « ' + t.text + ' »', detail: where + ' → corbeille', error: null, op: { kind: 'remove', ref: t.id } });
    sim.splice(sim.indexOf(t), 1);
  }
  batchCell(sim, dayId, slotId).forEach((x, k) => { x.order = k; });
  items.forEach((it, index) => {
    const step = { raw: m, label: '', detail: '', error: null };
    try {
      const fiche = { ...(it.fiche || {}), ...(it.horaire ? { horaire: it.horaire } : {}) };
      const hasFiche = Object.keys(fiche).length > 0;
      if (it.keep) {
        step.patch = hasFiche ? batchFichePatch(fiche, it.keep.details) : null;
        step.label = 'Garder « ' + it.text + ' »';
        step.op = { kind: 'move', ref: it.keep.id, dayId, slotId, index };
        batchPlace(sim, it.keep, dayId, slotId, index);
        if (step.patch) it.keep.details = { ...(it.keep.details || {}), ...step.patch };
      } else {
        step.patch = hasFiche ? batchFichePatch(fiche, null) : null;
        step.label = 'Ajouter « ' + it.text + ' »';
        const t = { id: newRef(), text: it.text, dayId, slotId, order: 0 };
        sim.push(t);
        batchPlace(sim, t, dayId, slotId, index);
        step.op = { kind: 'add', ref: t.id, text: it.text, dayId, slotId, index };
      }
      step.detail = where + (it.horaire ? ' · ' + it.horaire : '');
    } catch (e) {
      step.error = e.message;
    }
    steps.push(step);
  });
  return steps;
}

function renderBatchPlan() {
  const { titre, steps } = batchPlan;
  const errs = steps.filter((s) => s.error).length;
  $('batch-preview').innerHTML =
    '<h4>' + escapeHtml(titre || 'Modifications') + ' · ' + steps.length + ' changement' + (steps.length > 1 ? 's' : '') + '</h4>' +
    steps.map((s) => '<div class="batch-row' + (s.error ? ' err' : '') + (s.done ? ' done' : '') + '">' +
      '<span class="batch-ico">' + (s.error ? '⚠️' : s.done ? '✅' : s.n) + '</span>' +
      '<span>' + escapeHtml(s.error ? 'Modif ' + s.n + ' : ' + s.error : s.label) +
      (s.error ? '' : '<small>' + escapeHtml(s.detail) + '</small>') + '</span></div>').join('');
  $('batch-error').textContent = errs ? errs + ' modification(s) à corriger : rien ne sera appliqué tant qu\'il y a une erreur.' : '';
  $('batch-apply').disabled = !!errs || steps.every((s) => s.done);
}

function previewBatch() {
  $('batch-error').textContent = '';
  let data;
  const raw = $('batch-input').value.trim().replace(/^```\w*\s*|\s*```$/g, '').replace(/[“”]/g, '"');
  try { data = JSON.parse(raw); } catch (e) {
    $('batch-error').textContent = 'Le texte collé n\'est pas un bloc valide (copiez tout le bloc, accolades comprises).';
    return;
  }
  try { batchPlan = buildBatchPlan(data); } catch (e) {
    $('batch-error').textContent = e.message;
    return;
  }
  renderBatchPlan();
}

async function applyBatch() {
  if (!batchPlan || batchPlan.steps.some((s) => s.error)) return;
  $('batch-apply').disabled = true;
  $('batch-check').style.display = 'none';
  $('batch-input-wrap').style.display = 'none';
  const ids = {};
  const real = (ref) => (ref.startsWith('new:') ? ids[ref] : ref);
  for (const s of batchPlan.steps) {
    if (s.done) continue;
    try {
      const o = s.op;
      if (o.kind === 'edit') {
        await pushOp({ op: 'edit', taskId: real(o.ref), text: o.text });
      } else if (o.kind === 'add') {
        const before = new Set(currentState.tasks.map((t) => t.id));
        const next = await pushOp({ op: 'add', dayId: o.dayId, slotId: o.slotId, text: o.text });
        const created = next.tasks.find((t) => !before.has(t.id));
        if (!created) throw new Error('Bloc ajouté introuvable');
        ids[o.ref] = created.id;
        await pushOp({ op: 'move', taskId: created.id, dayId: o.dayId, slotId: o.slotId, index: o.index });
      } else if (o.kind === 'move') {
        await pushOp({ op: 'move', taskId: real(o.ref), dayId: o.dayId, slotId: o.slotId, index: o.index });
      } else if (o.kind === 'remove') {
        await pushOp({ op: 'remove', taskId: real(o.ref) });
      }
      if (s.patch && Object.keys(s.patch).length) {
        await pushOp({ op: 'setDetails', taskId: real(o.ref), details: s.patch });
      }
      s.done = true;
    } catch (e) {
      s.error = 'non appliquée (' + (e.message || 'erreur') + ')';
      renderBatchPlan();
      $('batch-error').textContent = 'Arrêt à la modification ' + s.n + '. Les précédentes sont enregistrées.';
      return;
    }
    renderBatchPlan();
  }
  $('batch-error').textContent = '';
  $('batch-preview').insertAdjacentHTML('beforeend', '<p><strong>Tout est appliqué ✅</strong></p>');
}
