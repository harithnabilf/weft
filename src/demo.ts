/**
 * Dev-only scripted demo for the submission video.
 * Drives IWER's emulated Quest 3 hands through a real Weft session (nothing is
 * faked: every thread, note and clear goes through the same hand-tracking code
 * a player uses) and records the XR canvas plus the app's own audio output.
 * Load with ?demo, then press Enter XR.
 */
import * as T from '@iwsdk/core';

type P = { a: number; r: number; y: number }; // loom-local cylindrical
type Seg =
  | { t0: number; t1: number; kind: 'move'; to: P; pinch?: boolean }
  | { t0: number; t1: number; kind: 'draw'; path: (u: number) => P };

const REST: P[] = [
  { a: -0.55, r: 0.3, y: -0.62 },
  { a: 0.55, r: 0.3, y: -0.62 },
];

const wave = (u: number): P => ({
  a: -0.95 + 1.9 * u,
  r: 0.4,
  y: -0.3 + 0.24 * u + 0.07 * Math.sin(u * Math.PI * 3),
});
const bass = (u: number): P => ({
  a: -1.0 + 2.0 * u,
  r: 0.54,
  y: -0.36 + 0.05 * Math.sin(u * Math.PI * 4),
});
const chord = (u: number): P => ({ a: 0.42, r: 0.3, y: -0.34 + 0.3 * u });
const spiral = (u: number): P => ({
  a: -0.7 + 1.1 * u,
  r: 0.34 + 0.08 * Math.sin(u * Math.PI * 2),
  y: -0.05 - 0.22 * u + 0.05 * Math.cos(u * Math.PI * 5),
});
const counter = (u: number): P => ({
  a: 1.0 - 1.3 * u,
  r: 0.5,
  y: -0.32 + 0.12 * Math.sin(u * Math.PI * 2),
});

// [left, right] timelines, seconds from the start of the recording
const TL: Seg[][] = [
  [
    { t0: 21.5, t1: 23.5, kind: 'move', to: bass(0) },
    { t0: 23.5, t1: 28.5, kind: 'draw', path: bass },
    { t0: 28.5, t1: 30, kind: 'move', to: REST[0] },
    { t0: 62.5, t1: 64, kind: 'move', to: counter(0) },
    { t0: 64, t1: 69, kind: 'draw', path: counter },
    { t0: 69, t1: 70.5, kind: 'move', to: REST[0] },
  ],
  [
    { t0: 8.5, t1: 10.5, kind: 'move', to: wave(0) },
    { t0: 10.5, t1: 15.5, kind: 'draw', path: wave },
    // pluck: sweep the bare fingertip down through the new thread
    { t0: 15.8, t1: 17.2, kind: 'move', to: { a: -0.2, r: 0.4, y: 0.03 } },
    { t0: 17.2, t1: 18.8, kind: 'move', to: { a: -0.2, r: 0.4, y: -0.42 } },
    { t0: 18.8, t1: 20.3, kind: 'move', to: REST[1] },
    { t0: 32.5, t1: 34, kind: 'move', to: chord(0) },
    { t0: 34, t1: 35.4, kind: 'draw', path: chord },
    { t0: 35.4, t1: 36.5, kind: 'move', to: REST[1] },
    // a second pluck, through the far bass thread
    { t0: 44, t1: 45.5, kind: 'move', to: { a: 0.6, r: 0.54, y: 0.0 } },
    { t0: 45.5, t1: 47, kind: 'move', to: { a: 0.6, r: 0.54, y: -0.45 } },
    { t0: 47, t1: 48.5, kind: 'move', to: REST[1] },
    { t0: 62, t1: 63.5, kind: 'move', to: spiral(0) },
    { t0: 63.5, t1: 68.5, kind: 'draw', path: spiral },
    { t0: 68.5, t1: 70, kind: 'move', to: REST[1] },
  ],
];
const END = 84;

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
const toVec = (p: P, v: T.Vector3) =>
  v.set(Math.sin(p.a) * p.r, p.y, -Math.cos(p.a) * p.r);

const w: any = (window as any).__weft;
const dev: any = (window as any).IWER_DEVICE;
const cur: P[] = [{ ...REST[0] }, { ...REST[1] }];
const want = new T.Vector3();
const have = new T.Vector3();

function sample(h: number, t: number): { p: P; pinch: boolean } {
  let p = cur[h];
  let pinch = false;
  for (const s of TL[h]) {
    if (t < s.t0) break;
    const u = Math.min(1, (t - s.t0) / (s.t1 - s.t0));
    if (s.kind === 'draw') {
      p = s.path(u);
      pinch = t < s.t1;
    } else if (TL[h].some((n) => n.kind === 'draw' && n.t0 > t && n.t0 - t < 0.3)) {
      pinch = true;
      const from = (s as any).from ?? ((s as any).from = { ...p });
      const k = ease(u);
      p = {
        a: from.a + (s.to.a - from.a) * k,
        r: from.r + (s.to.r - from.r) * k,
        y: from.y + (s.to.y - from.y) * k,
      };
    } else {
      const from = (s as any).from ?? ((s as any).from = { ...p });
      const k = ease(u);
      p = {
        a: from.a + (s.to.a - from.a) * k,
        r: from.r + (s.to.r - from.r) * k,
        y: from.y + (s.to.y - from.y) * k,
      };
    }
  }
  return { p, pinch };
}

function setHead(t: number) {
  // seated, glancing down at the loom, with a slow look across late in the piece
  const yaw = t > 72 ? 0.32 * Math.sin((t - 72) * 0.45) : 0.03 * Math.sin(t * 0.3);
  const pitch = -0.36 + 0.015 * Math.sin(t * 0.5);
  const cy = Math.cos(yaw / 2),
    sy = Math.sin(yaw / 2),
    cp = Math.cos(pitch / 2),
    sp = Math.sin(pitch / 2);
  // q = yaw(Y) * pitch(X)
  const q = [cy * sp, sy * cp, -sy * sp, cy * cp];
  dev.quaternion.set(q[0], q[1], q[2], q[3]);
}

let t0 = -1;
let rec: MediaRecorder | null = null;
const chunks: Blob[] = [];
const lastPinch = [false, false];

function startRecording() {
  const canvas = w.renderer.domElement as HTMLCanvasElement;
  const stream = canvas.captureStream(30);
  w.audio.recordStream.stream.getAudioTracks().forEach((tr: MediaStreamTrack) => stream.addTrack(tr));
  rec = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoBitsPerSecond: 12_000_000,
  });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    await fetch('/__save?name=weft-demo.webm', { method: 'POST', body: blob });
    (window as any).__demoDone = blob.size;
  };
  rec.start(1000);
}

dev.controlMode = 'programmatic';
dev.primaryInputMode = 'hand';
setHead(0);

w.demoTick = (time: number) => {
  if (!w.renderer.xr.isPresenting) return;
  if (t0 < 0) {
    t0 = time + 1.2;
    try {
      localStorage.removeItem('weft.weave.v1');
    } catch {
      /* ignore */
    }
  }
  const t = time - t0;
  setHead(Math.max(0, t));
  if (t >= 0 && !rec) startRecording();
  (window as any).__demoT = t;
  for (let h = 0; h < 2; h++) {
    const hand = h === 0 ? dev.hands.left : dev.hands.right;
    const { p, pinch } = sample(h, Math.max(0, t));
    cur[h] = p;
    toVec(p, want);
    w.loom.localToWorld(want);
    const hs = w.hands[h];
    // clap: palms turn to face each other and meet in front of the chest
    const clapK =
      t < 56.5 ? 0 : t < 58.8 ? ease((t - 56.5) / 2.3) : t < 59.6 ? 1 : t < 61.2 ? 1 - ease((t - 59.6) / 1.6) : 0;
    if (clapK > 0) {
      const sgn = h === 0 ? -1 : 1;
      want.set(sgn * (0.03 + 0.16 * (1 - clapK)), -0.25 - 0.2 * (1 - clapK), -0.3);
      w.loom.localToWorld(want);
      hand.position.x += (want.x - hand.position.x) * 0.25;
      hand.position.y += (want.y - hand.position.y) * 0.25;
      hand.position.z += (want.z - hand.position.z) * 0.25;
      const th = ((sgn * Math.PI) / 2) * clapK;
      hand.quaternion.set(0, 0, Math.sin(th / 2), Math.cos(th / 2));
      continue;
    }
    hand.quaternion.set(0, 0, 0, 1);
    if (hs.present) {
      have.copy(hs.pinching ? hs.smooth : hs.tip);
      w.loom.localToWorld(have);
      hand.position.x += (want.x - have.x) * 0.35;
      hand.position.y += (want.y - have.y) * 0.35;
      hand.position.z += (want.z - have.z) * 0.35;
    } else {
      hand.position.x = want.x;
      hand.position.y = want.y - 0.02;
      hand.position.z = want.z + 0.08;
    }
    if (pinch !== lastPinch[h]) {
      lastPinch[h] = pinch;
      hand.updatePinchValue(pinch ? 1 : 0);
    }
  }
  if (t > END && rec && rec.state === 'recording') rec.stop();
};
