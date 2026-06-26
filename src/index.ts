import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// API v1 routes
app.use('/api/v1', (req, res) => {
  res.json({ message: 'TwitNinf API v1' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
