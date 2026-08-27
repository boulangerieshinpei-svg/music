// メロディのデータ操作と、たたきメロディの自動生成。
//
// 音程は「キーのスケール上の段数」で保存する（0 = 主音）。
// 絶対音高で持たないので、移調してもメロディがキーに追従する。
// 音符は { s: 開始ステップ, d: 長さ(ステップ数), n: 段数 }。

import { scaleIndexToMidi, chordTones, parseChord } from './theory.js';

/** グリッドの行数。主音から1オクターブ+4度ぶん */
export const MELODY_ROWS = 12;

/** 1小節の分割数の選択肢 */
export const STEP_OPTIONS = [
  { id: '4', label: '4分' },
  { id: '8', label: '8分' },
  { id: '16', label: '16分' },
];

export function rowToMidi(project, row) {
  return scaleIndexToMidi(project.key, project.mode, row);
}

/** そのコードの構成音にあたる段数の集合を返す（グリッドの色分け用） */
export function chordToneRows(project, chordName) {
  const c = parseChord(chordName);
  if (!c) return { tones: new Set(), root: -1 };
  const pcs = new Set(chordTones(chordName).map((t) => ((t % 12) + 12) % 12));
  const tones = new Set();
  let root = -1;
  for (let row = 0; row < MELODY_ROWS; row++) {
    const pc = ((rowToMidi(project, row) % 12) + 12) % 12;
    if (pcs.has(pc)) tones.add(row);
    if (root < 0 && pc === c.rootPc) root = row;
  }
  return { tones, root };
}

/** (row, step) にかかっている音符を探す */
export function noteAt(melody, row, step) {
  return melody.find((n) => n.n === row && step >= n.s && step < n.s + n.d) || null;
}

/** 音符を追加する。同じ行の重なりは取り除く */
export function addNote(melody, note, steps) {
  const end = Math.min(steps, note.s + note.d);
  const clean = melody.filter(
    (n) => n.n !== note.n || n.s + n.d <= note.s || n.s >= end
  );
  clean.push({ s: note.s, d: end - note.s, n: note.n });
  clean.sort((a, b) => a.s - b.s || a.n - b.n);
  return clean;
}

export function removeNote(melody, note) {
  return melody.filter((n) => n !== note);
}

/** 分割数を変えたときに、音符の位置と長さを比例させる */
export function rescale(melody, fromSteps, toSteps) {
  const k = toSteps / fromSteps;
  return melody
    .map((n) => ({
      n: n.n,
      s: Math.round(n.s * k),
      d: Math.max(1, Math.round(n.d * k)),
    }))
    .filter((n) => n.s < toSteps)
    .map((n) => ({ ...n, d: Math.min(n.d, toSteps - n.s) }));
}

/** 再生用に、小節内の相対位置と MIDI ノート番号へ変換する */
export function toPlayable(project, melody, steps) {
  return melody.map((n) => ({
    start: n.s / steps,
    dur: n.d / steps,
    midi: rowToMidi(project, n.n),
  }));
}

/* ------------------------------------------------------------------ */
/* たたきメロディの生成                                                 */
/* ------------------------------------------------------------------ */

const rand = (a) => a[Math.floor(Math.random() * a.length)];

/** target に最も近いコード構成音の行 */
function nearestToneRow(tones, target) {
  if (!tones.size) return target;
  let best = target;
  let bestD = Infinity;
  for (const row of tones) {
    const d = Math.abs(row - target);
    if (d < bestD) { bestD = d; best = row; }
  }
  return best;
}

/** 音を置くステップを選ぶ。表拍を優先し、必要なら裏拍にも置く */
function pickSteps(steps, count, stepsPerBeat) {
  const strong = [];
  const weak = [];
  for (let i = 0; i < steps; i++) {
    if (i % stepsPerBeat === 0) strong.push(i);
    else weak.push(i);
  }
  // 表拍から順に、足りなければ裏拍を混ぜる
  const shuffledWeak = weak.slice().sort(() => Math.random() - 0.5);
  const chosen = new Set([0]);
  for (const s of strong) {
    if (chosen.size >= count) break;
    chosen.add(s);
  }
  for (const s of shuffledWeak) {
    if (chosen.size >= count) break;
    chosen.add(s);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * 1小節ぶんのメロディを作る
 * @param {object} o
 * @param {number} o.noteCount 置きたい音数（歌詞のモーラ数など）
 * @param {number} o.seedRow 直前の小節の終わりの高さ（つながりを作る）
 * @param {number} o.center この小節の中心の高さ（サビは高め、Aメロは低め）
 */
export function generateBarMelody({
  project, chord, steps, beatsPerBar, noteCount, seedRow = 4, center = 4,
}) {
  const stepsPerBeat = Math.max(1, Math.round(steps / beatsPerBar));
  const count = Math.max(1, Math.min(steps, noteCount));
  const positions = pickSteps(steps, count, stepsPerBeat);
  const { tones } = chordToneRows(project, chord);

  const notes = [];
  let row = nearestToneRow(tones, seedRow);

  positions.forEach((pos, i) => {
    if (i === 0) {
      // 小節アタマはコード構成音に置くと、まず外れない
      row = nearestToneRow(tones, seedRow);
    } else if (pos % stepsPerBeat === 0) {
      // 表拍もコード構成音へ寄せる
      row = nearestToneRow(tones, row + rand([-1, 0, 1]));
    } else {
      // 裏拍は隣接音で動かす（順次進行を基本にすると歌いやすい）
      row += rand([-2, -1, -1, 1, 1, 2]);
    }
    // 中心から離れすぎたら引き戻す
    if (row > center + 5) row = center + rand([2, 3, 4]);
    if (row < center - 4) row = center + rand([-2, -1, 0]);
    row = Math.max(0, Math.min(MELODY_ROWS - 1, row));

    const next = positions[i + 1] ?? steps;
    notes.push({ s: pos, d: Math.max(1, next - pos), n: row });
  });

  return { notes, lastRow: row };
}

/** セクションの役割ごとの音域の中心（サビを高くして盛り上げる） */
const CENTER_BY_ROLE = { intro: 3, A: 3, B: 4, chorus: 6, C: 5, outro: 3 };

/**
 * セクション全体のメロディを作る。
 * 歌詞が入っている小節はそのモーラ数に音数を合わせる。
 */
export function generateSectionMelody({ project, section, moraCounts }) {
  const steps = section.steps;
  const center = CENTER_BY_ROLE[section.role] ?? 4;
  let seedRow = center;
  return section.bars.map((bar, i) => {
    const noteCount = moraCounts[i] || section.moraPerBar;
    const res = generateBarMelody({
      project,
      chord: bar.chord,
      steps,
      beatsPerBar: project.beatsPerBar,
      noteCount,
      seedRow,
      center,
    });
    seedRow = res.lastRow;
    return res.notes;
  });
}
