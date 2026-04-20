// ═══════════════════════════════════════════════════════════════
//   Import « Planning prévisionnel BAFA approfondissement »
//   Version d'Océane — Mardi → Samedi (J2..J6)
//
//   ⚠ Le Lundi (J1) n'est PAS touché par ce script : il est déjà
//   à jour dans le planning actuel. Seuls les jours présents dans
//   SCHEDULE ci-dessous sont vidés (si CLEAR_FIRST = true) puis
//   remplis.
//
//   Mode d'emploi
//   ─────────────
//   1. Ouvre ton planning dans le navigateur :
//        https://planning-bafa.netlify.app/?planning=<ID>
//      (connecté comme directeur propriétaire du planning)
//   2. Assure-toi que le planning fait bien 6 jours (sinon : « ✎ »
//      sur le planning → Nombre de jours = 6).
//   3. Ouvre la console du navigateur (F12 → onglet « Console »).
//   4. Copie-colle tout ce fichier, puis appuie sur Entrée.
//   5. Regarde le log : chaque tâche ajoutée apparaît. À la fin :
//        ✓ Import terminé — N tâches ajoutées.
//
//   Variables à ajuster éventuellement :
//     PLANNING_ID : auto-détecté depuis l'URL, ou à forcer ci-dessous.
//     CLEAR_FIRST : true pour vider les cases J2..J6 avant import
//                   (le Lundi J1 n'est jamais vidé).
// ═══════════════════════════════════════════════════════════════

(async () => {
  const PLANNING_ID =
    new URLSearchParams(location.search).get('planning') ||
    'pl_mo5wbkvm_0nu55z';
  const CLEAR_FIRST = true;

  // ── Contenu du planning (version Océane) ─────────────────────
  //   Seuls J2..J6 sont redéfinis ; J1 (Lundi) reste intact.
  const SCHEDULE = {
    j2: {
      matin: [
        'Forum',
        'BSP : Foire aux activités réalisées en stage pratique (10-15 min prép)',
        'BSP : Les contrats, embauche',
        'Thème de stage — 2 groupes',
      ],
      aprem: [
        'BSP : Communication / Relations / projet',
        'BSP : Journée type + organisation',
        'Les responsabilités',
        'Animation individuelle + Prépa',
      ],
    },
    j3: {
      matin: [
        'Forum',
        'Intervention MARIE',
      ],
      aprem: [
        'Animation individuelle',
        'Thème de stage — 1 ou 2',
        'BSP : Grands jeux',
        'Prépa grands jeux + mi-stage',
      ],
    },
    j4: {
      matin: [
        'Forum',
        'Thème de stage — 1 ou 2',
        'Création jeu de société',
      ],
      aprem: [
        'BSP : Liberté / autrui / sanction + Addictions — 2 groupes',
        'Prépa veillée',
        'Veillée',
      ],
    },
    j5: {
      matin: [
        'Forum',
        'Grand jeu 1',
        'Grand jeu 2',
      ],
      aprem: [
        'Grand jeu 3',
        'Grand jeu 4',
        'Thème de stage',
        'Rangement / Ménage',
      ],
    },
    j6: {
      matin: [
        'Quizz',
        'Kermesse',
        'Administratif',
      ],
      aprem: [
        'Ménage finalisé',
        'Bilan — Évaluation',
      ],
    },
  };

  // ── Helpers ──────────────────────────────────────────────────
  async function api(body) {
    const res = await fetch(
      `/api/state?planning=${encodeURIComponent(PLANNING_ID)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, planningId: PLANNING_ID }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function fetchState() {
    const res = await fetch(
      `/api/state?planning=${encodeURIComponent(PLANNING_ID)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Préflight ────────────────────────────────────────────────
  console.log(`▶ Import BAFA approfondissement → ${PLANNING_ID}`);
  let state;
  try {
    state = await fetchState();
  } catch (e) {
    console.error('✗ Impossible de lire le planning :', e.message);
    console.error('  Vérifie que tu es connecté et que l\'ID est correct.');
    return;
  }

  const dayIds = state.days.map((d) => d.id);
  const missing = Object.keys(SCHEDULE).filter((id) => !dayIds.includes(id));
  if (missing.length) {
    console.error(
      `✗ Ce planning n'a pas les jours requis (manquants : ${missing.join(', ')}).`,
    );
    console.error(
      '  Passe-le à 6 jours via le bouton « ✎ » sur le planning, puis relance.',
    );
    return;
  }

  // ── Nettoyage optionnel ──────────────────────────────────────
  if (CLEAR_FIRST) {
    const targets = state.tasks.filter(
      (t) => SCHEDULE[t.dayId] && (t.slotId === 'matin' || t.slotId === 'aprem'),
    );
    console.log(`⌫ Suppression de ${targets.length} tâche(s) existante(s)…`);
    for (const t of targets) {
      try {
        await api({ op: 'remove', taskId: t.id });
      } catch (e) {
        console.warn(`  · ${t.id} : ${e.message}`);
      }
    }
  }

  // ── Import ───────────────────────────────────────────────────
  let added = 0;
  let failed = 0;
  for (const [dayId, slots] of Object.entries(SCHEDULE)) {
    for (const [slotId, items] of Object.entries(slots)) {
      for (const text of items) {
        try {
          await api({ op: 'add', dayId, slotId, text });
          added += 1;
          console.log(`  + [${dayId}/${slotId}] ${text}`);
        } catch (e) {
          failed += 1;
          console.error(`  ✗ [${dayId}/${slotId}] ${text} — ${e.message}`);
        }
      }
    }
  }

  console.log(
    `✓ Import terminé — ${added} tâche(s) ajoutée(s)` +
      (failed ? `, ${failed} échec(s).` : '.'),
  );
  console.log('   Recharge la page pour voir le résultat (ou attends 2 s).');
})();
