// Простое JSON-хранилище на файловой системе.
// Без нативных зависимостей — работает на любом VPS с Node.js без сборки.
// Для небольшого потока регистраций (десятки-сотни в день) этого достаточно.
// Если поток вырастет — замените на настоящую БД (Postgres/SQLite), интерфейс ниже несложно перенести.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'participants.json');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

// Редактируемые через админку тексты и даты лендинга.
// Значения по умолчанию — то, что раньше было зашито в public/index.html.
const DEFAULT_CONTENT = {
  headline: 'Как вы обращаетесь с конфликтом интересов?',
  intro: '5 минут — и вы получите представление о своей конфликтной устойчивости и зонах роста.',
  trainingTitle: 'Тренинг «Конфликт интересов»',
  trainingDescription: 'Формат групповой работы, кейсов и проживания ролей — для тех, кто регулярно сталкивается со столкновением интересов в команде и в переговорах.',
  leaders: 'преподаватели IPDC, 12 лет опыта',
  groupSize: 'до 20 человек',
  audience: 'руководители, консультанты, коучи, HR',
  preTestNote: 'Сначала — короткая диагностика. Она покажет, где вы сейчас находитесь и что может стать следующим шагом. Это не тест на правильность.',
  invitationTitle: 'Тренинг «Конфликт интересов»',
  invitationDescription: 'Не курс лекций — пространство, где вы проверите свои гипотезы, увидите свои паттерны и освоите новый способ обращения с конфликтами.',
  sessionDates: '11 и 18 февраля',
  sessionTime: '18:00–21:00 МСК',
  sessionFormat: 'Онлайн, Zoom',
  sessionGroupSize: 'до 20 человек',
  afterNote: 'Ваш профиль по результатам диагностики сохранён — это поможет ведущим точнее подобрать акценты для вашей группы.'
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ participants: [] }, null, 2), 'utf8');
  }
}

function readAll() {
  ensureStore();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // повреждённый файл — не теряем данные молча, поднимаем ошибку
    throw new Error('Файл базы данных повреждён: ' + DB_FILE);
  }
}

function writeAll(data) {
  ensureStore();
  // атомарная запись: сначала во временный файл, потом переименование
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

// простая блокировка на процесс, чтобы параллельные запросы не затирали друг друга
let writeChain = Promise.resolve();
function withLock(fn) {
  const result = writeChain.then(() => fn());
  writeChain = result.catch(() => {}); // не рвём цепочку при ошибке одного запроса
  return result;
}

const MAX_ATTEMPTS = 5;

// участники, заведённые до появления истории попыток, хранили только
// последний результат — при первом обращении превращаем его в attempts[0]
function ensureAttempts(p) {
  if (!Array.isArray(p.attempts)) {
    p.attempts = p.profile
      ? [{ answers: p.answers, profile: p.profile, scores: p.scores, at: p.resultAt }]
      : [];
  }
}

function createParticipant({ name, role, phone, email }) {
  return withLock(() => {
    const data = readAll();
    const participant = {
      id: require('crypto').randomUUID(),
      name,
      role: role || null,
      phone,
      email,
      consent: true,
      consentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      attempts: [],
      answers: null,
      profile: null,
      resultAt: null,
      booked: false,
      bookedAt: null
    };
    data.participants.push(participant);
    writeAll(data);
    return participant;
  });
}

function findParticipant(id) {
  const data = readAll();
  const p = data.participants.find(p => p.id === id) || null;
  if (p) ensureAttempts(p);
  return p;
}

function saveResult(id, answers, profile, scores) {
  return withLock(() => {
    const data = readAll();
    const p = data.participants.find(x => x.id === id);
    if (!p) return { ok: false, reason: 'not_found' };
    ensureAttempts(p);
    if (p.attempts.length >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'limit' };
    }
    const at = new Date().toISOString();
    p.attempts.push({ answers, profile, scores, at });
    p.answers = answers;
    p.profile = profile;
    p.scores = scores;
    p.resultAt = at;
    writeAll(data);
    return { ok: true, participant: p, attemptNumber: p.attempts.length };
  });
}

function markBooked(id) {
  return withLock(() => {
    const data = readAll();
    const p = data.participants.find(x => x.id === id);
    if (!p) return null;
    p.booked = true;
    p.bookedAt = new Date().toISOString();
    writeAll(data);
    return p;
  });
}

function listParticipants() {
  const list = readAll().participants;
  list.forEach(ensureAttempts);
  return list;
}

function ensureContentStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONTENT_FILE)) {
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(DEFAULT_CONTENT, null, 2), 'utf8');
  }
}

function getContent() {
  ensureContentStore();
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
  } catch (e) {
    saved = {};
  }
  return Object.assign({}, DEFAULT_CONTENT, saved);
}

// patch может содержать только часть полей — остальные остаются как были
function saveContent(patch) {
  return withLock(() => {
    const current = getContent();
    const next = Object.assign({}, current);
    Object.keys(DEFAULT_CONTENT).forEach(key => {
      if (typeof patch[key] === 'string') {
        next[key] = patch[key].trim();
      }
    });
    ensureContentStore();
    const tmpFile = CONTENT_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONTENT_FILE);
    return next;
  });
}

module.exports = {
  createParticipant,
  findParticipant,
  saveResult,
  markBooked,
  listParticipants,
  getContent,
  saveContent,
  CONTENT_FIELDS: Object.keys(DEFAULT_CONTENT),
  MAX_ATTEMPTS
};
