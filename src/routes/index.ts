import { Router } from 'express';

const router = Router();

// Auth routes
router.post('/auth/register', (req, res) => {
  res.json({ message: 'Register endpoint' });
});

router.post('/auth/login', (req, res) => {
  res.json({ message: 'Login endpoint' });
});

// Feed routes
router.get('/feed', (req, res) => {
  res.json({ message: 'Get feed' });
});

export default router;
