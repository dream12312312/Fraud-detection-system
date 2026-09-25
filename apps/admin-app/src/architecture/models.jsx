/**
 * Realistic 3D models for the architecture nodes.
 *
 * Every node gets an object that looks like the thing it represents (a phone,
 * a server rack, a chip, a database stack, gold ingots, a GPU…) built from
 * PBR materials that pick up the scene's studio environment map.
 * Animation speed follows the node's real status: running = fast, idle = calm,
 * inactive = powered off (no motion, LEDs dark).
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

const MODEL_FOR = {
  'user-app': 'phone', 'admin-app': 'monitor', api: 'rack', 'fraud-engine': 'chip', base: 'chip',
  alerts: 'beacon', mongo: 'dbstack', landing: 'funnel', bridge: 'funnel', kafka: 'log', volume: 'bucket',
  bronze: 'ingots', silver: 'ingots', gold: 'ingots', dataset: 'datacube', features: 'gears', train: 'gpu',
  evaluate: 'gauge', mlflow: 'chart', registry: 'crates'
};
const SHAPE_FALLBACK = {
  screen: 'monitor', server: 'rack', brain: 'chip', bell: 'beacon', database: 'dbstack', funnel: 'funnel',
  ring: 'log', cube: 'gpu', disc: 'ingots', crystal: 'datacube', gear: 'gears', orb: 'gauge'
};
// Height of each model's top above the pedestal model origin (used to pin labels to the object).
const TOP = { phone: 1.7, monitor: 1.62, rack: 1.76, chip: 1.6, beacon: 1.06, dbstack: 1.28, funnel: 1.6, log: 1.45, bucket: 1.32,
  ingots: 0.62, datacube: 1.12, gears: 1.45, gpu: 1.2, gauge: 1.66, chart: 1.2, crates: 0.9 };
export const modelTop = (kind) => TOP[kind] ?? 1.5;
export const modelKind = (node) => node.model || MODEL_FOR[node.id] || SHAPE_FALLBACK[node.shape] || 'rack';

/* ---------------- canvas textures (screens, shadow) ---------------- */

const texCache = {};
function canvasTex(key, w, h, draw) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache[key] = t;
  return t;
}
const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };

export function shadowTexture() {
  return canvasTex('shadow', 128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.75)'); grad.addColorStop(0.55, 'rgba(0,0,0,.35)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  });
}

function phoneScreen() {
  return canvasTex('phone', 256, 500, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#13244a'); bg.addColorStop(1, '#0a1428');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e8eefc'; g.font = 'bold 22px Segoe UI, sans-serif'; g.fillText('SentinelPay', 22, 52);
    const card = g.createLinearGradient(0, 80, w, 200); card.addColorStop(0, '#4f7cff'); card.addColorStop(1, '#8b5cf6');
    g.fillStyle = card; rr(g, 18, 78, w - 36, 118, 16);
    g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '15px Segoe UI, sans-serif'; g.fillText('Available balance', 34, 110);
    g.fillStyle = '#fff'; g.font = 'bold 34px Segoe UI, sans-serif'; g.fillText('$4,700.00', 34, 156);
    const rows = [['#34d399', 'Rent · approved'], ['#fbbf24', 'Review · confirm'], ['#34d399', 'Groceries'], ['#f87171', 'Blocked payment']];
    rows.forEach(([c, t], i) => {
      const y = 224 + i * 54;
      g.fillStyle = 'rgba(255,255,255,.06)'; rr(g, 18, y, w - 36, 44, 10);
      g.fillStyle = c; g.beginPath(); g.arc(42, y + 22, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#cfd8ea'; g.font = '15px Segoe UI, sans-serif'; g.fillText(t, 62, y + 27);
    });
    g.fillStyle = '#4f7cff'; rr(g, 18, h - 70, w - 36, 46, 14);
    g.fillStyle = '#fff'; g.font = 'bold 18px Segoe UI, sans-serif'; g.fillText('Send money', w / 2 - 50, h - 40);
  });
}

function monitorScreen() {
  return canvasTex('monitor', 640, 360, (g, w, h) => {
    g.fillStyle = '#0c1630'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111f3f'; g.fillRect(0, 0, 120, h);
    for (let i = 0; i < 6; i += 1) { g.fillStyle = i === 2 ? '#4f7cff' : 'rgba(255,255,255,.12)'; rr(g, 14, 30 + i * 40, 92, 22, 6); }
    const kpi = ['#4f7cff', '#34d399', '#fbbf24', '#f87171'];
    kpi.forEach((c, i) => { g.fillStyle = 'rgba(255,255,255,.07)'; rr(g, 140 + i * 122, 22, 110, 70, 10); g.fillStyle = c; rr(g, 152 + i * 122, 36, 40, 8, 4); g.fillStyle = '#e8eefc'; g.font = 'bold 26px Segoe UI'; g.fillText(String([128, 97, 6, 3][i]), 152 + i * 122, 78); });
    g.fillStyle = 'rgba(255,255,255,.06)'; rr(g, 140, 110, 290, 230, 12);
    [0.4, 0.65, 0.5, 0.85, 0.7, 0.95, 0.6].forEach((v, i) => { const bh = v * 170; const gr = g.createLinearGradient(0, 320 - bh, 0, 320); gr.addColorStop(0, '#8b5cf6'); gr.addColorStop(1, '#4f7cff'); g.fillStyle = gr; rr(g, 160 + i * 38, 320 - bh, 24, bh, 5); });
    g.fillStyle = 'rgba(255,255,255,.06)'; rr(g, 446, 110, 176, 230, 12);
    g.strokeStyle = '#34d399'; g.lineWidth = 4; g.beginPath();
    [0.3, 0.5, 0.42, 0.7, 0.6, 0.82].forEach((v, i) => { const x = 462 + i * 28; const y = 320 - v * 180; if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
  });
}

/* ---------------- geometry helpers ---------------- */

function shieldGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.42);
  s.quadraticCurveTo(0.2, 0.33, 0.36, 0.33);
  s.lineTo(0.36, 0.02);
  s.quadraticCurveTo(0.34, -0.3, 0, -0.46);
  s.quadraticCurveTo(-0.34, -0.3, -0.36, 0.02);
  s.lineTo(-0.36, 0.33);
  s.quadraticCurveTo(-0.2, 0.33, 0, 0.42);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 4, curveSegments: 18 });
  g.center();
  return g;
}

function gearGeometry(teeth, rOut, rIn, depth) {
  const s = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step;
    const pts = [[rIn, a], [rOut, a + step * 0.18], [rOut, a + step * 0.5], [rIn, a + step * 0.68]];
    pts.forEach(([r, t], j) => { const x = Math.cos(t) * r; const y = Math.sin(t) * r; if (i === 0 && j === 0) s.moveTo(x, y); else s.lineTo(x, y); });
  }
  s.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, rIn * 0.32, 0, Math.PI * 2, true); s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 2 });
  g.center();
  return g;
}

function ingotGeometry() {
  const g = new THREE.CylinderGeometry(0.27, 0.36, 0.2, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale(1.45, 1, 1);
  return g;
}

/* ---------------- materials ---------------- */

/** One material set per node so dimming/status never leaks between nodes. */
export function useModelMaterials({ accent, status, dimmed, inactive, kind }) {
  const mats = useMemo(() => {
    const std = (p) => new THREE.MeshStandardMaterial({ transparent: true, ...p });
    const phys = (p) => new THREE.MeshPhysicalMaterial({ transparent: true, ...p });
    const m = {
      chassis: std({ color: '#2b3753', metalness: 0.8, roughness: 0.3 }),
      dark: std({ color: '#121a2b', metalness: 0.55, roughness: 0.42 }),
      metal: std({ color: '#dfe6f2', metalness: 1, roughness: 0.2 }),
      pcb: std({ color: '#0f4a36', metalness: 0.3, roughness: 0.55 }),
      goldPin: std({ color: '#f2c14e', metalness: 1, roughness: 0.25 }),
      paper: std({ color: '#f4f7fc', metalness: 0, roughness: 0.7 }),
      accent: phys({ color: accent, metalness: 0.35, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 }),
      precious: std({ color: accent, metalness: 1, roughness: 0.16 }),
      glass: phys({ color: accent, metalness: 0, roughness: 0.05, clearcoat: 1, emissive: accent, emissiveIntensity: 0.35, opacity: 0.55, depthWrite: false }),
      led: new THREE.MeshBasicMaterial({ color: accent, toneMapped: false, transparent: true }),
      statusLed: new THREE.MeshBasicMaterial({ color: status, toneMapped: false, transparent: true }),
      beam: new THREE.MeshBasicMaterial({ color: accent, toneMapped: false, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
    };
    if (kind === 'phone' || kind === 'monitor') {
      m.screen = new THREE.MeshBasicMaterial({ map: kind === 'phone' ? phoneScreen() : monitorScreen(), toneMapped: false, transparent: true });
    }
    m.funnel = std({ color: accent, metalness: 0.7, roughness: 0.25, side: THREE.DoubleSide });
    Object.values(m).forEach((x) => { x.userData.baseOpacity = x.opacity; });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accent, kind]);

  useEffect(() => { mats.statusLed.color.set(status); }, [mats, status]);
  useEffect(() => {
    const k = dimmed ? 0.14 : 1;
    Object.values(mats).forEach((x) => {
      x.opacity = x.userData.baseOpacity * k;
      if (x.userData.baseOpacity === 1 && x.blending !== THREE.AdditiveBlending) x.depthWrite = !dimmed;
    });
    // Powered-off devices: LEDs and screens go dark.
    const lit = inactive ? 0.28 : 1;
    mats.led.color.set(accent).multiplyScalar(lit);
    if (mats.screen) mats.screen.color.setScalar(inactive ? 0.35 : 1);
  }, [mats, dimmed, inactive, accent]);
  useEffect(() => () => Object.values(mats).forEach((x) => x.dispose()), [mats]);
  return mats;
}

/* ---------------- models (origin at the bottom centre, ~1.6 tall) ---------------- */

function Phone({ m }) {
  return (
    <group rotation={[-0.16, 0.12, 0]} position={[0, 0.02, 0]}>
      <RoundedBox args={[0.84, 1.6, 0.1]} radius={0.09} smoothness={4} position={[0, 0.82, 0]} material={m.chassis} />
      <mesh position={[0, 0.82, 0.052]} material={m.screen}><planeGeometry args={[0.74, 1.46]} /></mesh>
      <RoundedBox args={[0.2, 0.04, 0.01]} radius={0.015} smoothness={2} position={[0, 1.52, 0.056]} material={m.dark} />
      <mesh position={[0.43, 1.05, 0]} material={m.metal}><boxGeometry args={[0.02, 0.22, 0.05]} /></mesh>
    </group>
  );
}

function Monitor({ m }) {
  return (
    <group>
      <mesh position={[0, 0.03, 0.05]} material={m.metal}><cylinderGeometry args={[0.36, 0.4, 0.06, 40]} /></mesh>
      <mesh position={[0, 0.36, 0]} material={m.metal}><boxGeometry args={[0.09, 0.62, 0.07]} /></mesh>
      <RoundedBox args={[1.96, 1.16, 0.08]} radius={0.04} smoothness={3} position={[0, 1.02, 0.02]} material={m.chassis} />
      <mesh position={[0, 1.03, 0.063]} material={m.screen}><planeGeometry args={[1.84, 1.04]} /></mesh>
      <mesh position={[0.86, 0.48, 0.065]} material={m.statusLed}><circleGeometry args={[0.018, 12]} /></mesh>
    </group>
  );
}

function Rack({ m, anim }) {
  const leds = useMemo(() => Array.from({ length: 5 }, () => m.led.clone()), [m.led]);
  useEffect(() => () => leds.forEach((x) => x.dispose()), [leds]);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    leds.forEach((x, i) => { x.color.copy(m.led.color); x.opacity = m.led.opacity * (anim.inactive ? 0.3 : 0.45 + 0.55 * (Math.sin(t * (anim.running ? 14 : 5) + i * 1.9) > 0 ? 1 : 0.2)); });
  });
  return (
    <group>
      <RoundedBox args={[1.02, 1.72, 0.86]} radius={0.05} smoothness={3} position={[0, 0.86, 0]} material={m.chassis} />
      {leds.map((led, i) => {
        const y = 0.24 + i * 0.31;
        return (
          <group key={i} position={[0, y, 0.435]}>
            <mesh material={m.dark}><boxGeometry args={[0.9, 0.25, 0.02]} /></mesh>
            {[-0.3, -0.18, -0.06, 0.06].map((x) => <mesh key={x} position={[x, 0, 0.012]} material={m.chassis}><boxGeometry args={[0.08, 0.17, 0.005]} /></mesh>)}
            <mesh position={[0.24, 0, 0.014]} material={led}><boxGeometry args={[0.06, 0.035, 0.01]} /></mesh>
            <mesh position={[0.35, 0, 0.014]} material={m.statusLed}><boxGeometry args={[0.035, 0.035, 0.01]} /></mesh>
          </group>
        );
      })}
      <mesh position={[0, 1.735, 0]} material={m.metal}><boxGeometry args={[1.04, 0.02, 0.88]} /></mesh>
    </group>
  );
}

function Chip({ m, anim }) {
  const shield = useRef();
  const geo = useMemo(() => shieldGeometry(), []);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame((s, dt) => {
    if (!shield.current) return;
    if (!anim.inactive) shield.current.rotation.y += dt * (anim.running ? 1.6 : 0.6);
    shield.current.position.y = 1.12 + Math.sin(s.clock.elapsedTime * 1.4) * 0.05;
  });
  const pins = [-0.3, -0.18, -0.06, 0.06, 0.18, 0.3];
  return (
    <group>
      <mesh position={[0, 0.04, 0]} material={m.pcb}><boxGeometry args={[1.45, 0.07, 1.45]} /></mesh>
      {[0, 1, 2, 3].map((side) => (
        <group key={side} rotation={[0, (side * Math.PI) / 2, 0]}>
          {pins.map((p) => <mesh key={p} position={[p, 0.1, 0.5]} material={m.goldPin}><boxGeometry args={[0.05, 0.03, 0.14]} /></mesh>)}
          {pins.map((p) => <mesh key={`t${p}`} position={[p, 0.078, 0.64]} material={m.led}><boxGeometry args={[0.018, 0.004, 0.14]} /></mesh>)}
        </group>
      ))}
      <RoundedBox args={[0.9, 0.16, 0.9]} radius={0.03} smoothness={2} position={[0, 0.16, 0]} material={m.dark} />
      <RoundedBox args={[0.66, 0.04, 0.66]} radius={0.02} smoothness={2} position={[0, 0.25, 0]} material={m.metal} />
      <mesh position={[0, 0.65, 0]} material={m.beam}><cylinderGeometry args={[0.08, 0.3, 0.72, 24, 1, true]} /></mesh>
      <group ref={shield} position={[0, 1.12, 0]}>
        <mesh geometry={geo} material={m.accent} />
        <mesh position={[0, 0, 0.075]} material={m.statusLed}><torusGeometry args={[0.13, 0.025, 8, 24, Math.PI * 1.4]} /></mesh>
      </group>
    </group>
  );
}

function Beacon({ m, anim }) {
  const spin = useRef();
  useFrame((_, dt) => { if (spin.current && !anim.inactive) spin.current.rotation.y += dt * (anim.running ? 7 : 2.4); });
  return (
    <group>
      <mesh position={[0, 0.14, 0]} material={m.chassis}><cylinderGeometry args={[0.5, 0.56, 0.28, 40]} /></mesh>
      <mesh position={[0, 0.29, 0]} material={m.metal}><cylinderGeometry args={[0.47, 0.47, 0.04, 40]} /></mesh>
      <mesh position={[0, 0.31, 0]} material={m.glass}><cylinderGeometry args={[0.4, 0.42, 0.5, 40, 1, true]} /></mesh>
      <mesh position={[0, 0.56, 0]} material={m.glass}><sphereGeometry args={[0.4, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
      <group ref={spin} position={[0, 0.58, 0]}>
        <mesh material={m.led}><boxGeometry args={[0.18, 0.22, 0.08]} /></mesh>
        <mesh position={[0, 0, 0.9]} rotation={[Math.PI / 2, 0, 0]} material={m.beam}><coneGeometry args={[0.45, 1.6, 24, 1, true]} /></mesh>
      </group>
      <mesh position={[0, 1.0, 0]} material={m.metal}><sphereGeometry args={[0.05, 16, 8]} /></mesh>
    </group>
  );
}

function DbStack({ m }) {
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <group key={i} position={[0, 0.22 + i * 0.44, 0]}>
          <mesh material={m.chassis}><cylinderGeometry args={[0.62, 0.62, 0.36, 48]} /></mesh>
          <mesh position={[0, 0.181, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.metal}><circleGeometry args={[0.6, 48]} /></mesh>
          <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.led}><torusGeometry args={[0.6, 0.022, 8, 64]} /></mesh>
          <mesh position={[0.28, 0, 0.555]} material={m.statusLed}><sphereGeometry args={[0.035, 12, 8]} /></mesh>
          <mesh position={[0.4, 0, 0.47]} material={m.led}><sphereGeometry args={[0.03, 12, 8]} /></mesh>
        </group>
      ))}
    </group>
  );
}

function Funnel({ m, anim }) {
  const geo = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(0.09, 0), new THREE.Vector2(0.09, 0.4), new THREE.Vector2(0.6, 1.08), new THREE.Vector2(0.66, 1.12), new THREE.Vector2(0.62, 1.12)
  ], 48), []);
  useEffect(() => () => geo.dispose(), [geo]);
  const drops = useRef([]);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    drops.current.forEach((d, i) => {
      if (!d) return;
      d.visible = !anim.inactive;
      const p = (t * (anim.running ? 0.9 : 0.45) + i / 4) % 1;
      const r = 0.45 * (1 - p);
      d.position.set(Math.cos(i * 1.6 + p * 5) * r, 1.6 - p * 1.35, Math.sin(i * 1.6 + p * 5) * r);
      d.rotation.set(t, t * 1.3, 0);
    });
  });
  return (
    <group>
      <mesh geometry={geo} material={m.funnel} />
      <mesh position={[0, 1.12, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}><torusGeometry args={[0.64, 0.03, 8, 48]} /></mesh>
      {[0, 1, 2, 3].map((i) => <mesh key={i} ref={(el) => { drops.current[i] = el; }} material={m.led}><boxGeometry args={[0.1, 0.1, 0.1]} /></mesh>)}
    </group>
  );
}

function Log({ m, anim }) {
  const rows = useRef([]);
  useFrame((s) => {
    const t = s.clock.elapsedTime * (anim.inactive ? 0 : anim.running ? 0.5 : 0.18);
    rows.current.forEach((row, r) => row && row.children.forEach((c, i) => { c.position.x = -0.7 + (((i / 5 + t * (1 + r * 0.25)) % 1) * 1.4); }));
  });
  return (
    <group>
      {[-0.62, 0.62].map((x) => <mesh key={x} position={[x, 0.7, 0]} material={m.metal}><boxGeometry args={[0.05, 1.4, 0.44]} /></mesh>)}
      {[0, 1, 2].map((r) => (
        <group key={r} position={[0, 0.3 + r * 0.42, 0]}>
          <mesh material={m.dark}><boxGeometry args={[1.3, 0.05, 0.4]} /></mesh>
          <group ref={(el) => { rows.current[r] = el; }} position={[0, 0.11, 0]}>
            {[0, 1, 2, 3, 4].map((i) => <RoundedBox key={i} args={[0.2, 0.16, 0.3]} radius={0.03} smoothness={2} material={i === 0 ? m.led : m.accent} />)}
          </group>
        </group>
      ))}
    </group>
  );
}

function Bucket({ m }) {
  const geo = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(0, 0.02), new THREE.Vector2(0.48, 0.02), new THREE.Vector2(0.5, 0.06), new THREE.Vector2(0.64, 1.0), new THREE.Vector2(0.66, 1.02)
  ], 48), []);
  useEffect(() => () => geo.dispose(), [geo]);
  const files = [[-0.2, 0.2, 0.05], [0.05, -0.12, -0.1], [0.24, 0.15, 0.2], [-0.02, 0.1, -0.25]];
  return (
    <group>
      {files.map(([x, rz, z], i) => (
        <group key={i} position={[x, 1.02, z]} rotation={[0.1, i * 0.7, rz]}>
          <mesh material={m.paper}><boxGeometry args={[0.36, 0.5, 0.02]} /></mesh>
          <mesh position={[0, 0.16, 0.012]} material={m.led}><boxGeometry args={[0.24, 0.04, 0.004]} /></mesh>
        </group>
      ))}
      <mesh geometry={geo} material={m.funnel} />
      <mesh position={[0, 1.02, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}><torusGeometry args={[0.65, 0.035, 8, 48]} /></mesh>
      {[0.35, 0.7].map((y) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.dark}><torusGeometry args={[0.54 + y * 0.12, 0.018, 6, 48]} /></mesh>)}
    </group>
  );
}

function Ingots({ m }) {
  const geo = useMemo(() => ingotGeometry(), []);
  useEffect(() => () => geo.dispose(), [geo]);
  const spots = [[-0.42, 0.1, -0.3, 0], [0.42, 0.1, -0.3, 0], [-0.42, 0.1, 0.3, 0], [0.42, 0.1, 0.3, 0], [0, 0.3, -0.15, 0], [0, 0.3, 0.2, 0.08], [0, 0.5, 0.02, Math.PI / 2]];
  return (
    <group>
      {spots.map(([x, y, z, ry], i) => <mesh key={i} geometry={geo} position={[x, y, z]} rotation={[0, ry, 0]} material={m.precious} />)}
    </group>
  );
}

function DataCube({ m, anim }) {
  const inst = useRef();
  const N = 4;
  const S = 0.2;
  const G = 0.07;
  const cells = useMemo(() => {
    const out = [];
    for (let x = 0; x < N; x += 1) for (let y = 0; y < N; y += 1) for (let z = 0; z < N; z += 1) out.push([x, y, z, ((x * 7 + y * 3 + z * 5) % 11) === 0]);
    return out;
  }, []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const colors = useMemo(() => ({ ok: new THREE.Color(m.accent.color), fraud: new THREE.Color('#f43f5e') }), [m.accent.color]);
  useEffect(() => {
    cells.forEach((c, i) => inst.current.setColorAt(i, c[3] ? colors.fraud : colors.ok));
    inst.current.instanceColor.needsUpdate = true;
  }, [cells, colors]);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    const off = ((N - 1) * (S + G)) / 2;
    cells.forEach(([x, y, z], i) => {
      const wave = anim.inactive ? 1 : 0.82 + 0.18 * Math.sin(t * (anim.running ? 6 : 2) - (x + y + z) * 0.9);
      tmp.position.set(x * (S + G) - off, y * (S + G) + S / 2 + 0.06, z * (S + G) - off);
      tmp.scale.setScalar(wave);
      tmp.updateMatrix();
      inst.current.setMatrixAt(i, tmp.matrix);
    });
    inst.current.instanceMatrix.needsUpdate = true;
    if (!anim.inactive) inst.current.parent.rotation.y += 0.004;
  });
  return (
    <group>
      <instancedMesh ref={inst} args={[null, null, cells.length]}>
        <boxGeometry args={[S, S, S]} />
        <meshStandardMaterial metalness={0.2} roughness={0.35} transparent opacity={anim.dimmed ? 0.14 : 1} depthWrite={!anim.dimmed} />
      </instancedMesh>
    </group>
  );
}

function Gears({ m, anim }) {
  const big = useMemo(() => gearGeometry(12, 0.56, 0.46, 0.14), []);
  const small = useMemo(() => gearGeometry(8, 0.34, 0.25, 0.14), []);
  useEffect(() => () => { big.dispose(); small.dispose(); }, [big, small]);
  const a = useRef();
  const b = useRef();
  useFrame((_, dt) => {
    if (anim.inactive) return;
    const w = anim.running ? 1.8 : 0.45;
    if (a.current) a.current.rotation.z += dt * w;
    if (b.current) b.current.rotation.z -= dt * w * (12 / 8);
  });
  return (
    <group rotation={[0, -0.25, 0]}>
      <mesh position={[0, 0.06, 0]} material={m.chassis}><boxGeometry args={[1.5, 0.12, 0.5]} /></mesh>
      <mesh position={[-0.22, 0.45, -0.1]} material={m.metal}><boxGeometry args={[0.08, 0.8, 0.08]} /></mesh>
      <mesh ref={a} geometry={big} position={[-0.22, 0.86, 0]} material={m.metal} />
      <mesh position={[-0.22, 0.86, 0.09]} material={m.led}><cylinderGeometry args={[0.07, 0.07, 0.04, 20]} /></mesh>
      <mesh position={[0.56, 0.3, -0.1]} material={m.metal}><boxGeometry args={[0.07, 0.4, 0.07]} /></mesh>
      <mesh ref={b} geometry={small} position={[0.56, 0.62, 0]} rotation={[0, 0, 0.2]} material={m.accent} />
    </group>
  );
}

function Fan({ m, x, anim }) {
  const r = useRef();
  useFrame((_, dt) => { if (r.current && !anim.inactive) r.current.rotation.z += dt * (anim.running ? 22 : 3); });
  return (
    <group position={[x, 0, 0.12]}>
      <mesh material={m.metal}><torusGeometry args={[0.3, 0.025, 8, 40]} /></mesh>
      <mesh position={[0, 0, -0.01]} material={m.dark}><circleGeometry args={[0.3, 40]} /></mesh>
      <group ref={r}>
        {Array.from({ length: 9 }).map((_, i) => (
          <mesh key={i} rotation={[0.35, 0, (i * Math.PI * 2) / 9]} position={[0, 0, 0.01]} material={m.chassis}>
            <boxGeometry args={[0.06, 0.52, 0.01]} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0.02]} rotation={[Math.PI / 2, 0, 0]} material={m.accent}><cylinderGeometry args={[0.08, 0.08, 0.04, 24]} /></mesh>
      </group>
    </group>
  );
}

function Gpu({ m, anim }) {
  return (
    <group position={[0, 0.72, 0]} rotation={[-0.35, -0.12, 0]}>
      <RoundedBox args={[1.7, 0.86, 0.24]} radius={0.05} smoothness={3} material={m.chassis} />
      <Fan m={m} x={-0.42} anim={anim} />
      <Fan m={m} x={0.42} anim={anim} />
      <mesh position={[0, 0.405, 0.121]} material={m.led}><boxGeometry args={[1.5, 0.035, 0.01]} /></mesh>
      <mesh position={[0, -0.47, -0.04]} material={m.pcb}><boxGeometry args={[1.7, 0.1, 0.06]} /></mesh>
      {Array.from({ length: 12 }).map((_, i) => <mesh key={i} position={[-0.55 + i * 0.07, -0.53, -0.04]} material={m.goldPin}><boxGeometry args={[0.04, 0.05, 0.065]} /></mesh>)}
      <mesh position={[0.9, 0, -0.05]} material={m.metal}><boxGeometry args={[0.04, 0.96, 0.3]} /></mesh>
    </group>
  );
}

const ARC = [['#f43f5e', 0], ['#fbbf24', 1], ['#34d399', 2]];
function Gauge({ m, anim, meter }) {
  const needle = useRef();
  const arcs = useMemo(() => ARC.map(([c]) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true })), []);
  useEffect(() => () => arcs.forEach((x) => x.dispose()), [arcs]);
  useEffect(() => { arcs.forEach((x) => { x.opacity = anim.dimmed ? 0.14 : 1; }); }, [arcs, anim.dimmed]);
  useFrame((s) => {
    if (!needle.current) return;
    const v = anim.running ? 0.5 + 0.45 * Math.sin(s.clock.elapsedTime * 2.2) : meter ?? 0;
    const target = (Math.PI * 3) / 4 - v * (Math.PI * 1.5);
    needle.current.rotation.z = THREE.MathUtils.lerp(needle.current.rotation.z, target, 0.08);
  });
  return (
    <group>
      <mesh position={[0, 0.05, 0]} material={m.chassis}><cylinderGeometry args={[0.36, 0.42, 0.1, 40]} /></mesh>
      <mesh position={[0, 0.3, 0]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 0.42, 16]} /></mesh>
      <group position={[0, 0.98, 0]} rotation={[-0.15, 0, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} material={m.chassis}><cylinderGeometry args={[0.64, 0.64, 0.12, 56]} /></mesh>
        <mesh position={[0, 0, 0.061]} material={m.dark}><circleGeometry args={[0.57, 56]} /></mesh>
        <mesh position={[0, 0, 0.06]} rotation={[0, 0, 0]} material={m.metal}><torusGeometry args={[0.62, 0.03, 10, 64]} /></mesh>
        {ARC.map(([, i]) => (
          <mesh key={i} position={[0, 0, 0.066]} rotation={[0, 0, (Math.PI * 3) / 4 - (i + 1) * (Math.PI / 2)]} material={arcs[i]}>
            <torusGeometry args={[0.46, 0.035, 6, 32, Math.PI / 2 - 0.04]} />
          </mesh>
        ))}
        <group ref={needle} position={[0, 0, 0.08]}>
          <mesh position={[0, 0.2, 0]} material={m.statusLed}><boxGeometry args={[0.035, 0.42, 0.015]} /></mesh>
        </group>
        <mesh position={[0, 0, 0.085]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}><cylinderGeometry args={[0.06, 0.06, 0.03, 20]} /></mesh>
      </group>
    </group>
  );
}

function Chart({ m, anim, bars }) {
  const vals = bars?.length ? bars.slice(-5) : [0.35, 0.55, 0.45, 0.75, 0.62];
  const refs = useRef([]);
  useFrame((s) => {
    refs.current.forEach((b, i) => {
      if (!b) return;
      const v = Math.max(0.08, vals[i] ?? 0.1) * (anim.running ? 0.85 + 0.15 * Math.sin(s.clock.elapsedTime * 5 + i) : 1);
      b.scale.y = THREE.MathUtils.lerp(b.scale.y, v, 0.1);
      b.position.y = 0.1 + b.scale.y * 0.5;
    });
  });
  return (
    <group>
      <RoundedBox args={[1.4, 0.08, 0.9]} radius={0.03} smoothness={2} position={[0, 0.04, 0]} material={m.chassis} />
      <RoundedBox args={[1.4, 1.1, 0.05]} radius={0.03} smoothness={2} position={[0, 0.6, -0.42]} material={m.dark} />
      {[0.35, 0.6, 0.85].map((y) => <mesh key={y} position={[0, y, -0.39]} material={m.beam}><boxGeometry args={[1.25, 0.008, 0.005]} /></mesh>)}
      {vals.map((_, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }} position={[-0.5 + i * 0.25, 0.3, 0]} scale={[1, 0.4, 1]} material={i === vals.length - 1 ? m.led : m.accent}>
          <boxGeometry args={[0.16, 1, 0.16]} />
        </mesh>
      ))}
    </group>
  );
}

function Crates({ m, count }) {
  const n = Math.max(1, Math.min(3, count || 0));
  const spots = [[-0.32, 0.22, 0], [0.32, 0.22, 0.05], [0, 0.66, 0.02]].slice(0, n);
  return (
    <group>
      {spots.map(([x, y, z], i) => (
        <group key={i} position={[x, y, z]} rotation={[0, i * 0.18 - 0.1, 0]}>
          <RoundedBox args={[0.58, 0.42, 0.58]} radius={0.04} smoothness={2} material={count ? m.accent : m.chassis} />
          <mesh material={m.dark}><boxGeometry args={[0.6, 0.43, 0.08]} /></mesh>
          <mesh position={[0, 0.05, 0.296]} material={m.led}><planeGeometry args={[0.26, 0.12]} /></mesh>
        </group>
      ))}
    </group>
  );
}

const MODELS = { phone: Phone, monitor: Monitor, rack: Rack, chip: Chip, beacon: Beacon, dbstack: DbStack, funnel: Funnel, log: Log, bucket: Bucket, ingots: Ingots, datacube: DataCube, gears: Gears, gpu: Gpu, gauge: Gauge, chart: Chart, crates: Crates };

export function NodeModel({ kind, m, anim, node }) {
  const C = MODELS[kind] || Rack;
  return <C m={m} anim={anim} meter={node.meter} bars={node.bars} count={node.count} />;
}
