import * as THREE from 'three';

/* ==========================================================================
   MAESTRO MAYHEM
   A 2.5D fighting game. Single self-contained file. Modules below:
     PALETTE / NOTES ............ colour + music constants
     AUDIO ...................... Web Audio synth (timbres, sfx, metronome)
     INPUT & MOTIF PARSER ....... key -> note; rolling buffer; motif matching
     FIGHTER DATA ............... roster stats, motifs, finales, AI personas
     FIGHTER FACTORY ............ procedural ink figurines from primitives
     STAGE ...................... manuscript world, staff ridges, dressing
     VFX ........................ pooled particles (notes, ink, shockwave)
     CAMERA DIRECTOR ............ side-view framing + cinematic moves
     AI ......................... state machine emitting the same note inputs
     FIGHT ...................... combat rules, hitboxes, rounds, finale
     ENGINE / LOOP + UI ......... screens, flow, render loop
   MOTIF-MATCHING: every key press pushes {note,time} to a per-fighter buffer.
     After each press we test the buffer tail against each motif pattern (array
     of note names); a match whose notes all fall within a 2s window fires the
     special. Simultaneous presses (<40ms apart) are grouped into a chord for
     block/parry instead. See InputParser + Fight.tryMotif.
   CAMERA-DIRECTOR: a small state machine. Default state frames both fighters
     (midpoint + distance -> dolly/zoom with easing). Cinematic states
     (intro-orbit, parry-punch, finale-orbit, ko) temporarily seize control,
     lerp toward scripted offsets, then release back to FRAME. See CameraDir.
   ========================================================================== */

/* ============================ PALETTE / NOTES ============================ */
const COL = {
  paper:0xF2E8D5, stain:0xE0D3B8, sepia:0x4A3B2A, ink:0x1A1511,
  gold:0xC9962E, verm:0xD4472B, dissonance:0x7A7A28,
  crimson:0x8E2C2C, blue:0x2C4A8E, green:0x2C5E3F, violet:0x5E2C6E,
  night:0x1A1511, cream:0xF2E8D5
};
// Note frequencies, C4..B4 (natural notes only, the 7 attack inputs)
const FREQ = { C:261.63, D:293.66, E:329.63, F:349.23, G:392.00, A:440.00, B:493.88 };
const NOTE_ORDER = ['C','D','E','F','G','A','B'];
const NOTE_SEMITONE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }; // for interval math
// hit height by pitch: low notes low, high notes high
function noteHeight(n){ if(n==='C'||n==='D') return 'low'; if(n==='A'||n==='B') return 'high'; return 'mid'; }
// consonant triads (block) and perfect-fifth pairs (parry)
const TRIADS = [['C','E','G'],['F','A','C'],['G','B','D']];
function isTriad(set){ return TRIADS.some(t=>t.every(n=>set.has(n)) && set.size===3); }
function isFifth(set){
  if(set.size!==2) return false;
  const arr=[...set].map(n=>NOTE_SEMITONE[n]).sort((a,b)=>a-b);
  const iv=(arr[1]-arr[0]+12)%12; return iv===7||iv===5; // fifth or its inversion (fourth)
}
// dissonance terminator test: motif ending F->B (tritone) or E->F (semitone)
function endsDissonant(seq){
  if(seq.length<2) return false;
  const a=seq[seq.length-2], b=seq[seq.length-1];
  return (a==='F'&&b==='B')||(a==='E'&&b==='F');
}

/* ================================ AUDIO ================================= */
const Audio = (() => {
  let ctx=null, master=null, muted=false, room=null;
  const timbres = {}; // per-fighter oscillator config
  function init(){
    if(ctx) return;
    ctx = new (window.AudioContext||window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    // quiet concert-hall room tone: filtered noise
    const buf = ctx.createBuffer(1, ctx.sampleRate*2, ctx.sampleRate);
    const d = buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1);
    room = ctx.createBufferSource(); room.buffer=buf; room.loop=true;
    const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=380;
    const rg=ctx.createGain(); rg.gain.value=0.012;
    room.connect(lp); lp.connect(rg); rg.connect(master); room.start();
  }
  function resume(){ if(ctx && ctx.state==='suspended') ctx.resume(); }
  function setMuted(m){ muted=m; if(master) master.gain.setTargetAtTime(m?0:0.55, ctx.currentTime, 0.02); }
  // pan by stage x position (-8..8) -> (-1..1)
  function panFor(x){ return Math.max(-1,Math.min(1, (x||0)/8)); }

  // core voice: play a frequency in a fighter's timbre
  function voice(freq, timbre, {dur=0.32, gain=0.5, pan=0, when=0}={}){
    if(!ctx) return;
    const t = ctx.currentTime + when;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const out = ctx.createGain(); out.gain.value=0;
    const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value= timbre.cutoff||4000;
    out.connect(p); p.connect(master); filt.connect(out);
    const oscs=[];
    const layers = timbre.layers||[{type:'sawtooth',detune:0,g:1}];
    for(const L of layers){
      const o=ctx.createOscillator(); o.type=L.type; o.frequency.value=freq*(L.mul||1); o.detune.value=L.detune||0;
      const g=ctx.createGain(); g.gain.value=(L.g||1);
      o.connect(g); g.connect(filt); o.start(t); oscs.push(o);
    }
    const atk=timbre.attack||0.006, rel=timbre.release||0.22, peak=gain*(timbre.vol||1);
    out.gain.setValueAtTime(0,t);
    out.gain.linearRampToValueAtTime(peak, t+atk);
    out.gain.exponentialRampToValueAtTime(0.0008, t+dur+rel);
    const stop=t+dur+rel+0.05;
    oscs.forEach(o=>o.stop(stop));
  }
  function noteName(name, timbre, opts={}){ if(FREQ[name]) voice(FREQ[name]*(opts.oct? Math.pow(2,opts.oct):1), timbre, opts); }

  // percussive thump for landed hits
  function thump(pan=0, strong=false){
    if(!ctx) return; const t=ctx.currentTime;
    const o=ctx.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(strong?150:110,t); o.frequency.exponentialRampToValueAtTime(40,t+0.14);
    const g=ctx.createGain(); g.gain.setValueAtTime(strong?0.7:0.45,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.18);
    const p=ctx.createStereoPanner(); p.pan.value=pan;
    o.connect(g); g.connect(p); p.connect(master); o.start(t); o.stop(t+0.2);
  }
  // metronome woodblock tick
  function tick(){
    if(!ctx) return; const t=ctx.currentTime;
    const o=ctx.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(1500,t); o.frequency.exponentialRampToValueAtTime(700,t+0.03);
    const g=ctx.createGain(); g.gain.setValueAtTime(0.14,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.05);
    o.connect(g); g.connect(master); o.start(t); o.stop(t+0.06);
  }
  // block: muted palm note
  function block(pan=0){ if(!ctx)return; voice(180,{layers:[{type:'sine'}],attack:0.002,release:0.05,vol:0.8,cutoff:600},{dur:0.06,gain:0.4,pan}); thump(pan,false); }
  // parry: note + perfect fifth, long bright ring
  function parry(pan=0){
    if(!ctx)return; const base=FREQ.C*2;
    voice(base,{layers:[{type:'triangle'},{type:'sine',mul:1.5,g:0.7}],attack:0.002,release:1.2,vol:1,cutoff:6000},{dur:0.5,gain:0.5,pan});
  }
  // dissonance: tritone clash with detune wobble
  function dissonance(pan=0){
    if(!ctx)return; const t=ctx.currentTime;
    [FREQ.F, FREQ.B].forEach((f,i)=>{
      const o=ctx.createOscillator(); o.type='sawtooth'; o.frequency.value=f;
      const lfo=ctx.createOscillator(); lfo.frequency.value=6; const lg=ctx.createGain(); lg.gain.value=14;
      lfo.connect(lg); lg.connect(o.detune); lfo.start(t); lfo.stop(t+0.6);
      const g=ctx.createGain(); g.gain.setValueAtTime(0.28,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.55);
      const p=ctx.createStereoPanner(); p.pan.value=pan;
      o.connect(g); g.connect(p); p.connect(master); o.start(t); o.stop(t+0.6);
    });
  }
  function timpaniRoll(){
    if(!ctx)return; const t=ctx.currentTime;
    for(let i=0;i<10;i++){ const tt=t+i*0.05;
      const o=ctx.createOscillator(); o.type='sine'; o.frequency.value=70+Math.random()*8;
      const g=ctx.createGain(); g.gain.setValueAtTime(0.0,tt); g.gain.linearRampToValueAtTime(0.3*(i/10),tt+0.02); g.gain.exponentialRampToValueAtTime(0.001,tt+0.1);
      o.connect(g); g.connect(master); o.start(tt); o.stop(tt+0.12);
    }
  }
  function cymbal(){
    if(!ctx)return; const t=ctx.currentTime;
    const buf=ctx.createBuffer(1,ctx.sampleRate*1.2,ctx.sampleRate); const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.5);
    const s=ctx.createBufferSource(); s.buffer=buf; const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=5000;
    const g=ctx.createGain(); g.gain.value=0.3; s.connect(hp); hp.connect(g); g.connect(master); s.start(t);
  }
  // synthesized cannon (Tchaikovsky finale): filtered noise burst + 50Hz thump
  function cannon(pan=0){
    if(!ctx)return; const t=ctx.currentTime;
    const buf=ctx.createBuffer(1,ctx.sampleRate*0.5,ctx.sampleRate); const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    const s=ctx.createBufferSource(); s.buffer=buf; const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=900;
    const g=ctx.createGain(); g.gain.value=0.6; const p=ctx.createStereoPanner(); p.pan.value=pan;
    s.connect(lp); lp.connect(g); g.connect(p); p.connect(master); s.start(t);
    const o=ctx.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(50,t); o.frequency.exponentialRampToValueAtTime(30,t+0.3);
    const og=ctx.createGain(); og.gain.setValueAtTime(0.8,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.4);
    o.connect(og); og.connect(p); o.start(t); o.stop(t+0.42);
  }
  // choir/string pad swell (used for finales, dark harmonization)
  function pad(freqs, {dur=2.5, gain=0.16, type='sine'}={}){
    if(!ctx)return; const t=ctx.currentTime;
    freqs.forEach(f=>{ const o=ctx.createOscillator(); o.type=type; o.frequency.value=f; o.detune.value=(Math.random()*10-5);
      const g=ctx.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(gain,t+0.8); g.gain.linearRampToValueAtTime(0.0001,t+dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t+dur+0.1);
    });
  }
  return { init, resume, setMuted, isMuted:()=>muted, voice, noteName, thump, tick, block, parry,
           dissonance, timpaniRoll, cymbal, cannon, pad, panFor, ctx:()=>ctx };
})();

/* ============================ FIGHTER DATA ============================== */
// Each motif is an array of note names. Masterwork = finale motif. Timbre =
// Audio layer config. AI persona tunes the state machine aggression/rhythm.
const ROSTER = [
  {
    id:'beethoven', name:'Beethoven', accent:COL.crimson, accentHex:'#8E2C2C',
    blurb:'Brawler. Heavy fists, rising fury.',
    timbre:{ layers:[{type:'sawtooth',detune:-8},{type:'sawtooth',detune:8,g:0.8}], attack:0.008, release:0.3, vol:1, cutoff:2600 },
    specials:[
      { key:'fate',  name:'Fate Knock',  notes:['G','G','G','E'], type:'rush',   dmg:14 },
      { key:'ode',   name:'Ode Rising',  notes:['E','E','F','G'], type:'launcher',dmg:12 },
    ],
    finale:{ name:'Ninth Storm', notes:['G','G','G','E','E','F','G','G','F','E','D'], dmg:42 },
    ai:{ aggression:0.9, prefers:'fate', rhythm:0.6 }
  },
  {
    id:'mozart', name:'Mozart', accent:COL.blue, accentHex:'#2C4A8E',
    blurb:'Rushdown. Fast staccato pokes.',
    timbre:{ layers:[{type:'square'}], attack:0.003, release:0.14, vol:0.85, cutoff:5200 },
    specials:[
      { key:'nacht', name:'Kleine Nacht Strike', notes:['G','D','G','B'], type:'multipoke', dmg:11 },
      { key:'turca', name:'Rondo Turca',         notes:['B','A','B','A','B'], type:'crossup', dmg:10 },
    ],
    finale:{ name:'Requiem Veil', notes:['D','E','F','E','D','E','F','D'], dmg:38 },
    ai:{ aggression:0.85, prefers:'nacht', rhythm:0.7 }
  },
  {
    id:'bach', name:'Bach', accent:COL.green, accentHex:'#2C5E3F',
    blurb:'Zoner / counter-master.',
    timbre:{ layers:[{type:'sine'},{type:'triangle',g:0.6,mul:2}], attack:0.05, release:0.4, vol:0.9, cutoff:3200 },
    specials:[
      { key:'toccata', name:'Toccata Bolt', notes:['A','G','A','G','F','E','D'], type:'projectile', dmg:12 },
      { key:'fugue',   name:'Fugue Mirror', notes:['C','E','G','C'], type:'counter', dmg:16 },
    ],
    finale:{ name:'Grand Fugue', notes:['A','G','A','G','F','E','D','C'], dmg:40 },
    ai:{ aggression:0.5, prefers:'toccata', rhythm:0.75 }
  },
  {
    id:'tchaikovsky', name:'Tchaikovsky', accent:COL.violet, accentHex:'#5E2C6E',
    blurb:'Heavy stage-controller.',
    timbre:{ layers:[{type:'sawtooth',detune:-6},{type:'sawtooth',detune:7,g:0.7},{type:'triangle',g:0.4,mul:0.5}], attack:0.02, release:0.5, vol:0.95, cutoff:2400 },
    specials:[
      { key:'swan',  name:'Swan Cutter',     notes:['A','B','C','B','A'], type:'sweep',    dmg:13 },
      { key:'sugar', name:'Sugar Plum Step', notes:['E','D','E','C'],     type:'teleport', dmg:9  },
    ],
    finale:{ name:'1812 Overture', notes:['C','F','E','D','C','G','C','G'], dmg:44 },
    ai:{ aggression:0.65, prefers:'swan', rhythm:0.68 }
  },
];
function fighterById(id){ return ROSTER.find(f=>f.id===id); }
const DIFFICULTIES = [
  { id:'andante',  name:'Andante',  react:0.9,  offbeat:0.35, mistake:0.35, parryChance:0.05 },
  { id:'moderato', name:'Moderato', react:0.55, offbeat:0.18, mistake:0.15, parryChance:0.18 },
  { id:'presto',   name:'Presto',   react:0.28, offbeat:0.06, mistake:0.04, parryChance:0.42 },
];

/* ============================ FIGHTER FACTORY =========================== */
// Build a glossy-black-ink figurine from primitives. Returns a group with
// named sub-parts we animate procedurally (no bones).
const _geoCache = {};
function geo(key, make){ if(!_geoCache[key]) _geoCache[key]=make(); return _geoCache[key]; }
const inkMat = new THREE.MeshPhysicalMaterial({ color:COL.ink, roughness:0.18, metalness:0.1, clearcoat:1, clearcoatRoughness:0.15 });

function makeFighter(data){
  const g = new THREE.Group();
  const accentMat = new THREE.MeshStandardMaterial({ color:data.accent, roughness:0.4, metalness:0.2, emissive:data.accent, emissiveIntensity:0.25 });

  // torso (capsule)
  const torso = new THREE.Mesh(geo('torso',()=>new THREE.CapsuleGeometry(0.42,0.9,6,14)), inkMat);
  torso.position.y=1.35; torso.castShadow=true; g.add(torso);
  // coat flare (cone) — gives silhouette weight
  const coat = new THREE.Mesh(geo('coat',()=>new THREE.ConeGeometry(0.72,1.1,16,1,true)), inkMat);
  coat.position.y=0.95; coat.castShadow=true; g.add(coat);
  // cravat/detail in accent color
  const cravat = new THREE.Mesh(geo('cravat',()=>new THREE.ConeGeometry(0.2,0.34,8)), accentMat);
  cravat.position.set(0,1.72,0.34); cravat.rotation.x=0.3; g.add(cravat);

  // head
  const head = new THREE.Mesh(geo('head',()=>new THREE.SphereGeometry(0.34,18,16)), inkMat);
  head.position.y=2.1; head.castShadow=true; g.add(head);

  // hair/wig — distinct per fighter for readable silhouette
  const hair = new THREE.Group(); hair.position.y=2.2; g.add(hair);
  if(data.id==='beethoven'){
    // wild swept-back noise-displaced clumps
    for(let i=0;i<9;i++){
      const s=new THREE.Mesh(geo('bhair',()=>new THREE.SphereGeometry(0.17,8,8)), inkMat);
      const a=(i/9)*Math.PI - Math.PI/2;
      s.position.set(Math.sin(a)*0.28, 0.12+Math.random()*0.16, -0.12-Math.cos(a)*0.18);
      s.scale.set(1+Math.random()*0.5,1+Math.random()*0.6,1.2+Math.random()*0.6);
      hair.add(s);
    }
  } else if(data.id==='mozart'){
    // powdered wig with side rolls
    const cap=new THREE.Mesh(geo('mcap',()=>new THREE.SphereGeometry(0.36,14,12,0,Math.PI*2,0,Math.PI*0.6)), inkMat);
    cap.position.y=0.06; hair.add(cap);
    [-1,1].forEach(s=>{ const roll=new THREE.Mesh(geo('mroll',()=>new THREE.TorusGeometry(0.11,0.07,8,12)), inkMat);
      roll.position.set(0.34*s,-0.05,0); roll.rotation.y=Math.PI/2; hair.add(roll); });
    const tail=new THREE.Mesh(geo('mtail',()=>new THREE.CapsuleGeometry(0.06,0.3,4,8)), inkMat);
    tail.position.set(0,-0.05,-0.32); hair.add(tail);
  } else if(data.id==='bach'){
    // formal curled wig
    const cap=new THREE.Mesh(geo('bacap',()=>new THREE.SphereGeometry(0.38,14,12,0,Math.PI*2,0,Math.PI*0.7)), inkMat);
    cap.position.y=0.04; hair.add(cap);
    for(let i=0;i<6;i++){ const c=new THREE.Mesh(geo('bacurl',()=>new THREE.TorusGeometry(0.09,0.05,6,10)), inkMat);
      const a=(i/6)*Math.PI*2; c.position.set(Math.cos(a)*0.3,-0.18-Math.abs(Math.sin(a))*0.1,Math.sin(a)*0.24); hair.add(c); }
  } else {
    // Tchaikovsky: fuller hair + big beard
    const cap=new THREE.Mesh(geo('tcap',()=>new THREE.SphereGeometry(0.36,14,12,0,Math.PI*2,0,Math.PI*0.55)), inkMat);
    cap.position.y=0.08; hair.add(cap);
    const beard=new THREE.Mesh(geo('tbeard',()=>new THREE.ConeGeometry(0.26,0.5,12)), inkMat);
    beard.position.set(0,-0.42,0.16); beard.rotation.x=Math.PI; g.add(beard); beard.position.y=1.78;
  }

  // arms (capsules) — pivot groups at shoulders
  function makeArm(side){
    const pivot=new THREE.Group(); pivot.position.set(0.46*side,1.72,0);
    const upper=new THREE.Mesh(geo('arm',()=>new THREE.CapsuleGeometry(0.13,0.7,5,10)), inkMat);
    upper.position.y=-0.42; upper.castShadow=true; pivot.add(upper);
    const fist=new THREE.Mesh(geo('fist',()=>new THREE.SphereGeometry(0.17,10,10)), inkMat);
    fist.position.y=-0.82; pivot.add(fist);
    // accent cuff
    const cuff=new THREE.Mesh(geo('cuff',()=>new THREE.TorusGeometry(0.14,0.05,6,10)), accentMat);
    cuff.position.y=-0.72; cuff.rotation.x=Math.PI/2; pivot.add(cuff);
    g.add(pivot); return pivot;
  }
  const armL=makeArm(-1), armR=makeArm(1);
  armL.rotation.x=0.3; armR.rotation.x=0.3;

  // legs
  function makeLeg(side){
    const pivot=new THREE.Group(); pivot.position.set(0.2*side,0.9,0);
    const leg=new THREE.Mesh(geo('leg',()=>new THREE.CapsuleGeometry(0.15,0.7,5,10)), inkMat);
    leg.position.y=-0.42; leg.castShadow=true; pivot.add(leg);
    g.add(pivot); return pivot;
  }
  const legL=makeLeg(-1), legR=makeLeg(1);

  g.userData.parts = { torso, coat, head, hair, cravat, armL, armR, legL, legR };
  g.scale.setScalar(0.62);
  return g;
}

/* ================================ STAGE ================================= */
function buildStage(scene){
  const grp=new THREE.Group(); scene.add(grp);
  // giant sheet of manuscript paper (the ground plane), warm cream
  const paperMat=new THREE.MeshStandardMaterial({ color:COL.paper, roughness:0.95, metalness:0 });
  const paper=new THREE.Mesh(new THREE.PlaneGeometry(200,90), paperMat);
  paper.rotation.x=-Math.PI/2; paper.receiveShadow=true; grp.add(paper);
  // coffee-ring stain patches
  const stainMat=new THREE.MeshStandardMaterial({ color:COL.stain, roughness:1, transparent:true, opacity:0.5 });
  for(let i=0;i<7;i++){
    const r=1.5+Math.random()*3;
    const ring=new THREE.Mesh(new THREE.RingGeometry(r*0.7,r,24), stainMat);
    ring.rotation.x=-Math.PI/2; ring.position.set((Math.random()-0.5)*40,0.01,-4-Math.random()*20); grp.add(ring);
  }
  // staff-line ridges: raised sepia ink lines. Duel line is middle; two behind, two front.
  const ridgeMat=new THREE.MeshStandardMaterial({ color:COL.sepia, roughness:0.6, metalness:0.05 });
  const ridgeZ=[-6,-3,0,3,6];
  ridgeZ.forEach(z=>{
    const ridge=new THREE.Mesh(new THREE.BoxGeometry(180,0.14,0.16), ridgeMat);
    ridge.position.set(0,0.07,z); ridge.castShadow=true; ridge.receiveShadow=true; grp.add(ridge);
  });
  grp.userData.ridgeZ = ridgeZ;

  // metronome obelisk, stage-center background, swinging pendulum
  const metro=new THREE.Group(); metro.position.set(0,0,-14); grp.add(metro);
  const body=new THREE.Mesh(new THREE.ConeGeometry(1.4,5,4), new THREE.MeshStandardMaterial({color:COL.sepia,roughness:0.5}));
  body.position.y=2.5; body.castShadow=true; metro.add(body);
  const penPivot=new THREE.Group(); penPivot.position.set(0,4.4,0.5); metro.add(penPivot);
  const rod=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,3.6), new THREE.MeshStandardMaterial({color:COL.ink}));
  rod.position.y=-1.6; penPivot.add(rod);
  const bob=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.3), new THREE.MeshStandardMaterial({color:COL.verm,emissive:COL.verm,emissiveIntensity:0.5}));
  bob.position.y=-1.1; penPivot.add(bob);
  metro.userData.pen = penPivot;

  // background dressing: distant ink quills (tower-sized)
  const quillMat=new THREE.MeshStandardMaterial({color:COL.ink,roughness:0.3});
  for(let i=0;i<5;i++){
    const q=new THREE.Mesh(new THREE.ConeGeometry(0.8,14,7), quillMat);
    q.position.set(-40+i*20+(Math.random()*6),7,-30-Math.random()*10); q.rotation.z=0.25*(i%2?1:-1); grp.add(q);
    const feather=new THREE.Mesh(new THREE.ConeGeometry(1.6,6,6), new THREE.MeshStandardMaterial({color:COL.sepia,roughness:0.7,transparent:true,opacity:0.7}));
    feather.position.copy(q.position); feather.position.y+=8; feather.rotation.z=q.rotation.z; grp.add(feather);
  }
  // giant fermata arches
  const fermMat=new THREE.MeshStandardMaterial({color:COL.sepia,roughness:0.6,transparent:true,opacity:0.55});
  [-22,22].forEach(x=>{ const arc=new THREE.Mesh(new THREE.TorusGeometry(8,0.5,8,24,Math.PI), fermMat);
    arc.position.set(x,0,-26); grp.add(arc);
    const dot=new THREE.Mesh(new THREE.SphereGeometry(0.7,12,12), fermMat); dot.position.set(x,4,-26); grp.add(dot); });

  // floating bars of sheet music drifting in parallax (far background)
  const barGroup=new THREE.Group(); grp.add(barGroup);
  const barMat=new THREE.MeshStandardMaterial({color:COL.sepia,roughness:0.8,transparent:true,opacity:0.4});
  const bars=[];
  for(let i=0;i<8;i++){
    const bar=new THREE.Group();
    for(let l=0;l<5;l++){ const line=new THREE.Mesh(new THREE.BoxGeometry(6,0.04,0.02), barMat); line.position.y=l*0.25; bar.add(line); }
    bar.position.set(-45+Math.random()*90, 6+Math.random()*12, -40-Math.random()*20);
    bar.userData.speed=0.2+Math.random()*0.3; barGroup.add(bar); bars.push(bar);
  }
  grp.userData.bars = bars;

  // drifting eighth-note motes
  const moteMat=new THREE.MeshStandardMaterial({color:COL.gold,emissive:COL.gold,emissiveIntensity:0.6});
  const motes=[];
  for(let i=0;i<24;i++){
    const m=new THREE.Group();
    const headM=new THREE.Mesh(geo('moteHead',()=>new THREE.SphereGeometry(0.12,8,8)), moteMat);
    const stem=new THREE.Mesh(geo('moteStem',()=>new THREE.BoxGeometry(0.03,0.4,0.03)), moteMat); stem.position.set(0.1,0.22,0);
    m.add(headM); m.add(stem);
    m.position.set((Math.random()-0.5)*50, 2+Math.random()*10, -6-Math.random()*18);
    m.userData={ sp:0.3+Math.random()*0.5, rot:(Math.random()-0.5)*0.02, base:m.position.y, ph:Math.random()*6 };
    grp.add(m); motes.push(m);
  }
  grp.userData.motes = motes;
  return grp;
}

/* ================================= VFX ================================== */
// Simple pooled particle system: reused Mesh instances with velocity + life.
const VFX = (() => {
  let scene=null; const pool=[]; const active=[];
  const shared = {
    noteMat: new THREE.MeshStandardMaterial({color:COL.gold,emissive:COL.gold,emissiveIntensity:0.8}),
    inkMat:  new THREE.MeshStandardMaterial({color:COL.ink, roughness:0.2}),
    sourMat: new THREE.MeshStandardMaterial({color:COL.dissonance, emissive:COL.dissonance, emissiveIntensity:0.3}),
    noteGeo: new THREE.SphereGeometry(0.14,8,8),
    inkGeo:  new THREE.SphereGeometry(0.1,6,6),
  };
  function setup(s){ scene=s; for(let i=0;i<160;i++){ const m=new THREE.Mesh(shared.noteGeo, shared.noteMat); m.visible=false; scene.add(m); pool.push(m); } }
  function grab(){ return pool.pop() || (()=>{ const m=new THREE.Mesh(shared.noteGeo,shared.noteMat); scene.add(m); return m; })(); }
  function spawn(pos, {count=12, color='note', speed=4, gravity=-9, size=1, life=0.8, spread=1}={}){
    const mat = color==='ink'?shared.inkMat : color==='sour'?shared.sourMat : shared.noteMat;
    const g = color==='ink'?shared.inkGeo : shared.noteGeo;
    for(let i=0;i<count;i++){
      const m=grab(); m.material=mat; m.geometry=g; m.visible=true; m.scale.setScalar(size);
      m.position.copy(pos);
      const a=Math.random()*Math.PI*2, up=0.3+Math.random();
      m.userData={ vx:Math.cos(a)*speed*spread*(Math.random()*0.6+0.4), vy:speed*up, vz:(Math.random()-0.5)*speed*spread*0.5,
                   life, max:life, grav:gravity, spin:(Math.random()-0.5)*0.3 };
      active.push(m);
    }
  }
  function burstUp(pos, color='note', count=16){ // for launchers/uppercuts: mostly vertical
    for(let i=0;i<count;i++){ const m=grab(); m.material = color==='ink'?shared.inkMat:shared.noteMat; m.geometry=shared.noteGeo; m.visible=true; m.scale.setScalar(1);
      m.position.copy(pos); m.position.x+=(Math.random()-0.5);
      m.userData={vx:(Math.random()-0.5)*1.5, vy:6+Math.random()*3, vz:(Math.random()-0.5)*1.5, life:1, max:1, grav:-8, spin:0.2};
      active.push(m); }
  }
  function update(dt){
    for(let i=active.length-1;i>=0;i--){ const m=active[i]; const u=m.userData;
      u.life-=dt; if(u.life<=0){ m.visible=false; active.splice(i,1); pool.push(m); continue; }
      u.vy+=u.grav*dt; m.position.x+=u.vx*dt; m.position.y+=u.vy*dt; m.position.z+=u.vz*dt;
      m.rotation.x+=u.spin; m.rotation.y+=u.spin;
      const k=u.life/u.max; m.scale.setScalar(Math.max(0.01,k));
    }
  }
  return { setup, spawn, burstUp, update };
})();

/* Radial shockwave ring on the paper (on-beat / parry). Pooled rings. */
const Shock = (() => {
  let scene=null; const rings=[];
  function setup(s){ scene=s;
    for(let i=0;i<8;i++){ const r=new THREE.Mesh(new THREE.RingGeometry(0.3,0.5,32),
      new THREE.MeshBasicMaterial({color:COL.gold,transparent:true,opacity:0,side:THREE.DoubleSide}));
      r.rotation.x=-Math.PI/2; r.position.y=0.08; r.visible=false; scene.add(r); rings.push(r); } }
  function pop(pos, color=COL.gold){ const r=rings.find(x=>!x.visible)||rings[0];
    r.visible=true; r.position.set(pos.x,0.08,pos.z); r.material.color.setHex(color); r.material.opacity=0.9; r.scale.setScalar(0.2); r.userData.t=0; }
  function update(dt){ for(const r of rings){ if(!r.visible) continue; r.userData.t+=dt;
    const k=r.userData.t/0.5; if(k>=1){ r.visible=false; continue; } r.scale.setScalar(0.2+k*5); r.material.opacity=0.9*(1-k); } }
  return { setup, pop, update };
})();

/* ============================ CAMERA DIRECTOR =========================== */
// State machine: FRAME (default) plus cinematic states that seize control.
const CameraDir = (() => {
  let cam=null; let state='FRAME'; let t=0, dur=0;
  const cur=new THREE.Vector3(14,7,20), curLook=new THREE.Vector3(0,2,0);
  const tmpPos=new THREE.Vector3(), tmpLook=new THREE.Vector3();
  let dutch=0, dutchTarget=0;
  let orbitFrom=0, orbitTo=0;
  let midX=0, dist=6, slowmo=1;
  function init(camera){ cam=camera; }
  // called each frame with fighter positions
  function frame(p1x, p2x){
    midX=(p1x+p2x)/2; dist=Math.abs(p1x-p2x);
  }
  function set(s, d=1){ state=s; t=0; dur=d; }
  function isCinematic(){ return state!=='FRAME'; }
  function getSlowmo(){ return slowmo; }
  function update(dt){
    t+=dt;
    // default framing target: side view, dolly out with distance, slight height
    const z = 16 + dist*0.9;        // farther when apart
    const y = 6 + dist*0.12;
    tmpPos.set(midX*0.4, y, z);
    tmpLook.set(midX*0.5, 2.2, 0);
    dutchTarget=0; slowmo=1;
    let lerpK = 1-Math.pow(0.001, dt); // easing toward target

    if(state==='INTRO'){
      // slow orbital sweep around the fighters
      const k=t/dur; const ang=(-0.9 + k*1.8);
      const R=14+dist*0.5;
      tmpPos.set(midX*0.4 + Math.sin(ang)*R, 5+Math.sin(k*Math.PI)*3, Math.cos(ang)*R);
      tmpLook.set(midX*0.5, 2.4, 0); lerpK=1-Math.pow(0.02,dt);
      if(t>=dur) set('FRAME');
    } else if(state==='PARRY'){
      // fast dolly-in with Dutch angle
      tmpPos.set(midX*0.4, 4.5, 11+dist*0.3); tmpLook.set(midX*0.5,2.2,0);
      dutchTarget=0.13; lerpK=1-Math.pow(0.0000005,dt); slowmo=0.55;
      if(t>=dur) set('FRAME');
    } else if(state==='FINALE'){
      // full 360 orbit + slow motion
      const k=t/dur; const ang=orbitFrom + (orbitTo-orbitFrom)*k;
      const R=15+dist*0.4;
      tmpPos.set(midX*0.4+Math.sin(ang)*R, 5.5+Math.sin(k*Math.PI*2)*2.5, Math.cos(ang)*R);
      tmpLook.set(midX*0.5,2.6,0); lerpK=1-Math.pow(0.05,dt); slowmo=0.4;
      if(t>=dur) set('FRAME');
    } else if(state==='KO'){
      // low dramatic angle on the loser dissolving
      tmpPos.set(midX*0.4+3, 1.6, 9); tmpLook.set(midX*0.5,2.0,0);
      lerpK=1-Math.pow(0.02,dt); slowmo=0.6;
      if(t>=dur) set('FRAME');
    }
    cur.lerp(tmpPos, Math.min(1,lerpK));
    curLook.lerp(tmpLook, Math.min(1,lerpK));
    dutch += (dutchTarget-dutch)*Math.min(1,dt*6);
    cam.position.copy(cur); cam.up.set(Math.sin(dutch),Math.cos(dutch),0); cam.lookAt(curLook);
  }
  function finale(){ orbitFrom=-0.5; orbitTo=orbitFrom+Math.PI*2; set('FINALE',5.0); }
  return { init, frame, set, update, isCinematic, getSlowmo, finale };
})();

/* Camera shake (added on top of director output) */
const Shake = (() => { let amt=0; function add(a){ amt=Math.max(amt,a); }
  function apply(cam,dt){ if(amt<=0.001){amt=0;return;} cam.position.x+=(Math.random()-0.5)*amt; cam.position.y+=(Math.random()-0.5)*amt; amt*=Math.pow(0.001,dt); }
  return { add, apply }; })();

/* =============================== INPUT ================================== */
// Maps keys to notes, records a rolling buffer, and detects chords vs seq.
const KEYMAP = { KeyC:'C', KeyD:'D', KeyE:'E', KeyF:'F', KeyG:'G', KeyA:'A', KeyB:'B' };
const Input = (() => {
  const down=new Set(); const listeners=[];
  window.addEventListener('keydown', e=>{ if(e.repeat) return; down.add(e.code); listeners.forEach(l=>l.down&&l.down(e)); });
  window.addEventListener('keyup', e=>{ down.delete(e.code); listeners.forEach(l=>l.up&&l.up(e)); });
  return { down, on:(l)=>listeners.push(l), isDown:(c)=>down.has(c) };
})();

/* ================================= AI =================================== */
// Emits the same note inputs as a human. State machine over distance + timing.
function makeAI(fight, side, diff){
  const self = side===0?fight.f1:fight.f2;
  const foe  = side===0?fight.f2:fight.f1;
  let state='approach'; let cd=0; let buffer=[]; let motifTimer=0; let motif=null; let motifIdx=0; let think=0;
  const persona = self.data.ai;
  function pickMotif(){
    // choose a special or plain jab depending on state/aggression
    const specials=self.data.specials;
    if(state==='zone'||foeFar()){ const proj=specials.find(s=>s.type==='projectile'||s.type==='sweep'); return proj||specials[0]; }
    if(Math.random()<persona.aggression*0.6){ return specials[Math.random()<0.6?0:1]; }
    return null; // plain jab
  }
  function foeFar(){ return Math.abs(self.x-foe.x)>5; }
  function reset(){ state='approach'; buffer=[]; motif=null; think=0.4; }
  function update(dt){
    if(fight.state!=='fight'){ return; }
    if(self.stun>0||self.dead) return;
    cd-=dt; think-=dt;
    const distance=Math.abs(self.x-foe.x); const dir=self.x<foe.x?1:-1;

    // update coarse state
    if(distance>6) state = (persona.aggression<0.6)?'zone':'approach';
    else if(distance>2.4) state='approach';
    else state='pressure';

    // defensive: try to block/parry incoming
    if(foe.activeAttack && foe.activeAttack.owner===foe && distance<3.2){
      if(Math.random()<diff.parryChance && cd<=0){
        // attempt a parry (perfect fifth) — emit chord C+G
        fight.aiChord(self, new Set(['C','G'])); cd=0.5; return;
      } else if(Math.random()<0.4){
        fight.aiChord(self, new Set(['C','E','G'])); cd=0.4; return; // block triad
      }
    }

    // movement toward preferred range
    if(state==='approach'){ self.moveIntent = dir; }
    else if(state==='zone'){ self.moveIntent = (distance<8?-dir:0); }
    else self.moveIntent = 0;

    // sidestep dodge if a projectile is incoming
    if(fight.projectiles.some(p=>p.owner!==self && Math.sign(p.vx)===Math.sign(foe.x-self.x)*-1)){
      if(cd<=0 && Math.random()<0.5){ fight.sidestep(self); cd=0.6; }
    }

    // motif execution: feed notes on a cadence
    if(motif){
      motifTimer-=dt;
      if(motifTimer<=0){
        const n=motif.notes[motifIdx++];
        fight.aiNote(self, n, /*onbeatBias*/persona.rhythm*(1-diff.offbeat));
        // pace: presto near beat, andante loose
        motifTimer = 0.12 + diff.offbeat*0.25 + Math.random()*diff.offbeat;
        if(motifIdx>=motif.notes.length){ motif=null; cd=0.4+Math.random()*0.5*(1-persona.aggression); }
      }
      return;
    }

    // decide to start something
    if(think<=0 && cd<=0){
      think = diff.react + Math.random()*diff.react;
      const chanceAttack = (state==='pressure')?0.85:(state==='approach'?0.3:0.6);
      if(Math.random()<chanceAttack){
        const m=pickMotif();
        if(m){ motif=m; motifIdx=0; motifTimer=0; }
        else { // plain jab: single note, occasionally on beat
          const jab=['C','E','G','A'][Math.floor(Math.random()*4)];
          fight.aiNote(self, jab, persona.rhythm*(1-diff.offbeat));
          cd=0.3+Math.random()*0.3;
        }
      } else { self.moveIntent = (distance>3?dir:-dir); cd=0.2; }
    }
    // occasional jump to approach
    if(state==='approach' && Math.random()<0.005 && self.onGround) fight.doJump(self);
  }
  return { update, reset };
}

/* ================================ FIGHT ================================= */
// Owns fighters' physics/state, combat rules, rounds, and the finale.
const DUEL_Z=0; // combat plane
class FighterState {
  constructor(data, side){
    this.data=data; this.side=side; // 0=left,1=right
    this.x = side===0?-4:4; this.y=0; this.z=DUEL_Z; this.vx=0; this.vy=0;
    this.facing = side===0?1:-1;
    this.hp=100; this.rounds=0; this.crescendo=0;
    this.onGround=true; this.crouch=false;
    this.stun=0; this.dash=0; this.dashCd=0; this.sideCd=0; this.sidestep=0; this.invuln=0; this.projInvuln=0;
    this.blockTimer=0; this.parryWindow=0; this.fumble=0;
    this.activeAttack=null; this.moveIntent=0; this.dead=false;
    this.buffer=[]; // {note,time}
    this.anim={ t:0, name:'idle', punch:0, hurt:0, squash:0 };
    this.group=makeFighter(data);
  }
}
const Fight = {
  scene:null, f1:null, f2:null, state:'idle', // idle|intro|fight|roundend|finale|ko
  round:0, roundWins:[0,0], timer:60, tempoBPM:90, beatInterval:60/90, beatClock:0, lastBeat:0,
  ai:null, aiSide:1, projectiles:[], onEvent:null, finaleActive:false, timeScale:1,
  bpmByRound:[90,110,130],

  begin(scene, p1data, p2data, diffId, humanSide=0){
    this.scene=scene;
    this.f1=new FighterState(p1data,0); this.f2=new FighterState(p2data,1);
    scene.add(this.f1.group); scene.add(this.f2.group);
    this.f1.group.position.set(this.f1.x,0,0); this.f2.group.position.set(this.f2.x,0,0);
    this.humanSide=humanSide; this.aiSide=1-humanSide;
    const diff=DIFFICULTIES.find(d=>d.id===diffId)||DIFFICULTIES[1];
    this.diff=diff;
    this.ai=makeAI(this, this.aiSide, diff);
    this.round=0; this.roundWins=[0,0];
    this.projectiles=[];
    this.startRound();
  },
  startRound(){
    this.tempoBPM=this.bpmByRound[Math.min(this.round,2)];
    this.beatInterval=60/this.tempoBPM; this.beatClock=0;
    this.timer=60; this.timeScale=1; this.finaleActive=false;
    const f1=this.f1,f2=this.f2;
    [f1,f2].forEach((f,i)=>{ f.hp=100; f.x=i===0?-4:4; f.y=0; f.vx=0; f.vy=0; f.onGround=true; f.dead=false;
      f.stun=0; f.crescendo= f.crescendo||0; f.activeAttack=null; f.buffer=[]; f.fumble=0; f.crouch=false; f.dissolve=0;
      f.group.visible=true; f.group.scale.setScalar(0.62); });
    // keep crescendo across rounds but reset small — design: retain
    this.projectiles.forEach(p=>this.scene.remove(p.mesh)); this.projectiles=[];
    this.state='intro';
    CameraDir.frame(f1.x,f2.x); CameraDir.set('INTRO',3.2);
    this.emit('movement', `Movement ${['I','II','III'][this.round]}`);
    Audio.timpaniRoll();
    this.ai.reset();
    setTimeout(()=>{ if(this.state==='intro'){ this.state='fight'; this.emit('announce','Da Capo!'); } }, 3200);
  },
  emit(type,data){ if(this.onEvent) this.onEvent(type,data); },

  /* -------- beat / metronome -------- */
  onBeat(now){ // is 'now' within on-beat window of nearest tick?
    const phase = this.beatClock % this.beatInterval;
    const d = Math.min(phase, this.beatInterval-phase);
    return d <= 0.09; // ±90ms
  },

  /* -------- note input (human) -------- */
  humanNote(note){
    const f = this.humanSide===0?this.f1:this.f2;
    this.pushNote(f, note, /*human*/true);
  },
  aiNote(f, note){ this.pushNote(f, note, false); },
  aiChord(f, set){ this.resolveChord(f, set); },

  pushNote(f, note, human){
    if(this.state!=='fight' && this.state!=='finale') return;
    if(f.dead||f.fumble>0) return;
    const now=this.audioNow();
    f.buffer.push({note, time:now});
    // trim to 2.2s window
    f.buffer=f.buffer.filter(b=>now-b.time<2.2);
    // audio: sound the note in fighter timbre, panned, octave by air/crouch
    const oct = !f.onGround?1 : f.crouch?-1 : 0;
    Audio.noteName(note, f.data.timbre, {pan:Audio.panFor(f.x), oct, dur:0.28, gain:0.5});
    this.emit('buffer', {side:f.side, note});

    // chord detection: notes within 40ms group -> defense
    const cluster = f.buffer.filter(b=>now-b.time<0.04);
    if(cluster.length>=2){
      const set=new Set(cluster.map(b=>b.note));
      if(isFifth(set)||isTriad(set)){ this.resolveChord(f,set); f.buffer=[]; return; }
    }

    // on-beat single jab -> immediate light attack (if not building a motif match)
    // first, try motif match on the tail
    if(this.tryMotif(f)) return;

    // otherwise treat as a light jab
    this.lightJab(f, note, human);
  },

  // MOTIF MATCH: test buffer tail against each special/finale pattern.
  tryMotif(f){
    const now=this.audioNow();
    const seq=f.buffer.map(b=>b.note);
    // finale first (masterwork) if crescendo full
    if(f.crescendo>=100){
      const fm=f.data.finale;
      if(this.tailMatches(f, seq, fm.notes)){ this.doFinale(f, fm); return true; }
    }
    for(const sp of f.data.specials){
      if(this.tailMatches(f, seq, sp.notes)){
        // dissonance terminator check
        if(endsDissonant(sp.notes)){ this.fumble(f); return true; }
        this.doSpecial(f, sp); return true;
      }
    }
    // dissonance from a free-form clash ending (player mashing F then B, etc.)
    if(seq.length>=2 && endsDissonant(seq)){ /* only punish if it wasn't a valid motif tail—handled above */ }
    return false;
  },
  tailMatches(f, seq, pattern){
    if(seq.length<pattern.length) return false;
    const tail=seq.slice(seq.length-pattern.length);
    if(!tail.every((n,i)=>n===pattern[i])) return false;
    // all within 2s window
    const b=f.buffer.slice(f.buffer.length-pattern.length);
    return (b[b.length-1].time - b[0].time) <= 2.0;
  },

  /* -------- attacks -------- */
  lightJab(f, note, human){
    if(f.stun>0) return;
    const foe = f===this.f1?this.f2:this.f1;
    f.anim.punch=1; f.anim.name='attack';
    const height=noteHeight(note);
    const onbeat=this.onBeat();
    const reach=1.9;
    const dist=Math.abs(f.x-foe.x);
    let dmg=5;
    // check hit
    if(dist<=reach && this.heightHits(foe,height) && foe.invuln<=0){
      this.applyHit(f, foe, dmg, {onbeat, note, kind:'jab'});
    } else {
      // whiff — still sounded the note
      if(onbeat) this.crescendoGain(f, 4);
    }
    Audio.thump(Audio.panFor(f.x), false);
  },
  heightHits(foe, height){
    if(foe.crouch && (height==='high'||height==='mid')) return false; // crouch dodges high/mid partly
    if(!foe.onGround && height==='low') return false; // airborne dodges low
    return true;
  },
  doSpecial(f, sp){
    if(f.stun>0) return;
    const foe = f===this.f1?this.f2:this.f1;
    f.buffer=[]; f.anim.name='special'; f.anim.punch=1;
    const pan=Audio.panFor(f.x);
    // play motif as a phrase
    sp.notes.forEach((n,i)=> Audio.noteName(n, f.data.timbre, {when:i*0.11, pan, dur:0.22, gain:0.42}));
    this.emit('special',{side:f.side,name:sp.name});
    const onbeat=this.onBeat();

    if(sp.type==='projectile'){ this.spawnProjectile(f, sp); return; }
    if(sp.type==='teleport'){ // Sugar Plum: hop behind foe
      Audio.pad([FREQ.E*2,FREQ.G*2,FREQ.B*2],{dur:0.5,gain:0.1,type:'sine'});
      VFX.spawn(f.group.position.clone().setY(1.4),{count:14,color:'note',speed:3});
      f.x = foe.x + (foe.facing>0?-1.4:1.4)*-1*1; f.x = foe.x - foe.facing*1.4;
      f.facing=-foe.facing*1; f.facing = f.x<foe.x?1:-1;
      VFX.spawn(f.group.position.clone().setY(1.4),{count:14,color:'note',speed:3});
      // then a hit
      setTimeout(()=>{ if(!f.dead&&!foe.dead&&Math.abs(f.x-foe.x)<2.2) this.applyHit(f,foe,sp.dmg,{onbeat,kind:'special',special:sp}); },160);
      return;
    }
    if(sp.type==='counter'){ // Fugue Mirror: stance; catch next hit
      f.counterStance=0.9; VFX.spawn(f.group.position.clone().setY(1.6),{count:8,color:'note',speed:2});
      return;
    }
    // melee specials: rush/launcher/multipoke/crossup/sweep
    const reach = sp.type==='rush'?2.6 : sp.type==='sweep'?2.4 : 2.1;
    const dist=Math.abs(f.x-foe.x);
    if(sp.type==='rush'){ // dash forward multi-hit
      f.vx = f.facing*10;
      let hits=sp.notes.length;
      const doHit=(k)=>{ if(k>=hits||f.dead) return;
        if(Math.abs(f.x-foe.x)<reach && foe.invuln<=0){ this.applyHit(f,foe,sp.dmg/hits,{onbeat:this.onBeat(),kind:'special',special:sp,multi:true}); Shake.add(0.15+0.05*k); }
        setTimeout(()=>doHit(k+1),110); };
      doHit(0); return;
    }
    if(sp.type==='launcher'){
      if(dist<reach && foe.invuln<=0){ this.applyHit(f,foe,sp.dmg,{onbeat,kind:'launch',special:sp});
        foe.vy=12; foe.onGround=false; VFX.burstUp(foe.group.position.clone().setY(1),'note',18); }
      return;
    }
    if(sp.type==='crossup'){ // Rondo Turca: hop over
      f.vy=9; f.onGround=false; const tgtX=foe.x+ (f.x<foe.x?1.6:-1.6);
      f.vx=(tgtX-f.x)*3;
      setTimeout(()=>{ if(!f.dead&&Math.abs(f.x-foe.x)<2.4) this.applyHit(f,foe,sp.dmg,{onbeat,kind:'special',special:sp}); },220);
      return;
    }
    if(sp.type==='multipoke'){ // Kleine Nacht: quick multi-hit with afterimage
      f.vx=f.facing*6; let hits=3;
      const doHit=(k)=>{ if(k>=hits||f.dead) return;
        if(Math.abs(f.x-foe.x)<reach && foe.invuln<=0) this.applyHit(f,foe,sp.dmg/hits,{onbeat:this.onBeat(),kind:'special',special:sp,multi:true});
        this.spawnAfterimage(f);
        setTimeout(()=>doHit(k+1),90); };
      doHit(0); return;
    }
    if(sp.type==='sweep'){ // Swan Cutter: crescent slash + feather arc
      if(dist<reach && foe.invuln<=0){ this.applyHit(f,foe,sp.dmg,{onbeat,kind:'special',special:sp}); }
      const p=f.group.position.clone().setY(1.4).add(new THREE.Vector3(f.facing*1.2,0,0));
      VFX.spawn(p,{count:16,color:'note',speed:5,spread:1.4});
      return;
    }
  },
  spawnAfterimage(f){
    const p=f.group.position.clone();
    const ghost=new THREE.Mesh(geo('torso'), new THREE.MeshBasicMaterial({color:f.data.accent,transparent:true,opacity:0.4}));
    ghost.position.copy(p).setY(1.35*0.62); ghost.scale.setScalar(0.62); this.scene.add(ghost);
    let life=0.3; const iv=setInterval(()=>{ life-=0.05; ghost.material.opacity=0.4*(life/0.3); if(life<=0){ clearInterval(iv); this.scene.remove(ghost);} },50);
  },

  /* -------- projectiles -------- */
  spawnProjectile(f, sp){
    const foe=f===this.f1?this.f2:this.f1;
    // glowing ribbon of sixteenth-note geometry
    const grp=new THREE.Group();
    const mat=new THREE.MeshStandardMaterial({color:COL.gold,emissive:COL.gold,emissiveIntensity:0.9});
    for(let i=0;i<6;i++){ const nh=new THREE.Mesh(geo('moteHead'), mat); nh.position.x=i*0.22; grp.add(nh); }
    grp.position.set(f.x + f.facing*1.2, 1.4, DUEL_Z);
    this.scene.add(grp);
    this.projectiles.push({ mesh:grp, x:grp.position.x, vx:f.facing*9, owner:f, dmg:sp.dmg, life:2.2, t:0, special:sp });
  },
  updateProjectiles(dt){
    for(let i=this.projectiles.length-1;i>=0;i--){ const p=this.projectiles[i];
      p.t+=dt; p.x+=p.vx*dt; p.mesh.position.x=p.x;
      // undulate along duel line
      p.mesh.children.forEach((c,j)=>{ c.position.y=Math.sin(p.t*10+j)*0.25; });
      p.life-=dt;
      const foe = p.owner===this.f1?this.f2:this.f1;
      if(p.life<=0 || Math.abs(p.x)>60){ this.scene.remove(p.mesh); this.projectiles.splice(i,1); continue; }
      if(Math.abs(p.x-foe.x)<1.2 && foe.projInvuln<=0 && foe.invuln<=0){
        this.applyHit(p.owner, foe, p.dmg, {onbeat:this.onBeat(),kind:'projectile',special:p.special});
        this.scene.remove(p.mesh); this.projectiles.splice(i,1);
      }
    }
  },

  /* -------- defense resolution -------- */
  resolveChord(f, set){
    const foe=f===this.f1?this.f2:this.f1;
    const pan=Audio.panFor(f.x);
    if(isFifth(set)){
      // parry window: if an attack is incoming/active within 150ms -> parry
      f.parryWindow=0.15;
      // check foe currently attacking
      if(foe.anim && (foe.anim.name==='special'||foe.anim.name==='attack') && Math.abs(f.x-foe.x)<3.4){
        this.doParry(f, foe);
      } else {
        Audio.parry(pan); // still rings, just a stance
        f.blockTimer=0.3;
      }
    } else if(isTriad(set)){
      f.blockTimer=0.6; Audio.block(pan);
      this.emit('block',{side:f.side});
    }
  },
  doParry(f, attacker){
    Audio.parry(Audio.panFor(f.x));
    attacker.stun=0.8; attacker.activeAttack=null; attacker.vx*=-0.3;
    this.crescendoGain(f, 18);
    Shock.pop(f.group.position, COL.verm);
    VFX.spawn(f.group.position.clone().setY(1.6),{count:18,color:'note',speed:5});
    this.emit('parry',{side:f.side});
    CameraDir.set('PARRY',0.9);
    Shake.add(0.25);
  },

  /* -------- hit application -------- */
  applyHit(attacker, foe, dmg, opts){
    if(foe.dead) return;
    // block?
    if(foe.blockTimer>0){ Audio.block(Audio.panFor(foe.x)); this.emit('block',{side:foe.side}); foe.blockTimer=0; foe.vx += attacker.facing*1.5; return; }
    // counter stance (Bach Fugue Mirror)?
    if(foe.counterStance>0){ foe.counterStance=0; this.counterRiposte(foe, attacker); return; }
    // on-beat bonus
    let onbeat = opts.onbeat && this.onBeat();
    // recompute against current phase for fairness
    onbeat = opts.onbeat;
    let mult = onbeat?1.5:1;
    let final = dmg*mult;
    foe.hp=Math.max(0, foe.hp-final);
    foe.stun=Math.max(foe.stun, opts.kind==='launch'?0.5:0.28);
    foe.anim.hurt=1; foe.vx += attacker.facing*(opts.kind==='launch'?2:3.5);
    // sfx: note + thump; airborne +oct
    if(opts.note) Audio.noteName(opts.note, attacker.data.timbre,{pan:Audio.panFor(attacker.x),gain:0.5});
    Audio.thump(Audio.panFor(foe.x), true);
    // vfx
    const hp=foe.group.position.clone().setY(1.3);
    VFX.spawn(hp,{count:onbeat?14:8, color:'note', speed:onbeat?5:3.5});
    if(onbeat){ Shock.pop(foe.group.position, COL.gold); this.emit('onbeat',{side:foe.side}); this.crescendoGain(attacker,8); Shake.add(0.2); }
    else { this.crescendoGain(attacker,3); Shake.add(0.12); }
    this.emit('hit',{attacker:attacker.side,target:foe.side,dmg:final,onbeat});
    if(foe.hp<=0) this.knockout(foe);
  },
  counterRiposte(counterer, attacker){
    // Bach answers with attacker's last motif inverted, bonus damage
    Audio.parry(Audio.panFor(counterer.x));
    Shock.pop(counterer.group.position, COL.verm);
    const dmg=16;
    attacker.hp=Math.max(0,attacker.hp-dmg);
    attacker.stun=0.6; attacker.anim.hurt=1; attacker.vx += counterer.facing*4;
    // sound: inverted phrase (reverse of a triad)
    ['C','G','E'].forEach((n,i)=>Audio.noteName(n,counterer.data.timbre,{when:i*0.1,pan:Audio.panFor(counterer.x)}));
    VFX.spawn(attacker.group.position.clone().setY(1.4),{count:14,color:'note',speed:4});
    this.emit('parry',{side:counterer.side});
    CameraDir.set('PARRY',0.8);
    if(attacker.hp<=0) this.knockout(attacker);
  },
  fumble(f){
    f.fumble=0.6; f.buffer=[]; f.invuln=-1; // vulnerable
    Audio.dissonance(Audio.panFor(f.x));
    VFX.spawn(f.group.position.clone().setY(1.4),{count:14,color:'sour',speed:3,gravity:-6});
    this.emit('fumble',{side:f.side});
  },

  crescendoGain(f, amt){ f.crescendo=Math.min(100, f.crescendo+amt); this.emit('crescendo',{side:f.side,value:f.crescendo}); },

  /* -------- movement helpers -------- */
  doJump(f){ if(f.onGround && f.stun<=0){ f.vy=11; f.onGround=false; f.anim.name='jump'; } },
  doDash(f){ if(f.dashCd<=0 && f.stun<=0){ f.vx=f.facing*16; f.dash=0.18; f.invuln=0.18; f.dashCd=3; VFX.spawn(f.group.position.clone().setY(1.2),{count:8,color:'ink',speed:2}); } },
  sidestep(f){ if(f.sideCd<=0 && f.stun<=0){ f.sidestep=0.4; f.projInvuln=0.4; f.sideCd=4; } },

  /* -------- finale -------- */
  doFinale(f, fm){
    if(this.finaleActive) return;
    this.finaleActive=true; f.buffer=[]; f.crescendo=0; this.state='finale';
    const foe=f===this.f1?this.f2:this.f1;
    this.emit('finale',{side:f.side,name:fm.name});
    CameraDir.finale();
    // invert world to night
    this.emit('night',true);
    // fully harmonized motif phrase
    const pan=Audio.panFor(f.x);
    fm.notes.forEach((n,i)=>{ Audio.noteName(n,f.data.timbre,{when:i*0.18,pan,dur:0.3,gain:0.5});
      Audio.pad([FREQ[n],FREQ[n]*1.5],{dur:0.6,gain:0.06}); });
    // fighter-specific finale visuals
    this.finaleVisual(f, foe, fm);
    // resolve damage over the slow-mo window
    setTimeout(()=>{
      if(foe.invuln>0){} else {
        foe.hp=Math.max(0, foe.hp-fm.dmg);
        VFX.burstUp(foe.group.position.clone().setY(1),'note',30);
        Shock.pop(foe.group.position, COL.gold);
        this.emit('hit',{attacker:f.side,target:foe.side,dmg:fm.dmg,onbeat:false});
        if(foe.hp<=0) this.knockout(foe);
      }
    }, 2400);
    setTimeout(()=>{ this.finaleActive=false; if(this.state==='finale') this.state='fight'; this.emit('night',false); }, 5200);
  },
  finaleVisual(f, foe, fm){
    const id=f.data.id;
    if(id==='beethoven'){ // giant translucent chord-stab planes sweep the stage
      for(let i=0;i<4;i++){ const plane=new THREE.Mesh(new THREE.PlaneGeometry(3,10),
        new THREE.MeshBasicMaterial({color:COL.crimson,transparent:true,opacity:0.4,side:THREE.DoubleSide}));
        plane.position.set(f.x + f.facing*(1+i*1.5),3,DUEL_Z); this.scene.add(plane);
        let t=0; const iv=setInterval(()=>{ t+=0.05; plane.position.x+=f.facing*0.4; plane.material.opacity=0.4*(1-t/1.2);
          if(t>=1.2){clearInterval(iv); this.scene.remove(plane);} },50);
      }
      Audio.pad([FREQ.G,FREQ.C*2,FREQ.E*2,FREQ.G*2],{dur:2.5,gain:0.14,type:'sawtooth'});
    } else if(id==='mozart'){ // Requiem: night + choir + spectral notes rain
      Audio.pad([FREQ.D,FREQ.F,FREQ.A,FREQ.D*2],{dur:3,gain:0.14,type:'sine'});
      let n=0; const iv=setInterval(()=>{ VFX.spawn(new THREE.Vector3(foe.x+(Math.random()-0.5)*4,8,DUEL_Z),{count:6,color:'note',speed:1,gravity:-4}); if(++n>18) clearInterval(iv); },80);
    } else if(id==='bach'){ // Grand Fugue: four voice-ribbons from four ridges in canon
      [-6,-3,3,6].forEach((z,i)=> setTimeout(()=>{
        const grp=new THREE.Group(); const mat=new THREE.MeshStandardMaterial({color:COL.green,emissive:COL.green,emissiveIntensity:0.8});
        for(let k=0;k<6;k++){ const nh=new THREE.Mesh(geo('moteHead'),mat); nh.position.x=k*0.22; grp.add(nh); }
        grp.position.set(f.x+f.facing*1.2,1.4,z); this.scene.add(grp);
        let t=0; const iv=setInterval(()=>{ t+=0.05; grp.position.x+=f.facing*0.5; grp.position.z += (DUEL_Z-grp.position.z)*0.06;
          if(t>=2){clearInterval(iv); this.scene.remove(grp);} },40);
      }, i*250));
      Audio.pad([FREQ.A,FREQ.C*2,FREQ.E*2],{dur:2.5,gain:0.12,type:'triangle'});
    } else { // Tchaikovsky 1812: cannons + smoke puffs blasting foe down the line
      [0,0.4,0.8,1.2].forEach((d,i)=> setTimeout(()=>{ Audio.cannon(Audio.panFor(foe.x));
        VFX.spawn(foe.group.position.clone().setY(1.2),{count:18,color:'ink',speed:6,gravity:-4});
        Shake.add(0.5); foe.vx += f.facing*6; }, d*1000));
    }
  },

  /* -------- knockout / rounds -------- */
  knockout(foe){
    if(this.state==='ko') return;
    const winner = foe===this.f1?this.f2:this.f1;
    this.state='ko';
    CameraDir.set('KO',3.0);
    Audio.cymbal();
    this.emit('ko',{loser:foe.side, winner:winner.side});
    // dissolve loser into swarm of floating notes
    foe.dissolve=0.0001;
    const roundWinnerSide = winner.side;
    this.roundWins[roundWinnerSide]++;
    winner.rounds=this.roundWins[roundWinnerSide];
    this.emit('rounds',{wins:this.roundWins.slice()});
    setTimeout(()=>{
      if(this.roundWins[roundWinnerSide]>=2){
        this.state='matchover';
        this.emit('matchover',{winner:winner.side});
      } else {
        this.round++;
        this.startRound();
      }
    }, 3200);
  },

  /* -------- per-frame update -------- */
  audioNow(){ const c=Audio.ctx(); return c?c.currentTime:performance.now()/1000; },
  update(dt){
    const scaled = dt*this.timeScale;
    // metronome clock (real time so beats stay musical, but pause in cinematics slowmo)
    if(this.state==='fight'||this.state==='finale'){
      this.beatClock+=dt; // uses real dt so bpm is stable
      const beatsElapsed=Math.floor(this.beatClock/this.beatInterval);
      if(beatsElapsed>this.lastBeat){ this.lastBeat=beatsElapsed; if(!Audio.isMuted()) Audio.tick(); this.emit('beat',{}); }
    }
    if(this.state==='fight'){
      this.timer-=dt; if(this.timer<=0){ this.timer=0; this.timeUp(); }
      this.emit('timer',this.timer);
    }
    // AI
    if(this.ai && (this.state==='fight')) this.ai.update(dt);
    // human movement (continuous keys)
    if(this.state==='fight') this.handleHumanMovement();
    // physics for both
    this.stepFighter(this.f1, scaled);
    this.stepFighter(this.f2, scaled);
    // face each other
    this.f1.facing = this.f1.x<=this.f2.x?1:-1;
    this.f2.facing = this.f2.x< this.f1.x?1:-1;
    // projectiles
    this.updateProjectiles(scaled);
    // camera framing input
    CameraDir.frame(this.f1.x, this.f2.x);
  },
  handleHumanMovement(){
    const f=this.humanSide===0?this.f1:this.f2;
    if(f.stun>0||f.fumble>0) return;
    let mv=0;
    if(Input.isDown('ArrowLeft')) mv-=1;
    if(Input.isDown('ArrowRight')) mv+=1;
    f.moveIntent=mv;
    f.crouch = Input.isDown('ArrowDown') && f.onGround;
  },
  stepFighter(f, dt){
    // apply move intent -> velocity along duel line (x only)
    const speed = f.data.id==='mozart'?6.5 : f.data.id==='tchaikovsky'?4.5 : 5.5;
    if(f.stun<=0 && f.fumble<=0 && f.dash<=0){
      const targetVx = f.moveIntent*speed*(f.crouch?0.4:1);
      f.vx += (targetVx - f.vx)*Math.min(1,dt*12);
    }
    f.moveIntent=0;
    // gravity
    if(!f.onGround){ f.vy-=26*dt; }
    f.x+=f.vx*dt; f.y+=f.vy*dt;
    if(f.y<=0){ f.y=0; if(!f.onGround){ f.onGround=true; f.vy=0; if(f.anim.name==='jump')f.anim.name='idle'; } }
    // friction on ground
    if(f.onGround && f.dash<=0) f.vx*=Math.pow(0.02,dt);
    // clamp to stage
    f.x=Math.max(-16,Math.min(16,f.x));
    // timers
    f.stun=Math.max(0,f.stun-dt); f.dash=Math.max(0,f.dash-dt); f.dashCd=Math.max(0,f.dashCd-dt);
    f.sideCd=Math.max(0,f.sideCd-dt); f.blockTimer=Math.max(0,f.blockTimer-dt);
    f.parryWindow=Math.max(0,f.parryWindow-dt); f.fumble=Math.max(0,f.fumble-dt);
    if(f.counterStance>0) f.counterStance=Math.max(0,f.counterStance-dt);
    if(f.invuln>0) f.invuln=Math.max(0,f.invuln-dt);
    if(f.projInvuln>0) f.projInvuln=Math.max(0,f.projInvuln-dt);
    // sidestep: hop to parallel staff line and back (z animates), returns to duel line
    if(f.sidestep>0){ f.sidestep-=dt; const k=f.sidestep/0.4; f.z = Math.sin((1-k)*Math.PI)*3; }
    else f.z += (DUEL_Z - f.z)*Math.min(1,dt*10);

    this.animate(f, dt);
    // apply transform
    f.group.position.set(f.x, f.y, f.z);
    f.group.rotation.y = f.facing>0?Math.PI/2*0 : Math.PI; // face along +x or -x
    f.group.rotation.y = f.facing>0? Math.PI*0.5 : -Math.PI*0.5;
    // dissolve on KO
    if(f.dissolve!==undefined && f.dissolve>0){
      f.dissolve+=dt; const s=0.62*Math.max(0,1-f.dissolve*0.6); f.group.scale.setScalar(s);
      if(f.dissolve<0.5 && Math.random()<0.6) VFX.spawn(f.group.position.clone().setY(1+Math.random()),{count:2,color:'note',speed:2,gravity:-1});
      if(s<=0.02) f.group.visible=false;
    }
  },
  // procedural animation: torso lean, arm swings, squash/stretch, hurt
  animate(f, dt){
    const p=f.group.userData.parts; f.anim.t+=dt;
    const t=f.anim.t;
    // decay transient anims
    f.anim.punch=Math.max(0,f.anim.punch-dt*4);
    f.anim.hurt =Math.max(0,f.anim.hurt -dt*3);
    // base idle breathing
    const breathe=Math.sin(t*2)*0.03;
    p.torso.position.y=1.35+breathe;
    p.head.position.y=2.1+breathe;
    p.hair.position.y=2.2+breathe;
    // walking: leg swing when moving
    const moving=Math.abs(f.vx)>0.6 && f.onGround;
    const stride=moving?Math.sin(t*10)*0.5:0;
    p.legL.rotation.x= stride; p.legR.rotation.x=-stride;
    p.armL.rotation.x=0.3 - stride*0.6; p.armR.rotation.x=0.3 + stride*0.6;
    // crouch squash
    const crouchK = f.crouch?1:0;
    f.group.scale.y = 0.62*(1 - crouchK*0.28);
    // jump stretch
    if(!f.onGround){ p.legL.rotation.x=-0.6; p.legR.rotation.x=-0.6; f.group.scale.y=0.62*1.05; }
    // torso lean toward motion
    p.torso.rotation.z = -f.vx*0.02;
    // punch: thrust front arm
    if(f.anim.punch>0){ const k=f.anim.punch; p.armR.rotation.x=0.3 - k*1.6; p.torso.rotation.z += -0.15*k; }
    // hurt: recoil
    if(f.anim.hurt>0){ const k=f.anim.hurt; p.torso.rotation.x = k*0.4; p.head.position.z=-k*0.2; }
    else p.torso.rotation.x=0;
    // stun wobble
    if(f.stun>0){ f.group.rotation.z=Math.sin(t*30)*0.06; } else f.group.rotation.z=0;
    // block pose: arms up
    if(f.blockTimer>0){ p.armL.rotation.x=-1.4; p.armR.rotation.x=-1.4; }
  },
  timeUp(){
    // higher HP wins the round
    const loser = this.f1.hp<=this.f2.hp?this.f1:this.f2;
    this.knockout(loser);
  },
  // human actions dispatched from key handler
  humanAction(code){
    const f=this.humanSide===0?this.f1:this.f2;
    if(this.state!=='fight') return;
    if(code==='ArrowUp') this.doJump(f);
    else if(code==='Space') this.doDash(f);
    else if(code==='ShiftLeft'||code==='ShiftRight') this.sidestep(f);
  },
};

/* ============================ ENGINE / LOOP + UI ======================== */
const App = (() => {
  let renderer, scene, camera, clock, stage;
  let screen='title'; // title|select|fight|pause|victory
  let paused=false;
  // selection state
  let selectStep='player'; // player -> opponent -> difficulty (opponent can be random)
  let selIndex=0, playerPick=0, oppPick=1, diffIndex=1;
  let rafId=null;

  // titlescreen 3D logo group
  let titleGroup=null, titleT=0;

  function initThree(){
    renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    renderer.setSize(innerWidth,innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
    renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    renderer.setClearColor(COL.paper);
    document.getElementById('game').appendChild(renderer.domElement);

    scene=new THREE.Scene();
    scene.fog=new THREE.Fog(COL.paper, 24, 80);
    camera=new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 300);
    camera.position.set(14,7,20);
    CameraDir.init(camera);

    // lighting: warm key (reading lamp), cool fill, ambient
    const key=new THREE.DirectionalLight(0xfff0d8, 1.15); key.position.set(8,16,10);
    key.castShadow=true; key.shadow.mapSize.set(1024,1024);
    key.shadow.camera.left=-20; key.shadow.camera.right=20; key.shadow.camera.top=20; key.shadow.camera.bottom=-20;
    key.shadow.camera.near=1; key.shadow.camera.far=60; key.shadow.bias=-0.0005;
    scene.add(key);
    const fill=new THREE.DirectionalLight(0xbcccdd,0.4); fill.position.set(-10,8,6); scene.add(fill);
    scene.add(new THREE.AmbientLight(0xfff2dd,0.55));
    // rim lights per fighter set later via a moving light? keep simple: two rim lights
    App.rimA=new THREE.PointLight(COL.crimson,0,14); scene.add(App.rimA);
    App.rimB=new THREE.PointLight(COL.blue,0,14); scene.add(App.rimB);

    stage=buildStage(scene);
    VFX.setup(scene); Shock.setup(scene);
    App.key=key;

    clock=new THREE.Clock();
    window.addEventListener('resize',onResize);
    buildTitle();
    setScreen('title'); // ensure HUD hidden + title framing on boot
    loop();
  }
  function onResize(){ renderer.setSize(innerWidth,innerHeight); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); }

  /* ---- title 3D logo (engraved letters on paper) ---- */
  function buildTitle(){
    titleGroup=new THREE.Group(); scene.add(titleGroup);
    const letters='MAESTRO';
    const engMat=new THREE.MeshStandardMaterial({color:COL.sepia,roughness:0.5,metalness:0.1});
    // crude block letters as extruded boxes forming the word footprint
    for(let i=0;i<letters.length;i++){
      const b=new THREE.Mesh(new THREE.BoxGeometry(1.1,1.6,0.5), engMat);
      b.position.set((i-(letters.length-1)/2)*1.4, 3, 0); b.castShadow=true; titleGroup.add(b);
      // a note-head dot over each letter
      const dot=new THREE.Mesh(geo('moteHead'), new THREE.MeshStandardMaterial({color:COL.gold,emissive:COL.gold,emissiveIntensity:0.6}));
      dot.position.set((i-(letters.length-1)/2)*1.4, 4.3, 0); titleGroup.add(dot);
    }
    const sub=new THREE.Mesh(new THREE.BoxGeometry(8,0.9,0.4), engMat); sub.position.set(0,1.4,0); titleGroup.add(sub);
    titleGroup.visible=true;
  }

  /* ---- screen switching ---- */
  const $=(id)=>document.getElementById(id);
  function show(id){ ['title','select','pause','victory'].forEach(s=>$(s).classList.add('hidden')); if(id) $(id).classList.remove('hidden'); }
  function setScreen(s){ screen=s;
    if(s==='title'){ show('title'); $('hud').classList.add('hidden'); titleGroup&&(titleGroup.visible=true); }
    else if(s==='select'){ show('select'); $('hud').classList.add('hidden'); titleGroup&&(titleGroup.visible=false); buildSelectUI(); }
    else if(s==='fight'){ show(null); $('hud').classList.remove('hidden'); titleGroup&&(titleGroup.visible=false); }
    else if(s==='pause'){ show('pause'); }
    else if(s==='victory'){ show('victory'); $('hud').classList.add('hidden'); }
  }

  /* ---- select screen UI ---- */
  function buildSelectUI(){
    const roster=$('roster'); roster.innerHTML='';
    ROSTER.forEach((f,i)=>{ const c=document.createElement('div'); c.className='card'; c.dataset.i=i;
      c.innerHTML=`<div class="cn" style="color:${f.accentHex}">${f.name}</div><div class="cd">${f.blurb}</div>`;
      roster.appendChild(c); });
    const diffbox=$('diffbox'); diffbox.innerHTML='Tempo: '+DIFFICULTIES.map((d,i)=>`<span class="opt" data-i="${i}">${d.name}</span>`).join('');
    updateSelectUI();
  }
  function updateSelectUI(){
    document.querySelectorAll('#roster .card').forEach((c,i)=> c.classList.toggle('active', i===selIndex));
    document.querySelectorAll('#diffbox .opt').forEach((o,i)=> o.classList.toggle('on', i===diffIndex));
    const label = selectStep==='player'?'SELECTING: YOU (Player) — ← → choose, Enter':
                  selectStep==='opponent'?'SELECTING: OPPONENT — ← → choose, R random, Enter':
                  'SELECT TEMPO (difficulty) — ← → choose, Enter to fight';
    $('sideLabel').textContent=label;
    $('diffbox').style.display = selectStep==='difficulty'?'block':'none';
    $('roster').style.display = selectStep==='difficulty'?'none':'flex';
    let info='';
    if(selectStep==='player') info=`You: choose a maestro`;
    else if(selectStep==='opponent') info=`You are <b>${ROSTER[playerPick].name}</b>. Choose opponent (<span class="k">R</span>=random).`;
    else info=`<b>${ROSTER[playerPick].name}</b> vs <b>${ROSTER[oppPick].name}</b> — pick tempo, <span class="k">Enter</span> = Da Capo!`;
    $('stagerow').innerHTML=info;
  }

  /* ---- HUD update ---- */
  function drawCrescendo(svgId, value, right){
    const svg=$(svgId); const w=150,h=16; const k=value/100;
    // hairpin < that fills with gold
    svg.innerHTML='';
    const bg=`<polyline points="${right?w:0},8 ${right?0:w},2 ${right?0:w},14" fill="none" stroke="#4A3B2A" stroke-width="2"/>`;
    const fillW=w*k;
    const clip=right? `polygon(${100-k*100}% 0,100% 0,100% 100%,${100-k*100}% 100%)` : `polygon(0 0,${k*100}% 0,${k*100}% 100%,0 100%)`;
    svg.innerHTML=bg+`<polyline points="${right?w:0},8 ${right?0:w},2 ${right?0:w},14" fill="none" stroke="#C9962E" stroke-width="2" style="clip-path:${clip}"/>`;
    if(value>=100){ svg.innerHTML+=`<text x="${right?110:20}" y="13" fill="#D4472B" font-size="9" font-family="monospace">FINALE</text>`; }
  }
  function refreshHUD(){
    const f1=Fight.f1,f2=Fight.f2; if(!f1) return;
    $('p1name').textContent=f1.data.name; $('p2name').textContent=f2.data.name;
    $('p1name').style.color=f1.data.accentHex; $('p2name').style.color=f2.data.accentHex;
    $('p1hp').style.width=f1.hp+'%'; $('p2hp').style.width=f2.hp+'%';
    drawCrescendo('p1cres', f1.crescendo, false);
    drawCrescendo('p2cres', f2.crescendo, true);
    const pip=(n)=>`<span class="pip ${n>=1?'win':''}"></span><span class="pip ${n>=2?'win':''}"></span>`;
    $('p1rounds').innerHTML=pip(Fight.roundWins[0]); $('p2rounds').innerHTML=pip(Fight.roundWins[1]);
    $('rtimer').textContent=Math.ceil(Fight.timer);
    $('mvmt').textContent=`Movement ${['I','II','III'][Fight.round]||'III'}`;
  }
  let announceTimer=0;
  function announce(text, dur=1.4){ const a=$('announce'); a.textContent=text; a.style.transition='none'; a.style.opacity='1'; a.style.transform='translate(-50%,-50%) scale(1.15)';
    requestAnimationFrame(()=>{ a.style.transition='opacity .5s, transform .5s'; a.style.transform='translate(-50%,-50%) scale(1)'; });
    announceTimer=dur; }

  /* ---- buffer note-heads floating above fighter (3D) ---- */
  const bufferNotes={0:[],1:[]};
  function addBufferNote(side, note){
    const f=side===0?Fight.f1:Fight.f2; if(!f) return;
    const mat=new THREE.MeshStandardMaterial({color:COL.gold,emissive:COL.gold,emissiveIntensity:0.7});
    const m=new THREE.Group();
    const head=new THREE.Mesh(geo('moteHead'),mat); const stem=new THREE.Mesh(geo('moteStem'),mat); stem.position.set(0.1,0.22,0);
    m.add(head); m.add(stem);
    m.userData={note, life:2.0, idx:bufferNotes[side].length};
    scene.add(m); bufferNotes[side].push(m);
  }
  function updateBufferNotes(dt){
    for(const side of [0,1]){ const f=side===0?Fight.f1:Fight.f2; if(!f) continue;
      const arr=bufferNotes[side];
      for(let i=arr.length-1;i>=0;i--){ const m=arr[i]; m.userData.life-=dt;
        if(m.userData.life<=0){ scene.remove(m); arr.splice(i,1); continue; }
        const n=arr.length; const spread=0.4;
        m.position.set(f.x + (i-(n-1)/2)*spread, 3.0 + f.y, f.z);
        m.material && (m.children[0].material.opacity=1);
        const pop=Math.min(1,(2.0-m.userData.life)*8); m.scale.setScalar(0.9+Math.sin(pop*Math.PI)*0.3);
      }
    }
  }
  function clearBufferNotes(){ for(const s of [0,1]){ bufferNotes[s].forEach(m=>scene.remove(m)); bufferNotes[s]=[]; } }

  /* ---- AI input buffer display (notes above AI head — same as player) is handled by addBufferNote via events ---- */

  /* ---- pause movelist ---- */
  function buildMovelist(){
    const col=$('movelistCol'); let html='';
    ROSTER.forEach(f=>{ html+=`<div class="fname" style="color:${f.accentHex}">${f.name}</div>`;
      f.specials.forEach(s=> html+=`<div class="mv"><b>${s.name}</b> — <span class="notes">${s.notes.join(' ')}</span></div>`);
      html+=`<div class="mv"><b>Finale · ${f.finale.name}</b> — <span class="notes">${f.finale.notes.join(' ')}</span></div>`;
    });
    col.innerHTML=html;
  }

  /* ---- FIGHT EVENT SINK ---- */
  function onFightEvent(type,data){
    if(type==='buffer'){ addBufferNote(data.side,data.note); }
    else if(type==='announce'){ announce(data,1.4); }
    else if(type==='movement'){ /* movement label handled by HUD */ }
    else if(type==='special'){ announce(data.name, 1.0); }
    else if(type==='parry'){ announce('PARRY!',0.9); }
    else if(type==='fumble'){ announce('CLASH!',0.9); }
    else if(type==='block'){ flash(data.side); }
    else if(type==='onbeat'){ /* gold flash handled in VFX */ }
    else if(type==='finale'){ announce('FINALE — '+data.name, 2.2); }
    else if(type==='night'){ setNight(data); }
    else if(type==='ko'){ announce('K.O. — FINE', 2.4); clearBufferNotes(); }
    else if(type==='matchover'){ setTimeout(()=>showVictory(data.winner), 300); }
    else if(type==='hit'){ if(data.onbeat) flash(data.target); }
  }
  function flash(side){ const el=$(side===0?'p1flash':'p2flash'); el.style.transition='none'; el.style.opacity='0.7'; requestAnimationFrame(()=>{ el.style.transition='opacity .3s'; el.style.opacity='0'; }); }

  /* ---- night mode invert for finale ---- */
  let nightMode=false;
  function setNight(on){
    nightMode=on;
    if(on){ renderer.setClearColor(COL.night); scene.fog.color.setHex(COL.night); scene.background=null;
      App.key.color.setHex(COL.cream); }
    else { renderer.setClearColor(COL.paper); scene.fog.color.setHex(COL.paper); App.key.color.setHex(0xfff0d8); }
  }

  /* ---- victory ---- */
  function showVictory(winnerSide){
    setScreen('victory');
    const w=winnerSide===0?Fight.f1:Fight.f2;
    $('vwin').textContent=`${w.data.name} — Bravo!`; $('vwin').style.color=w.data.accentHex;
    // winner's motif flourish + slow orbit
    CameraDir.finale();
    const m=w.data.finale;
    m.notes.forEach((n,i)=>Audio.noteName(n,w.data.timbre,{when:i*0.16,pan:0,dur:0.3,gain:0.4}));
    Audio.cymbal();
  }

  /* ---- input wiring ---- */
  function wireInput(){
    Input.on({ down:(e)=>{
      Audio.init(); Audio.resume(); // unlock audio on first input (autoplay policy)
      const code=e.code;
      // global mute
      if(code==='KeyM'){ Audio.setMuted(!Audio.isMuted()); $('mutetag').textContent='M: sound '+(Audio.isMuted()?'off':'on'); return; }

      if(screen==='title'){ setScreen('select'); return; }

      if(screen==='select'){ handleSelectKey(code); return; }

      if(screen==='victory'){
        if(code==='KeyR'){ startFight(); }
        else if(code==='KeyS'){ selectStep='player'; setScreen('select'); }
        else if(code==='KeyT'){ setScreen('title'); }
        return;
      }

      if(screen==='fight'){
        if(code==='KeyP'||code==='Escape'){ togglePause(); return; }
        if(paused) return;
        // note keys
        if(KEYMAP[code]){ Fight.humanNote(KEYMAP[code]); return; }
        // movement actions
        Fight.humanAction(code);
      }
      if(screen==='pause'){ if(code==='KeyP'||code==='Escape') togglePause(); }
    }});
    // prevent page scroll on arrows/space
    window.addEventListener('keydown',e=>{ if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault(); },{passive:false});
  }
  function handleSelectKey(code){
    if(selectStep==='player'||selectStep==='opponent'){
      if(code==='ArrowLeft'){ selIndex=(selIndex+ROSTER.length-1)%ROSTER.length; Audio.tick(); }
      else if(code==='ArrowRight'){ selIndex=(selIndex+1)%ROSTER.length; Audio.tick(); }
      else if(code==='KeyR' && selectStep==='opponent'){ oppPick=Math.floor(Math.random()*ROSTER.length); selectStep='difficulty'; selIndex=diffIndex; updateSelectUI(); return; }
      else if(code==='Enter'){
        if(selectStep==='player'){ playerPick=selIndex; selectStep='opponent'; selIndex=(playerPick+1)%ROSTER.length; }
        else { oppPick=selIndex; selectStep='difficulty'; }
      }
      updateSelectUI();
    } else { // difficulty
      if(code==='ArrowLeft'){ diffIndex=(diffIndex+DIFFICULTIES.length-1)%DIFFICULTIES.length; Audio.tick(); }
      else if(code==='ArrowRight'){ diffIndex=(diffIndex+1)%DIFFICULTIES.length; Audio.tick(); }
      else if(code==='Enter'){ startFight(); }
      updateSelectUI();
    }
  }

  function togglePause(){ paused=!paused; if(paused){ buildMovelist(); setScreen('pause'); } else { setScreen('fight'); } }

  function startFight(){
    // clean previous fighters if any
    if(Fight.f1){ scene.remove(Fight.f1.group); scene.remove(Fight.f2.group); clearBufferNotes(); }
    setNight(false);
    setScreen('fight');
    paused=false;
    Fight.onEvent=onFightEvent;
    Fight.lastBeat=0;
    Fight.begin(scene, ROSTER[playerPick], ROSTER[oppPick], DIFFICULTIES[diffIndex].id, 0);
    // set rim lights to fighters' accents
    App.rimA.color.setHex(ROSTER[playerPick].accent);
    App.rimB.color.setHex(ROSTER[oppPick].accent);
  }

  /* ---- main loop ---- */
  function loop(){
    rafId=requestAnimationFrame(loop);
    let dt=clock.getDelta(); if(dt>0.05) dt=0.05;
    // slow-motion from camera director during cinematics
    const slow=CameraDir.getSlowmo();
    Fight.timeScale = slow;

    // stage ambient animation
    animateStage(dt);

    if(screen==='fight' && !paused){
      Fight.update(dt);
      refreshHUD();
      updateBufferNotes(dt);
    }
    if(screen==='title'){ titleT+=dt; camera.position.set(Math.sin(titleT*0.2)*4, 6+Math.sin(titleT*0.3)*1, 20); camera.lookAt(0,3,0);
      if(titleGroup){ titleGroup.children.forEach((c,i)=>{ c.position.y += Math.sin(titleT*2+i)*0.002; }); }
    } else {
      CameraDir.update(dt*(screen==='fight'&&!paused?1:1));
    }
    Shake.apply(camera,dt);

    // rim light follow
    if(Fight.f1 && screen==='fight'){ App.rimA.position.set(Fight.f1.x-2,3,4); App.rimA.intensity=1.4;
      App.rimB.position.set(Fight.f2.x+2,3,4); App.rimB.intensity=1.4; }

    VFX.update(dt); Shock.update(dt);
    // announce fade
    if(announceTimer>0){ announceTimer-=dt; if(announceTimer<=0){ $('announce').style.opacity='0'; } }

    renderer.render(scene,camera);
  }
  function animateStage(dt){
    const g=stage; const now=(g.userData._t=(g.userData._t||0)+dt);
    // metronome pendulum swings at stage tempo (only while fighting)
    if(g.userData.pen){ const bpm=Fight.tempoBPM||90; const w=(bpm/60)*Math.PI;
      const on = (screen==='fight'); g.userData.pen.rotation.z = on? Math.sin(Fight.beatClock*w)*0.5 : Math.sin(now*0.8)*0.2; }
    // drifting motes
    (g.userData.motes||[]).forEach(m=>{ m.position.x+=m.userData.sp*dt*0.4; if(m.position.x>26)m.position.x=-26;
      m.rotation.z+=m.userData.rot; m.position.y=m.userData.base+Math.sin(now+m.userData.ph)*0.4; });
    // parallax bars
    (g.userData.bars||[]).forEach(b=>{ b.position.x+=b.userData.speed*dt; if(b.position.x>50)b.position.x=-50; });
  }

  return { init:initThree, wire:wireInput, get renderer(){return renderer;}, key:null, rimA:null, rimB:null };
})();

/* ================================ BOOT ================================== */
App.init();
App.wire();
