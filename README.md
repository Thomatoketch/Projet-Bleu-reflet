# 💍 Baguier Virtuel - Bleu Reflet

Application de mesure de tour de doigt utilisant la réalité augmentée (MediaPipe) et une sauvegarde des statistiques en base de données.

## 📂 Structure du projet

- **client/** : Frontend Vue.js (Interface utilisateur, Caméra, Calculs)
- **server/** : Backend Node.js/Express (API, Base de données MongoDB)

## 🚀 Installation et Démarrage

Il faut lancer le **Server** et le **Client** simultanément dans deux terminaux.

### 1. Démarrer le Backend (Serveur)

```bash
cd server
npm install
# Créez un fichier .env avec : MONGO_URI=... et PORT=3000
node server.js
```

# 🚀 Intégration du Baguier Virtuel via Iframe

Ce guide explique comment intégrer le module de prise de mesure sur un site partenaire ou client.

---

## 1. Code d'intégration standard

Pour intégrer le module, insérez le code HTML suivant dans la page cible :

```html
<iframe 
  src="[https://votre-domaine-baguier.com/?client=NOM_DU_CLIENT](https://votre-domaine-baguier.com/?client=NOM_DU_CLIENT)" 
  width="100%" 
  height="600px" 
  style="border: none; border-radius: 10px;"
  allow="camera; display-capture"
></iframe>
```

[!IMPORTANT] L'attribut allow="camera" est obligatoire pour autoriser l'accès au flux vidéo via MediaPipe.

## 2. Paramètres d'URL

Le module utilise les paramètres de requête (Query Params) pour personnaliser l'expérience :

- client : (Obligatoire) Identifiant de la marque cliente (ex: ?client=Pandora). Ce paramètre est utilisé par le backend pour segmenter les statistiques.

- Personnalisation : Le module est conçu pour supporter des paramètres optionnels tels que la langue, le logo ou les couleurs via l'URL.

## 3. Fonctionnement Technique

Mode de détection : Le système détecte automatiquement la présence d'un capteur LiDAR. S'il n'est pas disponible, il bascule sur le mode "Standard" (fallback algorithmique).

Communication : Le baguier communique avec le backend Node.js pour enregistrer chaque étape du parcours utilisateur.

Confidentialité : Aucune image vidéo n'est stockée sur le serveur. Seules les données de mesures (diamètre, taille) sont conservées de manière anonyme.

## 4. Événements enregistrés

Chaque intégration via iframe permet de remonter les statistiques suivantes en base de données :

- Ouverture du module.
- Type de doigt mesuré.
- Mode utilisé (LiDAR vs Standard).
- Taille de bague finale et niveau de confiance de la mesure.