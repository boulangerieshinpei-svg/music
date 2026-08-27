// 画面の組み立てとイベント配線

import {
  KEYS, MODES, diatonicChords, spiceChords, PROGRESSIONS, progressionInKey, parseChord,
} from './theory.js';
import { countMora, hasKanji } from './mora.js';
import {
  ROLES, defaultProject, normalizeProject, makeSection, makeBar, transposeProject,
  saveLocal, loadLocal, saveSettings, loadSettings, totalBars, estimateSeconds, lyricsToText,
} from './state.js';
import { MOODS, generateLyrics, generateProgression } from './generator.js';
import { Player, PATTERNS } from './audio.js';
import { MODELS, EFFORTS, writeLyrics, suggestChords, suggestIdeas, testKey, AIError } from './ai.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

let project = loadLocal() || defaultProject();
let settings = Object.assign(
  { apiKey: '', model: MODELS[0].id, effort: 'medium', pattern: 'pad', click: true, volume: 0.7 },
  loadSettings()
);
const selection = new Set();     // "sectionId#barIndex"
const openPalettes = new Set();  // sectionId
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

function persist() {
  saveLocal(project);
  updateStats();
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
  updateStats();
}

/* ------------------------------------------------------------------ */
/* セクション描画                                                       */
/* ------------------------------------------------------------------ */

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

  const mora = el('div', 'mora');
  fillMora(mora, section, bar);

  node.append(head, chord, lyric, mora);
  return node;
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
    mk('🎲 コード', 'gen-chords', 'オフラインでコード進行のたたきを作る'),
    mk('🎲 歌詞', 'gen-lyrics', 'オフラインで歌詞のたたきを作る'),
    mk('✨ AIコード', 'ai-chords', '選択した小節（未選択ならセクション全体）のコードをAIが提案', true),
    mk('✨ AI歌詞', 'ai-lyrics', '選択した小節（未選択ならセクション全体）の歌詞をAIが書き換え', true),
  );

  const tools = el('div', 'head-group');
  tools.append(
    mk('▶', 'play-section', 'このセクションだけ再生'),
    mk('🎹', 'toggle-palette', 'コードパレットを開閉'),
    mk('↑', 'move-up', '上へ'),
    mk('↓', 'move-down', '下へ'),
    mk('複製', 'duplicate', 'このセクションを複製'),
    mk('✕', 'delete-section', 'このセクションを削除'),
  );

  head.append(tag, name, barsLabel, moraLabel, el('span', 'spacer'), group, tools);

  const bars = el('div', 'bars');
  section.bars.forEach((bar, i) => bars.append(renderBar(section, bar, i)));

  node.append(head, bars, renderPalette(section));
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

function collectBars(sectionFilter = null) {
  const out = [];
  project.sections.forEach((sec, si) => {
    if (sectionFilter && sec.id !== sectionFilter) return;
    sec.bars.forEach((bar, bi) => out.push({ chord: bar.chord, sectionIndex: si, barIndex: bi }));
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
  const bars = collectBars(sectionId);
  if (!bars.length) { toast('鳴らす小節がありません', true); return; }
  player.pattern = settings.pattern;
  player.click = settings.click;
  player.setVolume(settings.volume);
  player.onBar = (_, si, bi) => highlight(si, bi);
  player.onStop = () => {
    document.querySelectorAll('.bar.playing, .section.playing')
      .forEach((n) => n.classList.remove('playing'));
    $('#stopAll').disabled = true;
    $('#playAll').textContent = '▶ 全体再生';
  };
  player.play(bars, { bpm: project.bpm, beatsPerBar: project.beatsPerBar, loop: !!sectionId });
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

$('#sections').addEventListener('input', (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const section = sectionOf(target);
  if (!section) return;
  const barNode = target.closest('.bar');

  switch (target.dataset.act) {
    case 'section-name':
      section.name = target.value;
      persist();
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
    case 'chord': {
      const bar = section.bars[Number(barNode.dataset.index)];
      bar.chord = target.value;
      target.classList.toggle('invalid', !!bar.chord && !parseChord(bar.chord));
      persist();
      break;
    }
    case 'lyric': {
      const bar = section.bars[Number(barNode.dataset.index)];
      bar.lyric = target.value;
      bar.yomi = '';  // 手で書き換えたらAI由来の読みは破棄
      refreshMora(barNode, section, bar);
      persist();
      break;
    }
  }
});

/* --- 上部バー --- */
$('#songTitle').addEventListener('input', (e) => { project.title = e.target.value; persist(); });
$('#themeInput').addEventListener('input', (e) => { project.theme = e.target.value; persist(); });
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
  settings.pattern = e.target.value;
  player.pattern = e.target.value;
  saveSettings(settings);
});
$('#clickChk').addEventListener('change', (e) => {
  settings.click = e.target.checked;
  player.click = e.target.checked;
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
$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(project.title || 'song').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    project = normalizeProject(JSON.parse(await file.text()));
    selection.clear();
    persist(); render(); syncTopbar();
    toast('読み込みました');
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
  if (!confirm('現在の内容を破棄して新規作成します。よろしいですか？')) return;
  project = defaultProject();
  selection.clear();
  persist(); render(); syncTopbar();
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
fillSelect($('#patternSel'), PATTERNS, settings.pattern);
fillSelect($('#modelSel'), MODELS, settings.model);
fillSelect($('#effortSel'), EFFORTS, settings.effort);

$('#apiKeyInput').value = settings.apiKey;
$('#clickChk').checked = settings.click;
$('#volInput').value = String(settings.volume);
player.pattern = settings.pattern;
player.click = settings.click;
player.setVolume(settings.volume);

syncTopbar();
render();

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) {
    ev.preventDefault();
    if (player.playing) player.stop(); else startPlayback(null);
  }
});
