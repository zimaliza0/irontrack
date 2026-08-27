// Локальное хранилище на JSON-файле — для тестирования на ПК без Google Sheets API,
// сервисных аккаунтов и т.д. Экспортирует ровно те же функции с теми же сигнатурами,
// что и sheets.js, поэтому index.js может переключаться между ними одной переменной
// окружения (DB_DRIVER=local | sheets), не меняя остальной код.
//
// Данные лежат в server/data/db.json — простой файл, который можно открыть текстом,
// скопировать, удалить (пересоздастся пустым) или руками перенести в Google Sheets
// потом, если решите вернуться к тому варианту.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = {
  USERS: 'Пользователи',
  EXERCISES: 'Упражнения',
  TEMPLATES: 'Шаблоны',
  TEMPLATE_EX: 'Шаблон_Упражнения',
  WORKOUTS: 'Тренировки',
  SETS: 'Подходы',
  PROGRESS: 'Прогресс',
  BODYWEIGHT: 'Вес_Тела',
  NUTRITION_TARGETS: 'КБЖУ_Цель',
  NUTRITION_LOG: 'КБЖУ_Дневник',
};

const TABLES = Object.values(CFG);
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function ensureFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = {};
    TABLES.forEach((t) => { initial[t] = []; });
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

// Синхронное чтение/запись — намеренно: для локального однопользовательского теста
// это проще и надёжнее асинхронных гонок записи, и Node всё равно выполняет их без
// interleaving благодаря блокирующим вызовам fs.*Sync.
function loadDB() {
  ensureFile();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  let data = {};
  try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
  TABLES.forEach((t) => { if (!Array.isArray(data[t])) data[t] = []; });
  return data;
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function id(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}
function now() { return new Date().toISOString(); }
function n(v, fallback) { const x = Number(v); return Number.isFinite(x) ? x : (fallback === undefined ? 0 : fallback); }
function e1rmRaw(weight, reps) {
  if (reps <= 1) return weight;
  const r = Math.min(reps, 36);
  const epley = weight * (1 + reps / 30);
  const brzycki = weight * 36 / (37 - r);
  const lombardi = weight * Math.pow(reps, 0.10);
  const oconner = weight * (1 + 0.025 * reps);
  return (epley + brzycki + lombardi + oconner) / 4;
}
function roundToStep(value, referenceWeight) {
  const step = referenceWeight < 20 ? 1 : (referenceWeight < 60 ? 2.5 : 5);
  return Math.round(value / step) * step;
}
// Для лёгких гантелей (до 15кг) формулы 1ПМ на высоких повторах заметно завышают истинный
// максимум — компенсируем скидкой, растущей с числом повторов сверх 10 (максимум 20%).
function e1rm(weight, reps, exercise) {
  const equip = ((exercise && exercise['Оборудование']) || '').toLowerCase();
  const isLightDumbbell = equip.includes('гантел') && weight > 0 && weight < 15;
  let raw = e1rmRaw(weight, reps);
  if (isLightDumbbell) {
    const discount = Math.min(0.20, Math.max(0, reps - 10) * 0.02);
    raw = raw * (1 - discount);
  }
  return roundToStep(raw, weight);
}

async function ensureSchema() { ensureFile(); }

async function getAppData() {
  const db = loadDB();
  return {
    users: db[CFG.USERS].filter((x) => x['Активен'] !== false),
    exercises: db[CFG.EXERCISES].filter((x) => x['Активно'] !== false),
    templates: db[CFG.TEMPLATES].filter((x) => x['Активен'] !== false),
    templateEx: db[CFG.TEMPLATE_EX],
    workouts: db[CFG.WORKOUTS],
    sets: db[CFG.SETS],
  };
}

async function addUser(payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи имя спортсмена.');
  const db = loadDB();
  db[CFG.USERS].push({
    UserID: id('U'),
    Имя: name,
    Пол: payload.gender || '',
    'Дата рождения': payload.birth || '',
    'Рост, см': payload.height ? n(payload.height) : '',
    'Вес, кг': payload.weight ? n(payload.weight) : '',
    Активен: true,
    TelegramID: String((payload && payload.telegramId) || '').trim(),
  });
  saveDB(db);
  return true;
}

async function linkUserTelegramId(userId, telegramId) {
  if (!userId) throw new Error('Не указан спортсмен.');
  const db = loadDB();
  const u = db[CFG.USERS].find((x) => x.UserID === userId);
  if (!u) throw new Error('Спортсмен не найден.');
  u.TelegramID = String(telegramId || '').trim();
  saveDB(db);
  return true;
}

async function addExercise(payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи название упражнения.');
  const db = loadDB();
  db[CFG.EXERCISES].push({
    ExerciseID: id('E'),
    Название: name,
    Категория: payload.category || '',
    Мышца: payload.muscle || '',
    Оборудование: payload.equipment || '',
    Тип: payload.type || 'Силовое',
    Единица: payload.unit || 'кг',
    Активно: true,
    Описание: payload.description || '',
  });
  saveDB(db);
  return true;
}

async function addTemplate(payload) {
  const name = String((payload && payload.name) || '').trim();
  const userId = String((payload && payload.userId) || '').trim();
  if (!name) throw new Error('Укажи название шаблона.');
  if (!userId) throw new Error('Сначала выбери спортсмена.');
  const db = loadDB();
  if (!db[CFG.USERS].some((u) => u.UserID === userId)) throw new Error('Спортсмен не найден.');
  db[CFG.TEMPLATES].push({
    TemplateID: id('T'),
    Название: name,
    Описание: payload.description || '',
    'Владелец UserID': userId,
    Создан: now(),
    Активен: true,
  });
  saveDB(db);
  return true;
}

async function addTemplateExercises(payloads) {
  if (!payloads || !payloads.length) throw new Error('Нет упражнений для добавления.');
  const db = loadDB();
  const templateId = payloads[0].templateId;
  const current = db[CFG.TEMPLATE_EX].filter((x) => x.TemplateID === templateId);
  let orderOffset = current.length;
  payloads.forEach((p, idx) => {
    if (!p.templateId || !p.exerciseId) throw new Error('Неверные данные.');
    const t = db[CFG.TEMPLATES].find((x) => x.TemplateID === p.templateId);
    if (!t) throw new Error('Шаблон не найден.');
    db[CFG.TEMPLATE_EX].push({
      TemplateExerciseID: id('TE'),
      TemplateID: p.templateId,
      ExerciseID: p.exerciseId,
      Порядок: p.order ? n(p.order) : orderOffset + idx + 1,
      Сеты: Math.max(1, n(p.sets, 3)),
      Повторы: p.reps || '8-12',
      'Отдых, сек': Math.max(0, n(p.rest, 90)),
      Комментарий: p.comment || '',
    });
  });
  saveDB(db);
  return true;
}

async function deleteTemplateExercise(templateExerciseId) {
  const db = loadDB();
  const before = db[CFG.TEMPLATE_EX].length;
  db[CFG.TEMPLATE_EX] = db[CFG.TEMPLATE_EX].filter((x) => String(x.TemplateExerciseID) !== String(templateExerciseId));
  saveDB(db);
  return db[CFG.TEMPLATE_EX].length !== before;
}

async function updateTemplateOrder(templateId, orderData) {
  const db = loadDB();
  (orderData || []).forEach((item) => {
    const row = db[CFG.TEMPLATE_EX].find((x) => String(x.TemplateExerciseID) === String(item.id));
    if (row) row['Порядок'] = Number(item.order);
  });
  saveDB(db);
  return true;
}

async function startWorkout(userId, templateId) {
  if (!userId || !templateId) throw new Error('Не выбран спортсмен или шаблон.');
  const db = loadDB();
  const template = db[CFG.TEMPLATES].find(
    (x) => x.TemplateID === templateId && x['Активен'] !== false && x['Владелец UserID'] === userId
  );
  if (!template) throw new Error('Этот шаблон не принадлежит выбранному спортсмену.');
  const existing = db[CFG.WORKOUTS].find((w) => w.UserID === userId && w['Статус'] === 'В процессе');
  if (existing) return existing.WorkoutID;
  const wId = id('W');
  db[CFG.WORKOUTS].push({
    WorkoutID: wId,
    UserID: userId,
    TemplateID: templateId,
    Дата: now(),
    Название: template['Название'],
    'Длительность, мин': '',
    Заметки: '',
    Статус: 'В процессе',
  });
  saveDB(db);
  return wId;
}

async function planWorkout(userId, templateId, dateStr) {
  if (!userId || !templateId || !dateStr) throw new Error('Не хватает данных для планирования.');
  const db = loadDB();
  const template = db[CFG.TEMPLATES].find(
    (x) => x.TemplateID === templateId && x['Активен'] !== false && x['Владелец UserID'] === userId
  );
  if (!template) throw new Error('Этот шаблон не принадлежит выбранному спортсмену.');
  const isoDate = String(dateStr).length <= 10 ? dateStr + 'T12:00:00.000Z' : dateStr;
  const wId = id('W');
  db[CFG.WORKOUTS].push({
    WorkoutID: wId,
    UserID: userId,
    TemplateID: templateId,
    Дата: isoDate,
    Название: template['Название'],
    'Длительность, мин': '',
    Заметки: '',
    Статус: 'Запланирована',
  });
  saveDB(db);
  return wId;
}

async function startPlannedWorkout(workoutId) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const db = loadDB();
  const w = db[CFG.WORKOUTS].find((x) => x.WorkoutID === workoutId);
  if (!w) throw new Error('Тренировка не найдена.');
  if (w['Статус'] !== 'Запланирована') throw new Error('Эта тренировка уже не в статусе "Запланирована".');
  const active = db[CFG.WORKOUTS].find((x) => x.UserID === w.UserID && x['Статус'] === 'В процессе');
  if (active) throw new Error('У этого спортсмена уже есть незавершённая тренировка — сначала заверши её.');
  w['Статус'] = 'В процессе';
  w['Дата'] = now();
  saveDB(db);
  return workoutId;
}

async function saveAllSets(workoutId, setsArray) {
  if (!workoutId || !setsArray || !setsArray.length) throw new Error('Нет данных для сохранения');
  const db = loadDB();
  const workout = db[CFG.WORKOUTS].find((w) => w.WorkoutID === workoutId);
  if (!workout) throw new Error('Тренировка не найдена');
  const exMap = {};
  db[CFG.EXERCISES].forEach((e) => { exMap[e.ExerciseID] = e; });

  setsArray.forEach((s) => {
    const weight = n(s.weight, 0);
    const reps = n(s.reps, 0);
    if (weight <= 0 || reps <= 0) return;
    db[CFG.SETS].push({
      SetID: id('S'),
      WorkoutID: workoutId,
      ExerciseID: s.exerciseId,
      'Номер подхода': s.setNo || 1,
      'Вес, кг': weight,
      Повторы: reps,
      RPE: s.rpe || '',
      'Подход до отказа': false,
      'e1RM, кг': e1rm(weight, reps, exMap[s.exerciseId]),
      'Дата/время': now(),
      Комментарий: s.comment || '',
    });
  });

  const exerciseIds = [...new Set(setsArray.map((s) => s.exerciseId))];
  exerciseIds.forEach((exId) => upsertProgress(db, workoutId, exId));

  saveDB(db);
  return true;
}

function upsertProgress(db, workoutId, exerciseId) {
  const w = db[CFG.WORKOUTS].find((x) => x.WorkoutID === workoutId);
  if (!w) return;
  const u = db[CFG.USERS].find((x) => x.UserID === w.UserID);
  const e = db[CFG.EXERCISES].find((x) => x.ExerciseID === exerciseId);
  const relevant = db[CFG.SETS].filter((x) => x.WorkoutID === workoutId && x.ExerciseID === exerciseId);
  const best = Math.max(0, ...relevant.map((x) => n(x['e1RM, кг'], 0)));
  const out = {
    Дата: w['Дата'] || now(),
    UserID: w.UserID,
    Имя: u ? u['Имя'] : '',
    ExerciseID: exerciseId,
    Упражнение: e ? e['Название'] : '',
    'Лучший e1RM, кг': best,
    WorkoutID: workoutId,
  };
  const idx = db[CFG.PROGRESS].findIndex((x) => x.WorkoutID === workoutId && x.ExerciseID === exerciseId);
  if (idx >= 0) db[CFG.PROGRESS][idx] = out;
  else db[CFG.PROGRESS].push(out);
}

async function finishWorkout(workoutId, note, durationSeconds) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const db = loadDB();
  const w = db[CFG.WORKOUTS].find((x) => x.WorkoutID === workoutId);
  if (!w) throw new Error('Тренировка не найдена.');
  let sec = n(durationSeconds, 0);
  if (!sec && w['Дата']) {
    const parsed = new Date(w['Дата']);
    if (!isNaN(parsed)) sec = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  }
  w['Длительность, мин'] = Math.max(1, Math.round(sec / 60));
  w['Заметки'] = note || '';
  w['Статус'] = 'Завершена';
  saveDB(db);
  createBackup('finishWorkout').catch(() => {});
  return true;
}

async function deleteWorkout(workoutId) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  await createBackup('deleteWorkout').catch(() => {});
  const db = loadDB();
  const before = db[CFG.WORKOUTS].length;
  db[CFG.WORKOUTS] = db[CFG.WORKOUTS].filter((w) => String(w.WorkoutID) !== String(workoutId));
  if (db[CFG.WORKOUTS].length === before) throw new Error('Тренировка не найдена.');
  saveDB(db);
  return true;
}

async function getProgress(userId, exerciseId) {
  const db = loadDB();
  return db[CFG.PROGRESS]
    .filter((x) => (!userId || x.UserID === userId) && (!exerciseId || x.ExerciseID === exerciseId))
    .sort((a, b) => new Date(a['Дата']).getTime() - new Date(b['Дата']).getTime());
}

async function deleteUser(userId) {
  if (!userId) throw new Error('Не указан спортсмен.');
  const db = loadDB();
  const u = db[CFG.USERS].find((x) => x.UserID === userId);
  if (!u) throw new Error('Спортсмен не найден.');
  u['Активен'] = false;
  saveDB(db);
  return true;
}

// --- Резервные копии (локальный режим) ---
// Снимки складываются как отдельные JSON-файлы в server/data/backups/ — на вашем ПК это
// просто ещё папка с файлами, можно копировать/архивировать вручную когда захочется.
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 20;

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

async function createBackup(reason) {
  ensureBackupsDir();
  const db = loadDB();
  const backupId = 'B' + Date.now();
  const payload = { id: backupId, createdAt: now(), reason: reason || 'manual', data: db };
  fs.writeFileSync(path.join(BACKUPS_DIR, backupId + '.json'), JSON.stringify(payload, null, 2), 'utf8');
  const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  files.slice(MAX_BACKUPS).forEach((f) => fs.unlinkSync(path.join(BACKUPS_DIR, f)));
  return backupId;
}

async function listBackups() {
  ensureBackupsDir();
  const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  return files.map((f) => {
    const payload = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, f), 'utf8'));
    return { id: payload.id, CreatedAt: payload.createdAt, Reason: payload.reason };
  });
}

async function getBackup(backupId) {
  ensureBackupsDir();
  const file = path.join(BACKUPS_DIR, backupId + '.json');
  if (!fs.existsSync(file)) throw new Error('Резервная копия не найдена.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function logBodyWeight(userId, dateStr, weight) {
  if (!userId || !dateStr) throw new Error('Не хватает данных.');
  const w = n(weight, 0);
  if (w <= 0) throw new Error('Укажи вес больше нуля.');
  const db = loadDB();
  const recId = userId + '_' + dateStr;
  const existing = db[CFG.BODYWEIGHT].find((r) => r.id === recId);
  if (existing) existing['Вес, кг'] = w;
  else db[CFG.BODYWEIGHT].push({ id: recId, UserID: userId, Дата: dateStr, 'Вес, кг': w });
  saveDB(db);
  return true;
}
async function getBodyWeightLog(userId) {
  const db = loadDB();
  return db[CFG.BODYWEIGHT]
    .filter((r) => r.UserID === userId)
    .sort((a, b) => new Date(a['Дата']) - new Date(b['Дата']));
}

async function setNutritionTarget(userId, target) {
  if (!userId) throw new Error('Не указан спортсмен.');
  const db = loadDB();
  const rec = {
    UserID: userId,
    Калории: n(target.calories, 0),
    'Белки, г': n(target.protein, 0),
    'Жиры, г': n(target.fat, 0),
    'Углеводы, г': n(target.carbs, 0),
  };
  const idx = db[CFG.NUTRITION_TARGETS].findIndex((r) => r.UserID === userId);
  if (idx >= 0) db[CFG.NUTRITION_TARGETS][idx] = rec;
  else db[CFG.NUTRITION_TARGETS].push(rec);
  saveDB(db);
  return true;
}
async function getNutritionTarget(userId) {
  const db = loadDB();
  return db[CFG.NUTRITION_TARGETS].find((r) => r.UserID === userId) || null;
}
async function logNutrition(userId, dateStr, values) {
  if (!userId || !dateStr) throw new Error('Не хватает данных.');
  const db = loadDB();
  const recId = userId + '_' + dateStr;
  const rec = {
    id: recId,
    UserID: userId,
    Дата: dateStr,
    Калории: n(values.calories, 0),
    'Белки, г': n(values.protein, 0),
    'Жиры, г': n(values.fat, 0),
    'Углеводы, г': n(values.carbs, 0),
  };
  const idx = db[CFG.NUTRITION_LOG].findIndex((r) => r.id === recId);
  if (idx >= 0) db[CFG.NUTRITION_LOG][idx] = rec;
  else db[CFG.NUTRITION_LOG].push(rec);
  saveDB(db);
  return true;
}
async function getNutritionLog(userId) {
  const db = loadDB();
  return db[CFG.NUTRITION_LOG]
    .filter((r) => r.UserID === userId)
    .sort((a, b) => new Date(a['Дата']) - new Date(b['Дата']));
}

module.exports = {
  CFG,
  ensureSchema,
  getAppData,
  addUser,
  addExercise,
  addTemplate,
  addTemplateExercises,
  deleteTemplateExercise,
  updateTemplateOrder,
  startWorkout,
  planWorkout,
  startPlannedWorkout,
  saveAllSets,
  finishWorkout,
  deleteWorkout,
  getProgress,
  deleteUser,
  linkUserTelegramId,
  createBackup,
  listBackups,
  getBackup,
  logBodyWeight,
  getBodyWeightLog,
  setNutritionTarget,
  getNutritionTarget,
  logNutrition,
  getNutritionLog,
};
