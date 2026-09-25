import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, RoundedBox, Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { STATUS, LAYERS, LANES, PLATFORM } from './graph.js';
import { NodeModel, modelKind, modelTop, useModelMaterials, shadowTexture } from './models.jsx';

const FLOW_COLOR = { hot: '#5b8cff', cold: '#ff8a3d', train: '#f5c542' };
const DECISION_COLOR = { COMPLETED: '#34d399', CHALLENGED: '#fbbf24', BLOCKED: '#f87171', FAILED: '#94a3b8' };

/* ---------- shared textures / materials ---------- */

let glowTexture = null;
function getGlow() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

function Glow({ color, scale = 2.4, opacity = 0.5, position = [0, 0, 0] }) {
  return (
    <sprite position={position} scale={[scale, scale, 1]}>
      <spriteMaterial map={getGlow()} color={color} transparent opacity={opacity} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

/* ---------- nodes: pedestal + realistic model ---------- */

const MODEL_Y = 0.3;

function Node({ node, selected, hovered, dimmed, onSelect, onHover }) {
  const group = useRef();
  const halo = useRef();
  const statusColor = STATUS[node.status]?.color ?? STATUS.gray.color;
  const baseColor = node.tint || LAYERS[node.layer]?.color || '#4f7cff';
  const inactive = node.status === 'gray';
  const running = node.status === 'blue';
  const phase = useMemo(() => (node.pos[0] * 0.37 + node.pos[2] * 0.21) % (Math.PI * 2), [node.pos]);
  const kind = modelKind(node);
  const m = useModelMaterials({ accent: baseColor, status: statusColor, dimmed, inactive, kind });
  const anim = useMemo(() => ({ running, inactive, dimmed }), [running, inactive, dimmed]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (group.current) {
      group.current.position.y = MODEL_Y + (inactive ? 0 : 0.05 + Math.sin(t * 1.2 + phase) * 0.05);
      const target = hovered || selected ? 1.1 : 1;
      group.current.scale.setScalar(THREE.MathUtils.lerp(group.current.scale.x, target, 0.15));
    }
    if (halo.current) {
      const pulse = running || node.status === 'yellow' ? 1 + Math.sin(t * 4) * 0.06 : 1;
      halo.current.scale.set(pulse, pulse, pulse);
    }
  });

  const handlers = {
    onClick: (e) => { e.stopPropagation(); onSelect(node.id); },
    onPointerOver: (e) => { e.stopPropagation(); onHover(node.id); document.body.style.cursor = 'pointer'; },
    onPointerOut: () => { onHover(null); document.body.style.cursor = ''; }
  };

  return (
    <group position={[node.pos[0], 0, node.pos[2]]}>
      {/* pedestal: brushed-metal plinth with a lit status ring */}
      <mesh position={[0, 0.11, 0]} material={m.dark}><cylinderGeometry args={[1.02, 1.12, 0.22, 56]} /></mesh>
      <mesh position={[0, 0.222, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.chassis}><circleGeometry args={[0.98, 56]} /></mesh>
      <mesh ref={halo} position={[0, 0.226, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.86, 0.96, 56]} />
        <meshBasicMaterial color={statusColor} transparent opacity={dimmed ? 0.1 : inactive ? 0.45 : 0.95} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.06, 0.018, 8, 72]} />
        <meshBasicMaterial color={statusColor} transparent opacity={dimmed ? 0.08 : inactive ? 0.25 : 0.8} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.228, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.7, 1.7]} />
        <meshBasicMaterial map={shadowTexture()} transparent opacity={dimmed ? 0.1 : 0.6} depthWrite={false} />
      </mesh>
      {!dimmed && <Glow color={statusColor} scale={running ? 3.4 : 2.6} opacity={inactive ? 0.05 : running ? 0.4 : 0.16} position={[0, 0.3, 0]} />}
      {selected && (
        <mesh position={[0, 0.23, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.2, 1.28, 64]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.9} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      )}
      {/* invisible hit volume so thin model parts are still easy to click */}
      <mesh position={[0, 0.9, 0]} {...handlers}>
        <cylinderGeometry args={[1.1, 1.1, 1.9, 16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
      <group ref={group} position={[0, MODEL_Y, 0]}>
        <NodeModel kind={kind} m={m} anim={anim} node={node} />
      </group>
    </group>
  );
}

/* ---------- edges: glowing tubes with flowing energy + comet particles ---------- */

const tubeVertex = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const tubeFragment = /* glsl */`
  uniform vec3 uColor; uniform float uTime; uniform float uActive; uniform float uOpacity; uniform float uRep; uniform float uSpeed; uniform float uDashed;
  varying vec2 vUv;
  void main() {
    float d = fract(vUv.x * uRep - uTime * uSpeed);
    float flow = smoothstep(0.0, 0.2, d) * smoothstep(0.75, 0.35, d);
    float stat = uDashed > 0.5 ? step(0.5, fract(vUv.x * uRep * 2.0)) : 1.0;
    float a = uOpacity * (uActive > 0.5 ? (0.28 + flow * 0.95) : 0.32 * stat);
    gl_FragColor = vec4(uColor * (1.0 + flow * uActive * 0.8), a);
  }
`;

function makeCurve(a, b) {
  const start = new THREE.Vector3(a[0], 0.55, a[2]);
  const end = new THREE.Vector3(b[0], 0.55, b[2]);
  const mid = start.clone().lerp(end, 0.5);
  const dist = start.distanceTo(end);
  mid.y += Math.min(3.2, 0.5 + dist * 0.16);
  return new THREE.QuadraticBezierCurve3(start, mid, end);
}

function Comet({ curve, color, offset, speed, size = 0.13 }) {
  const refs = useRef([]);
  const TRAIL = 5;
  useFrame((state) => {
    const t0 = (state.clock.elapsedTime * speed + offset) % 1;
    for (let i = 0; i < TRAIL; i += 1) {
      const s = refs.current[i];
      if (!s) continue;
      const t = t0 - i * 0.018;
      s.visible = t > 0;
      if (t > 0) s.position.copy(curve.getPoint(t));
    }
  });
  return Array.from({ length: TRAIL }).map((_, i) => (
    <sprite key={i} ref={(el) => { refs.current[i] = el; }} scale={[size * 4 * (1 - i * 0.16), size * 4 * (1 - i * 0.16), 1]}>
      <spriteMaterial map={getGlow()} color={i === 0 ? '#ffffff' : color} transparent opacity={i === 0 ? 1 : 0.75 - i * 0.13} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  ));
}

function Edge({ edge, curve, dimmed, emphasized, trainingActive }) {
  const color = edge.manual ? '#94a3b8' : FLOW_COLOR[edge.flow];
  const length = useMemo(() => curve.getLength(), [curve]);
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 48, emphasized ? 0.07 : 0.05, 8, false), [curve, emphasized]);
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uActive: { value: 0 }, uOpacity: { value: 1 },
    uRep: { value: Math.max(1, length / 1.4) }, uSpeed: { value: 0.8 }, uDashed: { value: 0 }
  }), [color, length]);
  const running = edge.running || (edge.flow === 'train' && trainingActive && edge.active);
  uniforms.uActive.value = edge.active ? 1 : 0;
  uniforms.uOpacity.value = dimmed ? 0.12 : emphasized ? 1 : edge.active ? 0.85 : 0.5;
  uniforms.uSpeed.value = running ? 2.2 : edge.flow === 'hot' ? 1.2 : 0.7;
  uniforms.uDashed.value = edge.manual || edge.optional ? 1 : 0;
  useFrame((state) => { uniforms.uTime.value = state.clock.elapsedTime; });
  useEffect(() => () => geo.dispose(), [geo]);

  const arrow = useMemo(() => {
    const t = 0.55;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(t).normalize());
    return { pos: curve.getPoint(t), q };
  }, [curve]);
  const comets = edge.active && !dimmed ? (running ? 3 : 2) : 0;
  const speed = (running ? 0.55 : edge.flow === 'hot' ? 0.4 : 0.22) * Math.min(1.6, 8 / length);

  return (
    <group>
      <mesh geometry={geo}>
        <shaderMaterial vertexShader={tubeVertex} fragmentShader={tubeFragment} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh position={arrow.pos} quaternion={arrow.q}>
        <coneGeometry args={[0.13, 0.34, 12]} />
        <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.15 : 0.9} toneMapped={false} />
      </mesh>
      {Array.from({ length: comets }).map((_, i) => (
        <Comet key={i} curve={curve} color={color} offset={i / comets} speed={speed} size={running ? 0.16 : 0.12} />
      ))}
    </group>
  );
}

/** A bright comet that follows the path a real transaction just took. */
function TracePulse({ curves, color, onDone }) {
  const refs = useRef([]);
  const start = useRef(null);
  const PER_SEGMENT = 0.7;
  const TRAIL = 8;
  useFrame((state) => {
    if (start.current == null) start.current = state.clock.elapsedTime;
    const elapsed = (state.clock.elapsedTime - start.current) / PER_SEGMENT;
    if (Math.floor(elapsed) >= curves.length) { onDone(); return; }
    for (let i = 0; i < TRAIL; i += 1) {
      const s = refs.current[i];
      if (!s) continue;
      const e = elapsed - i * 0.03;
      const seg = Math.floor(e);
      s.visible = e > 0 && seg < curves.length;
      if (s.visible) s.position.copy(curves[seg].getPoint(e - seg));
    }
  });
  return Array.from({ length: TRAIL }).map((_, i) => (
    <sprite key={i} ref={(el) => { refs.current[i] = el; }} scale={[1.1 * (1 - i * 0.1), 1.1 * (1 - i * 0.1), 1]}>
      <spriteMaterial map={getGlow()} color={i === 0 ? '#ffffff' : color} transparent opacity={1 - i * 0.11} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  ));
}

/* ---------- environment ---------- */

function Stars() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pts = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i += 1) {
      const r = 60 + Math.random() * 40;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI * 0.45;
      pts.set([r * Math.cos(th) * Math.sin(ph), 8 + r * Math.cos(ph), r * Math.sin(th) * Math.sin(ph)], i * 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return <points geometry={geo}><pointsMaterial color="#8fb3ff" size={0.18} sizeAttenuation transparent opacity={0.7} /></points>;
}

function Lanes({ bounds }) {
  const [x0, x1] = bounds;
  return LANES.map((lane) => (
    <group key={lane.id}>
      <mesh position={[(x0 + x1) / 2, 0.01, lane.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[x1 - x0, 3.6]} />
        <meshBasicMaterial color={lane.color} transparent opacity={0.05} depthWrite={false} />
      </mesh>
      {[-1.8, 1.8].map((dz) => (
        <mesh key={dz} position={[(x0 + x1) / 2, 0.02, lane.z + dz]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[x1 - x0, 0.04]} />
          <meshBasicMaterial color={lane.color} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      ))}
    </group>
  ));
}

function Platform({ node, selected, dimmed, onSelect, onHover }) {
  const [x0, x1, z0, z1] = PLATFORM;
  const edge = useRef();
  const outline = useMemo(() => new THREE.BoxGeometry(x1 - x0, 0.01, z1 - z0), [x0, x1, z0, z1]);
  useEffect(() => () => outline.dispose(), [outline]);
  const color = STATUS[node.status]?.color ?? '#64748b';
  useFrame((state) => { if (edge.current) edge.current.opacity = (selected ? 0.9 : 0.45) + Math.sin(state.clock.elapsedTime * 1.5) * 0.12; });
  return (
    <group position={[(x0 + x1) / 2, -0.12, (z0 + z1) / 2]}>
      <RoundedBox args={[x1 - x0, 0.22, z1 - z0]} radius={0.1} smoothness={2}
        onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
        onPointerOver={(e) => { e.stopPropagation(); onHover(node.id); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { onHover(null); document.body.style.cursor = ''; }}>
        <meshPhysicalMaterial color="#1a1016" emissive="#ff3621" emissiveIntensity={selected ? 0.12 : 0.035} roughness={0.55} metalness={0.4} transparent opacity={dimmed ? 0.2 : 0.55} />
      </RoundedBox>
      <lineSegments position={[0, 0.12, 0]}>
        <edgesGeometry args={[outline]} />
        <lineBasicMaterial ref={edge} color={selected ? '#ffffff' : '#ff5a36'} transparent />
      </lineSegments>
      <mesh position={[-(x1 - x0) / 2 + 0.6, 0.14, -(z1 - z0) / 2 + 0.6]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.22, 24]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ---------- labels (DOM overlay projected each frame) ---------- */

function LabelProjector({ anchors, els }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (const a of anchors) {
      const el = els.current[a.id];
      if (!el) continue;
      v.set(a.pos[0], a.pos[1], a.pos[2]).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { el.style.visibility = 'hidden'; continue; }
      el.style.visibility = '';
      const tx = a.align === 'left' ? '0' : a.align === 'right' ? '-100%' : '-50%';
      const ty = a.below ? '0' : a.middle ? '-50%' : '-100%';
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * size.width}px, ${(-v.y * 0.5 + 0.5) * size.height + (a.dy || 0)}px) translate(${tx}, ${ty})`;
    }
  });
  return null;
}

/* ---------- camera ---------- */

const VIEW_DIR = new THREE.Vector3(0, 1.25, 1).normalize();

function boundsOf(nodes, withPlatform, compact) {
  const b = new THREE.Box3();
  nodes.forEach((nd) => b.expandByPoint(new THREE.Vector3(nd.pos[0], 0, nd.pos[2])));
  if (withPlatform) { b.expandByPoint(new THREE.Vector3(PLATFORM[0], 0, PLATFORM[2])); b.expandByPoint(new THREE.Vector3(PLATFORM[1], 0, PLATFORM[3])); }
  b.expandByScalar(compact ? 2.4 : 1.4);
  if (!compact) b.min.x -= 2.6; // room for the "ingestion & lakehouse" title left of MongoDB
  return b;
}

function CameraRig({ controls, bounds, flyTo, compact }) {
  const { camera, size } = useThree();
  const anim = useRef(null);
  const fit = useMemo(() => {
    const center = bounds.getCenter(new THREE.Vector3());
    const sz = bounds.getSize(new THREE.Vector3());
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const aspect = size.width / size.height;
    // Tilted view: the floor depth is foreshortened by the view angle (sin of the elevation).
    const halfW = sz.x / 2;
    const halfH = (sz.z * 0.78) / 2 + (compact ? 1.6 : 1.4);
    const dist = Math.max(halfW / (t * aspect), halfH / t) * 1.02 + 2;
    return { center, pos: center.clone().addScaledVector(VIEW_DIR, dist) };
  }, [bounds, camera.fov, size.width, size.height, compact]);

  useEffect(() => {
    camera.position.copy(fit.pos);
    camera.lookAt(fit.center);
    if (controls.current) { controls.current.target.copy(fit.center); controls.current.update(); controls.current.saveState(); }
  }, [fit, camera, controls]);

  useEffect(() => {
    if (!flyTo) return;
    const target = flyTo === 'home' ? fit.center.clone() : new THREE.Vector3(flyTo[0], 0.8, flyTo[2]);
    const pos = flyTo === 'home' ? fit.pos.clone() : target.clone().add(new THREE.Vector3(0, 7.5, 8.5));
    anim.current = { fromP: camera.position.clone(), fromT: controls.current?.target.clone() ?? fit.center.clone(), toP: pos, toT: target, t: 0 };
  }, [flyTo, fit, camera, controls]);

  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls.current) return;
    a.t = Math.min(1, a.t + dt / 1.1);
    const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
    camera.position.lerpVectors(a.fromP, a.toP, e);
    controls.current.target.lerpVectors(a.fromT, a.toT, e);
    controls.current.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

/* ---------- scene ---------- */

function SceneContents({ nodes, edges, platform, selected, hovered, focus, onSelect, onHover, trainingActive, traces, onTraceDone, showLanes, bounds }) {
  const byId = useMemo(() => Object.fromEntries(nodes.map((nd) => [nd.id, nd])), [nodes]);
  const layoutKey = nodes.map((nd) => `${nd.id}:${nd.pos.join(',')}`).join('|');
  const curves = useMemo(() => {
    const out = {};
    for (const e of edges) if (byId[e.from] && byId[e.to]) out[`${e.from}>${e.to}`] = makeCurve(byId[e.from].pos, byId[e.to].pos);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, edges.length]);

  const connected = useMemo(() => {
    if (!selected || selected === 'databricks') return null;
    const s = new Set([selected]);
    edges.forEach((e) => { if (e.from === selected) s.add(e.to); if (e.to === selected) s.add(e.from); });
    return s;
  }, [selected, edges]);
  const inFocus = (e) => focus === 'all' || e.flow === focus;
  const nodeInFocus = (nd) => focus === 'all' || nd.lane === focus || edges.some((e) => e.flow === focus && (e.from === nd.id || e.to === nd.id));

  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#b9ccff', '#1b1533', 0.55]} />
      <directionalLight position={[8, 18, 12]} intensity={1.6} color="#fff6ea" />
      <directionalLight position={[-12, 8, -6]} intensity={0.5} color="#8fb3ff" />
      <pointLight position={[-12, 6, -8]} intensity={30} color="#7c5cf6" distance={40} />
      <pointLight position={[10, 5, 6]} intensity={22} color="#ff7a45" distance={30} />
      {/* studio environment (no network): gives metals and glass real reflections */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.4} color="#e6eeff" position={[0, 14, 0]} rotation-x={Math.PI / 2} scale={[40, 40, 1]} />
        <Lightformer form="rect" intensity={1.6} color="#7f9dff" position={[-18, 5, 4]} rotation-y={Math.PI / 2} scale={[24, 6, 1]} />
        <Lightformer form="rect" intensity={1.3} color="#ffb48a" position={[18, 5, -4]} rotation-y={-Math.PI / 2} scale={[24, 6, 1]} />
        <Lightformer form="ring" intensity={2.2} color="#ffffff" position={[0, 7, 18]} scale={8} />
      </Environment>
      <Stars />
      <mesh position={[0, -0.27, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[160, 160]} />
        <meshStandardMaterial color="#10203f" metalness={0.35} roughness={0.78} />
      </mesh>
      <gridHelper args={[80, 80, '#2a4478', '#182a4d']} position={[0, -0.25, 0]} />
      {showLanes && <Lanes bounds={[bounds.min.x, bounds.max.x]} />}
      {platform && <Platform node={platform} selected={selected === 'databricks'} dimmed={Boolean(connected) || (focus !== 'all' && focus === 'hot')} onSelect={onSelect} onHover={onHover} />}

      {edges.map((e) => {
        const key = `${e.from}>${e.to}`;
        if (!curves[key]) return null;
        const touches = Boolean(connected) && (e.from === selected || e.to === selected);
        return <Edge key={key} edge={e} curve={curves[key]} dimmed={(connected && !touches) || !inFocus(e)} emphasized={touches} trainingActive={trainingActive} />;
      })}

      {nodes.map((nd) => (
        <Node key={nd.id} node={nd} selected={selected === nd.id} hovered={hovered === nd.id}
          dimmed={(connected && !connected.has(nd.id)) || !nodeInFocus(nd)} onSelect={onSelect} onHover={onHover} />
      ))}

      {traces.map((t) => (
        <TracePulse key={t.key} color={t.color} curves={t.path.map((k) => curves[k]).filter(Boolean)} onDone={() => onTraceDone(t.key)} />
      ))}
    </>
  );
}

const Scene3D = forwardRef(function Scene3D(props, ref) {
  const controls = useRef();
  const labelEls = useRef({});
  const [hovered, setHovered] = useState(null);
  const [traces, setTraces] = useState([]);
  const [flyTo, setFlyTo] = useState(null);
  const lastSeen = useRef(undefined);
  const { nodes, edges, selected, focus = 'all', platform, compact, showLanes } = props;
  const bounds = useMemo(() => boundsOf(nodes, Boolean(platform), compact),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes.map((nd) => nd.pos.join(',')).join('|'), Boolean(platform), compact]);
  const connected = selected && selected !== 'databricks' ? new Set([selected, ...edges.filter((e) => e.from === selected || e.to === selected).flatMap((e) => [e.from, e.to])]) : null;
  const nodeInFocus = (nd) => focus === 'all' || nd.lane === focus || edges.some((e) => e.flow === focus && (e.from === nd.id || e.to === nd.id));

  useEffect(() => () => { document.body.style.cursor = ''; }, []);
  useImperativeHandle(ref, () => ({
    resetView: () => setFlyTo('home'),
    focusNode: (id) => { const nd = nodes.find((x) => x.id === id); if (nd) setFlyTo([...nd.pos]); }
  }), [nodes]);

  // Turn each real transaction event into a pulse along the path it actually took.
  const { lastEvent, engineUp } = props;
  useEffect(() => {
    if (lastSeen.current === undefined) { lastSeen.current = lastEvent?.txId ?? null; return; }
    if (!lastEvent?.txId || lastEvent.txId === lastSeen.current) return;
    lastSeen.current = lastEvent.txId;
    const color = DECISION_COLOR[lastEvent.status] || '#60a5fa';
    const path = engineUp ? ['user-app>api', 'api>fraud-engine', 'fraud-engine>alerts', 'alerts>admin-app'] : ['user-app>api', 'api>mongo'];
    setTraces((prev) => [...prev, { key: `${lastEvent.txId}-${Date.now()}`, color, path }, { key: `${lastEvent.txId}-db-${Date.now()}`, color, path: ['api>mongo'] }].slice(-8));
  }, [lastEvent, engineUp]);

  const anchors = useMemo(() => {
    // Alternate neighbours are lifted in screen space so their labels never overlap.
    const a = nodes.map((nd) => ({ id: nd.id, pos: [nd.pos[0], MODEL_Y + 0.12 + modelTop(modelKind(nd)), nd.pos[2]], dy: nd.lift ? -42 : -6 }));
    if (showLanes && !compact) {
      LANES.forEach((l) => a.push({ id: `lane:${l.id}`, pos: [l.tag.x, 0.3, l.z], align: l.tag.align, middle: true }));
    }
    // Platform title on its front-left corner, clear of the node labels.
    if (platform) a.push({ id: 'databricks', pos: [PLATFORM[0] + 0.3, 0.1, PLATFORM[3] - 0.2], align: 'left', below: true });
    return a;
  }, [nodes, showLanes, compact, bounds, platform]);

  return (
    <div className={`arch3d-wrap ${compact ? 'compact' : ''}`}>
      <Canvas camera={{ position: [0, 20, 22], fov: 42 }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: 'low-power' }}
        onPointerMissed={() => props.onSelect(null)}>
        <color attach="background" args={['#0c1a36']} />
        <fog attach="fog" args={['#0c1a36', 50, 120]} />
        <SceneContents {...props} focus={focus} hovered={hovered} onHover={setHovered} traces={traces} bounds={bounds}
          onTraceDone={(k) => setTraces((prev) => prev.filter((t) => t.key !== k))} />
        <OrbitControls ref={controls} enableDamping dampingFactor={0.08} minDistance={5} maxDistance={90} maxPolarAngle={Math.PI * 0.47} />
        <CameraRig controls={controls} bounds={bounds} flyTo={flyTo} compact={compact} />
        <LabelProjector anchors={anchors} els={labelEls} />
      </Canvas>
      <div className="arch3d-labels" aria-hidden="true">
        {showLanes && !compact && LANES.map((l) => (
          <div key={l.id} ref={(el) => { labelEls.current[`lane:${l.id}`] = el; }} className={`lane-tag ${l.tag.align} ${focus !== 'all' && focus !== l.id ? 'dim' : ''}`} style={{ '--lane': l.color }}>
            <b>{l.dir > 0 ? '→' : '←'} {l.label}</b><span>{l.sub}</span>
          </div>
        ))}
        {platform && (
          <div ref={(el) => { labelEls.current.databricks = el; }} className={`platform-tag ${selected === 'databricks' ? 'sel' : ''}`}>
            <span className="dot" style={{ background: STATUS[platform.status]?.color }} /> {platform.label} · {platform.statusLabel}
          </div>
        )}
        {nodes.map((nd) => {
          const dim = (connected && !connected.has(nd.id)) || !nodeInFocus(nd);
          const color = STATUS[nd.status]?.color ?? STATUS.gray.color;
          const open = hovered === nd.id || selected === nd.id;
          return (
            <div key={nd.id} ref={(el) => { labelEls.current[nd.id] = el; }}
              className={`arch3d-label ${nd.lift ? 'lift' : ''} ${dim ? 'dim' : ''} ${selected === nd.id ? 'sel' : ''} ${compact ? 'sm' : ''}`}>
              <div className="l-top">
                {nd.step != null && <span className="step" style={{ background: LANES.find((l) => l.id === nd.lane)?.color }}>{nd.step}</span>}
                <span className="dot" style={{ background: color }} /><span className="nm">{nd.label}</span>
              </div>
              {(open || nd.value) && <div className="sub">{open ? nd.statusLabel : nd.value}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default Scene3D;
