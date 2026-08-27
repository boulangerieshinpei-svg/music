// 曲を複数ためておくための保存庫。
//
// 目次（一覧表示用の要約）と本体を分けて持つ。
// 一覧を出すたびに全曲を読み込まずに済み、保存も1曲分だけで済む。

import { normalizeProject } from './state.js';

const INDEX_KEY = 'vocalo-sketch:index';
const SONG_PREFIX = 'vocalo-sketch:song:';
const CURRENT_KEY = 'vocalo-sketch:current';
const LEGACY_KEY = 'vocalo-sketch:project';   // 1曲しか持てなかった頃の保存先

export class StorageFullError extends Error {}

let idCounter = 0;
export function newSongId() {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // 容量超過は黙って失敗させると作業が消えるので、呼び出し側に知らせる
    if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
      throw new StorageFullError('保存領域がいっぱいです');
    }
    return false;
  }
}

/** 一覧に出す要約を作る */
function summarize(id, project) {
  return {
    id,
    title: project.title || '無題',
    key: project.key,
    mode: project.mode,
    bpm: project.bpm,
    sections: project.sections.length,
    bars: project.sections.reduce((n, s) => n + s.bars.length, 0),
    lyricBars: project.sections.reduce(
      (n, s) => n + s.bars.filter((b) => b.lyric.trim()).length, 0
    ),
    updatedAt: Date.now(),
  };
}

/** 新しい順の一覧 */
export function loadIndex() {
  const list = read(INDEX_KEY, []);
  return Array.isArray(list) ? list.slice().sort((a, b) => b.updatedAt - a.updatedAt) : [];
}

function writeIndex(list) {
  write(INDEX_KEY, list);
}

export function saveSong(id, project) {
  write(SONG_PREFIX + id, project);
  const list = read(INDEX_KEY, []).filter((e) => e.id !== id);
  list.push(summarize(id, project));
  writeIndex(list);
}

export function loadSong(id) {
  const raw = read(SONG_PREFIX + id, null);
  return raw ? normalizeProject(raw) : null;
}

export function deleteSong(id) {
  try { localStorage.removeItem(SONG_PREFIX + id); } catch { /* 消せなくても一覧からは外す */ }
  writeIndex(read(INDEX_KEY, []).filter((e) => e.id !== id));
  if (currentId() === id) setCurrentId(null);
}

/** 曲を複製する。書きかけを壊さずに別案を試すため */
export function duplicateSong(id) {
  const project = loadSong(id);
  if (!project) return null;
  project.title = `${project.title} のコピー`;
  const newId = newSongId();
  saveSong(newId, project);
  return { id: newId, project };
}

export function currentId() {
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
}

export function setCurrentId(id) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch { /* 保存できなくても、その場の作業は続けられる */ }
}

/**
 * 1曲しか持てなかった頃のデータを保存庫へ移す。
 * 既存の作業を失わせないための処理で、1度だけ走る。
 */
export function migrateLegacy() {
  const legacy = read(LEGACY_KEY, null);
  if (!legacy) return null;
  const id = newSongId();
  saveSong(id, normalizeProject(legacy));
  setCurrentId(id);
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* 残っても実害はない */ }
  return id;
}

/** 起動時に開く曲を決める。無ければ null（呼び出し側で新規作成する） */
export function resolveOpening() {
  const id = currentId();
  if (id) {
    const project = loadSong(id);
    if (project) return { id, project };
  }
  const first = loadIndex()[0];
  if (first) {
    const project = loadSong(first.id);
    if (project) return { id: first.id, project };
  }
  return null;
}
