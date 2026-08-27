// 画面の組み立てとイベント配線

import {
  KEYS, MODES, diatonicChords, spiceChords, PROGRESSIONS, progressionInKey, parseChord,
  midiToFreq, scaleIndexName, chordToneInfo, analyzeChord, midiToFreq as freqOf,
} from './theory.js';
import { countMora, hasKanji } from './mora.js';
import {
  ROLES, defaultProject, normalizeProject, makeSection, makeBar, transposeProject,
  saveSettings, loadSettings, totalBars, estimateSeconds, lyricsToText,
  PATTERN_IDS,
} from './state.js';
import {
  loadIndex, saveSong, loadSong, deleteSong, duplicateSong,
  currentId, setCurrentId, migrateLegacy, resolveOpening, newSongId, StorageFullError,
} from './library.js';
import { MOODS, generateLyrics, generateProgression } from './generator.js';
import { toMidi, toMusicXML, kanaLyrics } from './export.js';
import {
  MELODY_ROWS, STEP_OPTIONS, rowToMidi, chordToneRows, noteAt, addNote, removeNote,
  rescale, toPlayable, generateSectionMelody, shiftMelodies,
} from './melody.js';
import { Player, PATTERNS } from './audio.js';
import {
  MODELS, EFFORTS, writeLyrics, suggestChords, suggestMelody, suggestIdeas, testKey, AIError,
} from './ai.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

migrateLegacy();
let opening = resolveOpening();
if (!opening) {
  // まだ1曲も無ければ、新しい曲を1つ用意する
  opening = { id: newSongId(), project: defaultProject() };
  saveSong(opening.id, opening.project);
  setCurrentId(opening.id);
}
let songId = opening.id;
let project = opening.project;
let settings = Object.assign(
  {
    apiKey: '', model: MODELS[0].id, effort: 'medium',
    click: true, volume: 0.7, playChords: true, playMelody: true, loop: false,
    // 画面が狭い端末では、最初からコンパクト表示にしておく
    compact: window.matchMedia('(max-width: 760px)').matches,
  },
  loadSettings()
);
// 以前は伴奏の弾き方を設定側に持っていた。曲の一部なのでプロジェクトへ移す。
// settings 側は消すので、この移行は1度しか走らない。
if (settings.pattern) {
  if (PATTERN_IDS.includes(settings.pattern)) project.pattern = settings.pattern;
  delete settings.pattern;
  saveSettings(settings);
}

const selection = new Set();     // "sectionId#barIndex"
const openPalettes = new Set();  // sectionId
const openTools = new Set();     // sectionId（詳細ツールを開いているセクション）
const player = new Player();
let busy = false;

/* ------------------------------------------------------------------ */
/* 共通ユーティリティ                                                   */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('err', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---- やり直し（Undo / Redo） ---- */

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 120;
let baseline = JSON.stringify(project);   // 直前に保存した状態
let lastPushAt = 0;
let lastPushTag = '';

/**
 * 変更を保存する。すべての変更がここを通るので、直前の状態をやり直し用に積む。
 * @param {string} tag 同じ種類の連続操作をまとめるための目印。
 *   文字入力は1打鍵ごとに履歴を作ると戻すのが大変なので、少しの間はまとめる。
 */
function persist(tag = '') {
  const now = Date.now();
  const coalesce = tag && tag === lastPushTag && now - lastPushAt < 800;
  if (!coalesce) {
    undoStack.push(baseline);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;   // 新しい操作をしたら、やり直しの先はもう使えない
  }
  lastPushAt = now;
  lastPushTag = tag;
  baseline = JSON.stringify(project);
  storeCurrent();
  updateStats();
  syncUndoButtons();
}

/** いま開いている曲を保存庫へ書き戻す */
function storeCurrent() {
  try {
    saveSong(songId, project);
  } catch (e) {
    if (e instanceof StorageFullError) {
      toast('保存領域がいっぱいです。使わない曲を消すか、JSONで書き出してください', true);
    } else {
      toast('保存できませんでした', true);
    }
  }
}

function syncUndoButtons() {
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
}

/** スナップショットを復元する。id ごと保存しているのでそのまま戻せる */
function restoreSnapshot(json, pushTo) {
  pushTo.push(JSON.stringify(project));
  project = JSON.parse(json);
  baseline = json;
  lastPushTag = '';
  storeCurrent();
  selection.clear();   // 元に戻すと小節の並びが変わり得るので選択は解除する
  render();
  syncTopbar();
  syncUndoButtons();
}

function undo() {
  if (!undoStack.length) { toast('これ以上戻せません', true); return; }
  restoreSnapshot(undoStack.pop(), redoStack);
  toast('元に戻しました');
}

function redo() {
  if (!redoStack.length) { toast('やり直せる操作がありません', true); return; }
  restoreSnapshot(redoStack.pop(), undoStack);
  toast('やり直しました');
}

function sectionById(id) {
  return project.sections.find((s) => s.id === id);
}

function selectedIndexes(section) {
  const out = [];
  section.bars.forEach((_, i) => {
    if (selection.has(`${section.id}#${i}`)) out.push(i);
  });
  return out;
}

function setAIStatus(text, kind = '') {
  const n = $('#aiStatus');
  n.textContent = text;
  n.className = 'ai-status' + (kind ? ' ' + kind : '');
}

function setBusy(state) {
  busy = state;
  document.querySelectorAll('[data-ai]').forEach((b) => { b.disabled = state; });
}

/** AI操作の共通ラッパー（キー未設定・エラーの扱いを1か所に） */
async function runAI(label, fn) {
  if (busy) return;
  if (!settings.apiKey) {
    setAIStatus('APIキーが未設定です（⚙ から設定）。キー無しでも「たたき」ボタンは使えます。', 'err');
    $('#settingsDlg').showModal();
    return;
  }
  setBusy(true);
  setAIStatus(`${label}を生成中…`, 'busy');
  try {
    const result = await fn();
    setAIStatus(result || `${label}を反映しました`, 'ok');
  } catch (e) {
    const msg = e instanceof AIError ? e.message : `失敗しました: ${e.message}`;
    setAIStatus(msg, 'err');
    toast(msg, true);
  } finally {
    setBusy(false);
  }
}

const aiOpts = () => ({
  apiKey: settings.apiKey,
  model: settings.model,
  effort: settings.effort,
  project,
});

/* ------------------------------------------------------------------ */
/* 上部バー                                                             */
/* ------------------------------------------------------------------ */

function fillSelect(node, items, value) {
  node.innerHTML = '';
  for (const it of items) {
    const o = el('option', null, it.label);
    o.value = it.id;
    node.append(o);
  }
  node.value = value;
}

function updateStats() {
  const secs = estimateSeconds(project);
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  const filled = project.sections.reduce(
    (n, sec) => n + sec.bars.filter((b) => b.lyric.trim()).length, 0
  );
  $('#songStats').textContent =
    `${project.sections.length}セクション / ${totalBars(project)}小節 / 歌詞${filled}小節 / 約${m}分${String(s).padStart(2, '0')}秒`;
}

function syncTopbar() {
  $('#songTitle').value = project.title;
  $('#keySel').value = project.key;
  $('#modeSel').value = project.mode;
  $('#bpmInput').value = project.bpm;
  $('#beatsSel').value = String(project.beatsPerBar);
  $('#moodSel').value = project.mood;
  $('#themeInput').value = project.theme;
  $('#patternSel').value = project.pattern;
  updateStats();
}

/* ------------------------------------------------------------------ */
/* セクション描画                                                       */
/* ------------------------------------------------------------------ */

/** 伴奏の弾き方を「小節 → セクション → 曲」の順で解決する */
function resolvePattern(section, bar) {
  return bar.pattern || section.pattern || project.pattern;
}

const PATTERN_SHORT = { pad: 'パ', arp: 'ア', stab: '刻' };
const patternLabel = (id) => PATTERNS.find((p) => p.id === id)?.label ?? id;

function moraClass(n, target) {
  const d = Math.abs(n - target);
  if (n === 0) return '';
  if (d <= 1) return 'fit';
  if (d <= 3) return 'near';
  return 'off';
}

/**
 * モーラ数バッジを描き直す。
 * AIが読み(yomi)を返している小節はそれを数えるので、漢字混じりでも正確になる。
 */
function fillMora(node, section, bar) {
  const source = bar.yomi || bar.lyric;
  const n = countMora(source);
  node.className = 'mora ' + moraClass(n, section.moraPerBar);
  node.innerHTML = '';
  node.append(el('span', 'n', String(n)), el('span', null, `/ ${section.moraPerBar} モーラ`));
  if (bar.yomi) {
    const y = el('span', 'kanji-warn', '♪');
    y.style.color = 'var(--ok)';
    y.title = `読み: ${bar.yomi}`;
    node.append(y);
  } else if (hasKanji(bar.lyric)) {
    const w = el('span', 'kanji-warn', '⚠');
    w.title = '漢字は読みが分からないため、モーラ数は目安です';
    node.append(w);
  }
}

function renderBar(section, bar, index) {
  const node = el('div', 'bar');
  node.dataset.sec = section.id;
  node.dataset.index = String(index);
  const key = `${section.id}#${index}`;
  if (selection.has(key)) node.classList.add('selected');

  const head = el('div', 'bar-head');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = selection.has(key);
  check.dataset.act = 'select';
  check.title = '選択（AIの対象にする）';
  head.append(check, el('span', 'bar-no', `${index + 1}`), el('span', 'spacer'));

  const pat = el('button', 'mini pattern-btn', bar.pattern ? PATTERN_SHORT[bar.pattern] : PATTERN_SHORT[resolvePattern(section, bar)]);
  pat.dataset.act = 'bar-pattern';
  if (!bar.pattern) pat.classList.add('inherited');
  pat.title = bar.pattern
    ? `伴奏: ${patternLabel(bar.pattern)}（この小節だけ指定）／タップで切替`
    : `伴奏: ${patternLabel(resolvePattern(section, bar))}（上の指定に従う）／タップでこの小節だけ変える`;
  head.append(pat);

  const aiBar = el('button', 'mini', '✨');
  aiBar.title = 'この小節の歌詞をAIで書き換える';
  aiBar.dataset.act = 'ai-bar';
  aiBar.dataset.ai = '1';
  head.append(aiBar);

  const chord = el('input', 'chord-input');
  chord.value = bar.chord;
  chord.placeholder = '—';
  chord.dataset.act = 'chord';
  chord.spellcheck = false;
  if (bar.chord && !parseChord(bar.chord)) chord.classList.add('invalid');

  const lyric = el('textarea', 'lyric-input');
  lyric.value = bar.lyric;
  lyric.rows = 2;
  lyric.placeholder = '歌詞';
  lyric.dataset.act = 'lyric';

  // 歌詞のモーラ数とメロディの音数は見比べるものなので、同じ行に並べる
  const counts = el('div', 'counts');
  const mora = el('div', 'mora');
  fillMora(mora, section, bar);
  counts.append(mora);
  if (section.showMelody) {
    const count = el('span', 'note-count');
    fillNoteCount(count, section, bar);
    counts.append(count);
  }

  node.append(head, chord);
  if (section.showKeys) node.append(renderKeyboard(bar));
  node.append(lyric, counts);

  if (section.showMelody) {
    const wrap = el('div', 'mel-wrap');
    wrap.append(renderMelodyGrid(section, bar));
    node.append(wrap);
  }
  return node;
}

/**
 * メロディグリッドを描く。
 * 行 = キーのスケール段数（上ほど高い）、列 = 小節の分割。
 * そのコードの構成音の行に色を敷いてあるので、光っている行を叩けば必ずハマる。
 */
// 鍵盤の並び。白鍵7つ＋黒鍵5つで1オクターブ
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
// 黒鍵は「左から何番目の白鍵の右肩に乗るか」で位置を決める
const BLACK_KEYS = [{ pc: 1, after: 0 }, { pc: 3, after: 1 }, { pc: 6, after: 3 }, { pc: 8, after: 4 }, { pc: 10, after: 5 }];

/**
 * そのコードで押さえる鍵盤を描く。
 * ルートと構成音を塗り分け、下に音名と度数を出して、何を押さえているか言葉でも分かるようにする。
 */
function renderKeyboard(bar) {
  const wrap = el('div', 'kb-wrap');
  const info = chordToneInfo(bar.chord);
  if (!info.length) {
    wrap.append(el('div', 'kb-empty', 'コードを入れると押さえる鍵盤が出ます'));
    return wrap;
  }

  const byPc = new Map();
  for (const t of info) if (!byPc.has(t.pc)) byPc.set(t.pc, t);
  const rootPc = info[0].pc;

  const kb = el('div', 'kb');
  kb.dataset.chord = bar.chord;
  kb.title = `${bar.chord} を鳴らす`;

  WHITE_PCS.forEach((pc) => {
    const k = el('div', 'kb-key white');
    if (byPc.has(pc)) k.classList.add(pc === rootPc ? 'root' : 'on');
    kb.append(k);
  });
  for (const { pc, after } of BLACK_KEYS) {
    const k = el('div', 'kb-key black');
    // 白鍵の幅を 1 として、右肩の位置に置く
    k.style.left = `calc(${after + 1} * (100% / 7) - (100% / 7) * 0.3)`;
    if (byPc.has(pc)) k.classList.add(pc === rootPc ? 'root' : 'on');
    kb.append(k);
  }

  const names = el('div', 'kb-names');
  for (const t of info) {
    const chip = el('span', 'kb-name' + (t.pc === rootPc ? ' root' : ''));
    chip.append(el('b', null, t.name), el('span', 'deg', t.degree));
    names.append(chip);
  }

  const a = analyzeChord(bar.chord, project.key, project.mode);
  const analysis = el('div', 'kb-analysis');
  if (a) {
    analysis.append(el('span', 'roman', a.roman));
    if (a.func) analysis.append(el('span', 'func', a.func));
    if (a.hint) analysis.append(el('span', 'hint', a.hint));
  }

  wrap.append(kb, names, analysis);
  return wrap;
}

function renderMelodyGrid(section, bar) {
  const wrap = el('div', 'mel-row');
  wrap.style.setProperty('--rows', MELODY_ROWS);

  const grid = el('div', 'mel-grid');
  grid.style.setProperty('--steps', section.steps);
  grid.style.setProperty('--rows', MELODY_ROWS);
  grid.dataset.melGrid = '1';

  const stepsPerBeat = Math.max(1, Math.round(section.steps / project.beatsPerBar));
  const { tones, root } = chordToneRows(project, bar.chord);

  // 左端に音名を出す。どの行がコードの構成音なのかが名前で確かめられる
  const labels = el('div', 'mel-labels');
  for (let row = MELODY_ROWS - 1; row >= 0; row--) {
    const name = scaleIndexName(project.key, project.mode, row);
    const lab = el('div', 'mel-label', name);
    if (tones.has(row)) lab.classList.add('tone');
    if (row === root) lab.classList.add('root');
    lab.title = row === root
      ? `${name} … ${bar.chord} のルート`
      : tones.has(row)
        ? `${name} … ${bar.chord} の構成音`
        : `${name} … コード外の音`;
    labels.append(lab);
  }

  for (let row = MELODY_ROWS - 1; row >= 0; row--) {
    for (let step = 0; step < section.steps; step++) {
      const cell = el('div', 'mel-cell');
      cell.dataset.row = String(row);
      cell.dataset.step = String(step);
      if (tones.has(row)) cell.classList.add('tone');
      if (row === root) cell.classList.add('root');
      if (step % stepsPerBeat === 0) cell.classList.add('beat');
      cell.title = scaleIndexName(project.key, project.mode, row);
      grid.append(cell);
    }
  }
  wrap.append(labels, grid);
  paintNotes(grid, section, bar);
  return wrap;
}

/** 音符の有無だけをセルのクラスに反映する（作り直さないので軽い） */
function paintNotes(grid, section, bar) {
  grid.querySelectorAll('.mel-cell.on, .mel-cell.head')
    .forEach((c) => c.classList.remove('on', 'head'));
  for (const note of bar.melody) {
    for (let i = 0; i < note.d; i++) {
      const step = note.s + i;
      if (step >= section.steps) break;
      const cell = grid.querySelector(`.mel-cell[data-row="${note.n}"][data-step="${step}"]`);
      if (!cell) continue;
      cell.classList.add('on');
      if (i === 0) cell.classList.add('head');
    }
  }
  const badge = grid.closest('.bar')?.querySelector('.note-count');
  if (badge) fillNoteCount(badge, section, bar);
}

/** 音符の数を出す。歌詞のモーラ数と揃っていれば緑になる */
function fillNoteCount(node, section, bar) {
  const notes = bar.melody.length;
  const mora = countMora(bar.yomi || bar.lyric);
  node.className = 'note-count';
  if (notes && mora) node.classList.add(notes === mora ? 'fit' : Math.abs(notes - mora) <= 1 ? 'near' : 'off');
  node.textContent = notes ? `♪${notes}音` : '♪—';
  node.title = mora
    ? `メロディ ${notes}音 / 歌詞 ${mora}モーラ（揃っていると1音1文字で乗ります）`
    : 'タップして音を置く。右へドラッグで音が伸びます';
}

function renderPalette(section) {
  const pal = el('div', 'palette');
  if (openPalettes.has(section.id)) pal.classList.add('open');
  pal.dataset.palette = section.id;

  const dia = el('div', 'palette-row');
  dia.append(el('span', 'palette-label', 'ダイアトニック'));
  const diaChips = el('span', 'chips');
  for (const c of diatonicChords(project.key, project.mode)) {
    const b = el('button', 'chip');
    b.dataset.act = 'insert-chord';
    b.dataset.chord = c.name;
    b.append(document.createTextNode(c.name), el('span', 'deg', c.degree));
    diaChips.append(b);
  }
  dia.append(diaChips);

  const spice = el('div', 'palette-row');
  spice.append(el('span', 'palette-label', 'スパイス'));
  const spiceChipsEl = el('span', 'chips');
  for (const c of spiceChords(project.key, project.mode)) {
    const b = el('button', 'chip', c.name);
    b.dataset.act = 'insert-chord';
    b.dataset.chord = c.name;
    b.title = c.label;
    spiceChipsEl.append(b);
  }
  spice.append(spiceChipsEl);

  const prog = el('div', 'palette-row');
  prog.append(el('span', 'palette-label', '定番進行'));
  const progChips = el('span', 'chips');
  for (const p of PROGRESSIONS) {
    const b = el('button', 'chip', p.name);
    b.dataset.act = 'apply-progression';
    b.dataset.prog = p.id;
    b.title = `${progressionInKey(p.chords, p.mode, project.key).join(' - ')}\n${p.note}`;
    progChips.append(b);
  }
  prog.append(progChips);

  pal.append(dia, spice, prog);
  return pal;
}

function renderSection(section, sectionIndex) {
  const node = el('section', 'section');
  node.dataset.sec = section.id;

  const head = el('div', 'section-head');
  const tag = el('span', 'role-tag', ROLES.find((r) => r.id === section.role)?.label ?? section.role);
  tag.dataset.role = section.role;

  const name = el('input', 'section-name');
  name.value = section.name;
  name.dataset.act = 'section-name';

  const moraLabel = el('label', 'ctl');
  const moraInput = el('input');
  moraInput.type = 'number';
  moraInput.min = '1';
  moraInput.max = '24';
  moraInput.value = String(section.moraPerBar);
  moraInput.dataset.act = 'mora-target';
  moraInput.title = '1小節あたりの目標モーラ数';
  moraLabel.append(document.createTextNode('目標モーラ'), moraInput);

  const barsLabel = el('span', 'head-group');
  const minus = el('button', 'mini', '−');
  minus.dataset.act = 'bars-minus';
  minus.title = '小節を減らす';
  const plus = el('button', 'mini', '＋');
  plus.dataset.act = 'bars-plus';
  plus.title = '小節を増やす';
  barsLabel.append(minus, el('span', 'ctl-label', `${section.bars.length}小節`), plus);

  const group = el('div', 'head-group');
  const mk = (label, act, title, isAI) => {
    const b = el('button', 'btn ghost', label);
    b.dataset.act = act;
    b.title = title;
    if (isAI) b.dataset.ai = '1';
    return b;
  };
  group.append(
    mk('✨ AIコード', 'ai-chords', '選択した小節（未選択ならセクション全体）のコードをAIが提案', true),
    mk('✨ AI歌詞', 'ai-lyrics', '選択した小節（未選択ならセクション全体）の歌詞をAIが書き換え', true),
    mk('✨ AIメロ', 'ai-melody', '歌詞とコードに合うメロディをAIが提案', true),
  );

  const stepsLabel = el('label', 'ctl');
  const stepsSel = el('select');
  for (const o of STEP_OPTIONS) {
    const opt = el('option', null, o.label);
    opt.value = o.id;
    stepsSel.append(opt);
  }
  stepsSel.value = String(section.steps);
  stepsSel.dataset.act = 'steps';
  stepsSel.title = 'メロディグリッドの細かさ';
  stepsLabel.append(stepsSel);

  const patLabel = el('label', 'ctl');
  const patSel = el('select');
  const inherit = el('option', null, '曲に従う');
  inherit.value = '';
  patSel.append(inherit);
  for (const o of PATTERNS) {
    const opt = el('option', null, o.label);
    opt.value = o.id;
    patSel.append(opt);
  }
  patSel.value = section.pattern || '';
  patSel.dataset.act = 'section-pattern';
  patSel.title = 'このセクションの伴奏の弾き方';
  patLabel.append(document.createTextNode('伴奏'), patSel);

  const tools = el('div', 'head-group');
  tools.append(
    (() => {
      const b = mk('🎵', 'toggle-melody',
        section.showMelody ? 'メロディグリッドを隠す' : 'メロディグリッドを表示');
      if (!section.showMelody) b.classList.add('off');
      return b;
    })(),
    mk('♪⇈', 'mel-oct-up', 'メロディを1オクターブ上げる（小節を選んでいればその小節だけ）'),
    mk('♪▲', 'mel-up', 'メロディを2度上げる（スケール上で1段。小節を選んでいればその小節だけ）'),
    mk('♪▼', 'mel-down', 'メロディを2度下げる（スケール上で1段。小節を選んでいればその小節だけ）'),
    mk('♪⇊', 'mel-oct-down', 'メロディを1オクターブ下げる（小節を選んでいればその小節だけ）'),
    mk('🧹', 'clear-melody', 'このセクションのメロディを消す'),
    (() => {
      const b = mk('🎹', 'toggle-keys',
        section.showKeys ? 'コードの鍵盤表示を隠す' : 'コードの鍵盤表示を出す');
      if (!section.showKeys) b.classList.add('off');
      return b;
    })(),
    mk('🎨', 'toggle-palette', 'コードパレットを開閉'),
    mk('↑', 'move-up', '上へ'),
    mk('↓', 'move-down', '下へ'),
    mk('複製', 'duplicate', 'このセクションを複製'),
    mk('✕', 'delete-section', 'このセクションを削除'),
  );

  // よく使うものだけ出し、残りは ⋯ の中に畳む。
  // 出しっぱなしにするとヘッダだけで画面が埋まり、肝心の小節が見えなくなるため。
  const primary = el('div', 'head-group');
  primary.append(
    mk('🎲 コード', 'gen-chords', 'オフラインでコード進行のたたきを作る'),
    mk('🎲 歌詞', 'gen-lyrics', 'オフラインで歌詞のたたきを作る'),
    mk('🎲 メロディ', 'gen-melody', 'コードと歌詞のモーラ数に合わせてメロディのたたきを作る'),
    mk('▶', 'play-section', 'このセクションを再生（小節を選んでいればその範囲だけ繰り返す）'),
  );
  const more = mk('⋯', 'toggle-tools', 'そのほかの操作');
  if (openTools.has(section.id)) more.classList.add('active');
  primary.append(more);

  head.append(tag, name, barsLabel, el('span', 'spacer'), primary);

  const drawer = el('div', 'head-drawer');
  if (openTools.has(section.id)) drawer.classList.add('open');
  drawer.dataset.drawer = section.id;
  drawer.append(moraLabel, stepsLabel, patLabel, group, tools);

  const bars = el('div', 'bars');
  section.bars.forEach((bar, i) => bars.append(renderBar(section, bar, i)));

  node.append(head, drawer, bars, renderPalette(section));
  if (section.showMelody) {
    const legend = el('div', 'mel-legend');
    legend.append(
      el('span', 'swatch root'), el('span', null, 'ルート'),
      el('span', 'swatch tone'), el('span', null, 'コードの構成音（ここに置けば外れません）'),
      el('span', 'swatch'), el('span', null, 'コード外の音'),
    );
    node.insertBefore(legend, bars);
  }
  node.dataset.sectionIndex = String(sectionIndex);
  return node;
}

function render() {
  const root = $('#sections');
  root.innerHTML = '';
  project.sections.forEach((s, i) => root.append(renderSection(s, i)));
  updateStats();
}

/** 入力中にDOMを作り直すとフォーカスが飛ぶので、モーラ表示だけ差し替える */
function refreshMora(barNode, section, bar) {
  fillMora(barNode.querySelector('.mora'), section, bar);
}

/* ------------------------------------------------------------------ */
/* 再生                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 再生するバーを集める。
 * @param {string|null} sectionFilter このセクションだけに絞る
 * @param {number[]} barIndexes 指定があれば、そのセクションの中でもこの小節だけに絞る
 */
function collectBars(sectionFilter = null, barIndexes = []) {
  const out = [];
  project.sections.forEach((sec, si) => {
    if (sectionFilter && sec.id !== sectionFilter) return;
    sec.bars.forEach((bar, bi) => {
      if (barIndexes.length && !barIndexes.includes(bi)) return;
      out.push({
        chord: bar.chord,
        pattern: resolvePattern(sec, bar),
        melody: toPlayable(project, bar.melody, sec.steps),
        sectionIndex: si,
        barIndex: bi,
      });
    });
  });
  return out;
}

function highlight(sectionIndex, barIndex) {
  document.querySelectorAll('.bar.playing, .section.playing')
    .forEach((n) => n.classList.remove('playing'));
  const sec = project.sections[sectionIndex];
  if (!sec) return;
  const secNode = document.querySelector(`.section[data-sec="${sec.id}"]`);
  if (secNode) secNode.classList.add('playing');
  const barNode = document.querySelector(`.bar[data-sec="${sec.id}"][data-index="${barIndex}"]`);
  if (barNode) barNode.classList.add('playing');
}

function startPlayback(sectionId = null) {
  const section = sectionId ? sectionById(sectionId) : null;
  // 小節を選んでいれば、その範囲だけを繰り返す（メロディを詰めるときに使う）
  const picked = section ? selectedIndexes(section) : [];
  const bars = collectBars(sectionId, picked);
  if (!bars.length) { toast('鳴らす小節がありません', true); return; }
  if (picked.length) toast(`選択した${picked.length}小節をループ再生`);
  player.pattern = project.pattern;
  player.click = settings.click;
  player.playChords = settings.playChords;
  player.playMelody = settings.playMelody;
  player.setVolume(settings.volume);
  player.onBar = (_, si, bi) => highlight(si, bi);
  player.onStop = () => {
    document.querySelectorAll('.bar.playing, .section.playing')
      .forEach((n) => n.classList.remove('playing'));
    $('#stopAll').disabled = true;
    $('#playAll').textContent = '▶ 全体再生';
  };
  player.play(bars, {
    bpm: project.bpm,
    beatsPerBar: project.beatsPerBar,
    // セクション／選択範囲は繰り返し、曲全体はチェックに従う
    loop: sectionId ? true : settings.loop,
  });
  $('#stopAll').disabled = false;
  $('#playAll').textContent = '▶ 再生中';
}

/* ------------------------------------------------------------------ */
/* セクション操作                                                       */
/* ------------------------------------------------------------------ */

function applyProgression(section, chords) {
  section.bars.forEach((bar, i) => { bar.chord = chords[i % chords.length] || ''; });
}

function genChords(section) {
  const res = generateProgression({
    key: project.key, mode: project.mode, bars: section.bars.length,
    role: section.role, spice: true,
  });
  applyProgression(section, res.chords);
  persist();
  render();
  toast(`${res.presetName} をベースに生成${res.note ? '：' + res.note : ''}`);
}

function genLyrics(section) {
  const lines = generateLyrics(project.mood, section.bars.length, section.moraPerBar, 2);
  section.bars.forEach((bar, i) => { bar.lyric = lines[i] || ''; });
  persist();
  render();
  toast('歌詞のたたきを入れました（AIキー不要のオフライン生成）');
}

/**
 * メロディの高さをまとめて上下させる。
 * 小節を選んでいればその小節だけ、選んでいなければセクション全体。
 */
function shiftSectionMelody(section, delta) {
  const targets = selectedIndexes(section);
  const indexes = targets.length ? targets : section.bars.map((_, i) => i);
  const groups = indexes.map((i) => section.bars[i].melody);
  const res = shiftMelodies(groups, delta);

  if (!res.moved) {
    const hasNotes = groups.some((g) => g.length);
    toast(
      hasNotes
        // 曲全体を上げ下げしたいなら、こちらではなくキーの移調が正しい操作になる
        ? 'これ以上動かすと音域からはみ出します（曲ごと上げたいときは上部の移調 ▲▼ を使ってください）'
        : '動かすメロディがありません',
      true
    );
    return;
  }
  indexes.forEach((barIndex, i) => { section.bars[barIndex].melody = res.groups[i]; });
  persist();
  render();

  const what = Math.abs(delta) === 7 ? '1オクターブ' : '2度';
  const dir = delta > 0 ? '上げました' : '下げました';
  const scope = targets.length ? `選択した${targets.length}小節の` : '';
  toast(`${scope}メロディを${what}${dir}`);
}

function genMelody(section) {
  const moraCounts = section.bars.map((b) => countMora(b.yomi || b.lyric));
  const melodies = generateSectionMelody({ project, section, moraCounts });
  section.bars.forEach((bar, i) => { bar.melody = melodies[i]; });
  persist();
  render();
  const withLyric = moraCounts.filter(Boolean).length;
  toast(withLyric
    ? `メロディのたたきを作りました（歌詞のある${withLyric}小節は音数をモーラ数に合わせています）`
    : 'メロディのたたきを作りました（歌詞を入れてから作り直すと、音数が歌詞に合います）');
}

async function aiMelody(section) {
  await runAI('メロディ', async () => {
    const res = await suggestMelody({
      ...aiOpts(),
      section,
      rows: MELODY_ROWS,
      instruction: $('#aiInstruction').value.trim(),
    });
    const byBar = new Map();
    for (const n of res.notes) {
      if (!byBar.has(n.bar)) byBar.set(n.bar, []);
      byBar.get(n.bar).push({ s: n.step, d: Math.max(1, n.duration), n: n.degree });
    }
    section.bars.forEach((bar, i) => {
      const notes = byBar.get(i);
      if (notes) bar.melody = notes.sort((a, b) => a.s - b.s);
    });
    persist();
    render();
    return `${byBar.size}小節にメロディを置きました${res.comment ? ' / ' + res.comment : ''}`;
  });
}

async function aiLyrics(section, forcedIndexes = null) {
  const targets = forcedIndexes ?? selectedIndexes(section);
  await runAI('歌詞', async () => {
    const res = await writeLyrics({
      ...aiOpts(),
      section,
      targetIndexes: targets,
      instruction: $('#aiInstruction').value.trim(),
      keepMora: $('#keepMoraChk').checked,
    });
    for (const line of res.lines) {
      section.bars[line.index].lyric = line.lyric;
      section.bars[line.index].yomi = line.yomi || '';
    }
    persist();
    render();
    const moras = res.lines.map((l) => countMora(l.yomi || l.lyric));
    const range = moras.length ? `${Math.min(...moras)}〜${Math.max(...moras)}モーラ` : '';
    return `${res.lines.length}小節を更新（${range}）${res.comment ? ' / ' + res.comment : ''}`;
  });
}

async function aiChords(section) {
  const targets = selectedIndexes(section);
  await runAI('コード', async () => {
    const res = await suggestChords({
      ...aiOpts(),
      section,
      targetIndexes: targets,
      instruction: $('#aiInstruction').value.trim(),
    });
    for (const c of res.chords) section.bars[c.index].chord = c.chord;
    persist();
    render();
    return `${res.chords.length}小節を更新${res.comment ? ' / ' + res.comment : ''}`;
  });
}

/* ------------------------------------------------------------------ */
/* イベント配線                                                         */
/* ------------------------------------------------------------------ */

function sectionOf(node) {
  const secNode = node.closest('[data-sec]');
  return secNode ? sectionById(secNode.dataset.sec) : null;
}

$('#sections').addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  const section = sectionOf(target);
  if (!section) return;
  const barNode = target.closest('.bar');
  const barIndex = barNode ? Number(barNode.dataset.index) : -1;

  switch (act) {
    case 'select': {
      const key = `${section.id}#${barIndex}`;
      if (target.checked) selection.add(key); else selection.delete(key);
      barNode.classList.toggle('selected', target.checked);
      break;
    }
    case 'ai-bar':
      aiLyrics(section, [barIndex]);
      break;
    case 'bar-pattern': {
      // 「上に従う → パッド → アルペジオ → 刻み → 上に従う」の順で巡回する
      const cycle = [null, ...PATTERN_IDS];
      const bar = section.bars[barIndex];
      const next = cycle[(cycle.indexOf(bar.pattern) + 1) % cycle.length];
      // 選択している小節があれば、まとめて同じ弾き方にする
      const targets = selectedIndexes(section);
      const indexes = targets.includes(barIndex) ? targets : [barIndex];
      for (const i of indexes) section.bars[i].pattern = next;
      persist(); render();
      toast(next
        ? `${indexes.length}小節の伴奏を「${patternLabel(next)}」にしました`
        : `${indexes.length}小節の伴奏を上の指定に戻しました`);
      break;
    }
    case 'insert-chord': {
      const targets = selectedIndexes(section);
      if (!targets.length) { toast('先に小節を選択してください（小節左上のチェック）', true); break; }
      for (const i of targets) section.bars[i].chord = target.dataset.chord;
      persist(); render();
      break;
    }
    case 'apply-progression': {
      const p = PROGRESSIONS.find((x) => x.id === target.dataset.prog);
      applyProgression(section, progressionInKey(p.chords, p.mode, project.key));
      persist(); render();
      toast(`${p.name} を適用${p.note ? '：' + p.note : ''}`);
      break;
    }
    case 'bars-plus':
      section.bars.push(makeBar(section.bars.at(-1)?.chord || '', ''));
      persist(); render();
      break;
    case 'bars-minus':
      if (section.bars.length <= 1) { toast('これ以上減らせません', true); break; }
      selection.delete(`${section.id}#${section.bars.length - 1}`);
      section.bars.pop();
      persist(); render();
      break;
    case 'gen-chords': genChords(section); break;
    case 'gen-lyrics': genLyrics(section); break;
    case 'gen-melody': genMelody(section); break;
    case 'ai-melody': aiMelody(section); break;
    case 'toggle-tools': {
      const open = openTools.has(section.id);
      if (open) openTools.delete(section.id); else openTools.add(section.id);
      document.querySelector(`[data-drawer="${section.id}"]`).classList.toggle('open', !open);
      target.classList.toggle('active', !open);
      break;
    }
    case 'toggle-keys':
      section.showKeys = !section.showKeys;
      persist(); render();
      break;
    case 'toggle-melody':
      section.showMelody = !section.showMelody;
      persist(); render();
      break;
    case 'mel-up': shiftSectionMelody(section, 1); break;
    case 'mel-down': shiftSectionMelody(section, -1); break;
    case 'mel-oct-up': shiftSectionMelody(section, 7); break;
    case 'mel-oct-down': shiftSectionMelody(section, -7); break;
    case 'clear-melody':
      section.bars.forEach((b) => { b.melody = []; });
      persist(); render();
      toast('メロディを消しました');
      break;
    case 'ai-chords': aiChords(section); break;
    case 'ai-lyrics': aiLyrics(section); break;
    case 'play-section': startPlayback(section.id); break;
    case 'toggle-palette': {
      if (openPalettes.has(section.id)) openPalettes.delete(section.id);
      else openPalettes.add(section.id);
      document.querySelector(`[data-palette="${section.id}"]`)
        .classList.toggle('open', openPalettes.has(section.id));
      break;
    }
    case 'move-up':
    case 'move-down': {
      const i = project.sections.indexOf(section);
      const j = act === 'move-up' ? i - 1 : i + 1;
      if (j < 0 || j >= project.sections.length) break;
      project.sections.splice(i, 1);
      project.sections.splice(j, 0, section);
      persist(); render();
      break;
    }
    case 'duplicate': {
      const copy = normalizeProject({ ...project, sections: [section] }).sections[0];
      copy.name = section.name + ' 2';
      project.sections.splice(project.sections.indexOf(section) + 1, 0, copy);
      persist(); render();
      break;
    }
    case 'delete-section': {
      if (project.sections.length <= 1) { toast('最後のセクションは消せません', true); break; }
      if (!confirm(`「${section.name}」を削除します。よろしいですか？`)) break;
      project.sections.splice(project.sections.indexOf(section), 1);
      persist(); render();
      break;
    }
  }
});

// 鍵盤をタップしたらそのコードを鳴らす。押さえる形と響きを結び付けられるように
$('#sections').addEventListener('click', (ev) => {
  const kb = ev.target.closest('.kb');
  if (!kb) return;
  const tones = chordToneInfo(kb.dataset.chord);
  if (!tones.length) return;
  const rootMidi = 48 + tones[0].pc;   // C3 あたりを基準に積む
  tones.forEach((t, i) => {
    setTimeout(() => {
      try {
        player.previewNote(freqOf(rootMidi + t.interval), 0.7);
      } catch { /* 音が出せない環境では何もしない */ }
    }, i * 45);
  });
});

$('#sections').addEventListener('input', (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const section = sectionOf(target);
  if (!section) return;
  const barNode = target.closest('.bar');

  switch (target.dataset.act) {
    case 'section-name':
      section.name = target.value;
      persist('name:' + section.id);
      break;
    case 'mora-target': {
      const v = Math.max(1, Math.min(24, Number(target.value) || 7));
      section.moraPerBar = v;
      section.bars.forEach((bar, i) => {
        const node = document.querySelector(`.bar[data-sec="${section.id}"][data-index="${i}"]`);
        if (node) refreshMora(node, section, bar);
      });
      persist();
      break;
    }
    case 'section-pattern':
      section.pattern = target.value || null;
      persist(); render();
      break;
    case 'steps': {
      const next = Number(target.value);
      // 分割を変えたら、置いてある音符の位置と長さを比例させる
      section.bars.forEach((bar) => { bar.melody = rescale(bar.melody, section.steps, next); });
      section.steps = next;
      persist(); render();
      break;
    }
    case 'chord': {
      const bar = section.bars[Number(barNode.dataset.index)];
      bar.chord = target.value;
      target.classList.toggle('invalid', !!bar.chord && !parseChord(bar.chord));
      // コードが変わるとグリッドで光る行（構成音）も変わる
      const melRow = barNode.querySelector('.mel-row');
      if (melRow) melRow.replaceWith(renderMelodyGrid(section, bar));
      const kb = barNode.querySelector('.kb-wrap');
      if (kb) kb.replaceWith(renderKeyboard(bar));
      persist('chord:' + bar.id);
      break;
    }
    case 'lyric': {
      const bar = section.bars[Number(barNode.dataset.index)];
      bar.lyric = target.value;
      bar.yomi = '';  // 手で書き換えたらAI由来の読みは破棄
      refreshMora(barNode, section, bar);
      const badge = barNode.querySelector('.note-count');
      if (badge) fillNoteCount(badge, section, bar);
      persist('lyric:' + bar.id);
      break;
    }
  }
});

/* --- メロディグリッドのタップ／ドラッグ --- */

let drag = null;

/** 座標から (行, ステップ) を割り出す。指でなぞってもセルを取りこぼさない */
function cellFromPoint(grid, section, clientX, clientY) {
  const r = grid.getBoundingClientRect();
  const step = Math.floor(((clientX - r.left) / r.width) * section.steps);
  const fromTop = Math.floor(((clientY - r.top) / r.height) * MELODY_ROWS);
  if (step < 0 || step >= section.steps || fromTop < 0 || fromTop >= MELODY_ROWS) return null;
  return { step, row: MELODY_ROWS - 1 - fromTop };
}

function previewRow(row) {
  try {
    player.previewNote(midiToFreq(rowToMidi(project, row)));
  } catch { /* 音が出せない環境でも操作は続けられるようにする */ }
}

/** タップ位置に音を置く／消す */
function commitAt(d, row, step) {
  const { grid, section, bar } = d;
  const existing = noteAt(bar.melody, row, step);
  if (existing) {
    d.mode = 'erase';
    bar.melody = removeNote(bar.melody, existing);
  } else {
    d.mode = 'draw';
    d.row = row;
    d.startStep = step;
    bar.melody = addNote(bar.melody, { s: step, d: 1, n: row }, section.steps);
    previewRow(row);
  }
  paintNotes(grid, section, bar);
}

$('#sections').addEventListener('pointerdown', (ev) => {
  const grid = ev.target.closest('[data-mel-grid]');
  if (!grid) return;
  const barNode = grid.closest('.bar');
  const section = sectionById(barNode.dataset.sec);
  const bar = section.bars[Number(barNode.dataset.index)];
  const hit = cellFromPoint(grid, section, ev.clientX, ev.clientY);
  if (!hit) return;

  drag = {
    grid, section, bar, mode: 'pending',
    row: hit.row, startStep: hit.step,
    startX: ev.clientX, startY: ev.clientY,
    touch: ev.pointerType === 'touch',
  };

  // 指の場合はここではまだ書き込まない。
  // 縦に動いたらページのスクロールなので、指を離した時点でタップとして確定する。
  if (!drag.touch) {
    ev.preventDefault();
    commitAt(drag, hit.row, hit.step);
    grid.setPointerCapture(ev.pointerId);
  }
});

$('#sections').addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const { grid, section, bar } = drag;

  if (drag.mode === 'pending') {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (Math.abs(dy) > 10) return;   // 縦方向はスクロールに譲る
    if (Math.abs(dx) < 8) return;
    commitAt(drag, drag.row, drag.startStep);
    grid.setPointerCapture(ev.pointerId);
  }

  const hit = cellFromPoint(grid, section, ev.clientX, ev.clientY);
  if (!hit) return;

  if (drag.mode === 'erase') {
    const existing = noteAt(bar.melody, hit.row, hit.step);
    if (!existing) return;
    bar.melody = removeNote(bar.melody, existing);
  } else if (hit.row === drag.row && hit.step >= drag.startStep) {
    // 右へなぞると音が伸びる
    bar.melody = addNote(
      bar.melody,
      { s: drag.startStep, d: hit.step - drag.startStep + 1, n: drag.row },
      section.steps
    );
  } else if (!noteAt(bar.melody, hit.row, hit.step)) {
    // 別の行へ移ったら、そこに新しい音を置く（なぞり書き）
    bar.melody = addNote(bar.melody, { s: hit.step, d: 1, n: hit.row }, section.steps);
    drag.row = hit.row;
    drag.startStep = hit.step;
    previewRow(hit.row);
  } else {
    return;
  }
  paintNotes(grid, section, bar);
});

$('#sections').addEventListener('pointerup', () => {
  if (drag?.mode === 'pending') commitAt(drag, drag.row, drag.startStep);
  endDrag();
});

// スクロールが始まると pointercancel が来る。まだ何も書いていなければ何も残さない。
$('#sections').addEventListener('pointercancel', endDrag);

function endDrag() {
  if (!drag) return;
  const changed = drag.mode !== 'pending';
  drag = null;
  if (changed) persist();   // 1ストローク = 1回の履歴
}

/* --- 上部バー --- */
$('#songTitle').addEventListener('input', (e) => { project.title = e.target.value; persist('title'); });
$('#themeInput').addEventListener('input', (e) => { project.theme = e.target.value; persist('theme'); });
$('#moodSel').addEventListener('change', (e) => { project.mood = e.target.value; persist(); });
$('#bpmInput').addEventListener('change', (e) => {
  project.bpm = Math.max(40, Math.min(300, Number(e.target.value) || 120));
  e.target.value = project.bpm;
  persist();
});
$('#beatsSel').addEventListener('change', (e) => {
  project.beatsPerBar = Number(e.target.value);
  persist();
});
$('#keySel').addEventListener('change', (e) => {
  const from = KEYS.indexOf(project.key);
  const to = KEYS.indexOf(e.target.value);
  transposeProject(project, to - from);
  persist(); render(); syncTopbar();
  toast(`${project.key} に移調しました`);
});
$('#modeSel').addEventListener('change', (e) => { project.mode = e.target.value; persist(); render(); });
$('#transUp').addEventListener('click', () => { transposeProject(project, 1); persist(); render(); syncTopbar(); });
$('#transDown').addEventListener('click', () => { transposeProject(project, -1); persist(); render(); syncTopbar(); });

$('#playAll').addEventListener('click', () => startPlayback(null));
$('#stopAll').addEventListener('click', () => player.stop());
$('#patternSel').addEventListener('change', (e) => {
  // 伴奏の弾き方は曲の一部なので、設定ではなくプロジェクトに持たせる
  project.pattern = e.target.value;
  player.pattern = e.target.value;
  persist(); render();
});
$('#clickChk').addEventListener('change', (e) => {
  settings.click = e.target.checked;
  player.click = e.target.checked;
  saveSettings(settings);
});
function applyCompact() {
  document.body.classList.toggle('compact', !!settings.compact);
}
$('#compactChk').addEventListener('change', (e) => {
  settings.compact = e.target.checked;
  saveSettings(settings);
  applyCompact();
});
// 画面が狭いときは曲の設定を畳んでおく。上部バーだけで画面の半分を使ってしまうため
$('#btnPanel').addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  $('#btnPanel').classList.toggle('active', open);
});
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#loopChk').addEventListener('change', (e) => {
  settings.loop = e.target.checked;
  saveSettings(settings);
});
$('#chordsChk').addEventListener('change', (e) => {
  settings.playChords = e.target.checked;
  player.playChords = e.target.checked;
  saveSettings(settings);
});
$('#melodyChk').addEventListener('change', (e) => {
  settings.playMelody = e.target.checked;
  player.playMelody = e.target.checked;
  saveSettings(settings);
});
$('#volInput').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  player.setVolume(settings.volume);
  saveSettings(settings);
});

/* --- セクション追加 --- */
for (const role of ROLES) {
  const b = el('button', 'chip', `+ ${role.label}`);
  b.addEventListener('click', () => {
    project.sections.push(makeSection(role.id, role.label, 4));
    persist(); render();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
  $('#addSectionBtns').append(b);
}

/* --- フッター --- */
const safeName = () => (project.title || 'song').replace(/[\\/:*?"<>|]/g, '_');

function download(data, extension, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = el('a');
  a.href = url;
  a.download = `${safeName()}.${extension}`;
  // DOM に入れてからクリックしないと、ブラウザがファイル名を無視することがある
  document.body.append(a);
  a.click();
  a.remove();
  // すぐ解放するとダウンロードが始まる前に切れることがあるので、少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#btnExport').addEventListener('click', () => {
  download(JSON.stringify(project, null, 2), 'json', 'application/json');
});

$('#btnMidi').addEventListener('click', () => {
  const hasMelody = project.sections.some((s) => s.bars.some((b) => b.melody.length));
  download(toMidi(project), 'mid', 'audio/midi');
  toast(hasMelody
    ? 'MIDIを書き出しました（メロディ／コードの2トラック）'
    : 'MIDIを書き出しました（メロディが空なのでコードのみ）');
});

$('#btnMusicXml').addEventListener('click', () => {
  const res = toMusicXML(project);
  if (!res.notes) { toast('メロディが1つも置かれていません', true); return; }
  download(res.xml, 'musicxml', 'application/vnd.recordare.musicxml+xml');

  // 歌詞が全部乗らなかった場合は、その理由をはっきり伝える
  const notes = [`${res.notes}音中${res.withLyric}音に歌詞`];
  if (res.unknownReading) notes.push(`読み不明${res.unknownReading}小節`);
  if (res.mismatched) notes.push(`音数とモーラ数が違う小節${res.mismatched}`);
  toast(`MusicXMLを書き出しました（${notes.join(' / ')}）`);
});

$('#btnKana').addEventListener('click', () => {
  const res = kanaLyrics(project);
  if (!res.text.trim()) { toast('歌詞がありません', true); return; }
  copyText(res.text, 'かな歌詞');
  if (res.unknown) {
    toast(`${res.unknown}小節は漢字の読みが不明です。AIで書き直すか、かなで入力してください`, true);
  }
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    // 開いている曲を潰さないよう、別の曲として取り込む
    createSong(normalizeProject(JSON.parse(await file.text())));
    toast('別の曲として読み込みました');
  } catch {
    toast('JSONを読み込めませんでした', true);
  }
  e.target.value = '';
});

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`);
  } catch {
    // クリップボードAPIが使えない環境（file:// の一部ブラウザなど）
    window.prompt(`${label}（手動でコピーしてください）`, text);
  }
}
$('#btnCopyLyrics').addEventListener('click', () => copyText(lyricsToText(project, false), '歌詞'));
$('#btnCopySheet').addEventListener('click', () => copyText(lyricsToText(project, true), 'コード譜'));

$('#btnIdeas').addEventListener('click', () => {
  runAI('タイトル案', async () => {
    const res = await suggestIdeas({ ...aiOpts(), instruction: $('#aiInstruction').value.trim() });
    const body = $('#ideasBody');
    body.innerHTML = '';

    const titleBox = el('div');
    titleBox.append(el('h4', null, 'タイトル案（クリックで反映）'));
    for (const t of res.titles || []) {
      const item = el('div', 'idea-item', t);
      item.addEventListener('click', () => {
        project.title = t;
        persist(); syncTopbar();
        toast(`タイトルを「${t}」にしました`);
      });
      titleBox.append(item);
    }

    const themeBox = el('div');
    themeBox.append(el('h4', null, '世界観の案（クリックでテーマ欄に反映）'));
    for (const t of res.themes || []) {
      const item = el('div', 'idea-item', t);
      item.addEventListener('click', () => {
        project.theme = t;
        persist(); syncTopbar();
        toast('テーマに反映しました');
      });
      themeBox.append(item);
    }

    body.append(titleBox, themeBox);
    if (res.comment) body.append(el('p', 'hint', res.comment));
    $('#ideasDlg').showModal();
    return '案を出しました';
  });
});

$('#btnReset').addEventListener('click', () => {
  // 前は今の曲を捨てていたが、保存庫に残るようになったので確認は要らない
  createSong();
});

/* --- 曲の一覧 --- */

/** 別の曲に切り替える。いま開いている曲は保存済みなので、そのまま差し替える */
function openSong(id) {
  const next = loadSong(id);
  if (!next) { toast('その曲を読み込めませんでした', true); return; }
  player.stop();
  songId = id;
  project = next;
  setCurrentId(id);
  // 曲が変われば履歴も別物になる
  undoStack.length = 0;
  redoStack.length = 0;
  baseline = JSON.stringify(project);
  lastPushTag = '';
  selection.clear();
  openTools.clear();
  openPalettes.clear();
  render();
  syncTopbar();
  syncUndoButtons();
  toast(`「${project.title}」を開きました`);
}

/** 新しい曲を作る。いまの曲は保存庫に残る */
function createSong(base = null) {
  storeCurrent();
  const id = newSongId();
  const fresh = base || defaultProject();
  try {
    saveSong(id, fresh);
  } catch {
    toast('保存領域がいっぱいで、新しい曲を作れませんでした', true);
    return;
  }
  openSong(id);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function renderLibrary() {
  const list = $('#libraryList');
  list.innerHTML = '';
  const entries = loadIndex();

  if (!entries.length) {
    list.append(el('div', 'lib-empty', 'まだ保存された曲がありません'));
  }
  for (const e of entries) {
    const row = el('div', 'lib-item');
    if (e.id === songId) row.classList.add('current');

    const open = el('button', 'lib-open');
    open.type = 'button';
    open.append(
      el('div', 'lib-title', e.title || '無題'),
      el('div', 'lib-meta',
        `${e.key}${e.mode === 'minor' ? 'm' : ''} / ${e.bpm}BPM / ${e.bars}小節 / 歌詞${e.lyricBars}小節 · ${fmtDate(e.updatedAt)}`),
    );
    open.addEventListener('click', () => {
      if (e.id !== songId) openSong(e.id);
      $('#libraryDlg').close();
    });
    row.append(open);

    if (e.id === songId) row.append(el('span', 'lib-badge', '編集中'));

    const dup = el('button', 'mini', '複製');
    dup.type = 'button';
    dup.title = '書きかけを残したまま別案を試す';
    dup.addEventListener('click', () => {
      if (e.id === songId) storeCurrent();
      const made = duplicateSong(e.id);
      if (!made) { toast('複製できませんでした', true); return; }
      renderLibrary();
      toast(`「${made.project.title}」を作りました`);
    });

    const del = el('button', 'mini', '削除');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!confirm(`「${e.title}」を削除します。元に戻せません。よろしいですか？`)) return;
      const wasCurrent = e.id === songId;
      deleteSong(e.id);
      if (wasCurrent) {
        // 編集中の曲を消したら、残っている曲か新しい曲へ移る
        const next = loadIndex()[0];
        if (next) openSong(next.id); else createSong();
      }
      renderLibrary();
      toast('削除しました');
    });

    row.append(dup, del);
    list.append(row);
  }

  $('#libStats').textContent = entries.length ? `${entries.length}曲` : '';
}

$('#btnLibrary').addEventListener('click', () => {
  storeCurrent();
  renderLibrary();
  $('#libraryDlg').showModal();
});

$('#btnNewSong').addEventListener('click', () => {
  createSong();
  $('#libraryDlg').close();
});

/* --- 設定ダイアログ --- */
$('#openSettings').addEventListener('click', () => $('#settingsDlg').showModal());
$('#apiKeyInput').addEventListener('input', (e) => {
  settings.apiKey = e.target.value.trim();
  saveSettings(settings);
});
$('#modelSel').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(settings); });
$('#effortSel').addEventListener('change', (e) => { settings.effort = e.target.value; saveSettings(settings); });
$('#btnClearKey').addEventListener('click', () => {
  settings.apiKey = '';
  $('#apiKeyInput').value = '';
  saveSettings(settings);
  $('#keyStatus').textContent = 'キーを削除しました';
  $('#keyStatus').className = 'ai-status';
});
$('#btnTestKey').addEventListener('click', async () => {
  const status = $('#keyStatus');
  status.textContent = '接続中…';
  status.className = 'ai-status busy';
  try {
    await testKey({ apiKey: settings.apiKey, model: settings.model });
    status.textContent = '接続できました';
    status.className = 'ai-status ok';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'ai-status err';
  }
});

/* ------------------------------------------------------------------ */
/* 起動                                                                 */
/* ------------------------------------------------------------------ */

fillSelect($('#keySel'), KEYS.map((k) => ({ id: k, label: k })), project.key);
fillSelect($('#modeSel'), MODES, project.mode);
fillSelect($('#moodSel'), MOODS, project.mood);
fillSelect($('#patternSel'), PATTERNS, project.pattern);
fillSelect($('#modelSel'), MODELS, settings.model);
fillSelect($('#effortSel'), EFFORTS, settings.effort);

$('#apiKeyInput').value = settings.apiKey;
$('#clickChk').checked = settings.click;
$('#chordsChk').checked = settings.playChords;
$('#loopChk').checked = settings.loop;
$('#compactChk').checked = !!settings.compact;
applyCompact();
$('#melodyChk').checked = settings.playMelody;
$('#volInput').value = String(settings.volume);
player.pattern = project.pattern;
player.click = settings.click;
player.playChords = settings.playChords;
player.playMelody = settings.playMelody;
player.setVolume(settings.volume);

syncTopbar();
render();
syncUndoButtons();

window.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);

  if (ev.code === 'Space' && !typing) {
    ev.preventDefault();
    if (player.playing) player.stop(); else startPlayback(null);
    return;
  }
  // 入力中の Ctrl+Z はブラウザの文字取り消しに任せる（打ち間違いを1文字戻したいはずなので）
  if (!typing && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) redo(); else undo();
  }
});
