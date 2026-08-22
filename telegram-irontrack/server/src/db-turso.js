// Хранилище на Turso (облачный SQLite, есть бесплатный тариф — https://turso.tech).
// Быстрее и надёжнее для реального хостинга, чем локальный JSON-файл (данные не привязаны
// к диску конкретного сервера и не пропадают при передеплое) и чем Google Sheets (обычная
// SQL-база, без задержек Sheets API). Экспортирует те же функции с теми же сигнатурами,
// что db-local.js и sheets.js — переключение через DB_DRIVER=turso в .env.

const { createClient } = require('@libsql/client');

let clientInstance = null;
function client() {
  if (clientInstance) return clientInstance;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error('Не задан TURSO_DATABASE_URL в .env');
  clientInstance = createClient({ url, authToken });
  return clientInstance;
}

function id(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}
const crypto = require('crypto');
function now() { return new Date().toISOString(); }
function n(v, fallback) { const x = Number(v); return Number.isFinite(x) ? x : (fallback === undefined ? 0 : fallback); }
// Оценка 1ПМ — среднее сразу нескольких признанных формул вместо одной, чтобы сгладить
// погрешность каждой отдельной формулы на разных диапазонах повторов. Результат округляется
// до ближайших 2.5 кг (стандартный шаг блинов).
function e1rm(weight, reps) {
  if (reps <= 1) return weight;
  const r = Math.min(reps, 36); // Brzycki не определена при reps>=37, подстраховка
  const epley = weight * (1 + reps / 30);
  const brzycki = weight * 36 / (37 - r);
  const lombardi = weight * Math.pow(reps, 0.10);
  const oconner = weight * (1 + 0.025 * reps);
  const avg = (epley + brzycki + lombardi + oconner) / 4;
  return Math.round(avg / 2.5) * 2.5;
}
function bool(v) { return v ? 1 : 0; }
function fromBool(v) { return v === 1 || v === true; }

const TABLES = {
  users: `CREATE TABLE IF NOT EXISTS users (
    "UserID" TEXT PRIMARY KEY,
    "Имя" TEXT,
    "Пол" TEXT,
    "Дата рождения" TEXT,
    "Рост, см" REAL,
    "Вес, кг" REAL,
    "Активен" INTEGER DEFAULT 1
  )`,
  exercises: `CREATE TABLE IF NOT EXISTS exercises (
    "ExerciseID" TEXT PRIMARY KEY,
    "Название" TEXT,
    "Категория" TEXT,
    "Мышца" TEXT,
    "Оборудование" TEXT,
    "Тип" TEXT,
    "Единица" TEXT,
    "Активно" INTEGER DEFAULT 1,
    "Описание" TEXT
  )`,
  templates: `CREATE TABLE IF NOT EXISTS templates (
    "TemplateID" TEXT PRIMARY KEY,
    "Название" TEXT,
    "Описание" TEXT,
    "Владелец UserID" TEXT,
    "Создан" TEXT,
    "Активен" INTEGER DEFAULT 1
  )`,
  template_ex: `CREATE TABLE IF NOT EXISTS template_ex (
    "TemplateExerciseID" TEXT PRIMARY KEY,
    "TemplateID" TEXT,
    "ExerciseID" TEXT,
    "Порядок" INTEGER,
    "Сеты" INTEGER,
    "Повторы" TEXT,
    "Отдых, сек" INTEGER,
    "Комментарий" TEXT
  )`,
  workouts: `CREATE TABLE IF NOT EXISTS workouts (
    "WorkoutID" TEXT PRIMARY KEY,
    "UserID" TEXT,
    "TemplateID" TEXT,
    "Дата" TEXT,
    "Название" TEXT,
    "Длительность, мин" INTEGER,
    "Заметки" TEXT,
    "Статус" TEXT
  )`,
  sets: `CREATE TABLE IF NOT EXISTS sets (
    "SetID" TEXT PRIMARY KEY,
    "WorkoutID" TEXT,
    "ExerciseID" TEXT,
    "Номер подхода" INTEGER,
    "Вес, кг" REAL,
    "Повторы" INTEGER,
    "RPE" REAL,
    "Подход до отказа" INTEGER DEFAULT 0,
    "e1RM, кг" REAL,
    "Дата/время" TEXT,
    "Комментарий" TEXT
  )`,
  progress: `CREATE TABLE IF NOT EXISTS progress (
    "id" TEXT PRIMARY KEY,
    "Дата" TEXT,
    "UserID" TEXT,
    "Имя" TEXT,
    "ExerciseID" TEXT,
    "Упражнение" TEXT,
    "Лучший e1RM, кг" REAL,
    "WorkoutID" TEXT
  )`,
  backups: `CREATE TABLE IF NOT EXISTS backups (
    "id" TEXT PRIMARY KEY,
    "CreatedAt" TEXT,
    "Reason" TEXT,
    "Data" TEXT
  )`,
};

async function ensureSchema() {
  const c = client();
  for (const sql of Object.values(TABLES)) {
    await c.execute(sql);
  }
}

async function all(sql, args) {
  const res = await client().execute({ sql, args: args || [] });
  return res.rows.map((row) => {
    const obj = {};
    res.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

async function run(sql, args) {
  return client().execute({ sql, args: args || [] });
}

async function getAppData() {
  const [users, exercises, templates, templateEx, workouts, sets] = await Promise.all([
    all('SELECT * FROM users'),
    all('SELECT * FROM exercises'),
    all('SELECT * FROM templates'),
    all('SELECT * FROM template_ex'),
    all('SELECT * FROM workouts'),
    all('SELECT * FROM sets'),
  ]);
  users.forEach((u) => { u['Активен'] = fromBool(u['Активен']); });
  exercises.forEach((e) => { e['Активно'] = fromBool(e['Активно']); });
  templates.forEach((t) => { t['Активен'] = fromBool(t['Активен']); });
  sets.forEach((s) => { s['Подход до отказа'] = fromBool(s['Подход до отказа']); });
  return {
    users: users.filter((x) => x['Активен'] !== false),
    exercises: exercises.filter((x) => x['Активно'] !== false),
    templates: templates.filter((x) => x['Активен'] !== false),
    templateEx,
    workouts,
    sets,
  };
}

async function addUser(payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи имя спортсмена.');
  await run(
    `INSERT INTO users ("UserID","Имя","Пол","Дата рождения","Рост, см","Вес, кг","Активен") VALUES (?,?,?,?,?,?,1)`,
    [id('U'), name, payload.gender || '', payload.birth || '', payload.height ? n(payload.height) : null, payload.weight ? n(payload.weight) : null]
  );
  return true;
}

async function addExercise(payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи название упражнения.');
  await run(
    `INSERT INTO exercises ("ExerciseID","Название","Категория","Мышца","Оборудование","Тип","Единица","Активно","Описание") VALUES (?,?,?,?,?,?,?,1,?)`,
    [id('E'), name, payload.category || '', payload.muscle || '', payload.equipment || '', payload.type || 'Силовое', payload.unit || 'кг', payload.description || '']
  );
  return true;
}

async function addTemplate(payload) {
  const name = String((payload && payload.name) || '').trim();
  const userId = String((payload && payload.userId) || '').trim();
  if (!name) throw new Error('Укажи название шаблона.');
  if (!userId) throw new Error('Сначала выбери спортсмена.');
  const existing = await all('SELECT "UserID" FROM users WHERE "UserID" = ?', [userId]);
  if (!existing.length) throw new Error('Спортсмен не найден.');
  await run(
    `INSERT INTO templates ("TemplateID","Название","Описание","Владелец UserID","Создан","Активен") VALUES (?,?,?,?,?,1)`,
    [id('T'), name, payload.description || '', userId, now()]
  );
  return true;
}

async function addTemplateExercises(payloads) {
  if (!payloads || !payloads.length) throw new Error('Нет упражнений для добавления.');
  const templateId = payloads[0].templateId;
  const countRows = await all('SELECT COUNT(*) as cnt FROM template_ex WHERE "TemplateID" = ?', [templateId]);
  let orderOffset = countRows[0] ? Number(countRows[0].cnt) : 0;
  for (let idx = 0; idx < payloads.length; idx++) {
    const p = payloads[idx];
    if (!p.templateId || !p.exerciseId) throw new Error('Неверные данные.');
    const t = await all('SELECT "TemplateID" FROM templates WHERE "TemplateID" = ?', [p.templateId]);
    if (!t.length) throw new Error('Шаблон не найден.');
    await run(
      `INSERT INTO template_ex ("TemplateExerciseID","TemplateID","ExerciseID","Порядок","Сеты","Повторы","Отдых, сек","Комментарий") VALUES (?,?,?,?,?,?,?,?)`,
      [id('TE'), p.templateId, p.exerciseId, p.order ? n(p.order) : orderOffset + idx + 1, Math.max(1, n(p.sets, 3)), p.reps || '8-12', Math.max(0, n(p.rest, 90)), p.comment || '']
    );
  }
  return true;
}

async function deleteTemplateExercise(templateExerciseId) {
  const res = await run('DELETE FROM template_ex WHERE "TemplateExerciseID" = ?', [templateExerciseId]);
  return (res.rowsAffected || 0) > 0;
}

async function updateTemplateOrder(templateId, orderData) {
  for (const item of orderData || []) {
    await run('UPDATE template_ex SET "Порядок" = ? WHERE "TemplateExerciseID" = ?', [Number(item.order), item.id]);
  }
  return true;
}

async function startWorkout(userId, templateId) {
  if (!userId || !templateId) throw new Error('Не выбран спортсмен или шаблон.');
  const templates = await all(
    'SELECT * FROM templates WHERE "TemplateID" = ? AND "Активен" = 1 AND "Владелец UserID" = ?',
    [templateId, userId]
  );
  if (!templates.length) throw new Error('Этот шаблон не принадлежит выбранному спортсмену.');
  const existing = await all('SELECT "WorkoutID" FROM workouts WHERE "UserID" = ? AND "Статус" = ?', [userId, 'В процессе']);
  if (existing.length) return existing[0].WorkoutID;
  const wId = id('W');
  await run(
    `INSERT INTO workouts ("WorkoutID","UserID","TemplateID","Дата","Название","Длительность, мин","Заметки","Статус") VALUES (?,?,?,?,?,?,?,?)`,
    [wId, userId, templateId, now(), templates[0]['Название'], null, '', 'В процессе']
  );
  return wId;
}

// Планирование тренировки на будущую (или любую) дату по шаблону — отдельная запись со
// статусом "Запланирована", которая позже либо "запускается" (превращается в обычную
// активную тренировку), либо отменяется (обычным удалением).
async function planWorkout(userId, templateId, dateStr) {
  if (!userId || !templateId || !dateStr) throw new Error('Не хватает данных для планирования.');
  const templates = await all(
    'SELECT * FROM templates WHERE "TemplateID" = ? AND "Активен" = 1 AND "Владелец UserID" = ?',
    [templateId, userId]
  );
  if (!templates.length) throw new Error('Этот шаблон не принадлежит выбранному спортсмену.');
  const isoDate = String(dateStr).length <= 10 ? dateStr + 'T12:00:00.000Z' : dateStr;
  const wId = id('W');
  await run(
    `INSERT INTO workouts ("WorkoutID","UserID","TemplateID","Дата","Название","Длительность, мин","Заметки","Статус") VALUES (?,?,?,?,?,?,?,?)`,
    [wId, userId, templateId, isoDate, templates[0]['Название'], null, '', 'Запланирована']
  );
  return wId;
}

async function startPlannedWorkout(workoutId) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const rows = await all('SELECT * FROM workouts WHERE "WorkoutID" = ?', [workoutId]);
  if (!rows.length) throw new Error('Тренировка не найдена.');
  const w = rows[0];
  if (w['Статус'] !== 'Запланирована') throw new Error('Эта тренировка уже не в статусе "Запланирована".');
  const active = await all('SELECT "WorkoutID" FROM workouts WHERE "UserID" = ? AND "Статус" = ?', [w.UserID, 'В процессе']);
  if (active.length) throw new Error('У этого спортсмена уже есть незавершённая тренировка — сначала заверши её.');
  await run('UPDATE workouts SET "Статус" = ?, "Дата" = ? WHERE "WorkoutID" = ?', ['В процессе', now(), workoutId]);
  return workoutId;
}

async function saveAllSets(workoutId, setsArray) {
  if (!workoutId || !setsArray || !setsArray.length) throw new Error('Нет данных для сохранения');
  const workouts = await all('SELECT * FROM workouts WHERE "WorkoutID" = ?', [workoutId]);
  if (!workouts.length) throw new Error('Тренировка не найдена');

  for (const s of setsArray) {
    const weight = n(s.weight, 0);
    const reps = n(s.reps, 0);
    if (weight <= 0 || reps <= 0) continue;
    await run(
      `INSERT INTO sets ("SetID","WorkoutID","ExerciseID","Номер подхода","Вес, кг","Повторы","RPE","Подход до отказа","e1RM, кг","Дата/время","Комментарий") VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      [id('S'), workoutId, s.exerciseId, s.setNo || 1, weight, reps, s.rpe || null, e1rm(weight, reps), now(), s.comment || '']
    );
  }

  const exerciseIds = [...new Set(setsArray.map((s) => s.exerciseId))];
  for (const exId of exerciseIds) {
    await upsertProgress(workoutId, exId);
  }
  return true;
}

async function upsertProgress(workoutId, exerciseId) {
  const workouts = await all('SELECT * FROM workouts WHERE "WorkoutID" = ?', [workoutId]);
  const w = workouts[0];
  if (!w) return;
  const users = await all('SELECT * FROM users WHERE "UserID" = ?', [w.UserID]);
  const exercises = await all('SELECT * FROM exercises WHERE "ExerciseID" = ?', [exerciseId]);
  const relevant = await all('SELECT "e1RM, кг" as e1rm FROM sets WHERE "WorkoutID" = ? AND "ExerciseID" = ?', [workoutId, exerciseId]);
  const best = Math.max(0, ...relevant.map((x) => n(x.e1rm, 0)));

  const u = users[0];
  const e = exercises[0];
  await run(
    `INSERT INTO progress ("id","Дата","UserID","Имя","ExerciseID","Упражнение","Лучший e1RM, кг","WorkoutID")
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT("id") DO UPDATE SET "Дата"=excluded."Дата", "Лучший e1RM, кг"=excluded."Лучший e1RM, кг"`,
    [workoutId + '_' + exerciseId, w['Дата'] || now(), w.UserID, u ? u['Имя'] : '', exerciseId, e ? e['Название'] : '', best, workoutId]
  );
}

async function finishWorkout(workoutId, note, durationSeconds) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const workouts = await all('SELECT * FROM workouts WHERE "WorkoutID" = ?', [workoutId]);
  const w = workouts[0];
  if (!w) throw new Error('Тренировка не найдена.');
  let sec = n(durationSeconds, 0);
  if (!sec && w['Дата']) {
    const parsed = new Date(w['Дата']);
    if (!isNaN(parsed)) sec = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  }
  await run('UPDATE workouts SET "Длительность, мин" = ?, "Заметки" = ?, "Статус" = ? WHERE "WorkoutID" = ?', [
    Math.max(1, Math.round(sec / 60)),
    note || '',
    'Завершена',
    workoutId,
  ]);
  createBackup('finishWorkout').catch(() => {});
  return true;
}

async function deleteWorkout(workoutId) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  await createBackup('deleteWorkout').catch(() => {});
  const res = await run('DELETE FROM workouts WHERE "WorkoutID" = ?', [workoutId]);
  if (!(res.rowsAffected > 0)) throw new Error('Тренировка не найдена.');
  return true;
}

async function getProgress(userId, exerciseId) {
  let sql = 'SELECT * FROM progress WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND "UserID" = ?'; args.push(userId); }
  if (exerciseId) { sql += ' AND "ExerciseID" = ?'; args.push(exerciseId); }
  const rows = await all(sql, args);
  return rows.sort((a, b) => new Date(a['Дата']).getTime() - new Date(b['Дата']).getTime());
}

async function deleteUser(userId) {
  if (!userId) throw new Error('Не указан спортсмен.');
  const res = await run('UPDATE users SET "Активен" = 0 WHERE "UserID" = ?', [userId]);
  if (!(res.rowsAffected > 0)) throw new Error('Спортсмен не найден.');
  return true;
}

// --- Резервные копии ---
// Полный снимок всех таблиц кладём в саму базу (табличка backups), храним последние
// MAX_BACKUPS штук. Это не отдельный сервис и не файл на диске сервера (который на Render
// эфемерный) — снимок живёт в той же Turso-базе, что и сами данные, но отдельной строкой,
// так что случайное удаление/порчу основных таблиц можно откатить вручную по данным снимка.
const BACKUP_TABLES = ['users', 'exercises', 'templates', 'template_ex', 'workouts', 'sets', 'progress'];

async function createBackup(reason) {
  const dump = {};
  for (const t of BACKUP_TABLES) {
    dump[t] = await all(`SELECT * FROM ${t}`);
  }
  const backupId = 'B' + Date.now();
  await run('INSERT INTO backups ("id","CreatedAt","Reason","Data") VALUES (?,?,?,?)', [
    backupId,
    now(),
    reason || 'manual',
    JSON.stringify(dump),
  ]);
  // Держим только последние MAX_BACKUPS штук, чтобы база не пухла бесконечно
  const ids = await all('SELECT "id" FROM backups ORDER BY "CreatedAt" DESC');
  const toDelete = ids.slice(MAX_BACKUPS).map((r) => r.id);
  for (const oldId of toDelete) {
    await run('DELETE FROM backups WHERE "id" = ?', [oldId]);
  }
  return backupId;
}

async function listBackups() {
  const rows = await all('SELECT "id","CreatedAt","Reason" FROM backups ORDER BY "CreatedAt" DESC');
  return rows;
}

async function getBackup(backupId) {
  const rows = await all('SELECT * FROM backups WHERE "id" = ?', [backupId]);
  if (!rows.length) throw new Error('Резервная копия не найдена.');
  return { id: rows[0].id, createdAt: rows[0].CreatedAt, reason: rows[0].Reason, data: JSON.parse(rows[0].Data) };
}

module.exports = {
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
  createBackup,
  listBackups,
  getBackup,
};
