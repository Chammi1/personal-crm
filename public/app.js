import { createApp, ref, computed, onMounted, nextTick } from '/vendor/vue.js';

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

const App = {
  setup() {
    const tab = ref('map');
    const state = ref(null);
    const loading = ref(true);
    const mode = ref('today');
    const toast = ref('');
    const opened = ref(null);
    const tags = ref([]);

    // ---- форма добавления; круг и теги липкие между сохранениями
    const form = ref({
      name: '', circle: 3, tags: [], lastContact: iso(0),
      birthday: '', city: '', context: '', newTag: '', more: false,
    });
    const saving = ref(false);
    const nameInput = ref(null);

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
      } catch (e) {
        toast.value = 'Нет доступа: ' + e.message;
      } finally {
        loading.value = false;
      }
    }

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
    async function open(id) {
      opened.value = await call('/person/' + id);
    }
    async function act(path, body) {
      await call(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      const id = opened.value.id;
      opened.value = null;
      await load();
      flash('Записал');
      if (body?.keepOpen) await open(id);
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

    async function save(again) {
      if (!form.value.name.trim() || saving.value) return;
      saving.value = true;
      try {
        await call('/person', {
          method: 'POST',
          body: JSON.stringify({
            name: form.value.name.trim(),
            circle: form.value.circle,
            tags: form.value.tags,
            lastContact: form.value.lastContact || null,
            birthday: form.value.birthday || null,
            city: form.value.city || null,
            context: form.value.context || null,
          }),
        });
        const kept = { circle: form.value.circle, tags: [...form.value.tags] };
        form.value = {
          name: '', circle: kept.circle, tags: kept.tags, lastContact: iso(0),
          birthday: '', city: '', context: '', newTag: '', more: false,
        };
        await load();
        const st = state.value.intake;
        flash(`Добавлен. Сегодня ${st.addedToday} из ${st.quota}`);
        if (again) { await nextTick(); nameInput.value?.focus(); }
        else tab.value = 'roster';
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
      sectorLabel, sectorEdge, lit, ghosts, nodeRadius, nodeColor, showLabel, labelPos, shortWhy,
      headline, subline, circleLoad, open, act, toggleTag, addNewTag, save, anotherPrompt, load, flash,
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

  <!-- ================= ДОБАВИТЬ ================= -->
  <template v-if="tab === 'add'">
    <header class="head">
      <div class="eyebrow">
        <span>новый человек</span>
        <span>{{ state.intake.addedToday }} / {{ state.intake.quota }} сегодня</span>
      </div>
      <h1>Кто это?</h1>
    </header>

    <form @submit.prevent="save(true)">
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
        Без даты человек сохранится, но не будет попадать в напоминания. Лучше поставить хотя бы примерно.
      </p>

      <button type="button" class="btn ghost" style="margin-top:20px"
              @click="form.more = !form.more">{{ form.more ? 'Свернуть' : 'Ещё поля' }}</button>

      <template v-if="form.more">
        <label>День рождения</label>
        <input type="text" v-model="form.birthday" placeholder="12.04 или 12.04.1991" inputmode="numeric">
        <label>Город</label>
        <input type="text" v-model="form.city" placeholder="Москва">
        <label>Как познакомились</label>
        <textarea v-model="form.context" rows="2" placeholder="забег в Сокольниках, познакомил Тимур"></textarea>
      </template>

      <div class="btns">
        <button type="submit" class="btn" :disabled="!form.name.trim() || saving">Сохранить и добавить ещё</button>
        <button type="button" class="btn ghost" :disabled="!form.name.trim() || saving" @click="save(false)">
          Сохранить и закончить
        </button>
      </div>
      <p class="hint">Круг и теги остаются между сохранениями — так одна пачка людей из одного контекста вводится за минуту.</p>
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

  <!-- ================= КАРТОЧКА ================= -->
  <Transition name="fade">
    <div v-if="opened" class="scrim" @click="opened = null"></div>
  </Transition>
  <Transition name="slide">
    <section v-if="opened" class="sheet">
      <div class="grab"></div>
      <h2>{{ opened.name }}</h2>
      <div class="meta">
        круг {{ opened.circle }} · {{ opened.circleLabel }}
        <template v-if="opened.city"> · {{ opened.city }}</template>
      </div>

      <div class="why-row" v-if="opened.lastOn">
        <i :style="{ background: opened.silent > opened.interval ? 'var(--late)' : 'var(--fresh)' }"></i>
        <span>Последний контакт {{ humanDate(opened.lastOn) }} — {{ opened.silent }} дн назад при норме {{ opened.interval }}.</span>
      </div>
      <div class="why-row" v-else>
        <i style="background:var(--ink-faint)"></i>
        <span>Дата общения не указана — человек не попадает в напоминания.</span>
      </div>

      <div class="recall" v-if="opened.dossier && (opened.dossier.family || opened.dossier.occupation || opened.dossier.recreation || opened.dossier.dreams)">
        <div v-if="opened.dossier.family"><b>Семья:</b> {{ opened.dossier.family }}</div>
        <div v-if="opened.dossier.occupation"><b>Работа:</b> {{ opened.dossier.occupation }}</div>
        <div v-if="opened.dossier.recreation"><b>Увлечения:</b> {{ opened.dossier.recreation }}</div>
        <div v-if="opened.dossier.dreams"><b>Планы:</b> {{ opened.dossier.dreams }}</div>
      </div>
      <div class="recall" v-else>Досье пустое. Заполни блоки в боте: <b>/f семья ...</b></div>

      <template v-if="opened.events.length">
        <div class="meta" style="margin-top:16px">даты</div>
        <div class="list">
          <div v-for="e in opened.events" :key="e.id" style="padding:9px 2px;border-bottom:1px solid var(--line);font-size:14px;display:flex">
            <span>{{ e.title }}</span>
            <span class="tail">{{ humanDays(e.days) }}</span>
          </div>
        </div>
      </template>

      <template v-if="opened.tasks.length">
        <div class="meta" style="margin-top:16px">обязательства</div>
        <div class="list">
          <button v-for="t in opened.tasks" :key="t.id" @click="act('/task/' + t.id + '/close')">
            <span class="bead" style="background:var(--owed)"></span>
            <span>{{ t.direction === 'i_owe' ? 'Ты: ' : 'Он: ' }}{{ t.body }}</span>
            <span class="tail">закрыть</span>
          </button>
        </div>
      </template>

      <div class="acts">
        <button class="primary" @click="act('/person/' + opened.id + '/contact', { channel: 'message' })">Написал</button>
        <button @click="act('/person/' + opened.id + '/contact', { channel: 'call' })">Звонок</button>
        <button @click="act('/person/' + opened.id + '/contact', { channel: 'meeting' })">Встреча</button>
      </div>
      <div class="acts">
        <button @click="act('/person/' + opened.id + '/snooze', { days: 7 })">Отложить неделю</button>
        <button @click="opened = null">Закрыть</button>
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
