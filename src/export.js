// 外部ツールへ渡すためのファイル書き出し。
//
// - MIDI      … Studio One などのDAW向け（メロディ＋コード、テンポ・拍子・調号つき）
// - MusicXML  … Synthesizer V 向け（メロディ＋かな歌詞。1音符に1モーラを割り当てる）
//
// SynthV は MIDI からの歌詞取り込みが不安定なため、歌詞を渡したい場合は MusicXML を使う。

import { parseChord, intervalsFor, noteToPc } from './theory.js';
import { splitMora, hasKanji } from './mora.js';
import { rowToMidi } from './melody.js';

const TPQ = 480;        // MIDI の4分音符あたりのティック数
const DIVISIONS = 48;   // MusicXML の4分音符あたりの分割数

/* ------------------------------------------------------------------ */
/* 共通                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 1小節ぶんのメロディを単旋律に整える。
 * グリッドでは同じ位置に複数の高さを置けてしまうが、歌もMusicXMLも単旋律が前提。
 * 同時に鳴る音は高い方を残し、長さは次の音の頭までに詰める。
 */
export function monophonize(melody, steps) {
  if (!melody.length) return [];
  const byOnset = new Map();
  for (const n of melody) {
    const cur = byOnset.get(n.s);
    if (!cur || n.n > cur.n) byOnset.set(n.s, n);
  }
  const onsets = [...byOnset.keys()].sort((a, b) => a - b);
  return onsets.map((s, i) => {
    const note = byOnset.get(s);
    const limit = (onsets[i + 1] ?? steps) - s;
    return { s, d: Math.max(1, Math.min(note.d, limit)), n: note.n };
  });
}

/** その小節の歌詞をモーラ単位のかなに分ける。読みが分からない場合は null */
export function barMora(bar) {
  if (bar.yomi) return splitMora(bar.yomi);
  if (bar.lyric && !hasKanji(bar.lyric)) return splitMora(bar.lyric);
  return null;   // 漢字混じりで読みが無いと、正しいかなに割れない
}

/** 曲の中の全小節を、セクションの情報つきで順に並べる */
function allBars(project) {
  const out = [];
  for (const sec of project.sections) {
    for (const bar of sec.bars) out.push({ bar, section: sec });
  }
  return out;
}

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_FIFTHS = { C: 0, Db: -5, D: 2, Eb: -3, E: 4, F: -1, Gb: -6, G: 1, Ab: -4, A: 3, Bb: -2, B: 5 };

/** 調号（シャープ/フラットの数）。マイナーは平行調のメジャーと同じ */
function fifthsOf(key, mode) {
  if (mode === 'minor') {
    const rel = KEYS[(noteToPc(key) + 3) % 12];
    return MAJOR_FIFTHS[rel] ?? 0;
  }
  return MAJOR_FIFTHS[key] ?? 0;
}

/* ------------------------------------------------------------------ */
/* MIDI                                                                */
/* ------------------------------------------------------------------ */

function vlq(value) {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function textBytes(str) {
  return [...new TextEncoder().encode(str)];
}

function chunk(id, data) {
  const len = data.length;
  return [
    ...textBytes(id),
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...data,
  ];
}

/** {tick, bytes} の配列を、デルタタイム付きのトラックチャンクにする */
function buildTrack(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let prev = 0;
  for (const ev of events) {
    data.push(...vlq(ev.tick - prev), ...ev.bytes);
    prev = ev.tick;
  }
  data.push(...vlq(0), 0xff, 0x2f, 0x00);   // End of Track
  return chunk('MTrk', data);
}

function metaText(type, str) {
  const bytes = textBytes(str);
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

/**
 * MIDIファイル（フォーマット1）を組み立てる。
 * トラック1 = テンポなど、トラック2 = メロディ、トラック3 = コード。
 */
export function toMidi(project) {
  const barTicks = project.beatsPerBar * TPQ;
  const usPerQuarter = Math.round(60000000 / project.bpm);

  const conductor = [
    { tick: 0, order: 0, bytes: metaText(0x03, project.title || 'song') },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03,
      (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    // 拍子は「4分音符 × beatsPerBar」で数えているので分母は常に4
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, project.beatsPerBar, 2, 24, 8] },
    { tick: 0, order: 3, bytes: [0xff, 0x59, 0x02,
      fifthsOf(project.key, project.mode) & 0xff, project.mode === 'minor' ? 1 : 0] },
  ];

  const melody = [{ tick: 0, order: 0, bytes: metaText(0x03, 'Melody') }];
  const chords = [{ tick: 0, order: 0, bytes: metaText(0x03, 'Chords') }];

  let tick = 0;
  let order = 1;
  for (const { bar, section } of allBars(project)) {
    const stepTicks = barTicks / section.steps;

    for (const n of monophonize(bar.melody, section.steps)) {
      const start = Math.round(tick + n.s * stepTicks);
      const end = Math.round(tick + (n.s + n.d) * stepTicks);
      const midi = rowToMidi(project, n.n);
      melody.push({ tick: start, order: order++, bytes: [0x90, midi, 96] });
      melody.push({ tick: end, order: order++, bytes: [0x80, midi, 0] });
    }

    const c = parseChord(bar.chord);
    if (c) {
      for (const iv of intervalsFor(c.quality)) {
        const midi = 48 + c.rootPc + iv;
        chords.push({ tick, order: order++, bytes: [0x91, midi, 70] });
        chords.push({ tick: tick + barTicks, order: order++, bytes: [0x81, midi, 0] });
      }
    }
    tick += barTicks;
  }

  // MThd の中身は6バイト固定: フォーマット(2) / トラック数(2) / 分解能(2)
  const header = chunk('MThd', [0, 1, 0, 3, (TPQ >> 8) & 0xff, TPQ & 0xff]);
  return new Uint8Array([
    ...header,
    ...buildTrack(conductor),
    ...buildTrack(melody),
    ...buildTrack(chords),
  ]);
}

/* ------------------------------------------------------------------ */
/* MusicXML                                                            */
/* ------------------------------------------------------------------ */

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SHARP_STEPS = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];

/** MIDIノート番号を MusicXML の <pitch> に変換する */
function pitchXml(midi) {
  const [step, alter] = SHARP_STEPS[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

const TYPES = [
  [4, 'whole'], [2, 'half'], [1, 'quarter'],
  [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd'],
];

/** 音価（4分音符いくつ分か）から記譜上の音符種別を決める */
function noteType(quarters) {
  for (const [q, name] of TYPES) {
    if (Math.abs(quarters - q) < 1e-6) return { type: name, dots: 0 };
    if (Math.abs(quarters - q * 1.5) < 1e-6) return { type: name, dots: 1 };
  }
  // 割り切れない長さは、近い種別に寄せる（音の長さ自体は duration が正）
  let best = TYPES[TYPES.length - 1];
  for (const t of TYPES) if (quarters >= t[0] - 1e-6) { best = t; break; }
  return { type: best[1], dots: 0 };
}

function noteXml({ midi, duration, lyric, rest = false }) {
  const { type, dots } = noteType(duration / DIVISIONS);
  const body = rest ? '<rest/>' : pitchXml(midi);
  const lyricXml = lyric
    ? `<lyric><syllabic>single</syllabic><text>${xmlEscape(lyric)}</text></lyric>`
    : '';
  return `      <note>${body}<duration>${duration}</duration><voice>1</voice>` +
    `<type>${type}</type>${'<dot/>'.repeat(dots)}${lyricXml}</note>`;
}

/**
 * MusicXML を組み立てる（メロディ1パートのみ）。
 * 歌詞は1音符に1モーラ。読みが分からない小節（漢字混じりで yomi 無し）は歌詞を付けない。
 * @returns {{xml:string, notes:number, withLyric:number, unknownReading:number, mismatched:number}}
 */
export function toMusicXML(project) {
  const measures = [];
  let notes = 0;
  let withLyric = 0;
  let unknownReading = 0;
  let mismatched = 0;

  allBars(project).forEach(({ bar, section }, index) => {
    const stepDur = (project.beatsPerBar * DIVISIONS) / section.steps;
    const barDur = project.beatsPerBar * DIVISIONS;
    const mono = monophonize(bar.melody, section.steps);
    const mora = barMora(bar);
    if (mora === null && bar.lyric) unknownReading += 1;
    if (mora && mono.length && mora.length !== mono.length) mismatched += 1;

    const rows = [];
    if (index === 0) {
      rows.push(
        '      <attributes>',
        `        <divisions>${DIVISIONS}</divisions>`,
        `        <key><fifths>${fifthsOf(project.key, project.mode)}</fifths>` +
          `<mode>${project.mode}</mode></key>`,
        `        <time><beats>${project.beatsPerBar}</beats><beat-type>4</beat-type></time>`,
        '        <clef><sign>G</sign><line>2</line></clef>',
        '      </attributes>',
        `      <direction placement="above"><direction-type><metronome>` +
          `<beat-unit>quarter</beat-unit><per-minute>${project.bpm}</per-minute>` +
          `</metronome></direction-type><sound tempo="${project.bpm}"/></direction>`,
      );
    }

    let pos = 0;
    mono.forEach((n, i) => {
      const start = Math.round(n.s * stepDur);
      if (start > pos) rows.push(noteXml({ duration: start - pos, rest: true }));
      const duration = Math.round(n.d * stepDur);
      const syllable = mora?.[i] ?? null;
      if (syllable) withLyric += 1;
      rows.push(noteXml({ midi: rowToMidi(project, n.n), duration, lyric: syllable }));
      notes += 1;
      pos = start + duration;
    });
    if (pos < barDur) rows.push(noteXml({ duration: barDur - pos, rest: true }));

    measures.push(`    <measure number="${index + 1}">\n${rows.join('\n')}\n    </measure>`);
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
      '"http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `  <work><work-title>${xmlEscape(project.title || '無題')}</work-title></work>`,
    '  <part-list>',
    '    <score-part id="P1"><part-name>Melody</part-name></score-part>',
    '  </part-list>',
    '  <part id="P1">',
    ...measures,
    '  </part>',
    '</score-partwise>',
    '',
  ].join('\n');

  return { xml, notes, withLyric, unknownReading, mismatched };
}

/* ------------------------------------------------------------------ */
/* かな歌詞（貼り付け用）                                                */
/* ------------------------------------------------------------------ */

/**
 * SynthV に貼り付けるためのかな歌詞。
 * SynthV は音符ひとつにかなひとつを入れるので、モーラ単位で区切って出す。
 */
export function kanaLyrics(project, separator = ' ') {
  const lines = [];
  let unknown = 0;
  for (const sec of project.sections) {
    const body = [];
    for (const bar of sec.bars) {
      if (!bar.lyric) continue;
      const mora = barMora(bar);
      if (mora === null) { unknown += 1; body.push(`【読み不明】${bar.lyric}`); continue; }
      body.push(mora.join(separator));
    }
    if (body.length) lines.push(`[${sec.name}]`, ...body, '');
  }
  return { text: lines.join('\n'), unknown };
}
