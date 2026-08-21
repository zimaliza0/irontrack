// Этот файл — прямой аналог функций из Code.gs, но работающий через Google Sheets API
// (googleapis / google-spreadsheet) вместо встроенного рантайма Apps Script.
// Названия листов, колонок и большая часть бизнес-логики (расчёт e1RM, апдейт прогресса
// и т.д.) намеренно оставлены такими же, как в оригинале, чтобы таблица осталась совместимой.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const CFG = {
  USERS: 'Пользователи',
  EXERCISES: 'Упражнения',
  TEMPLATES: 'Шаблоны',
  TEMPLATE_EX: 'Шаблон_Упражнения',
  WORKOUTS: 'Тренировки',
  SETS: 'Подходы',
  PROGRESS: 'Прогресс',
};

const HEADERS = {
  [CFG.USERS]: ['UserID', 'Имя', 'Пол', 'Дата рождения', 'Рост, см', 'Вес, кг', 'Активен'],
  [CFG.EXERCISES]: ['ExerciseID', 'Название', 'Категория', 'Мышца', 'Оборудование', 'Тип', 'Единица', 'Активно', 'Описание'],
  [CFG.TEMPLATES]: ['TemplateID', 'Название', 'Описание', 'Владелец UserID', 'Создан', 'Активен'],
  [CFG.TEMPLATE_EX]: ['TemplateExerciseID', 'TemplateID', 'ExerciseID', 'Порядок', 'Сеты', 'Повторы', 'Отдых, сек', 'Комментарий'],
  [CFG.WORKOUTS]: ['WorkoutID', 'UserID', 'TemplateID', 'Дата', 'Название', 'Длительность, мин', 'Заметки', 'Статус'],
  [CFG.SETS]: ['SetID', 'WorkoutID', 'ExerciseID', 'Номер подхода', 'Вес, кг', 'Повторы', 'RPE', 'Подход до отказа', 'e1RM, кг', 'Дата/время', 'Комментарий'],
  [CFG.PROGRESS]: ['Дата', 'UserID', 'Имя', 'ExerciseID', 'Упражнение', 'Лучший e1RM, кг', 'WorkoutID'],
};

let docPromise = null;

function getDoc() {
  if (docPromise) return docPromise;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!email || !key || !sheetId) {
    throw new Error('Не заданы GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_SHEET_ID в .env');
  }
  const auth = new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, auth);
  docPromise = doc.loadInfo().then(() => doc);
  return docPromise;
}

async function ensureSchema() {
  const doc = await getDoc();
  for (const name of Object.keys(HEADERS)) {
    let sheet = doc.sheetsByTitle[name];
    if (!sheet) {
      sheet = await doc.addSheet({ title: name, headerValues: HEADERS[name] });
      continue;
    }
    await sheet.loadHeaderRow().catch(() => {});
    const current = sheet.headerValues || [];
    const missing = HEADERS[name].filter((h) => current.indexOf(h) === -1);
    if (missing.length) {
      await sheet.setHeaderRow([...current, ...missing]);
    }
  }
}

async function sheet(name) {
  const doc = await getDoc();
  const sh = doc.sheetsByTitle[name];
  if (!sh) throw new Error('Не найден лист: ' + name);
  return sh;
}

function serialize(v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}

// Аналог rows_(name) из Code.gs — возвращает массив обычных объектов по заголовкам колонок.
async function rows(name) {
  const sh = await sheet(name);
  const gsRows = await sh.getRows();
  const headers = sh.headerValues || [];
  return gsRows.map((r) => {
    const obj = {};
    headers.forEach((h) => {
      if (!h) return;
      const raw = r.get(h);
      obj[h] = serialize(raw === undefined ? '' : raw);
    });
    return obj;
  });
}

async function appendObject(sheetName, obj) {
  const sh = await sheet(sheetName);
  await sh.addRow(obj, { raw: true });
}

function id(prefix) {
  const rnd = () => Math.random().toString(36).slice(2, 12).toUpperCase();
  return prefix + rnd().slice(0, 10);
}

function now() {
  return new Date();
}

function n(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : (fallback === undefined ? 0 : fallback);
}

function e1rm(weight, reps) {
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

// ---- Публичные функции, повторяющие сигнатуры Code.gs ----

async function getAppData() {
  await ensureSchema();
  const [users, exercises, templates, templateEx, workouts, sets] = await Promise.all([
    rows(CFG.USERS),
    rows(CFG.EXERCISES),
    rows(CFG.TEMPLATES),
    rows(CFG.TEMPLATE_EX),
    rows(CFG.WORKOUTS),
    rows(CFG.SETS),
  ]);
  return {
    users: users.filter((x) => x['Активен'] !== false && x['Активен'] !== 'FALSE'),
    exercises: exercises.filter((x) => x['Активно'] !== false && x['Активно'] !== 'FALSE'),
    templates: templates.filter((x) => x['Активен'] !== false && x['Активен'] !== 'FALSE'),
    templateEx,
    workouts,
    sets,
  };
}

async function addUser(payload) {
  await ensureSchema();
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи имя спортсмена.');
  await appendObject(CFG.USERS, {
    UserID: id('U'),
    Имя: name,
    Пол: payload.gender || '',
    'Дата рождения': payload.birth || '',
    'Рост, см': payload.height ? n(payload.height) : '',
    'Вес, кг': payload.weight ? n(payload.weight) : '',
    Активен: true,
  });
  return true;
}

async function addExercise(payload) {
  await ensureSchema();
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new Error('Укажи название упражнения.');
  await appendObject(CFG.EXERCISES, {
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
  return true;
}

async function addTemplate(payload) {
  await ensureSchema();
  const name = String((payload && payload.name) || '').trim();
  const userId = String((payload && payload.userId) || '').trim();
  if (!name) throw new Error('Укажи название шаблона.');
  if (!userId) throw new Error('Сначала выбери спортсмена.');
  const users = await rows(CFG.USERS);
  if (!users.some((u) => u.UserID === userId)) throw new Error('Спортсмен не найден.');
  await appendObject(CFG.TEMPLATES, {
    TemplateID: id('T'),
    Название: name,
    Описание: payload.description || '',
    'Владелец UserID': userId,
    Создан: now().toISOString(),
    Активен: true,
  });
  return true;
}

async function addTemplateExercises(payloads) {
  await ensureSchema();
  if (!payloads || !payloads.length) throw new Error('Нет упражнений для добавления.');
  const templateId = payloads[0].templateId;
  const templates = await rows(CFG.TEMPLATES);
  const current = (await rows(CFG.TEMPLATE_EX)).filter((x) => x.TemplateID === templateId);
  let orderOffset = current.length;
  for (let idx = 0; idx < payloads.length; idx++) {
    const p = payloads[idx];
    if (!p.templateId || !p.exerciseId) throw new Error('Неверные данные.');
    const t = templates.find((x) => x.TemplateID === p.templateId);
    if (!t) throw new Error('Шаблон не найден.');
    await appendObject(CFG.TEMPLATE_EX, {
      TemplateExerciseID: id('TE'),
      TemplateID: p.templateId,
      ExerciseID: p.exerciseId,
      Порядок: p.order ? n(p.order) : orderOffset + idx + 1,
      Сеты: Math.max(1, n(p.sets, 3)),
      Повторы: p.reps || '8-12',
      'Отдых, сек': Math.max(0, n(p.rest, 90)),
      Комментарий: p.comment || '',
    });
  }
  return true;
}

async function deleteTemplateExercise(templateExerciseId) {
  const sh = await sheet(CFG.TEMPLATE_EX);
  const gsRows = await sh.getRows();
  const row = gsRows.find((r) => String(r.get('TemplateExerciseID')) === String(templateExerciseId));
  if (!row) return false;
  await row.delete();
  return true;
}

async function updateTemplateOrder(templateId, orderData) {
  await ensureSchema();
  const sh = await sheet(CFG.TEMPLATE_EX);
  const gsRows = await sh.getRows();
  for (const item of orderData || []) {
    const row = gsRows.find((r) => String(r.get('TemplateExerciseID')) === String(item.id));
    if (row) {
      row.set('Порядок', Number(item.order));
      await row.save();
    }
  }
  return true;
}

async function startWorkout(userId, templateId) {
  await ensureSchema();
  if (!userId || !templateId) throw new Error('Не выбран спортсмен или шаблон.');
  const templates = await rows(CFG.TEMPLATES);
  const template = templates.find(
    (x) => x.TemplateID === templateId && x['Активен'] !== false && x['Владелец UserID'] === userId
  );
  if (!template) throw new Error('Этот шаблон не принадлежит выбранному спортсмену.');
  const workouts = await rows(CFG.WORKOUTS);
  const existing = workouts.find((w) => w.UserID === userId && w['Статус'] === 'В процессе');
  if (existing) return existing.WorkoutID;
  const wId = id('W');
  await appendObject(CFG.WORKOUTS, {
    WorkoutID: wId,
    UserID: userId,
    TemplateID: templateId,
    Дата: now().toISOString(),
    Название: template['Название'],
    'Длительность, мин': '',
    Заметки: '',
    Статус: 'В процессе',
  });
  return wId;
}

async function saveAllSets(workoutId, setsArray) {
  await ensureSchema();
  if (!workoutId || !setsArray || !setsArray.length) throw new Error('Нет данных для сохранения');
  const workouts = await rows(CFG.WORKOUTS);
  const workout = workouts.find((w) => w.WorkoutID === workoutId);
  if (!workout) throw new Error('Тренировка не найдена');

  for (const s of setsArray) {
    const weight = n(s.weight, 0);
    const reps = n(s.reps, 0);
    if (weight <= 0 || reps <= 0) continue;
    await appendObject(CFG.SETS, {
      SetID: id('S'),
      WorkoutID: workoutId,
      ExerciseID: s.exerciseId,
      'Номер подхода': s.setNo || 1,
      'Вес, кг': weight,
      Повторы: reps,
      RPE: s.rpe || '',
      'Подход до отказа': false,
      'e1RM, кг': e1rm(weight, reps),
      'Дата/время': now().toISOString(),
      Комментарий: s.comment || '',
    });
  }

  const exerciseIds = [...new Set(setsArray.map((s) => s.exerciseId))];
  for (const exId of exerciseIds) {
    await upsertProgress(workoutId, exId);
  }
  return true;
}

async function upsertProgress(workoutId, exerciseId) {
  const [workouts, sets, users, exercises] = await Promise.all([
    rows(CFG.WORKOUTS),
    rows(CFG.SETS),
    rows(CFG.USERS),
    rows(CFG.EXERCISES),
  ]);
  const w = workouts.find((x) => x.WorkoutID === workoutId);
  if (!w) return;
  const u = users.find((x) => x.UserID === w.UserID);
  const e = exercises.find((x) => x.ExerciseID === exerciseId);
  const relevant = sets.filter((x) => x.WorkoutID === workoutId && x.ExerciseID === exerciseId);
  const best = Math.max(0, ...relevant.map((x) => n(x['e1RM, кг'], 0)));

  const sh = await sheet(CFG.PROGRESS);
  const gsRows = await sh.getRows();
  const target = gsRows.find(
    (r) => String(r.get('WorkoutID')) === String(workoutId) && String(r.get('ExerciseID')) === String(exerciseId)
  );
  const out = {
    Дата: w['Дата'] || now().toISOString(),
    UserID: w.UserID,
    Имя: u ? u['Имя'] : '',
    ExerciseID: exerciseId,
    Упражнение: e ? e['Название'] : '',
    'Лучший e1RM, кг': best,
    WorkoutID: workoutId,
  };
  if (target) {
    Object.keys(out).forEach((k) => target.set(k, out[k]));
    await target.save();
  } else {
    await appendObject(CFG.PROGRESS, out);
  }
}

async function finishWorkout(workoutId, note, durationSeconds) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const sh = await sheet(CFG.WORKOUTS);
  const gsRows = await sh.getRows();
  const row = gsRows.find((r) => String(r.get('WorkoutID')) === String(workoutId));
  if (!row) throw new Error('Тренировка не найдена.');
  let sec = n(durationSeconds, 0);
  if (!sec) {
    const dateVal = row.get('Дата');
    const parsed = dateVal ? new Date(dateVal) : null;
    if (parsed && !isNaN(parsed)) sec = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  }
  row.set('Длительность, мин', Math.max(1, Math.round(sec / 60)));
  row.set('Заметки', note || '');
  row.set('Статус', 'Завершена');
  await row.save();
  return true;
}

async function deleteWorkout(workoutId) {
  if (!workoutId) throw new Error('Не указана тренировка.');
  const sh = await sheet(CFG.WORKOUTS);
  const gsRows = await sh.getRows();
  const row = gsRows.find((r) => String(r.get('WorkoutID')) === String(workoutId));
  if (!row) throw new Error('Тренировка не найдена.');
  await row.delete();
  return true;
}

async function getProgress(userId, exerciseId) {
  const progress = await rows(CFG.PROGRESS);
  return progress
    .filter((x) => (!userId || x.UserID === userId) && (!exerciseId || x.ExerciseID === exerciseId))
    .sort((a, b) => new Date(a['Дата']).getTime() - new Date(b['Дата']).getTime());
}

async function deleteUser(userId) {
  if (!userId) throw new Error('Не указан спортсмен.');
  const sh = await sheet(CFG.USERS);
  const gsRows = await sh.getRows();
  const row = gsRows.find((r) => String(r.get('UserID')) === String(userId));
  if (!row) throw new Error('Спортсмен не найден.');
  row.set('Активен', false);
  await row.save();
  return true;
}

// В режиме Google Sheets отдельный механизм резервных копий не нужен — у самой таблицы
// есть встроенная история версий (Файл → История версий в интерфейсе Google Sheets),
// которая и служит бэкапом. Эти функции — просто заглушки, чтобы общий API не падал.
async function createBackup() {
  return null;
}
async function listBackups() {
  return [];
}
async function getBackup() {
  throw new Error('В режиме Google Sheets резервные копии не нужны — используйте "Файл → История версий" в самой таблице.');
}

module.exports = {
  CFG,
  HEADERS,
  ensureSchema,
  getAppData,
  addUser,
  addExercise,
  addTemplate,
  addTemplateExercises,
  deleteTemplateExercise,
  updateTemplateOrder,
  startWorkout,
  saveAllSets,
  finishWorkout,
  deleteWorkout,
  getProgress,
  deleteUser,
  createBackup,
  listBackups,
  getBackup,
};
