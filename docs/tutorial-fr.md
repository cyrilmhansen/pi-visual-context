Tutoriel — analyser un texte avec Pi et pi-visual-context

Ce tutoriel montre comment utiliser pi-visual-context sur un corpus non logiciel.

Nous allons utiliser le Livre XIII des Entretiens de Confucius, disponible sur Wikisource. Le texte alterne le chinois classique et une traduction anglaise historique. Le livre aborde notamment le gouvernement, la conduite personnelle, l’éducation et le rapport entre langage et action.

La page Wikisource est disponible sous licence CC BY-SA ; si vous redistribuez le texte récupéré depuis Wikisource, conservez l’attribution et respectez les conditions indiquées par le site.

1. Préparer un petit répertoire de travail
mkdir analects-demo
cd analects-demo

Pour un premier essai, le plus simple est d’enregistrer le contenu du Livre XIII dans un fichier UTF-8, par exemple :

analects-xiii.txt

Source :

Wikisource — Confucian Analects, Book XIII

Il n’est pas nécessaire de convertir ce document dans un format particulier. pi-visual-context accepte les fichiers texte UTF-8 génériques.

Le fichier peut donc contenir directement une structure de ce type :

BOOK XIII. TSZE-LU.

Chapter I.
Tsze-lu asked about government.
...

Chapter II.
Chung-kung ... asked about government.
...

Le document original contient aussi les passages chinois correspondants.

2. Lancer Pi avec pi-visual-context

Depuis le dépôt pi-visual-context, l’extension peut être chargée directement :

pi -e /chemin/vers/pi-visual-context/src/index.ts

Si l’extension est déjà installée dans votre configuration Pi, démarrez simplement Pi normalement.

Pour vérifier les commandes disponibles :

/visual-context
3. Poser une première question avec le document visuel

Dans Pi :

@v analects-xiii.txt -- Quels sont les principaux principes de gouvernement défendus dans ce livre ?

pi-visual-context :

lit le fichier ;
le transforme en une ou plusieurs tablettes visuelles ;
joint ces images au message ;
ajoute un petit index permettant de les identifier ;
envoie la question au modèle avec ce contexte visuel.

Le modèle ne reçoit donc pas simplement plusieurs milliers de caractères copiés dans le prompt : il peut examiner la représentation visuelle du document.

Pour ce texte, une réponse devrait notamment remarquer des thèmes récurrents tels que l’exemplarité du dirigeant, l’éducation du peuple, la conduite personnelle ou encore la nécessité de rendre les noms et le langage conformes aux choses. Le chapitre III développe par exemple la célèbre idée de « rectifier les noms », tandis que le chapitre VI relie directement l’efficacité du gouvernement à la conduite personnelle du prince.

4. Poser une question plus transversale

On peut demander au modèle de comparer des passages éloignés dans le document :

@v analects-xiii.txt -- Compare les passages où Confucius insiste sur l'exemple personnel du gouvernant avec ceux où il parle de lois, d'ordres ou de sanctions.

Ce type de question illustre bien l’intérêt du contexte visuel : le modèle peut parcourir une représentation compacte de l’ensemble du texte au lieu de travailler uniquement sur un extrait sélectionné à l’avance.

Le Livre XIII contient par exemple à la fois des passages sur l’exemple personnel du dirigeant et des passages reliant langage, institutions et sanctions.

5. Continuer sans renvoyer les images

Une fois le contexte SOURCE injecté dans la conversation, les tablettes sont adressables.

L’index ajouté au message ressemble conceptuellement à :

PVC-VC-000123 analects-xiii.txt:1-85
PVC-VC-000124 analects-xiii.txt:84-167
PVC-VC-000125 analects-xiii.txt:166-240

Les identifiants exacts dépendront de votre projet.

Vous pouvez alors vous concentrer sur une tablette précise sans réinjecter son image :

@v --tablet PVC-VC-000124 -- Quels arguments apparaissent dans cette partie du texte ?

La commande produit uniquement une référence textuelle vers la tablette déjà présente dans la conversation.

6. Pourquoi --symbols n’est pas utile ici

Sur du code Python, Rust ou C, pi-visual-context peut extraire des symboles structurés et permettre par exemple :

@v --symbols
@v --symbol Executor.run -- explique cette méthode

analects-xiii.txt est en revanche du texte UTF-8 générique. Aucun extracteur de symboles n’est appliqué.

Donc :

@v --symbols

répondra normalement :

no symbol anchors are available in the active source context

Ce n’est pas une erreur d’analyse du texte : cela signifie seulement que PVC ne possède pas d’index structurel de symboles pour ce type de document.

Le modèle, lui, peut naturellement reconnaître visuellement des chapitres, personnages ou thèmes dans les tablettes.

7. Utiliser le prompt lui-même comme image

Pour une question longue, on peut également demander à PVC de rendre le prompt visuellement :

@v --visual-prompt analects-xiii.txt -- Analyse la conception du bon gouvernement dans ce livre. Distingue ce qui relève de la conduite personnelle du dirigeant, de la sélection des collaborateurs, de l'éducation du peuple, du langage politique et de la contrainte. Appuie chaque catégorie sur plusieurs passages distincts.

Le modèle reçoit alors séparément :

TASK tablets
+
SOURCE tablets

Cela peut être utile lorsque l’instruction elle-même devient suffisamment longue ou structurée pour bénéficier du canal visuel.

8. Prévisualiser sans appeler le modèle

Pour regarder uniquement le rendu produit :

@v --render analects-xiii.txt --

Ou pour ouvrir le rendu :

@v --render --open analects-xiii.txt --

La prévisualisation ne crée pas de Source Context Set actif et n’appelle pas le modèle.

Elle est pratique pour contrôler :

la lisibilité ;
le découpage en tablettes ;
le comportement de l’Unicode chinois ;
la densité du document.
9. Quelques questions intéressantes à essayer

Sur ce corpus, on peut tester par exemple :

Quels chapitres présentent le gouvernement comme une conséquence de la conduite personnelle ?
Quels passages mettent en opposition efficacité immédiate et transformation à long terme ?
Compare les chapitres III, VI, XIII et XVII. Quelle conception commune de l'action politique peut-on en tirer ?
Repère les passages où le texte oppose le bon dirigeant à un dirigeant médiocre ou mal conseillé.
La notion d'éducation apparaît-elle comme préalable, conséquence ou complément de la prospérité ?

Le chapitre IX, par exemple, propose explicitement la séquence « rendre le peuple nombreux → l’enrichir → l’instruire », et le chapitre XVII met en garde contre la recherche de résultats trop rapides et des petits avantages.

10. Ce que montre cet exemple

Ce cas d’usage ne dépend d’aucun codec de programmation.

fichier UTF-8
      ↓
pi-visual-context
      ↓
tablettes visuelles
      ↓
modèle multimodal
      ↓
questions globales et navigation

Il illustre donc que pi-visual-context n’est pas limité au code source : son cœur manipule un contexte visuel adressable, dont le texte source n’est qu’un cas d’entrée.

Pour un corpus littéraire plus important, on peut ensuite passer de :

un livre

à :

plusieurs livres ou chapitres

et tester la capacité du modèle à retrouver des thèmes ou des relations à travers plusieurs tablettes.
