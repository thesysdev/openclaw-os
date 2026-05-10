import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Team = 'left' | 'right';
type Vec = { x: number; y: number };
type Marble = Vec & {
  vx: number;
  vy: number;
  r: number;
  team: Team;
  assetId: string;
  color: string;
  score: number;
};
type Peg = Vec & { r: number };
type Triangle = Vec & { size: number; rot: number; verts: Vec[] };
type Block = { type: 'peg'; peg: Peg } | { type: 'tri'; tri: Triangle };

const W = 1100;
const H = 680;
const LEFT = '#37a2ff';
const RIGHT = '#ff5a7a';
const BG = '#080b14';
const SIDE_ZONE = 132;
const GOAL_ZONE = 72;
const MARBLE_ASSETS = Array.from({ length: 32 }, (_, i) => `asset-${i + 1}`);
const SCORE_ZONES = [
  { top: 0, bottom: 0.22, points: 1 },
  { top: 0.22, bottom: 0.40, points: 2 },
  { top: 0.40, bottom: 0.60, points: 3 },
  { top: 0.60, bottom: 0.78, points: 2 },
  { top: 0.78, bottom: 1, points: 1 },
];
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function triVerts(x: number, y: number, size: number, rot: number): Vec[] {
  return [0, 1, 2].map((i) => {
    const a = rot + i * (Math.PI * 2 / 3) - Math.PI / 2;
    return { x: x + Math.cos(a) * size, y: y + Math.sin(a) * size };
  });
}

function newField(): Block[] {
  const blocks: Block[] = [];
  const cols = 7;
  const rows = 10;
  const fieldLeft = SIDE_ZONE + 42;
  const fieldRight = W / 2 - 28;
  const xGap = (fieldRight - fieldLeft) / (cols - 1);
  const yGap = H / (rows + 1);
  const addMirrored = (block: Block) => {
    blocks.push(block);
    if (block.type === 'peg') {
      const { x, y, r } = block.peg;
      blocks.push({ type: 'peg', peg: { x: W - x, y, r } });
    } else {
      const { x, y, size, rot } = block.tri;
      const mx = W - x;
      const mrot = Math.PI - rot;
      blocks.push({ type: 'tri', tri: { x: mx, y, size, rot: mrot, verts: triVerts(mx, y, size, mrot) } });
    }
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = fieldLeft + xGap * col + (row % 2 ? xGap * 0.33 : 0) + rand(-13, 13);
      const y = yGap * (row + 1) + rand(-18, 18);
      if (x < fieldLeft || x > fieldRight) continue;
      if (Math.random() < 0.18) {
        const size = rand(15, 30);
        const rot = rand(0, Math.PI * 2);
        addMirrored({ type: 'tri', tri: { x, y, size, rot, verts: triVerts(x, y, size, rot) } });
      } else {
        addMirrored({ type: 'peg', peg: { x, y, r: rand(7, 13) } });
      }
    }
  }
  // Larger midfield deflectors create the chunky pachinko-machine read from the sketch/reference.
  // Only the left half is sampled; the right half is always a mirror, so both teams get the same course.
  for (let i = 0; i < 6; i++) {
    const x = rand(W * 0.28, W / 2 - 42);
    const y = rand(H * 0.18, H * 0.82);
    if (Math.random() < 0.5) addMirrored({ type: 'peg', peg: { x, y, r: rand(16, 28) } });
    else {
      const rot = rand(0, Math.PI * 2);
      const size = rand(25, 42);
      addMirrored({ type: 'tri', tri: { x, y, size, rot, verts: triVerts(x, y, size, rot) } });
    }
  }
  return blocks;
}

function getGoalPoints(y: number) {
  const pct = clamp(y / H, 0, 0.999);
  return SCORE_ZONES.find((zone) => pct >= zone.top && pct < zone.bottom)?.points ?? 1;
}

function makeMarble(team: Team, i: number, assetId: string): Marble {
  return {
    x: team === 'left' ? rand(28, SIDE_ZONE - 32) : rand(W - SIDE_ZONE + 32, W - 28),
    y: 56 + (i % 13) * 44 + Math.floor(i / 13) * 18 + rand(-5, 5),
    vx: team === 'left' ? rand(0, 35) : rand(-35, 0),
    vy: rand(-45, 45),
    r: rand(8, 12),
    team,
    assetId,
    color: team === 'left' ? LEFT : RIGHT,
    score: 0,
  };
}

function spawnTeam(team: Team, count: number): Marble[] {
  if (count > MARBLE_ASSETS.length) throw new Error(`Team count ${count} exceeds unique asset pool ${MARBLE_ASSETS.length}`);
  const assetPool = [...MARBLE_ASSETS].sort(() => Math.random() - 0.5);
  return Array.from({ length: count }, (_, i) => makeMarble(team, i, assetPool[i]));
}

function respawnMarble(m: Marble) {
  return { ...makeMarble(m.team, Math.floor(rand(0, 26)), m.assetId), score: m.score };
}

function collideCircle(m: Marble, c: Vec, r: number, bounce = 0.82) {
  const dx = m.x - c.x;
  const dy = m.y - c.y;
  const d = Math.hypot(dx, dy) || 0.0001;
  const minD = m.r + r;
  if (d >= minD) return;
  const nx = dx / d;
  const ny = dy / d;
  const push = minD - d;
  m.x += nx * push;
  m.y += ny * push;
  const vn = m.vx * nx + m.vy * ny;
  if (vn < 0) {
    m.vx -= (1 + bounce) * vn * nx;
    m.vy -= (1 + bounce) * vn * ny;
  }
}

function closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby), 0, 1);
  return { x: a.x + abx * t, y: a.y + aby * t };
}

function collideTriangle(m: Marble, tri: Triangle) {
  for (let i = 0; i < 3; i++) {
    const a = tri.verts[i];
    const b = tri.verts[(i + 1) % 3];
    collideCircle(m, closestPointOnSegment(m, a, b), 1, 0.88);
  }
}

function drawTriangle(ctx: CanvasRenderingContext2D, tri: Triangle) {
  ctx.beginPath();
  ctx.moveTo(tri.verts[0].x, tri.verts[0].y);
  ctx.lineTo(tri.verts[1].x, tri.verts[1].y);
  ctx.lineTo(tri.verts[2].x, tri.verts[2].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Vec, to: Vec, color: string) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - 0.45) * 15, to.y - Math.sin(angle - 0.45) * 15);
  ctx.lineTo(to.x - Math.cos(angle + 0.45) * 15, to.y - Math.sin(angle + 0.45) * 15);
  ctx.closePath();
  ctx.fill();
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const marblesRef = useRef<Marble[]>([]);
  const blocksRef = useRef<Block[]>([]);
  const scoreRef = useRef({ left: 0, right: 0 });
  const [hud, setHud] = useState({ left: 0, right: 0, marbles: 0, field: 0 });

  const reset = () => {
    blocksRef.current = newField();
    marblesRef.current = [...spawnTeam('left', 26), ...spawnTeam('right', 26)];
    scoreRef.current = { left: 0, right: 0 };
    setHud({ left: 0, right: 0, marbles: marblesRef.current.length, field: blocksRef.current.length });
  };

  useEffect(() => {
    reset();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let last = performance.now();
    let raf = 0;

    let lastHud = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.025, (now - last) / 1000);
      last = now;
      const marbles = marblesRef.current;
      const blocks = blocksRef.current;

      for (const m of marbles) {
        const gx = m.team === 'left' ? 360 : -360;
        m.vx += gx * dt;
        m.vy += Math.sin(now * 0.001 + m.x * 0.01) * 12 * dt; // tiny turbulence, keeps lanes from feeling solved
        m.vx *= 0.996;
        m.vy *= 0.996;
        m.x += m.vx * dt;
        m.y += m.vy * dt;

        if (m.y < m.r) { m.y = m.r; m.vy = Math.abs(m.vy) * 0.82; }
        if (m.y > H - m.r) { m.y = H - m.r; m.vy = -Math.abs(m.vy) * 0.82; }

        for (const block of blocks) {
          if (block.type === 'peg') collideCircle(m, block.peg, block.peg.r);
          else collideTriangle(m, block.tri);
        }
      }

      // Marble-to-marble collisions, including cross-team traffic jams.
      for (let i = 0; i < marbles.length; i++) {
        for (let j = i + 1; j < marbles.length; j++) {
          const a = marbles[i];
          const b = marbles[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const minD = a.r + b.r;
          if (d >= minD) continue;
          const nx = dx / d;
          const ny = dy / d;
          const push = (minD - d) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const impulse = -rel * 0.92;
            a.vx -= impulse * nx; a.vy -= impulse * ny;
            b.vx += impulse * nx; b.vy += impulse * ny;
          }
        }
      }

      for (const m of marbles) {
        if (m.team === 'left' && m.x + m.r >= W) {
          const points = getGoalPoints(m.y);
          scoreRef.current.left += points;
          m.score += points;
          Object.assign(m, respawnMarble(m));
        }
        if (m.team === 'right' && m.x - m.r <= 0) {
          const points = getGoalPoints(m.y);
          scoreRef.current.right += points;
          m.score += points;
          Object.assign(m, respawnMarble(m));
        }
        // If a marble gets fully shoved backwards, bounce it back into play.
        if (m.x < -60 || m.x > W + 60) Object.assign(m, respawnMarble(m));
      }

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, 'rgba(55,162,255,.18)');
      g.addColorStop(0.5, 'rgba(255,255,255,.03)');
      g.addColorStop(1, 'rgba(255,90,122,.18)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // Big readable board zones: team staging pockets, opposite goals, and the pachinko field.
      ctx.fillStyle = 'rgba(55,162,255,.16)';
      ctx.fillRect(0, 0, SIDE_ZONE, H);
      ctx.fillStyle = 'rgba(255,90,122,.16)';
      ctx.fillRect(W - SIDE_ZONE, 0, SIDE_ZONE, H);
      ctx.fillStyle = 'rgba(255,90,122,.16)';
      ctx.fillRect(0, 0, GOAL_ZONE, H);
      ctx.fillStyle = 'rgba(55,162,255,.16)';
      ctx.fillRect(W - GOAL_ZONE, 0, GOAL_ZONE, H);

      for (const zone of SCORE_ZONES) {
        const y = zone.top * H;
        const h = (zone.bottom - zone.top) * H;
        const alpha = zone.points === 3 ? 0.18 : zone.points === 2 ? 0.11 : 0.06;
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.fillRect(0, y, GOAL_ZONE, h);
        ctx.fillRect(W - GOAL_ZONE, y, GOAL_ZONE, h);
        ctx.fillStyle = 'rgba(255,255,255,.62)';
        ctx.font = '800 13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${zone.points}`, GOAL_ZONE / 2, y + h / 2 + 5);
        ctx.fillText(`${zone.points}`, W - GOAL_ZONE / 2, y + h / 2 + 5);
      }

      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 3;
      ctx.strokeRect(SIDE_ZONE, 18, W - SIDE_ZONE * 2, H - 36);
      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.beginPath();
      ctx.moveTo(SIDE_ZONE, 0); ctx.lineTo(SIDE_ZONE, H);
      ctx.moveTo(W - SIDE_ZONE, 0); ctx.lineTo(W - SIDE_ZONE, H);
      ctx.stroke();

      drawArrow(ctx, { x: 34, y: 34 }, { x: 108, y: 34 }, 'rgba(87,183,255,.85)');
      drawArrow(ctx, { x: W - 34, y: H - 34 }, { x: W - 108, y: H - 34 }, 'rgba(255,120,146,.85)');

      ctx.save();
      ctx.font = '800 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,.68)';
      ctx.fillText('BLUE START', SIDE_ZONE / 2, H - 22);
      ctx.fillText('RED START', W - SIDE_ZONE / 2, 32);
      ctx.fillText('RED GOAL', GOAL_ZONE / 2, 32);
      ctx.fillText('BLUE GOAL', W - GOAL_ZONE / 2, H - 22);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const block of blocks) {
        ctx.fillStyle = 'rgba(235,240,255,.72)';
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.lineWidth = 2;
        if (block.type === 'peg') {
          ctx.beginPath();
          ctx.arc(block.peg.x, block.peg.y, block.peg.r, 0, Math.PI * 2);
          ctx.fill();
        } else drawTriangle(ctx, block.tri);
      }

      for (const m of marbles) {
        ctx.beginPath();
        ctx.shadowColor = m.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = m.color;
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.beginPath();
        ctx.arc(m.x - m.r * 0.32, m.y - m.r * 0.35, m.r * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }

      if (now - lastHud > 200) {
        lastHud = now;
        setHud({ left: scoreRef.current.left, right: scoreRef.current.right, marbles: marbles.length, field: blocks.length });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <main>
      <section className="panel">
        <div>
          <p className="eyebrow">Prototype 0.2</p>
          <h1>Marble Pachinko Clash</h1>
          <p className="summary">Blue and red teams launch from opposite staging zones, then fight through a dense pachinko field toward the opposite goal side.</p>
        </div>
        <div className="scoreboard">
          <span className="blue">Left team: {hud.left}</span>
          <span className="red">Right team: {hud.right}</span>
          <span>{hud.marbles} marbles · {hud.field} colliders</span>
        </div>
        <button onClick={reset}>Regenerate Field</button>
      </section>
      <canvas ref={canvasRef} width={W} height={H} />
      <p className="note">Next obvious prototype knobs: team sizes, gravity strength, collider recipes, goals, marble traits, and scoring zones.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
