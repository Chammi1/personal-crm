import { createApp, ref, computed, onMounted, nextTick, watch } from '/vendor/vue.js';

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const KIND = {
  missed: { color: 'var(--missed)', word: 'пропущено' },
  event:  { color: 'var(--event)',  word: 'событие' },
  owed:   { color: 'var(--owed)',   word: 'обещание' },
  late:   { color: 'var(--late)',   word: 'просрочка' },
  risk:   { color: 'var(--risk)',   word: 'риск' },
};
const HEALTH = {
  'свежо': 'var(--fresh)', 'скоро': 'var(--fresh)', 'пора': 'var(--owed)',
  'просрочка': 'var(--late)', 'риск': 'var(--risk)',
};

async function call(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData ?? '',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};

const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const humanDate = (s) => { const [, m, d] = s.split('-'); return `${+d} ${MONTHS[+m - 1]}`; };
const humanDays = (n) => n < 0 ? `${-n} дн назад` : n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n === 2 ? 'послезавтра' : `через ${n} дн`;
const plural = (n, a, b, c) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b;
  return c;
};

/** Уменьшение картинки прямо в браузере: серверу не нужен sharp, трафика меньше. */
function resizeImage(file, max = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await resizeImage(file) : null);
    };
    input.click();
  });
}

const ROLES = [
  ['spouse', 'супруг(а)'], ['child', 'ребёнок'], ['parent', 'родитель'],
  ['sibling', 'брат/сестра'], ['relative', 'родственник'],
];

const App = {
  setup() {
    const tab = ref('map');
    const state = ref(null);
    const loading = ref(true);
    const mode = ref('today');
    const toast = ref('');
    const opened = ref(null);
    const tags = ref([]);

    // ---- форма добавления: визард из 3 шагов; круг и теги липкие между сохранениями
    const blankForm = (keep = {}) => ({
      step: 1,
      name: '', circle: keep.circle ?? 3, tags: keep.tags ?? [], newTag: '',
      city: '', birthday: '', telegram: '', phone: '', occupation: '',
      lastContact: iso(0),
      context: '', familyNote: '', hooks: '', dreams: '', rapport: 0,
    });
    const form = ref(blankForm());
    const saving = ref(false);
    const nameInput = ref(null);

    const STEP_TITLES = ['Кто это?', 'Контакты и жизнь', 'Досье'];
    function wNext() {
      if (form.value.step === 1 && !form.value.name.trim()) return;
      form.value.step = Math.min(3, form.value.step + 1);
    }
    function wBack() { form.value.step = Math.max(1, form.value.step - 1); }

    const WHEN = [
      { label: 'Сегодня',      value: () => iso(0) },
      { label: 'На этой неделе', value: () => iso(-3) },
      { label: 'В этом месяце',  value: () => iso(-14) },
      { label: 'Пару месяцев',   value: () => iso(-60) },
      { label: 'Полгода назад',  value: () => iso(-180) },
      { label: 'Больше года',    value: () => iso(-400) },
    ];

    async function load() {
      try {
        state.value = await call('/state');
        tags.value = await call('/tags');
        // Справочник обновляем только если он уже открывался: иначе не тратим запрос.
        if (dir.value) dir.value = await call('/people');
      } catch (e) {
        toast.value = 'Нет доступа: ' + e.message;
      } finally {
        loading.value = false;
      }
    }

    // ---- справочник всех людей на вкладке «Разметка»
    const dir = ref(null);           // null = ещё не загружался
    const dirQ = ref('');            // строка поиска
    const dirCity = ref('');         // выбранный город
    const dirTag = ref('');          // выбранный тег (род деятельности)
    const dirCircle = ref(null);     // выбранный круг
    const dirMore = ref(false);      // показать все чипсы, а не первые 10

    async function loadDir() {
      dir.value = await call('/people');
    }
    watch(tab, (t) => { if (t === 'roster' && dir.value === null) loadDir(); });

    const dirCities = computed(() => {
      const m = new Map();
      for (const p of dir.value ?? []) if (p.city) m.set(p.city, (m.get(p.city) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([city, n]) => ({ city, n }));
    });
    const dirTags = computed(() => {
      const m = new Map();
      for (const p of dir.value ?? []) for (const t of p.tags) m.set(t, (m.get(t) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n }));
    });

    const dirFiltered = computed(() => {
      if (!dir.value) return [];
      const q = dirQ.value.trim().toLowerCase();
      return dir.value.filter((p) => {
        if (dirCity.value && (p.city ?? '') !== dirCity.value) return false;
        if (dirTag.value && !p.tags.includes(dirTag.value)) return false;
        if (dirCircle.value !== null && p.circle !== dirCircle.value) return false;
        if (!q) return true;
        // Поиск сразу по всему, что видно в строке: имя, город, работа, теги.
        return [p.name, p.city, p.occupation, ...p.tags]
          .filter(Boolean).some((s) => s.toLowerCase().includes(q));
      });
    });

    const dirSub = (p) => [
      p.city, p.occupation, p.tags.join(', '),
    ].filter(Boolean).join(' · ');

    function dirReset() {
      dirQ.value = ''; dirCity.value = ''; dirTag.value = ''; dirCircle.value = null;
    }

    /** Быстрый лог «написал» прямо со строки списка, без открытия карточки. */
    async function quickLog(p) {
      await call('/person/' + p.id + '/contact', {
        method: 'POST', body: JSON.stringify({ channel: 'message' }),
      });
      flash('Записал: переписка с ' + p.name.split(' ')[0]);
      await load();
    }
    const dirHasFilter = computed(() =>
      dirQ.value || dirCity.value || dirTag.value || dirCircle.value !== null);

    function flash(text) {
      toast.value = text;
      setTimeout(() => { if (toast.value === text) toast.value = ''; }, 2200);
    }

    // ---- карта
    const sectorCount = computed(() => state.value?.clusters.length ?? 6);
    const sectorSpan = computed(() => 360 / sectorCount.value);

    const sectorLabel = (i) => {
      const mid = (-90 + i * sectorSpan.value + sectorSpan.value / 2) * Math.PI / 180;
      return {
        x: 180 + Math.cos(mid) * 172,
        y: 180 + Math.sin(mid) * 172 + 2.5,
        anchor: Math.cos(mid) > 0.25 ? 'start' : Math.cos(mid) < -0.25 ? 'end' : 'middle',
      };
    };
    const sectorEdge = (i) => {
      const a = (-90 + i * sectorSpan.value) * Math.PI / 180;
      return { x2: 180 + Math.cos(a) * 168, y2: 180 + Math.sin(a) * 168 };
    };

    const lit = computed(() => {
      if (!state.value || mode.value !== 'today') return [];
      return state.value.nodes.filter((n) => n.signal && (n.signal.kind !== 'event' || n.signal.days <= 5 || n.signal.size > 0));
    });
    const ghosts = computed(() => {
      if (!state.value) return [];
      const litIds = new Set(lit.value.map((n) => n.id));
      return state.value.nodes.filter((n) => !litIds.has(n.id));
    });

    const NODE_R = [4.6, 3.8, 3.2, 2.7, 2.3];
    function nodeRadius(n) {
      const s = n.signal;
      if (!s) return NODE_R[n.circle];
      if (s.kind !== 'event') return 5;
      return 1.6 + 3.9 * s.size;
    }
    function nodeColor(n) {
      if (n.signal) return KIND[n.signal.kind].color;
      return HEALTH[n.health] ?? 'var(--ghost)';
    }
    function showLabel(n) {
      return !n.signal || n.signal.kind !== 'event' || n.signal.days <= 5;
    }
    function labelPos(n) {
      const right = Math.cos(n.angle * Math.PI / 180) > -0.15;
      const off = nodeRadius(n) + 9;
      return { x: n.x + (right ? off : -off), anchor: right ? 'start' : 'end' };
    }
    const shortWhy = (n) => {
      const s = n.signal;
      if (!s) return '';
      if (s.kind === 'event') return humanDays(s.days);
      if (s.kind === 'missed') return 'пропустил';
      if (s.kind === 'owed') return 'обещание';
      return n.silent ? `${n.silent} дн` : '';
    };

    const headline = computed(() => {
      if (!state.value) return '';
      if (mode.value === 'all') return `<b>${state.value.counts.total}</b> человек`;
      const n = state.value.counts.due;
      if (!n) return '<span class="zero">Круг чист</span>';
      return `<b>${n}</b> ${plural(n, 'человек ждёт', 'человека ждут', 'человек ждут')}`;
    });
    const subline = computed(() => {
      if (!state.value) return '';
      if (mode.value === 'all') return 'Цвет — состояние связи. Угол — где вы пересеклись, радиус — насколько близко.';
      const h = state.value.counts.horizon;
      return h ? `${h} ${plural(h, 'событие растёт', 'события растут', 'событий растут')} на горизонте.` : 'Остальные молчат.';
    });

    // ---- карточка
    const cardTab = ref('dossier');   // dossier | history | dates
    const pickCircle = ref(false);    // раскрыт ли быстрый выбор круга
    async function open(id) {
      opened.value = await call('/person/' + id);
      cardTab.value = 'dossier';
      pickCircle.value = false;
    }

    /** Перенос в другой круг в один тап, без захода в правку. */
    async function setCircleFromCard(circle) {
      await call('/person/' + opened.value.id + '/circle', {
        method: 'POST', body: JSON.stringify({ circle }),
      });
      pickCircle.value = false;
      await open(opened.value.id);
      await load();
      flash('Перенесён: ' + (state.value.circleLoad.find((c) => c.circle === circle)?.label ?? 'круг ' + circle));
    }

    const MONTHS_SHORT = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
    const calDay = (isoDate) => +isoDate.split('-')[2];
    const calMon = (isoDate) => MONTHS_SHORT[+isoDate.split('-')[1] - 1];
    const CHANNEL_VIEW = {
      message: { icon: '💬', word: 'Переписка' },
      call:    { icon: '📞', word: 'Звонок' },
      meeting: { icon: '🤝', word: 'Встреча' },
    };

    /** «Перед разговором»: ближайшее событие + свежая заметка + незакрытые обещания. */
    const focusText = computed(() => {
      const p = opened.value;
      if (!p) return '';
      const bits = [];
      const ev = [...p.events].sort((a, b) => a.days - b.days)[0];
      if (ev && ev.days <= 30) {
        bits.push(`${ev.title} — ${humanDays(ev.days)}.`);
      }
      const note = p.notes?.[0];
      if (note) {
        const txt = note.body.length > 100 ? note.body.slice(0, 100) + '…' : note.body;
        bits.push(`Из заметок: «${txt}»`);
      }
      for (const t of (p.tasks ?? []).slice(0, 2)) {
        bits.push(t.direction === 'i_owe' ? `Ты обещал: ${t.body}.` : `Тебе обещали: ${t.body}.`);
      }
      return bits.join(' ');
    });

    /** Строки досье для вкладки: только заполненные блоки. */
    const dossierRows = computed(() => {
      const p = opened.value;
      if (!p) return [];
      const d = p.dossier ?? {};
      const rows = [];
      if (d.occupation) rows.push({ ic: '💼', b: d.occupation, s: 'работа' });
      if (d.dreams) rows.push({ ic: '⭐', b: d.dreams, s: 'мечты и цели' });
      if (d.hooks) rows.push({ ic: '🎣', b: d.hooks, s: 'зацепка для разговора' });
      if (d.recreation) rows.push({ ic: '🎾', b: d.recreation, s: 'увлечения' });
      if (d.family && !(p.family?.length)) rows.push({ ic: '👨‍👩‍👧', b: d.family, s: 'семья' });
      if (d.gift_ideas) rows.push({ ic: '🎁', b: d.gift_ideas, s: 'идеи подарка' });
      if (d.avoid) rows.push({ ic: '⛔', b: d.avoid, s: 'не трогать' });
      if (p.met_context) rows.push({ ic: '👋', b: p.met_context, s: 'как познакомились' });
      if (p.metVia) rows.push({ ic: '🔗', b: 'Представил: ' + p.metVia.name, s: 'связь по знакомству', personId: p.metVia.id });
      if (p.introduced && p.introduced.length) {
        rows.push({
          ic: '🌱', b: 'Привёл в сеть: ' + p.introduced.map((b) => b.name.split(' ')[0]).join(', '),
          s: p.introduced.length + ' ' + plural(p.introduced.length, 'человек', 'человека', 'человек') + ' — коннектор',
        });
      }
      return rows;
    });

    /** История: касания + явные паузы длиннее 30 дней. */
    const historyRows = computed(() => {
      const list = opened.value?.interactions ?? [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        out.push({ kind: 'x', ...cur, view: CHANNEL_VIEW[cur.channel] ?? CHANNEL_VIEW.message });
        const next = list[i + 1];
        if (next) {
          const gap = Math.round((new Date(cur.on) - new Date(next.on)) / 86400000);
          if (gap > 30) out.push({ kind: 'gap', id: 'g' + cur.id, days: gap });
        }
      }
      return out;
    });
    const touchesHalfYear = computed(() => {
      const list = opened.value?.interactions ?? [];
      const cutoff = new Date(Date.now() - 180 * 86400000);
      return list.filter((i) => new Date(i.on) >= cutoff).length;
    });

    /** Даты: события человека (включая питомцев) + дни рождения родных. */
    const dateRows = computed(() => {
      const p = opened.value;
      if (!p) return [];
      const rows = p.events.map((e) => ({
        id: 'e' + e.id, eventId: e.id, title: e.title, days: e.days, next: e.next,
        sub: e.recurring ? 'ежегодно' : 'разовое',
      }));
      for (const m of p.family ?? []) {
        if (m.birthdayDays !== null && m.birthdayDays !== undefined) {
          rows.push({
            id: 'f' + m.id, eventId: null, title: `ДР — ${m.name}`, days: m.birthdayDays,
            next: iso(m.birthdayDays),
            sub: m.label + (m.age !== null ? ` · исполнится ${m.age + 1}` : ''),
          });
        }
      }
      return rows.sort((a, b) => a.days - b.days);
    });
    async function act(path, body) {
      await call(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      const id = opened.value.id;
      opened.value = null;
      await load();
      flash('Записал');
      if (body?.keepOpen) await open(id);
    }

    // ---- редактирование
    const editing = ref(null);
    const confirmStep = ref(null);   // 'archive' | 'delete'
    const newEvent = ref({ date: '', title: '', recurring: true });
    const archivedList = ref(null);

    const block = ref('main');            // раскрытый блок в правке
    const toggleBlock = (b) => { block.value = block.value === b ? null : b; };

    const newMember = ref({ name: '', role: 'spouse', birthday: '' });
    const newPet = ref({ name: '', species: '', breed: '', birthday: '', note: '' });

    const DOSSIER_BLOCKS = [
      ['family', 'Семья'], ['occupation', 'Работа'], ['recreation', 'Увлечения'],
      ['dreams', 'Планы'], ['hooks', 'Зацепки'], ['avoid', 'Не трогать'], ['gift_ideas', 'Подарки'],
    ];

    function openEdit() {
      const p = opened.value;
      const d = p.dossier ?? {};
      editing.value = {
        id: p.id, name: p.name, circle: p.circle, tags: [...p.tags],
        city: p.city ?? '', telegram: p.telegram ?? '', phone: p.phone ?? '',
        context: p.met_context ?? '', interval: p.target_interval ?? '', rapport: p.rapport ?? 0,
        lastContact: '', newTag: '',
        dossier: Object.fromEntries(DOSSIER_BLOCKS.map(([k]) => [k, d[k] ?? ''])),
      };
      confirmStep.value = null;
      block.value = 'main';
      newEvent.value = { date: '', title: '', recurring: true };
      newMember.value = { name: '', role: 'spouse', birthday: '' };
      newPet.value = { name: '', species: '', breed: '', birthday: '', note: '' };
    }

    // ---- аватары
    async function uploadAvatar(kind, id) {
      const data = await pickImage();
      if (!data) return;
      try {
        await call(`/${kind}/${id}/avatar`, { method: 'POST', body: JSON.stringify({ data }) });
        await open(opened.value.id);
        flash('Фото загружено');
      } catch (err) {
        flash(err.message);
      }
    }

    // ---- семья
    async function addMember() {
      const m = newMember.value;
      if (!m.name.trim()) return;
      try {
        await call('/person/' + editing.value.id + '/family', {
          method: 'POST',
          body: JSON.stringify({ name: m.name, role: m.role, birthday: m.birthday || undefined }),
        });
        newMember.value = { name: '', role: m.role, birthday: '' };
        await open(editing.value.id);
        flash('Родственник добавлен и связан');
      } catch (err) {
        flash(err.message);
      }
    }

    async function delMember(memberId) {
      await call(`/person/${editing.value.id}/family/${memberId}`, { method: 'DELETE' });
      await open(editing.value.id);
      flash('Связь убрана');
    }

    async function activateMember(id) {
      await call('/person/' + id + '/activate', { method: 'POST', body: JSON.stringify({ circle: 3 }) });
      await open(editing.value.id);
      await load();
      flash('Теперь полноценная карточка');
    }

    /** «Поздравил» из вкладки «Даты»: повод закрывается и не всплывает в этом году. */
    async function closeOccurrence(d) {
      await call('/event/' + d.eventId + '/close', {
        method: 'POST', body: JSON.stringify({ occurrence: d.next }),
      });
      flash('Закрыто — в этом году больше не напомнит');
      await open(opened.value.id);
      await load();
    }

    /** «В круг» прямо из карточки, без захода в правку. */
    async function activateFromCard(id) {
      await call('/person/' + id + '/activate', { method: 'POST', body: JSON.stringify({ circle: 3 }) });
      await open(opened.value.id);
      await load();
      flash('Теперь в круге — появится на карте');
    }

    // ---- питомцы
    async function addPet() {
      const p = newPet.value;
      if (!p.name.trim()) return;
      try {
        await call('/person/' + editing.value.id + '/pet', { method: 'POST', body: JSON.stringify(p) });
        newPet.value = { name: '', species: '', breed: '', birthday: '', note: '' };
        await open(editing.value.id);
        flash('Питомец добавлен');
      } catch (err) {
        flash(err.message);
      }
    }

    async function delPet(id) {
      await call('/pet/' + id, { method: 'DELETE' });
      await open(editing.value.id);
      flash('Питомец удалён');
    }

    function toggleEditTag(t) {
      const i = editing.value.tags.indexOf(t);
      if (i >= 0) editing.value.tags.splice(i, 1);
      else editing.value.tags.push(t);
    }
    function addEditTag() {
      const t = editing.value.newTag.trim().toLowerCase();
      if (t && !editing.value.tags.includes(t)) editing.value.tags.push(t);
      editing.value.newTag = '';
    }

    async function saveEdit() {
      const e = editing.value;
      if (!e.name.trim()) return;
      saving.value = true;
      try {
        await call('/person/' + e.id, {
          method: 'PATCH',
          body: JSON.stringify({
            name: e.name, circle: e.circle, tags: e.tags,
            city: e.city, telegram: e.telegram, phone: e.phone,
            context: e.context, interval: e.interval === '' ? null : Number(e.interval),
            dossier: e.dossier,
            rapport: e.rapport || null,
            lastContact: e.lastContact || undefined,
          }),
        });
        const id = e.id;
        editing.value = null;
        await load();
        await open(id);
        flash('Сохранено');
      } catch (err) {
        flash('Не сохранилось: ' + err.message);
      } finally {
        saving.value = false;
      }
    }

    async function addEvent() {
      const ev = newEvent.value;
      if (!ev.date.trim()) return;
      try {
        await call('/person/' + editing.value.id + '/event', {
          method: 'POST',
          body: JSON.stringify({ date: ev.date, title: ev.title, recurring: ev.recurring }),
        });
        newEvent.value = { date: '', title: '', recurring: true };
        await open(editing.value.id);
        flash('Дата добавлена');
      } catch (err) {
        flash(err.message);
      }
    }

    async function delEvent(id) {
      await call('/event/' + id, { method: 'DELETE' });
      await open(editing.value.id);
      flash('Дата удалена');
    }

    async function archivePerson() {
      if (confirmStep.value !== 'archive') { confirmStep.value = 'archive'; return; }
      await call('/person/' + editing.value.id + '/archive', { method: 'POST' });
      editing.value = null; opened.value = null;
      await load();
      flash('В архиве. Восстановить можно на вкладке «Разметка»');
    }

    async function deletePerson() {
      if (confirmStep.value !== 'delete') { confirmStep.value = 'delete'; return; }
      await call('/person/' + editing.value.id, { method: 'DELETE' });
      editing.value = null; opened.value = null;
      await load();
      flash('Удалён вместе с историей');
    }

    async function loadArchived() {
      archivedList.value = await call('/archived');
    }
    async function restorePerson(id) {
      await call('/person/' + id + '/restore', { method: 'POST' });
      await loadArchived();
      await load();
      flash('Восстановлен');
    }

    // ---- добавление
    const circleLoad = computed(() => state.value?.circleLoad ?? []);

    function toggleTag(t) {
      const i = form.value.tags.indexOf(t);
      if (i >= 0) form.value.tags.splice(i, 1);
      else form.value.tags.push(t);
    }
    function addNewTag() {
      const t = form.value.newTag.trim().toLowerCase();
      if (t && !form.value.tags.includes(t)) form.value.tags.push(t);
      form.value.newTag = '';
    }

    async function save() {
      const f = form.value;
      if (!f.name.trim() || saving.value) return;
      saving.value = true;
      try {
        await call('/person', {
          method: 'POST',
          body: JSON.stringify({
            name: f.name.trim(),
            circle: f.circle,
            tags: f.tags,
            lastContact: f.lastContact || null,
            birthday: f.birthday || null,
            city: f.city || null,
            telegram: f.telegram || null,
            phone: f.phone || null,
            occupation: f.occupation || null,
            context: f.context || null,
            familyNote: f.familyNote || null,
            hooks: f.hooks || null,
            dreams: f.dreams || null,
            rapport: f.rapport || null,
          }),
        });
        form.value = blankForm({ circle: f.circle, tags: [...f.tags] });
        await load();
        const st = state.value.intake;
        flash(`Добавлен. Сегодня ${st.addedToday} из ${st.quota}`);
        await nextTick();
        nameInput.value?.focus();
      } catch (e) {
        flash('Не сохранилось: ' + e.message);
      } finally {
        saving.value = false;
      }
    }

    async function anotherPrompt() {
      const { prompt } = await call('/prompt');
      state.value.intake.prompt = prompt;
    }

    onMounted(load);

    return {
      tab, state, loading, mode, toast, opened, tags, form, saving, nameInput,
      WHEN, iso, humanDate, humanDays, plural, KIND, HEALTH,
      STEP_TITLES, wNext, wBack,
      cardTab, focusText, dossierRows, historyRows, touchesHalfYear, dateRows,
      calDay, calMon, activateFromCard, pickCircle, setCircleFromCard, closeOccurrence,
      sectorLabel, sectorEdge, lit, ghosts, nodeRadius, nodeColor, showLabel, labelPos, shortWhy,
      headline, subline, circleLoad, open, act, toggleTag, addNewTag, save, anotherPrompt, load, flash,
      dir, dirQ, dirCity, dirTag, dirCircle, dirMore, dirCities, dirTags,
      dirFiltered, dirSub, dirReset, dirHasFilter, loadDir, quickLog,
      editing, confirmStep, newEvent, archivedList, DOSSIER_BLOCKS, ROLES,
      block, toggleBlock, newMember, newPet,
      uploadAvatar, addMember, delMember, activateMember, addPet, delPet,
      openEdit, toggleEditTag, addEditTag, saveEdit, addEvent, delEvent,
      archivePerson, deletePerson, loadArchived, restorePerson,
    };
  },

  template: `
<div v-if="loading" class="loading">ЗАГРУЗКА</div>

<template v-else-if="state">
  <!-- ================= КАРТА ================= -->
  <template v-if="tab === 'map'">
    <header class="head">
      <div class="eyebrow">
        <span>{{ humanDate(state.today) }}</span>
        <span>{{ state.counts.total }} в сети</span>
      </div>
      <h1 v-html="headline"></h1>
      <p class="sub">{{ subline }}</p>
    </header>

    <div class="stage">
      <svg viewBox="0 0 360 360">
        <line v-for="(c, i) in state.clusters" :key="'e'+i" class="sectorline"
              x1="180" y1="180" :x2="sectorEdge(i).x2" :y2="sectorEdge(i).y2"/>
        <text v-for="(c, i) in state.clusters" :key="'l'+i" class="sectorlabel"
              :x="sectorLabel(i).x" :y="sectorLabel(i).y" :text-anchor="sectorLabel(i).anchor">{{ c }}</text>

        <template v-for="ring in state.rings" :key="ring.circle">
          <circle class="ringline" :class="{ lit: ring.circle < 2 }" cx="180" cy="180" :r="ring.r"/>
          <text class="ringlabel" x="183" :y="180 - ring.r - 3">{{ ring.cap }}</text>
        </template>

        <circle class="me" cx="180" cy="180" r="7"/>
        <circle class="me-core" cx="180" cy="180" r="2.4"/>

        <template v-if="mode === 'today'">
          <circle v-for="n in ghosts" :key="'g'+n.id" class="ghost" :cx="n.x" :cy="n.y" r="1.5"/>
        </template>
        <template v-else>
          <g v-for="n in state.nodes" :key="'a'+n.id" class="node" @click="open(n.id)">
            <circle :cx="n.x" :cy="n.y" :r="nodeRadius(n)" :fill="nodeColor(n)"
                    :opacity="n.signal ? 1 : (n.health === 'свежо' ? .5 : .85)"/>
          </g>
        </template>

        <g v-for="n in (mode === 'today' ? lit : [])" :key="'s'+n.id" class="node" @click="open(n.id)">
          <circle v-if="n.signal.kind !== 'event' || n.signal.days <= 2" class="ripple"
                  :cx="n.x" :cy="n.y" r="6" :stroke="KIND[n.signal.kind].color"/>
          <circle v-if="n.signal.size > .35" :cx="n.x" :cy="n.y" :r="nodeRadius(n) * 2.1"
                  :fill="KIND[n.signal.kind].color" :opacity="n.signal.size * .14"/>
          <circle :cx="n.x" :cy="n.y" :r="nodeRadius(n)" :fill="KIND[n.signal.kind].color"
                  :opacity="n.signal.kind === 'event' ? .35 + .65 * n.signal.size : 1"/>
          <template v-if="showLabel(n)">
            <text :x="labelPos(n).x" :y="n.y - 1" :text-anchor="labelPos(n).anchor">{{ n.name.split(' ')[0] }}</text>
            <text class="why" :x="labelPos(n).x" :y="n.y + 8.5" :text-anchor="labelPos(n).anchor">{{ shortWhy(n) }}</text>
          </template>
        </g>
      </svg>
    </div>

    <div class="pad">
      <div class="legend">
        <template v-if="mode === 'today'">
          <span v-for="(k, key) in KIND" :key="key"><i :style="{ background: k.color }"></i>{{ k.word }}</span>
        </template>
        <template v-else>
          <span v-for="(color, word) in HEALTH" :key="word"><i :style="{ background: color }"></i>{{ word }}</span>
        </template>
      </div>
      <div class="seg">
        <button :class="{ on: mode === 'today' }" @click="mode = 'today'">Сегодня</button>
        <button :class="{ on: mode === 'all' }" @click="mode = 'all'">Вся сеть</button>
      </div>
    </div>
  </template>

  <!-- ================= ДОБАВИТЬ: ВИЗАРД ================= -->
  <template v-if="tab === 'add'">
    <header class="head">
      <div class="eyebrow">
        <span>новый человек · шаг {{ form.step }} из 3</span>
        <span>{{ state.intake.addedToday }} / {{ state.intake.quota }} сегодня</span>
      </div>
      <div class="steps">
        <span v-for="s in 3" :key="s" :class="{ done: form.step >= s }"></span>
      </div>
      <h1>{{ STEP_TITLES[form.step - 1] }}</h1>
      <p class="sub" v-if="form.step === 1">Имя и место в твоём круге. Единственный обязательный шаг.</p>
      <p class="sub" v-else-if="form.step === 2">{{ form.name }} · круг {{ form.circle }}<template v-if="form.tags.length"> · #{{ form.tags[0] }}</template></p>
      <p class="sub" v-else>Самое ценное — то, что забудется через месяц. Всё опционально.</p>
    </header>

    <form @submit.prevent="form.step < 3 ? wNext() : save()">
      <!-- шаг 1: кто -->
      <template v-if="form.step === 1">
        <label>Имя</label>
        <input type="text" ref="nameInput" v-model="form.name" placeholder="Аня Соколова"
               autocomplete="off" autocapitalize="words">

        <label>Круг близости</label>
        <div class="rings-pick">
          <button type="button" v-for="c in circleLoad" :key="c.circle"
                  :class="{ on: form.circle === c.circle }" @click="form.circle = c.circle">
            <span class="bead"></span>
            <span>{{ c.label }}</span>
            <span class="cap" :class="{ over: c.n >= c.cap }">{{ c.n }} / {{ c.cap }}</span>
          </button>
        </div>

        <label>Откуда знаешь</label>
        <div class="chips">
          <button type="button" class="chip" v-for="t in tags" :key="t.tag"
                  :class="{ on: form.tags.includes(t.tag) }" @click="toggleTag(t.tag)">
            {{ t.tag }}<small>{{ t.n }}</small>
          </button>
        </div>
        <div class="row" style="margin-top:8px">
          <input type="text" v-model="form.newTag" placeholder="новый тег"
                 @keydown.enter.prevent="addNewTag" autocapitalize="none">
          <button type="button" class="btn ghost" style="flex:0 0 96px" @click="addNewTag">Добавить</button>
        </div>

        <div class="wnav">
          <button type="submit" class="btn" :disabled="!form.name.trim()">Дальше</button>
        </div>
        <p class="hint">Круг и теги запомнятся — следующий человек из этой же компании добавится за секунды.</p>
      </template>

      <!-- шаг 2: контакты и жизнь -->
      <template v-else-if="form.step === 2">
        <div class="row">
          <div>
            <label>Город</label>
            <input type="text" v-model="form.city" placeholder="Москва">
          </div>
          <div>
            <label>День рождения</label>
            <input type="text" v-model="form.birthday" placeholder="12.04.1991" inputmode="numeric">
          </div>
        </div>
        <div class="row">
          <div>
            <label>Telegram</label>
            <input type="text" v-model="form.telegram" placeholder="@ник" autocapitalize="none">
          </div>
          <div>
            <label>Телефон</label>
            <input type="text" v-model="form.phone" placeholder="+7 …" inputmode="tel">
          </div>
        </div>

        <label>Род деятельности</label>
        <input type="text" v-model="form.occupation" placeholder="юрист в IT, тренер по бегу…">

        <label>Когда общались последний раз</label>
        <div class="chips">
          <button type="button" class="chip" v-for="w in WHEN" :key="w.label"
                  :class="{ on: form.lastContact === w.value() }" @click="form.lastContact = w.value()">
            {{ w.label }}
          </button>
          <button type="button" class="chip" :class="{ on: !form.lastContact }" @click="form.lastContact = ''">
            Не помню
          </button>
        </div>
        <p class="hint" :class="{ warn: !form.lastContact }" v-if="!form.lastContact">
          Без даты человек сохранится, но не попадёт в напоминания — поставь хотя бы примерно.
        </p>

        <div class="wnav">
          <button type="button" class="btn ghost back" @click="wBack">Назад</button>
          <button type="submit" class="btn">Дальше</button>
        </div>
      </template>

      <!-- шаг 3: досье -->
      <template v-else>
        <label>Как познакомились</label>
        <textarea v-model="form.context" rows="2" placeholder="забег в Сокольниках, познакомил Тимур"></textarea>

        <label>Семья — кто у него есть</label>
        <textarea v-model="form.familyNote" rows="2" placeholder="муж Паша, дочь Мира 5 лет, кот Барсик"></textarea>
        <p class="hint">Пока одной строкой. Связать карточки родных со всеми датами можно будет в правке.</p>

        <label>Зацепки — о чём поговорить</label>
        <textarea v-model="form.hooks" rows="2" placeholder="готовится к первому марафону в сентябре"></textarea>

        <label>Мечты и цели</label>
        <textarea v-model="form.dreams" rows="2" placeholder="хочет свою юрпрактику к 30"></textarea>

        <label>Как вам вместе</label>
        <div class="rate big">
          <button type="button" v-for="n in 5" :key="n" :class="{ on: n <= form.rapport }"
                  @click="form.rapport = form.rapport === n ? 0 : n"></button>
          <span class="hint" style="margin:0 0 0 10px">{{ ['не оценено','тяжело','прохладно','нормально','хорошо','отлично'][form.rapport] }}</span>
        </div>

        <div class="wnav">
          <button type="button" class="btn ghost back" @click="wBack">Назад</button>
          <button type="submit" class="btn" :disabled="!form.name.trim() || saving">Сохранить</button>
        </div>
        <p class="hint">Один заполненный пункт досье стоит десяти дежурных «как дела».</p>
      </template>
    </form>
  </template>

  <!-- ================= РАЗМЕТКА ================= -->
  <template v-if="tab === 'roster'">
    <header class="head">
      <div class="eyebrow"><span>разметка базы</span><span>{{ state.intake.total }} / {{ state.intake.target }}</span></div>
      <h1><b>{{ state.intake.addedToday }}</b> из {{ state.intake.quota }} сегодня</h1>
      <div class="bar"><i :style="{ width: Math.min(100, state.intake.total / state.intake.target * 100) + '%' }"></i></div>
      <p class="sub">
        Осталось {{ Math.max(0, state.intake.target - state.intake.total) }} —
        это примерно {{ Math.ceil(Math.max(0, state.intake.target - state.intake.total) / state.intake.quota) }}
        {{ plural(Math.ceil(Math.max(0, state.intake.target - state.intake.total) / state.intake.quota), 'день', 'дня', 'дней') }}.
      </p>
    </header>

    <div class="panel">
      <label>Откуда доставать сегодня</label>
      <div class="prompt">{{ state.intake.prompt }}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" @click="anotherPrompt">Другая подсказка</button>
        <button class="btn" @click="tab = 'add'">Добавить человека</button>
      </div>

      <template v-if="state.intake.withoutContact">
        <label>Пробелы: {{ state.intake.withoutContact }} без даты общения</label>
        <p class="hint">Эти люди не попадают в напоминания вообще. Открой и отметь, когда вы последний раз общались.</p>
        <div class="list">
          <button v-for="n in state.nodes.filter(n => !n.lastOn).slice(0, 15)" :key="n.id" @click="open(n.id)">
            <span class="bead" style="background:var(--ink-faint)"></span>
            <span>{{ n.name }}</span>
            <span class="tail">круг {{ n.circle }}</span>
          </button>
        </div>
      </template>

      <label>Все люди<template v-if="dir"> · {{ dirHasFilter ? dirFiltered.length + ' из ' + dir.length : dir.length }}</template></label>
      <template v-if="dir === null">
        <p class="hint">Загружаю список…</p>
      </template>
      <template v-else>
        <input type="text" v-model="dirQ" placeholder="имя, город, работа, тег" autocapitalize="none">

        <div class="chips" style="margin-top:10px" v-if="dirCities.length > 1 || dirTags.length">
          <button type="button" class="chip" v-for="c in (dirMore ? dirCities : dirCities.slice(0, 5))" :key="'c' + c.city"
                  :class="{ on: dirCity === c.city }" @click="dirCity = dirCity === c.city ? '' : c.city">
            {{ c.city }}<small>{{ c.n }}</small>
          </button>
          <button type="button" class="chip" v-for="t in (dirMore ? dirTags : dirTags.slice(0, 5))" :key="'t' + t.tag"
                  :class="{ on: dirTag === t.tag }" @click="dirTag = dirTag === t.tag ? '' : t.tag">
            #{{ t.tag }}<small>{{ t.n }}</small>
          </button>
          <button type="button" class="chip" v-for="c in circleLoad" :key="'k' + c.circle"
                  :class="{ on: dirCircle === c.circle }" @click="dirCircle = dirCircle === c.circle ? null : c.circle"
                  v-show="dirMore">
            круг {{ c.circle }}<small>{{ c.n }}</small>
          </button>
          <button type="button" class="chip" v-if="dirCities.length + dirTags.length > 10 || !dirMore"
                  @click="dirMore = !dirMore">{{ dirMore ? 'свернуть' : 'ещё фильтры…' }}</button>
        </div>

        <p class="hint" v-if="dirHasFilter" style="margin-top:8px">
          Найдено {{ dirFiltered.length }}. <a href="#" @click.prevent="dirReset" style="color:var(--event)">Сбросить фильтры</a>
        </p>

        <div class="list">
          <button v-for="p in dirFiltered" :key="p.id" @click="open(p.id)">
            <span class="ava sm">
              <img v-if="p.avatar" :src="'/avatars/' + p.avatar" alt="">
              <span v-else>{{ p.name.slice(0, 1) }}</span>
            </span>
            <span class="kin-name">{{ p.name }}<em>{{ dirSub(p) || 'круг ' + p.circle }}</em></span>
            <span class="tail">{{ p.silent !== null ? p.silent + ' дн' : 'нет даты' }}</span>
            <span class="mini" @click.stop="quickLog(p)" title="Записать переписку">✍</span>
          </button>
        </div>
        <p class="hint" v-if="!dirFiltered.length">Никого не нашлось. Попробуй убрать фильтры.</p>
      </template>

      <label>Архив</label>
      <button class="btn ghost" @click="loadArchived" v-if="archivedList === null">Показать архив</button>
      <template v-else>
        <p class="hint" v-if="!archivedList.length">Архив пуст.</p>
        <div class="list">
          <button v-for="a in archivedList" :key="a.id" @click="restorePerson(a.id)">
            <span class="bead" style="background:var(--ink-faint)"></span>
            <span>{{ a.name }}</span>
            <span class="tail">вернуть</span>
          </button>
        </div>
      </template>

      <label>Круги</label>
      <div class="list">
        <div v-for="c in circleLoad" :key="c.circle" style="display:flex;gap:10px;padding:11px 2px;border-bottom:1px solid var(--line);font-size:14.5px">
          <span class="bead" style="background:var(--event);width:7px;height:7px;border-radius:50%;margin-top:6px"></span>
          <span>{{ c.label }}</span>
          <span class="tail" :style="{ color: c.n > c.cap ? 'var(--late)' : '' }">{{ c.n }} / {{ c.cap }}</span>
        </div>
      </div>
    </div>
  </template>

  <!-- ================= КАРТОЧКА: ВКЛАДКИ ================= -->
  <Transition name="fade">
    <div v-if="opened" class="scrim" @click="opened = null"></div>
  </Transition>
  <Transition name="slide">
    <section v-if="opened" class="sheet">
      <div class="grab"></div>
      <div class="who">
        <button class="ava" @click="uploadAvatar('person', opened.id)">
          <img v-if="opened.avatar" :src="'/avatars/' + opened.avatar" alt="">
          <span v-else>{{ opened.name.slice(0, 1) }}</span>
        </button>
        <div>
          <h2>{{ opened.name }}</h2>
          <div class="meta">
            <button class="circle-btn" @click="pickCircle = !pickCircle">{{ opened.circleLabel }} ▾</button><template v-if="opened.city"> · {{ opened.city }}</template><template v-if="opened.dossier && opened.dossier.occupation"> · {{ opened.dossier.occupation }}</template>
          </div>
          <div class="rate" v-if="opened.rapport">
            <i v-for="n in 5" :key="n" :class="{ on: n <= opened.rapport }"></i>
          </div>
        </div>
      </div>

      <div class="chips" v-if="pickCircle" style="margin-top:12px">
        <button type="button" class="chip" v-for="c in circleLoad" :key="c.circle"
                :class="{ on: opened.circle === c.circle }" @click="setCircleFromCard(c.circle)">
          {{ c.label }}<small>{{ c.n }} / {{ c.cap }}</small>
        </button>
      </div>

      <div class="focus" v-if="focusText">
        <div class="fl">Перед разговором</div>
        {{ focusText }}
      </div>

      <div class="tabsx">
        <button :class="{ on: cardTab === 'dossier' }" @click="cardTab = 'dossier'">Досье</button>
        <button :class="{ on: cardTab === 'history' }" @click="cardTab = 'history'">История</button>
        <button :class="{ on: cardTab === 'dates' }" @click="cardTab = 'dates'">Даты</button>
      </div>

      <!-- ===== вкладка ДОСЬЕ ===== -->
      <template v-if="cardTab === 'dossier'">
        <div v-if="dossierRows.length">
          <div class="frow" v-for="(r, i) in dossierRows" :key="i"
               :style="r.personId ? 'cursor:pointer' : ''" @click="r.personId && open(r.personId)">
            <div class="ic">{{ r.ic }}</div>
            <div><b>{{ r.b }}</b><span>{{ r.s }}</span></div>
          </div>
        </div>
        <div class="recall" v-else style="margin-top:14px">
          Досье пустое. Нажми «Редактировать» и запиши хотя бы одну зацепку — она всплывёт в нужный момент.
        </div>

        <template v-if="opened.family && opened.family.length">
          <div class="meta" style="margin-top:16px">семья</div>
          <div class="krow" v-for="m in opened.family" :key="m.id">
            <span class="kava">
              <img v-if="m.avatar" :src="'/avatars/' + m.avatar" alt="">
              <template v-else>{{ m.name.slice(0, 1) }}</template>
            </span>
            <div>
              <b>{{ m.name }}</b>
              <span>{{ m.label }}<template v-if="m.age !== null"> · {{ m.age }} {{ plural(m.age, 'год', 'года', 'лет') }}</template><template v-if="m.derived"> · авто</template></span>
            </div>
            <div class="kbd" v-if="m.birthday">
              др <b>{{ calDay(m.birthday) }} {{ calMon(m.birthday) }}</b>
            </div>
            <button class="mini" v-if="m.isStub" @click="activateFromCard(m.id)">в круг</button>
          </div>
        </template>

        <template v-if="opened.pets && opened.pets.length">
          <div class="meta" style="margin-top:16px">питомцы</div>
          <div class="krow" v-for="p in opened.pets" :key="'pet' + p.id">
            <button class="kava pet" @click="uploadAvatar('pet', p.id)">
              <img v-if="p.avatar" :src="'/avatars/' + p.avatar" alt="">
              <template v-else>🐾</template>
            </button>
            <div>
              <b>{{ p.name }}</b>
              <span>{{ [p.species, p.breed].filter(Boolean).join(' · ') || 'питомец' }}<template v-if="p.note"> · {{ p.note }}</template></span>
            </div>
            <div class="kbd" v-if="p.birthday">
              др <b>{{ calDay(p.birthday) }} {{ calMon(p.birthday) }}</b>
            </div>
          </div>
        </template>

        <template v-if="opened.tasks.length">
          <div class="meta" style="margin-top:16px">обязательства</div>
          <div class="list">
            <button v-for="t in opened.tasks" :key="t.id" @click="act('/task/' + t.id + '/close', { keepOpen: true })">
              <span class="bead" style="background:var(--owed)"></span>
              <span>{{ t.direction === 'i_owe' ? 'Ты: ' : 'Он: ' }}{{ t.body }}</span>
              <span class="tail">закрыть</span>
            </button>
          </div>
        </template>
      </template>

      <!-- ===== вкладка ИСТОРИЯ ===== -->
      <template v-else-if="cardTab === 'history'">
        <div class="focus calm" style="margin-top:14px" v-if="opened.lastOn">
          <div class="fl">Ритм связи</div>
          {{ opened.silent }} дн тишины при норме {{ opened.interval }}.
          За полгода — {{ touchesHalfYear }} {{ plural(touchesHalfYear, 'касание', 'касания', 'касаний') }}.
        </div>
        <div class="focus calm" style="margin-top:14px" v-else>
          <div class="fl">Ритм связи</div>
          Ни одного контакта не записано — человек не участвует в напоминаниях.
        </div>

        <template v-for="r in historyRows" :key="r.id">
          <div class="gap-row" v-if="r.kind === 'gap'">пауза {{ r.days }} {{ plural(r.days, 'день', 'дня', 'дней') }}</div>
          <div class="lrow" v-else>
            <div class="ic">{{ r.view.icon }}</div>
            <div>
              <b>{{ r.view.word }}</b>
              <div class="note" v-if="r.summary">{{ r.summary }}</div>
            </div>
            <div class="dt">{{ humanDate(r.on) }}</div>
          </div>
        </template>
        <p class="hint" v-if="!historyRows.length" style="margin-top:14px">
          Лента пуста. Отметь контакт кнопкой внизу — и после каждого будет вопрос «о чём говорили», из этого соберётся история.
        </p>
      </template>

      <!-- ===== вкладка ДАТЫ ===== -->
      <template v-else>
        <div class="drow2" v-for="d in dateRows" :key="d.id">
          <div class="cal"><b>{{ calDay(d.next) }}</b><span>{{ calMon(d.next) }}</span></div>
          <div class="what">
            <b>{{ d.title }}</b>
            <span>{{ d.sub }}</span>
          </div>
          <div class="in" :class="{ soon: d.days <= 14 }">{{ humanDays(d.days) }}</div>
          <button class="zap" v-if="d.eventId && d.days <= 30" @click="closeOccurrence(d)" title="Закрыть повод">✓</button>
        </div>
        <p class="hint" v-if="!dateRows.length" style="margin-top:14px">
          Дат пока нет. День рождения, защита, переезд — добавляются в правке, в блоке «Контакты и даты».
        </p>
      </template>

      <div class="acts">
        <button class="primary" @click="act('/person/' + opened.id + '/contact', { channel: 'message' })">Написал</button>
        <button @click="act('/person/' + opened.id + '/contact', { channel: 'call' })">Звонок</button>
        <button @click="act('/person/' + opened.id + '/contact', { channel: 'meeting' })">Встреча</button>
      </div>
      <div class="acts">
        <button @click="act('/person/' + opened.id + '/snooze', { days: 7 })">Отложить неделю</button>
        <button @click="openEdit">Редактировать</button>
      </div>
    </section>
  </Transition>

  <!-- ================= ПРАВКА ================= -->
  <Transition name="fade">
    <div v-if="editing" class="scrim" @click="editing = null"></div>
  </Transition>
  <Transition name="slide">
    <section v-if="editing" class="sheet edit">
      <div class="grab"></div>
      <h2>Правка</h2>

      <div class="acc" :class="{ open: block === 'main' }">
        <button class="acc-head" @click="toggleBlock('main')">Основное<i></i></button>
        <div class="acc-body" v-if="block === 'main'">

      <label>Имя</label>
      <input type="text" v-model="editing.name" autocapitalize="words">

      <label>Круг близости</label>
      <div class="rings-pick">
        <button type="button" v-for="c in circleLoad" :key="c.circle"
                :class="{ on: editing.circle === c.circle }" @click="editing.circle = c.circle">
          <span class="bead"></span><span>{{ c.label }}</span>
          <span class="cap" :class="{ over: c.n >= c.cap }">{{ c.n }} / {{ c.cap }}</span>
        </button>
      </div>

      <label>Как вам вместе</label>
      <div class="rate big">
        <button v-for="n in 5" :key="n" :class="{ on: n <= editing.rapport }"
                @click="editing.rapport = editing.rapport === n ? 0 : n"></button>
        <span class="hint" style="margin:0 0 0 10px">{{ ['не оценено','тяжело','прохладно','нормально','хорошо','отлично'][editing.rapport] }}</span>
      </div>

      <label>Свой интервал, дней</label>
      <input type="text" v-model="editing.interval" inputmode="numeric"
             :placeholder="'по кругу — ' + (opened ? opened.interval : '') + ' дн'">

      <label>Теги</label>
      <div class="chips">
        <button type="button" class="chip" v-for="t in tags" :key="t.tag"
                :class="{ on: editing.tags.includes(t.tag) }" @click="toggleEditTag(t.tag)">
          {{ t.tag }}<small>{{ t.n }}</small>
        </button>
      </div>
      <div class="row" style="margin-top:8px">
        <input type="text" v-model="editing.newTag" placeholder="новый тег"
               @keydown.enter.prevent="addEditTag" autocapitalize="none">
        <button type="button" class="btn ghost" style="flex:0 0 96px" @click="addEditTag">Добавить</button>
      </div>

      <label>Поправить дату последнего общения</label>
      <div class="chips">
        <button type="button" class="chip" v-for="w in WHEN" :key="w.label"
                :class="{ on: editing.lastContact === w.value() }" @click="editing.lastContact = w.value()">
          {{ w.label }}
        </button>
      </div>
      <p class="hint">Прошлые контакты не стираются — добавляется ещё один задним числом.</p>
        </div>
      </div>

      <div class="acc" :class="{ open: block === 'dreams' }">
        <button class="acc-head" @click="toggleBlock('dreams')">Цели и мечты<i></i></button>
        <div class="acc-body" v-if="block === 'dreams'">
          <textarea v-model="editing.dossier.dreams" rows="4"
                    placeholder="К чему идёт, о чём говорит с горящими глазами, чего опасается"></textarea>
          <p class="hint">Самый ценный блок досье и самый пустой у большинства. Один вопрос по нему стоит десяти дежурных сообщений.</p>
        </div>
      </div>

      <div class="acc" :class="{ open: block === 'dossier' }">
        <button class="acc-head" @click="toggleBlock('dossier')">Остальное досье<i></i></button>
        <div class="acc-body" v-if="block === 'dossier'">
          <template v-for="b in DOSSIER_BLOCKS" :key="b[0]">
            <template v-if="b[0] !== 'dreams'">
              <div class="meta" style="margin:12px 0 6px">{{ b[1] }}</div>
              <textarea v-model="editing.dossier[b[0]]" rows="2" :placeholder="b[1]"></textarea>
            </template>
          </template>
        </div>
      </div>

      <div class="acc" :class="{ open: block === 'family' }">
        <button class="acc-head" @click="toggleBlock('family')">
          Семья<span class="cnt" v-if="opened && opened.family.length">{{ opened.family.length }}</span><i></i>
        </button>
        <div class="acc-body" v-if="block === 'family'">
          <div class="list" v-if="opened && opened.family.length">
            <div v-for="m in opened.family" :key="m.id" class="kin-row">
              <span class="ava sm">
                <img v-if="m.avatar" :src="'/avatars/' + m.avatar" alt="">
                <span v-else>{{ m.name.slice(0, 1) }}</span>
              </span>
              <span class="kin-name">{{ m.name }}<em>{{ m.label }}<template v-if="m.derived"> · авто</template></em></span>
              <button class="mini" v-if="m.isStub" @click="activateMember(m.id)">в круг</button>
              <button class="mini danger-btn" @click="delMember(m.id)">×</button>
            </div>
          </div>

          <div class="meta" style="margin:16px 0 8px">добавить</div>
          <div class="row">
            <input type="text" v-model="newMember.name" placeholder="имя" autocapitalize="words">
            <select v-model="newMember.role">
              <option v-for="r in ROLES" :key="r[0]" :value="r[0]">{{ r[1] }}</option>
            </select>
          </div>
          <div class="row" style="margin-top:8px">
            <input type="text" v-model="newMember.birthday" placeholder="др 12.04" inputmode="numeric">
            <button type="button" class="btn ghost" style="flex:0 0 100px" @click="addMember">Добавить</button>
          </div>
          <p class="hint">Карточка создаётся сразу и связывается со всей роднёй: дети одного родителя автоматически становятся братьями и сёстрами, супруг родителя — родителем детей. Такие карточки не занимают место в кругах и не шлют напоминаний, пока не нажать «в круг».</p>
        </div>
      </div>

      <div class="acc" :class="{ open: block === 'pets' }">
        <button class="acc-head" @click="toggleBlock('pets')">
          Питомцы<span class="cnt" v-if="opened && opened.pets.length">{{ opened.pets.length }}</span><i></i>
        </button>
        <div class="acc-body" v-if="block === 'pets'">
          <div class="list" v-if="opened && opened.pets.length">
            <div v-for="p in opened.pets" :key="p.id" class="kin-row">
              <button class="ava sm" @click="uploadAvatar('pet', p.id)">
                <img v-if="p.avatar" :src="'/avatars/' + p.avatar" alt="">
                <span v-else>{{ p.name.slice(0, 1) }}</span>
              </button>
              <span class="kin-name">{{ p.name }}<em>{{ [p.species, p.breed].filter(Boolean).join(', ') || 'питомец' }}</em></span>
              <button class="mini danger-btn" @click="delPet(p.id)">×</button>
            </div>
          </div>

          <div class="meta" style="margin:16px 0 8px">добавить</div>
          <div class="row">
            <input type="text" v-model="newPet.name" placeholder="кличка">
            <input type="text" v-model="newPet.species" placeholder="кот, собака">
          </div>
          <div class="row" style="margin-top:8px">
            <input type="text" v-model="newPet.breed" placeholder="порода">
            <input type="text" v-model="newPet.birthday" placeholder="др 12.04" inputmode="numeric">
          </div>
          <textarea v-model="newPet.note" rows="2" placeholder="чем болеет, как зовут ласково" style="margin-top:8px"></textarea>
          <button type="button" class="btn ghost" style="margin-top:8px" @click="addPet">Добавить питомца</button>
          <p class="hint">Дата рождения питомца становится напоминанием тебе про хозяина: спросить про кота — часто теплее, чем спросить про работу.</p>
        </div>
      </div>

      <div class="acc" :class="{ open: block === 'contacts' }">
        <button class="acc-head" @click="toggleBlock('contacts')">Контакты и даты<i></i></button>
        <div class="acc-body" v-if="block === 'contacts'">
          <div class="row">
            <input type="text" v-model="editing.city" placeholder="город">
            <input type="text" v-model="editing.telegram" placeholder="@telegram" autocapitalize="none">
          </div>
          <textarea v-model="editing.context" rows="2" placeholder="как познакомились" style="margin-top:8px"></textarea>

          <div class="meta" style="margin:16px 0 8px">даты</div>
          <div class="list" v-if="opened && opened.events.length">
            <button v-for="e in opened.events" :key="e.id" @click="delEvent(e.id)">
              <span class="bead" style="background:var(--event)"></span>
              <span>{{ e.title }}</span>
              <span class="tail">{{ humanDays(e.days) }} · удалить</span>
            </button>
          </div>
          <div class="row" style="margin-top:8px">
            <input type="text" v-model="newEvent.date" placeholder="12.04" inputmode="numeric" style="flex:0 0 96px">
            <input type="text" v-model="newEvent.title" placeholder="Событие">
            <button type="button" class="btn ghost" style="flex:0 0 56px" @click="addEvent">+</button>
          </div>
        </div>
      </div>

      <div class="btns">
        <button class="btn" :disabled="!editing.name.trim() || saving" @click="saveEdit">Сохранить</button>
        <button class="btn ghost" @click="editing = null">Отмена</button>
      </div>

      <div class="danger">
        <div class="meta">убрать из базы</div>
        <div class="row" style="margin-top:10px">
          <button class="btn ghost" :class="{ armed: confirmStep === 'archive' }" @click="archivePerson">
            {{ confirmStep === 'archive' ? 'Точно в архив?' : 'В архив' }}
          </button>
          <button class="btn ghost danger-btn" :class="{ armed: confirmStep === 'delete' }" @click="deletePerson">
            {{ confirmStep === 'delete' ? 'Точно удалить?' : 'Удалить' }}
          </button>
        </div>
        <p class="hint">Архив прячет человека из карты и напоминаний, но сохраняет историю. Удаление стирает всё безвозвратно — только для дублей и ошибок.</p>
      </div>
    </section>
  </Transition>

  <Transition name="fade">
    <div v-if="toast" class="toast">{{ toast }}</div>
  </Transition>

  <nav>
    <button :class="{ on: tab === 'map' }" @click="tab = 'map'"><span class="dotmark"></span>Круг</button>
    <button :class="{ on: tab === 'add' }" @click="tab = 'add'"><span class="dotmark"></span>Добавить</button>
    <button :class="{ on: tab === 'roster' }" @click="tab = 'roster'"><span class="dotmark"></span>Разметка</button>
  </nav>
</template>
`,
};

createApp(App).mount('#app');
