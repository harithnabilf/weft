/**
 * Weft — weave music with your hands.
 *
 * A curved "loom" floats in front of you, within arm's reach while seated.
 * Pinch and draw: every stroke becomes a glowing thread. A light (the shuttle)
 * sweeps the loom left to right; wherever it crosses a thread, that thread
 * sings from the exact point in space where you drew it.
 *   - left/right across the loom = time
 *   - height = pitch (snapped to today's scale, so it always sounds good)
 *   - depth = timbre (near = bright and short, far = soft and long)
 *   - left hand = warm low strings, right hand = glass bells
 * Touch a thread to pluck it. Clap to clear the loom.
 */
import * as T from '@iwsdk/core';
import { createSystem } from '@iwsdk/core';
import { degreeToMidi, todaysTuning, WeftAudio } from './audio.js';

// ---- loom geometry (metres, relative to the head at calibration) ----------
const STEPS = 16;
const STEP_DUR = 0.36; // seconds per step → one pass ≈ 5.8 s
const LOOP = STEPS * STEP_DUR;
const ARC = (140 * Math.PI) / 180; // azimuth span of the loom
const R = 0.42; // guide radius
const R_MIN = 0.22;
const R_MAX = 0.68;
const Y_LO = -0.42; // bottom of the loom (≈ lap) relative to eye height
const Y_HI = 0.06; // top of the loom (≈ eye level)
const DEGREES = 11;
const MAX_THREADS = 28;

const PINCH_ON = 0.022;
const PINCH_OFF = 0.04;
const PLUCK_DIST = 0.024;
const CLAP_DIST = 0.075;
const STORE_KEY = 'weft.weave.v1';

const COLORS = [new T.Color('#9fc3ff'), new T.Color('#ffdcae')]; // left, right
const WHITE = new T.Color('#ffffff');

interface Slot {
  degrees: number[];
  pos: T.Vector3; // loom-local
  depth: number;
}

interface Thread {
  hand: number;
  pts: T.Vector3[]; // loom-local
  core: T.Mesh;
  halo: T.Mesh;
  slots: Map<number, Slot>;
  energy: number;
  dying: number; // 0 = alive, >0 = seconds into dissolve
  ghost: boolean;
  lastPluck: number;
  dirtyAt: number;
}

interface HandState {
  present: boolean;
  pinching: boolean;
  tip: T.Vector3; // loom-local index tip
  pinchPt: T.Vector3; // loom-local
  palm: T.Vector3; // world
  drawing: Thread | null;
  lastSlotKey: string;
  smooth: T.Vector3; // filtered pinch point (loom-local)
  pinchSince: number;
  noPluckUntil: number;
  cursor: T.Mesh;
}

// ---- small helpers ----------------------------------------------------------
function azimuth(p: T.Vector3): number {
  return Math.atan2(p.x, -p.z);
}
function slotOf(p: T.Vector3): number {
  const u = (azimuth(p) + ARC / 2) / ARC;
  if (u < 0 || u >= 1) return -1;
  return Math.floor(u * STEPS);
}
function degreeOf(p: T.Vector3): number {
  const v = T.MathUtils.clamp((p.y - Y_LO) / (Y_HI - Y_LO), 0, 1);
  return Math.round(v * (DEGREES - 1));
}
function depthOf(p: T.Vector3): number {
  const r = Math.hypot(p.x, p.z);
  return T.MathUtils.clamp((r - R_MIN) / (R_MAX - R_MIN), 0, 1);
}

function glowTexture(): T.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

function shuttleTexture(): T.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.5, 'rgba(255,255,255,1)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(0.25, 'rgba(0,0,0,0.7)');
  v.addColorStop(0.85, 'rgba(0,0,0,1)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

const FONT =
  '-apple-system, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

/** Crisp text on a plane. Restrained: white, two weights, generous tracking. */
class Label {
  mesh: T.Mesh;
  private canvas = document.createElement('canvas');
  private tex: T.CanvasTexture;
  private mat: T.MeshBasicMaterial;
  opacity = 0;
  target = 0;
  private text = '';
  constructor(
    private widthM: number,
    private px: number,
    private weight: number,
    private sub = false,
  ) {
    this.canvas.width = 1024;
    this.canvas.height = 160;
    this.tex = new T.CanvasTexture(this.canvas);
    this.tex.colorSpace = T.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new T.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const h = (widthM * this.canvas.height) / this.canvas.width;
    this.mesh = new T.Mesh(new T.PlaneGeometry(widthM, h), this.mat);
    this.mesh.renderOrder = 10;
  }
  set(text: string, sub = ''): void {
    const key = text + '|' + sub;
    if (key === this.text) return;
    this.text = key;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.94)';
    g.font = `${this.weight} ${this.px}px ${FONT}`;
    (g as any).letterSpacing = this.sub ? '2px' : '-0.5px';
    const w = g.measureText(text).width;
    if (w > 980) g.font = `${this.weight} ${Math.floor((this.px * 980) / w)}px ${FONT}`;
    g.fillText(text, 512, sub ? 62 : 80);
    if (sub) {
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = `400 ${Math.round(this.px * 0.42)}px ${FONT}`;
      (g as any).letterSpacing = '1px';
      g.fillText(sub, 512, 126);
    }
    this.tex.needsUpdate = true;
  }
  tick(dt: number): void {
    this.opacity += (this.target - this.opacity) * Math.min(1, dt * 4);
    this.mat.opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.01;
  }
}

// ---- the system -------------------------------------------------------------
export class WeftSystem extends createSystem({}) {
  private audio!: WeftAudio;
  private loom!: T.Group;
  private threads: Thread[] = [];
  private hands: HandState[] = [];
  private shuttle!: T.Mesh;
  private bead!: T.Mesh;
  private flashes: { s: T.Sprite; t: number; c: T.Color }[] = [];
  private flashIdx = 0;
  private glowTex!: T.CanvasTexture;
  private title!: Label;
  private hint!: Label;
  private tuningLabel!: Label;
  private ghost: Thread | null = null;
  private ghostDot!: T.Sprite;
  private ghostPath: T.Vector3[] = [];

  private calibrated = false;
  private wasPresenting = false;
  private presentStart = 0;
  private undo: { h: number; pts: T.Vector3[] }[] = [];
  private undoUntil = 0;
  private lastWake = 0;
  private controllersOnly = false;
  private palmT: number[] = [];
  private palmD: number[] = [];
  private loopStart = 0;
  private lastStep = -1;
  private clock = 0;
  private lastClap = -10;
  private stage: 'intro' | 'pluck' | 'clap' | 'free' = 'intro';
  private stageT = 0;
  private plucked = false;
  private tuning = todaysTuning();

  // scratch
  private v1 = new T.Vector3();
  private v2 = new T.Vector3();
  private v3 = new T.Vector3();
  private q1 = new T.Quaternion();
  private q2 = new T.Quaternion();
  private fwd = new T.Vector3();
  private up = new T.Vector3();

  init(): void {
    this.audio = new WeftAudio();
    const wake = () => this.audio.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    });

    this.glowTex = glowTexture();
    this.loom = new T.Group();
    this.loom.name = 'Loom';
    this.world.createTransformEntity(this.loom);

    this.buildGuides();
    this.buildShuttle();
    this.buildFlashes();
    this.buildLabels();
    this.buildHands();
    this.buildGhost();
    this.restore();

    (window as any).__weft = this; // used by the scripted demo recorder
  }

  // ---------------------------------------------------------------- building
  private buildGuides(): void {
    const mat = new T.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    for (const y of [Y_LO, Y_HI]) {
      const pts: T.Vector3[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = -ARC / 2 + (ARC * i) / 48;
        pts.push(new T.Vector3(Math.sin(a) * R, y, -Math.cos(a) * R));
      }
      const tube = new T.Mesh(
        new T.TubeGeometry(new T.CatmullRomCurve3(pts), 96, 0.0009, 5, false),
        mat,
      );
      this.loom.add(tube);
    }
    // step ticks on the lower rail, every 4th a little taller (one beat)
    const tickMat = mat.clone();
    tickMat.opacity = 0.22;
    for (let i = 0; i <= STEPS; i++) {
      const a = -ARC / 2 + (ARC * i) / STEPS;
      const h = i % 4 === 0 ? 0.022 : 0.01;
      const tick = new T.Mesh(new T.CylinderGeometry(0.0009, 0.0009, h, 5), tickMat);
      tick.position.set(Math.sin(a) * R, Y_LO + h / 2, -Math.cos(a) * R);
      this.loom.add(tick);
    }
  }

  private buildShuttle(): void {
    const h = Y_HI - Y_LO + 0.06;
    // a soft vertical band of light on the guide radius, facing the player
    const geo = new T.PlaneGeometry(0.07, h);
    geo.translate(0, Y_LO + h / 2 - 0.03, -R);
    this.shuttle = new T.Mesh(
      geo,
      new T.MeshBasicMaterial({
        map: shuttleTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.26,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide,
      }),
    );
    this.loom.add(this.shuttle);
    this.bead = new T.Mesh(
      new T.SphereGeometry(0.0055, 14, 10),
      new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.loom.add(this.bead);
  }

  private buildFlashes(): void {
    for (let i = 0; i < 40; i++) {
      const s = new T.Sprite(
        new T.SpriteMaterial({
          map: this.glowTex,
          transparent: true,
          blending: T.AdditiveBlending,
          depthWrite: false,
          opacity: 0,
        }),
      );
      s.visible = false;
      this.loom.add(s);
      this.flashes.push({ s, t: 1, c: new T.Color() });
    }
  }

  private buildLabels(): void {
    this.title = new Label(0.36, 96, 600);
    this.title.set('Weft', 'WEAVE MUSIC WITH YOUR HANDS');
    this.title.mesh.position.set(0, Y_HI + 0.1, -R - 0.08);
    this.title.target = 1;
    this.hint = new Label(0.3, 64, 500);
    this.hint.mesh.position.set(0, Y_HI + 0.045, -R - 0.06);
    this.tuningLabel = new Label(0.26, 40, 500, true);
    this.tuningLabel.set(`TODAY’S TUNING · ${this.tuning.name.toUpperCase()}`);
    this.tuningLabel.mesh.position.set(0, Y_HI + 0.1, -R - 0.08);
    this.loom.add(this.title.mesh, this.hint.mesh, this.tuningLabel.mesh);
  }

  private buildHands(): void {
    for (let h = 0; h < 2; h++) {
      const cursor = new T.Mesh(
        new T.SphereGeometry(0.0045, 14, 10),
        new T.MeshBasicMaterial({
          color: COLORS[h],
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        }),
      );
      cursor.visible = false;
      this.loom.add(cursor);
      this.hands.push({
        present: false,
        pinching: false,
        tip: new T.Vector3(),
        pinchPt: new T.Vector3(),
        palm: new T.Vector3(),
        drawing: null,
        lastSlotKey: '',
        smooth: new T.Vector3(),
        pinchSince: 0,
        noPluckUntil: 0,
        cursor,
      });
    }
  }

  /** A demonstration stroke drawn by a ghost fingertip: teaches without words. */
  private buildGhost(): void {
    const pts: T.Vector3[] = [];
    for (let i = 0; i <= 60; i++) {
      const u = i / 60;
      const a = -0.75 + u * 1.5;
      const r = R - 0.02;
      const y = Y_LO + 0.12 + 0.22 * u + 0.06 * Math.sin(u * Math.PI * 2.2);
      pts.push(new T.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r));
    }
    this.ghostPath = pts;
    this.ghostDot = new T.Sprite(
      new T.SpriteMaterial({
        map: this.glowTex,
        color: COLORS[1],
        transparent: true,
        blending: T.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.ghostDot.scale.setScalar(0.035);
    this.loom.add(this.ghostDot);
  }

  // ------------------------------------------------------------ threads
  private makeThread(hand: number, ghost = false): Thread {
    const color = COLORS[hand].clone();
    const core = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: ghost ? 0.3 : 0.95,
        blending: T.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const halo = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: ghost ? 0.05 : 0.12,
        blending: T.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.loom.add(core, halo);
    return {
      hand,
      pts: [],
      core,
      halo,
      slots: new Map(),
      energy: 0,
      dying: 0,
      ghost,
      lastPluck: 0,
      dirtyAt: 0,
    };
  }

  private rebuildThread(th: Thread): void {
    if (th.pts.length < 2) return;
    const curve = new T.CatmullRomCurve3(th.pts, false, 'centripetal');
    const seg = Math.min(220, th.pts.length * 3);
    th.core.geometry.dispose();
    th.halo.geometry.dispose();
    th.core.geometry = new T.TubeGeometry(curve, seg, 0.0026, 6, false);
    th.halo.geometry = new T.TubeGeometry(curve, Math.ceil(seg / 2), 0.0085, 6, false);
  }

  private computeSlots(th: Thread): void {
    th.slots.clear();
    const acc = new Map<number, { deg: Set<number>; sum: T.Vector3; n: number }>();
    for (const p of th.pts) {
      const s = slotOf(p);
      if (s < 0) continue;
      let a = acc.get(s);
      if (!a) {
        a = { deg: new Set(), sum: new T.Vector3(), n: 0 };
        acc.set(s, a);
      }
      a.deg.add(degreeOf(p));
      a.sum.add(p);
      a.n++;
    }
    acc.forEach((a, s) => {
      const pos = a.sum.multiplyScalar(1 / a.n);
      // a vertical stroke inside one slot becomes a chord (max 3 notes)
      const sorted = [...a.deg].sort((x, y) => x - y);
      const degrees =
        sorted.length <= 3
          ? sorted
          : [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]];
      th.slots.set(s, { degrees, pos, depth: depthOf(pos) });
    });
  }

  private removeThread(th: Thread): void {
    this.loom.remove(th.core, th.halo);
    th.core.geometry.dispose();
    th.halo.geometry.dispose();
    (th.core.material as T.Material).dispose();
    (th.halo.material as T.Material).dispose();
  }

  private save(): void {
    try {
      const data = this.threads
        .filter((t) => !t.ghost && t.dying === 0)
        .map((t) => ({
          h: t.hand,
          p: t.pts.flatMap((p) => [
            +p.x.toFixed(3),
            +p.y.toFixed(3),
            +p.z.toFixed(3),
          ]),
        }));
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable: the weave just won't persist */
    }
  }

  private restore(): void {
    if (/[?&]demo/.test(location.search)) return; // recorder always starts fresh
    let data: { h: number; p: number[] }[] = [];
    try {
      data = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch {
      data = [];
    }
    for (const d of data) {
      const th = this.makeThread(d.h);
      for (let i = 0; i + 2 < d.p.length; i += 3) {
        th.pts.push(new T.Vector3(d.p[i], d.p[i + 1], d.p[i + 2]));
      }
      this.rebuildThread(th);
      this.computeSlots(th);
      this.threads.push(th);
    }
    if (this.threads.length) {
      this.stage = 'free';
      this.title.set('Welcome back', 'YOUR WEAVE, RETUNED FOR TODAY');
    }
  }

  // ---------------------------------------------------------- sound + light
  private playSlot(th: Thread, slot: Slot, vel: number, priority = false): void {
    this.v1.copy(slot.pos);
    this.loom.localToWorld(this.v1);
    for (const d of slot.degrees) {
      this.audio.note(
        degreeToMidi(this.tuning, d, th.hand),
        this.v1,
        th.hand,
        slot.depth,
        vel * (slot.degrees.length > 1 ? 0.75 : 1),
        priority,
      );
    }
    th.energy = 1;
    this.flash(slot.pos, COLORS[th.hand], 1 + slot.degrees.length * 0.3);
  }

  private flash(p: T.Vector3, c: T.Color, size = 1): void {
    const f = this.flashes[this.flashIdx++ % this.flashes.length];
    f.s.position.copy(p);
    f.t = 0;
    f.c.copy(c);
    f.s.userData.size = size;
    f.s.visible = true;
  }

  // ------------------------------------------------------------- per frame
  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.05);
    this.clock = time;
    (this as any).demoTick?.(time, dt); // scripted demo recorder hook (dev only)
    const presenting = this.renderer.xr.isPresenting;
    if (presenting !== this.wasPresenting) {
      this.wasPresenting = presenting;
      this.calibrated = false;
      this.presentStart = time;
      if (presenting) {
        this.audio.resume();
        this.loopStart = time;
        const session = this.renderer.xr.getSession();
        session?.addEventListener('selectstart', () => this.audio.resume());
        const ref = this.renderer.xr.getReferenceSpace() as any;
        ref?.addEventListener?.('reset', () => {
          this.calibrated = false;
        });
      }
    }
    // the XR head pose settles over the first frames of a session
    if (!this.calibrated || time - this.presentStart < 0.6) this.calibrate();
    else if (presenting && !this.hands[0].drawing && !this.hands[1].drawing && this.headPose()) {
      // safety net: the loom is centred on the seated player; if it is far off, re-centre
      const dx = this.v1.x - this.loom.position.x;
      const dz = this.v1.z - this.loom.position.z;
      if (dx * dx + dz * dz > 0.25) this.calibrate();
    }

    // listener follows the head
    this.camera.getWorldPosition(this.v1);
    this.camera.getWorldQuaternion(this.q1);
    this.fwd.set(0, 0, -1).applyQuaternion(this.q1);
    this.up.set(0, 1, 0).applyQuaternion(this.q1);
    this.audio.updateListener(this.v1, this.fwd, this.up);

    if (presenting && this.audio.ctx.state !== 'running' && time - this.lastWake > 1) {
      this.lastWake = time;
      this.audio.resume();
    }
    if (presenting) this.readHands(time);
    this.sequencer(time);
    this.animate(dt, time);
  }

  /** Head pose in world space: the real XR viewer pose when in a session. */
  private headPose(): boolean {
    if (this.renderer.xr.isPresenting) {
      const frame = this.xrFrame as XRFrame | undefined;
      const ref = this.renderer.xr.getReferenceSpace();
      const vp = frame && ref ? frame.getViewerPose(ref) : null;
      if (!vp) return false;
      const t = vp.transform;
      this.v1.set(t.position.x, t.position.y, t.position.z).applyMatrix4(this.player.matrixWorld);
      this.player.getWorldQuaternion(this.q1);
      this.q2.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      this.q1.multiply(this.q2);
      return true;
    }
    this.camera.getWorldPosition(this.v1);
    this.camera.getWorldQuaternion(this.q1);
    return true;
  }

  private calibrate(): void {
    if (!this.headPose()) return;
    if (!Number.isFinite(this.v1.y)) return;
    this.fwd.set(0, 0, -1).applyQuaternion(this.q1);
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    this.loom.position.copy(this.v1);
    if (!this.renderer.xr.isPresenting) {
      // flat preview: sit the viewer a little behind the loom so all of it shows
      this.loom.position.x += -Math.sin(yaw) * 0.32;
      this.loom.position.z += -Math.cos(yaw) * 0.32;
    }
    this.loom.rotation.set(0, yaw, 0);
    this.loom.updateMatrixWorld(true);
    this.calibrated = true;
  }

  private readHands(time: number): void {
    const frame = this.xrFrame as XRFrame | undefined;
    const ref = this.renderer.xr.getReferenceSpace();
    this.hands[0].present = this.hands[1].present = false;
    if (!frame || !ref) return;
    let pads = 0;
    let handsSeen = 0;
    for (const src of frame.session.inputSources) {
      if ((src as any).hand) handsSeen++;
      else if (src.gamepad) pads++;
    }
    this.controllersOnly = pads > 0 && handsSeen === 0;
    const origin = this.player.matrixWorld;
    for (const src of frame.session.inputSources) {
      const hand = (src as any).hand as XRHand | undefined;
      if (!hand) continue;
      const hi = src.handedness === 'left' ? 0 : 1;
      const tipJ = hand.get('index-finger-tip');
      const thJ = hand.get('thumb-tip');
      const palmJ = hand.get('middle-finger-metacarpal');
      if (!tipJ || !thJ || !palmJ || !frame.getJointPose) continue;
      const tip = frame.getJointPose(tipJ, ref);
      const thb = frame.getJointPose(thJ, ref);
      const palm = frame.getJointPose(palmJ, ref);
      if (!tip || !thb || !palm) continue;
      const hs = this.hands[hi];
      hs.present = true;
      const tp = tip.transform.position;
      const bp = thb.transform.position;
      const pp = palm.transform.position;
      this.v1.set(tp.x, tp.y, tp.z).applyMatrix4(origin);
      this.v2.set(bp.x, bp.y, bp.z).applyMatrix4(origin);
      hs.palm.set(pp.x, pp.y, pp.z).applyMatrix4(origin);
      const gap = this.v1.distanceTo(this.v2);
      this.v3.copy(this.v1).add(this.v2).multiplyScalar(0.5);
      hs.tip.copy(this.v1);
      this.loom.worldToLocal(hs.tip);
      hs.pinchPt.copy(this.v3);
      this.loom.worldToLocal(hs.pinchPt);

      const was = hs.pinching;
      if (!was && gap < PINCH_ON) hs.pinching = true;
      else if (was && gap > PINCH_OFF) hs.pinching = false;
      if (hs.pinching && !was) {
        hs.pinchSince = time;
        hs.smooth.copy(hs.pinchPt);
      }
      // filter tracking jitter; start the stroke once the pinch has settled
      hs.smooth.lerp(hs.pinchPt, 0.45);
      if (
        hs.pinching &&
        !hs.drawing &&
        time - hs.pinchSince > 0.12 &&
        this.inLoom(hs.smooth)
      )
        this.beginStroke(hi);
      if (hs.pinching && hs.drawing) this.extendStroke(hi, time);
      if (!hs.pinching && was) this.endStroke(hi);
      if (!hs.pinching) this.tryPluck(hi, time);
    }
    for (let h = 0; h < 2; h++) {
      const hs = this.hands[h];
      if (!hs.present && hs.drawing) {
        hs.pinching = false;
        this.endStroke(h);
      }
    }
    // clap: both palms meet → clear the loom
    const [l, r] = this.hands;
    let closing = 0;
    if (l.present && r.present) {
      const d = l.palm.distanceTo(r.palm);
      this.palmT.push(time);
      this.palmD.push(d);
      while (this.palmT.length && time - this.palmT[0] > 0.3) {
        this.palmT.shift();
        this.palmD.shift();
      }
      closing = Math.max(...this.palmD) - d;
    } else {
      this.palmT.length = 0;
      this.palmD.length = 0;
    }
    this.v3.copy(l.palm).add(r.palm).multiplyScalar(0.5);
    this.loom.worldToLocal(this.v3);
    if (
      l.present &&
      r.present &&
      !l.drawing &&
      !r.drawing &&
      l.palm.distanceTo(r.palm) < CLAP_DIST &&
      closing > 0.08 && // a real clap closes fast; hands resting together don't

      this.v3.y > Y_LO - 0.12 && // in front of the body, not resting on the lap
      this.v3.z < -0.12 &&
      time - this.lastClap > 1.5
    ) {
      this.lastClap = time;
      this.clear();
    }
  }

  private inLoom(p: T.Vector3): boolean {
    const r = Math.hypot(p.x, p.z);
    return p.y > Y_LO - 0.1 && p.y < Y_HI + 0.14 && r > 0.14 && r < 0.82 && p.z < -0.05;
  }

  beginStroke(h: number): void {
    const hs = this.hands[h];
    const th = this.makeThread(h);
    th.pts.push(hs.smooth.clone());
    hs.drawing = th;
    hs.lastSlotKey = '';
    this.threads.push(th);
    while (this.threads.filter((t) => !t.dying && !t.ghost).length > MAX_THREADS) {
      const old = this.threads.find((t) => !t.dying && !t.ghost);
      if (!old) break;
      old.dying = 0.0001;
    }
  }

  extendStroke(h: number, time: number): void {
    const hs = this.hands[h];
    const th = hs.drawing!;
    const last = th.pts[th.pts.length - 1];
    if (last.distanceTo(hs.smooth) < 0.008) return;
    th.pts.push(hs.smooth.clone());
    if (time - th.dirtyAt > 0.04) {
      th.dirtyAt = time;
      this.rebuildThread(th);
    }
    // you hear the melody while you draw it
    const s = slotOf(hs.smooth);
    const d = degreeOf(hs.smooth);
    const key = s + ':' + d;
    if (s >= 0 && key !== hs.lastSlotKey) {
      hs.lastSlotKey = key;
      this.v1.copy(hs.smooth);
      this.loom.localToWorld(this.v1);
      this.audio.note(
        degreeToMidi(this.tuning, d, h),
        this.v1,
        h,
        depthOf(hs.smooth),
        0.45,
        true,
      );
      this.flash(hs.smooth, COLORS[h], 0.8);
    }
  }

  endStroke(h: number): void {
    const hs = this.hands[h];
    const th = hs.drawing;
    hs.drawing = null;
    hs.noPluckUntil = this.clock + 0.8;
    if (!th) return;
    th.lastPluck = this.clock + 0.6;
    if (th.pts.length < 3) {
      th.dying = 0.0001;
      return;
    }
    this.rebuildThread(th);
    this.computeSlots(th);
    this.save();
    if (this.stage === 'intro') {
      this.stage = 'pluck';
      this.stageT = this.clock;
      if (this.ghost) this.ghost.dying = 0.0001;
    }
  }

  private tryPluck(h: number, time: number): void {
    const hs = this.hands[h];
    if (time < hs.noPluckUntil) return;
    for (const th of this.threads) {
      if (th.dying || th.ghost || time - th.lastPluck < 0.22) continue;
      for (let i = 0; i < th.pts.length; i += 1) {
        if (th.pts[i].distanceTo(hs.tip) < PLUCK_DIST) {
          th.lastPluck = time;
          const p = th.pts[i];
          const slot: Slot = { degrees: [degreeOf(p)], pos: p.clone(), depth: depthOf(p) };
          this.playSlot(th, slot, 0.85, true);
          if (this.stage === 'pluck') {
            this.plucked = true;
            this.stage = 'clap';
            this.stageT = time;
          }
          break;
        }
      }
    }
  }

  /** Clap clears the loom; a second clap within a few seconds brings it back. */
  clear(): void {
    if (this.undo.length && this.clock < this.undoUntil) {
      this.restoreSnapshot();
      return;
    }
    let any = false;
    const snap: { h: number; pts: T.Vector3[] }[] = [];
    for (const th of this.threads) {
      if (!th.dying && !th.ghost) {
        snap.push({ h: th.hand, pts: th.pts.map((p) => p.clone()) });
        th.dying = 0.0001;
        any = true;
      }
    }
    if (any) {
      this.undo = snap;
      this.undoUntil = this.clock + 5;
    }
    if (any) {
      this.audio.whoosh();
      for (let i = 0; i < 10; i++) {
        const a = -ARC / 2 + (ARC * i) / 9;
        this.v1.set(Math.sin(a) * R, (Y_LO + Y_HI) / 2, -Math.cos(a) * R);
        this.flash(this.v1, WHITE, 2.2);
      }
    }
    if (this.stage === 'clap') {
      this.stage = 'free';
      this.stageT = this.clock;
    }
    this.save();
  }

  private restoreSnapshot(): void {
    for (const d of this.undo) {
      const th = this.makeThread(d.h);
      th.pts = d.pts;
      this.rebuildThread(th);
      this.computeSlots(th);
      th.energy = 1;
      this.threads.push(th);
      const mid = th.pts[Math.floor(th.pts.length / 2)];
      if (mid) this.flash(mid, COLORS[d.h], 1.6);
    }
    this.undo = [];
    this.undoUntil = 0;
    this.save();
  }

  private sequencer(time: number): void {
    const t = time - this.loopStart;
    const step = Math.floor((t % LOOP) / STEP_DUR);
    if (step !== this.lastStep) {
      this.lastStep = step;
      // newest threads first, so a dense weave never silences what you just drew
      for (let i = this.threads.length - 1; i >= 0; i--) {
        const th = this.threads[i];
        if (th.dying) continue;
        if (this.hands.some((hs) => hs.drawing === th)) continue;
        const slot = th.slots.get(step);
        if (slot) this.playSlot(th, slot, th.ghost ? 0.5 : 0.8);
      }
    }
  }

  private animate(dt: number, time: number): void {
    // shuttle sweeps left → right
    const u = ((time - this.loopStart) % LOOP) / LOOP;
    const a = -ARC / 2 + u * ARC;
    this.shuttle.rotation.y = -a;
    this.bead.position.set(Math.sin(a) * R, Y_LO, -Math.cos(a) * R);

    // threads breathe when they sing, dissolve when cleared
    for (let i = this.threads.length - 1; i >= 0; i--) {
      const th = this.threads[i];
      th.energy = Math.max(0, th.energy - dt * 2.6);
      const cm = th.core.material as T.MeshBasicMaterial;
      const hm = th.halo.material as T.MeshBasicMaterial;
      cm.color.copy(COLORS[th.hand]).lerp(WHITE, th.energy * 0.6);
      let k = 1;
      if (th.dying) {
        th.dying += dt;
        k = Math.max(0, 1 - th.dying / 0.7);
        th.core.scale.setScalar(1 + (1 - k) * 0.04);
        if (k <= 0) {
          this.removeThread(th);
          this.threads.splice(i, 1);
          if (th === this.ghost) this.ghost = null;
          continue;
        }
      }
      const base = th.ghost ? 0.3 : 0.9;
      cm.opacity = k * (base + th.energy * 0.1);
      hm.opacity = k * ((th.ghost ? 0.04 : 0.1) + th.energy * 0.35);
    }

    // flashes
    for (const f of this.flashes) {
      if (!f.s.visible) continue;
      f.t += dt / 0.55;
      if (f.t >= 1) {
        f.s.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - f.t, 3);
      f.s.scale.setScalar((0.012 + e * 0.05) * (f.s.userData.size || 1));
      const m = f.s.material as T.SpriteMaterial;
      m.color.copy(f.c);
      m.opacity = (1 - f.t) * 0.9;
    }

    // fingertip cursors
    for (let h = 0; h < 2; h++) {
      const hs = this.hands[h];
      hs.cursor.visible = hs.present;
      if (!hs.present) continue;
      hs.cursor.position.copy(hs.pinching ? hs.smooth : hs.tip);
      hs.cursor.scale.setScalar(hs.pinching ? 1.7 : 1);
    }

    this.tutorial(dt, time);
  }

  private tutorial(dt: number, time: number): void {
    const since = time - this.stageT;
    const inSession = time - this.presentStart; // restarts when XR begins
    // title fades after a few seconds
    this.title.target = inSession < 6 ? 1 : 0;
    this.title.tick(dt);

    // ghost demonstration while nothing has been drawn
    const showGhost = this.stage === 'intro';
    this.ghostDot.visible = showGhost;
    if (showGhost) {
      const cycle = 4.2;
      const p = (time % cycle) / 2.6;
      if (!this.ghost && time > 1.2) {
        this.ghost = this.makeThread(1, true);
        this.threads.push(this.ghost);
      }
      if (this.ghost && p <= 1) {
        const n = Math.max(2, Math.floor(p * this.ghostPath.length));
        this.ghost.pts = this.ghostPath.slice(0, n).map((v) => v.clone());
        this.rebuildThread(this.ghost);
        this.computeSlots(this.ghost);
        this.ghostDot.position.copy(this.ghostPath[n - 1]);
        const m = this.ghostDot.material as T.SpriteMaterial;
        m.opacity = 0.9;
        this.ghostDot.scale.setScalar(0.03 + 0.008 * Math.sin(time * 9));
      } else {
        (this.ghostDot.material as T.SpriteMaterial).opacity = 0.25;
      }
    }

    switch (this.stage) {
      case 'intro':
        this.hint.set('Pinch and draw');
        this.hint.target = inSession > 2.5 ? 1 : 0;
        break;
      case 'pluck':
        this.hint.set('Touch a thread to pluck it');
        this.hint.target = since < 14 ? 1 : 0;
        if (since > 14) {
          this.stage = 'clap';
          this.stageT = time;
        }
        break;
      case 'clap': {
        // only worth teaching once there is a weave to clear
        const live = this.threads.filter((t) => !t.ghost && !t.dying).length;
        if (live < 3) this.stageT = time;
        else this.hint.set('Clap to clear the loom');
        this.hint.target = live >= 3 && since < 9 ? 1 : 0;
        break;
      }
      default:
        if (this.undo.length && time < this.undoUntil) {
          this.hint.set('Clap again to bring it back');
          this.hint.target = 1;
        } else {
          this.hint.target = 0;
        }
    }
    if (this.controllersOnly) {
      this.hint.set('Put your controllers down', 'WEFT IS PLAYED WITH YOUR HANDS');
      this.hint.target = 1;
    }
    this.hint.tick(dt);
    this.tuningLabel.target = this.title.opacity < 0.15 && inSession > 7 ? 0.75 : 0;
    this.tuningLabel.tick(dt);
  }
}
