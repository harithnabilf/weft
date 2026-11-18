/**
 * Weft audio engine — all sound is synthesised with Web Audio, no samples.
 * Every note is placed in 3D with an HRTF panner at the exact point where the
 * thread was drawn, so the music literally comes from the air around you.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Tuning {
  name: string;
  root: number; // MIDI note of degree 0
  steps: number[]; // semitone offsets of one octave of the scale
}

// One tuning per weekday. The same weave sounds different every day.
export const TUNINGS: Tuning[] = [
  { name: 'D minor pentatonic', root: 50, steps: [0, 3, 5, 7, 10] },
  { name: 'C major pentatonic', root: 48, steps: [0, 2, 4, 7, 9] },
  { name: 'E Hirajoshi', root: 52, steps: [0, 2, 3, 7, 8] },
  { name: 'G Yo', root: 55, steps: [0, 2, 5, 7, 9] },
  { name: 'A minor pentatonic', root: 45, steps: [0, 3, 5, 7, 10] },
  { name: 'F major pentatonic', root: 53, steps: [0, 2, 4, 7, 9] },
  { name: 'B♭ Egyptian', root: 46, steps: [0, 2, 5, 7, 10] },
];

export function todaysTuning(date = new Date()): Tuning {
  const day = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000,
  );
  return TUNINGS[((day % TUNINGS.length) + TUNINGS.length) % TUNINGS.length];
}

export function degreeToMidi(t: Tuning, degree: number, hand: number): number {
  const n = t.steps.length;
  const oct = Math.floor(degree / n);
  const base = t.root + (hand === 0 ? -12 : 12);
  return base + 12 * oct + t.steps[((degree % n) + n) % n];
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class WeftAudio {
  ctx: AudioContext;
  private master: GainNode;
  private reverbSend: GainNode;
  private droneGain: GainNode | null = null;
  readonly recordStream: MediaStreamAudioDestinationNode;
  private voices = 0;

  constructor() {
    const Ctx = (window.AudioContext ||
      (window as any).webkitAudioContext) as typeof AudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.recordStream = ctx.createMediaStreamDestination();
    comp.connect(this.recordStream);

    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.2, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.42;
    this.reverbSend.connect(reverb);
    reverb.connect(this.master);
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    if (!this.droneGain) this.startDrone();
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** A soft root+fifth bed so the very first note already sounds like music. */
  private startDrone(): void {
    const ctx = this.ctx;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    this.droneGain.connect(lp);
    lp.connect(this.master);
    lp.connect(this.reverbSend);
    this.setDroneRoot(todaysTuning().root - 24);
    this.droneGain.gain.setTargetAtTime(0.05, ctx.currentTime, 2.5);
  }

  private droneOscs: OscillatorNode[] = [];
  setDroneRoot(midi: number): void {
    if (!this.droneGain) return;
    this.droneOscs.forEach((o) => o.stop());
    this.droneOscs = [];
    const ctx = this.ctx;
    [0, 7, 12].forEach((iv, i) => {
      const o = ctx.createOscillator();
      o.type = i === 1 ? 'triangle' : 'sine';
      o.frequency.value = mtof(midi + iv);
      o.detune.value = (i - 1) * 4;
      const g = ctx.createGain();
      g.gain.value = i === 1 ? 0.35 : 0.6;
      o.connect(g);
      g.connect(this.droneGain!);
      o.start();
      this.droneOscs.push(o);
    });
  }

  updateListener(p: Vec3Like, fwd: Vec3Like, up: Vec3Like): void {
    const l = this.ctx.listener as any;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /**
   * hand 0 = left (warm, low, plucked string), hand 1 = right (glass bell).
   * depth 0..1: near threads are bright and short, far threads soft and long.
   */
  note(midi: number, pos: Vec3Like, hand: number, depth: number, vel = 0.7): void {
    if (this.ctx.state !== 'running' || this.voices > 28) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const f = mtof(midi);

    const panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 0.35,
      rolloffFactor: 0.7,
      positionX: pos.x,
      positionY: pos.y,
      positionZ: pos.z,
    });
    const env = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 900 + (1 - depth) * 5200;
    tone.Q.value = 0.4;
    env.connect(tone);
    tone.connect(panner);
    panner.connect(this.master);
    panner.connect(this.reverbSend);

    const dur = hand === 0 ? 1.8 + depth * 1.6 : 1.3 + depth * 2.2;
    const peak = vel * (hand === 0 ? 0.34 : 0.26);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.006 + depth * 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const partials =
      hand === 0
        ? [
            { r: 1, g: 1, type: 'triangle' as OscillatorType },
            { r: 2, g: 0.3, type: 'sine' as OscillatorType },
            { r: 0.5, g: 0.45, type: 'sine' as OscillatorType },
          ]
        : [
            { r: 1, g: 1, type: 'sine' as OscillatorType },
            { r: 2.01, g: 0.28, type: 'sine' as OscillatorType },
            { r: 3.99, g: 0.1, type: 'sine' as OscillatorType },
            { r: 5.43, g: 0.04, type: 'sine' as OscillatorType },
          ];
    this.voices++;
    let ended = 0;
    partials.forEach((p, i) => {
      const o = ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = f * p.r;
      const g = ctx.createGain();
      g.gain.value = p.g;
      if (i > 0) {
        // upper partials die faster: a struck, glassy attack
        g.gain.setValueAtTime(p.g, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (0.35 / i + 0.1));
      }
      o.connect(g);
      g.connect(env);
      o.start(t);
      o.stop(t + dur + 0.05);
      o.onended = () => {
        g.disconnect();
        if (++ended === partials.length) {
          this.voices--;
          env.disconnect();
          tone.disconnect();
          panner.disconnect();
        }
      };
    });
  }

  /** Soft air sweep used when the weave is cleared. */
  whoosh(): void {
    if (this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(4200, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    g.connect(this.reverbSend);
    src.start(t);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
  }
}
