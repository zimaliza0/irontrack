// Разовый скрипт миграции: переливает данные из server/data/db.json (сделанного из вашего
// исходного xlsx) в базу Turso. Запускается один раз с ПК, после — можно удалить или не трогать.
//
// Использование:
//   node scripts/migrate-json-to-turso.js
// Обязательно должны быть заданы TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в .env (server/.env).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const DB_JSON_PATH = path.join(__dirname, '..', 'data', 'db.json');

const SHEET_TO_TABLE = {
  'Пользователи': 'users',
  'Упражнения': 'exercises',
  'Шаблоны': 'templates',
  'Шаблон_Упражнения': 'template_ex',
  'Тренировки': 'workouts',
  'Подходы': 'sets',
  // Прогресс пересчитывается приложением само по себе из "Подходы" при сохранении сетов,
  // но на всякий случай перельём и его тоже, если он есть в исходном файле.
  'Прогресс': 'progress',
};

const TABLES_SQL = {
  users: `CREATE TABLE IF NOT EXISTS users (
    "UserID" TEXT PRIMARY KEY, "Имя" TEXT, "Пол" TEXT, "Дата рождения" TEXT,
    "Рост, см" REAL, "Вес, кг" REAL, "Активен" INTEGER DEFAULT 1)`,
  exercises: `CREATE TABLE IF NOT EXISTS exercises (
    "ExerciseID" TEXT PRIMARY KEY, "Название" TEXT, "Категория" TEXT, "Мышца" TEXT,
    "Оборудование" TEXT, "Тип" TEXT, "Единица" TEXT, "Активно" INTEGER DEFAULT 1, "Описание" TEXT)`,
  templates: `CREATE TABLE IF NOT EXISTS templates (
    "TemplateID" TEXT PRIMARY KEY, "Название" TEXT, "Описание" TEXT,
    "Владелец UserID" TEXT, "Создан" TEXT, "Активен" INTEGER DEFAULT 1)`,
  template_ex: `CREATE TABLE IF NOT EXISTS template_ex (
    "TemplateExerciseID" TEXT PRIMARY KEY, "TemplateID" TEXT, "ExerciseID" TEXT,
    "Порядок" INTEGER, "Сеты" INTEGER, "Повторы" TEXT, "Отдых, сек" INTEGER, "Комментарий" TEXT)`,
  workouts: `CREATE TABLE IF NOT EXISTS workouts (
    "WorkoutID" TEXT PRIMARY KEY, "UserID" TEXT, "TemplateID" TEXT, "Дата" TEXT,
    "Название" TEXT, "Длительность, мин" INTEGER, "Заметки" TEXT, "Статус" TEXT)`,
  sets: `CREATE TABLE IF NOT EXISTS sets (
    "SetID" TEXT PRIMARY KEY, "WorkoutID" TEXT, "ExerciseID" TEXT, "Номер подхода" INTEGER,
    "Вес, кг" REAL, "Повторы" INTEGER, "RPE" REAL, "Подход до отказа" INTEGER DEFAULT 0,
    "e1RM, кг" REAL, "Дата/время" TEXT, "Комментарий" TEXT)`,
  progress: `CREATE TABLE IF NOT EXISTS progress (
    "id" TEXT PRIMARY KEY, "Дата" TEXT, "UserID" TEXT, "Имя" TEXT, "ExerciseID" TEXT,
    "Упражнение" TEXT, "Лучший e1RM, кг" REAL, "WorkoutID" TEXT)`,
};

function toSqlValue(v, colName) {
  if (v === '' || v === null || v === undefined) return null;
  if (colName === 'Активен' || colName === 'Активно') {
    return v === false || v === 'FALSE' || v === 0 ? 0 : 1;
  }
  if (colName === 'Подход до отказа') {
    return v === true || v === 'TRUE' || v === 1 ? 1 : 0;
  }
  return v;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error('Не задан TURSO_DATABASE_URL — проверьте server/.env');

  if (!fs.existsSync(DB_JSON_PATH)) {
    throw new Error('Не найден файл ' + DB_JSON_PATH + ' — сначала положите db.json в server/data/');
  }

  const client = createClient({ url, authToken });
  const raw = JSON.parse(fs.readFileSync(DB_JSON_PATH, 'utf8'));

  console.log('Создаю таблицы (если их ещё нет)...');
  for (const sql of Object.values(TABLES_SQL)) {
    await client.execute(sql);
  }

  for (const [sheetName, tableName] of Object.entries(SHEET_TO_TABLE)) {
    const rows = raw[sheetName];
    if (!rows || !rows.length) {
      console.log(tableName + ': нет данных в db.json, пропускаю');
      continue;
    }
    let inserted = 0;
    for (const row of rows) {
      if (tableName === 'progress' && !row.id) {
        row.id = String(row.WorkoutID || '') + '_' + String(row.ExerciseID || '');
      }
      const cols = Object.keys(row).filter((c) => c !== '');
      if (!cols.length) continue;
      const placeholders = cols.map(() => '?').join(',');
      const colList = cols.map((c) => `"${c}"`).join(',');
      const values = cols.map((c) => toSqlValue(row[c], c));
      const sql = `INSERT OR REPLACE INTO ${tableName} (${colList}) VALUES (${placeholders})`;
      try {
        await client.execute({ sql, args: values });
        inserted++;
      } catch (e) {
        console.error('Ошибка вставки в', tableName, ':', e.message, JSON.stringify(row));
      }
    }
    console.log(tableName + ': загружено ' + inserted + ' из ' + rows.length + ' строк');
  }

  console.log('Готово! Проверьте приложение — данные должны появиться.');
}

main().catch((e) => {
  console.error('МИГРАЦИЯ НЕ УДАЛАСЬ:', e.message);
  process.exit(1);
});
