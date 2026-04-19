# Scripts d'import

Petits utilitaires à coller dans la console du navigateur pour remplir un
planning en un clic plutôt qu'à la main.

## `import-bafa-approfondissement.js`

Remplit un planning de **6 jours** avec le contenu du *Planning prévisionnel
de formation BAFA approfondissement* (3 créneaux : matin / repas / après-midi,
le créneau *Repas* n'étant pas éditable).

### Utilisation

1. Ouvre ton planning dans le navigateur (connecté comme directeur) :
   `https://planning-bafa.netlify.app/?planning=<ID>`
2. Vérifie que le planning fait bien **6 jours** (bouton `✎` à côté du
   sélecteur ; sinon change « Nombre de jours » à 6).
3. Ouvre la console (F12 → *Console*).
4. Copie-colle l'intégralité de `import-bafa-approfondissement.js`.
5. Appuie sur *Entrée*. Chaque tâche ajoutée est loggée.

### Options

En haut du script :

- `PLANNING_ID` — auto-détecté depuis l'URL (`?planning=…`) ; à forcer au
  besoin.
- `CLEAR_FIRST` — mettre `true` pour vider les cases J1..J6 avant d'importer
  (utile si tu relances le script après un premier essai).

Les tâches existantes dans les jours **au-delà de J6** ne sont jamais
touchées.
