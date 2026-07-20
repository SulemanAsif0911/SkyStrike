import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =========================================================================
   SKYSTRIKE — Fighter Jet Simulator
   Single-module game engine.
   ========================================================================= */

/* ---------------------------- constants ---------------------------- */
// flip180: manual override — the geometry-based nose-detector guesses the nose is whichever end
// has a narrower cross-section. That's backwards for the F-16 model specifically (its tail-nozzle
// cross-section reads narrower than its front intake/fuselage section); F-35 and F-14 detect fine.
const JET_DEFS = [
  { id:'f16', name:'F-16C Block 50', file:'models/f16.glb', desc:'Agile multirole fighter', maxSpeed:210, accel:0.9, turnRate:2.6, flip180:true },
  { id:'f35', name:'F-35 Lightning II', file:'models/f35.glb', desc:'Stealth strike fighter', maxSpeed:195, accel:0.8, turnRate:2.3, flip180:false },
  { id:'f14', name:'F-14 Tomcat', file:'models/f14.glb', desc:'Heavy swing-wing interceptor', maxSpeed:225, accel:0.7, turnRate:2.0, flip180:false },
];
const TARGET_JET_LENGTH = 18;         // normalized in-game length (meters-ish) of every jet model
const SEA_LEVEL = 0;
const MIN_SAFE_ALT = 6;               // below this over the wave surface = crash/splash
const CHECKPOINT_RADIUS = 130;
const CHECKPOINT_TUBE = 7;
const CHECKPOINT_TRIGGER_DIST = 140;  // sphere trigger radius
const WORLD_UP = new THREE.Vector3(0,1,0);

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const lerp = (a,b,t)=>a+(b-a)*t;
const rand = (a,b)=>a+Math.random()*(b-a);
const degToRad = THREE.MathUtils.degToRad;
const radToDeg = THREE.MathUtils.radToDeg;

function fmtTime(sec){
  if (sec == null || !isFinite(sec)) return '--:--.-';
  const m = Math.floor(sec/60);
  const s = (sec - m*60).toFixed(1).padStart(4,'0');
  return `${m}:${s}`;
}

/* ---------------------------- procedural audio ---------------------------- */
// Real recorded audio, layered in on top of (and eventually crossfaded over) the procedural
// synthesis below. Every file here is optional: if it's missing or fails to decode, the game
// just keeps using the synthesized version — nothing breaks. Drop matching files into
// assets/audio/ to upgrade a sound; see assets/audio/README.md for exact sources/licenses.
const AUDIO_ASSET_BASE = 'assets/audio/';
const SAMPLE_FILES = {
  engine: 'engine_loop.mp3',   // continuous, looped, pitch-shifted with speed
  wind: 'wind_loop.mp3',       // continuous, looped, gain follows speed
  splash: 'splash.mp3',        // one-shot, played on water impact
};

class FlightAudio {
  constructor(){
    this.ctx = null; this.engineGain = null; this.windGain = null; this.started = false;
    this.sampleBuffers = {};     // name -> decoded AudioBuffer, once loaded
    this.sampleReady = { engine:false, wind:false, splash:false };
  }
  _makeNoiseBuffer(seconds){
    const ctx = this.ctx;
    const bufSize = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) data[i] = Math.random()*2-1;
    return buf;
  }
  ensure(){
    if (this.started) return;
    this.started = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    // Engine: layered synthesis instead of a single tone, so it reads as a turbine rather than
    // a clean electronic drone. A pair of detuned oscillators a couple Hz apart (the original
    // approach here) beats at that couple-Hz rate — which is exactly the amplitude-modulation
    // pattern that makes something sound like a buzzing insect. Real engine noise is mostly
    // broadband (combustion/airflow turbulence) with a rough, moving tonal core underneath, so
    // we build that instead: sub rumble + a 3-voice growl core (wide, non-beating detune spread)
    // through a swept filter + broadband roar + a thin high whine, all mixed into one bus.
    this.master = ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(ctx.destination);
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.0; this.engineGain.connect(this.master);

    // sub rumble — low-end weight
    this.engineSub = ctx.createOscillator(); this.engineSub.type = 'triangle'; this.engineSub.frequency.value = 42;
    this.engineSubGain = ctx.createGain(); this.engineSubGain.gain.value = 0.55;
    this.engineSub.connect(this.engineSubGain); this.engineSubGain.connect(this.engineGain);
    this.engineSub.start();

    // growl core — 3 sawtooths spread across a wide, deliberately non-simple detune ratio
    // (not a fixed Hz offset) so there's no single dominant slow beat frequency.
    this.engineGrowlOscs = [-1, 0, 1].map(i=>{
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = i*23 + (i?  (i>0?7:-11) : 0);
      return o;
    });
    this.engineGrowlFilter = ctx.createBiquadFilter(); this.engineGrowlFilter.type = 'bandpass';
    this.engineGrowlFilter.frequency.value = 220; this.engineGrowlFilter.Q.value = 0.9;
    this.engineGrowlGain = ctx.createGain(); this.engineGrowlGain.gain.value = 0.5;
    this.engineGrowlOscs.forEach(o=>{ o.connect(this.engineGrowlFilter); o.start(); });
    this.engineGrowlFilter.connect(this.engineGrowlGain); this.engineGrowlGain.connect(this.engineGain);

    // broadband roar — filtered noise, the part that actually makes it sound like moving air
    // and hot exhaust rather than a synthesizer.
    this.engineRoarSrc = ctx.createBufferSource();
    this.engineRoarSrc.buffer = this._makeNoiseBuffer(2); this.engineRoarSrc.loop = true;
    this.engineRoarFilter = ctx.createBiquadFilter(); this.engineRoarFilter.type = 'bandpass';
    this.engineRoarFilter.frequency.value = 900; this.engineRoarFilter.Q.value = 0.7;
    this.engineRoarGain = ctx.createGain(); this.engineRoarGain.gain.value = 0.35;
    this.engineRoarSrc.connect(this.engineRoarFilter); this.engineRoarFilter.connect(this.engineRoarGain);
    this.engineRoarGain.connect(this.engineGain);
    this.engineRoarSrc.start();

    // thin high whine — the compressor whistle, subtle, with a slow vibrato so it doesn't
    // read as a pure electronic tone either.
    this.engineWhine = ctx.createOscillator(); this.engineWhine.type = 'sine'; this.engineWhine.frequency.value = 1800;
    this.engineWhineVibrato = ctx.createOscillator(); this.engineWhineVibrato.type = 'sine'; this.engineWhineVibrato.frequency.value = 4.3;
    this.engineWhineVibratoGain = ctx.createGain(); this.engineWhineVibratoGain.gain.value = 12;
    this.engineWhineVibrato.connect(this.engineWhineVibratoGain); this.engineWhineVibratoGain.connect(this.engineWhine.frequency);
    this.engineWhineGain = ctx.createGain(); this.engineWhineGain.gain.value = 0.05;
    this.engineWhine.connect(this.engineWhineGain); this.engineWhineGain.connect(this.engineGain);
    this.engineWhine.start(); this.engineWhineVibrato.start();

    // slow flutter — gentle overall-gain wobble, strongest at idle, smoothing out at high power
    this.engineFlutter = ctx.createOscillator(); this.engineFlutter.type = 'sine'; this.engineFlutter.frequency.value = 3.1;
    this.engineFlutterGain = ctx.createGain(); this.engineFlutterGain.gain.value = 0.05;
    this.engineFlutter.connect(this.engineFlutterGain); this.engineFlutterGain.connect(this.engineGain.gain);
    this.engineFlutter.start();

    // wind noise
    this.noise = ctx.createBufferSource(); this.noise.buffer = this._makeNoiseBuffer(2); this.noise.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type='bandpass'; this.windFilter.frequency.value=800; this.windFilter.Q.value=0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.0;
    this.noise.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.master);
    this.noise.start();

    // real-sample gain stages (silent until their buffer is loaded and crossfaded in)
    this.sampleGainEngine = ctx.createGain(); this.sampleGainEngine.gain.value = 0.0; this.sampleGainEngine.connect(this.master);
    this.sampleGainWind = ctx.createGain(); this.sampleGainWind.gain.value = 0.0; this.sampleGainWind.connect(this.master);

    this._loadSamples();
  }

  async _loadSamples(){
    const ctx = this.ctx;
    const loadOne = async (name, file)=>{
      try{
        const res = await fetch(AUDIO_ASSET_BASE + file);
        if (!res.ok) return;
        const arr = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arr);
        this.sampleBuffers[name] = decoded;
        this.sampleReady[name] = true;
        if (name === 'engine' || name === 'wind'){
          const src = ctx.createBufferSource();
          src.buffer = decoded; src.loop = true;
          src.connect(name === 'engine' ? this.sampleGainEngine : this.sampleGainWind);
          src.start();
          if (name === 'engine') this.sampleSourceEngine = src; else this.sampleSourceWind = src;
        }
      } catch(e){
        // missing/undecodable file — silently keep the procedural fallback for this sound
      }
    };
    await Promise.all(Object.entries(SAMPLE_FILES).map(([name,file])=>loadOne(name,file)));
  }

  update(speedFrac, boosting){
    if (!this.started) return;
    const t = this.ctx.currentTime;

    if (this.sampleReady.engine){
      // real engine loop: fade out the synth, fade in the sample, pitch it up with speed
      this.engineGain.gain.setTargetAtTime(0, t, 0.15);
      this.sampleGainEngine.gain.setTargetAtTime(0.35 + speedFrac*0.5 + (boosting?0.15:0), t, 0.12);
      this.sampleSourceEngine.playbackRate.setTargetAtTime(0.55 + speedFrac*0.85 + (boosting?0.15:0), t, 0.15);
    } else {
      const boost = boosting ? 1 : 0;
      this.engineSub.frequency.setTargetAtTime(38 + speedFrac*30, t, 0.15);
      this.engineSubGain.gain.setTargetAtTime(0.32 + speedFrac*0.16, t, 0.15);

      const growlFreq = 65 + speedFrac*130;
      this.engineGrowlOscs.forEach(o=>o.frequency.setTargetAtTime(growlFreq, t, 0.1));
      this.engineGrowlFilter.frequency.setTargetAtTime(260 + speedFrac*900 + boost*300, t, 0.12);
      this.engineGrowlGain.gain.setTargetAtTime(0.2 + speedFrac*0.18, t, 0.1);

      this.engineRoarFilter.frequency.setTargetAtTime(700 + speedFrac*2600 + boost*500, t, 0.12);
      this.engineRoarGain.gain.setTargetAtTime(0.14 + speedFrac*0.26 + boost*0.12, t, 0.1);

      this.engineWhine.frequency.setTargetAtTime(1400 + speedFrac*2200 + boost*300, t, 0.12);
      this.engineWhineGain.gain.setTargetAtTime(0.03 + speedFrac*0.08, t, 0.15);

      this.engineFlutterGain.gain.setTargetAtTime(0.06 * (1-speedFrac*0.7), t, 0.2);

      this.engineGain.gain.setTargetAtTime(0.4 + speedFrac*0.28 + boost*0.12, t, 0.1);
    }

    if (this.sampleReady.wind){
      this.windGain.gain.setTargetAtTime(0, t, 0.2);
      this.sampleGainWind.gain.setTargetAtTime(0.08 + speedFrac*0.4, t, 0.15);
    } else {
      this.windGain.gain.setTargetAtTime(0.03 + speedFrac*0.22, t, 0.15);
      this.windFilter.frequency.setTargetAtTime(500 + speedFrac*3000, t, 0.15);
    }
  }
  blip(freqStart, freqEnd, dur, gainAmt=0.25, type='sine'){
    if (!this.started) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.type = type;
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20,freqEnd), ctx.currentTime+dur);
    g.gain.setValueAtTime(gainAmt, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
    osc.connect(g); g.connect(this.master);
    osc.start(); osc.stop(ctx.currentTime+dur+0.02);
  }
  checkpointChime(){ this.blip(660,1320,0.35,0.3,'triangle'); setTimeout(()=>this.blip(880,1760,0.3,0.22,'triangle'),80); }
  splash(){
    if (!this.started) return;
    if (this.sampleReady.splash){
      const ctx = this.ctx;
      const src = ctx.createBufferSource(); src.buffer = this.sampleBuffers.splash;
      const g = ctx.createGain(); g.gain.value = 0.7;
      src.connect(g); g.connect(this.master);
      src.start();
      return;
    }
    this._proceduralSplash();
  }
  _proceduralSplash(){
    const ctx = this.ctx;
    const bufSize = ctx.sampleRate*0.4;
    const buf = ctx.createBuffer(1,bufSize,ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) d[i] = (Math.random()*2-1) * (1 - i/bufSize);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=1200;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start();
  }
  finishFanfare(){ this.blip(440,880,0.2,0.3,'square'); setTimeout(()=>this.blip(660,1320,0.25,0.3,'square'),150); setTimeout(()=>this.blip(880,1760,0.4,0.32,'square'),320); }
}
const audio = new FlightAudio();

export { THREE, GLTFLoader, JET_DEFS, TARGET_JET_LENGTH, SEA_LEVEL, MIN_SAFE_ALT, CHECKPOINT_RADIUS,
  CHECKPOINT_TUBE, CHECKPOINT_TRIGGER_DIST, WORLD_UP, clamp, lerp, rand, degToRad, radToDeg, fmtTime, audio };
