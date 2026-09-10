# Feuille de route

## Vue d’ensemble

Le projet fournit actuellement une extension Pi déterministe de représentation
visuelle de sources. La série 0.4 est terminée. La prochaine étape n’est pas
un nouveau codec : c’est la séparation d’un cœur réutilisable, puis son usage
headless par Pi et Atlas Agent.

| Version | Objectif | État / critère de sortie |
|---|---|---|
| **0.1 — Prototype autonome** ✓ | Rendre le pipeline local fonctionnel | Extension Pi, codecs Rust/C, Typst, PNG, crop, profils et packaging |
| **0.2 — Python et premier usage réel** ✓ | Rendre `@v` utile sur des projets réels | Codec Python dense, globs déterministes, multifichier, confirmations, preview et fallback UTF-8 |
| **0.3 — Cache, Unicode, raster parallèle et prompt visuel** ✓ | Éviter les recalculs et structurer le contexte visuel | Cache SOURCE/TASK, TASK-only/TASK+SOURCE, timings, groupes de profils, workers bornés |
| **0.4a — Tablettes SOURCE adressables** ✓ | Relier chaque tablette aux lignes originales | VC-id, fichier, nom visuel et plages 1-based conservés dans les manifests |
| **0.4b — Index texte minimal** ✓ | Nommer les tablettes dans le contexte texte | `tabletIndex` dérivé de `source.tablets`, sans duplication du prompt source |
| **0.4c — Symbol anchors ↔ VC** ✓ | Relier les symboles aux lignes et tablettes | Extraction best-effort Python/Rust/C, `source.symbols[]`, mapping canonique |
| **0.4c½ — Identité VC persistante par projet** ✓ | Conserver l’identité entre les rendus | IDs monotones scoped projet, `project.json`, allocation atomique et cache compatible |
| **0.4d — Navigation sans réinjection** ✓ | Référencer le contexte SOURCE déjà injecté | Un Source Context Set par conversation, `--tablet`/`--symbol`, texte uniquement |
| **0.4e — Consultation locale de l’index symbolique** ✓ | Inspecter et désambiguïser le snapshot actif | `--symbols`, recherche locale bornée, sans modèle ni rendu |
| **0.5a — Core boundary** | Séparer le moteur du frontend Pi | Pipeline SOURCE invocable par API TypeScript sans charger Pi |
| **0.5b — Portable Source Context contract** | Définir un contrat machine versionné | Snapshot compréhensible par un consommateur externe, indépendant de Pi et Typst |
| **0.5c — Headless CLI** | Utiliser le cœur sans Pi | CLI JSON déterministe, diagnostics sur stderr, aucun modèle ni état conversationnel |
| **0.5d — Atlas Agent adapter** | Rendre le service utilisable par Atlas Agent | Atlas Agent récupère snapshots, artefacts et provenance dans son infrastructure qualifiée |
| **0.5e — Trace / observabilité Atlas Agent** | Rendre l’exécution observable | Event stream exploitable en console, JSONL durable et replay/post-mortem |
| **0.6 — Dogfooding Atlas Agent** | Piloter la suite par l’usage réel | Frictions répétées collectées et priorisées avant les nouvelles fonctionnalités structurantes |
| **0.7 — Visual IR et extensions** | Explorer les représentations plus riches | Couleurs, scopes, relations, graphes, annotations, formats et providers selon les besoins observés |

## État actuel : 0.4 terminé

Le pipeline SOURCE produit des tablettes adressables, persistantes et
provenancées. Un rendu identique conserve ses PNG et ses IDs ; un snapshot
modifié reçoit une nouvelle série monotone. `source.tablets[]` est la source
canonique de la provenance, et `tabletIndex` est sa projection compacte.

Les symbol anchors sont conservateurs et best-effort. Python dispose d’une
extraction structurelle ; Rust et C couvrent un sous-ensemble lexical. Les
omissions sont préférées aux faux positifs. Le texte UTF-8 générique reste
supporté, mais ne produit pas de symboles.

Le premier envoi SOURCE établit un unique **Source Context Set** dans la
conversation Pi. Il contient notamment les tablettes, le `tabletIndex`, les
symboles et l’identité du snapshot. Les commandes suivantes sont locales :

```text
@v --tablet PREFIX-VC-000123 -- question
@v --symbol Executor.run -- question
@v --symbols
@v --symbols run
```

`--tablet`, `--symbol` et `--symbols` ne réinjectent pas d’image et ne
relancent pas le rendu. Une seconde injection SOURCE est refusée dans la même
conversation. Les prompts TASK-only et les previews restent indépendants du
contexte SOURCE.

La persistance projet (`project.json`) et la persistance conversationnelle Pi
sont distinctes :

```text
cache de rendu / identité projet  → éviter un nouveau rendu lors d’une future injection
état de session Pi                → savoir quel snapshot est actif dans cette conversation
cache provider                    → responsabilité du provider
```

Si une compaction Pi retire les anciennes images du contexte modèle, 0.4 ne
les réinjecte pas automatiquement. La navigation suppose que les images
référencées sont encore conservées par le contexte effectif.

## 0.5 — Modularisation et intégration headless

### 0.5a — Core boundary

Le moteur doit être séparé du frontend Pi sans déplacer prématurément les
responsabilités de session ou d’UX.

Architecture cible :

```text
visual-context core
    ├── préparation des sources
    ├── codecs
    ├── Typst / raster
    ├── cache
    ├── identité VC persistante
    ├── provenance
    ├── symboles
    └── primitives d’index et de navigation

          ┌───────────────┴───────────────┐
          │                               │
      Pi adapter                    headless adapter
```

Le core doit être appelable par une API TypeScript sans charger Pi. L’adapter
Pi conserve ce qui appartient réellement à Pi : parser et UX `@v`, widgets,
statuts, confirmations, lifecycle de session, `appendEntry`, `ImageContent` et
hooks provider.

### 0.5b — Portable Source Context contract

Définir un contrat portable et versionné pour un Source Context Snapshot. Il
devra pouvoir contenir, selon le besoin réel :

```text
schemaVersion
sourceCacheKey / identité du snapshot
projectPrefix
tablets
tabletIndex
symbols
symbolDiagnostics
provenance
metrics
références d’images et d’artefacts
```

Le manifest historique de debug Pi ne doit pas devenir accidentellement l’API
publique. Un consommateur externe doit comprendre le snapshot sans connaître
Pi, Typst ou les détails internes du cache.

### 0.5c — Headless CLI

Interface conceptuelle :

```text
pvc prepare ...
pvc resolve-tablet ...
pvc resolve-symbol ...
pvc symbols ...
```

La sortie machine-readable va sur stdout ; progrès et diagnostics vont sur
stderr. Le CLI n’appelle aucun modèle, ne possède aucun état conversationnel et
produit les mêmes résultats déterministes que le core utilisé par Pi.

Critère : un programme Python ou Rust peut utiliser visual-context comme outil
externe sans charger l’environnement Pi.

### 0.5d — Atlas Agent adapter

pi-visual-context devient un service spécialisé consommable par Atlas Agent.
Il produit des observations, snapshots, artefacts et provenance ; il ne décide
pas de leur signification ni de leur persistance sémantique.

```text
pi-visual-context  → représentation visuelle, snapshots, artefacts, provenance
Atlas Agent        → autorisation, exécution, isolation, qualification, journal, matérialisation
Atlas              → interprétation, coordination, décision et connaissance éventuelle
```

Atlas Agent doit pouvoir exécuter le visual-context headless dans son
infrastructure qualifiée et récupérer le résultat sans faire de PVC une couche
sémantique Atlas ni le propriétaire du graphe Atlas.

### 0.5e — Trace / observabilité Atlas Agent

Cette étape concerne l’event stream du runtime Atlas Agent, pas un système de
trace propre à PVC. Il doit rendre visibles, lorsque pertinents :

```text
generation.start/end
model.request/response
tool.request
tool.accepted
tool.result/error
artifact
timing
agent/sub-agent identity
```

La même séquence doit pouvoir alimenter une console/TUI, un JSONL durable et
un mécanisme de replay ou post-mortem. PVC doit devenir un premier outil dont
les artefacts et durées sont réellement visibles dans cette timeline.

## 0.6 — Dogfooding Atlas Agent

Après 0.5e, ne pas empiler automatiquement de gros features dans PVC. Utiliser
Atlas Agent et pi-visual-context sur de vrais travaux, puis enregistrer les
frictions avec une structure simple :

```text
task
snapshot
action
expected affordance
observed problem
category
possible fix
```

Catégories utiles :

```text
missing-context, navigation, layout, symbol-index,
unsupported-language, unicode, cache, context-window,
latency, agent-decision, observability, provider-behavior
```

La roadmap suivante doit être pilotée par des problèmes répétés observés en
usage, et non uniquement par des fonctionnalités plausibles à l’avance.

## 0.7 — Visual IR et extensions

Les expérimentations ambitieuses sont volontairement repoussées ici :

- représentation visuelle plus formalisée et visual IR ;
- couleurs sémantiques, scopes et encadrements ;
- relations spatiales, graphes et annotations ;
- images natives et formats PDF/SVG/Mermaid/Graphviz ;
- documents convertibles ;
- providers, codecs ou capabilities externes ;
- éventuel registry de capabilities.

L’ordre de ces sujets ne sera pas décidé avant le dogfooding 0.6.

## Frontières et règle de convergence

Les responsabilités restent séparées :

```text
Pi
  frontend, UX et lifecycle de conversation

visual-context core
  observation et représentation visuelle déterministe

Atlas Agent
  exécution, isolation, qualification, journal et matérialisation

Atlas
  sémantique, interprétation, coordination et décision
```

Avant le dogfooding, ne pas construire un framework général de providers. La
priorité est d’avoir un core et deux consommateurs réels : Pi et Atlas Agent.
Les abstractions communes ne seront généralisées qu’après avoir été révélées
par ces deux usages.

Après 0.5e, une fonctionnalité structurante de visual-context doit idéalement
être justifiée par au moins un des éléments suivants :

- friction répétée en usage réel ;
- limitation mesurée ;
- besoin concret de Pi ou d’Atlas Agent ;
- invariant architectural nécessaire.

Éviter les fonctionnalités ajoutées uniquement parce qu’elles sont plausibles.

## Notes historiques conservées

Les premiers essais ont validé le rendu multifichier, les codecs Rust/C/Python,
le fallback UTF-8, les profils Romulus et le cache déterministe. Les anciens
résultats de benchmark et les explorations de typographie ont servi à choisir
le pipeline actuel ; ils ne constituent plus des milestones futurs.

La distribution multiplateforme complète et les binaires précompilés ne sont
pas prioritaires pour la modularisation. Les helpers source et les scripts de
build restent la base de distribution actuelle ; les binaires pourront être
réévalués après le core headless.
