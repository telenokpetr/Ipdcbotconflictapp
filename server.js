const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

if (ADMIN_TOKEN === 'change-me') {
  console.warn('[внимание] ADMIN_TOKEN не задан — используется значение по умолчанию. ' +
    'Установите переменную окружения ADMIN_TOKEN перед деплоем на VPS.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Категории ответов теста (должны совпадать с вопросами на фронтенде) ----
// AV = сглаживание/избегание (варианты А и В)
// B  = борьба (вариант Б)
// G  = анализ (вариант Г)
const QUESTION_CATEGORIES = [
  { А: 'AV', Б: 'B', В: 'AV', Г: 'G' },
  { А: 'AV', Б: 'B', В: 'AV', Г: 'G' },
  { А: 'AV', Б: 'B', В: 'AV', Г: 'G' },
  { А: 'AV', Б: 'B', В: 'AV', Г: 'G' },
  { А: 'AV', Б: 'B', В: 'AV', Г: 'G' }
];

function computeProfile(answers) {
  const scores = { AV: 0, B: 0, G: 0 };
  answers.forEach((letter, i) => {
    const map = QUESTION_CATEGORIES[i];
    if (map && letter && map[letter]) {
      scores[map[letter]]++;
    }
  });
  let top = 'AV';
  let topScore = -1;
  Object.keys(scores).forEach(cat => {
    if (scores[cat] > topScore) {
      topScore = scores[cat];
      top = cat;
    }
  });
  return { profile: top, scores };
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Неверный или отсутствующий токен администратора' });
  }
  next();
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maxLen;
}

// ---- Регистрация участника ----
app.post('/api/register', async (req, res) => {
  const { name, role, contact, consent } = req.body || {};

  if (!isNonEmptyString(name, 200)) {
    return res.status(400).json({ error: 'Укажите имя' });
  }
  if (!isNonEmptyString(contact, 200)) {
    return res.status(400).json({ error: 'Укажите email или телефон' });
  }
  if (role !== undefined && role !== null && (typeof role !== 'string' || role.length > 200)) {
    return res.status(400).json({ error: 'Некорректное значение роли' });
  }
  if (consent !== true) {
    return res.status(400).json({ error: 'Требуется согласие на обработку персональных данных' });
  }

  try {
    const participant = await db.createParticipant({
      name: name.trim(),
      role: role ? role.trim() : null,
      contact: contact.trim()
    });
    res.json({ id: participant.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось сохранить регистрацию' });
  }
});

// ---- Приём результатов теста ----
app.post('/api/results', async (req, res) => {
  const { participantId, answers } = req.body || {};

  if (!isNonEmptyString(participantId, 100)) {
    return res.status(400).json({ error: 'Отсутствует идентификатор участника' });
  }
  if (!Array.isArray(answers) || answers.length !== QUESTION_CATEGORIES.length) {
    return res.status(400).json({ error: 'Некорректный формат ответов' });
  }

  const participant = db.findParticipant(participantId);
  if (!participant) {
    return res.status(404).json({ error: 'Участник не найден. Пройдите регистрацию заново.' });
  }

  const { profile, scores } = computeProfile(answers);

  try {
    await db.saveResult(participantId, answers, profile, scores);
    res.json({ profile, scores });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось сохранить результат' });
  }
});

// ---- Бронирование места на тренинге ----
app.post('/api/booking', async (req, res) => {
  const { participantId } = req.body || {};

  if (!isNonEmptyString(participantId, 100)) {
    return res.status(400).json({ error: 'Отсутствует идентификатор участника' });
  }

  const participant = db.findParticipant(participantId);
  if (!participant) {
    return res.status(404).json({ error: 'Участник не найден' });
  }

  try {
    await db.markBooked(participantId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось сохранить бронирование' });
  }
});

// ---- Админ: список участников (для просмотра регистраций/результатов) ----
app.get('/api/admin/participants', requireAdmin, (req, res) => {
  try {
    const list = db.listParticipants();
    res.json({ participants: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось прочитать данные' });
  }
});

// ---- Админ: сводная статистика ----
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const list = db.listParticipants();

    const total = list.length;
    const completed = list.filter(p => p.profile).length;
    const booked = list.filter(p => p.booked).length;

    const profileCounts = { AV: 0, B: 0, G: 0 };
    list.forEach(p => {
      if (p.profile && profileCounts[p.profile] !== undefined) {
        profileCounts[p.profile]++;
      }
    });

    const byRole = {};
    list.forEach(p => {
      const key = p.role && p.role.trim() ? p.role.trim() : 'Не указана';
      byRole[key] = (byRole[key] || 0) + 1;
    });

    res.json({
      total,
      completed,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
      booked,
      bookingRate: total ? Math.round((booked / total) * 100) : 0,
      profileCounts,
      byRole
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось построить статистику' });
  }
});

// ---- Обработка ошибок: не отдаём наружу стек и внутренние пути ----
app.use((req, res) => {
  res.status(404).json({ error: 'Не найдено' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Некорректный запрос' });
});

app.listen(PORT, () => {
  console.log('Сервер запущен: http://localhost:' + PORT);
});
