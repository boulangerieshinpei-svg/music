// Web Audio によるコード再生。外部ライブラリなしで「鳴らして確かめる」用。

import { parseChord, intervalsFor, midiToFreq } from './theory.js';

export const PATTERNS = [
  { id: 'pad',  label: 'パッド（伸ばし）' },
  { id: 'arp',  label: 'アルペジオ' },
  { id: 'stab', label: '刻み（8ビート）' },
];

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.15; // 秒

export class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.timer = null;
    this.playing = false;
    this.pattern = 'pad';
    this.click = true;
    this.volume = 0.7;
    this.playChords = true;
    this.playMelody = true;
    this.onBar = null;      // (globalBarIndex, sectionIndex, barIndex) => void
    this.onStop = null;
    this._queue = [];       // 再生するバーの配列
    this._cursor = 0;
    this._nextTime = 0;
    this._loop = false;
  }

  _ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * @param {Array<{chord:string, melody?:Array<{start:number,dur:number,midi:number}>,
   *                sectionIndex:number, barIndex:number}>} bars
   *        melody の start / dur は小節を1とした相対値。
   * @param {{bpm:number, beatsPerBar:number, loop?:boolean}} opts
   */
  play(bars, { bpm, beatsPerBar, loop = false }) {
    this.stop();
    if (!bars.length) return;
    this._ensureCtx();
    this._queue = bars;
    this._cursor = 0;
    this._loop = loop;
    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
    this.playing = true;
    this._nextTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
    this._tick();
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.onStop) this.onStop();
  }

  _tick() {
    if (!this.playing) return;
    const secPerBeat = 60 / this.bpm;
    const barDur = secPerBeat * this.beatsPerBar;
    while (this._nextTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      if (this._cursor >= this._queue.length) {
        if (this._loop) this._cursor = 0;
        else { this.stop(); return; }
      }
      const bar = this._queue[this._cursor];
      this._scheduleBar(bar, this._nextTime, barDur, secPerBeat);
      const at = this._nextTime;
      const idx = this._cursor;
      if (this.onBar) {
        const delay = Math.max(0, (at - this.ctx.currentTime) * 1000);
        setTimeout(() => {
          if (this.playing && this.onBar) this.onBar(idx, bar.sectionIndex, bar.barIndex);
        }, delay);
      }
      this._nextTime += barDur;
      this._cursor += 1;
    }
  }

  _scheduleBar(bar, t0, barDur, secPerBeat) {
    if (this.click) {
      for (let b = 0; b < this.beatsPerBar; b++) {
        this._click(t0 + b * secPerBeat, b === 0);
      }
    }
    if (this.playMelody && bar.melody?.length) {
      for (const note of bar.melody) {
        this._lead(midiToFreq(note.midi), t0 + note.start * barDur, note.dur * barDur);
      }
    }
    if (!this.playChords) return;
    const c = parseChord(bar.chord);
    if (!c) return;
    const ivs = intervalsFor(c.quality);
    // ルートは低め、上物は C4 付近に配置
    const bassMidi = 36 + (c.bassPc !== null ? c.bassPc : c.rootPc);
    const voicing = ivs.map((iv) => 60 + ((c.rootPc + iv) % 24));

    this._note(midiToFreq(bassMidi), t0, Math.min(barDur, secPerBeat * 2), 0.28, 'triangle');

    // 小節ごとに弾き方を変えられる。指定が無ければプレイヤー既定（＝曲の指定）を使う
    const pattern = bar.pattern || this.pattern;
    if (pattern === 'pad') {
      voicing.forEach((m, i) => this._note(midiToFreq(m), t0 + i * 0.012, barDur * 0.98, 0.14, 'sawtooth'));
    } else if (pattern === 'arp') {
      const steps = this.beatsPerBar * 2;
      const step = barDur / steps;
      for (let i = 0; i < steps; i++) {
        const m = voicing[i % voicing.length] + (i >= voicing.length * 2 ? 12 : 0);
        this._note(midiToFreq(m), t0 + i * step, step * 1.6, 0.13, 'triangle');
      }
    } else {
      for (let b = 0; b < this.beatsPerBar * 2; b++) {
        if (b % 2 === 1 && b !== this.beatsPerBar * 2 - 1) continue; // 8分の裏を少し抜く
        voicing.forEach((m) =>
          this._note(midiToFreq(m), t0 + b * (secPerBeat / 2), secPerBeat * 0.35, 0.11, 'square')
        );
      }
    }
  }

  /** メロディ用の音色。コードより前に出るように少し強く、明るめに鳴らす */
  _lead(freq, at, dur, gain = 0.3) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 3800;
    osc.type = 'square';
    osc.frequency.value = freq;

    // 伸ばす音には軽くビブラートをかけて、歌っぽく聞こえるようにする
    if (dur > 0.35) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 5.5;
      lfoGain.gain.value = freq * 0.006;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(at + 0.15);
      lfo.stop(at + dur);
    }

    const a = 0.015;
    const r = Math.min(0.12, dur * 0.4);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + a);
    g.gain.setValueAtTime(gain, at + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    osc.connect(filt).connect(g).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** グリッドをタップしたときの試聴。再生中でなくても鳴らせる */
  previewNote(freq, dur = 0.28) {
    this._ensureCtx();
    this._lead(freq, this.ctx.currentTime + 0.01, dur, 0.32);
  }

  _note(freq, at, dur, gain, type = 'sine') {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 2600;
    osc.type = type;
    osc.frequency.value = freq;
    const a = 0.012;
    const r = Math.min(0.25, dur * 0.5);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + a);
    g.gain.setValueAtTime(gain, at + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    osc.connect(filt).connect(g).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  _click(at, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(accent ? 0.09 : 0.05, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    osc.connect(g).connect(this.master);
    osc.start(at);
    osc.stop(at + 0.05);
  }
}
