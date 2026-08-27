// プロジェクトのデータモデルと永続化（localStorage / JSON）

import { progressionInKey, transposeChord, keyPrefersFlats, noteToPc } from './theory.js';

const STORAGE_KEY = 'vocalo-sketch:project';
const SETTINGS_KEY = 'vocalo-sketch:settings';
export const PROJECT_VERSION = 1;

export const ROLES = [
  { id: 'intro',  label: 'Intro',  short: 'In' },
  { id: 'A',      label: 'Aメロ',  short: 'A' },
  { id: 'B',      label: 'Bメロ',  short: 'B' },
  { id: 'chorus', label: 'サビ',   short: '♪' },
  { id: 'C',      label: 'Cメロ',  short: 'C' },
  { id: 'outro',  label: 'Outro',  short: 'Out' },
];

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

export function makeBar(chord = '', lyric = '', yomi = '') {
  // yomi は AI が返した読み。あるとモーラ数を正確に数えられる。
  return { id: uid('bar'), chord, lyric, yomi };
}

export function makeSection(role = 'A', name = null, bars = 4) {
  const roleDef = ROLES.find((r) => r.id === role) || ROLES[1];
  return {
    id: uid('sec'),
    role,
    name: name || roleDef.label,
    moraPerBar: role === 'chorus' ? 8 : 7,
    bars: Array.from({ length: bars }, () => makeBar()),
  };
}

export function defaultProject() {
  const key = 'C';
  const mode = 'major';
  const p = {
    version: PROJECT_VERSION,
    title: '無題のうた',
    key,
    mode,
    bpm: 150,
    beatsPerBar: 4,
    mood: 'setsunai',
    theme: '',
    sections: [
      makeSection('A', 'Aメロ', 8),
      makeSection('B', 'Bメロ', 4),
      makeSection('chorus', 'サビ', 8),
    ],
  };
  // 初期コードを入れておく（空だと何もできない画面になるため）
  const seed = {
    A: ['Am7', 'Am7', 'FM7', 'FM7', 'CM7', 'CM7', 'Dm7', 'G7'],
    B: ['FM7', 'G7', 'Em7', 'Am'],
    chorus: ['FM7', 'G7', 'Em7', 'Am', 'FM7', 'G7', 'C', 'C'],
  };
  for (const sec of p.sections) {
    const chords = progressionInKey(seed[sec.role] || [], 'major', key);
    sec.bars.forEach((bar, i) => { bar.chord = chords[i % chords.length] || ''; });
  }
  return p;
}

/** 読み込んだデータが壊れていても落ちないように整える */
export function normalizeProject(raw) {
  const base = defaultProject();
  if (!raw || typeof raw !== 'object') return base;
  const p = {
    version: PROJECT_VERSION,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    key: typeof raw.key === 'string' && noteToPc(raw.key) !== null ? raw.key : base.key,
    mode: raw.mode === 'minor' ? 'minor' : 'major',
    bpm: Number.isFinite(+raw.bpm) ? Math.min(300, Math.max(40, Math.round(+raw.bpm))) : base.bpm,
    beatsPerBar: [2, 3, 4, 6].includes(+raw.beatsPerBar) ? +raw.beatsPerBar : 4,
    mood: typeof raw.mood === 'string' ? raw.mood : base.mood,
    theme: typeof raw.theme === 'string' ? raw.theme : '',
    sections: [],
  };
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  p.sections = sections.map((s) => {
    const role = ROLES.some((r) => r.id === s?.role) ? s.role : 'A';
    const bars = Array.isArray(s?.bars) ? s.bars : [];
    return {
      id: uid('sec'),
      role,
      name: typeof s?.name === 'string' && s.name ? s.name : (ROLES.find((r) => r.id === role)?.label ?? role),
      moraPerBar: Number.isFinite(+s?.moraPerBar) ? Math.max(1, Math.min(24, Math.round(+s.moraPerBar))) : 7,
      bars: (bars.length ? bars : [{}, {}, {}, {}]).map((b) =>
        makeBar(
          typeof b?.chord === 'string' ? b.chord : '',
          typeof b?.lyric === 'string' ? b.lyric : '',
          typeof b?.yomi === 'string' ? b.yomi : ''
        )
      ),
    };
  });
  if (!p.sections.length) p.sections = base.sections;
  return p;
}

/** 曲全体を移調する */
export function transposeProject(project, semitones) {
  const toPc = ((noteToPc(project.key) + semitones) % 12 + 12) % 12;
  const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const newKey = KEYS[toPc];
  const flats = keyPrefersFlats(newKey, project.mode);
  for (const sec of project.sections) {
    for (const bar of sec.bars) {
      if (bar.chord) bar.chord = transposeChord(bar.chord, semitones, flats);
    }
  }
  project.key = newKey;
  return project;
}

export function totalBars(project) {
  return project.sections.reduce((n, s) => n + s.bars.length, 0);
}

/** 曲の長さ（秒） */
export function estimateSeconds(project) {
  const secPerBar = (60 / project.bpm) * project.beatsPerBar;
  return totalBars(project) * secPerBar;
}

export function saveLocal(project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* プライベートモード等では黙って諦める */ }
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

/** 歌詞をテキストで書き出す */
export function lyricsToText(project, withChords = false) {
  const out = [`# ${project.title}`, `Key: ${project.key}${project.mode === 'minor' ? 'm' : ''} / BPM: ${project.bpm}`, ''];
  for (const sec of project.sections) {
    out.push(`[${sec.name}]`);
    for (const bar of sec.bars) {
      if (withChords) out.push(`${(bar.chord || '-').padEnd(8)}| ${bar.lyric || ''}`);
      else if (bar.lyric) out.push(bar.lyric);
    }
    out.push('');
  }
  return out.join('\n');
}
