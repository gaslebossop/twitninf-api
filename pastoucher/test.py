from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool

# Paramètres de connexion
DB_HOST = "51.255.48.125"
DB_PORT = 5432
DB_NAME = "twitninf"
DB_USER = "admin"
DB_PASSWORD = "myytree88"
DB_SSL = False  # Non utilisé ici car SSL est désactivé
DB_POOL_MAX = 20
DB_POOL_MIN = 5
DB_POOL_ACQUIRE = 30  # en secondes
DB_POOL_IDLE = 10     # en secondes

# URL de connexion PostgreSQL
DATABASE_URL = f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

# Création du moteur avec pool
engine = create_engine(
    DATABASE_URL,
    poolclass=QueuePool,
    pool_size=DB_POOL_MIN,
    max_overflow=DB_POOL_MAX - DB_POOL_MIN,
    pool_timeout=DB_POOL_ACQUIRE,
    pool_recycle=DB_POOL_IDLE
)

# Exemple de test de connexion
try:
    with engine.connect() as connection:
        result = connection.execute(text("SELECT NOW();"))
        print("Connexion réussie ✅ :", result.scalar())
except Exception as e:
    print("Erreur de connexion ❌ :", e)
