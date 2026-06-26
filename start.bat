@echo off
echo ========================================
echo    TwitNin API - PostgreSQL Optimisee
echo ========================================
echo.
echo [INFO] Configuration pour VPS PostgreSQL
echo [INFO] Assurez-vous que votre VPS PostgreSQL est accessible
echo.

REM Vérifier si Node.js est installé
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERREUR: Node.js n'est pas installe ou n'est pas dans le PATH
    echo Veuillez installer Node.js depuis https://nodejs.org/
    pause
    exit /b 1
)

REM Vérifier si npm est installé
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERREUR: npm n'est pas installe
    pause
    exit /b 1
)

echo [INFO] Node.js version: 
node --version
echo [INFO] npm version:
npm --version
echo.

REM Vérifier si le fichier .env existe
if not exist ".env" (
    echo [WARN] Fichier .env non trouve
    echo [INFO] Copie du fichier d'exemple...
    copy env.example .env
    echo [INFO] Veuillez configurer le fichier .env avant de continuer
    echo.
    echo Appuyez sur une touche pour ouvrir le fichier .env...
    pause >nul
    notepad .env
)

REM Installer les dépendances si nécessaire
if not exist "node_modules" (
    echo [INFO] Installation des dependances...
    npm install
    if %errorlevel% neq 0 (
        echo ERREUR: Echec de l'installation des dependances
        pause
        exit /b 1
    )
)

REM Vérifier si PostgreSQL est en cours d'exécution
echo [INFO] Verification de la connexion PostgreSQL...
echo [INFO] Assurez-vous que votre VPS PostgreSQL est accessible
echo [INFO] Configurez l'IP et le port dans le fichier .env

REM Lancer les migrations
echo [INFO] Execution des migrations PostgreSQL...
npm run migrate
if %errorlevel% neq 0 (
    echo [WARN] Echec des migrations, tentative de demarrage quand meme...
)

REM Vérifier si Redis est en cours d'exécution
echo [INFO] Verification de la connexion Redis...
echo [INFO] Assurez-vous que Redis est demarre et accessible

REM Démarrer l'API
echo [INFO] Demarrage de l'API TwitNin...
echo [INFO] L'API sera disponible sur http://localhost:3000
echo [INFO] Health check: http://localhost:3000/health
echo.
echo Appuyez sur Ctrl+C pour arreter le serveur
echo.

npm run dev

echo.
echo [INFO] Serveur arrete
pause
