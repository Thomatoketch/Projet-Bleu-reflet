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