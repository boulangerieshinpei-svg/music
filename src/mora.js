// 日本語の「モーラ数（音数）」を数える。メロディに歌詞が乗るかの目安に使う。

const SMALL_KANA = new Set([...'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ']);
const IGNORE = /[\s　、。,.!?！？「」『』（）()\[\]…‥・゛゜~〜"'`\-—/\\|+*=_]/g;

/** 拗音（きゃ など）を1モーラとして数える */
export function countMora(text) {
  if (!text) return 0;
  const s = String(text).replace(IGNORE, '');
  let n = 0;
  for (const ch of s) {
    if (SMALL_KANA.has(ch)) continue; // 直前の音に吸収される
    n += 1;
  }
  return n;
}

/** 漢字が含まれているか（モーラ数が正確に測れないので警告用） */
export function hasKanji(text) {
  return /[㐀-䶿一-鿿]/.test(String(text || ''));
}

/** モーラ単位で分割する（表示用） */
export function splitMora(text) {
  const s = String(text || '').replace(IGNORE, '');
  const out = [];
  for (const ch of s) {
    if (SMALL_KANA.has(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** ひらがな/カタカナ正規化（韻の判定用） */
function toHira(text) {
  return String(text || '').replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

const VOWEL_OF = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'a', き: 'i', く: 'u', け: 'e', こ: 'o',
  さ: 'a', し: 'i', す: 'u', せ: 'e', そ: 'o',
  た: 'a', ち: 'i', つ: 'u', て: 'e', と: 'o',
  な: 'a', に: 'i', ぬ: 'u', ね: 'e', の: 'o',
  は: 'a', ひ: 'i', ふ: 'u', へ: 'e', ほ: 'o',
  ま: 'a', み: 'i', む: 'u', め: 'e', も: 'o',
  や: 'a', ゆ: 'u', よ: 'o',
  ら: 'a', り: 'i', る: 'u', れ: 'e', ろ: 'o',
  わ: 'a', を: 'o',
  が: 'a', ぎ: 'i', ぐ: 'u', げ: 'e', ご: 'o',
  ざ: 'a', じ: 'i', ず: 'u', ぜ: 'e', ぞ: 'o',
  だ: 'a', ぢ: 'i', づ: 'u', で: 'e', ど: 'o',
  ば: 'a', び: 'i', ぶ: 'u', べ: 'e', ぼ: 'o',
  ぱ: 'a', ぴ: 'i', ぷ: 'u', ぺ: 'e', ぽ: 'o',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'a', ゅ: 'u', ょ: 'o',
};

/** 末尾の母音列を取り出す（韻チェック用）。漢字は判定不能なので null */
export function tailVowels(text, n = 2) {
  const s = toHira(String(text || '').replace(IGNORE, ''));
  const vowels = [];
  for (const ch of s) {
    const v = VOWEL_OF[ch];
    if (v) vowels.push(v);
    else if (ch === 'ー' && vowels.length) vowels.push(vowels[vowels.length - 1]);
    else if (ch === 'ん' || ch === 'っ') vowels.push('n');
    else vowels.push('?');
  }
  const tail = vowels.slice(-n);
  if (!tail.length || tail.includes('?')) return null;
  return tail.join('');
}

/** 2つの行が韻を踏んでいるか */
export function rhymes(a, b, n = 2) {
  const va = tailVowels(a, n);
  const vb = tailVowels(b, n);
  return !!va && va === vb;
}
