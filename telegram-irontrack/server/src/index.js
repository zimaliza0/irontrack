require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const driver = String(process.env.DB_DRIVER || 'local').toLowerCase();
const sheets =
  driver === 'sheets' ? require('./sheets') :
  driver === 'turso' ? require('./db-turso') :
  require('./db-local');
console.log('Хранилище данных:', { sheets: 'Google Sheets', turso: 'Turso (SQLite)', local: 'локальный файл server/data/db.json' }[driver] || driver);

const { telegramAuthMiddleware } = require('./telegramAuth');

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN !== '*' ? process.env.ALLOWED_ORIGIN : true,
  })
);

// Отдаём фронтенд (webapp/index.html) с того же сервера — удобно для локального теста:
// открываете http://localhost:3000 в браузере и сразу видите приложение без отдельного
// статического хостинга. При деплое можно оставить как есть или раздавать webapp отдельно.
app.use(express.static(path.join(__dirname, '..', '..', 'webapp')));

// Небольшой хелпер, чтобы не писать try/catch в каждом роуте
function h(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: (e && e.message) || String(e) });
    }
  };
}

app.get('/health', (req, res) => res.json({ ok: true, driver }));

app.use('/api', telegramAuthMiddleware);

app.get('/api/data', h(() => sheets.getAppData()));

app.post('/api/users', h((req) => sheets.addUser(req.body)));
app.post('/api/exercises', h((req) => sheets.addExercise(req.body)));
app.post('/api/templates', h((req) => sheets.addTemplate(req.body)));

// Принимает { items: [...] } — массив упражнений, добавляемых в шаблон разом
app.post('/api/template-exercises', h((req) => sheets.addTemplateExercises(req.body.items || req.body)));
app.delete('/api/template-exercises/:id', h((req) => sheets.deleteTemplateExercise(req.params.id)));
app.put('/api/templates/:templateId/order', h((req) => sheets.updateTemplateOrder(req.params.templateId, req.body.orderData || [])));

app.post('/api/workouts/start', h((req) => sheets.startWorkout(req.body.userId, req.body.templateId)));
app.post('/api/workouts/plan', h((req) => sheets.planWorkout(req.body.userId, req.body.templateId, req.body.date)));
app.post('/api/workouts/:id/start-planned', h((req) => sheets.startPlannedWorkout(req.params.id)));
app.post('/api/workouts/:id/sets', h((req) => sheets.saveAllSets(req.params.id, req.body.sets || [])));
app.post('/api/workouts/:id/finish', h((req) => sheets.finishWorkout(req.params.id, req.body.note, req.body.durationSeconds)));
app.delete('/api/workouts/:id', h((req) => sheets.deleteWorkout(req.params.id)));

app.get('/api/progress', h((req) => sheets.getProgress(req.query.userId, req.query.exerciseId)));

app.delete('/api/users/:id', h((req) => sheets.deleteUser(req.params.id)));

app.post('/api/backups', h(() => sheets.createBackup('manual')));
app.get('/api/backups', h(() => sheets.listBackups()));
app.get('/api/backups/:id', h((req) => sheets.getBackup(req.params.id)));

const port = process.env.PORT || 3000;
sheets.ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log('IronTrack backend listening on http://localhost:' + port);
    });
  })
  .catch((e) => {
    console.error('Не удалось инициализировать хранилище данных:', e.message);
    process.exit(1);
  });
