// ═══════════════════════════════════════════════════════════════
//   Import « Planning prévisionnel BAFA approfondissement »
//   (6 jours — 3 créneaux Matin / Repas / Après-midi)
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
//     CLEAR_FIRST : true pour vider les cases J1..J6 avant import.
// ═══════════════════════════════════════════════════════════════

(async () => {
  const PLANNING_ID =
    new URLSearchParams(location.search).get('planning') ||
    'pl_mo5wbkvm_0nu55z';
  const CLEAR_FIRST = false;

  // ── Contenu du planning (image fournie) ──────────────────────
  const SCHEDULE = {
    j1: {
      matin: [
        'Accueil, Présentation stage et tour de table',
        'Jeux présentation',
        "Affiches : PE règles de vie, thèmes, attentes, matériel, fonctions animateur, critères éval",
      ],
      aprem: [
        'Quizz 1 et rappels réglementaires',
        'Forum et prépa',
        'BSP : présentation structures, PP, PE, PA : format histoire',
      ],
    },
    j2: {
      matin: [
        'Forum',
        'BSP : communication, relations, projets des mineurs',
        'BSP : Journée type, organisation',
      ],
      aprem: [
        'AI (Animation individuelle) : prépa',
        'Thème de stage',
        'BSP : foire aux activités réalisées en stage pratique',
        'BSP : les contrats, embauche',
      ],
    },
    j3: {
      matin: [
        'Forum',
        'BSP : Handicap, maltraitance, VSS, VRI, harcèlement',
        'Thème de stage',
      ],
      aprem: [
        'Animations individuelles',
        'Thème de stage',
        'BSP : Prépa grand projet',
        'Mi-stage',
      ],
    },
    j4: {
      matin: [
        'Forum',
        'Intervention ASE / VEO / VSS',
        'Thème de stage',
      ],
      aprem: [
        'Création de jeux de société',
        'BSP : LAS, MS, addictions',
        'Les responsabilités',
      ],
    },
    j5: {
      matin: [
        'Forum',
        'Thème de stage',
        'Grand projet 1',
      ],
      aprem: [
        'Grand projet 2',
        'Prépa',
        'Jeu exceptionnel',
        'Repas animé',
        'Jeux de soirée',
      ],
    },
    j6: {
      matin: [
        'Forum',
        'Quizz final',
        'Jeux de société',
      ],
      aprem: [
        'Administratif',
        'Evaluations',
        'Fin de stage',
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
