// Synchro Anima <-> planning-bafa
//
// Loaded by the "Synchro Anima" bookmarklet on plateforme.anima-lorraine.fr,
// with the page's "Planning du stage" open.  The bookmarklet sets
// window.__PLANNING_BAFA = { api, planningId, token } before injecting this
// file.
//
// Anima side (observed, no official API): the planning manager lives in the
// same-origin iframe /front and exposes globals:
//   _pmJours   { "j1_matin": [{type:"temps", id, formateur?}, ...], ... }
//   _pmTemps   catalog { <id>: { titre, duree, ... } }
//   PM_SLOTS   ["j1_matin", "j1_apm", "j1_veillee", ...]
//   pmRenderPlanning(), pmSave(cb)
// Unknown ids are displayed by Anima with their id as title, which is how
// free-text items created in planning-bafa are carried over.
(function () {
  'use strict';

  const CFG = window.__PLANNING_BAFA || {};
  const UI_ID = 'pb-sync-panel';
  const SLOT_MAP = { matin: 'matin', apm: 'aprem', veillee: 'veillee' };
  const SLOT_MAP_BACK = { matin: 'matin', aprem: 'apm', veillee: 'veillee' };
  const SLOT_LABEL = { matin: 'Matin', aprem: 'Après-midi', veillee: 'Veillée' };

  // ── Locate the Anima planning manager ─────────────────────────
  function findPM() {
    const cands = [window];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentWindow) cands.push(f.contentWindow); } catch (e) {}
    }
    for (const w of cands) {
      try {
        if (w.PM_SLOTS && w._pmJours && typeof w.pmSave === 'function') return w;
      } catch (e) {}
    }
    return null;
  }

  // ── Text helpers ──────────────────────────────────────────────
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function norm(s) {
    return clean(s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2019'`]/g, "'").replace(/\s*:\s*/g, ':');
  }
  function entryId(e) {
    if (!e) return null;
    if (typeof e === 'string') return e;
    if (e.type === 'temps') return e.id;
    if (e.type === 'groupe') return 'groupe:' + e.typeProjet + ':' + e.nomGroupe;
    return null;
  }
  function titleFor(pm, id) {
    const t = pm._pmTemps && pm._pmTemps[id];
    if (t && t.titre) return clean(t.titre);
    const g = /^groupe:([^:]*):(.*)$/.exec(id);
    if (g) return clean(g[1] + ' : ' + g[2]);
    return clean(id);
  }

  // Summary of the Anima "fiche" (sommaire), shown read-only in the
  // module's details in planning-bafa.
  function ficheFor(pm, id) {
    const t = pm._pmTemps && pm._pmTemps[id];
    if (!t || !t.sommaire) return '';
    let txt = String(t.sommaire);
    try { if (typeof pm.pmStripHtml === 'function') txt = pm.pmStripHtml(txt); } catch (e) {}
    try { if (typeof pm.pmDecodeEntities === 'function') txt = pm.pmDecodeEntities(txt); } catch (e) {}
    txt = txt.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (t.duree) txt = 'Durée Anima : ' + t.duree + '\n' + txt;
    return txt.slice(0, 6000);
  }

  // ── Models ────────────────────────────────────────────────────
  // Both sides are reduced to { "j1|matin": [{text, animaId}], ... }
  function animaModel(pm) {
    const out = {};
    for (const key of pm.PM_SLOTS) {
      const m = /^(j\d+)_(matin|apm|veillee)$/.exec(key);
      if (!m) continue;
      const cell = m[1] + '|' + SLOT_MAP[m[2]];
      out[cell] = (pm._pmJours[key] || []).map((e) => {
        const id = entryId(e);
        return id ? { animaId: id, text: titleFor(pm, id) } : null;
      }).filter(Boolean);
    }
    return out;
  }

  function netlifyModel(state) {
    const out = {};
    for (const d of state.days) {
      for (const s of state.slots) {
        if (s.id === 'repas') continue;
        out[d.id + '|' + s.id] = state.tasks
          .filter((t) => t.dayId === d.id && t.slotId === s.id)
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map((t) => ({ text: t.text, animaId: t.animaId || null }));
      }
    }
    return out;
  }

  function cellSig(items) { return items.map((i) => norm(i.text)).join('\n'); }

  function diffCells(a, n, netDays) {
    const cells = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(n)]);
    for (const k of keys) {
      const [day] = k.split('|');
      const ai = a[k] || [], ni = n[k] || [];
      if (!netDays.has(day)) {
        if (ai.length) cells.push({ key: k, anima: ai, netlify: null, outOfRange: true });
        continue;
      }
      if (cellSig(ai) !== cellSig(ni)) cells.push({ key: k, anima: ai, netlify: ni });
    }
    const dayNum = (k) => parseInt(k.slice(1), 10);
    const slotNum = (k) => ['matin', 'aprem', 'veillee'].indexOf(k.split('|')[1]);
    return cells.sort((x, y) => dayNum(x.key) - dayNum(y.key) || slotNum(x.key) - slotNum(y.key));
  }

  // ── Netlify API ───────────────────────────────────────────────
  async function api(method, body) {
    const url = CFG.api + '/api/state?planning=' + encodeURIComponent(CFG.planningId);
    const res = await fetch(url, {
      method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + CFG.token },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  async function historyApi(method, query, body) {
    const url = CFG.api + '/api/history?planning=' + encodeURIComponent(CFG.planningId) + (query || '');
    const res = await fetch(url, {
      method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + CFG.token },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  // Raw copy of the Anima planning (ids, formateurs) plus the titles so the
  // copy stays readable even if the catalog changes.
  function animaRaw(pm) {
    const jours = {};
    const titles = {};
    for (const k of Object.keys(pm._pmJours)) {
      jours[k] = JSON.parse(JSON.stringify(pm._pmJours[k] || []));
      if (Array.isArray(jours[k])) {
        for (const e of jours[k]) {
          const id = entryId(e);
          if (id) titles[id] = titleFor(pm, id);
        }
      }
    }
    return { jours, titles };
  }

  function snapshotAnima(pm, label) {
    return historyApi('POST', '', { source: 'anima', label, data: animaRaw(pm) });
  }

  async function writeAnima(pm, next) {
    // Replace the content in place: other functions keep a reference.
    for (const k of Object.keys(pm._pmJours)) delete pm._pmJours[k];
    Object.assign(pm._pmJours, next);
    try { pm.pmRenderPlanning(); } catch (e) {}
    await new Promise((resolve, reject) => {
      pm.pmSave((ok) => (ok ? resolve() : reject(new Error('Anima a refusé la sauvegarde'))));
    });
    try { pm._pmDirty = false; if (typeof pm.pmUpdateStatus === 'function') pm.pmUpdateStatus(); } catch (e) {}
  }

  async function restoreAnimaVersion(pm, snapId) {
    const { snapshot } = await historyApi('GET', '&id=' + encodeURIComponent(snapId));
    if (!snapshot || snapshot.source !== 'anima' || !snapshot.data || !snapshot.data.jours) {
      throw new Error('Version Anima illisible');
    }
    await snapshotAnima(pm, 'Avant restauration d\'une version');
    await writeAnima(pm, snapshot.data.jours);
  }

  // ── Actions ───────────────────────────────────────────────────
  async function animaToNetlify(pm, state, reason) {
    await snapshotAnima(pm, 'Copie Anima importée dans planning-bafa');
    const a = animaModel(pm);
    const tasks = [];
    for (const d of state.days) {
      for (const s of ['matin', 'aprem', 'veillee']) {
        for (const it of a[d.id + '|' + s] || []) {
          const fiche = ficheFor(pm, it.animaId);
          tasks.push(Object.assign(
            { dayId: d.id, slotId: s, text: it.text.slice(0, 300), animaId: it.animaId },
            fiche ? { ficheAnima: fiche } : {}
          ));
        }
      }
    }
    return api('POST', { op: 'replaceAll', tasks, reason: reason || 'Avant import depuis Anima' });
  }

  async function netlifyToAnima(pm, state) {
    // Never overwrite Anima without keeping a copy first.
    await snapshotAnima(pm, 'Avant envoi de planning-bafa vers Anima');
    // Title -> catalog id, to relink items typed by hand in planning-bafa.
    const byTitle = {};
    for (const [id, t] of Object.entries(pm._pmTemps || {})) {
      if (t && t.titre) byTitle[norm(t.titre)] = id;
    }
    // Keep existing Anima entries (they carry the formateur assignment).
    const existing = {};
    for (const key of pm.PM_SLOTS) {
      for (const e of pm._pmJours[key] || []) {
        const id = entryId(e);
        if (id && !existing[id]) existing[id] = typeof e === 'string' ? { type: 'temps', id: e } : e;
      }
    }
    const netDays = new Set(state.days.map((d) => d.id));
    const next = {};
    const relinked = [];
    for (const key of pm.PM_SLOTS) {
      const m = /^(j\d+)_(matin|apm|veillee)$/.exec(key);
      if (!m || !netDays.has(m[1])) { next[key] = pm._pmJours[key] || []; continue; }
      const slotId = SLOT_MAP[m[2]];
      next[key] = state.tasks
        .filter((t) => t.dayId === m[1] && t.slotId === slotId)
        .sort((x, y) => (x.order || 0) - (y.order || 0))
        .map((t) => {
          let id = t.animaId || byTitle[norm(t.text)] || t.text;
          if (!t.animaId && id !== t.text) relinked.push(t.text);
          return existing[id] || { type: 'temps', id };
        });
    }
    for (const k of Object.keys(pm._pmJours)) {
      if (!(k in next)) next[k] = pm._pmJours[k];
    }
    await writeAnima(pm, next);
    // Record the Anima ids on the planning-bafa side so future syncs match
    // by id rather than by title.
    if (relinked.length) await animaToNetlify(pm, state, 'Avant liaison au catalogue Anima');
    return relinked.length;
  }

  // ── UI ────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function panel() {
    let el = document.getElementById(UI_ID);
    if (el) el.remove();
    el = document.createElement('div');
    el.id = UI_ID;
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:min(560px,calc(100vw - 32px));'
      + 'max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#1A2B3A;border-radius:12px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.4 system-ui,-apple-system,sans-serif;padding:16px;';
    document.body.appendChild(el);
    return el;
  }

  function cellLabel(state, key) {
    const [day, slot] = key.split('|');
    const d = state && state.days.find((x) => x.id === day);
    const dl = d ? (d.short + ' ' + d.name + ' ' + d.date) : day.toUpperCase();
    return dl + ' · ' + (SLOT_LABEL[slot] || slot);
  }

  function list(items) {
    if (!items || !items.length) return '<em style="color:#999">vide</em>';
    return '<ul style="margin:2px 0 0;padding-left:16px">' + items.map((i) => '<li>' + esc(i.text) + '</li>').join('') + '</ul>';
  }

  async function render() {
    const el = panel();
    el.innerHTML = '<b>Synchro Anima ↔ planning-bafa</b><p>Chargement…</p>';
    const pm = findPM();
    if (!pm) {
      el.innerHTML = '<b>Synchro Anima ↔ planning-bafa</b><p>Ouvre d\'abord l\'onglet <b>« Planning du stage »</b> du stage concerné dans Anima, puis reclique sur le favori.</p>'
        + '<button data-act="close">Fermer</button>';
      el.querySelector('[data-act=close]').onclick = () => el.remove();
      return;
    }
    let state;
    try { state = await api('GET'); } catch (e) {
      el.innerHTML = '<b>Synchro</b><p style="color:#c00">Impossible de lire planning-bafa : ' + esc(e.message) + '</p><button data-act="close">Fermer</button>';
      el.querySelector('[data-act=close]').onclick = () => el.remove();
      return;
    }
    const netDays = new Set(state.days.map((d) => d.id));
    const cells = diffCells(animaModel(pm), netlifyModel(state), netDays);
    const unsaved = pm._pmDirty ? '<p style="background:#FFF4D6;padding:6px 8px;border-radius:6px">⚠️ Des modifications Anima ne sont pas encore sauvegardées. Elles seront prises en compte par « Anima → planning-bafa ».</p>' : '';
    const btn = 'border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;margin:4px 6px 0 0;';
    let html = '<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:15px">🔄 Synchro Anima ↔ planning-bafa</b>'
      + '<button data-act="close" style="border:0;background:none;font-size:18px;cursor:pointer">×</button></div>'
      + '<div style="color:#666;margin:2px 0 10px">Planning : <b>' + esc(state.planningName || CFG.planningId) + '</b></div>' + unsaved;
    if (!cells.length) {
      html += '<p style="color:#2A6749;font-weight:700">✓ Les deux plannings sont identiques.</p>';
    } else {
      html += '<p><b>' + cells.length + '</b> créneau(x) différent(s) :</p>';
      for (const c of cells) {
        html += '<div style="border:1px solid #D0DBE8;border-radius:8px;padding:6px 8px;margin:6px 0">'
          + '<div style="font-weight:700;margin-bottom:4px">' + esc(cellLabel(state, c.key)) + '</div>';
        if (c.outOfRange) {
          html += '<div style="color:#B57800">Jour absent de planning-bafa (non synchronisé) :</div>' + list(c.anima);
        } else {
          html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
            + '<div><div style="color:#666;font-size:11px">ANIMA</div>' + list(c.anima) + '</div>'
            + '<div><div style="color:#666;font-size:11px">PLANNING-BAFA</div>' + list(c.netlify) + '</div></div>';
        }
        html += '</div>';
      }
    }
    html += '<div style="margin-top:10px">'
      + '<button data-act="a2n" style="' + btn + 'background:#1B3A5C;color:#fff">Anima → planning-bafa</button>'
      + '<button data-act="n2a" style="' + btn + 'background:#E07B2A;color:#fff">planning-bafa → Anima</button>'
      + '</div><p style="color:#888;font-size:11px;margin:8px 0 0">La direction choisie écrase l\'autre côté (les cases cochées dans planning-bafa sont conservées).</p>'
      + '<div data-msg style="margin-top:8px;font-weight:700"></div>'
      + '<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:700">🕘 Versions Anima enregistrées</summary><div data-versions style="margin-top:6px">Chargement…</div></details>';
    el.innerHTML = html;
    loadVersions(el, pm);
    const msg = el.querySelector('[data-msg]');
    el.querySelector('[data-act=close]').onclick = () => el.remove();
    const run = async (fn, label) => {
      el.querySelectorAll('button[data-act=a2n],button[data-act=n2a]').forEach((b) => { b.disabled = true; });
      msg.style.color = '#1B3A5C';
      msg.textContent = label + '…';
      try {
        const extra = await fn();
        msg.style.color = '#2A6749';
        msg.textContent = '✓ ' + label + ' terminé' + (typeof extra === 'number' && extra ? ' (' + extra + ' module(s) reliés au catalogue Anima)' : '') + '.';
        setTimeout(render, 1200);
      } catch (e) {
        msg.style.color = '#c00';
        msg.textContent = 'Erreur : ' + e.message;
        el.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    };
    el.querySelector('[data-act=a2n]').onclick = () => run(() => animaToNetlify(pm, state), 'Anima → planning-bafa');
    el.querySelector('[data-act=n2a]').onclick = () => {
      if (!confirmInline(el, () => run(() => netlifyToAnima(pm, state), 'planning-bafa → Anima'))) return;
    };
  }

  async function loadVersions(el, pm) {
    const box = el.querySelector('[data-versions]');
    try {
      const { versions } = await historyApi('GET');
      const anima = versions.filter((v) => v.source === 'anima').slice(0, 15);
      if (!anima.length) { box.innerHTML = '<em style="color:#999">Aucune copie pour l\'instant (une copie est faite à chaque synchro).</em>'; return; }
      box.innerHTML = anima.map((v) => '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #EEE">'
        + '<span>' + esc(new Date(v.at).toLocaleString('fr-FR')) + '</span>'
        + '<button data-restore="' + esc(v.id) + '" style="font-size:11px">Restaurer dans Anima</button></div>').join('');
      box.querySelectorAll('[data-restore]').forEach((b) => {
        b.onclick = () => {
          b.outerHTML = '<span>Sûr ? <button data-yes>Oui</button></span>';
          const yes = box.querySelector('[data-yes]');
          yes.onclick = async () => {
            yes.disabled = true;
            try { await restoreAnimaVersion(pm, b.dataset.restore); render(); }
            catch (e) { yes.parentElement.textContent = 'Erreur : ' + e.message; }
          };
        };
      });
    } catch (e) {
      box.textContent = 'Historique indisponible : ' + e.message;
    }
  }

  // Inline confirmation (no window.confirm: blocked in some contexts).
  function confirmInline(el, onYes) {
    const box = el.querySelector('[data-msg]');
    box.style.color = '#1A2B3A';
    box.innerHTML = 'Remplacer le planning Anima par celui de planning-bafa ? '
      + '<button data-yes style="margin-left:6px">Oui, remplacer</button> <button data-no>Annuler</button>';
    box.querySelector('[data-yes]').onclick = onYes;
    box.querySelector('[data-no]').onclick = () => { box.textContent = ''; };
    return false;
  }

  if (!CFG.api || !CFG.planningId || !CFG.token) {
    panel().innerHTML = '<b>Synchro Anima</b><p>Favori incomplet : régénère-le depuis planning-bafa (bouton 🔄).</p>';
    return;
  }
  render();
})();
