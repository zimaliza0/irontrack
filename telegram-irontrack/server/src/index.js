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

const { createTelegramAuthMiddleware } = require('./telegramAuth');
const telegramAuthMiddleware = createTelegramAuthMiddleware(sheets);

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

// Небольшой хелпер, чтобы не писать try/catch в каждом роуте. Уважает кастомный
// e.status (используется guard-функциями ниже для 403 вместо общего 400).
function h(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status((e && e.status) || 400).json({ error: (e && e.message) || String(e) });
    }
  };
}

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// Только тренер (req.telegramRole === 'trainer'). Используется для управления клиентами,
// упражнениями, шаблонами и резервными копиями — административные действия.
function requireTrainer(req) {
  if (req.telegramRole !== 'trainer') throw forbidden('Это действие доступно только тренеру.');
}

// Тренер может работать с любым userId; клиент (athlete) — только со своим собственным.
function requireOwnUserOrTrainer(req, userId) {
  if (req.telegramRole === 'athlete' && String(userId || '') !== String(req.telegramAthleteUserId)) {
    throw forbidden('Недостаточно прав для этого действия.');
  }
}

// То же самое, но когда нужно проверить владельца конкретной тренировки (а не userId
// напрямую из тела запроса) — подтягиваем тренировку и сверяем UserID.
async function requireOwnWorkoutOrTrainer(req, workoutId) {
  if (req.telegramRole !== 'athlete') return;
  const data = await sheets.getAppData();
  const w = (data.workouts || []).find((x) => x.WorkoutID === workoutId);
  if (!w || String(w.UserID) !== String(req.telegramAthleteUserId)) {
    throw forbidden('Недостаточно прав для этого действия.');
  }
}

app.get('/health', (req, res) => res.json({ ok: true, driver }));

app.use('/api', telegramAuthMiddleware);

// Кто я — тренер или конкретный привязанный спортсмен. Фронтенд использует это, чтобы
// заблокировать выбор клиента и скрыть административные разделы для роли "athlete".
app.get('/api/me', h((req) => ({ role: req.telegramRole, athleteUserId: req.telegramAthleteUserId })));

app.get('/api/data', h(() => sheets.getAppData()));

app.post('/api/users', h((req) => { requireTrainer(req); return sheets.addUser(req.body); }));
app.post('/api/exercises', h((req) => { requireTrainer(req); return sheets.addExercise(req.body); }));
app.post('/api/templates', h((req) => { requireTrainer(req); return sheets.addTemplate(req.body); }));

// Принимает { items: [...] } — массив упражнений, добавляемых в шаблон разом
app.post('/api/template-exercises', h((req) => { requireTrainer(req); return sheets.addTemplateExercises(req.body.items || req.body); }));
app.delete('/api/template-exercises/:id', h((req) => { requireTrainer(req); return sheets.deleteTemplateExercise(req.params.id); }));
app.put('/api/templates/:templateId/order', h((req) => { requireTrainer(req); return sheets.updateTemplateOrder(req.params.templateId, req.body.orderData || []); }));

app.post('/api/workouts/start', h((req) => { requireOwnUserOrTrainer(req, req.body.userId); return sheets.startWorkout(req.body.userId, req.body.templateId); }));
app.post('/api/workouts/plan', h((req) => { requireOwnUserOrTrainer(req, req.body.userId); return sheets.planWorkout(req.body.userId, req.body.templateId, req.body.date); }));
app.post('/api/workouts/:id/start-planned', h(async (req) => { await requireOwnWorkoutOrTrainer(req, req.params.id); return sheets.startPlannedWorkout(req.params.id); }));
app.post('/api/workouts/:id/sets', h(async (req) => { await requireOwnWorkoutOrTrainer(req, req.params.id); return sheets.saveAllSets(req.params.id, req.body.sets || []); }));
app.post('/api/workouts/:id/finish', h(async (req) => { await requireOwnWorkoutOrTrainer(req, req.params.id); return sheets.finishWorkout(req.params.id, req.body.note, req.body.durationSeconds); }));
app.delete('/api/workouts/:id', h(async (req) => { await requireOwnWorkoutOrTrainer(req, req.params.id); return sheets.deleteWorkout(req.params.id); }));

app.get('/api/progress', h((req) => { requireOwnUserOrTrainer(req, req.query.userId); return sheets.getProgress(req.query.userId, req.query.exerciseId); }));

app.delete('/api/users/:id', h((req) => { requireTrainer(req); return sheets.deleteUser(req.params.id); }));
app.post('/api/users/:id/telegram', h((req) => { requireTrainer(req); return sheets.linkUserTelegramId(req.params.id, req.body.telegramId); }));

app.post('/api/backups', h((req) => { requireTrainer(req); return sheets.createBackup('manual'); }));
app.get('/api/backups', h((req) => { requireTrainer(req); return sheets.listBackups(); }));
app.get('/api/backups/:id', h((req) => { requireTrainer(req); return sheets.getBackup(req.params.id); }));

app.post('/api/bodyweight', h((req) => { requireOwnUserOrTrainer(req, req.body.userId); return sheets.logBodyWeight(req.body.userId, req.body.date, req.body.weight); }));
app.get('/api/bodyweight', h((req) => { requireOwnUserOrTrainer(req, req.query.userId); return sheets.getBodyWeightLog(req.query.userId); }));

app.get('/api/nutrition/target', h((req) => { requireOwnUserOrTrainer(req, req.query.userId); return sheets.getNutritionTarget(req.query.userId); }));
app.post('/api/nutrition/target', h((req) => { requireOwnUserOrTrainer(req, req.body.userId); return sheets.setNutritionTarget(req.body.userId, req.body); }));
app.post('/api/nutrition/log', h((req) => { requireOwnUserOrTrainer(req, req.body.userId); return sheets.logNutrition(req.body.userId, req.body.date, req.body); }));
app.get('/api/nutrition/log', h((req) => { requireOwnUserOrTrainer(req, req.query.userId); return sheets.getNutritionLog(req.query.userId); }));

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
