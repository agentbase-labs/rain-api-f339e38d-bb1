import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import marketsRouter from './routes/marketsSdkOnly.js';
import usersRouter from './routes/usersStub.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    service: 'Rain Market API (SDK-only, no PostgreSQL)',
    version: '1.0.0',
    uptime: process.uptime(),
  }),
);

app.get('/health/db', (req, res) =>
  res.json({
    ok: false,
    postgres: false,
    note: 'This server runs in SDK-only mode; DATABASE_URL is not required.',
  }),
);

app.use('/markets', marketsRouter);
app.use('/users', usersRouter);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`API (SDK-only, no DB migrate) running on port ${PORT}`);
});
