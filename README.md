# TwitNinf API - Backend Services

RESTful API backend for TwitNinf, integrating with the NeuralRank Fusion recommendation engine.

## 🚀 Tech Stack

- **Framework**: Express.js / Fastify (TypeScript)
- **Database**: PostgreSQL
- **Cache**: Redis
- **Real-time**: Socket.io
- **Authentication**: JWT
- **Documentation**: OpenAPI/Swagger

## 🎯 Features

- User authentication & authorization
- Feed generation with recommendations
- Tweet CRUD operations
- User interactions (likes, retweets, replies)
- Real-time notifications
- WebSocket support
- Rate limiting
- API versioning

## 🏗️ Project Structure

```
src/
├── routes/           # API endpoints
├── controllers/      # Business logic
├── services/         # Business services
├── models/           # Database models
├── middleware/       # Express middleware
├── utils/            # Utility functions
├── types/            # TypeScript types
├── config/           # Configuration
├── database/         # DB setup
└── index.ts          # App entry point
```

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env

# Database setup
npm run db:migrate

# Development
npm run dev

# Production
npm run build
npm start
```

## 📦 API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register user
- `POST /api/v1/auth/login` - Login user
- `POST /api/v1/auth/refresh` - Refresh token

### Feed
- `GET /api/v1/feed` - Get personalized feed
- `GET /api/v1/feed/trending` - Get trending tweets
- `GET /api/v1/feed/discover` - Get discovery feed

### Tweets
- `POST /api/v1/tweets` - Create tweet
- `GET /api/v1/tweets/:id` - Get tweet
- `PUT /api/v1/tweets/:id` - Update tweet
- `DELETE /api/v1/tweets/:id` - Delete tweet

### Interactions
- `POST /api/v1/tweets/:id/like` - Like tweet
- `POST /api/v1/tweets/:id/retweet` - Retweet
- `POST /api/v1/tweets/:id/reply` - Reply to tweet

### Users
- `GET /api/v1/users/:id` - Get user profile
- `PUT /api/v1/users/:id` - Update profile
- `POST /api/v1/users/:id/follow` - Follow user

## 🔐 Environment Variables

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/twitninf

# Cache
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your_secret_key
JWT_EXPIRY=24h

# Recommendation Engine
RECOMMENDER_URL=http://localhost:3002

# CORS
CORS_ORIGIN=http://localhost:3000
```

## 🗄️ Database Schema

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR UNIQUE NOT NULL,
  email VARCHAR UNIQUE NOT NULL,
  password_hash VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tweets table
CREATE TABLE tweets (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Likes table
CREATE TABLE tweet_likes (
  tweet_id UUID REFERENCES tweets(id),
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

## 🧪 Testing

```bash
npm run test
npm run test:watch
npm run test:coverage
```

## 📚 Documentation

- [API Docs](./docs/API.md)
- [Database Schema](./docs/DATABASE.md)
- [Authentication](./docs/AUTH.md)

## 🤝 Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md)

## 📄 License

MIT
