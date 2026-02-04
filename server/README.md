# Baguier Virtuel - Module Backend

Ce module gère l'API, la base de données et l'exportation des statistiques pour le projet Bleu Reflet.

## Technologies
- Node.js & Express: Serveur API
- MongoDB (Atlas) : Base de données NoSQL
- Mongoose : Modélisation des données
- json2csv : Générateur d'export Excel/CSV

## Installation & Lancement

1.  Prérequis : Avoir Node.js installé.
2.  Installation des dépendances :
    ```bash
    cd backend-baguier
    npm install
    ```
3.  Configuration :
    Créez un fichier `.env` à la racine du dossier `backend-baguier` avec les infos suivantes (demander à Aurore pour le mot de passe) :
    ```env
    MONGO_URI=mongodb+srv://admin:MOT_DE_PASSE@cluster...
    PORT=3000
    ```
4.  Démarrage :
    ```bash
    node server.js
    ```
    Le serveur sera accessible sur `http://localhost:3000`.

## Documentation API

### 1. Sauvegarder une mesure
- URL : `POST /api/measurements`
- Description : Enregistre une nouvelle prise de mesure.
- Body (JSON) :
    ```json
    {
      "clientId": "Pandora",
      "fingerName": "index",
      "sizeEU": 54,
      "diameterMm": 17.2,
      "detectionMode": "Standard"
    }
    ```

### 2. Exporter les données
- URL : `GET /api/export`
- Description : Télécharge automatiquement un fichier `.csv` contenant tout l'historique.
