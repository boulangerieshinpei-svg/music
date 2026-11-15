// 音楽理論ドリル。耳と鍵盤で、作曲に使う理論を反復して覚えるためのページ。
// 理論の計算と音の出し方は、作曲スケッチと同じ theory.js / audio.js を使う。

import {
  noteToPc, pcToNote, keyPrefersFlats, parseChord, intervalsFor,
  chordToneInfo, diatonicChords, midiToFreq,
} from './theory.js';
import { Player } from './audio.js';

const STORE_KEY = 'music-study-v1';
const ROUND = 10;
const KB_FROM = 48; // C3
const KB_TO = 71;   // B4

// ---------- 小道具 ----------

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const mod12 = (n) => ((n % 12) + 12) % 12;
const pretty = (s) => String(s).replace(/b5/g, '♭5').replace(/([A-G])b/g, '$1♭').replace(/#/g, '♯');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- 記録 ----------

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return { items: {}, lessons: {}, days: {}, ...s };
  } catch { /* 壊れていたら作り直す */ }
  return { items: {}, lessons: {}, days: {} };
}
let store = loadStore();
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* 保存できなくても続ける */ }
}
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function lessonStat(id) {
  if (!store.lessons[id]) store.lessons[id] = { n: 0, ok: 0, level: 1, recent: [], seenIntro: false };
  return store.lessons[id];
}
function record(lessonId, itemKey, ok) {
  const it = store.items[itemKey] || (store.items[itemKey] = { n: 0, ok: 0 });
  it.n += 1; if (ok) it.ok += 1;
  const ls = lessonStat(lessonId);
  ls.n += 1; if (ok) ls.ok += 1;
  ls.recent = [...ls.recent, ok ? 1 : 0].slice(-20);
  const d = dayKey();
  store.days[d] = (store.days[d] || 0) + 1;
  saveStore();
}
function streakDays() {
  let n = 0;
  const d = new Date();
  if (!store.days[dayKey(d)]) d.setDate(d.getDate() - 1); // 今日まだでも、昨日までの連続は見せる
  while (store.days[dayKey(d)]) { n += 1; d.setDate(d.getDate() - 1); }
  return n;
}

// ---------- 音 ----------

const player = new Player();
player.setVolume(0.8);

/** notes: [{midi, at, dur, gain?}]。at は秒 */
function playNotes(notes) {
  const ctx = player._ensureCtx();
  const t0 = ctx.currentTime + 0.06;
  for (const n of notes) {
    player._note(midiToFreq(n.midi), t0 + n.at, n.dur, n.gain ?? 0.2, 'triangle');
  }
}
function chordMidis(name, base = 48) {
  const c = parseChord(name);
  const root = base + c.rootPc;
  return intervalsFor(c.quality).map((iv) => root + iv);
}
/** バラしてから、まとめて鳴らす */
function playChord(name) {
  const ms = chordMidis(name);
  const step = 0.28;
  const notes = ms.map((m, i) => ({ midi: m, at: i * step, dur: 0.5 }));
  const t = ms.length * step + 0.15;
  ms.forEach((m) => notes.push({ midi: m, at: t, dur: 1.4, gain: 0.15 }));
  playNotes(notes);
}
function playProgression(names) {
  const bar = 1.0;
  const notes = [];
  names.forEach((name, i) => {
    const c = parseChord(name);
    notes.push({ midi: 36 + c.rootPc, at: i * bar, dur: bar * 0.95, gain: 0.26 });
    // 上の音が飛びすぎないよう、C4 のまわりに寄せる
    intervalsFor(c.quality).forEach((iv) => {
      notes.push({ midi: 55 + mod12(c.rootPc + iv - 7), at: i * bar, dur: bar * 0.95, gain: 0.13 });
    });
  });
  playNotes(notes);
}

// ---------- 理論の補助 ----------

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const MODE_JA = { major: 'メジャー', minor: 'マイナー' };

/** スケールの音名を、ドレミ…の文字が1つずつ並ぶように綴る */
function spellScale(key, mode) {
  const start = LETTERS.indexOf(key[0]);
  const rootPc = noteToPc(key);
  return SCALES[mode].map((iv, i) => {
    const letter = LETTERS[(start + i) % 7];
    const alter = ((mod12(rootPc + iv) - LETTER_PC[letter] + 18) % 12) - 6;
    return letter + (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter));
  });
}

const MAJOR_KEYS_EASY = ['C', 'G', 'F', 'D'];
const MAJOR_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db'];
const MINOR_KEYS = ['A', 'E', 'B', 'F#', 'C#', 'D', 'G', 'C', 'F'];
const MINOR_DEG = ['I', 'II', '♭III', 'IV', 'V', '♭VI', '♭VII'];

/** キーのダイアトニックを、度数ラベル付きで返す。例: {deg:'IIm7', name:'Dm7', idx:1} */
function diatonic(key, mode, seventh) {
  return diatonicChords(key, mode, seventh).map((d, i) => {
    const q = parseChord(d.name).quality;
    const base = mode === 'minor' ? MINOR_DEG[i] : d.degree;
    return { deg: base + q, name: d.name, idx: i };
  });
}

const INTERVALS = {
  1: '短2度', 2: '長2度', 3: '短3度', 4: '長3度', 5: '完全4度', 6: '増4度／減5度',
  7: '完全5度', 8: '短6度', 9: '長6度', 10: '短7度', 11: '長7度', 12: 'オクターブ',
};
const INTERVAL_FEEL = {
  1: 'ぶつかる。すぐ隣の音', 2: 'ドレ。階段を1段', 3: '暗い響きのもと', 4: '明るい響きのもと',
  5: '素直で硬い。ドファ', 6: '不安定。ドミナント7thの中にある', 7: 'いちばん安定。ドソ',
  8: '切なく広い', 9: '明るく広い', 10: '7thコードの濁り', 11: 'あと半音でオクターブ。お洒落で痛い',
  12: '同じ音の高い版',
};

const QUALITY_JA = {
  '': 'メジャー', m: 'マイナー', 7: 'セブンス', M7: 'メジャーセブンス', m7: 'マイナーセブンス',
  dim: 'ディミニッシュ', aug: 'オーギュメント', sus4: 'サスフォー', m7b5: 'マイナーセブンフラットファイブ',
  6: 'シックス', add9: 'アドナインス',
};
const QUALITY_FEEL = {
  '': '明るく安定', m: '暗め・切ない', 7: '濁りがあって、次へ進みたがる', M7: 'お洒落で浮遊感',
  m7: '柔らかく落ち着いた暗さ', dim: '詰まって不安定', aug: '浮いたまま落ち着かない',
  sus4: '解決待ちで宙ぶらりん', m7b5: '暗くて不安定。マイナーキーの II', 6: '明るくて少し懐かしい',
  add9: '明るさに透明感が足される',
};
const qLabel = (q) => (q === '' ? 'メジャー' : `${QUALITY_JA[q]}（${pretty(q)}）`);

function tonesText(name) {
  return chordToneInfo(name).map((t) => `${pretty(t.name)}(${t.degree})`).join('  ');
}

// ---------- 問題を作る ----------
// 返す形:
//   { key, prompt(HTML), sub?, kind:'choice'|'keys', sound?, choices?, cols?, answer,
//     explain, show?:{midis, root?}, tones?:[{name,degree}], label }
// key は「どの項目を間違えやすいか」を数えるための名前。

const LESSONS = [
  {
    id: 'interval',
    icon: '👂',
    name: '音程を耳で',
    desc: '2つの音の離れ具合を聴き分ける',
    intro: [
      '<b>音程</b>は2つの音の距離です。鍵盤で隣へ1つ進むのが<b>半音</b>。',
      'コードもメロディも音程の組み合わせなので、ここが聴き取れると耳コピが一気に楽になります。',
      'まずは <code>長3度（半音4つ）＝明るい</code>、<code>短3度（半音3つ）＝暗い</code>、<code>完全5度（半音7つ）＝安定</code> の3つから。',
    ],
    levels: ['3度・4度・5度', '6度・2度も', '全部＋下行'],
    make(level) {
      const set = level === 1 ? [3, 4, 5, 7, 12] : level === 2 ? [1, 2, 3, 4, 5, 7, 8, 9, 12] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const iv = pick(set);
      const low = 55 + rnd(10);
      const down = level === 3 && Math.random() < 0.35;
      const a = down ? low + iv : low;
      const b = down ? low : low + iv;
      const flats = Math.random() < 0.5;
      return {
        key: `iv:${iv}`,
        label: INTERVALS[iv],
        prompt: 'この2つの音の<em>音程</em>は？',
        sub: down ? '高い音 → 低い音 → 同時、の順に鳴ります' : '低い音 → 高い音 → 同時、の順に鳴ります',
        kind: 'choice',
        sound: () => playNotes([
          { midi: a, at: 0, dur: 0.7 }, { midi: b, at: 0.75, dur: 0.7 },
          { midi: a, at: 1.7, dur: 1.3, gain: 0.16 }, { midi: b, at: 1.7, dur: 1.3, gain: 0.16 },
        ]),
        choices: set.map((n) => ({ value: n, label: INTERVALS[n], small: `半音${n}つ` })),
        answer: iv,
        explain: `${INTERVALS[iv]}＝半音${iv}つ。${INTERVAL_FEEL[iv]}。\n今の音は ${pretty(pcToNote(low, flats))} と ${pretty(pcToNote(low + iv, flats))} でした。`,
        show: { midis: [low, low + iv].map(fitKb), root: fitKb(low) },
      };
    },
  },
  {
    id: 'chordear',
    icon: '🎧',
    name: 'コードの種類を耳で',
    desc: 'メジャー／マイナー／7th を響きで当てる',
    intro: [
      'コードの名前の後ろ（<code>m</code> <code>7</code> <code>M7</code> など）は<b>響きの種類</b>を表します。',
      'ルートが何であっても、種類が同じなら同じ「色」に聞こえます。その色を覚える練習です。',
      '迷ったら「明るいか暗いか」→「濁っているか澄んでいるか」の順に考えると絞れます。',
    ],
    levels: ['メジャー／マイナー', '7th 3種も', 'dim・aug・sus4 も'],
    make(level) {
      const set = level === 1 ? ['', 'm'] : level === 2 ? ['', 'm', '7', 'M7', 'm7'] : ['', 'm', '7', 'M7', 'm7', 'dim', 'aug', 'sus4', 'm7b5'];
      const q = pick(set);
      const root = pcToNote(rnd(12), Math.random() < 0.5);
      const name = root + q;
      return {
        key: `ce:${q}`,
        label: qLabel(q),
        prompt: 'このコードの<em>種類</em>は？',
        sub: '1音ずつ → まとめて、の順に鳴ります',
        kind: 'choice',
        sound: () => playChord(name),
        choices: set.map((s) => ({ value: s, label: QUALITY_JA[s], small: s === '' ? '何も付かない' : pretty(s) })),
        cols: set.length === 2 ? 2 : set.length === 9 ? 3 : 2,
        answer: q,
        explain: `${pretty(name)}（${QUALITY_JA[q]}）。${QUALITY_FEEL[q]}。`,
        show: { midis: chordMidis(name).map(fitKb), root: fitKb(chordMidis(name)[0]) },
        tones: chordToneInfo(name),
      };
    },
  },
  {
    id: 'chordtones',
    icon: '🎹',
    name: 'コードを押さえる',
    desc: 'コード名を見て、構成音を鍵盤で押さえる',
    intro: [
      'コードは<b>ルートから決まった間隔で音を積む</b>だけです。形を覚えれば、どのルートでも作れます。',
      '<code>メジャー</code>＝ルート・半音4つ上・さらに3つ上。<code>マイナー</code>＝ルート・3つ上・さらに4つ上。',
      '<code>7</code> は上に短7度（ルートの全音下）、<code>M7</code> は長7度（ルートの半音下）を足します。',
      'オクターブはどこでも正解です。押さえる音の種類が合っていれば OK。',
    ],
    levels: ['白鍵ルートの3和音', '7th・黒鍵ルート', 'dim・sus4 なども'],
    make(level) {
      const roots = level === 1 ? ['C', 'D', 'E', 'F', 'G', 'A', 'B']
        : ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Bb', 'Eb', 'Ab', 'F#', 'C#'];
      const quals = level === 1 ? ['', 'm'] : level === 2 ? ['', 'm', '7', 'M7', 'm7']
        : ['7', 'M7', 'm7', 'dim', 'aug', 'sus4', 'm7b5', '6', 'add9'];
      const q = pick(quals);
      const name = pick(roots) + q;
      const info = chordToneInfo(name);
      return {
        key: `ct:${q}`,
        label: pretty(name),
        prompt: `<em>${pretty(name)}</em> を押さえてください`,
        sub: `${QUALITY_JA[q]}コード。音は${info.length}つ`,
        kind: 'keys',
        answer: [...new Set(info.map((t) => t.pc))],
        rootPc: info[0].pc,
        explain: `${pretty(name)} の構成音は下のとおり。${QUALITY_FEEL[q]}。`,
        tones: info,
        after: () => playChord(name),
      };
    },
  },
  {
    id: 'scale',
    icon: '🪜',
    name: 'スケールを押さえる',
    desc: 'キーで使う7つの音を鍵盤で押さえる',
    intro: [
      '<b>キー</b>とは「この曲で主に使う7つの音」のこと。その7音を並べたのがスケールです。',
      'メジャースケールは主音から <code>全・全・半・全・全・全・半</code> の間隔で進みます（全＝半音2つ）。',
      'マイナースケールは <code>全・半・全・全・半・全・全</code>。同じ7音を使うメジャーが必ず1つあります（A マイナーと C メジャーなど）。',
      'オクターブはどこでも正解です。7種類の音が合っていれば OK。',
    ],
    levels: ['C・G・F・D', 'メジャー全部', 'マイナーも'],
    make(level) {
      const mode = level === 3 && Math.random() < 0.6 ? 'minor' : 'major';
      const key = mode === 'minor' ? pick(MINOR_KEYS) : pick(level === 1 ? MAJOR_KEYS_EASY : MAJOR_KEYS);
      const names = spellScale(key, mode);
      const rootPc = noteToPc(key);
      return {
        key: `sc:${mode}:${key}`,
        label: `${pretty(key)} ${MODE_JA[mode]}`,
        prompt: `<em>${pretty(key)} ${MODE_JA[mode]}</em>スケールの音を全部押さえてください`,
        sub: mode === 'major' ? '主音から 全・全・半・全・全・全・半' : '主音から 全・半・全・全・半・全・全',
        kind: 'keys',
        answer: SCALES[mode].map((iv) => mod12(rootPc + iv)),
        rootPc,
        explain: `${pretty(key)} ${MODE_JA[mode]}スケール。黒鍵は${names.filter((n) => n.length > 1).length}つ。`,
        tones: names.map((n, i) => ({ name: n, degree: String(i + 1) })),
        after: () => {
          const base = 48 + rootPc;
          playNotes([...SCALES[mode], 12].map((iv, i) => ({ midi: base + iv, at: i * 0.22, dur: 0.3 })));
        },
      };
    },
  },
  {
    id: 'diatonic',
    icon: '🔢',
    name: 'ダイアトニックコード',
    desc: 'キーの中の I〜VII 番目のコードを言える',
    intro: [
      'スケールの7音だけで作れるコードが<b>ダイアトニックコード</b>。曲の大半はこの7つでできています。',
      'メジャーキーは必ず <code>I  IIm  IIIm  IV  V  VIm  VIIdim</code> の並び（7th なら <code>IM7 IIm7 IIIm7 IVM7 V7 VIm7 VIIm7♭5</code>）。',
      '番号で覚えると、「王道進行＝4-5-3-6」のように、どのキーでも同じ進行を作れるようになります。',
    ],
    levels: ['C・G・F・D の3和音', '全メジャーキー・7th', 'マイナーキーも'],
    make(level) {
      const mode = level === 3 && Math.random() < 0.6 ? 'minor' : 'major';
      const key = mode === 'minor' ? pick(MINOR_KEYS) : pick(level === 1 ? MAJOR_KEYS_EASY : MAJOR_KEYS);
      const list = diatonic(key, mode, level > 1);
      const target = pick(list);
      const others = shuffle(list.filter((d) => d !== target)).slice(0, 3);
      const opts = shuffle([target, ...others]);
      const keyJa = `キー ${pretty(key)} ${MODE_JA[mode]}`;
      const all = list.map((d) => `${pretty(d.deg)}=${pretty(d.name)}`).join('  ');
      const forward = Math.random() < 0.5;
      return {
        key: `dia:${mode}:${target.idx}`,
        label: `${keyJa}の ${pretty(target.deg)}`,
        prompt: forward
          ? `${keyJa}の <em>${pretty(target.deg)}</em> は？`
          : `${keyJa}で <em>${pretty(target.name)}</em> は何番目？`,
        kind: 'choice',
        choices: opts.map((d) => ({ value: d.idx, label: pretty(forward ? d.name : d.deg) })),
        answer: target.idx,
        explain: `${keyJa}の ${pretty(target.deg)} は ${pretty(target.name)}。\n${all}`,
        show: { midis: chordMidis(target.name).map(fitKb), root: fitKb(chordMidis(target.name)[0]) },
        tones: chordToneInfo(target.name),
        after: () => playChord(target.name),
      };
    },
  },
  {
    id: 'function',
    icon: '🧭',
    name: 'コードの働き',
    desc: 'トニック／サブドミナント／ドミナントを見分ける',
    intro: [
      'ダイアトニックコードは働きで3つに分かれます。',
      '<b>トニック（T）</b>＝安定・帰る場所：<code>I  IIIm  VIm</code>',
      '<b>サブドミナント（SD）</b>＝動き出す・広がる：<code>IV  IIm</code>',
      '<b>ドミナント（D）</b>＝緊張して I に戻りたがる：<code>V  VIIdim</code>',
      '進行が気持ちいい理由は、たいてい「T → SD → D → T」の流れで説明がつきます。',
    ],
    levels: ['C・G・F・D', '全メジャーキー・7th', 'IVm（切ないやつ）も'],
    make(level) {
      const key = pick(level === 1 ? MAJOR_KEYS_EASY : MAJOR_KEYS);
      const list = diatonic(key, 'major', level > 1);
      const FUNC = ['T', 'SD', 'T', 'SD', 'D', 'T', 'D'];
      const NAME = { T: 'トニック', SD: 'サブドミナント', D: 'ドミナント' };
      const FEEL = { T: '安定して落ち着く場所', SD: '動き出して景色が広がる', D: '緊張して I へ戻りたがる' };
      let target = pick(list);
      let func = FUNC[target.idx];
      let extra = '';
      if (level === 3 && Math.random() < 0.25) {
        const iv = list[3];
        const root = parseChord(iv.name).root;
        target = { deg: 'IVm7', name: root + 'm7', idx: 7 };
        func = 'SD';
        extra = '\nキーの外から借りてきた「サブドミナントマイナー」。IV を暗くした形で、働きは同じサブドミナント。J-POP の切ない場面の定番です。';
      }
      return {
        key: `fn:${target.idx}`,
        label: `${pretty(target.deg)} の働き`,
        prompt: `キー ${pretty(key)} メジャーで <em>${pretty(target.name)}</em> の働きは？`,
        kind: 'choice',
        cols: 1,
        choices: ['T', 'SD', 'D'].map((f) => ({ value: f, label: NAME[f], small: FEEL[f] })),
        answer: func,
        explain: `${pretty(target.name)} はこのキーの ${pretty(target.deg)}。${NAME[func]}＝${FEEL[func]}。${extra}`,
        after: () => playProgression([target.name, list[0].name]),
      };
    },
  },
  {
    id: 'progression',
    icon: '🎼',
    name: '定番進行を耳で',
    desc: '王道・小室・カノンなどを聴いて当てる',
    intro: [
      'J-POP やボカロでよく出る進行を、<b>番号（度数）の並び</b>として耳で覚えます。',
      'キーは毎回変わりますが、番号の並びが同じなら同じ進行に聞こえます。',
      'コツは<b>いちばん低い音（ベース）の動き</b>を追うこと。上がっているか、下がっているか、どこで落ち着くか。',
    ],
    levels: ['王道・小室・カノン', '1625・1564 も', '全部'],
    make(level) {
      const all = [
        { id: 'oudou', name: '王道進行', degs: 'IV → V → IIIm → VIm', ch: [[5, ''], [7, ''], [4, 'm'], [9, 'm']], note: '明るく始まって切なく着地する' },
        { id: 'komuro', name: '小室進行', degs: 'VIm → IV → V → I', ch: [[9, 'm'], [5, ''], [7, ''], [0, '']], note: '暗く始まって明るく抜ける。疾走感' },
        { id: 'canon', name: 'カノン進行（前半）', degs: 'I → V → VIm → IIIm', ch: [[0, ''], [7, ''], [9, 'm'], [4, 'm']], note: 'I から順に下がっていく安定感' },
        { id: '1625', name: '循環コード', degs: 'I → VIm → IIm → V', ch: [[0, ''], [9, 'm'], [2, 'm'], [7, '']], note: 'ぐるぐる回って I に戻りたくなる' },
        { id: '1564', name: 'ポップパンク進行', degs: 'I → V → VIm → IV', ch: [[0, ''], [7, ''], [9, 'm'], [5, '']], note: '洋楽ヒットの定番。最後が IV で開ける' },
        { id: '251', name: 'ツーファイブワン', degs: 'IIm → V → I → I', ch: [[2, 'm'], [7, ''], [0, ''], [0, '']], note: 'SD → D → T。いちばん素直な解決' },
        { id: 'city', name: 'シティポップ下降', degs: 'IV → IIIm → IIm → V', ch: [[5, ''], [4, 'm'], [2, 'm'], [7, '']], note: '1つずつ下がってから V で持ち上げる' },
      ];
      const set = all.slice(0, level === 1 ? 3 : level === 2 ? 5 : 7);
      const p = pick(set);
      const key = pick(MAJOR_KEYS);
      const flats = keyPrefersFlats(key, 'major');
      const names = p.ch.map(([iv, q]) => pcToNote(noteToPc(key) + iv, flats) + q);
      return {
        key: `pg:${p.id}`,
        label: p.name,
        prompt: 'この<em>コード進行</em>はどれ？',
        sub: '4小節ぶん鳴ります',
        kind: 'choice',
        cols: 1,
        sound: () => playProgression(names),
        choices: set.map((s) => ({ value: s.id, label: s.name, small: s.degs })),
        answer: p.id,
        explain: `${p.name}（${p.degs}）。${p.note}。\n今のはキー ${pretty(key)} で ${names.map(pretty).join(' → ')} でした。`,
      };
    },
  },
];
const lessonById = (id) => LESSONS.find((l) => l.id === id);

/** 鍵盤に収まる高さへ寄せる */
function fitKb(midi) {
  let m = midi;
  while (m < KB_FROM) m += 12;
  while (m > KB_TO) m -= 12;
  return m;
}

/** 苦手な項目が出やすいように、候補をいくつか作って重み付きで選ぶ */
function nextQuestion(lessonId, prevKey) {
  const mk = () => {
    const l = lessonId === 'mix' ? pick(LESSONS) : lessonById(lessonId);
    const q = l.make(lessonStat(l.id).level);
    q.lessonId = l.id;
    return q;
  };
  const cands = Array.from({ length: 6 }, mk).filter((q) => q.key !== prevKey);
  if (!cands.length) return mk();
  const weights = cands.map((q) => {
    const it = store.items[q.key];
    return it ? 1 + 4 * (1 - it.ok / it.n) : 2.5;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

// ---------- 鍵盤 ----------

const isBlack = (midi) => [1, 3, 6, 8, 10].includes(mod12(midi));

/**
 * @param {{small?:boolean, onTap?:(midi:number)=>void}} opts
 * onTap が無ければ表示専用。
 */
function makeKeyboard({ small = false, onTap = null } = {}) {
  const el = h('div', { class: `kb${small ? ' small' : ''}${onTap ? '' : ' readonly'}` });
  const keys = new Map();
  const whites = [];
  for (let m = KB_FROM; m <= KB_TO; m++) if (!isBlack(m)) whites.push(m);
  const ww = 100 / whites.length;
  const add = (m, cls, style) => {
    const b = h('button', { class: cls, type: 'button', style, tabindex: onTap ? '0' : '-1', 'aria-label': pcToNote(m) });
    if (onTap) b.addEventListener('click', () => onTap(m));
    keys.set(m, b);
    el.append(b);
  };
  whites.forEach((m) => add(m, `w${mod12(m) === 0 ? ' c' : ''}`, ''));
  whites.forEach((m, i) => {
    const up = m + 1;
    if (up <= KB_TO && isBlack(up)) {
      add(up, 'b', `left:${(i + 1) * ww - ww * 0.3}%;width:${ww * 0.6}%`);
    }
  });
  return {
    el,
    mark(midi, cls, on = true) { keys.get(midi)?.classList.toggle(cls, on); },
    clear() { keys.forEach((k) => k.classList.remove('sel', 'root', 'good', 'miss', 'bad')); },
  };
}

// ---------- 画面 ----------

const view = document.getElementById('view');
const topTitle = document.getElementById('topTitle');
const btnHome = document.getElementById('btnHome');
btnHome.addEventListener('click', () => showHome());

function setTop(title, home) {
  topTitle.textContent = title;
  btnHome.hidden = home;
  document.title = home ? '音楽理論ドリル' : `${title}｜音楽理論ドリル`;
}

function showHome() {
  setTop('音楽理論ドリル', true);
  const today = store.days[dayKey()] || 0;
  const total = Object.values(store.lessons).reduce((a, l) => a + l.n, 0);
  view.replaceChildren(
    h('div', { class: 'today' },
      h('div', { class: 'stat' }, h('b', {}, today), h('span', {}, '今日といた数')),
      h('div', { class: 'stat' }, h('b', {}, streakDays()), h('span', {}, '連続日数')),
      h('div', { class: 'stat' }, h('b', {}, total), h('span', {}, 'これまでの合計')),
    ),
    h('button', { class: 'mix-btn', onclick: () => startRound('mix') },
      '▶ おまかせ10問',
      h('small', {}, '全部の単元から、苦手なものを多めに出します'),
    ),
    h('h2', { class: 'sec-title' }, '単元をえらぶ'),
    h('div', { class: 'lessons' }, LESSONS.map((l) => {
      const s = lessonStat(l.id);
      const rate = s.n ? Math.round((s.ok / s.n) * 100) : null;
      return h('button', { class: 'lesson', onclick: () => startRound(l.id) },
        h('span', { class: 'ico' }, l.icon),
        h('span', {}, h('div', { class: 'name' }, l.name), h('div', { class: 'desc' }, l.desc)),
        h('span', { class: 'meta' }, h('b', {}, rate === null ? '—' : `${rate}%`), `Lv.${s.level}・${s.n}問`),
        h('span', { class: 'bar' }, h('i', { style: `width:${rate ?? 0}%` })),
      );
    })),
    h('p', { class: 'foot-note' },
      '記録はこの端末のブラウザに保存されます。 ',
      h('button', { onclick: resetAll }, '記録を消す'),
    ),
  );
  window.scrollTo(0, 0);
}

function resetAll() {
  if (!confirm('これまでの記録をすべて消します。元に戻せません。よろしいですか？')) return;
  store = { items: {}, lessons: {}, days: {} };
  saveStore();
  showHome();
}

let round = null;

function startRound(lessonId) {
  round = { lessonId, results: [], misses: [], prevKey: null };
  showQuestion();
}

function showQuestion() {
  const { lessonId } = round;
  const q = nextQuestion(lessonId, round.prevKey);
  round.prevKey = q.key;
  const lesson = lessonById(q.lessonId);
  const ls = lessonStat(q.lessonId);
  setTop(lessonId === 'mix' ? 'おまかせ10問' : lesson.name, false);

  const head = h('div', { class: 'q-head' });
  if (lessonId !== 'mix') {
    head.append(h('div', { class: 'levels' }, lesson.levels.map((label, i) =>
      h('button', {
        class: ls.level === i + 1 ? 'on' : '',
        title: label,
        onclick: () => { ls.level = i + 1; saveStore(); showQuestion(); },
      }, `Lv.${i + 1}`))));
  }
  head.append(h('span', { class: 'progress' }, `${round.results.length + 1} / ${ROUND}`));
  head.append(h('div', { class: 'dots' }, Array.from({ length: ROUND }, (_, i) => {
    const r = round.results[i];
    return h('i', { class: r === undefined ? (i === round.results.length ? 'now' : '') : r ? 'ok' : 'ng' });
  })));

  const intro = lessonId === 'mix' ? null : h('details', { class: 'intro', open: !ls.seenIntro },
    h('summary', {}, `解説：${lesson.name}（Lv.${ls.level} ${lesson.levels[ls.level - 1]}）`),
    lesson.intro.map((t) => h('p', { html: t })),
  );
  if (intro && !ls.seenIntro) { ls.seenIntro = true; saveStore(); }

  const card = h('div', { class: 'card' });
  if (lessonId === 'mix') card.append(h('div', { class: 'tag' }, `${lesson.icon} ${lesson.name}`));
  card.append(h('p', { class: 'prompt', html: q.prompt }));
  if (q.sub) card.append(h('p', { class: 'sub' }, q.sub));
  if (q.sound) card.append(h('button', { class: 'listen', onclick: q.sound }, '▶ もう一度聴く'));

  const resultBox = h('div', {});
  let done = false;

  const finish = (ok, kb) => {
    done = true;
    record(q.lessonId, q.key, ok);
    round.results.push(ok);
    if (!ok) round.misses.push(q.label);

    const box = h('div', { class: 'result' },
      h('div', { class: `verdict ${ok ? 'ok' : 'ng'}` }, ok ? '○ 正解' : '× ちがいます'),
      h('p', { class: 'explain' }, q.explain),
    );
    if (q.tones) {
      box.append(h('div', { class: 'tones' }, q.tones.map((t) =>
        h('span', {}, pretty(t.name), h('small', {}, t.degree)))));
    }
    if (q.show && !kb) {
      const k = makeKeyboard({ small: true });
      q.show.midis.forEach((m) => k.mark(m, m === q.show.root ? 'root' : 'sel'));
      box.append(k.el);
    }
    const replay = q.after || q.sound;
    if (replay) box.append(h('button', { class: 'replay', onclick: replay }, '▶ 音で確かめる'));
    const last = round.results.length >= ROUND;
    const next = h('button', { class: 'next', onclick: () => (last ? showRoundEnd() : showQuestion()) },
      last ? '結果を見る' : '次へ');
    box.append(next);
    resultBox.replaceChildren(box);
    if (q.after && q.kind === 'keys') q.after();
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  if (q.kind === 'choice') {
    const cols = q.cols ?? 2;
    const wrap = h('div', { class: `choices${cols === 1 ? ' one' : cols === 3 ? ' three' : ''}` });
    q.choices.forEach((c) => {
      const b = h('button', { type: 'button' }, c.label, c.small ? h('small', {}, c.small) : null);
      b.dataset.value = String(c.value);
      b.addEventListener('click', () => {
        if (done) return;
        const ok = c.value === q.answer;
        wrap.querySelectorAll('button').forEach((x) => {
          x.disabled = true;
          if (x.dataset.value === String(q.answer)) x.classList.add('right');
        });
        if (!ok) b.classList.add('wrong');
        finish(ok, null);
      });
      wrap.append(b);
    });
    card.append(wrap);
  } else {
    const selected = new Set();
    const count = h('div', { class: 'count' });
    const check = h('button', { class: 'check', disabled: true }, '答え合わせ');
    const upd = () => {
      const pcs = new Set([...selected].map(mod12));
      count.textContent = `${pcs.size} / ${q.answer.length} 音`;
      check.disabled = selected.size === 0;
    };
    const kb = makeKeyboard({
      onTap: (m) => {
        if (done) return;
        if (selected.has(m)) selected.delete(m); else selected.add(m);
        kb.mark(m, 'sel', selected.has(m));
        if (selected.has(m)) playNotes([{ midi: m, at: 0, dur: 0.4 }]);
        upd();
      },
    });
    check.addEventListener('click', () => {
      if (done) return;
      const want = new Set(q.answer);
      const got = new Set([...selected].map(mod12));
      const ok = want.size === got.size && [...want].every((pc) => got.has(pc));
      kb.clear();
      // 押した鍵は ○× を付け、押し忘れた音は主音に近い所へ1つだけ示す
      selected.forEach((m) => kb.mark(m, want.has(mod12(m)) ? 'good' : 'bad'));
      const base = KB_FROM + (q.rootPc ?? 0);
      want.forEach((pc) => {
        if (got.has(pc)) return;
        kb.mark(fitKb(base + mod12(pc - (q.rootPc ?? 0))), 'miss');
      });
      check.remove();
      count.replaceWith(h('div', { class: 'legend' },
        h('span', {}, h('i', { style: 'background:#4ec9a5' }), '合っている'),
        ok ? null : h('span', {}, h('i', { style: 'background:#e8756a' }), '余分'),
        ok ? null : h('span', {}, h('i', { style: 'background:#f1d98a' }), '押し忘れ'),
      ));
      finish(ok, kb);
    });
    card.append(kb.el, count, check);
    upd();
  }

  card.append(resultBox);
  view.replaceChildren(head, intro ?? '', card);
  window.scrollTo(0, 0);
  // 耳の問題は、画面を出したらすぐ鳴らす（直前のタップがあるので、ブラウザの自動再生制限にはかからない）
  if (q.sound) q.sound();
}

function showRoundEnd() {
  const { lessonId, results, misses } = round;
  const ok = results.filter(Boolean).length;
  const lesson = lessonId === 'mix' ? null : lessonById(lessonId);
  setTop(lesson ? lesson.name : 'おまかせ10問', false);

  let msg = ok === ROUND ? '全問正解です。' : ok >= 8 ? 'よく取れています。' : ok >= 5 ? '半分以上取れました。間違えた所を次で拾いましょう。' : 'まだ慣れていない単元です。解説をもう一度見てから、同じレベルで繰り返すのが近道です。';
  let levelUp = null;
  if (lesson) {
    const ls = lessonStat(lesson.id);
    if (ok >= 8 && ls.level < lesson.levels.length) {
      msg += ` Lv.${ls.level + 1}（${lesson.levels[ls.level]}）に進めます。`;
      levelUp = () => { ls.level += 1; saveStore(); startRound(lesson.id); };
    }
  }
  const uniq = [...new Set(misses)];
  view.replaceChildren(h('div', { class: 'card round' },
    h('div', { class: 'score' }, ok, h('small', {}, ` / ${ROUND}`)),
    h('p', {}, msg),
    uniq.length ? h('div', { class: 'miss-list' }, h('b', {}, '間違えたもの（次から多めに出ます）'), uniq.join('、')) : null,
    h('div', { class: 'row' },
      h('button', { onclick: showHome }, 'メニューへ'),
      levelUp
        ? h('button', { class: 'primary', onclick: levelUp }, '次のレベルへ')
        : h('button', { class: 'primary', onclick: () => startRound(lessonId) }, 'もう10問'),
    ),
    levelUp ? h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { onclick: () => startRound(lessonId) }, '同じレベルでもう10問')) : null,
  ));
  window.scrollTo(0, 0);
}

showHome();
