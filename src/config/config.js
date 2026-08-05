const path = require('path');
// Load .env from both the root directory and the api directory for safety
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config();

const config = {
  // Configuration du serveur
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: false
    }
  },

  // Configuration PostgreSQL optimisée
  database: {
    // Repli sur la boucle locale, pas sur l'IP d'un serveur : celle d'un ancien
    // hôte traînait ici, ce qui la publie et fait surtout pointer une install
    // mal configurée vers une base qui n'est pas la sienne.
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'twitninf',
    username: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD,
    dialect: 'postgres',
    pool: {
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
      min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 60000,
      idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000
    },
    logging: false,
    benchmark: false,
    define: {
      timestamps: true,
      underscored: true,
      freezeTableName: true
    },
    dialectOptions: {
      statement_timeout: 60000,
      idle_in_transaction_session_timeout: 60000,
      ssl: process.env.DB_SSL === 'true',
      connectTimeout: 60000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    },
    retry: {
      max: 5,
      timeout: 3000
    }
  },

  // Configuration JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    // Access token court : il embarque le rôle, le statut premium et la
    // suspension, qui mettaient jusqu'ici 7 jours à se propager. Le client
    // le renouvelle de façon transparente via /api/auth/refresh.
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    // Conservé pour l'ancien generateRefreshToken (déprécié) : la durée de vie
    // réelle des sessions est SESSION_TTL_MS dans authService.
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '180d'
  },

  // Configuration de sécurité
  security: {
    bcryptRounds: 12,
    rateLimit: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000 // limite chaque IP à 1000 requêtes par fenêtre
    }
  },

  // Configuration des logs
  logging: {
    level: 'info',
    filename: 'logs/app.log'
  },

  // Configuration des emails
  email: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: '',
      pass: ''
    }
  },

  // Configuration Redis optimisée
  //
  // ⚠️ Le bloc `socket` n'est pas décoratif. Ce fichier était écrit pour
  // node-redis v3, où `host` et `port` étaient des clés de premier niveau. La
  // v4 (celle qui est installée) ne les lit plus : elle attend
  // `socket: { host, port }` et, à défaut, se rabat silencieusement sur
  // 127.0.0.1:6379. Tant que Redis tournait sur la même machine que l'API, le
  // bug était invisible — la valeur par défaut se trouvait être la bonne. Dès
  // qu'une instance doit joindre un Redis distant, elle se connecte à sa
  // propre boucle locale et échoue en ECONNREFUSED sans que `REDIS_HOST`
  // apparaisse nulle part dans l'erreur.
  //
  // Les clés de premier niveau sont conservées : plusieurs endroits du code
  // lisent `config.redis.host` pour journaliser ou diagnostiquer.
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      keepAlive: 30000,
      family: 4
    },
    password: process.env.REDIS_PASSWORD || null,
    database: parseInt(process.env.REDIS_DB, 10) || 0,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    keepAlive: 30000,
    family: 4,
    maxMemoryPolicy: 'allkeys-lru'
  },

  // Configuration des uploads
  upload: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
    uploadPath: 'uploads/',
    defaultAvatar: 'https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U'
  },

  // Configuration des notifications
  notifications: {
    push: {
      vapidPublicKey: '',
      vapidPrivateKey: ''
    }
  },

  // Configuration du cache
  cache: {
    ttl: 300, // 5 minutes
    checkPeriod: 600, // 10 minutes
    maxKeys: 1000
  },

  // Configuration des performances
  performance: {
    compression: {
      level: 6,
      threshold: 1024
    },
    queryTimeout: 30000,
    connectionTimeout: 10000
  }
};

module.exports = config;
