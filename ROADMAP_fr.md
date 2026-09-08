# Feuille de route

## Vue d’ensemble

| Version | Objectif | Contenu principal | Critère de sortie |
|---|---|---|---|
| **0.1 — Prototype autonome** | Publier quelque chose qui fonctionne réellement | Extension Pi, `rust-strip-lex` embarqué, profils `normal`/`conservative`, rendu Typst, recadrage de la dernière page, en-têtes, artefacts de debug, usage des tokens, script de release | Un clone peut être construit et `@v` fonctionne localement sans dépendre du repo POC |
| **0.2 — Packaging propre** | Rendre l’installation raisonnable | Licence et police Romulus, build Rust, `npm pack`, README d’installation, tests unitaires légers | Installation documentée depuis Git ou npm |
| **0.3 — Usage réel dans Pi** | Vérifier que le concept aide réellement au développement | Plusieurs fichiers, questions successives, persistance de session, reprise de conversation, cache Pi/provider | Utilisation sur de vrais projets, sans banc de benchmark |
| **0.4 — Navigation visuelle** | Passer de « fichier-image » à un véritable contexte source | Plages de lignes et symboles, plusieurs fichiers, index texte minimal, provenance et métadonnées de pages | Le modèle peut demander ou retrouver une zone précise |
| **0.5 — Codec visuel v1** | Formaliser ce qui est encodé | Représentation auto-descriptive, métadonnées dans l’image, symboles LF/TAB, profils, version du codec | Format reproductible et versionné |
| **0.6 — Performance et cache** | Éviter les recalculs et optimiser les coûts | Hash source + profil, cache d’images, invalidation, prise en compte du prompt cache, métriques de tokens d’entrée | Fichier inchangé → aucun nouveau rendu |
| **0.7 — Expérimentations de programmation visuelle** | Exploiter réellement le canal graphique | Couleurs catégorielles, boîtes, relations, références spatiales, graphes, annotations | Gains au-delà du simple texte rasterisé |
| **1.0 — Visual context layer** | Faire de l’extension un composant générique | API stable, plusieurs langages, plugin Pi propre, éventuellement Atlas | Usage quotidien stable et documentation publique |

---

## État d’avancement

Le prototype autonome 0.1 est maintenant implémenté et validé sans appel LLM : build Rust, profils, rendu, crop, en-têtes, artefacts de debug, usage et packaging sont en place.

Le support multifichier de base et les codecs Rust/C sont également implémentés. La navigation par symboles, l’indexation et le cache restent futurs.

## 0.1 — Terminé

Le scope livré est :

```text
@v path.rs -- question
@v --profile conservative path.rs -- question
@v foo.h foo.c -- question
```

avec les profils suivants :

```text
normal
  Romulus
  scale 1.00
  margin 12
  gutter 24

conservative
  Romulus
  scale 1.05
  margin 64
  gutter 32
```

### Fonctionnalités déjà acquises

- Rust `strip-lex` et codec lexical C
- rendu Typst
- pages PNG
- recadrage de la dernière page
- en-tête visuel
- support multifichier dans un même message
- `detail=original` sélectif
- `ImageContent` Pi
- persistance de conversation Pi
- artefacts de debug
- usage par requête `@v`

Ces éléments sont désormais terminés. Le prochain travail porte sur l’usage réel du système, pas sur de nouveaux benchmarks.

---

## 0.2 — Distribution et usage réel

La distribution de base est maintenant résolue : Romulus est embarqué avec son attribution, le helper Rust/C est fourni en source et les scripts de build/package sont présents.

Les binaires précompilés restent hors scope. Trois possibilités restent envisageables pour de futures distributions multiplateformes, par ordre de préférence :

1. licence compatible → inclure Romulus ;
2. licence non redistribuable → demander à l’utilisateur de fournir la police ;
3. remplacer Romulus par une police redistribuable ayant des propriétés proches.

Je ne convertirais pas le helper Rust en TypeScript. Pour une première publication :

```text
package npm
   +
source Rust inclus
   +
cargo build
```

est tout à fait acceptable.

Plus tard seulement :

```text
linux-x64
linux-arm64
macos-arm64
windows-x64
```

avec des binaires précompilés dans les releases.

---

## 0.3 — Arrêter les microbenchmarks et utiliser le système

C’est probablement l’étape la plus importante après la release.

On a déjà obtenu :

```text
serde_json/src/de.rs
86.8k caractères source
70.3k caractères encodés
4 images
4.4k tokens d’entrée
1 appel Sol Medium
réponse architecturale cohérente
```

Je ne chercherais plus à optimiser `gutter=22` contre `gutter=24`.

Les tests intéressants deviennent :

- « explique ce fichier » ;
- « où est gérée telle propriété ? » ;
- « quels invariants relient ces deux portions ? » ;
- « vois-tu un bug potentiel ? » ;
- « compare ces deux fichiers » ;
- « propose une modification ».

Puis surtout une deuxième question dans la même conversation, sans réinjecter le contexte, pour comprendre comment Pi, la session et le provider réutilisent les images.

C’est là qu’on étudiera proprement le cache de conversation de Pi.

---

## 0.4 — Navigation visuelle

Le support multifichier de base est terminé : plusieurs fichiers `.rs`, `.c` et `.h` peuvent être rendus indépendamment dans un seul message, dans l’ordre fourni.

La navigation par index reste à construire. L’interface naturelle pourrait évoluer vers :

```text
@v src/foo.rs src/bar.rs -- question
```

puis :

```text
@v src/
```

Mais je n’enverrais jamais naïvement tout un dépôt.

Il faut plutôt introduire une représentation légère parallèle :

```text
source canonique texte
        │
        ├── index noms/symboles/fichiers
        │
        └── pages visuelles
```

Le modèle peut alors savoir :

```text
page VC-013
file src/de.rs
symbols around parse_exponent_overflow
```

et demander du texte exact uniquement lorsqu’il doit modifier quelque chose.

C’est la séparation que nous avions déjà esquissée :

> visuel pour la compréhension globale, texte pour l’adressage exact et l’édition.

---

## 0.5 — Rendre les « tablettes » réellement auto-descriptives

L’en-tête que nous ajoutons maintenant n’est que le début.

Une page pourrait progressivement encoder :

- la version du codec ;
- le langage ;
- le chemin relatif au dépôt ;
- le hash de la source ;
- la page `n/N` ;
- le profil ;
- la plage de source ou de symboles.

Mais autant que possible dans le canal visuel, et non en répétant cela dans les tokens texte.

On arrive alors à l’idée discutée des « tablettes » :

```text
source canonique
     ↓
visual-context codec
     ↓
tablettes dérivées, immuables, adressables
```

Une tablette pourrait être conservée, indexée, réutilisée et éventuellement avoir plusieurs « éditions » selon le modèle :

```text
normal
conservative
dense
```

---

## 0.6 — Cache

C’est seulement à ce moment-là que je construirais le cache propre :

```text
SHA256(
  source bytes
  + codec version
  + profile
  + renderer version
)
→ pages
```

Cela couvre :

- la réutilisation entre les tours ;
- la réutilisation entre les sessions ;
- la reprise de Pi ;
- Atlas plus tard ;
- l’absence de nouveau rendu pour un fichier inchangé.

À distinguer clairement de :

```text
cache fichier rendu       ← notre extension
session persistence       ← Pi
prompt/input cache        ← provider
```

L’UI pourrait finir par montrer :

```text
visual-context:
4 pages · 70.3k chars
render cache hit
↑ 4.4k · cache R 3.9k
```

---

## 0.7 — Dépasser le simple « code imprimé »

C’est là que le projet devient réellement original.

Une fois le pipeline stable, on pourra essayer des choses qu’un fichier texte ne peut pas exprimer aussi efficacement :

- couleurs = catégories syntaxiques ;
- encadrements = scopes ;
- traits = relations ;
- glyphes = types de symboles ;
- zones = modules ;
- annotations marginales ;
- références spatiales.

Le principe que nous avions formulé reste bon :

> Tout élément graphique doit avoir une fonction symbolique.

Pas de décoration.

Il faudra aussi rester prudent avec la couleur : notre ancien essai de multiplexage RGB n’avait pas fonctionné, mais cela ne dit rien contre une palette simple, spatialement séparée et sémantique.

---

## Hors scope pour l’instant

- ❌ optimisation supplémentaire de la typographie ;
- ❌ nouveaux benchmarks Astra massifs ;
- ❌ support Python/TypeScript ;
- ❌ Atlas ;
- ❌ graphes ;
- ❌ couleurs ;
- ❌ vectoriel ;
- ❌ cache sophistiqué ;
- ❌ binaires Rust multiplateformes.

Le chemin critique est plutôt :

```text
maintenant
   ↓
repo autonome
   ↓
release 0.1
   ↓
vrais usages Pi
   ↓
navigation + persistance
   ↓
codec visuel formalisé
   ↓
visual IR plus riche
```

Je pense que c’est la bonne manière de converger sans perdre l’ambition initiale : la version actuelle est déjà suffisamment intéressante pour être publiée et utilisée ; les idées plus radicales deviennent des étapes explicites de la roadmap plutôt que des fonctionnalités que l’on essaie de faire entrer dans le MVP.
