// Claude API 連携（ブラウザから Messages API を直接叩く）。
// APIキーはブラウザの localStorage に保存され、リクエストにそのまま乗る。
// 自分のマシンで自分のキーを使う前提のツール。共有PCや公開ホスティングでは使わないこと。

import { countMora as countMoraLite } from './mora.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5（いちばん賢い / 推奨）' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5（速い・安い）' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5（最速・最安）' },
];

// モデルごとに受け付けるパラメータが違う。
// effort は Haiku 4.5 では 400 になる。refusal フォールバックは Opus 5 系のみ明示サポート。
const CAPABILITIES = {
  'claude-opus-5':   { effort: true,  fallbacks: true },
  'claude-fable-5':  { effort: true,  fallbacks: true },
  'claude-sonnet-5': { effort: true,  fallbacks: false },
  'claude-haiku-4-5':{ effort: false, fallbacks: false },
};
const capsFor = (model) => CAPABILITIES[model] || { effort: false, fallbacks: false };

export const EFFORTS = [
  { id: 'low', label: '低（速い）' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高（じっくり）' },
];

export class AIError extends Error {
  constructor(message, kind = 'unknown') {
    super(message);
    this.kind = kind;
  }
}

/**
 * Messages API を叩いて、JSON スキーマに沿った結果を受け取る。
 * Opus 5 系は assistant prefill が使えないので、構造化出力で JSON を固定する。
 */
async function callClaude({
  apiKey, workspaceId = '', model, system, prompt, schema, effort = 'medium', maxTokens = 8000,
}) {
  if (!apiKey) throw new AIError('APIキーが設定されていません。設定パネルから入力してください。', 'no-key');

  const caps = capsFor(model);
  const outputConfig = { format: { type: 'json_schema', schema } };
  if (caps.effort) outputConfig.effort = effort;

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: outputConfig,
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // ブラウザから直接叩くための明示的なオプトイン
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // ID連携キーの場合、どのワークスペースでの実行かを明示しないと 400 になる
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;
  if (caps.fallbacks) {
    // 安全分類による refusal 時に、同じリクエストを別モデルで自動リトライさせる
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const send = (b, h) =>
    fetch(API_URL, { method: 'POST', headers: h, body: JSON.stringify(b) }).catch(() => {
      throw new AIError('ネットワークに繋がりませんでした（オフライン、またはブラウザにブロックされた可能性）。', 'network');
    });

  let res = await send(body, headers);

  // fallbacks / effort を受け付けないモデルだった場合は、外して1度だけ再試行する
  if (res.status === 400 && (body.fallbacks || outputConfig.effort)) {
    const plainBody = { ...body };
    delete plainBody.fallbacks;
    plainBody.output_config = { format: outputConfig.format };
    const plainHeaders = { ...headers };
    delete plainHeaders['anthropic-beta'];
    res = await send(plainBody, plainHeaders);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* JSON でないエラー本文は無視 */ }
    if (res.status === 400 && /workspace/i.test(detail)) {
      throw new AIError(
        'このキーはワークスペースIDが必要です。⚙ の「ワークスペースID」に wrkspc_ から始まるIDを入れてください。',
        'workspace'
      );
    }
    if (res.status === 401) throw new AIError('APIキーが正しくありません（401）。', 'auth');
    if (res.status === 429) throw new AIError('レート制限に達しました（429）。少し待ってから再試行してください。', 'rate');
    if (res.status >= 500) throw new AIError(`APIが一時的にエラーを返しました（${res.status}）。再試行してください。`, 'server');
    throw new AIError(`APIエラー（${res.status}）${detail ? ': ' + detail : ''}`, 'api');
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new AIError('リクエストが安全上の理由で拒否されました。歌詞の内容や指示を変えて試してください。', 'refusal');
  }

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new AIError('モデルからの応答が空でした。', 'empty');

  try {
    return JSON.parse(text);
  } catch {
    // 構造化出力が効かなかった場合の保険
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) return JSON.parse(m[0]);
    throw new AIError('応答をJSONとして読めませんでした。', 'parse');
  }
}

const LINES_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '対象の小節番号（0始まり）' },
          lyric: { type: 'string', description: '表示用の歌詞（漢字かな交じり）' },
          yomi: { type: 'string', description: '歌詞の読みをすべてひらがなで。モーラ数の検算に使う' },
        },
        required: ['index', 'lyric', 'yomi'],
        additionalProperties: false,
      },
    },
    comment: { type: 'string', description: '狙いを一言で（日本語、80字以内）' },
  },
  required: ['lines', 'comment'],
  additionalProperties: false,
};

const CHORDS_SCHEMA = {
  type: 'object',
  properties: {
    chords: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '対象の小節番号（0始まり）' },
          chord: { type: 'string', description: 'コードネーム。例: FM7, Am7, G7sus4, F/G' },
        },
        required: ['index', 'chord'],
        additionalProperties: false,
      },
    },
    comment: { type: 'string', description: '進行の狙いを一言で（日本語、120字以内）' },
  },
  required: ['chords', 'comment'],
  additionalProperties: false,
};

const MELODY_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bar: { type: 'integer', description: '小節番号（0始まり）' },
          step: { type: 'integer', description: '小節内の位置（0始まり、分割数未満）' },
          duration: { type: 'integer', description: '長さ（ステップ数、1以上）' },
          degree: { type: 'integer', description: 'キーのスケール上の段数。0=主音、7=1オクターブ上の主音' },
        },
        required: ['bar', 'step', 'duration', 'degree'],
        additionalProperties: false,
      },
    },
    comment: { type: 'string', description: 'メロディの狙いを一言で（日本語、120字以内）' },
  },
  required: ['notes', 'comment'],
  additionalProperties: false,
};

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' }, description: 'タイトル案' },
    themes: { type: 'array', items: { type: 'string' }, description: '歌詞テーマ・世界観の案' },
    comment: { type: 'string' },
  },
  required: ['titles', 'themes', 'comment'],
  additionalProperties: false,
};

const LYRICIST_SYSTEM = `あなたはボーカロイド楽曲を専門とする日本語の作詞家です。

守ること:
- 出力する歌詞は日本語。英単語の混用は1行に1語までに抑える。
- 指定されたモーラ数（音数）を必ず意識する。拗音（きゃ等）は1モーラ、促音「っ」・撥音「ん」・長音「ー」はそれぞれ1モーラとして数える。
- yomi フィールドには歌詞の読みを全てひらがなで書く。表示用の歌詞と読みが一致していること。
- ボカロらしい歌唱を意識する: 母音が続くと歌いやすく、子音が詰まると歌いにくい。無理な詰め込みを避ける。
- 与えられた曲の雰囲気・キー・コード進行の情緒に合わせる。
- 1小節1行。行をまたぐ言い回しは自然な息継ぎになる位置で切る。
- 説明や前置きは書かず、スキーマ通りのJSONだけを返す。`;

const COMPOSER_SYSTEM = `あなたはJ-POP／ボカロ楽曲のコード進行に詳しいアレンジャーです。

守ること:
- 指定されたキーとモードのダイアトニックを基本にしつつ、必要ならサブドミナントマイナー・セカンダリドミナント・分数コードを使ってよい。
- コードネームは一般的な表記で書く（例: C, Am, FM7, Dm7, G7, G7sus4, F/G, Bb, C#m7b5）。
- セクションの役割（Aメロは抑えめ、Bメロは緊張、サビは開放）を意識する。
- セクションの最後は次に自然につながる終止にする。
- 説明や前置きは書かず、スキーマ通りのJSONだけを返す。`;

function songContext(project) {
  const lines = [
    `曲名: ${project.title || '無題'}`,
    `キー: ${project.key}${project.mode === 'minor' ? ' マイナー' : ' メジャー'} / BPM: ${project.bpm} / ${project.beatsPerBar}拍子`,
  ];
  if (project.theme) lines.push(`テーマ・世界観: ${project.theme}`);
  return lines.join('\n');
}

function sectionContext(section) {
  const bars = section.bars
    .map((b, i) => `  ${i}小節目 | コード:${b.chord || '-'} | 現在の歌詞:${b.lyric || '(空)'}`)
    .join('\n');
  return `セクション名: ${section.name}（${section.bars.length}小節）\n1小節あたりの目標モーラ数: ${section.moraPerBar}\n${bars}`;
}

/**
 * 指定した小節の歌詞を書き換える／新しく書く
 * @param {object} opts
 * @param {number[]} opts.targetIndexes 対象の小節番号。空なら全小節
 */
export async function writeLyrics({
  apiKey, workspaceId, model, effort, project, section,
  targetIndexes = [], instruction = '', keepMora = true,
}) {
  const targets = targetIndexes.length ? targetIndexes : section.bars.map((_, i) => i);
  const prompt = [
    songContext(project),
    '',
    sectionContext(section),
    '',
    `書き換える小節: ${targets.join(', ')}（0始まり）`,
    keepMora
      ? `各行は ${section.moraPerBar} モーラ前後（±1）に収めてください。`
      : 'モーラ数は多少前後してかまいません。歌いやすさを優先してください。',
    instruction ? `\n作者からの指示: ${instruction}` : '',
    '',
    '書き換えない小節は出力に含めないでください。既存の歌詞がある場合は、その文脈と自然につながるようにしてください。',
  ].join('\n');

  const out = await callClaude({
    apiKey, workspaceId, model, effort,
    system: LYRICIST_SYSTEM,
    prompt,
    schema: LINES_SCHEMA,
  });
  return {
    lines: (out.lines || []).filter((l) => Number.isInteger(l.index) && l.index >= 0 && l.index < section.bars.length),
    comment: out.comment || '',
  };
}

/** セクションのコード進行を提案してもらう */
export async function suggestChords({
  apiKey, workspaceId, model, effort, project, section, instruction = '', targetIndexes = [],
}) {
  const targets = targetIndexes.length ? targetIndexes : section.bars.map((_, i) => i);
  const prompt = [
    songContext(project),
    '',
    sectionContext(section),
    '',
    `コードを提案する小節: ${targets.join(', ')}（0始まり）`,
    instruction ? `作者からの指示: ${instruction}` : '',
    '',
    '歌詞が既に入っている場合は、その情緒に合う響きを選んでください。',
  ].join('\n');

  const out = await callClaude({
    apiKey, workspaceId, model, effort,
    system: COMPOSER_SYSTEM,
    prompt,
    schema: CHORDS_SCHEMA,
  });
  return {
    chords: (out.chords || []).filter((c) => Number.isInteger(c.index) && c.index >= 0 && c.index < section.bars.length),
    comment: out.comment || '',
  };
}

/** 歌詞とコードに合うメロディを提案してもらう */
export async function suggestMelody({
  apiKey, workspaceId, model, effort, project, section, rows = 12, instruction = '',
}) {
  const barLines = section.bars.map((b, i) => {
    const mora = countMoraLite(b.yomi || b.lyric);
    return `  ${i}小節目 | コード:${b.chord || '-'} | 歌詞:${b.lyric || '(空)'}` +
      (mora ? ` | 音数の目安:${mora}` : ` | 音数の目安:${section.moraPerBar}`);
  }).join('\n');

  const prompt = [
    songContext(project),
    '',
    `セクション: ${section.name}（${section.bars.length}小節）`,
    `1小節の分割数: ${section.steps}（step は 0〜${section.steps - 1}）`,
    `音程は degree で指定します。0 = ${project.key} のスケールの主音、1 = 2度上、7 = 1オクターブ上の主音。`,
    `使える範囲は degree 0〜${rows - 1} です。この範囲を超える音は出さないでください。`,
    '',
    barLines,
    instruction ? `\n作者からの指示: ${instruction}` : '',
    '',
    '守ること:',
    '- 各小節の音数を「音数の目安」に合わせる（1音1モーラで歌えるように）',
    '- 小節アタマと表拍はその小節のコードの構成音に置く',
    '- 基本は順次進行（隣り合う degree）。跳躍は1小節に1回まで',
    '- 歌える音域に収める。極端に飛ばさない',
    '- セクションの役割を意識する（サビは高め・開放的、Aメロは低めで抑える）',
    '- 音が重ならないようにする（同じ小節で step の範囲を重複させない）',
  ].join('\n');

  const out = await callClaude({
    apiKey, workspaceId, model, effort,
    system: COMPOSER_SYSTEM,
    prompt,
    schema: MELODY_SCHEMA,
  });

  // 範囲外の値はここで落としておく（画面側で壊れないように）
  const notes = (out.notes || []).filter((n) =>
    Number.isInteger(n.bar) && n.bar >= 0 && n.bar < section.bars.length &&
    Number.isInteger(n.step) && n.step >= 0 && n.step < section.steps &&
    Number.isInteger(n.degree) && n.degree >= 0 && n.degree < rows
  ).map((n) => ({
    ...n,
    duration: Math.max(1, Math.min(section.steps - n.step, n.duration || 1)),
  }));

  return { notes, comment: out.comment || '' };
}

/** タイトル案・世界観案を出してもらう */
export async function suggestIdeas({ apiKey, workspaceId, model, effort, project, instruction = '' }) {
  const lyricDump = project.sections
    .map((s) => `[${s.name}]\n` + s.bars.map((b) => b.lyric).filter(Boolean).join('\n'))
    .join('\n\n');
  const prompt = [
    songContext(project),
    '',
    '現在の歌詞:',
    lyricDump || '(まだ歌詞がありません)',
    instruction ? `\n作者からの指示: ${instruction}` : '',
    '',
    'タイトル案を5つ、歌詞テーマ・世界観の案を3つ出してください。',
  ].join('\n');

  return callClaude({
    apiKey, workspaceId, model, effort,
    system: LYRICIST_SYSTEM,
    prompt,
    schema: IDEAS_SCHEMA,
    maxTokens: 4000,
  });
}

/** APIキーの疎通確認（最小のリクエストを1回投げる） */
export async function testKey({ apiKey, workspaceId, model }) {
  await callClaude({
    apiKey,
    workspaceId,
    model,
    effort: 'low',
    maxTokens: 1000,
    system: '接続テストです。',
    prompt: 'ok という文字列だけを ok フィールドに入れて返してください。',
    schema: {
      type: 'object',
      properties: { ok: { type: 'string' } },
      required: ['ok'],
      additionalProperties: false,
    },
  });
  return true;
}
