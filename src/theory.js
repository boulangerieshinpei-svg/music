// 音楽理論まわりのユーティリティ（キー・コード・移調・ダイアトニック）

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// フラット表記を好むキー（調号にフラットが付くキー）
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

export const KEYS = [
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
];

export const MODES = [
  { id: 'major', label: 'メジャー' },
  { id: 'minor', label: 'マイナー' },
];

/** 音名 -> ピッチクラス(0-11) */
export function noteToPc(name) {
  const m = /^([A-Ga-g])([#b♯♭]*)/.exec(name.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  let pc = base;
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') pc += 1;
    if (ch === 'b' || ch === '♭') pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

/** ピッチクラス -> 音名 */
export function pcToNote(pc, preferFlats = false) {
  const i = ((pc % 12) + 12) % 12;
  return preferFlats ? FLAT_NAMES[i] : SHARP_NAMES[i];
}

export function keyPrefersFlats(key, mode) {
  return FLAT_KEYS.has(mode === 'minor' ? key + 'm' : key);
}

/** コード種別 -> ルートからの音程(半音) */
export const CHORD_QUALITIES = {
  '':      [0, 4, 7],
  'M':     [0, 4, 7],
  'm':     [0, 3, 7],
  'dim':   [0, 3, 6],
  'aug':   [0, 4, 8],
  'sus4':  [0, 5, 7],
  'sus2':  [0, 2, 7],
  '5':     [0, 7],
  '6':     [0, 4, 7, 9],
  'm6':    [0, 3, 7, 9],
  '7':     [0, 4, 7, 10],
  'M7':    [0, 4, 7, 11],
  'maj7':  [0, 4, 7, 11],
  'm7':    [0, 3, 7, 10],
  'mM7':   [0, 3, 7, 11],
  'm7b5':  [0, 3, 6, 10],
  'dim7':  [0, 3, 6, 9],
  'add9':  [0, 4, 7, 14],
  'madd9': [0, 3, 7, 14],
  'sus4-7':[0, 5, 7, 10],
  '7sus4': [0, 5, 7, 10],
  '9':     [0, 4, 7, 10, 14],
  'M9':    [0, 4, 7, 11, 14],
  'm9':    [0, 3, 7, 10, 14],
  '7#5':   [0, 4, 8, 10],
  '7b9':   [0, 4, 7, 10, 13],
  '69':    [0, 4, 7, 9, 14],
};

/**
 * コード名をパースする。例: "FM7", "Am7", "F/G", "N.C."
 * @returns {{root:string, rootPc:number, quality:string, bass:string|null, bassPc:number|null}|null}
 */
export function parseChord(name) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw || /^(n\.?c\.?|-|—|%)$/i.test(raw)) return null;
  const [chordPart, bassPart] = raw.split('/');
  const m = /^([A-Ga-g][#b♯♭]*)(.*)$/.exec(chordPart.trim());
  if (!m) return null;
  const rootPc = noteToPc(m[1]);
  if (rootPc === null) return null;
  const quality = m[2].trim();
  const bassPc = bassPart ? noteToPc(bassPart) : null;
  return {
    root: m[1],
    rootPc,
    quality,
    bass: bassPart ? bassPart.trim() : null,
    bassPc,
  };
}

/** コード種別の構成音程を返す（未知の種別はメジャーにフォールバック） */
export function intervalsFor(quality) {
  if (quality in CHORD_QUALITIES) return CHORD_QUALITIES[quality];
  // "Am7(9)" のような括弧付きを緩く処理
  const cleaned = quality.replace(/[()（）\s]/g, '');
  if (cleaned in CHORD_QUALITIES) return CHORD_QUALITIES[cleaned];
  if (cleaned.startsWith('m') && !cleaned.startsWith('maj') && !cleaned.startsWith('M')) {
    return CHORD_QUALITIES['m'];
  }
  return CHORD_QUALITIES[''];
}

/** コードの構成音（ピッチクラス配列、テンションは12で丸めない生の音程） */
export function chordTones(name) {
  const c = parseChord(name);
  if (!c) return [];
  return intervalsFor(c.quality).map((iv) => c.rootPc + iv);
}

/** コード名を移調する */
export function transposeChord(name, semitones, preferFlats = false) {
  const raw = String(name || '').trim();
  const c = parseChord(raw);
  if (!c) return raw;
  const root = pcToNote(c.rootPc + semitones, preferFlats);
  const bass = c.bassPc === null ? null : pcToNote(c.bassPc + semitones, preferFlats);
  return root + c.quality + (bass ? '/' + bass : '');
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

const MAJOR_QUALITIES = ['M7', 'm7', 'm7', 'M7', '7', 'm7', 'm7b5'];
const MINOR_QUALITIES = ['m7', 'm7b5', 'M7', 'm7', 'm7', 'M7', '7'];
const MAJOR_DEGREES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MINOR_DEGREES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** キーのダイアトニックコード一覧 */
export function diatonicChords(key, mode, seventh = true) {
  const rootPc = noteToPc(key);
  const flats = keyPrefersFlats(key, mode);
  const scale = mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  const quals = mode === 'minor' ? MINOR_QUALITIES : MAJOR_QUALITIES;
  const degs = mode === 'minor' ? MINOR_DEGREES : MAJOR_DEGREES;
  return scale.map((iv, i) => {
    let q = quals[i];
    if (!seventh) {
      q = q === 'M7' ? '' : q === 'm7' ? 'm' : q === '7' ? '' : q === 'm7b5' ? 'dim' : q;
    }
    return {
      degree: degs[i],
      name: pcToNote(rootPc + iv, flats) + q,
    };
  });
}

/** よく使うノンダイアトニック（借用・セカンダリドミナント）候補 */
export function spiceChords(key, mode) {
  const rootPc = noteToPc(key);
  const flats = keyPrefersFlats(key, mode);
  const n = (iv, q) => pcToNote(rootPc + iv, flats) + q;
  if (mode === 'minor') {
    return [
      { label: 'V7 (ハーモニックマイナー)', name: n(7, '7') },
      { label: 'IVm7', name: n(5, 'm7') },
      { label: 'bVI M7', name: n(8, 'M7') },
      { label: 'bVII7', name: n(10, '7') },
      { label: 'II7 (ドリアン)', name: n(2, '7') },
      { label: 'sus4', name: n(7, '7sus4') },
    ];
  }
  return [
    { label: 'IVm7 (サブドミナントマイナー)', name: n(5, 'm7') },
    { label: 'bVII7', name: n(10, '7') },
    { label: 'III7 (セカンダリドミナント)', name: n(4, '7') },
    { label: 'VI7', name: n(9, '7') },
    { label: 'II7', name: n(2, '7') },
    { label: 'bVI M7', name: n(8, 'M7') },
    { label: 'V7sus4', name: n(7, '7sus4') },
    { label: 'IV/V (分数)', name: n(5, '') + '/' + pcToNote(rootPc + 7, flats) },
  ];
}

/**
 * Cメジャー / Aマイナー で書いたコード進行を、指定キーへ移調する
 */
export function progressionInKey(chordsInC, mode, key) {
  const fromPc = mode === 'minor' ? noteToPc('A') : noteToPc('C');
  const toPc = noteToPc(key);
  const semis = ((toPc - fromPc) % 12 + 12) % 12;
  const flats = keyPrefersFlats(key, mode);
  return chordsInC.map((c) => transposeChord(c, semis, flats));
}

/** 定番コード進行プリセット（Cメジャー / Aマイナー 表記） */
export const PROGRESSIONS = [
  { id: 'oudou',    name: '王道進行',            mode: 'major', chords: ['FM7', 'G7', 'Em7', 'Am'],       note: 'J-POP/ボカロ王道。切なさと高揚感' },
  { id: 'komuro',   name: '小室進行',            mode: 'minor', chords: ['Am', 'F', 'G', 'C'],            note: '疾走感。ロック系サビに強い' },
  { id: 'canon',    name: 'カノン進行',          mode: 'major', chords: ['C', 'G', 'Am', 'Em', 'F', 'C', 'F', 'G'], note: '安定感。バラード〜壮大サビ' },
  { id: 'marusa',   name: '丸サ進行 (Just the Two of Us)', mode: 'major', chords: ['FM7', 'E7', 'Am7', 'Gm7', 'C7'], note: 'お洒落・都会的。近年のボカロ頻出' },
  { id: 'komuro2',  name: '小室進行 (4536)',      mode: 'major', chords: ['F', 'G', 'Em', 'Am'],           note: '王道のトライアド版。素直に明るい' },
  { id: 'kirikaeshi',name: '4→5→3→6 逆循環',     mode: 'major', chords: ['Am7', 'Dm7', 'G7', 'CM7'],      note: 'ジャジー。Bメロやブリッジ向き' },
  { id: 'ichirokuni',name: 'IV-V-I 王道サビ締め', mode: 'major', chords: ['F', 'G', 'C', 'C'],            note: 'サビ終わりの決めに' },
  { id: 'kaiketsu', name: 'ラスサビ転調前',       mode: 'major', chords: ['FM7', 'G7', 'Em7', 'A7'],       note: '最後をA7にして次へ引っ張る' },
  { id: 'ede',      name: '哀愁マイナー循環',      mode: 'minor', chords: ['Am', 'Em', 'F', 'C'],           note: 'Aメロ向き。淡々とした語り' },
  { id: 'dorian',   name: 'ドリアン浮遊',         mode: 'minor', chords: ['Am7', 'D7', 'Am7', 'D7'],       note: '浮遊感。ダンス系イントロ' },
  { id: 'sus',      name: 'sus4 引っ張り',        mode: 'major', chords: ['C', 'Csus4', 'F', 'G7sus4'],    note: '溜めを作りたいとき' },
  { id: 'gekiatsu', name: '激アツ半音下降',        mode: 'minor', chords: ['Am', 'Am/G', 'F', 'E7'],        note: 'ベースが下がる。Bメロの緊張感' },
  { id: 'city',     name: 'シティポップ',         mode: 'major', chords: ['FM7', 'Em7', 'Dm7', 'G7'],      note: '洒落た下降。落ちサビにも' },
  { id: 'ballad',   name: 'バラード定番',         mode: 'major', chords: ['C', 'Am', 'Dm7', 'G7'],         note: '王道の1625。安心の響き' },
];

/** キーからスケール上の音（MIDIノート番号）を作る */
export function scaleNotes(key, mode, octave = 4) {
  const rootPc = noteToPc(key);
  const scale = mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  return scale.map((iv) => 12 * (octave + 1) + rootPc + iv);
}

/**
 * スケール上の段数(0=主音)を MIDI ノート番号に変換する。
 * メロディはこの段数で保存するので、移調してもキーに追従する。
 */
export function scaleIndexToMidi(key, mode, index, octave = 4) {
  const rootPc = noteToPc(key);
  const scale = mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  const oct = Math.floor(index / 7);
  const deg = ((index % 7) + 7) % 7;
  return 12 * (octave + 1) + rootPc + 12 * oct + scale[deg];
}

/** スケール段数の音名（表示用）。例: C キーの 0 -> 'C', 7 -> 'C' */
export function scaleIndexName(key, mode, index) {
  const midi = scaleIndexToMidi(key, mode, index);
  return pcToNote(midi % 12, keyPrefersFlats(key, mode));
}

/** MIDIノート番号 -> 周波数 */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
