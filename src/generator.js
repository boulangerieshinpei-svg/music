// オフラインでも動く「たたき」生成器。
// AIキーが無くても、歌詞のたたき台とコード進行を作れるようにする。
// 各フレーズは t(表示) と y(読み) を持ち、モーラ数は読みから計算する。

import { countMora, tailVowels } from './mora.js';
import { PROGRESSIONS, progressionInKey, diatonicChords, spiceChords } from './theory.js';

const f = (t, y) => ({ t, y, m: countMora(y), v: tailVowels(y, 2) });

export const MOODS = [
  { id: 'setsunai', label: '切ない' },
  { id: 'shissou',  label: '疾走' },
  { id: 'gensou',   label: '幻想' },
  { id: 'maemuki',  label: '前向き' },
  { id: 'ensei',    label: '厭世' },
];

// 行頭に置くフレーズ（情景・主語）
const HEADS = {
  setsunai: [
    f('夕暮れの街で', 'ゆうぐれのまちで'), f('触れられないまま', 'ふれられないまま'),
    f('君の横顔が', 'きみのよこがおが'), f('冷たい指先で', 'つめたいゆびさきで'),
    f('言えなかった言葉', 'いえなかったことば'), f('season の隙間に', 'しーずんのすきまに'),
    f('通りじゃなくて', 'とおりじゃなくて'), f('あの日のままの', 'あのひのままの'),
    f('半分だけの', 'はんぶんだけの'), f('雨に濡れた', 'あめにぬれた'),
  ],
  shissou: [
    f('夜を裂いて', 'よるをさいて'), f('息を切らして', 'いきをきらして'),
    f('信号が変わる前に', 'しんごうがかわるまえに'), f('鼓動が鳴る', 'こどうがなる'),
    f('走り出した', 'はしりだした'), f('アスファルト蹴って', 'あすふぁるとけって'),
    f('迷いごと全部', 'まよいごとぜんぶ'), f('壊れそうな speed で', 'こわれそうなすぴーどで'),
    f('今夜だけは', 'こんやだけは'), f('風を追い越して', 'かぜをおいこして'),
  ],
  gensou: [
    f('青い惑星の', 'あおいわくせいの'), f('透明な水槽で', 'とうめいなすいそうで'),
    f('溶けかけた月が', 'とけかけたつきが'), f('名前のない星に', 'なまえのないほしに'),
    f('夢の縁を', 'ゆめのふちを'), f('硝子の海に', 'がらすのうみに'),
    f('うたかたの', 'うたかたの'), f('目を閉じれば', 'めをとじれば'),
    f('銀色の雨が', 'ぎんいろのあめが'), f('誰もいない街で', 'だれもいないまちで'),
  ],
  maemuki: [
    f('明日の僕が', 'あしたのぼくが'), f('まだ間に合うよ', 'まだまにあうよ'),
    f('顔を上げて', 'かおをあげて'), f('小さな一歩で', 'ちいさないっぽで'),
    f('もう一度だけ', 'もういちどだけ'), f('手を伸ばせば', 'てをのばせば'),
    f('陽が昇るから', 'ひがのぼるから'), f('不安じゃなくて', 'ふあんじゃなくて'),
    f('遠回りでも', 'とおまわりでも'), f('声にすれば', 'こえにすれば'),
  ],
  ensei: [
    f('意味なんてないさ', 'いみなんてないさ'), f('正解の顔して', 'せいかいのかおして'),
    f('タイムラインの海で', 'たいむらいんのうみで'), f('誰かの言葉で', 'だれかのことばで'),
    f('生きてるフリして', 'いきてるふりして'), f('espresso みたいな', 'えすぷれっそみたいな'),
    f('どうせ明日も', 'どうせあしたも'), f('代わりじゃなくて', 'かわりじゃなくて'),
    f('剥がれた仮面で', 'はがれたかめんで'), f('数えきれない', 'かぞえきれない'),
  ],
};

// 行末に置くフレーズ（述部・締め）
const TAILS = {
  setsunai: [
    f('立ち尽くす', 'たちつくす'), f('泣いていた', 'ないていた'),
    f('消えていく', 'きえていく'), f('届かない', 'とどかない'),
    f('思い出してる', 'おもいだしてる'), f('見つけたの', 'みつけたの'),
    f('嘘をついた', 'うそをついた'), f('わからないまま', 'わからないまま'),
    f('抱きしめてた', 'だきしめてた'), f('置いてきた', 'おいてきた'),
    f('揺れている', 'ゆれている'), f('言えないよ', 'いえないよ'),
  ],
  shissou: [
    f('駆け抜けろ', 'かけぬけろ'), f('叫んでいた', 'さけんでいた'),
    f('飛び越えていく', 'とびこえていく'), f('止まらないで', 'とまらないで'),
    f('燃やしていく', 'もやしていく'), f('掴んでみせる', 'つかんでみせる'),
    f('振り切って', 'ふりきって'), f('加速していく', 'かそくしていく'),
    f('escape していく', 'えすけーぷしていく'), f('連れ出して', 'つれだして'),
  ],
  gensou: [
    f('揺らめいてる', 'ゆらめいてる'), f('降り積もる', 'ふりつもる'),
    f('溶けていく', 'とけていく'), f('眠っている', 'ねむっている'),
    f('遠くで光る', 'とおくでひかる'), f('息をする', 'いきをする'),
    f('沈んでいく', 'しずんでいく'), f('浮かんでいた', 'うかんでいた'),
    f('遠い声', 'とおいこえ'), f('祈っている', 'いのっている'),
  ],
  maemuki: [
    f('歩き出す', 'あるきだす'), f('笑っていたい', 'わらっていたい'),
    f('大丈夫だよ', 'だいじょうぶだよ'), f('続いていく', 'つづいていく'),
    f('信じてみる', 'しんじてみる'), f('進んでいく', 'すすんでいく'),
    f('届くはずさ', 'とどくはずさ'), f('始まるんだ', 'はじまるんだ'),
    f('抱きしめよう', 'だきしめよう'), f('迎えにいく', 'むかえにいく'),
  ],
  ensei: [
    f('笑ってる', 'わらってる'), f('沈んでいく', 'しずんでいく'),
    f('どうでもいいや', 'どうでもいいや'), f('繰り返してる', 'くりかえしてる'),
    f('生きている', 'いきている'), f('数えている', 'かぞえている'),
    f('壊れていく', 'こわれていく'), f('知らないふり', 'しらないふり'),
    f('待っている', 'まっている'), f('立ち止まってる', 'たちどまってる'),
  ],
};

const rand = (a) => a[Math.floor(Math.random() * a.length)];

/**
 * 指定モーラ数に近い1行を作る
 * @param {string} mood
 * @param {number} target 目標モーラ数
 * @param {string|null} rhymeWith 韻を合わせたい母音（例 'ai'）
 */
export function generateLine(mood, target, rhymeWith = null) {
  const heads = HEADS[mood] || HEADS.setsunai;
  let tails = TAILS[mood] || TAILS.setsunai;
  if (rhymeWith) {
    const matched = tails.filter((x) => x.v === rhymeWith);
    if (matched.length) tails = matched;
  }

  const candidates = [];
  for (const h of heads) {
    for (const t of tails) {
      candidates.push({ text: h.t + ' ' + t.t, yomi: h.y + t.y, m: h.m + t.m, v: t.v });
    }
  }
  for (const t of tails) candidates.push({ text: t.t, yomi: t.y, m: t.m, v: t.v });
  for (const h of heads) candidates.push({ text: h.t, yomi: h.y, m: h.m, v: h.v });

  const best = Math.min(...candidates.map((c) => Math.abs(c.m - target)));
  const pool = candidates.filter((c) => Math.abs(c.m - target) <= best + 1);
  return rand(pool);
}

/** セクション分の歌詞たたきを作る（小節数ぶんの行） */
export function generateLyrics(mood, bars, moraPerBar = 7, rhymeEvery = 2) {
  const lines = [];
  let rhymeVowel = null;
  for (let i = 0; i < bars; i++) {
    const wantRhyme = rhymeEvery > 0 && i % rhymeEvery === rhymeEvery - 1;
    const line = generateLine(mood, moraPerBar, wantRhyme ? rhymeVowel : null);
    if (!wantRhyme) rhymeVowel = line.v;
    lines.push(line.text);
  }
  return lines;
}

/** セクションの役割ごとの推奨プリセット */
const ROLE_HINT = {
  intro:  ['dorian', 'city', 'sus'],
  A:      ['ede', 'ballad', 'kirikaeshi', 'city'],
  B:      ['gekiatsu', 'oudou', 'sus', 'kirikaeshi'],
  chorus: ['oudou', 'komuro', 'canon', 'komuro2', 'marusa'],
  C:      ['marusa', 'city', 'gekiatsu'],
  outro:  ['ballad', 'ichirokuni', 'ede'],
};

/**
 * コード進行のたたきを作る
 * @param {{key:string, mode:string, bars:number, role:string, spice:boolean}} opts
 */
export function generateProgression({ key, mode, bars, role = 'chorus', spice = false }) {
  const hints = ROLE_HINT[role] || ROLE_HINT.chorus;
  const pool = PROGRESSIONS.filter((p) => hints.includes(p.id));
  const preset = rand(pool.length ? pool : PROGRESSIONS);
  const base = progressionInKey(preset.chords, preset.mode, key);

  const out = [];
  while (out.length < bars) out.push(...base);
  out.length = bars;

  if (spice && bars >= 4) {
    const spices = spiceChords(key, mode);
    const idx = bars - 2 + (Math.random() < 0.5 ? 0 : -2);
    if (idx > 0 && idx < bars) out[idx] = rand(spices).name;
  }
  return { chords: out, presetName: preset.name, note: preset.note };
}

/** ダイアトニック内でランダムな進行を作る（プリセットに寄せたくないとき） */
export function randomProgression({ key, mode, bars }) {
  const dia = diatonicChords(key, mode).map((d) => d.name);
  const out = [];
  for (let i = 0; i < bars; i++) {
    if (i === bars - 1) out.push(dia[4]); // V でひっぱる
    else if (i === 0) out.push(dia[mode === 'minor' ? 0 : 3]);
    else out.push(rand(dia));
  }
  return { chords: out, presetName: 'ランダム(ダイアトニック)', note: '' };
}
