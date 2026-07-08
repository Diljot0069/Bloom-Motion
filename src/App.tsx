import { useEffect, useRef, useState, useCallback } from 'react';

interface SmoothedValue {
  current: number;
  target: number;
  velocity: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  hue: number;
  life: number;
  maxLife: number;
}

interface Petal {
  released: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  scale: number;
  opacity: number;
  hue: number;
}

const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
const dist2D = (x1: number, y1: number, x2: number, y2: number) =>
  Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

const smoothStep = (s: SmoothedValue, stiffness = 0.12, damping = 0.75): number => {
  const acc = stiffness * (s.target - s.current) - damping * s.velocity;
  s.velocity += acc;
  s.current += s.velocity;
  return s.current;
};

class MovingAverage {
  private values: number[] = [];
  constructor(private size: number = 8) {}
  add(v: number): number {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
}

function App() {
  // ── Refs ──────────────────────────────────────────────────────────
  // Single video element – used for both MediaPipe input and the visible preview
  const videoRef = useRef<HTMLVideoElement>(null);
  const handCanvasRef = useRef<HTMLCanvasElement>(null);
  const flowerCanvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ambientGainRef = useRef<GainNode | null>(null);

  // ── State ─────────────────────────────────────────────────────────
  const [cameraPermission, setCameraPermission] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [showIntro, setShowIntro] = useState(true);
  const [trackingStatus, setTrackingStatus] = useState<'searching' | 'tracking'>('searching');
  const [detectedHands, setDetectedHands] = useState({ left: false, right: false });
  const [fps, setFps] = useState(0);
  const [isMuted, setIsMuted] = useState(true);
  const [bloomPercent, setBloomPercent] = useState(0);
  const [flowerSize, setFlowerSize] = useState(50);

  // ── Smoothed hand values ──────────────────────────────────────────
  const leftSmooth = useRef<SmoothedValue>({ current: 0.5, target: 0.5, velocity: 0 });
  const rightSmooth = useRef<SmoothedValue>({ current: 0.3, target: 0.3, velocity: 0 });
  const leftMA = useRef(new MovingAverage(8));
  const rightMA = useRef(new MovingAverage(8));

  // ── Animation state ───────────────────────────────────────────────
  const timeRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);
  const releasedPetalsRef = useRef<Petal[]>([]);
  const lastBloomRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

  // ─────────────────────────────────────────────────────────────────
  // Draw hand skeleton – coordinates are manually mirrored, NO CSS mirror needed
  // ─────────────────────────────────────────────────────────────────
  const drawHandSkeleton = useCallback((
    ctx: CanvasRenderingContext2D,
    landmarks: Array<{ x: number; y: number; z: number }>,
    w: number,
    h: number,
    isLeft: boolean
  ) => {
    const lineColor = isLeft ? 'rgba(255,182,193,0.9)' : 'rgba(255,218,185,0.9)';
    const glowColor = isLeft ? 'rgba(255,105,180,0.5)' : 'rgba(255,165,0,0.5)';

    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17],
    ];

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;

    for (const [s, e] of connections) {
      ctx.beginPath();
      ctx.moveTo((1 - landmarks[s].x) * w, landmarks[s].y * h);
      ctx.lineTo((1 - landmarks[e].x) * w, landmarks[e].y * h);
      ctx.stroke();
    }

    ctx.shadowBlur = 20;
    landmarks.forEach((lm) => {
      const x = (1 - lm.x) * w;
      const y = lm.y * h;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 5);
      grad.addColorStop(0, 'white');
      grad.addColorStop(0.5, lineColor);
      grad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });

    // Highlight thumb + index tips
    [4, 8].forEach(idx => {
      const x = (1 - landmarks[idx].x) * w;
      const y = landmarks[idx].y * h;
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    });

    ctx.shadowBlur = 0;
  }, []);

  // ─────────────────────────────────────────────────────────────────
  // MediaPipe results handler
  // ─────────────────────────────────────────────────────────────────
  const onHandsResults = useCallback((results: any) => {
    const canvas = handCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let leftFound = false;
    let rightFound = false;

    if (results.multiHandLandmarks && results.multiHandedness) {
      for (let i = 0; i < results.multiHandLandmarks.length; i++) {
        const landmarks = results.multiHandLandmarks[i];
        // MediaPipe labels from user's perspective (already accounts for mirror)
        // When using a mirrored preview, "Right" label = user's left hand
        const isLeft = results.multiHandedness[i].label === 'Right';

        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const pinch = clamp(dist2D(thumbTip.x, thumbTip.y, indexTip.x, indexTip.y) / 0.28, 0, 1);

        if (isLeft) {
          leftFound = true;
          leftSmooth.current.target = leftMA.current.add(pinch);
        } else {
          rightFound = true;
          rightSmooth.current.target = rightMA.current.add(pinch);
        }

        drawHandSkeleton(ctx, landmarks, canvas.width, canvas.height, isLeft);
      }
    }

    setDetectedHands({ left: leftFound, right: rightFound });
    setTrackingStatus(leftFound || rightFound ? 'tracking' : 'searching');

    if (!leftFound) leftSmooth.current.target = 0.5;
    if (!rightFound) rightSmooth.current.target = 0.3;
  }, [drawHandSkeleton]);

  // ─────────────────────────────────────────────────────────────────
  // Init MediaPipe + camera
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // @ts-ignore
      const hands = new Hands({
        locateFile: (f: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
      });
      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.65,
      });
      hands.onResults(onHandsResults);
      handsRef.current = hands;

      if (!videoRef.current) return;

      // @ts-ignore
      const camera = new Camera(videoRef.current, {
        onFrame: async () => {
          if (handsRef.current && videoRef.current && !cancelled) {
            await handsRef.current.send({ image: videoRef.current });
          }
        },
        width: 1280,
        height: 720,
      });

      try {
        await camera.start();
        if (!cancelled) {
          cameraRef.current = camera;
          setCameraPermission('granted');
        }
      } catch {
        if (!cancelled) setCameraPermission('denied');
      }
    };

    // Short delay so the video element is guaranteed to be in the DOM
    const tid = setTimeout(init, 200);
    const introTid = setTimeout(() => setShowIntro(false), 2500);

    return () => {
      cancelled = true;
      clearTimeout(tid);
      clearTimeout(introTid);
      cameraRef.current?.stop();
      cancelAnimationFrame(animationRef.current);
    };
  }, [onHandsResults]);

  // ─────────────────────────────────────────────────────────────────
  // Audio
  // ─────────────────────────────────────────────────────────────────
  const initAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'sine';
    osc.frequency.value = 110;
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    gain.gain.value = 0.025;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    audioCtxRef.current = ctx;
    ambientGainRef.current = gain;
  }, []);

  const playBloomChime = useCallback(() => {
    if (!audioCtxRef.current || isMuted) return;
    const ctx = audioCtxRef.current;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + i * 0.12 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.6);
    });
  }, [isMuted]);

  // ─────────────────────────────────────────────────────────────────
  // Main render loop – starts immediately, no gated flag
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const animate = () => {
      timeRef.current += 0.016;
      frameCountRef.current++;

      const now = Date.now();
      if (now - lastFpsTimeRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastFpsTimeRef.current = now;
      }

      const leftVal = smoothStep(leftSmooth.current);
      const rightVal = smoothStep(rightSmooth.current);
      const size = 30 + leftVal * 130;
      const bloom = rightVal;

      setFlowerSize(Math.round(size));
      setBloomPercent(Math.round(bloom * 100));

      if (bloom > 0.9 && lastBloomRef.current <= 0.9) {
        playBloomChime();
        for (let i = 0; i < 6; i++) {
          releasedPetalsRef.current.push({
            released: true,
            x: window.innerWidth / 2 + (Math.random() - 0.5) * 120,
            y: window.innerHeight / 2,
            vx: (Math.random() - 0.5) * 5,
            vy: -Math.random() * 4 - 1.5,
            rotation: Math.random() * 360,
            rotationSpeed: (Math.random() - 0.5) * 12,
            scale: 0.4 + Math.random() * 0.7,
            opacity: 1,
            hue: 325 + Math.random() * 35,
          });
        }
      }
      lastBloomRef.current = bloom;

      updateParticles(bloom);
      updatePetals();
      renderBackground(bloom, size);
      renderFlower(bloom, size);

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [playBloomChime]);

  // ─────────────────────────────────────────────────────────────────
  // Particle system
  // ─────────────────────────────────────────────────────────────────
  const updateParticles = (bloom: number) => {
    const arr = particlesRef.current;
    const cap = 40 + Math.floor(bloom * 30);
    if (arr.length < cap && Math.random() < 0.25) {
      arr.push({
        x: Math.random() * window.innerWidth,
        y: window.innerHeight + 10,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -Math.random() * 0.8 - 0.3,
        size: Math.random() * 3 + 1.5,
        opacity: Math.random() * 0.45 + 0.15,
        hue: 315 + Math.random() * 50,
        life: 0,
        maxLife: 350 + Math.random() * 200,
      });
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.x += p.vx + Math.sin(timeRef.current * 1.5 + i) * 0.2;
      p.y += p.vy;
      p.life++;
      if (p.life > p.maxLife || p.y < -10) arr.splice(i, 1);
    }
  };

  const updatePetals = () => {
    const arr = releasedPetalsRef.current;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.x += p.vx + Math.sin(timeRef.current + i) * 0.3;
      p.y += p.vy;
      p.vy += 0.04;
      p.rotation += p.rotationSpeed;
      p.opacity -= 0.004;
      if (p.opacity <= 0 || p.y > window.innerHeight + 60) arr.splice(i, 1);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Background renderer
  // ─────────────────────────────────────────────────────────────────
  const renderBackground = (bloom: number, size: number) => {
    const canvas = backgroundCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const hs = Math.sin(timeRef.current * 0.15) * 12;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, `hsl(${275 + hs},55%,95%)`);
    bg.addColorStop(0.35, `hsl(${318 + hs},48%,91%)`);
    bg.addColorStop(0.65, `hsl(${348 + hs},42%,89%)`);
    bg.addColorStop(1, `hsl(${32 + hs},52%,93%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Aurora bands
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 3; i++) {
      const aug = ctx.createLinearGradient(
        w * (0.2 + Math.sin(timeRef.current * 0.25 + i) * 0.25), 0,
        w * (0.7 + Math.cos(timeRef.current * 0.25 + i) * 0.2), h
      );
      aug.addColorStop(0, 'transparent');
      aug.addColorStop(0.5, `hsla(${295 + i * 25 + hs},75%,72%,0.5)`);
      aug.addColorStop(1, 'transparent');
      ctx.fillStyle = aug;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = 1;

    // Bokeh
    for (let i = 0; i < 9; i++) {
      const bx = w * (0.08 + (i / 9) * 0.84 + Math.sin(timeRef.current * 0.4 + i * 2.1) * 0.04);
      const by = h * (0.25 + Math.cos(timeRef.current * 0.28 + i * 1.7) * 0.22);
      const br = 90 + Math.sin(timeRef.current + i * 0.9) * 35;
      const bog = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      bog.addColorStop(0, `hsla(${335 + i * 12},65%,82%,0.07)`);
      bog.addColorStop(1, 'transparent');
      ctx.fillStyle = bog;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }

    // Particles
    particlesRef.current.forEach(p => {
      const pg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2.5);
      pg.addColorStop(0, `hsla(${p.hue},75%,82%,${p.opacity})`);
      pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // Light rays at high bloom
    if (bloom > 0.25) {
      const cx = w / 2, cy = h / 2;
      const rayCount = Math.floor(bloom * 14);
      ctx.globalAlpha = bloom * 0.18;
      for (let i = 0; i < rayCount; i++) {
        const angle = (i / rayCount) * Math.PI * 2 + timeRef.current * 0.18;
        const len = size * 3.5 + Math.sin(timeRef.current * 2 + i) * 25;
        const rg = ctx.createLinearGradient(cx, cy, cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
        rg.addColorStop(0, 'hsla(45,90%,80%,0.5)');
        rg.addColorStop(1, 'transparent');
        ctx.strokeStyle = rg;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Central glow reacting to size + bloom
    const gr = size * 2.2 + bloom * 60;
    const cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, gr);
    cg.addColorStop(0, `hsla(${42 + bloom * 18},78%,90%,${0.28 + bloom * 0.22})`);
    cg.addColorStop(0.5, `hsla(338,65%,85%,${0.12 + bloom * 0.1})`);
    cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, gr, 0, Math.PI * 2);
    ctx.fill();
  };

  // ─────────────────────────────────────────────────────────────────
  // Flower renderer
  // ─────────────────────────────────────────────────────────────────
  const renderFlower = (bloom: number, size: number) => {
    const canvas = flowerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const breathe = 1 + Math.sin(timeRef.current * 1.4) * 0.022;
    const fx = Math.sin(timeRef.current * 0.75) * 6;
    const fy = Math.sin(timeRef.current * 0.55) * 9;

    ctx.save();
    ctx.translate(w / 2 + fx, h / 2 + fy);
    ctx.scale(breathe, breathe);

    const layerDefs = [
      { count: 5,  sizeF: 1.00, colorH: 340, colorS: 48, colorL: 86 },
      { count: 7,  sizeF: 0.88, colorH: 335, colorS: 54, colorL: 80 },
      { count: 9,  sizeF: 0.76, colorH: 328, colorS: 60, colorL: 74 },
      { count: 11, sizeF: 0.64, colorH: 322, colorS: 66, colorL: 68 },
      { count: 13, sizeF: 0.52, colorH: 316, colorS: 72, colorL: 62 },
    ];

    // Outer → inner
    for (let layer = 0; layer < layerDefs.length; layer++) {
      const def = layerDefs[layer];
      const layerSize = size * def.sizeF;
      const layerBloom = clamp(bloom * 1.6 - layer * 0.08, 0.08, 1);

      ctx.save();
      ctx.rotate(layer * 0.22 + timeRef.current * 0.04 * (layer % 2 === 0 ? 1 : -1));

      for (let i = 0; i < def.count; i++) {
        const angle = (i / def.count) * Math.PI * 2;
        ctx.save();
        ctx.rotate(angle + (layerBloom - 0.5) * 0.85);

        const pLen = layerSize * (0.58 + layerBloom * 0.42);
        const pWid = layerSize * (0.24 + layerBloom * 0.16);
        const openness = 0.18 + layerBloom * 0.65;
        const shimmer = 0.88 + Math.sin(timeRef.current * 3.2 + i + layer) * 0.12;

        drawPetal(ctx, pLen, pWid, openness, def.colorH, def.colorS, def.colorL, shimmer);
        ctx.restore();
      }
      ctx.restore();
    }

    drawCenter(ctx, size * 0.14, bloom);
    drawStamens(ctx, size * 0.34, bloom);
    ctx.restore();

    // Released floating petals
    releasedPetalsRef.current.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.scale(p.scale, p.scale);
      drawFloatingPetal(ctx, 32, 14, p.hue);
      ctx.restore();
    });

    // Sparkles at full bloom
    if (bloom > 0.82) {
      const t = timeRef.current;
      const extra = (bloom - 0.82) / 0.18;
      const cx2 = w / 2 + fx, cy2 = h / 2 + fy;
      for (let i = 0; i < Math.floor(extra * 20); i++) {
        const a = Math.random() * Math.PI * 2;
        const d = size * 0.5 + Math.random() * size * 2;
        const sx = cx2 + Math.cos(a) * d;
        const sy = cy2 + Math.sin(a) * d;
        const ss = 1.5 + Math.random() * 3.5;
        ctx.save();
        ctx.globalAlpha = (0.4 + Math.random() * 0.6) * (0.5 + Math.sin(t * 8 + i) * 0.5);
        ctx.fillStyle = `hsla(${42 + Math.random() * 18},92%,84%,1)`;
        ctx.beginPath();
        ctx.arc(sx, sy, ss, 0, Math.PI * 2);
        ctx.fill();
        const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, ss * 3.5);
        sg.addColorStop(0, 'hsla(45,90%,90%,0.45)');
        sg.addColorStop(1, 'transparent');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sx, sy, ss * 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };

  const drawPetal = (
    ctx: CanvasRenderingContext2D,
    len: number, wid: number, openness: number,
    h: number, s: number, l: number, shimmer: number
  ) => {
    ctx.save();
    ctx.rotate(-openness * 0.28);

    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, `hsla(${h + 12},${s - 8}%,${l + 12}%,0.92)`);
    g.addColorStop(0.3, `hsla(${h},${s}%,${l}%,${0.86 * shimmer})`);
    g.addColorStop(0.7, `hsla(${h - 6},${s + 10}%,${l - 6}%,${0.80 * shimmer})`);
    g.addColorStop(1, `hsla(${h - 12},${s + 16}%,${l - 12}%,${0.72 * shimmer})`);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.22, -wid * 0.82, len * 0.62, -wid * 0.58, len, 0);
    ctx.bezierCurveTo(len * 0.62, wid * 0.58, len * 0.22, wid * 0.82, 0, 0);
    ctx.fillStyle = g;
    ctx.fill();

    // Center vein
    ctx.strokeStyle = `hsla(${h - 12},${s + 22}%,${l - 18}%,0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(len * 0.1, 0);
    ctx.lineTo(len * 0.72, 0);
    ctx.stroke();

    // Texture veins
    ctx.strokeStyle = `hsla(${h},${s + 8}%,${l + 6}%,0.09)`;
    ctx.lineWidth = 0.5;
    for (let v = 1; v <= 3; v++) {
      ctx.beginPath();
      ctx.moveTo(len * 0.18, -wid * 0.14 * v);
      ctx.quadraticCurveTo(len * 0.52, -wid * 0.09 * v, len * 0.82, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(len * 0.18, wid * 0.14 * v);
      ctx.quadraticCurveTo(len * 0.52, wid * 0.09 * v, len * 0.82, 0);
      ctx.stroke();
    }

    // Rim highlight
    ctx.strokeStyle = `hsla(${h + 12},${s - 22}%,${l + 22}%,0.14)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(len * 0.1, -wid * 0.28);
    ctx.quadraticCurveTo(len * 0.42, -wid * 0.44, len * 0.92, 0);
    ctx.stroke();

    // Translucent inner glow
    const ig = ctx.createRadialGradient(len * 0.28, 0, 0, len * 0.28, 0, wid * 1.1);
    ig.addColorStop(0, `hsla(${h + 18},${s - 12}%,${l + 22}%,0.28)`);
    ig.addColorStop(1, 'transparent');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.22, -wid * 0.82, len * 0.62, -wid * 0.58, len, 0);
    ctx.bezierCurveTo(len * 0.62, wid * 0.58, len * 0.22, wid * 0.82, 0, 0);
    ctx.fill();

    ctx.restore();
  };

  const drawFloatingPetal = (ctx: CanvasRenderingContext2D, len: number, wid: number, hue: number) => {
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, `hsla(${hue},65%,82%,0.9)`);
    g.addColorStop(1, `hsla(${hue - 10},70%,72%,0.7)`);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.22, -wid, len * 0.62, -wid * 0.5, len, 0);
    ctx.bezierCurveTo(len * 0.62, wid * 0.5, len * 0.22, wid, 0, 0);
    ctx.fillStyle = g;
    ctx.fill();
  };

  const drawCenter = (ctx: CanvasRenderingContext2D, radius: number, bloom: number) => {
    // Outer halo
    const halo = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, radius * 2.5);
    halo.addColorStop(0, `hsla(45,92%,72%,${0.45 + bloom * 0.3})`);
    halo.addColorStop(0.6, `hsla(40,85%,62%,0.2)`);
    halo.addColorStop(1, 'transparent');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Main disk
    const disk = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    disk.addColorStop(0, '#fffadc');
    disk.addColorStop(0.3, '#ffd700');
    disk.addColorStop(0.72, '#daa520');
    disk.addColorStop(1, '#b8860b');
    ctx.fillStyle = disk;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // Specular
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(-radius * 0.28, -radius * 0.28, radius * 0.32, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawStamens = (ctx: CanvasRenderingContext2D, radius: number, bloom: number) => {
    const count = 8;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + timeRef.current * 0.08;
      const sway = Math.sin(timeRef.current * 1.8 + i) * 0.12 * bloom;
      const len = radius * (0.55 + bloom * 0.45);

      ctx.save();
      ctx.rotate(angle + sway);

      ctx.strokeStyle = `hsla(50,58%,76%,0.8)`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(radius * 0.28, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();

      const pg = ctx.createRadialGradient(len, 0, 0, len, 0, 9);
      pg.addColorStop(0, `hsla(46,96%,70%,${0.65 + bloom * 0.3})`);
      pg.addColorStop(0.5, 'hsla(40,88%,60%,0.35)');
      pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(len, 0, 9, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffd700';
      ctx.beginPath();
      ctx.ellipse(len, 0, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Canvas resize
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const resize = () => {
      [handCanvasRef, flowerCanvasRef, backgroundCanvasRef].forEach(r => {
        if (r.current) {
          r.current.width = window.innerWidth;
          r.current.height = window.innerHeight;
        }
      });
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // ─────────────────────────────────────────────────────────────────
  // Audio toggle
  // ─────────────────────────────────────────────────────────────────
  const toggleMute = () => {
    if (!isMuted) {
      // muting
      if (ambientGainRef.current) ambientGainRef.current.gain.value = 0;
      setIsMuted(true);
    } else {
      // unmuting
      initAudio();
      if (ambientGainRef.current) ambientGainRef.current.gain.value = 0.025;
      setIsMuted(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-screen overflow-hidden select-none">

      {/* ── Intro overlay ── */}
      {showIntro && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #fce4ec 0%, #fdf2f8 50%, #fff3e0 100%)',
            animation: 'intro-fade 0.6s ease-out 2s forwards',
          }}
        >
          <h1 style={{ fontSize: '4rem', fontWeight: 200, color: '#d4626f', letterSpacing: '0.25em', marginBottom: '0.75rem' }}>
            BloomMotion
          </h1>
          <p style={{ fontSize: '1.1rem', color: '#e8909a', fontWeight: 300, letterSpacing: '0.12em' }}>
            Control Nature With Your Hands
          </p>
          <div style={{ marginTop: '2.5rem', display: 'flex', gap: '8px' }}>
            {[0, 0.2, 0.4].map(d => (
              <div key={d} style={{
                width: 8, height: 8, borderRadius: '50%', background: '#f48fb1',
                animation: `pulse-glow 1.2s ease-in-out ${d}s infinite`,
              }} />
            ))}
          </div>
        </div>
      )}

      {/* ── Camera denied ── */}
      {cameraPermission === 'denied' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #fce4ec, #fdf6ff)' }}>
          <div className="glass-panel p-12 text-center max-w-sm">
            <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>📷</div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 300, color: '#c62828', marginBottom: '1rem' }}>
              Camera Access Required
            </h2>
            <p style={{ color: '#e57373', fontWeight: 300, lineHeight: 1.6 }}>
              BloomMotion needs your camera to track hand gestures.
              Allow camera access and refresh the page.
            </p>
          </div>
        </div>
      )}

      {/* ── Background canvas ── */}
      <canvas ref={backgroundCanvasRef} className="absolute inset-0 z-0" />

      {/* ── Single video element: both MediaPipe source + visible preview ──
           • Always in DOM so videoRef is valid when init fires
           • CSS mirrors horizontally for natural selfie view
           • Positioned top-right, below the mute button              ── */}
      <video
        ref={videoRef}
        className="absolute z-10 object-cover rounded-2xl shadow-xl"
        style={{
          top: '5.5rem',
          right: '2rem',
          width: '180px',
          opacity: 0.55,
          transform: 'scaleX(-1)',
          border: '1px solid rgba(255,255,255,0.25)',
        }}
        playsInline
        muted
        autoPlay
      />

      {/* ── Hand skeleton canvas (no CSS mirror – coords already flipped) ── */}
      <canvas
        ref={handCanvasRef}
        className="absolute inset-0 z-20 pointer-events-none"
      />

      {/* ── Flower canvas ── */}
      <canvas
        ref={flowerCanvasRef}
        className="absolute inset-0 z-30 pointer-events-none"
      />

      {/* ── Header ── */}
      <div className="absolute top-0 left-0 right-0 z-40 flex justify-center pt-7 px-4">
        <div className="glass-panel px-10 py-5 text-center">
          <h1 style={{ fontSize: '1.8rem', fontWeight: 200, color: 'white', letterSpacing: '0.22em', marginBottom: '0.25rem' }}>
            BloomMotion
          </h1>
          <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.65)', fontWeight: 300, letterSpacing: '0.14em' }}>
            Control Nature With Your Hands
          </p>
        </div>
      </div>

      {/* ── Instructions (bottom-left) ── */}
      <div className="absolute bottom-8 left-8 z-40">
        <div className="glass-panel-dark p-5">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f48fb1', boxShadow: '0 0 8px #f48fb1' }} />
            <span style={{ color: 'rgba(255,255,255,0.88)', fontSize: '0.85rem', fontWeight: 300 }}>LEFT Hand — Size</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffcc80', boxShadow: '0 0 8px #ffcc80' }} />
            <span style={{ color: 'rgba(255,255,255,0.88)', fontSize: '0.85rem', fontWeight: 300 }}>RIGHT Hand — Bloom</span>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 12 }}>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.72rem', marginBottom: 3 }}>Pinch thumb + index together</p>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.72rem' }}>Spread apart to expand</p>
          </div>
        </div>
      </div>

      {/* ── Stats panel (bottom-right) ── */}
      <div className="absolute bottom-8 right-8 z-40">
        <div className="glass-panel-dark p-5" style={{ minWidth: 148 }}>
          {[
            { label: 'FPS', value: String(fps), color: fps >= 55 ? '#86efac' : fps >= 30 ? '#fde047' : '#fca5a5' },
            { label: 'Size', value: String(flowerSize), color: '#f9a8d4' },
            { label: 'Bloom', value: `${bloomPercent}%`, color: '#fdba74' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.75rem', fontWeight: 300 }}>{row.label}</span>
              <span style={{ color: row.color, fontSize: '0.88rem', fontWeight: 500 }}>{row.value}</span>
            </div>
          ))}

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.72rem' }}>Status</span>
              <span style={{
                fontSize: '0.75rem', fontWeight: 500,
                color: trackingStatus === 'tracking' ? '#86efac' : '#fde047',
              }}>
                {trackingStatus === 'tracking' ? 'Tracking' : 'Searching…'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: detectedHands.left ? '#f9a8d4' : 'rgba(255,255,255,0.15)',
                boxShadow: detectedHands.left ? '0 0 6px #f9a8d4' : 'none',
                transition: 'all 0.3s',
              }} />
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: detectedHands.right ? '#fdba74' : 'rgba(255,255,255,0.15)',
                boxShadow: detectedHands.right ? '0 0 6px #fdba74' : 'none',
                transition: 'all 0.3s',
              }} />
              <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.7rem' }}>L  R</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Mute button (top-right) ── */}
      <button
        onClick={toggleMute}
        className="absolute z-40 glass-panel-dark"
        style={{ top: '2rem', right: '2rem', padding: '10px', cursor: 'pointer', border: 'none', background: undefined }}
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="rgba(255,255,255,0.65)" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        ) : (
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="rgba(255,255,255,0.65)" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default App;
