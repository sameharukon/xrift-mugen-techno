// @ts-nocheck
/*
 * Techno generator engine + conductor (intent / DJ logic), ported from
 * sameharukon/techno-generator-1 live/index.html (script section, engine part).
 * Changes vs. original:
 *  - master output connects to `opts.dest` (spatial panner) instead of ctx.destination
 *  - DOM UI, visualizer, Worker/Blob ticker and the OfflineAudioContext test hook are removed
 *    (live transport lives in ./transport.ts)
 * Engine and Conductor share module-level state (S, tables), so they stay in one module.
 */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const KEYS=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MINOR_PENT=[0,3,5,7,10];
const PARTS=["kick","hat","clap","perc","bass","stab"];
const PART_JA={kick:"キック",hat:"ハット",clap:"クラップ",perc:"パーカッション",bass:"ベース",stab:"上モノ"};
// style families; the actual name / tempo / kick flavour depends on the set's tempo band (STYLE_BAND, KICK_BAND)
const STYLES={minimal:{ja:"ミニマル",bpm:124},hard:{ja:"ハードテクノ",bpm:144},groove:{ja:"ハードグルーヴ",bpm:136},tribal:{ja:"トライバル",bpm:126},broken:{ja:"ブレイクビート風",bpm:125}};
// base settings (詳細設定). The conductor's intent parameters modulate these.
const S={key:9,cutoff:0.5,sweep:true,dmix:0.35,dfb:0.42,variation:0.5,vol:0.8,style:"minimal",band:"b120",
  dropManual:false,fill:true,riser:true,crash:true,
  };
// ---------- Tempo bands (set modes) ----------
// A set stays in one tempo band; styles have a variant per band, the tempo only drifts slowly (<= 0.5 BPM / phrase).
const BANDS={
  // chill-only set: dub / ambient / deep techno, downtempo. Gentle swells instead of hard peaks; the whole set is chill, so no extra chill episodes
  bchill:{ja:"チル帯",min:110,max:122,center:116,start:114,first:"hard",arc:{warm:113,build:115.5,peak:118,release:114.5},noChill:true,
    phaseE:{warm:.24,build:.33,peak:.42,release:.27,chill:.18},phaseJa:{peak:"スウェル"},
    pool:{warm:["hard","minimal"],build:["groove","tribal","broken"],peak:["groove","minimal","tribal"],release:["hard","broken","minimal"]},
    chillW:{soft4:1,half:1.5,beatless:2}},
  b120:{ja:"120帯",min:121,max:130,center:125,start:123.5,first:"minimal",arc:{warm:123,build:125,peak:127.5,release:125},
    pool:{warm:["minimal","broken"],build:["tribal","groove","broken"],peak:["hard","groove","tribal"],release:["minimal","broken","tribal"]}},
  b140:{ja:"140帯",min:134,max:148,center:140,start:137,first:"groove",arc:{warm:137,build:140,peak:144,release:140},
    pool:{warm:["groove","minimal"],build:["tribal","groove","broken"],peak:["hard","tribal","hard"],release:["groove","minimal","tribal"]}},
};
const PHASES=["warm","build","peak","release"],PHASE_JA={warm:"ウォームアップ",build:"ビルド",peak:"ピーク",release:"リリース",chill:"チル",opening:"オープニング",closing:"クロージング"},PHASE_E={warm:.38,build:.6,peak:.88,release:.5,chill:.22};
// chill episode: same band / same tempo rules, softer rounded kick (or half-time / brief beatless), warm pads, dubby space, fewer hats
const phJa=(ph,band=S.band)=>((BANDS[band]||{}).phaseJa||{})[ph]||PHASE_JA[ph];
const phE=(ph,band=S.band)=>((BANDS[band]||{}).phaseE||PHASE_E)[ph];
const CHILL_MODE_JA={soft4:"丸いキックの4つ打ち",half:"ハーフタイム",beatless:"ビートレス"};
const chillKick=(st,band)=>({...kickParams(st,band),f0:125,f1:45,sw:0.14,tau:0.12,click:0.1,len:band==="b160"?0.34:0.5,drive:0,rumble:0,gab:0});
const STYLE_BAND={b120:{minimal:{bpm:124,ja:"ミニマル"},tribal:{bpm:126,ja:"トライバル"},broken:{bpm:125,ja:"ブロークン"},groove:{bpm:127,ja:"グルーヴィー"},hard:{bpm:129,ja:"インダストリアル"}},
  b140:{minimal:{bpm:138,ja:"ハイプノティック"},groove:{bpm:136,ja:"ハードグルーヴ"},tribal:{bpm:140,ja:"ピークタイム・トライバル"},broken:{bpm:139,ja:"ブロークン（速め）"},hard:{bpm:144,ja:"ハードテクノ"}},
  bchill:{minimal:{bpm:116,ja:"ディープ・ミニマル"},groove:{bpm:117,ja:"ダブテクノ"},tribal:{bpm:115,ja:"オーガニック・ローファイ"},broken:{bpm:114,ja:"ダウンテンポ（ハーフタイム）"},hard:{bpm:113,ja:"アンビエント・テクノ"}}};
const styleJa=(st,band=S.band)=>(STYLE_BAND[band]&&STYLE_BAND[band][st]||STYLES[st]).ja;
// kick timbre as continuous parameters (drive = hard saturation share, rumble = reverb/distortion tail send)
const KICK_BASE={minimal:{f0:160,f1:48,sw:0.12,tau:0.16,click:0.35,len:0.6,drive:0,rumble:0,gab:0},
  hard:{f0:200,f1:46,sw:0.09,tau:0.22,click:0.45,len:0.8,drive:1,rumble:1,gab:0},
  groove:{f0:170,f1:52,sw:0.06,tau:0.085,click:0.55,len:0.4,drive:0.1,rumble:0,gab:0},
  tribal:{f0:140,f1:43,sw:0.13,tau:0.18,click:0.25,len:0.6,drive:0,rumble:0.05,gab:0},
  broken:{f0:165,f1:48,sw:0.1,tau:0.13,click:0.4,len:0.5,drive:0.05,rumble:0,gab:0}};
// band flavour: in the 140 set every kick is somewhat driven/rumbly (close to the hard kick); the 120 set's industrial kick is milder
const KICK_BAND={b120:{hard:{f0:185,drive:0.55,rumble:0.5,tau:0.19,len:0.7}},
  b140:{minimal:{drive:0.4,rumble:0.4,tau:0.18,len:0.65},groove:{drive:0.5,rumble:0.3,tau:0.11,len:0.5},tribal:{drive:0.4,rumble:0.45,tau:0.19,len:0.65},broken:{drive:0.45,rumble:0.25,len:0.55}},
  // 160: every kick strongly saturated and tonal; lengths stay under one beat (0.375 s) so the tail never smears into the next kick.
  // hardcore: pitched kick with a long distorted tonal tail (the tail IS the bass); schranz: hard rolling kick + rumble
  // chill band: soft, round, un-driven kicks (dub techno gets a little rumble for the classic low-end smear)
  bchill:{minimal:{f0:140,f1:46,sw:0.12,tau:0.15,click:0.18,len:0.5,drive:0,rumble:0.1},groove:{f0:130,f1:44,sw:0.14,tau:0.17,click:0.12,len:0.55,drive:0,rumble:0.3},
    tribal:{f0:125,f1:43,sw:0.13,tau:0.16,click:0.15,len:0.5,drive:0,rumble:0.1},broken:{f0:150,f1:48,sw:0.1,tau:0.14,click:0.25,len:0.45,drive:0,rumble:0},
    hard:{f0:115,f1:42,sw:0.15,tau:0.13,click:0.08,len:0.45,drive:0,rumble:0.2}},
  b160:{minimal:{f0:190,f1:50,sw:0.07,tau:0.15,click:0.4,len:0.3,drive:0.8,rumble:0.7,gab:0.2},
    groove:{f0:210,f1:52,sw:0.06,tau:0.13,click:0.5,len:0.28,drive:1,rumble:0.6,gab:0.35},
    tribal:{f0:180,f1:48,sw:0.08,tau:0.14,click:0.35,len:0.28,drive:0.8,rumble:0.5,gab:0.25},
    broken:{f0:250,f1:53,sw:0.05,tau:0.22,click:0.2,len:0.3,drive:1,rumble:0.3,gab:0.6},
    hard:{f0:330,f1:55,sw:0.045,tau:0.3,click:0.55,len:0.35,drive:1,rumble:0.15,gab:1}}};
// glue fields (all kicks carry them so kick morphs interpolate): tune = pull the tail pitch onto the key root (A1-ish), gabLp / gabPk = tone of the
// hardcore-distortion path (lowpass Hz / 1.7 kHz peak dB), scBass = bass sidechain depth, scUp = 上モノ bus sidechain depth, room = kick send into the shared space
const KICK_GLUE={tune:0,gabLp:6500,gabPk:3,scBass:0.6,scUp:0,room:0,kLvl:1};
// クロスブリード (v12): tail tuned to the root (was ≈49–51 Hz against the A1/E1 off-beat bass → beating), less hardcore path / click / presence,
// bass + 上モノ breathe with the kick, a touch of the shared room on the kick
const KICK_GLUE_BAND={b160:{broken:{tune:1,gabLp:3200,gabPk:1,scBass:0.9,scUp:0.35,room:0.06,kLvl:0.8}}};
const kickParams=(st,band)=>({...KICK_GLUE,...KICK_BASE[st],...((KICK_BAND[band]||{})[st]||{}),...((KICK_GLUE_BAND[band]||{})[st]||{})});
const kickDist=(a,b)=>Math.abs(a.drive-b.drive)+Math.abs(a.rumble-b.rumble)+Math.abs(a.tau-b.tau)*4+Math.abs(a.f0-b.f0)/100+Math.abs((a.gab||0)-(b.gab||0));
// 160: bass treatment per style. none = the kick tail / rumble is the bass (no extra low end, no mud); off = short off-beat notes only
const BASS160={hard:"none",groove:"none",minimal:"none",tribal:"off",broken:"off"};
// chill band bass: ambient = long sparse notes, downtempo = half density
const BASSCH={hard:"sparse",broken:"half"};
// kick-drop recipes
const KD_REM_JA={kick:"キックのみ",kickbass:"キック＋ベース",lowcut:"ローカット",thin:"細いキック",beat1:"1拍目だけ",offbeat:"裏打ちキック"};
const KD_FILL_JA={coreRoll:"ハードコア・キックロール",snare16:"スネア16分",snareBuild:"スネア加速",triplet:"3連スネア",kickroll8:"キックロール8分",kickroll16:"キックロール16分",tom:"タムフィル",revcym:"リバースシンバル",gap:"無音ギャップ",echo:"エコースロー",none:"フィルなし"};
const KD_RISER_JA={noise:"ノイズライザー",pitch:"ピッチライザー",none:""};
const KD_IMP_JA={crash:"クラッシュ",boom:"サブブーム",crashboom:"クラッシュ＋ブーム",none:"インパクトなし"};
const kdName=R=>[R.micro?(R.micro===2?"半拍":"1拍"):`${R.len}小節`,KD_REM_JA[R.remove],KD_FILL_JA[R.fill],KD_RISER_JA[R.riser],KD_IMP_JA[R.impact]].filter(Boolean).join("・")+(R.pos==="pickup"?"（フレーズ途中）":"");
const KD_DEFAULT={remove:"kick",fill:"snare16",riser:"noise",impact:"crash",micro:0};

const cutoffHz=v=>Math.round(120*Math.pow(2000/120,v));
const keyOff=()=>(((S.key-9)+17)%12-5);
const mtof=m=>440*Math.pow(2,(m-69)/12);
// ---------- v13: key / mode / harmony (per set, per deck; DJ-style key-compatible mixes) ----------
const KEY_NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const pcOf=k=>((k%12)+12)%12,offOf=k=>(((pcOf(k)-9)+17)%12-5);
const camelot=k=>(((7*(pcOf(k)-9)+7)%12)+12)%12+1;            // minor keys on the Camelot wheel: Am=8A, Em=9A, Dm=7A
const keyName=k=>KEY_NAMES[pcOf(k)]+"m",keyLabel=k=>`${keyName(k)}（${camelot(k)}A）`;
const MODES={aeolian:[0,2,3,5,7,8,10],dorian:[0,2,3,5,7,9,10],phrygian:[0,1,3,5,7,8,10],minpent:[0,3,5,7,10]};
const MODE_JA={aeolian:"エオリアン",dorian:"ドリアン",phrygian:"フリジアン",minpent:"マイナーペンタ"};
// v14: natural minor most of the time; phrygian now and then for hard / 160, dorian now and then for groove / chill
const MODE_W={minimal:{aeolian:1},hard:{aeolian:.75,phrygian:.25},groove:{aeolian:.72,dorian:.28},tribal:{aeolian:1},broken:{aeolian:1}};
const MODE_W160={aeolian:.75,phrygian:.25};
const MODE_W_CH={aeolian:.72,dorian:.28};
// v14: set keys only with roots F..B (sub root ~44-62 Hz, same register as the A-minor home); A minor is the home key
const KEY_W={9:.45,7:.11,8:.11,10:.11,5:.08,6:.07,11:.07};
// chord-root progressions (semitones above the key root, one chord per H.len bars); filtered to the deck's mode
const PROGS=[[0,0,0,0],[0,0,10,10],[0,0,8,8],[0,8,10,0],[0,5,0,5],[0,10,8,10],[0,3,10,8],[0,0,0,10],[0,0,1,0],[0,0,5,7],[0,8,3,10],[0,10,0,10],[0,0,5,5],[0,5,10,3]];
const PROG_W={minimal:[1.5,1,1,0,1,0,0,1,0,0,0,0,.6,0],hard:[3,0,0,0,0,0,0,1,2,0,0,.6,0,0],groove:[.5,1,0,0,1.5,1,.8,0,0,.6,0,0,.6,.6],
  tribal:[1.5,0,0,0,0,0,0,.6,.5,0,0,1,1,0],broken:[.8,1,0,1,0,0,.6,0,0,.6,1,0,0,0],chill:[0,.6,.6,1,.6,1,1,0,0,0,1.5,0,0,1]};
const pickW=(r,W)=>{const ks=Object.keys(W);let x=r()*ks.reduce((a,k)=>a+W[k],0);for(const k of ks){x-=W[k];if(x<=0)return k;}return ks[ks.length-1];};
// nearest tone of the scale (rel = semitones above the key root, any octave); ties resolve downward
const snapTo=(rel,sc)=>{let best=rel,bd=99;for(let o=-1;o<=1;o++)for(const x of sc){const c=Math.floor(rel/12)*12+12*o+x,d=Math.abs(c-rel)+(c>rel?0.01:0);if(d<bd){bd=d;best=c;}}return best;};

// ---------- Break library ----------
// each break: length range (bars), default length, energy range where it fits, tension it creates, whether the
// classic snare fill / crash is used on the return. Part masks + effects live in Engine.breakMask / dropStart / armReturn.
const BREAKS={
  kick:     {ja:"キック抜き",len:[1,8],def:2,energy:[0,1],tension:.5,fill:true,crash:true,desc:"キックだけ抜いてライザーで溜める"},
  breakdown:{ja:"フルブレイクダウン",len:[8,16],def:8,energy:[.3,1],tension:.9,fill:false,crash:true,desc:"ドラム・ベースが抜けて上モノ＋パッドだけ、最後の2小節でスネアロール＋ライザー"},
  filter:   {ja:"フィルターブレイク",len:[2,8],def:4,energy:[0,.85],tension:.4,fill:true,crash:true,desc:"マスターLPFで隣の部屋のようにこもらせ、最後の1拍で開く"},
  hpbuild:  {ja:"ハイパスビルド",len:[2,8],def:4,energy:[.35,1],tension:.8,fill:false,crash:true,desc:"HPFで全体を少しずつ細くし、最後の小節はキックとベースを抜いてドロップ"},
  bassonly: {ja:"ベースだけ",len:[2,4],def:2,energy:[.3,1],tension:.4,fill:true,crash:true,desc:"キック＋ベースだけを残す"},
  perconly: {ja:"パーカッションだけ",len:[2,4],def:2,energy:[0,.85],tension:.35,fill:true,crash:true,desc:"ハット・クラップ・パーカッションだけを残す"},
  tapestop: {ja:"テープストップ",len:[1,1],def:1,energy:[.3,1],tension:.6,fill:false,crash:true,desc:"後半2拍で全体がピッチダウンして止まり、次の1拍目で再始動"},
  stutter:  {ja:"スタッター",len:[1,1],def:1,energy:[.35,1],tension:.7,fill:false,crash:true,desc:"後半2拍を8分→16分→32分で連打（ビートリピート）"},
  echo:     {ja:"エコーアウト",len:[1,2],def:1,energy:[0,1],tension:.5,fill:false,crash:true,desc:"ドライを切ってダブ・ディレイの残響だけを残す"},
  halftime: {ja:"ハーフタイム",len:[4,8],def:4,energy:[.3,1],tension:.45,fill:true,crash:true,desc:"キック1拍目・スネア3拍目の半分のノリ、ベースも半分の速さに"},
  silence:  {ja:"サイレンス",len:[1,1],def:1,energy:[.3,1],tension:.7,fill:false,crash:true,desc:"最後の1拍だけほぼ無音にしてドロップ"},
  // internal: opening (start of the set) and closing outro (end of the set)
  intro:    {ja:"オープニング",len:[16,16],def:16,energy:[0,1],tension:.3,fill:false,crash:true,internal:true,desc:"パッドとフィルターのかかったパーカッションから始め、16小節目でキックイン"},
  outro:    {ja:"アウトロ",len:[8,8],def:8,energy:[0,1],tension:.1,fill:false,crash:false,internal:true,desc:"キックアウト＋エコー／リバーブの余韻、要素を順に抜いてフェードアウト"},
  // internal: used only for tempo-band changes (beatless, tempo moves while no kick plays)
  bridge:   {ja:"アンビエント・ブリッジ",len:[6,8],def:8,energy:[0,1],tension:.3,fill:false,crash:true,internal:true,desc:"ビートレスのパッドだけにして、その間にテンポを切り替える"}};
const BREAK_ORDER=Object.keys(BREAKS).filter(k=>!BREAKS[k].internal);
const M_ALL={k:1,h:1,c:1,p:1,b:1,u:1},M_NONE={k:0,h:0,c:0,p:0,b:0,u:0};
// style affinity for automatic choice
const BREAK_AFFINITY={minimal:{filter:1.6,echo:1.5,perconly:1.4,kick:1.2},hard:{tapestop:1.6,stutter:1.5,hpbuild:1.5,silence:1.4},
  groove:{bassonly:1.5,stutter:1.4,filter:1.3,perconly:1.3},tribal:{perconly:1.7,halftime:1.4,breakdown:1.3,echo:1.2},broken:{halftime:1.6,stutter:1.4,echo:1.3,tapestop:1.2}};

// ---------- Pattern generator ----------
class Patterns{
  constructor(rand){this.r=rand;this.bar=0;this.ghost=0.35;this.openHat=false;this.init();}
  init(){
    const r=this.r;
    // v13: the bass line is generated per seed (rhythm family + degrees), the old fixed line is one of the options
    const BT=[[2,3,6,7,10,11,14,15],[2,6,10,14],[2,6,7,10,14,15],[1,2,6,9,10,14],[2,3,6,10,11,14],[3,6,10,13],[2,5,6,10,13,14],[2,6,9,10,14,15]];
    const base=r()<0.2?[[2,0,0],[3,0,0],[6,0,1],[7,0,0],[10,1,0],[11,0,0],[14,3,-1],[15,0,0]]
      :BT[Math.floor(r()*BT.length)].map((s,i)=>[s,i===0||r()<0.5?0:1+Math.floor(r()*4),r()<0.14?1:(r()<0.06?-1:0)]);
    this.bass=Array.from({length:16},()=>null);
    for(const [s,d,o] of base) this.bass[s]={deg:d,oct:o};
    this.bassFill=null;this.answerBass();
    this.stab=new Set([3]);this.stabAlt=new Set([11,14]);
    this.hatAccent=Array.from({length:16},()=>0.8+0.25*r());
    // hard groove: extra kick probability + shaker probabilities
    this.grooveExtra=0.35;
    this.shaker=Array.from({length:16},(_,s)=>s%4===2?0.95:(s%2?0.55:0.3));
    // tribal: 3-over-4 cycle + 12/8-feel accents (3+3+2 / 3+3+3+3+4)
    this.trib={cyc:3,off:0,voiceA:1,b:[0,-1,-1,2,-1,-1,0,-1,1,-1,-1,2,-1,-1,1,-1],prob:0.85,ghost:0.15};
    // broken kick
    this.broken=new Set([0,6,10]);
    // 160 schranz loop: per-step hit probability + band-pass colour (driven into a distortion, swept by a filter)
    this.loop=Array.from({length:16},(_,s)=>s%4===2?0.95:(s%2?0.5+0.3*r():(s%4===0?0.25:0.7)));
    this.loopF=Array.from({length:16},(_,s)=>[900,1400,2200,3200][Math.floor(r()*4)]*(s%4===2?1.3:1));
    this.initUpper();
  }
  mutate(v){
    const r=this.r;
    const nCh=r()<v*0.9?1+(r()<v*0.5?1:0):0;           // v13: develop the line (1-2 steps, neighbouring degrees) instead of re-rolling every step
    for(let k=0;k<nCh;k++){const s=Math.floor(r()*16),down=s%4===0,b=this.bass[s];
      if(b){const x=r();
        if(x<0.25&&s!==2) this.bass[s]=null;
        else if(x<0.7) this.bass[s]={deg:Math.max(0,Math.min(4,b.deg+(r()<0.5?1:-1))),oct:b.oct};
        else this.bass[s]={deg:b.deg,oct:b.oct?0:(r()<0.7?1:-1)};
      }else if(!down || r()<0.08){
        this.bass[s]={deg:r()<0.6?0:Math.floor(r()*MINOR_PENT.length),oct:r()<0.12?1:0};
      }
    }
    if(nCh||r()<0.3)this.answerBass();
    // phrase fill for the 4th bar (turnaround: passing tones on steps 12-15), not every phrase
    this.bassFill=null;if(r()<0.35+0.4*v){const F={};let d=[1,3,4,2][Math.floor(r()*4)];
      for(const s of [12,13,14,15].filter(()=>r()<0.6)){F[s]={deg:d,oct:r()<0.2?1:0};d=Math.max(0,Math.min(4,d+(r()<0.6?-1:1)));}
      if(Object.keys(F).length){for(const s of [12,13,14,15])if(!F[s])F[s]=null;this.bassFill=F;}}
    let n=this.bass.filter(Boolean).length;
    while(n<4){const s=[2,6,10,14,3,11][Math.floor(r()*6)];if(!this.bass[s]){this.bass[s]={deg:0,oct:0};n++;}}
    while(n>10){const s=Math.floor(r()*16);if(this.bass[s]&&s!==2){this.bass[s]=null;n--;}}
    this.ghost=Math.min(0.75,Math.max(0.05,this.ghost+(r()-0.5)*0.5*v));
    this.hatAccent=this.hatAccent.map(a=>Math.min(1.1,Math.max(0.6,a+(r()-0.5)*0.3*v)));
    const reroll=set=>{const k=1+Math.floor(r()*(v>0.6?3:2));set.clear();
      for(let i=0;i<k;i++)set.add([3,6,7,10,11,13,14,15][Math.floor(r()*8)]);};
    if(r()<v*0.8) reroll(this.stab);
    if(r()<v*0.8) reroll(this.stabAlt);
    // groove
    this.grooveExtra=Math.min(0.8,Math.max(0.1,this.grooveExtra+(r()-0.5)*0.5*v));
    this.shaker=this.shaker.map((p,s)=>s%4===2?p:Math.min(0.9,Math.max(0.05,p+(r()-0.5)*0.5*v)));
    this.loop=this.loop.map((p,s)=>s%4===2?p:Math.min(0.95,Math.max(0.1,p+(r()-0.5)*0.45*v)));
    if(r()<v*0.5){const i=Math.floor(r()*16);this.loopF[i]=[900,1400,2200,3200,4500][Math.floor(r()*5)];}
    // tribal
    const T=this.trib;
    if(r()<v*0.6){T.cyc=r()<0.75?3:(r()<0.5?5:6);T.off=Math.floor(r()*T.cyc);T.voiceA=Math.floor(r()*3);}
    if(r()<v*0.7){const rot=Math.floor(r()*4)*2;T.b=T.b.slice(rot).concat(T.b.slice(0,rot));}
    for(let s=0;s<16;s++) if(r()<v*0.15) T.b[s]=T.b[s]<0?Math.floor(r()*3):-1;
    T.prob=Math.min(1,Math.max(0.55,T.prob+(r()-0.5)*0.3*v));
    T.ghost=Math.min(0.45,Math.max(0.05,T.ghost+(r()-0.5)*0.3*v));
    // broken kick (always keeps the downbeat)
    if(r()<v*0.7){const opts=[[0,6,10],[0,3,10],[0,7,10,13],[0,6,8,11],[0,3,8,10,14],[0,10],[0,6,11,14]];
      this.broken=new Set(opts[Math.floor(r()*opts.length)]);}
  }
  // v13: 2-bar call/answer bass (the answer bar changes 1-2 notes: octave, neighbouring degree, the last note) + 4th-bar fill
  answerBass(){const r=this.r,B=this.bass.map(n=>n&&{...n}),on=[...B.keys()].filter(s=>B[s]&&s!==2);
    for(let k=0,n=1+(r()<0.5?1:0);k<n&&on.length;k++){const s=on.splice(Math.floor(r()*on.length),1)[0],b=B[s],x=r();
      B[s]=x<0.4?{deg:b.deg,oct:b.oct?0:1}:x<0.85?{deg:Math.max(0,Math.min(4,b.deg+(r()<0.5?1:-1))),oct:b.oct}:null;}
    if(r()<0.3){const fr=[13,15,11].find(s=>!B[s]);if(fr!=null)B[fr]={deg:[1,2,3][Math.floor(r()*3)],oct:0};}
    this.bassB=B;}
  bassAt(s,bar){const F=this.bassFill;return F&&bar%4===3&&s in F?F[s]:(bar%2===1&&this.bassB?this.bassB[s]:this.bass[s]);}
  nextBar(v){
    if(this.bar>0 && this.bar%4===0){this.mutate(v);this.mutateUpper(v);}
    if(this.bar%8===0) this.openHat = this.bar%16===8 ? true : (this.r()<0.3+0.4*v);
    return this.bar++;
  }
}

// ---------- AudioParam envelope helper ----------
// Mirrors the automation we schedule so we can hold the exact current value
// (cancelAndHoldAtTime where supported, otherwise cancelScheduledValues + computed value).
class Env{
  constructor(param,v0){this.p=param;this.ev=[{type:"set",time:0,value:v0}];param.setValueAtTime(v0,0);}
  valueAt(T){let v=this.ev[0].value,pt=this.ev[0].time,tgt=null;
    for(const e of this.ev){
      if(e.time>T){ if(e.type==="lin") return v+(e.value-v)*(T-pt)/(e.time-pt);
        if(e.type==="exp") return v*Math.pow(e.value/v,(T-pt)/(e.time-pt)); break;}
      if(tgt) v=tgt.value+(v-tgt.value)*Math.exp(-(e.time-pt)/tgt.tau);
      tgt=null;
      if(e.type==="target"){tgt=e;}else v=e.value;
      pt=e.time;}
    if(tgt) v=tgt.value+(v-tgt.value)*Math.exp(-(T-pt)/tgt.tau);
    return v;}
  hold(t,floor=0){const v=Math.max(floor,this.valueAt(t));
    // inside a ramp, cancelScheduledValues would drop the ramp's end point -> use cancelAndHoldAtTime.
    // otherwise (after a set/target event) the computed value is exact and works in every browser.
    const midRamp=this.ev.some((e,i)=>(e.type==="lin"||e.type==="exp")&&e.time>t&&i>0&&this.ev[i-1].time<t);
    if(midRamp&&this.p.cancelAndHoldAtTime&&floor===0){this.p.cancelAndHoldAtTime(t);}
    else{this.p.cancelScheduledValues(t);this.p.setValueAtTime(v,t);}
    this.ev=this.ev.filter(e=>e.time<t);this.ev.push({type:"set",time:t,value:v});
    if(this.ev.length>12)this.ev=this.ev.slice(-12);return v;}
  exp(v,t){this.p.exponentialRampToValueAtTime(v,t);this.ev.push({type:"exp",time:t,value:v});}
  lin(v,t){this.p.linearRampToValueAtTime(v,t);this.ev.push({type:"lin",time:t,value:v});}
  set(v,t){this.p.setValueAtTime(v,t);this.ev=this.ev.filter(x=>x.time<t);this.ev.push({type:"set",time:t,value:v});}
  target(v,t,tau){this.p.setTargetAtTime(v,t,tau);this.ev.push({type:"target",time:t,value:v,tau});}
}

// ---------- Engine (AudioContext; XRift port: output goes to opts.dest instead of ctx.destination) ----------
class Engine{
  constructor(ctx,seed,opts={}){
    this.ctx=ctx;this.opts=opts;this.closed=false;this.closeDoneT=null;this.seed=seed;this.rand=mulberry32(seed);this.deckSeq=0;this.debug=false;this.kickLog=[];this.bassLog=[];this.bpmLog=[];
    const c=ctx;
    const nb=c.createBuffer(1,c.sampleRate*2,c.sampleRate),d=nb.getChannelData(0);
    const nr=mulberry32(seed^0x9e3779b9);for(let i=0;i<d.length;i++)d[i]=nr()*2-1;
    this.noise=nb;
    // master: sum -> highpass (drop riser) -> volume -> soft clip -> limiter -> out
    this.sum=c.createGain();this.sum.gain.value=0.8;
    this.hpf=c.createBiquadFilter();this.hpf.type="highpass";this.hpf.frequency.value=0;this.hpf.Q.value=0.8;
    this.hpCtl=c.createConstantSource();this.hpCtl.connect(this.hpf.frequency);this.hpCtl.start();this.hpEnv=new Env(this.hpCtl.offset,20);
    this.vol=c.createGain();this.vol.gain.value=S.vol;this.fadeG=c.createGain();   // fadeG: closing-phase level (independent of the volume slider)
    this.clip=c.createWaveShaper();this.clip.curve=Engine.curve(2048,x=>Math.tanh(1.3*x)/Math.tanh(1.3));this.clip.oversample="2x";
    this.lim=c.createDynamicsCompressor();
    this.lim.threshold.value=-3;this.lim.knee.value=0;this.lim.ratio.value=20;this.lim.attack.value=0.002;this.lim.release.value=0.12;
    this.out=c.createGain();this.out.gain.value=0.89;
    this.trim=c.createGain();this.trim.gain.value=0;
    // break FX on the master: lowpass (filter break / tape stop), modulated delay (tape-stop pitch drop), break gain (silence / tape stop)
    this.lpf=c.createBiquadFilter();this.lpf.type="lowpass";this.lpf.Q.value=1.1;this.lpEnv=new Env(this.lpf.frequency,20000);
    this.tape=c.createDelay(1.5);this.tape.delayTime.value=0;
    this.brkG=c.createGain();this.brkEnv=new Env(this.brkG.gain,1);
    this.sum.connect(this.trim).connect(this.hpf).connect(this.lpf).connect(this.tape).connect(this.brkG).connect(this.vol).connect(this.fadeG).connect(this.clip).connect(this.lim).connect(this.out).connect(opts.dest||c.destination);
    // dub echo for エコーアウト: tap after trim -> send -> delay <-> (LP, HP, feedback) -> straight into vol (no loop through sum)
    this.echoSend=c.createGain();this.echoSendEnv=new Env(this.echoSend.gain,0);
    this.echoDL=c.createDelay(2);this.echoLP=c.createBiquadFilter();this.echoLP.type="lowpass";this.echoLP.frequency.value=2600;
    this.echoHP=c.createBiquadFilter();this.echoHP.type="highpass";this.echoHP.frequency.value=160;
    this.echoFb=c.createGain();this.echoFbEnv=new Env(this.echoFb.gain,0.3);
    this.echoOut=c.createGain();this.echoOutEnv=new Env(this.echoOut.gain,1);
    this.trim.connect(this.echoSend).connect(this.echoDL);this.echoDL.connect(this.echoLP).connect(this.echoHP);
    this.echoHP.connect(this.echoFb).connect(this.echoDL);this.echoHP.connect(this.echoOut).connect(this.vol);this.echoPreAt=-9;
    this.bus={};for(const p of PARTS){const g=c.createGain();g.gain.value=1;g.connect(this.sum);this.bus[p]=g;}
    // low-cut on the kick / bass buses (kick-drop variants "ローカット" / "細いキック"); idle at 12 Hz
    this.lc={};for(const p of ["kick","bass"]){const f=c.createBiquadFilter();f.type="highpass";f.Q.value=0.7;f.frequency.value=12;
      this.bus[p].disconnect();this.bus[p].connect(f).connect(this.sum);this.lc[p]=new Env(f.frequency,12);}
    this.fillBus=c.createGain();this.fillBus.gain.value=1;this.fillBus.connect(this.sum);
    // 上モノ sidechain pump (unity unless the kick asks for it: KICK_GLUE.scUp)
    this.pumpUp=c.createGain();this.pumpUp.gain.value=1;this.bus.stab.disconnect();this.bus.stab.connect(this.pumpUp).connect(this.sum);
    this.riserBus=c.createGain();this.riserBus.connect(this.vol); // riser bypasses the master HPF
    // persistent riser voice: looped noise -> bandpass (freq from riserFreq) -> gain (level from riserLvl)
    this.riserSrc=c.createBufferSource();this.riserSrc.buffer=this.noise;this.riserSrc.loop=true;
    this.riserBP=c.createBiquadFilter();this.riserBP.type="bandpass";this.riserBP.Q.value=1.2;this.riserBP.frequency.value=0;
    this.riserG=c.createGain();this.riserG.gain.value=0;
    this.rfCtl=c.createConstantSource();this.rfCtl.connect(this.riserBP.frequency);this.rfEnv=new Env(this.rfCtl.offset,500);
    this.lvlCtl=c.createConstantSource();this.lvlCtl.connect(this.riserG.gain);this.lvlEnv=new Env(this.lvlCtl.offset,0);
    this.riserSrc.connect(this.riserBP).connect(this.riserG).connect(this.riserBus);
    this.riserSrc.start();this.rfCtl.start();this.lvlCtl.start();
    // kick saturation (soft for minimal/groove/tribal, hard for hardtechno)
    this.kickSat=c.createWaveShaper();this.kickSat.curve=Engine.curve(1024,x=>Math.tanh(1.6*x));this.kickSat.connect(this.bus.kick);
    this.kickHard=c.createWaveShaper();this.kickHard.curve=Engine.curve(2048,x=>Math.tanh(5*x)/Math.tanh(5)*0.8);this.kickHard.oversample="4x";
    this.kickHard.connect(this.bus.kick);
    // 160 hardcore distortion: pre-gain -> very hard (slightly asymmetric) clip -> mid push -> lowpass -> kick bus
    this.kickGabIn=c.createGain();this.kickGabIn.gain.value=3.2;
    this.kickGab=c.createWaveShaper();this.kickGab.curve=Engine.curve(2048,x=>(Math.tanh(7*x+0.25)-Math.tanh(0.25))/(1+Math.tanh(0.25)));this.kickGab.oversample="2x";
    this.kickGabPk=c.createBiquadFilter();this.kickGabPk.type="peaking";this.kickGabPk.frequency.value=1700;this.kickGabPk.Q.value=0.9;this.kickGabPk.gain.value=3;
    this.kickGabLp=c.createBiquadFilter();this.kickGabLp.type="lowpass";this.kickGabLp.frequency.value=6500;this.kickGabLp.Q.value=0.6;
    this.kickGabOut=c.createGain();this.kickGabOut.gain.value=0.9;
    this.kickGabIn.connect(this.kickGab).connect(this.kickGabPk).connect(this.kickGabLp).connect(this.kickGabOut).connect(this.bus.kick);
    this.satCurve=Engine.curve(1024,x=>Math.tanh(3.5*x)/Math.tanh(3.5));this.loopCurve=Engine.curve(1024,x=>Math.tanh(5*x)/Math.tanh(5));
    // rumble: kick -> reverb (convolver) -> lowpass -> distortion -> lowpass -> sidechain duck -> kick bus
    this.rumbleIn=c.createGain();this.rumbleIn.gain.value=0.9;
    this.verb=c.createConvolver();this.verb.normalize=true;this.verb.buffer=this.makeIR(1.1);
    this.rlp=c.createBiquadFilter();this.rlp.type="lowpass";this.rlp.frequency.value=140;this.rlp.Q.value=0.9;
    this.rdrive=c.createGain();this.rdrive.gain.value=6;
    this.rdist=c.createWaveShaper();this.rdist.curve=Engine.curve(1024,x=>Math.tanh(3*x));this.rdist.oversample="2x";
    this.rlp2=c.createBiquadFilter();this.rlp2.type="lowpass";this.rlp2.frequency.value=220;
    this.rduck=c.createGain();this.rduck.gain.value=0;
    this.rout=c.createGain();this.rout.gain.value=0.38;
    this.rumbleIn.connect(this.verb).connect(this.rlp).connect(this.rdrive).connect(this.rdist).connect(this.rlp2).connect(this.rduck).connect(this.rout).connect(this.bus.kick);
    // bass sidechain duck
    this.duck=c.createGain();this.duck.connect(this.bus.bass);
    // stab + ping-pong delay
    this.send=c.createGain();this.send.gain.value=S.dmix;
    this.dL=c.createDelay(2);this.dR=c.createDelay(2);
    this.fbL=c.createGain();this.fbR=c.createGain();this.fbL.gain.value=this.fbR.gain.value=S.dfb;
    this.dlp=c.createBiquadFilter();this.dlp.type="lowpass";this.dlp.frequency.value=3200;
    this.panL=c.createStereoPanner();this.panL.pan.value=-0.8;this.panR=c.createStereoPanner();this.panR.pan.value=0.8;
    this.wet=c.createGain();
    this.send.connect(this.dlp).connect(this.dL);
    this.dL.connect(this.panL).connect(this.wet);this.dL.connect(this.fbL).connect(this.dR);
    this.dR.connect(this.panR).connect(this.wet);this.dR.connect(this.fbR).connect(this.dL);
    this.wet.connect(this.bus.stab);
    this.bpm=BANDS[S.band].start;this.bpmGlide=null;this.setBpm(this.bpm,0);
    this.kp=kickParams(S.style,S.band);this.kMorph=null;this.motifSeq=0;this.upLog=[];this.kpLog=[];this.arrLog=[];this.chillAmt=0;this.chillGlide=null;this.chillMode=null;this.chillLog=[];this.hatBar=0;this.kickBarCnt=0;
    this.step=0;this.nextTime=0;this.bar=0;this.onStep=null;
    this.key=opts.key!=null?pcOf(opts.key):+pickW(this.rand,KEY_W);S.key=this.key;   // v13/v14: key per set (seeded, roots F..B, A minor most likely), kick tail + bass follow it
    this.initUpper();this.decks=[this.makeDeck(S.style,true)];this.low=this.decks[0];this.cur=this.low.out;this.cond=new Conductor(this);
    this.drop={active:false,type:"kick",src:null,endBar:-1,startBar:0,len:0,armed:false,tr:0,riserOn:false,spaceBoost:0};this.returnTimes=[];this.dropTimes=[];
    this.breakLog=[];this.brkMarks=[];
    this.stats={kicks:0,dropBars:0,perc:0,fills:0,drops:0};this.minLead=Infinity;
  }
  dispose(t){for(const n of [this.riserSrc,this.rfCtl,this.lvlCtl,this.hpCtl,...UPSTYLES.map(st=>this["upCtl_"+st]),...this.decks.map(d=>d.ctl)]){try{n.stop(t);}catch(_){}}}
  // ----- decks (DJ-style: two independent pattern engines can coexist during a mix) -----
  makeDeck(style,initial,band=S.band){const c=this.ctx,d={style,band,id:this.deckSeq++,pat:new Patterns(this.rand),kickBar:new Array(16).fill(0),upOn:true,topOn:true,out:{},arr:{variant:0,init:false}};
    d.key=initial||!this.low?this.key:this.nextKey(band!==this.low.band);this.initHarm(d);
    d.ctl=c.createConstantSource();d.ctl.start();
    for(const p of ["hat","clap","perc"]){const g=c.createGain();g.gain.value=0;d.ctl.connect(g.gain);g.connect(this.bus[p]);d.out[p]=g;}
    if(band==="b160"){d.loopIn=c.createGain();d.loopIn.gain.value=2.2;const ws=c.createWaveShaper();ws.curve=this.loopCurve;
      d.loopBP=c.createBiquadFilter();d.loopBP.type="bandpass";d.loopBP.Q.value=0.8;d.loopBP.frequency.value=1800;
      const lo=c.createGain();lo.gain.value=0.42;d.loopIn.connect(ws).connect(d.loopBP).connect(lo).connect(d.out.perc);d.loopNodes=[d.loopIn,ws,d.loopBP,lo];}
    d.kit=this.makeKit(d);   // v21: own drum identity
    d.topEnv=new Env(d.ctl.offset,initial?1:0);return d;}
  disposeDeck(d,t){d.upOn=false;d.topOn=false;d.ctl.onended=()=>{for(const g of Object.values(d.out))g.disconnect();for(const x of d.loopNodes||[])x.disconnect();};d.ctl.stop(t+0.5);}
  // ----- intent-driven effective parameters -----
  cutHz(){const p=this.cond.p;return cutoffHz(S.cutoff)*Math.pow(2,(0.5-p.dark)*2.0+(p.energy-0.5)*0.6);}
  effVar(){return Math.min(1,S.variation*(0.5+this.cond.p.energy));}
  dens(){return Math.min(1.3,0.4+1.3*this.cond.p.density);}
  applyBarParams(t){const p=this.cond.p,D=this.drop,sp=Math.min(1.2,p.space+(D.active?D.spaceBoost||0:0));
    this.send.gain.setTargetAtTime(S.dmix*(0.35+1.3*sp),t,0.4);
    const fb=Math.min(0.85,S.dfb*(0.7+0.5*sp)+0.12*p.tension);
    this.fbL.gain.setTargetAtTime(fb,t,0.4);this.fbR.gain.setTargetAtTime(fb,t,0.4);
    this.verbRet.gain.setTargetAtTime(0.35+1.1*sp,t,0.4);}
  fade(t1,ms=15){const g=this.ctx.createGain();g.gain.setValueAtTime(1,t1-ms/1000);g.gain.linearRampToValueAtTime(0,t1);return g;}
  static curve(n,f){const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=f(i/(n-1)*2-1);return a;}
  makeIR(sec){const c=this.ctx,n=Math.floor(c.sampleRate*sec),b=c.createBuffer(2,n,c.sampleRate),r=mulberry32(this.seed^0x51ed);
    for(let ch=0;ch<2;ch++){const d=b.getChannelData(ch);for(let i=0;i<n;i++)d[i]=(r()*2-1)*Math.exp(-i/(c.sampleRate*0.28));}
    return b;}
  get s16(){return 60/this.bpm/4;}
  setBpm(b,t=this.ctx.currentTime){const dt=3*60/b/4;
    this.dL.delayTime.setTargetAtTime(dt,t,0.05);this.dR.delayTime.setTargetAtTime(dt,t,0.05);
    if(this.echoDL)this.echoDL.delayTime.setTargetAtTime(dt,t,0.05);}
  applyParams(){const t=this.ctx.currentTime;
    this.vol.gain.setTargetAtTime(S.vol,t,0.03);this.applyBarParams(t);
}
  free(src,...nodes){src.onended=()=>{src.disconnect();for(const n of nodes)n.disconnect();};}
  lfo(){if(!S.sweep) return 0.5;const ph=((this.bar%16)+(this.step%16)/16)/16;return 0.5-0.5*Math.cos(2*Math.PI*ph);}
  noiseSrc(t,dur){const s=this.ctx.createBufferSource();s.buffer=this.noise;s.start(t,this.rand()*1.5,dur+0.01);return s;}

  // ----- drums -----
  // kick timbre comes from this.kp (continuous; morphs during a mix): soft/hard saturation crossfade + rumble send
  kick(t,vel=1,ko={}){const c=this.ctx,P=this.kp,pm=ko.pm||1,len=ko.len?Math.min(P.len,ko.len):P.len,gab=P.gab||0;
    const o=c.createOscillator(),g=c.createGain();o.type="sine";
    // tail pitch: f1 settles to f1-4; with tune>0 it is pulled so the settled tail sits on the key root (nearest octave of A, transposed with the key)
    const tn=P.tune||0,rootHz=this.tailRoot(P.f1),f1=tn>0.001?P.f1+(rootHz+3-P.f1)*tn:P.f1;
    o.frequency.setValueAtTime(P.f0*pm,t);o.frequency.exponentialRampToValueAtTime(f1*pm,t+P.sw);o.frequency.setTargetAtTime(f1*pm-4,t+P.sw,0.1);
    if(gab>0.001){this.kickGabLp.frequency.setValueAtTime(P.gabLp??6500,t);this.kickGabPk.gain.setValueAtTime(P.gabPk??3,t);}
    if(this.kickRoom)this.kickRoom.gain.setValueAtTime((P.room||0)*Math.min(1,vel),t);
    this.bus.kick.gain.setValueAtTime(P.kLvl??1,t);
    if((P.scUp||0)>0.005){const u=this.pumpUp.gain,dep=1-P.scUp*Math.min(1,vel),bt=15*this.s16/4;u.cancelAndHoldAtTime(t);u.setTargetAtTime(dep,t,0.004);u.setTargetAtTime(1,t+0.03,bt*0.28);}
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vel,t+0.002);g.gain.setTargetAtTime(0,t+0.01,P.tau);
    const fo=this.fade(t+len,Math.min(25,len*300));o.connect(g).connect(fo);const extra=[fo];
    if(P.drive<0.999&&gab<0.999){const gs=c.createGain();gs.gain.value=(1-P.drive)*(1-gab);fo.connect(gs).connect(this.kickSat);extra.push(gs);}
    if(P.drive>0.001&&gab<0.999){const gh=c.createGain();gh.gain.value=P.drive*(1-gab);fo.connect(gh).connect(this.kickHard);extra.push(gh);}
    if(gab>0.001){const gg=c.createGain();gg.gain.value=gab;fo.connect(gg).connect(this.kickGabIn);extra.push(gg);}
    if(P.rumble>0.01){const sg=c.createGain();sg.gain.value=P.rumble;fo.connect(sg).connect(this.rumbleIn);extra.push(sg);
      // rumble sidechain: duck under the kick, swell between kicks
      const rd=this.rduck.gain;rd.setValueAtTime(0,t);rd.setTargetAtTime(1,t+0.07,0.05);}
    o.start(t);o.stop(t+len);this.free(o,g,...extra);
    const n=this.noiseSrc(t,0.006),hp=c.createBiquadFilter(),ng=c.createGain();
    hp.type="highpass";hp.frequency.value=2000;ng.gain.setValueAtTime(P.click*vel,t);ng.gain.exponentialRampToValueAtTime(0.001,t+0.005);
    n.connect(hp).connect(ng).connect(this.bus.kick);this.free(n,hp,ng);
    // bass sidechain follows every kick that actually plays
    const scb=P.scBass??0.6,d=this.duck.gain,depth=1-scb*Math.min(1,vel);d.setValueAtTime(1,t);d.linearRampToValueAtTime(depth,t+0.004);
    d.setTargetAtTime(1,t+0.03+(scb>0.6?(scb-0.6)*0.25:0),0.07);   // deeper sidechain also holds a little longer (クロスブリード: bass leaves the kick its sub, back by the off-beat)
    this.stats.kicks++;
  }
  // gradual kick morph: rumble arrives early / leaves late, saturation arrives late / leaves early, the rest is linear
  startKickMorph(to,bars,b0){this.kMorph={from:{...this.kp},to,b0,bars:Math.max(1,bars)};}
  updateKickMorph(){const K=this.kMorph;if(!K||this.bar<K.b0)return;const x=Math.min(1,(this.bar-K.b0+1)/K.bars),c01=v=>Math.max(0,Math.min(1,v)),P={};
    for(const k of Object.keys(K.to)){const a=K.from[k],b=K.to[k];let f=x;
      if(k==="rumble")f=b>a?c01(x*1.7):c01((x-0.4)/0.6);
      else if(k==="drive")f=b>a?c01((x-0.35)/0.65):c01(x*1.7);
      P[k]=a+(b-a)*f;}
    this.kp=P;if(x>=1)this.kMorph=null;}
  hat(t,vel,dur,tau,pan,freq=7000,bus=this.cur.hat,type="highpass"){const c=this.ctx;
    const n=this.noiseSrc(t,Math.max(dur,tau*9)),hp=c.createBiquadFilter(),g=c.createGain(),p=c.createStereoPanner();
    hp.type=type;hp.frequency.value=freq;hp.Q.value=type==="bandpass"?2:0.7;p.pan.value=pan;
    g.gain.setValueAtTime(vel,t);g.gain.setTargetAtTime(0,t,tau);
    n.connect(hp).connect(g).connect(p).connect(bus);this.free(n,hp,g,p);}
  loopHit(t,vel,freq,d){const c=this.ctx,n=this.noiseSrc(t,0.07),bp=c.createBiquadFilter(),g=c.createGain();
    bp.type="bandpass";bp.frequency.value=freq;bp.Q.value=1.6;
    g.gain.setValueAtTime(vel,t);g.gain.setTargetAtTime(0,t+0.004,0.018);
    n.connect(bp).connect(g).connect(d.loopIn);this.free(n,bp,g);this.stats.perc++;}
  clap(t,vel=1){const c=this.ctx;
    const n=this.noiseSrc(t,0.6),bp=c.createBiquadFilter(),g=c.createGain();
    bp.type="bandpass";bp.frequency.value=1600;bp.Q.value=1.1;
    const v=0.32*vel;g.gain.setValueAtTime(0,t);
    for(const o of [0,0.011,0.022]){g.gain.setValueAtTime(v,t+o);g.gain.setTargetAtTime(0,t+o,0.006);}
    g.gain.setValueAtTime(v*0.8,t+0.03);g.gain.setTargetAtTime(0,t+0.03,0.06);
    n.connect(bp).connect(g).connect(this.cur.clap);this.free(n,bp,g);}
  snare(t,vel){const c=this.ctx;
    const n=this.noiseSrc(t,0.45),bp=c.createBiquadFilter(),g=c.createGain();
    bp.type="bandpass";bp.frequency.value=2200;bp.Q.value=0.7;
    g.gain.setValueAtTime(0.45*vel,t);g.gain.setTargetAtTime(0,t,0.045);
    n.connect(bp).connect(g).connect(this.fillBus);this.free(n,bp,g);
    const o=c.createOscillator(),og=c.createGain();o.type="triangle";
    o.frequency.setValueAtTime(220,t);o.frequency.exponentialRampToValueAtTime(170,t+0.05);
    og.gain.setValueAtTime(0.35*vel,t);og.gain.setTargetAtTime(0,t,0.035);
    o.connect(og).connect(this.fillBus);o.start(t);o.stop(t+0.25);this.free(o,og);this.stats.fills++;}
  ride(t,vel,bus=this.cur.perc){const c=this.ctx; // 808-style metallic: 6 squares -> bandpass -> highpass
    const bp=c.createBiquadFilter(),hp=c.createBiquadFilter(),g=c.createGain(),p=c.createStereoPanner();
    bp.type="bandpass";bp.frequency.value=9000;bp.Q.value=0.8;hp.type="highpass";hp.frequency.value=6500;p.pan.value=0.35;
    g.gain.setValueAtTime(0.09*vel,t);g.gain.setTargetAtTime(0,t,0.16);
    const fo=this.fade(t+0.9,30);bp.connect(hp).connect(g).connect(fo).connect(p).connect(bus);
    const os=[];for(const f of [205.3,304.4,369.6,522.7,540,800]){const o=c.createOscillator();o.type="square";o.frequency.value=f*1.7;o.connect(bp);o.start(t);o.stop(t+0.9);os.push(o);this.free(o);}
    os[0].addEventListener("ended",()=>{bp.disconnect();hp.disconnect();g.disconnect();fo.disconnect();p.disconnect();});this.stats.perc++;}
  tom(t,voice,vel){const c=this.ctx;
    const midi=[45,52,57][voice]+keyOff(),f=mtof(midi),tau=[0.2,0.14,0.1][voice];
    const o=c.createOscillator(),g=c.createGain(),p=c.createStereoPanner();o.type="sine";p.pan.value=[-0.35,0.1,0.45][voice];
    o.frequency.setValueAtTime(f*1.6,t);o.frequency.exponentialRampToValueAtTime(f,t+0.035);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.42*vel,t+0.002);g.gain.setTargetAtTime(0,t+0.004,tau);
    o.connect(g).connect(p).connect(this.cur.perc);o.start(t);o.stop(t+tau*9);this.free(o,g,p);
    this.hat(t,0.12*vel,0.012,0.004,p.pan.value,2800,this.cur.perc,"bandpass"); // slap
    this.stats.perc++;}

  // ----- tonal -----
  // kick tail target: the key root in the octave nearest the patch tail; when the root sits far from it (> ~2.5 st), its fifth instead
  tailRoot(f1){const h=mtof(33+keyOff());if(h>=42&&h<=63)return h;let best=h,bs=1e9;   // v14: roots F..B sit at 44-62 Hz: tune straight to the root
    for(const [m,pen] of [[1,0],[1.5,2.5]])for(let k=-2;k<=2;k++){const c=h*m*Math.pow(2,k),sc=Math.abs(12*Math.log2(c/f1))+pen;if(sc<bs){bs=sc;best=c;}}return best;}
  // bass pitch: pentatonic degree on the key root, following the low deck's chord when its harmony says so (snapped to its mode)
  // lift: notes below / on the root go up an octave (クロスブリード: the kick tail owns the sub on the root, the off-beat bass sits on / above it)
  bassMidi(note,lift){if(note.midi!=null)return note.midi;const root=33+keyOff(),L=this.low;let rel=MINOR_PENT[note.deg]+12*note.oct;
    if(L&&L.harm&&L.harm.bassFollow){const ch=this.chordOf(L).semi;if(ch){rel=snapTo(rel+(ch>6?ch-12:ch),L.scale);}}
    if(L&&L.harm){const pcs=this.chordPcs(L),pc=((rel%12)+12)%12;if(!pcs.includes(pc)&&pcs.some(x=>{const d=(x-pc+12)%12;return d===1||d===11||d===6;}))rel=this.snapChord(rel,0,pcs);}   // v18
    if(this.jazz&&this.jazz.on&&L&&L.harm){const ch=this.chordOf(L).semi,tn=this.chordTones(L,ch,3),o=Math.floor(rel/12)*12;if(((tn[2]-tn[0])%12+12)%12===6)tn[2]=tn[0];   // v20: jazzy segment -> bass on roots / fifths only
      rel=[tn[0],tn[2],tn[0]+12,tn[2]-12].map(x=>o+(((x%12)+12)%12)).concat([o+12+(((tn[0]%12)+12)%12)]).reduce((a,b)=>Math.abs(b-rel)<Math.abs(a-rel)?b:a);}
    let bm=root+rel;if(note.oct<=0&&bm>root+10)bm-=12;if(bm>root+12)bm-=12;if(bm<28)bm+=12;if(lift&&bm<root+3)bm+=12;return bm;}   // v14: same register as the A-minor version (root .. root+12, octave notes on top)
  bass(t,note,lm=1,lift=false){const c=this.ctx,len=this.s16*0.85*lm;
    const bm=this.bassMidi(note,lift),f=mtof(bm);
    const o1=c.createOscillator(),o2=c.createOscillator(),m1=c.createGain(),m2=c.createGain(),lp=c.createBiquadFilter(),g=c.createGain();
    o1.type="sawtooth";o2.type="sine";o1.frequency.value=f;o2.frequency.value=f;m1.gain.value=0.35;m2.gain.value=0.6;
    const l=this.lfo(),base=this.cutHz()*(0.55+0.9*l);
    lp.type="lowpass";lp.Q.value=4+4*l;
    lp.frequency.setValueAtTime(Math.min(12000,base+1400*(0.5+l)),t);lp.frequency.setTargetAtTime(base,t,0.03);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.55,t+0.003);g.gain.setTargetAtTime(0,t+0.004,0.09);g.gain.setTargetAtTime(0,t+len,0.006);
    o1.connect(m1).connect(lp);o2.connect(m2).connect(lp);lp.connect(g).connect(this.duck);
    o1.start(t);o2.start(t);o1.stop(t+len+0.05);o2.stop(t+len+0.05);this.free(o1,m1,lp,g);this.free(o2,m2);}
  stab(t,dest,root=57+keyOff(),ivs=[0,3,7,10]){const c=this.ctx,g=c.createGain(),bp=c.createBiquadFilter(),l=this.lfo();
    const center=(600+3500*l)*(this.cutHz()/600)**0.5;
    bp.type="bandpass";bp.frequency.value=Math.min(9000,Math.max(300,center));bp.Q.value=1.4;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.22,t+0.002);g.gain.setTargetAtTime(0,t+0.003,0.035);
    bp.connect(g).connect(dest);const os=[];
    for(const iv of ivs){const o=c.createOscillator(),og=c.createGain();o.type="square";
      o.frequency.value=mtof(root+iv);o.detune.value=(this.rand()-0.5)*8;og.gain.value=0.25;
      o.connect(og).connect(bp);o.start(t);o.stop(t+0.25);os.push(o);this.free(o,og);}
    os[0].addEventListener("ended",()=>{bp.disconnect();g.disconnect();});}

  // ----- drops -----
  crash(t){const c=this.ctx; // impact on the return downbeat: stereo filtered noise, long natural decay
    for(const [pan,off] of [[-0.6,0],[0.6,0.37]]){
      const n=c.createBufferSource();n.buffer=this.noise;n.loop=true;
      const hp=c.createBiquadFilter(),pk=c.createBiquadFilter(),g=c.createGain(),p=c.createStereoPanner();
      hp.type="highpass";hp.frequency.value=3200;pk.type="peaking";pk.frequency.value=7500;pk.gain.value=6;pk.Q.value=0.8;p.pan.value=pan;
      g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.11,t+0.003);g.gain.setTargetAtTime(0,t+0.004,0.55);
      n.connect(hp).connect(pk).connect(g).connect(p).connect(this.fillBus);n.start(t,off);n.stop(t+0.55*10);this.free(n,hp,pk,g,p);}}
  // generic riser: master HPF up + band-passed noise up, peaking exactly where the return sweep begins
  riserFx(t0,tr,peak,hp=true){const D=this.drop,H=0.12;D.riserOn=true;
    if(hp)this.hpEnv.hold(t0);this.lvlEnv.hold(t0);this.rfEnv.hold(t0);
    if(tr){if(hp)this.hpEnv.exp(peak,tr-H);
      this.lvlEnv.hold(t0+0.001,0.0005);this.lvlEnv.exp(0.11,tr);this.rfEnv.exp(500,t0+0.03);this.rfEnv.exp(7000,tr);}
    else{if(hp)this.hpEnv.target(peak,t0,3);this.lvlEnv.target(0.11,t0,2.5);this.rfEnv.exp(500,t0+0.03);this.rfEnv.target(7000,t0+0.03,3);}}
  // pre-roll one beat before a break (echo-out needs to catch the last beat in the delay)
  breakPre(type,t){if(type!=="echo")return;this.echoPreAt=t;
    this.echoOutEnv.hold(t);this.echoOutEnv.lin(1,t+0.02);this.echoFbEnv.hold(t);this.echoFbEnv.lin(0.62,t+0.05);
    this.echoSendEnv.hold(t);this.echoSendEnv.lin(0.9,t+0.015);}
  // reverse cymbal: noise swelling into tr, cut right on the downbeat
  revCym(t0,tr,dest=this.fillBus,lvl=0.09){const c=this.ctx;if(tr-t0<0.05)return;
    for(const pan of [-0.5,0.5]){const n=c.createBufferSource();n.buffer=this.noise;n.loop=true;
      const hp=c.createBiquadFilter(),pk=c.createBiquadFilter(),g=c.createGain(),p=c.createStereoPanner();
      hp.type="highpass";hp.frequency.value=3500;pk.type="peaking";pk.frequency.value=8000;pk.gain.value=5;p.pan.value=pan;
      g.gain.setValueAtTime(0.0004,t0);g.gain.exponentialRampToValueAtTime(lvl,tr-0.006);g.gain.linearRampToValueAtTime(0,tr);
      n.connect(hp).connect(pk).connect(g).connect(p).connect(dest);n.start(t0,this.rand());n.stop(tr+0.02);this.free(n,hp,pk,g,p);}}
  // sub boom on the return downbeat
  boom(t){const c=this.ctx,o=c.createOscillator(),g=c.createGain();o.type="sine";
    o.frequency.setValueAtTime(70,t);o.frequency.exponentialRampToValueAtTime(34,t+0.9);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.42,t+0.006);g.gain.setTargetAtTime(0,t+0.02,0.45);
    o.connect(g).connect(this.bus.kick);o.start(t);o.stop(t+3);this.free(o,g);}
  // pitched riser (saw sweeping up into tr), bypasses the master HPF
  pitchRiser(t0,tr){const c=this.ctx;if(tr-t0<0.1)return;const o=c.createOscillator(),o2=c.createOscillator(),bp=c.createBiquadFilter(),g=c.createGain();
    o.type="sawtooth";o2.type="sawtooth";o2.detune.value=14;
    for(const x of [o,o2]){x.frequency.setValueAtTime(180,t0);x.frequency.exponentialRampToValueAtTime(1500,tr);}
    bp.type="bandpass";bp.Q.value=1.5;bp.frequency.setValueAtTime(600,t0);bp.frequency.exponentialRampToValueAtTime(4500,tr);
    g.gain.setValueAtTime(0,t0);g.gain.linearRampToValueAtTime(0.045,tr-0.01);g.gain.linearRampToValueAtTime(0,tr+0.01);
    o.connect(bp);o2.connect(bp);bp.connect(g).connect(this.riserBus);o.start(t0);o2.start(t0);o.stop(tr+0.03);o2.stop(tr+0.03);this.free(o,bp,g);this.free(o2);}
  // echo throw: send the last beat(s) into the dub delay without cutting the dry signal
  echoClose(tr){const bd=16*this.s16;this.echoSendEnv.hold(tr-0.03);this.echoSendEnv.lin(0,tr-0.002);this.echoFbEnv.hold(tr);this.echoFbEnv.lin(0.3,tr+bd);}
  dropStart(t,src,lenBars,type="kick",o={}){const D=this.drop,B=BREAKS[type]||BREAKS.kick;if(!BREAKS[type])type="kick";
    if(type!=="kick"&&!lenBars)lenBars=B.def;
    let R=null;if(type==="kick")R=o.recipe||{...KD_DEFAULT,len:lenBars,fill:S.fill?"snare16":"none",riser:S.riser?"noise":"none",impact:"crash",name:"手動"};
    Object.assign(D,{active:true,type,src,startBar:this.bar,len:lenBars||0,endBar:lenBars?this.bar+lenBars:-1,armed:false,tr:0,riserOn:false,spaceBoost:0,
      recipe:R,dir:o.dir||null,noImpact:!!o.noImpact,toBpm:o.toBpm||null});
    this.stats.drops++;this.dropTimes.push(t);if(this.debug)this.breakLog.push({type,t,bar:this.bar,len:lenBars,recipe:R?R.key:null,name:R?R.name:null});
    const s16=this.s16,bd=16*s16,tr=lenBars?t+lenBars*bd:0,lastBar=tr?tr-bd:0;
    switch(type){
      case "kick":{
        if(R.remove==="lowcut"||R.remove==="thin"){const f=R.remove==="thin"?280:150,ta=t+Math.min(bd,Math.max(1,lenBars)*bd*0.25);
          for(const k of R.remove==="thin"?["kick"]:["kick","bass"]){this.lc[k].hold(t);this.lc[k].exp(f,ta);}}
        if(R.riser==="noise"&&S.riser)this.riserFx(t,tr,lenBars>=2?480:260,["kick","kickbass","beat1","offbeat"].includes(R.remove));
        else if(R.riser==="pitch"&&tr)this.pitchRiser(Math.max(t,tr-Math.min(2,lenBars)*bd),tr);
        break;}
      case "bridge":{D.spaceBoost=0.4;const root=57+keyOff(),slow=Math.min(this.bpm,o.toBpm||this.bpm),dur=lenBars*16*60/slow/4,att=Math.min(3,dur*0.25);
        for(const [m,ty,lvl,cut] of [[root-24,"sawtooth",0.03,480],[root-12,"triangle",0.03,900],[root-5,"triangle",0.022,1300],[root+3,"sine",0.016,2000]])
          this.drone(t,dur,{midi:m,type:ty,det:10,cut,q:0.8,lvl,att,rel:2.6,lfo:0.05,depth:cut*0.35},this.padBus);
        this.noiseWash(t,dur,0.03,this.padBus);this.brkMarks.push([t,"bridge"]);break;}
      case "intro":{const root=57+keyOff(),dur=lenBars*bd;D.spaceBoost=0.25;
        this.brkEnv.hold(t);this.brkEnv.set(0,t);this.brkEnv.lin(1,t+bd);                  // click-free fade-in over the first bar
        this.lpEnv.hold(t);this.lpEnv.set(500,t);this.lpEnv.exp(2600,t+8*bd);this.lpEnv.exp(20000,tr-bd);                // percussion starts muffled, opens up by bar 15
        for(const [m,ty,lvl,cut] of [[root-24,"sawtooth",0.07,450],[root-12,"triangle",0.08,900],[root-5,"triangle",0.055,1300],[root+3,"sine",0.04,2000]])
          this.drone(t,dur,{midi:m,type:ty,det:10,cut,q:0.8,lvl,att:Math.min(6,dur*0.3),rel:2.5,lfo:0.05,depth:cut*0.35},this.padBus);
        if(S.riser)this.riserFx(tr-2*bd,tr,420,true);this.brkMarks.push([t,"intro"]);break;}
      case "outro":{const root=57+keyOff(),dur=lenBars*bd;D.spaceBoost=0.6;
        this.breakPre("echo",t);this.echoSendEnv.lin(0.5,t+3*bd);this.echoSendEnv.lin(0,t+7*bd);   // echo-out of the last beats, then only tails
        this.echoFbEnv.hold(t+0.06);this.echoFbEnv.lin(0.7,t+4*bd);
        this.lpEnv.hold(t);this.lpEnv.exp(1400,t+dur);
        for(const [m,ty,lvl,cut] of [[root-24,"sawtooth",0.065,420],[root-12,"triangle",0.075,800],[root+3,"sine",0.04,1600]])
          this.drone(t,dur,{midi:m,type:ty,det:10,cut,q:0.8,lvl,att:Math.min(0.8,dur*0.1),rel:3.5,lfo:0.05,depth:cut*0.3},this.padBus);
        this.brkMarks.push([t,"outro"]);break;}
      case "breakdown":{D.spaceBoost=0.3;const root=57+keyOff(),dur=lenBars*bd,att=Math.min(4,dur*0.3);
        // atmosphere pad (minor chord, slow attack) under whatever 上モノ keeps playing
        for(const [m,ty,lvl,cut] of [[root-24,"sawtooth",0.035,520],[root-17,"sawtooth",0.022,700],[root-9,"triangle",0.03,1400]])
          this.drone(t,dur,{midi:m,type:ty,det:12,cut,q:1,lvl,att,rel:2.4,lfo:0.07,depth:cut*0.4},this.padBus);
        if(S.riser)this.riserFx(Math.max(t,tr-Math.min(4,lenBars/2)*bd),tr,520);break;}
      case "filter":this.lpEnv.hold(t);this.lpEnv.exp(420,t+bd);break;              // muffle over one bar, open in armReturn
      case "hpbuild":this.hpEnv.hold(t);this.hpEnv.exp(lenBars>=4?1300:900,tr-0.12);D.riserOn=true;
        if(S.riser)this.riserFx(Math.max(t,tr-2*bd),tr,0,false);break;
      case "tapestop":{const t0=lastBar+8*s16,T=tr-t0-0.012,n=256,cv=new Float32Array(n);
        // delay time d(x) with d' = 1 - pitch, pitch = (1-x)^1.4  -> playback slows to a halt like a stopped deck
        for(let i=0;i<n;i++){const x=i/(n-1);cv[i]=T*(x-(1-Math.pow(1-x,2.4))/2.4);}
        this.tape.delayTime.setValueAtTime(0,t0);this.tape.delayTime.setValueCurveAtTime(cv,t0,T);
        this.lpEnv.hold(t0);this.lpEnv.exp(300,t0+T);this.brkEnv.hold(t0);this.brkEnv.lin(0.85,t0+0.5*T);this.brkEnv.lin(0,t0+T);
        this.brkMarks.push([t0,"tapestop"]);break;}
      case "stutter":{const t0=lastBar+8*s16;this.hpEnv.hold(t0);this.hpEnv.exp(380,tr-0.12);D.riserOn=true;this.brkMarks.push([t0,"stutter"]);break;}
      case "echo":D.spaceBoost=0.2;if(t-this.echoPreAt>bd)this.breakPre("echo",t);
        this.echoFbEnv.hold(t+0.06);this.echoFbEnv.lin(0.72,t+0.06+lenBars*bd*0.7);break;
      case "silence":{const t0=lastBar+12*s16;this.brkEnv.hold(t0);this.brkEnv.target(0.012,t0,0.008);this.brkMarks.push([t0,"silence"]);break;}
    }}
  // closing pressed during the opening: refresh the drone bed for the extra bars, echo / LPF slowly closing, parts peel away (mask)
  introHold(t,lenBars){const D=this.drop,bd=16*this.s16,dur=lenBars*bd,root=57+keyOff();D.holdFrom=this.bar;D.spaceBoost=0.6;
    this.breakPre("echo",t);this.echoSendEnv.lin(0.45,t+4*bd);this.echoSendEnv.lin(0,t+12*bd);this.echoFbEnv.hold(t+0.06);this.echoFbEnv.lin(0.68,t+6*bd);
    this.lpEnv.hold(t);this.lpEnv.exp(1400,t+dur);
    for(const [m,ty,lvl,cut] of [[root-24,"sawtooth",0.065,420],[root-12,"triangle",0.075,800],[root+3,"sine",0.04,1600]])
      this.drone(t,dur,{midi:m,type:ty,det:10,cut,q:0.8,lvl,att:Math.min(0.8,dur*0.1),rel:3.5,lfo:0.05,depth:cut*0.3},this.padBus);}
  // end of the closing phase: stop producing notes, fade the master (tails of echo / reverb / pads), then the transport stops
  closeAt(t){this.closed=true;const v=this.fadeG.gain;v.cancelScheduledValues(t);v.setValueAtTime(this.fadeLvl??1,t);v.linearRampToValueAtTime(0,t+5);
    this.riserBus.gain.setTargetAtTime(0,t,0.3);this.closeDoneT=t+5.3;}
  // which parts keep playing this step (k kick, h hat, c clap, p perc, b bass, u 上モノ)
  breakMask(s){const D=this.drop;if(!D.active)return M_ALL;
    const last=D.endBar>0&&this.bar===D.endBar-1;
    switch(D.type){
      case "kick":{const R=D.recipe||KD_DEFAULT;
        if(R.micro)return s>=16-R.micro?{...M_ALL,k:0,b:R.remove==="kickbass"?0:1}:M_ALL;
        switch(R.remove){case "kickbass":return {...M_ALL,k:0,b:0};case "beat1":return {...M_ALL,k:s===0?1:0};
          case "thin":case "lowcut":return M_ALL;default:return {...M_ALL,k:0};}}
      case "bridge":return M_NONE;
      case "intro":{const rel=this.bar-D.startBar;if(D.holdFrom!=null){const r2=this.bar-D.holdFrom;return {k:0,b:0,c:r2<4?1:0,h:r2<8?1:0,p:r2<12?1:0,u:r2<10?1:0};}
        return {k:0,b:0,h:rel>=4?1:0,c:rel>=8?1:0,p:1,u:rel>=8?1:0};}
      case "outro":{const rel=this.bar-D.startBar;return {k:0,b:0,c:rel<2?1:0,h:rel<4?1:0,p:rel<6?1:0,u:rel<5?1:0};}
      case "breakdown":return {...M_NONE,u:1};
      case "hpbuild":return last?{...M_ALL,k:0,b:0}:M_ALL;
      case "bassonly":return {...M_NONE,k:1,b:1};
      case "perconly":return {...M_NONE,h:1,c:1,p:1};
      case "tapestop":case "stutter":return last&&s>=8?M_NONE:M_ALL;
      case "echo":return M_NONE;
      case "halftime":return {...M_ALL,k:0,c:0,b:0};
      case "silence":return last&&s>=12?M_NONE:M_ALL;
      default:return M_ALL;}}
  // kick-drop fill in the last bar (or two); kicks played here are owned by the low deck only
  kickFill(R,t,s,ev,L,logK){const D=this.drop,rel=D.endBar-this.bar,s16=this.s16;if(!R||rel<1||rel>2)return;
    // a roll step never doubles a kick that already plays on this step (recipes that keep the kick: thin / lowcut / beat1 / offbeat)
    const busy=!!(this.breakMask(s).k&&L.kickBar[s])||(R.remove==="offbeat"&&!R.micro&&s%4===2&&!(rel===1&&s===14&&/kickroll/.test(R.fill)));
    if(rel===2){if(R.fill==="snareBuild"&&D.len>=2&&s%4===0){this.snare(t,0.16+0.01*s);ev.fill=1;}
      if(R.fill==="coreRoll"&&D.len>=2&&s%2===0&&!busy){const kv=0.42+0.012*s;this.kick(t,kv,{len:0.2});logK(t);ev.kick=kv;ev.fill=1;}return;}
    switch(R.fill){
      case "snare16":if(s>=12){this.snare(t,0.45+0.18*(s-12));ev.fill=1;if(s>=14)this.snare(t+s16/2,0.6+0.2*(s-14));}break;
      case "snareBuild":if(s<8){if(s%2===0){this.snare(t,0.3+0.025*s);ev.fill=1;}}else{this.snare(t,0.5+0.035*(s-8));if(s>=12)this.snare(t+s16/2,0.52+0.035*(s-8));ev.fill=1;}break;
      case "triplet":if(s===8){for(let i=0;i<6;i++)this.snare(t+i*8*s16/6,0.35+0.08*i);ev.fill=1;}break;
      case "coreRoll":{const pm=1+0.03*s,kv=Math.min(0.85,0.5+0.022*s);  // 16ths, then 32nds in the second half, pitch rising
        if(!busy){this.kick(t,kv,{pm,len:0.15});logK(t);}ev.kick=kv;ev.fill=1;
        if(s>=8&&s<15){const t2=t+s16/2;this.kick(t2,kv*0.9,{pm:pm+0.015,len:0.1});logK(t2);}break;}
      case "kickroll8":if(s>=8&&s%2===0&&s<=14&&!busy){const kv=0.45+0.06*(s-8);this.kick(t,kv);logK(t);ev.kick=kv;ev.fill=1;}break;
      case "kickroll16":if(s>=8&&(s<12?s%2===0:s<=14)&&!busy){const kv=0.4+0.05*(s-8);this.kick(t,kv);logK(t);ev.kick=kv;ev.fill=1;}break;
      case "tom":if(s>=10){this.cur=L.out;this.tom(t,s<12?2:(s<14?1:0),0.6+0.07*(s-10));if(s>=13)this.tom(t+s16/2,s<14?1:0,0.6);ev.fill=1;}break;
      case "revcym":if(s===0){this.revCym(t+(D.len>=2||R.micro?0:4*s16),t+16*s16);ev.fill=1;}break;
      case "echo":if(s===8)this.breakPre("echo",t);if(s===12){this.echoSendEnv.hold(t);this.echoSendEnv.lin(0,t+0.03);}break;
      // "gap" is scheduled in armReturn (needs to sit right before the return)
    }}
  // called in the last beat before the return, so every ramp can be placed ahead of the downbeat
  armReturn(tr,now){const D=this.drop,B=BREAKS[D.type],R=D.recipe;D.armed=true;D.tr=tr;this.returnTimes.push(tr);
    if(D.riserOn){
      const h=Math.max(now,tr-0.12);
      this.hpEnv.hold(h);this.hpEnv.exp(20,tr);      // smooth sweep down, lands at 20 Hz on the downbeat
      this.lvlEnv.hold(tr);this.lvlEnv.target(0,tr,0.11); // riser peaks at the downbeat then decays (~0.4 s)
      this.rfEnv.hold(tr);}
    switch(D.type){
      case "kick":{if(!R)break;
        if(R.remove==="lowcut"||R.remove==="thin"){const h=Math.max(now,tr-0.12);for(const k of ["kick","bass"]){this.lc[k].hold(h);this.lc[k].exp(12,tr);}}
        if(R.fill==="gap"){const t0=Math.max(now,tr-(R.micro===2?1:2)*this.s16);this.brkEnv.hold(t0);this.brkEnv.target(0.015,t0,0.006);this.brkEnv.hold(tr-0.003);this.brkEnv.lin(1,tr+0.004);}
        if(R.fill==="echo")this.echoClose(tr);break;}
      case "filter":{const h=Math.max(now,tr-4*this.s16);this.lpEnv.hold(h);this.lpEnv.exp(20000,tr);break;}
      // everything below happens while the break gain is ~0, then the gain ramps up over 10 ms on the downbeat
      case "tapestop":this.tape.delayTime.setValueAtTime(0,tr-0.008);this.lpEnv.set(20000,tr-0.006);
        this.brkEnv.hold(tr-0.004);this.brkEnv.lin(1,tr+0.006);break;
      case "silence":this.brkEnv.hold(tr-0.003);this.brkEnv.lin(1,tr+0.004);break;
      case "echo":{const bd=16*this.s16;this.echoSendEnv.hold(tr-0.03);this.echoSendEnv.lin(0,tr-0.002);
        this.echoFbEnv.hold(tr);this.echoFbEnv.lin(0.25,tr+bd);this.echoOutEnv.hold(tr);this.echoOutEnv.lin(0,tr+2*bd);break;}
    }
    if(D.noImpact)return;
    const imp=D.type==="kick"&&R?R.impact:(D.type==="bridge"?(this.cond.band==="bchill"?"crash":"crashboom"):(B.crash?"crash":"none"));
    if(S.crash&&(imp==="crash"||imp==="crashboom"))this.crash(tr);
    if(imp==="boom"||imp==="crashboom")this.boom(tr);}
  dropEnd(t){const D=this.drop,B=BREAKS[D.type];
    if(D.type==="intro")this.cond.logItem("オープニング完了：キックイン（ウォームアップへ）",D.meta?D.meta.src:"自動","done",this.bar,t);
    else if(D.src==="manual")this.cond.logItem("キック抜き（手動）：復帰","手動（K）","done",this.bar,t);
    else if(D.type==="kick"&&D.recipe)this.cond.logItem(`キック抜き（${D.recipe.name}）：復帰`,D.meta?D.meta.src:"自動","done",this.bar,t);
    else this.cond.logItem(`${B.ja} ${D.len}小節：復帰`,D.meta?D.meta.src:"自動","done",this.bar,t);D.meta=null;
    Object.assign(this.drop,{active:false,type:"kick",src:null,endBar:-1,armed:false,spaceBoost:0,recipe:null,dir:null,noImpact:false,toBpm:null});}
  // accelerating snare roll over the last 2 bars (component used by breakdown / hp build / bridge up)
  buildRoll(t,s,ev,logK){const D=this.drop,rel=D.endBar-this.bar,s16=this.s16;
    if(this.cond.band==="b160"&&D.type!=="bridge"&&logK){        // hardcore build-up: the roll is made of (short, rising) kicks
      if(this.breakMask(s).k&&this.low.kickBar[s]){if(rel===1&&s>=8&&s<15){const kv=Math.min(0.8,0.45+0.022*s);this.kick(t+s16/2,kv*0.9,{len:0.1,pm:1+0.035*s+0.02});logK(t+s16/2);}return;}
      if(rel===2&&D.len>=4){if(s%2===0){const kv=0.35+0.012*s;this.kick(t,kv,{len:0.18,pm:0.9+0.006*s});logK(t);ev.kick=kv;ev.fill=1;}}
      else if(rel===1){const kv=Math.min(0.8,0.45+0.022*s),pm=1+0.035*s;this.kick(t,kv,{len:0.14,pm});logK(t);ev.kick=kv;ev.fill=1;
        if(s>=8&&s<15){this.kick(t+s16/2,kv*0.9,{len:0.1,pm:pm+0.02});logK(t+s16/2);}if(s>=12)this.snare(t,0.3+0.05*(s-12));}
      return;}
    if(rel===2&&D.len>=4){if(s%2===0){this.snare(t,0.18+0.012*s);ev.fill=1;}}
    else if(rel===1){if(s<8){this.snare(t,0.32+0.025*s);ev.fill=1;}
      else{this.snare(t,0.5+0.035*(s-8));this.snare(t+s16/2,0.52+0.035*(s-8));ev.fill=1;}}}

  buildKickBar(d){const P=d.pat,r=this.rand,k=new Array(16).fill(0);
    if(this.chillMode==="beatless")return k;
    if(this.chillMode==="half"){k[0]=1;if(r()<0.35)k[10]=0.6;return k;}
    if(this.chillMode==="soft4"){for(const s of [0,4,8,12])k[s]=0.85;if(r()<0.25)k[[7,15][Math.floor(r()*2)]]=0.4;return k;}
    if(d.band==="bchill"){
      if(d.style==="broken"){k[0]=1;if(r()<0.5)k[10]=0.6;if(r()<0.2)k[7]=0.4;return k;}               // downtempo: half-time kick
      for(const s of [0,4,8,12])k[s]=d.style==="hard"?0.75:0.9;
      if(d.style==="hard"&&this.bar%8===7){k[8]=0;k[12]=0;}                                              // ambient: the beat breathes
      return k;}
    if(d.style==="broken"||(this.flav&&d===this.low&&this.bar>=this.flav.from&&this.bar<this.flav.until)){for(const s of P.broken)k[s]=s===0?1:0.9;return k;}
    for(const s of [0,4,8,12])k[s]=1;
    if(d.band==="b160"&&d.style==="hard"&&this.bar%4===3&&r()<0.45){k[14]=0.7;if(r()<0.5)k[15]=0.6;}   // gabber pickup into the next phrase
    if(d.style==="groove"){
      if(r()<P.grooveExtra){const s=[15,11,14,3,7][Math.floor(r()*5)];k[s]=0.55+0.25*r();}
      if(r()<P.grooveExtra*0.4){const s=[15,7,10][Math.floor(r()*3)];k[s]=Math.max(k[s],0.5);}
    }
    return k;}

  scheduleStep(t){if(this.t0==null)this.t0=t;this.lastT=t;
    if(this.closed){this.step++;return;}                // closing finished: only the fading tails remain
    const s=this.step%16,v=this.effVar(),r=this.rand,D=this.drop,C=this.cond,p=C.p;
    if(s===0){
      this.bar=(this.step/16)|0;
      // DJ pitch-ride: tempo glides bar by bar (constant within a bar so drop/return timing stays exact)
      // band switch: tempo glides bar by bar, only while the beatless bridge plays
      if(this.bpmGlide){const g=this.bpmGlide;if(this.bar>=g.b0){const k=Math.min(1,(this.bar-g.b0+1)/g.bars);
        this.bpm=g.from+(g.to-g.from)*k;if(k>=1){this.bpmGlide=null;if(g.label)C.logItem(g.label+"：到達",g.src,"done",this.bar,t);}this.setBpm(this.bpm,t);}}
      // in-band tempo drift: at most tempoRate BPM per 16-bar phrase toward the set's target (constant within a bar)
      else if(!C.pendingBand){const tg=C.tempoTarget(),dv=tg-this.bpm,mx=C.tempoRate/16;
        if(Math.abs(dv)>1e-4){this.bpm+=Math.max(-mx,Math.min(mx,dv));this.setBpm(this.bpm,t);}
        if(C.tempoGoal&&Math.abs(tg-this.bpm)<0.02){C.logItem(C.tempoGoal.label+"：到達",C.tempoGoal.src,"done",this.bar,t);C.tempoGoal=null;C.tempoRate=0.5;}}
      this.updateKickMorph();
      if(this.chillGlide){const g=this.chillGlide;if(this.bar>=g.b0){const x=Math.min(1,(this.bar-g.b0+1)/g.bars);this.chillAmt=g.from+(g.to-g.from)*x;if(x>=1)this.chillGlide=null;}}
      if(this.debug&&this.bar>0)this.chillLog.push([this.bar-1,this.hatBar,this.kickBarCnt]);this.hatBar=0;this.kickBarCnt=0;
      if(this.debug)this.kpLog.push([this.bar,+this.kp.drive.toFixed(3),+this.kp.rumble.toFixed(3),+this.kp.tau.toFixed(3),+this.kp.f0.toFixed(1)]);
      if(this.debug)(this.barTL=this.barTL||[]).push(t);
      if(this.debug)this.bpmLog.push([this.bar,+this.bpm.toFixed(3),this.low.style,this.decks.map(d=>d.style).join("+"),+this.chillAmt.toFixed(3),this.chillMode||"",+C.p.energy.toFixed(3),+C.p.density.toFixed(3)]);
      if(D.active && D.armed) this.dropEnd(t);      // return already prepared during the previous beat
      if(D.active && !D.armed && D.type==="kick" && (D.src==="manual"||this.bar>=D.endBar||S.dropManual)){D.src="manual";D.endBar=-1;}
      this.jazzPre();this.ornBar();
      C.onBar(this.bar,t);                          // conductor: intents, phrase plans, DJ mix events
      this.applyBarParams(t);
      this.flavourBar(t);
      for(const d of this.decks){d.pat.nextBar(v);this.kitBar(d);d.kickBar=this.buildKickBar(d);this.arrangeUpper(d);
        if(d.loopBP){const ph=((this.bar+d.id*5)%8)/8,f=(650+2600*(0.5-0.5*Math.cos(2*Math.PI*ph)))*Math.pow(2,(0.5-p.dark)*0.8);d.loopBP.frequency.setTargetAtTime(Math.min(6000,f),t,0.6);}}
      if(this.debug)this.arrLog.push([this.bar,this.decks.map(d=>[d.id,d.style,(d.arr.chillPatch||patchList(d)[d.arr.variant]).n,d.arr.section,d.arr.motif?d.arr.motif.id:0,d.arr.layer2&&this.bar%16===0?d.arr.layer2:"",d.arr.chillPatch?d.arr.chillPatch.n:""])]);
      const padOk=!(D.active&&["bridge","intro","outro"].includes(D.type));
      this.chipBar(t);this.jazzBar(t);
      const padNow=this.bar%8===0||(this.jazz.on&&this.bar===this.jazz.start)||this.chordOf(this.low).semi!==this.chordOf(this.low,this.bar-1).semi||this.padDeck!==this.low;  // v13: the pad follows the chord changes
      if(padNow&&(this.chillAmt>0.3||this.low.band==="bchill")&&padOk){this.padDeck=this.low;this.chillPad(t,this.chillAmt>0.3?this.chillAmt:0.55,this.padSpan(this.low));}   // chill band: warm pad bed throughout
      if(D.active&&D.type==="bridge"&&D.dir==="up"&&D.endBar-this.bar===2&&S.riser)this.riserFx(t,t+32*this.s16,520);   // tempo is final by now
    }
    if(S.dropManual && !D.active && s%4===0) this.dropStart(t,"manual",0);
    if(s===12 && !D.active){const pe=C.events.find(x=>x.bar===this.bar+1&&(x.type==="break"||x.type==="drop"));if(pe&&pe.btype)this.breakPre(pe.btype,t);}
    if(D.active && s===0) this.stats.dropBars++;
    const M=this.breakMask(s),BT=D.active?D.type:null,last=D.active&&D.endBar>0&&this.bar===D.endBar-1;
    const ev={kick:0,hat:0,clap:0,perc:0,bass:0,stab:0,drop:D.active&&!M.k,fill:0,brk:D.active?BREAKS[D.type].ja:""};
    const L=this.low;                               // only ONE deck owns kick+bass at any time
    const logK=tt=>{this.kickBarCnt++;if(this.debug)this.kickLog.push([tt,L.id]);};
    const ca=this.chillAmt;
    if(M.k && L.kickBar[s]){const kv=L.kickBar[s]*(1-0.25*ca);this.kick(t,kv);ev.kick=kv;logK(t);}
    if(BT==="kick"&&D.recipe&&D.recipe.remove==="offbeat"&&!D.recipe.micro&&s%4===2&&!(last&&s===14&&/kickroll/.test(D.recipe.fill))){this.kick(t,0.55);ev.kick=0.55;logK(t);}
    if(D.active && !D.armed && s>=12 && D.type!=="outro" && !(D.type==="intro"&&this.cond.closing) && (D.type!=="kick"||!S.dropManual) && (D.src==="manual"||this.bar===D.endBar-1))
      this.armReturn(t+(16-s)*this.s16,t);
    if(BT==="halftime"){                            // half-time: kick on 1, snare on 3, bass stretched over 2 bars
      if(s===0||(s===10&&r()<0.35)){const kv=s?0.65:1;this.kick(t,kv);ev.kick=kv;logK(t);}
      if(s===8){this.cur=L.out;this.clap(t);this.snare(t,0.5);ev.clap=1;}
      if(s%2===0&&!(L.band==="b160"&&BASS160[L.style]==="none")){const bn=L.pat.bass[(s>>1)+8*((this.bar-D.startBar)%2)];if(bn){this.bass(t,bn,1.8);ev.bass=1;if(this.debug)this.bassLog.push([t,L.id]);}}}
    if(BT==="stutter"&&last&&s>=8){                 // beat repeat: 8th -> 16th -> 32nd retriggers of the beat-3 slice
      const reps={8:[0],10:[0],12:[0],13:[0],14:[0,0.5],15:[0,0.5]}[s]||[],note=L.pat.bass.slice(8).find(Boolean)||{deg:0,oct:0};
      for(const f of reps){const tt=t+f*this.s16,pr=(s-8+f)/8,kv=0.55+0.45*pr;this.cur=L.out;
        if(s<15){this.kick(tt,kv);logK(tt);}this.snare(tt,0.25+0.45*pr);this.hat(tt,0.2+0.15*pr,0.03,0.008,(r()-0.5)*0.6);this.bass(tt,note,0.5);ev.kick=kv;ev.fill=1;ev.bass=1;}}
    if(D.active && (BT==="breakdown"||BT==="hpbuild"||(BT==="bridge"&&D.dir==="up")) && D.endBar>0) this.buildRoll(t,s,ev,logK);
    else if(BT==="kick"&&D.endBar>0){if(S.fill)this.kickFill(D.recipe,t,s,ev,L,logK);}
    else if(BT==="kick"&&D.armed&&S.fill&&s>=12){this.snare(t,0.45+0.18*(s-12));ev.fill=1;if(s>=14)this.snare(t+this.s16/2,0.6+0.2*(s-14));}
    else if(S.fill && D.active && BREAKS[BT].fill && s>=12 && D.armed){
      this.snare(t,0.45+0.18*(s-12));ev.fill=1;
      if(s>=14) this.snare(t+this.s16/2,0.6+0.2*(s-14));}
    else if(!D.active && p.tension>0.55 && this.bar%16===15 && s>=12 && this.ornB().fill>0 && r()<p.tension){this.snare(t,0.25+0.12*(s-12));ev.fill=1;}
    this.jazzSwingStep();
    for(const d of this.decks){if(!d.topOn)continue;this.cur=d.out;this.drumsTop(d,t,s,ev,v,M);}
    this.cur=L.out;
    const bm=L.band==="b160"?BASS160[L.style]:(L.band==="bchill"?BASSCH[L.style]:null),
      b160Skip=bm==="none"?!(ca>0.5):(bm==="off"?s%4!==2:(bm==="sparse"?s%8!==0&&s%8!==3:(bm==="half"?(s%2===1||r()<0.4):false)));
    const bn=L.pat.bassAt(s,this.bar),bSkip=b160Skip||(ca>0.05&&(this.chillMode==="beatless"?s%8!==0&&s%8!==3:(s%4!==2&&r()<0.55*ca)));
    const JW=this.jazz.on&&this.jazz.walk&&!D.active&&this.chillMode!=="beatless";   // v20: walking-ish bass replaces the pattern
    if(JW){if(M.b&&(s%4===0||s===14)){this.bass(t+this.swOff(s),this.jazzWalk(s),s===12?1.8:(s===14?1.6:3));ev.bass=1;if(this.debug)this.bassLog.push([t,L.id]);}}
    else if(M.b&&bn&&!bSkip){this.bass(t+this.swOff(s),bn,this.chillMode==="beatless"||bm==="sparse"?2.5:(bm==="off"?0.6:(bm==="half"?1.3:1)),L.band==="b160"&&L.style==="broken");ev.bass=1;if(this.debug)this.bassLog.push([t,L.id]);}
    let h=0;if(M.u&&!(this.chip&&this.chip.on)&&!this.jazz.on&&this.ornB().mel)for(const d of this.decks)if(d.upOn&&this.melOK(d))h=Math.max(h,this.upperStep(d.style,t,s,d)||0);ev.stab=h;
    if(M.u&&this.chip.on)this.chipStep(t,s);
    if(this.jazz.on)this.jazzStep(t,s,M);
    const B=D.active?BREAKS[D.type]:null;
    ev.dropInfo=D.active?(D.src==="auto"?`${D.type==="kick"&&D.recipe?"キック抜き（"+D.recipe.name+"）":B.ja+" "+D.len+"小節"}（残り${Math.max(0,D.endBar-this.bar)}）`:(S.dropManual?"キック抜き・手動（押下中）":"キック抜き・次の小節で復帰")):"";
    ev.style=L.style;ev.decks=this.decks.map(d=>d.style);
    if(this.onStep) this.onStep(s,t,ev,this.bar);
    this.step++;
  }
  drumsTop(d,t,s,ev,v,M=M_ALL){const p=this.cond.p,dn=this.dens(),ca=this.chillAmt,cm=this.chillMode,hv=1-0.55*ca,K=d.kit;
    let tsw=s%2===1?t+p.swing*0.25*this.s16:t;
    if(this.jzA>0){t=t+this.swOff(s);tsw=t;}               // v22: hats / claps / perc share the jazzy swing
    if(d.band==="bchill"){this.drumsChill(d,t,tsw,s,ev,v,M,dn,ca,cm);return;}
    if(M.h&&!(cm==="beatless"&&ca>0.6))this.kitHat(d,K,t,tsw,s,ev,hv,ca,p);       // v21: per-deck hat family / pattern family / drift / fills
    if(M.c&&cm!=="beatless")this.kitClap(d,K,t,tsw,s,ev,ca,cm);                    // v21: clap timbre + flams / pre-claps / phrase-end extras / dub tail
    if(M.p)this.kitPerc(d,K,t,tsw,s,ev,dn,ca,0);                                   // v21: polyrhythmic perc layers (budget 2-3)
  }
}

/* v21: per-deck drum kits. Each deck draws its own seed-driven identity (hat timbre family + pattern family, clap timbre + variations,
   a palette of 2-4 percussion layers with polyrhythmic cycles); a set-level preference keeps decks of one set related, and the next deck
   avoids the outgoing deck's choices so a swap changes the drum feel. Everything evolves slowly (4-bar ghost edits, phrase-level
   pattern / layer changes, 8-16 bar decay / filter drift) -- per-hit randomness is limited to small velocity humanising. */
const HAT_FAM_JA={tight:"タイト",open:"オープン",metal:"909メタル",shaker:"シェイカー",ride:"ライド"};
const HAT_PAT_JA={off:"裏打ち",e8:"8分",a16:"16分アクセント",roll:"ローリング16分",s332:"3-3-2"};
const CLAP_JA={tight:"タイトクラップ",room:"ルームクラップ",rim:"リム",layer:"クラップ＋スネア"};
const PERC_JA={conga:"コンガ",bongo:"ボンゴ",tom:"タム",bell:"カウベル",wood:"ウッドブロック",click:"メタルクリック",blip:"FMブリップ",shk:"シェイカー",ride:"ライド"};
const KIT_STYLE={
  minimal:{hat:{tight:3,metal:2,shaker:1,open:.6,ride:.4},pat:{off:3,a16:2,e8:1,roll:1,s332:.6},clap:{tight:2,rim:3,room:1,layer:.4},perc:{click:3,blip:3,wood:2,bell:.8,bongo:.6,conga:.4,tom:.3,ride:.6,shk:.4}},
  hard:{hat:{metal:3,open:2,tight:1.5,ride:.8,shaker:.3},pat:{a16:3,roll:2,off:2,e8:1,s332:.8},clap:{layer:3,room:2,tight:1.5,rim:.3},perc:{tom:3,click:2.5,ride:2,bell:1,blip:1,wood:.5,conga:.3,bongo:.3,shk:.3}},
  groove:{hat:{shaker:2.5,open:2,tight:1.5,ride:1.5,metal:.8},pat:{e8:2.5,a16:2,s332:1.5,off:1.5,roll:1},clap:{room:2.5,tight:2,layer:1,rim:1},perc:{conga:3,bongo:2.5,shk:2.5,bell:2,ride:1.5,wood:1,blip:.6,tom:.5,click:.5}},
  tribal:{hat:{shaker:2.5,tight:1.5,open:1,metal:1,ride:.6},pat:{s332:3,roll:2,a16:1.5,e8:1,off:1},clap:{rim:2,room:2,tight:1,layer:1},perc:{tom:3.5,conga:3,bongo:2,wood:1.5,shk:1,bell:.6,click:.5,blip:.3}},
  broken:{hat:{tight:2,shaker:2,metal:1.5,open:1,ride:.5},pat:{roll:2.5,a16:2,s332:1.5,e8:1,off:1},clap:{tight:2,rim:2,room:1.5,layer:1},perc:{blip:3,bongo:2,click:2,wood:1.5,conga:1,tom:.5,bell:.5,shk:.6}}};
const HAT_NEXT={off:["e8","a16"],e8:["off","a16","s332"],a16:["roll","e8","off"],roll:["a16","s332"],s332:["e8","roll","a16"]};
const OPEN_VARS=[[6,14],[14],[6],[10],[2,10],[14,"odd"],[6,"odd"]];
const PERC_BASE={conga:[57,[0,7,12,3]],bongo:[69,[0,7,3,12]],tom:[45,[0,7,12,5]],bell:[81,[0,7]],wood:[81,[0,7,3]],blip:[81,[0,3,7,10,12]]};   // in key: minor-pent degrees
const PERC_CYC={conga:[16,16,3,6],bongo:[16,3,6,5],tom:[3,5,16,6],bell:[16,16,5],wood:[5,7,3,16],click:[16,5,7,3],blip:[3,5,7,16],shk:[16],ride:[16]};
const PERC_LVL={conga:.34,bongo:.24,tom:.36,bell:.1,wood:.15,click:.13,blip:.1,shk:.15,ride:.8};
function h3(a,b,c){let x=(a*374761393+b*668265263+c*2246822519)|0;x=Math.imul(x^x>>>13,1274126177);x^=x>>>16;return (x>>>0)/4294967296;}
Object.assign(Engine.prototype,{
  kitPick(o,r){let s=0;for(const k in o)s+=o[k];let x=r()*s;for(const k in o){x-=o[k];if(x<=0&&o[k]>0)return k;}return Object.keys(o).find(k=>o[k]>0);},
  makeKit(d){const r=this.dr||(this.dr=mulberry32(this.seed^0xd21d)),st=KIT_STYLE[d.style]||KIT_STYLE.minimal,ch=d.band==="bchill",prev=this.low&&this.low!==d&&this.low.kit;
    if(!this.drumSet){const p0=KIT_STYLE.minimal;this.drumSet={hat:this.kitPick(p0.hat,r),clap:this.kitPick(p0.clap,r),perc:[this.kitPick(p0.perc,r),this.kitPick(KIT_STYLE.groove.perc,r)]};}
    const DS=this.drumSet;
    const W=(o,kind,prevV,fav)=>{const out={};for(const k in o){let w=o[k];
        if(ch&&kind==="hat"&&!["tight","shaker","ride"].includes(k))w*=0.12;if(ch&&kind==="pat"&&["roll","a16"].includes(k))w*=0.3;
        if(ch&&kind==="perc"&&["click","tom","ride"].includes(k))w*=0.3;
        if(fav&&(Array.isArray(fav)?fav.includes(k):fav===k))w*=2;                 // set coherence
        if(prevV&&(Array.isArray(prevV)?prevV.includes(k):prevV===k))w*=0.35;       // a swap changes the feel
        out[k]=w;}return out;};
    const K={id:Math.floor(r()*1e6),hat:{fam:this.kitPick(W(st.hat,"hat",prev&&prev.hat.fam,DS.hat),r),pat:this.kitPick(W(st.pat,"pat",prev&&prev.hat.pat),r),
        open:OPEN_VARS[Math.floor(r()*OPEN_VARS.length)],lp:r()<0.5?8:16,ph:r(),ld:0.25+0.35*r(),dbl:new Set()},
      clap:{tim:this.kitPick(W(st.clap,"clap",prev&&prev.clap.tim,DS.clap),r),flam:r()<0.45?0.25+0.3*r():0,pre:r()<0.4?0.2+0.3*r():0,preS:[11,3,7,15][Math.floor(r()*4)],
        extra:r()<0.55?0.4+0.4*r():0,exS:[14,15,10][Math.floor(r()*3)],tail:r()<0.45},
      perc:[],bp:r()<0.5?16:32,bph:r(),fill:null,cr:r()<0.5};
    this.genHat(K.hat,r);
    const pw=W(st.perc,"perc",prev&&prev.perc.filter(x=>x.on).map(x=>x.kind),DS.perc),n=ch?2+(r()<0.4?1:0):3+(r()<0.5?1:0);
    for(let i=0;i<n;i++){const k=this.kitPick(pw,r);if(!k)break;pw[k]=0;K.perc.push(this.genPerc(k,r,ch));}
    const nOn=ch?1:(r()<0.35?1:2);K.perc.forEach((L,i)=>L.on=i<nOn);this.kitRoles(K);
    return K;},
  genHat(H,r){const v=new Array(16).fill(0),P=H.pat,g=(n,set)=>{for(let i=0;i<n;i++){const s=set[Math.floor(r()*set.length)];if(!v[s])v[s]=0.3+0.15*r();}};
    if(P==="off"){for(const s of [2,6,10,14])v[s]=1;g(1+Math.floor(r()*2),[1,3,5,7,9,11,13,15]);}
    else if(P==="e8"){for(let s=0;s<16;s+=2)v[s]=s%4===2?1:0.5+0.1*r();g(1,[3,7,11,15,1,5,9,13]);}
    else if(P==="a16"){for(let s=0;s<16;s++)v[s]=s%4===2?1:(s%2===0?0.55+0.1*r():0.32+0.15*r());}
    else if(P==="roll"){for(let s=0;s<16;s++)v[s]=s%4===2?1:(s%2===0?0.45:(r()<0.75?0.25+0.2*r():0));H.dbl=new Set([[7,15],[15],[11,15],[3,11]][Math.floor(r()*4)]);}
    else{for(const s of [0,3,6,8,11,14])v[s]=0.85;v[2]=Math.max(v[2],0.75);v[10]=Math.max(v[10],0.75);g(1,[1,5,9,13]);}   // 3-3-2 over the bar, offbeats kept
    H.v=v;},
  genPerc(kind,r,ch){const cyc=PERC_CYC[kind][Math.floor(r()*PERC_CYC[kind].length)],L={kind,cyc,id:Math.floor(r()*1e6),off:Math.floor(r()*cyc),hits:[],pan:(r()-0.5)*0.9,lvl:PERC_LVL[kind]*(ch?0.65:1),pi:0,on:false,role:"both"};
    if(kind==="shk"){for(let s=0;s<16;s++)if(s%4===2)L.hits.push({o:s,a:1});else if(s%2===1&&r()<0.6)L.hits.push({o:s,a:0.5});else if(s%4===0&&r()<0.3)L.hits.push({o:s,a:0.35});}
    else if(kind==="ride"){for(const s of [2,6,10,14])L.hits.push({o:s,a:1});if(r()<0.5)L.hits.push({o:[7,15,11][Math.floor(r()*3)],a:0.5});}
    else if(cyc===16){const pool=[3,6,7,10,11,14,15,2,13,5],k=2+Math.floor(r()*(ch?2:3)),used=new Set();
      while(used.size<k){used.add(pool[Math.floor(r()*(used.size<2?7:pool.length))]);}
      for(const s of [...used].sort((a,b)=>a-b))L.hits.push({o:s,a:used.size&&s===[...used][0]?1:(r()<0.5?1:0.6)});}
    else{L.hits.push({o:0,a:1});if(cyc>=5&&r()<0.6)L.hits.push({o:2+Math.floor(r()*(cyc-3)),a:0.6});}
    const B=PERC_BASE[kind];if(B){const m=[0];const n=1+Math.floor(r()*3);for(let i=0;i<n;i++)m.push(B[1][1+Math.floor(r()*(B[1].length-1))]);L.pm=m.map(x=>B[0]+x);}
    return L;},
  kitRoles(K){const on=K.perc.filter(x=>x.on);for(const L of K.perc)L.role="both";if(K.cr&&on.length>=2){on[0].role="call";on[1].role="resp";}},
  // bar hook: slow evolution + phrase-level layer changes + fills
  kitBar(d){const K=d.kit;if(!K)return;const r=this.dr,bar=this.bar,H=K.hat,ch=d.band==="bchill";
    const ph16=bar>0&&bar%16===0,pH=ph16&&this.ornPlan("hat"),pP=ph16&&this.ornPlan("perc"),pC=ph16&&this.ornPlan("clap"),OB=this.ornB();   // v23: changes only where the phrase plan allows
    if(pH&&r()<0.7){const odd=[1,3,5,7,9,11,13,15].filter(s=>!(H.pat==="s332"&&[3,11].includes(s))),s=odd[Math.floor(r()*odd.length)],ng=H.v.filter((x,i)=>i%2&&x>0).length;
      if(H.v[s]>0&&H.v[s]<0.7)H.v[s]=0;else if(!H.v[s]&&ng<(H.pat==="a16"||H.pat==="roll"?8:3))H.v[s]=0.28+0.15*r();}
    if(bar>0&&bar%16===0){
      if(pH&&r()<0.3){H.pat=HAT_NEXT[H.pat][Math.floor(r()*HAT_NEXT[H.pat].length)];this.genHat(H,r);}
      if(pH&&r()<0.1&&!ch){const st=KIT_STYLE[d.style]||KIT_STYLE.minimal;H.fam=this.kitPick(st.hat,r);}
      if(pH&&r()<0.4){H.lp=r()<0.5?8:16;}
      const on=K.perc.filter(x=>x.on),off=K.perc.filter(x=>!x.on),mx=Math.max(1,ch?Math.min(2,OB.perc):OB.perc),x=pP?r():1;
      if(x<0.3&&on.length<mx&&off.length)off[Math.floor(r()*off.length)].on=true;
      else if(x<0.55&&on.length>1)on[Math.floor(r()*on.length)].on=false;
      else if(x<0.72&&off.length&&on.length){on[Math.floor(r()*on.length)].on=false;off[Math.floor(r()*off.length)].on=true;}
      while(K.perc.filter(x=>x.on).length>mx)K.perc.filter(x=>x.on).pop().on=false;
      if(pP)for(const L of K.perc){if(r()<0.25)L.off=(L.off+1)%L.cyc;if(L.pm&&r()<0.25)L.pm.push(L.pm.shift());
        if(L.cyc===16&&L.kind!=="shk"&&L.kind!=="ride"&&r()<0.25){const i=Math.floor(r()*L.hits.length);const o=[3,6,7,10,11,14,15][Math.floor(r()*7)];if(!L.hits.some(h=>h.o===o))L.hits[i]={o,a:L.hits[i].a};}}
      if(pP&&r()<0.3)K.cr=!K.cr;this.kitRoles(K);
      if(pC){if(r()<0.4)K.clap.flam=K.clap.flam?0:0.3+0.4*r();if(r()<0.4)K.clap.pre=K.clap.pre?0:0.3+0.3*r();if(r()<0.25)K.clap.tail=!K.clap.tail;}}
    if(pH&&r()<0.4)H.open=OPEN_VARS[Math.floor(r()*OPEN_VARS.length)];
    K.fill=null;if(!this.drop.active&&!ch){const p=Math.min(0.8,(bar%16===15?0.5:(bar%8===7?0.1:0))*OB.fill);if(r()<p)K.fill=["roll","open","stut","drop"][Math.floor(r()*4)];}},
  kitHat(d,K,t,tsw,s,ev,hv,ca,p){const H=K.hat,P=d.pat,bar=this.bar,s16=this.s16,ph=2*Math.PI*((bar+s/16)/H.lp+H.ph),tm=1+H.ld*Math.sin(ph),fm=1+0.1*Math.sin(ph*0.5+1);
    const F=K.fill,hum=()=>0.88+0.24*this.rand(),en=0.8+0.45*p.energy;let vv=H.v[s];
    const OB=this.ornB(),openOK=OB.open&&(P.openHat||p.energy>0.72)&&ca<0.5,ov=H.open,isOpen=openOK&&ov.includes(s)&&(!ov.includes("odd")||bar%2===1);
    if(F==="drop"&&s>=12)return;
    if(F==="roll"&&s>=12){for(const f of [0,0.5]){const k=(s-12+f)/4;this.kitHatHit(H,t+f*s16,hv*(0.12+0.3*k)*en,tm*0.7,fm,false,this.cur.hat);}ev.hat=1;this.hatBar++;return;}
    if(F==="stut"&&s>=8){this.kitHatHit(H,s%2?tsw:t,hv*(0.14+0.3*(s-8)/8)*en,tm*0.8,fm,false,this.cur.hat);ev.hat=1;this.hatBar++;return;}
    if(F==="open"&&s>=14){if(s===14){this.kitHatHit(H,t,hv*0.2,tm*1.6,fm,true,this.cur.hat);ev.hat=1;this.hatBar++;}return;}
    if(isOpen){this.kitHatHit(H,t,hv*0.17*en/1.1,tm,fm,true,this.cur.hat);ev.hat=1;this.hatBar++;return;}
    if(!vv)return;
    const main=vv>=0.7;
    if(main){if(this.rand()<0.45*ca)return;}
    else if(h3(K.id,bar,s)>(1-0.8*ca)*Math.min(1,0.35+1.1*p.density)*OB.ghost)return;   // ghosts thin out with density (deterministic per bar/step)
    const tt=s%2?tsw:t,vel=hv*(main?0.38*P.hatAccent[s]:0.36*vv)*hum()*(main?en:1);
    this.kitHatHit(H,tt,vel,tm,fm,false,this.cur.hat);if(H.dbl.has(s)&&OB.dbl)this.kitHatHit(H,tt+s16/2,vel*0.45,tm*0.8,fm,false,this.cur.hat);
    ev.hat=Math.max(ev.hat,main?1:0.4);this.hatBar++;},
  kitHatHit(H,t,vel,tm,fm,open,bus){const pan=(this.rand()-0.5)*0.35;
    switch(H.fam){
      case "metal":if(open)this.metalHat(t,vel*0.9,0.075*tm,bus);else this.metalHat(t,vel,0.016*tm,bus);break;
      case "shaker":if(open)this.hat(t,vel*0.9,0.2,0.05*tm,pan,6000*fm,bus,"bandpass");else this.hat(t,vel*1.1,0.05,0.016*tm,pan,5600*fm,bus,"bandpass");break;
      case "ride":if(open||vel>0.2)this.ride(t,open?1.1:vel*2.6,bus);else this.hat(t,vel,0.03,0.008*tm,pan,8000*fm,bus);break;
      case "open":if(open)this.hat(t,vel,0.35,0.09*tm,pan,6800*fm,bus);else this.hat(t,vel,0.07,0.022*tm,pan,7200*fm,bus);break;
      default:if(open)this.hat(t,vel,0.3,0.065*tm,pan,7500*fm,bus);else this.hat(t,vel,0.05,0.01*tm,pan,8600*fm,bus);}},
  metalHat(t,vel,tau,bus=this.cur.hat){const c=this.ctx,bp=c.createBiquadFilter(),hp=c.createBiquadFilter(),g=c.createGain(),end=t+Math.max(0.08,tau*8);
    bp.type="bandpass";bp.frequency.value=10500;bp.Q.value=0.9;hp.type="highpass";hp.frequency.value=7200;
    g.gain.setValueAtTime(vel*0.55,t);g.gain.setTargetAtTime(0,t,tau);
    const os=[];for(const f of [263,400,421,600,756,1000]){const o=c.createOscillator();o.type="square";o.frequency.value=f*2.1;o.connect(bp);o.start(t);o.stop(end);os.push(o);}
    bp.connect(hp).connect(g).connect(bus);this.hat(t,vel*0.45,0.04,tau*0.7,0,9000,bus);
    os[0].onended=()=>{for(const o of os)o.disconnect();bp.disconnect();hp.disconnect();g.disconnect();};},
  kitClap(d,K,t,tsw,s,ev,ca,cm){const C=K.clap,bar=this.bar,vel=1-0.5*ca,main=cm==="half"?s===8:(s===4||s===12),lite=C.tim==="layer"?"tight":C.tim;
    const OB=this.ornB(),end8=bar%8===7,end4=bar%4===3&&s===12;          // v23: ornaments at 8 / 16-bar phrase ends (4-bar ends only at the fullest budget)
    if(main){if(C.flam&&(end8||(OB.flam>=1&&end4))&&h3(K.id+7,bar,s)<C.flam*OB.flam)this.clapK(t-0.019,vel*0.38,lite);
      this.clapK(t,vel,C.tim,C.tail&&OB.fill>0&&end8&&s===12);ev.clap=1;return;}
    if(this.drop.active||cm==="half")return;
    if(C.pre&&s===C.preS&&(end8||(OB.pre>=1&&bar%4===3))&&h3(K.id+3,bar,s)<C.pre*OB.pre){this.clapK(s%2?tsw:t,0.22*vel,lite);ev.clap=Math.max(ev.clap,0.3);}
    if(C.extra&&bar%8===7&&s===C.exS&&h3(K.id+5,bar>>3,s)<C.extra*OB.pre){this.clapK(s%2?tsw:t,0.55*vel,lite);ev.clap=Math.max(ev.clap,0.6);}},
  clapK(t,vel,tim,tail){const c=this.ctx,bus=this.cur.clap;
    if(tim==="rim"){const n=this.noiseSrc(t,0.05),bp=c.createBiquadFilter(),g=c.createGain(),o=c.createOscillator(),og=c.createGain();
      bp.type="bandpass";bp.frequency.value=1900;bp.Q.value=2.5;g.gain.setValueAtTime(0.42*vel,t);g.gain.setTargetAtTime(0,t,0.014);
      o.type="triangle";o.frequency.value=mtof(81+keyOff());og.gain.setValueAtTime(0.2*vel,t);og.gain.setTargetAtTime(0,t,0.012);   // in key
      n.connect(bp).connect(g).connect(bus);o.connect(og).connect(bus);o.start(t);o.stop(t+0.12);this.free(n,bp,g);this.free(o,og);
      if(tail){const s2=c.createGain();s2.gain.value=0.5;g.connect(s2).connect(this.send);o.addEventListener("ended",()=>s2.disconnect());}return;}
    const room=tim==="room",n=this.noiseSrc(t,room?0.8:0.5),bp=c.createBiquadFilter(),g=c.createGain();
    bp.type="bandpass";bp.frequency.value=room?1450:1700;bp.Q.value=room?0.9:1.2;
    const v=0.32*vel*(tim==="layer"?0.85:1);g.gain.setValueAtTime(0,t);
    for(const o of [0,0.011,0.022]){g.gain.setValueAtTime(v,t+o);g.gain.setTargetAtTime(0,t+o,0.006);}
    g.gain.setValueAtTime(v*(room?0.7:0.8),t+0.03);g.gain.setTargetAtTime(0,t+0.03,room?0.1:0.045);
    n.connect(bp).connect(g).connect(bus);const xs=[];
    if(room){const vs=c.createGain();vs.gain.value=0.3;g.connect(vs).connect(this.upVerb);xs.push(vs);}
    if(tail){const ds=c.createGain();ds.gain.value=0.45;g.connect(ds).connect(this.send);xs.push(ds);}
    this.free(n,bp,g,...xs);
    if(tim==="layer"){const n2=this.noiseSrc(t,0.3),b2=c.createBiquadFilter(),g2=c.createGain(),o=c.createOscillator(),og=c.createGain();
      b2.type="bandpass";b2.frequency.value=2300;b2.Q.value=0.7;g2.gain.setValueAtTime(0.2*vel,t);g2.gain.setTargetAtTime(0,t,0.05);
      o.type="triangle";o.frequency.setValueAtTime(mtof(55+keyOff()),t);o.frequency.exponentialRampToValueAtTime(mtof(50+keyOff()),t+0.05);   // body: key root -> 5th below
      og.gain.setValueAtTime(0.2*vel,t);og.gain.setTargetAtTime(0,t,0.035);
      n2.connect(b2).connect(g2).connect(bus);o.connect(og).connect(bus);o.start(t);o.stop(t+0.25);this.free(n2,b2,g2);this.free(o,og);}},
  kitPerc(d,K,t,tsw,s,ev,dn,ca,ch){const g=this.step,bar=this.bar;let act=K.perc.filter(L=>L.on);
    if(this.jazz&&this.jazz.on)act=act.slice(0,1);
    act=act.slice(0,this.ornB().perc);                                         // v23: perc layer budget (stripped: 0-1)                             // the jazzy ride / brushes take the room
    const two=act.filter(L=>L.role!=="both").length===2,br=0.62+0.38*Math.sin(2*Math.PI*(bar/K.bp+K.bph));
    for(const L of act){if(two&&L.role==="call"&&bar%2===1&&s>=8)continue;if(two&&L.role==="resp"&&(bar%2===0||s<8))continue;   // call / response
      const ph=L.cyc===16?s:((g-L.off)%L.cyc+L.cyc)%L.cyc,hit=L.hits.find(x=>x.o===ph);if(!hit)continue;
      if(hit.a<0.9&&h3(L.id,g,1)>br*Math.min(1,dn+0.15))continue;               // density breathing (seeded)
      const m=L.pm?L.pm[(L.pi++)%L.pm.length]+keyOff():0,tt=s%2?tsw:t;
      this.pz(tt,L.kind,m,hit.a*L.lvl*(1-0.4*ca)*(0.9+0.2*this.rand()),L.pan);ev.perc=Math.max(ev.perc,hit.a);this.stats.perc++;}},
  pz(t,kind,midi,vel,pan){const c=this.ctx,bus=this.cur.perc,P=c.createStereoPanner();P.pan.value=pan;P.connect(bus);
    if(kind==="shk"){this.hat(t,vel,0.05,0.014,pan,5200,bus,"bandpass");P.disconnect();return;}
    if(kind==="ride"){this.ride(t,vel,bus);P.disconnect();return;}
    if(kind==="click"){const n=this.noiseSrc(t,0.03),bp=c.createBiquadFilter(),g=c.createGain();bp.type="bandpass";bp.frequency.value=6500+2000*((Math.abs(pan)*7)%1);bp.Q.value=9;
      g.gain.setValueAtTime(vel*1.6,t);g.gain.setTargetAtTime(0,t,0.008);n.connect(bp).connect(g).connect(P);this.free(n,bp,g,P);return;}
    const f=mtof(midi),o=c.createOscillator(),g=c.createGain();let end;
    if(kind==="bell"){const o2=c.createOscillator(),bp=c.createBiquadFilter();o.type="square";o2.type="square";o.frequency.value=f;o2.frequency.value=mtof(midi+7);
      bp.type="bandpass";bp.frequency.value=f*2;bp.Q.value=1.6;g.gain.setValueAtTime(vel,t);g.gain.setTargetAtTime(vel*0.3,t,0.012);g.gain.setTargetAtTime(0,t+0.02,0.06);
      o.connect(bp);o2.connect(bp);bp.connect(g).connect(P);end=t+0.5;o.start(t);o2.start(t);o.stop(end);o2.stop(end);this.free(o,o2,bp,g,P);return;}
    if(kind==="blip"){const m=c.createOscillator(),mg=c.createGain();o.type="sine";m.type="sine";o.frequency.value=f;m.frequency.value=f*2;
      mg.gain.setValueAtTime(f*2.2,t);mg.gain.setTargetAtTime(0,t,0.02);m.connect(mg).connect(o.frequency);
      g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vel,t+0.002);g.gain.setTargetAtTime(0,t+0.002,0.035);
      o.connect(g).connect(P);end=t+0.3;o.start(t);m.start(t);o.stop(end);m.stop(end);this.free(o,m,mg,g,P);return;}
    const tau={conga:0.16,bongo:0.08,tom:0.2,wood:0.025}[kind]||0.1,bend={conga:1.5,bongo:1.35,tom:1.8,wood:1.08}[kind]||1.3,bt={conga:0.025,bongo:0.015,tom:0.045,wood:0.006}[kind]||0.02;
    o.type=kind==="wood"?"triangle":"sine";o.frequency.setValueAtTime(f*bend,t);o.frequency.exponentialRampToValueAtTime(f,t+bt);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vel,t+0.002);g.gain.setTargetAtTime(0,t+0.003,tau);
    end=t+tau*9;o.connect(g).connect(P);o.start(t);o.stop(end);this.free(o,g,P);
    if(kind!=="wood")this.hat(t,vel*(kind==="bongo"?0.4:0.3),0.012,0.004,pan,kind==="bongo"?3800:2600,bus,"bandpass");   // slap
    else this.hat(t,vel*0.5,0.01,0.003,pan,2200,bus,"bandpass");},
  kitDesc(K){if(!K)return "";const on=K.perc.filter(x=>x.on).map(x=>PERC_JA[x.kind]);return `${HAT_FAM_JA[K.hat.fam]}ハット・${HAT_PAT_JA[K.hat.pat]}／${CLAP_JA[K.clap.tim]}${on.length?"／"+on.join("・"):""}`;},
});

/* v23: ornament budget + stripped sections (メリハリ). Per bar a budget from the set arc (phase) and energy decides how much decoration
   is allowed (perc layers, ghost hats, rolls, fills, flams / pre-claps, melodic voice); some 8-16 bar stretches per set are deliberately
   stripped (kick + bass + plain hat, maybe one perc), typically after a peak, on a new deck, or at the start of a build, so the next full
   section hits harder. At each 16-bar boundary only 1-2 elements (hats / perc / claps / lead) may change. */
const ORN_PHASE={warm:0.55,build:0.72,peak:1,release:0.6,chill:0.45};
Object.assign(Engine.prototype,{
  ornBar(){const bar=this.bar,cd=this.cond,r=this.orr||(this.orr=mulberry32(this.seed^0x0a7e5)),O=this.orn||(this.orn={strip:null,lastStrip:-999,lastLow:null,lastPhase:null,swapBar:-99,plan:new Set(["hat","perc","clap","lead"]),B:null,lvl:0.6});
    if(this.low!==O.lastLow){O.swapBar=bar;O.lastLow=this.low;}if(this.decks.length>1)O.multi=bar;
    const cur=cd.set&&cd.set.list[cd.set.idx],ph=cd.chill?"chill":(cur?cur.phase:"build"),ch=this.low.band==="bchill",e=cd.p.energy;
    O.lvl=Math.max(0,Math.min(1,0.5*(ORN_PHASE[ph]??0.65)+0.5*Math.min(1,e/0.85)));
    if(O.strip&&(bar>=O.strip.end||cd.closing||this.drop.active&&["bridge","outro"].includes(this.drop.type))){O.strip=null;O.stripEnded=bar;}
    let edge=false;
    if(bar%16===0){
      if(!O.strip&&bar>=32&&bar>=O.lastStrip+40&&!cd.opening&&!cd.closing&&!this.closed&&!cd.chill&&!this.drop.active&&this.chillAmt<0.3&&!(this.jazz&&this.jazz.on)&&!this.jzPlan&&!(this.chip&&this.chip.on)&&this.decks.length===1&&!(cd.mix&&cd.mix.state!=="planned")){
        const afterPeak=O.lastPhase==="peak"&&ph!=="peak",newDeck=bar-O.swapBar<=24||bar-(O.multi??-99)<=16,toBuild=ph==="build"&&O.lastPhase&&O.lastPhase!=="build";
        const p=afterPeak?0.9:(toBuild?0.7:(newDeck?0.6:(O.lvl<0.8?0.22:0.08)));
        if(r()<p){let len=r()<0.6?8:16;const nx=cd.events.filter(x=>x.bar>bar&&x.bar<bar+len&&["mixStart","bandSwitch","break","drop"].includes(x.type)).map(x=>x.bar);
          if(nx.length)len=Math.max(4,Math.min(len,Math.min(...nx)-bar));
          if(len>=8||nx.length){O.strip={start:bar,end:bar+len,perc:r()<0.5?1:0,why:afterPeak?"ピーク後":(toBuild?"ビルド前":(newDeck?"新デッキ":"間"))};O.lastStrip=bar;edge=true;
            cd.logItem(`ストリップ ${len}小節（キック・ベース・ハット${O.strip.perc?"＋パーカッション1つ":""}だけ・${O.strip.why}）`,"おまかせ","done",bar);}}}
      if(O.stripEnded===bar)edge=true;
      O.lastPhase=ph;
      // change plan: 1-2 elements per boundary (none when the boundary itself is a strip in / out or a jazzy / chip start)
      const W={hat:1,perc:1.2,clap:0.6,lead:1.4},plan=new Set(),k=edge||this.jzPlan?0:(r()<0.55?1:2);
      for(let i=0;i<k;i++){let s=0;for(const x in W)if(!plan.has(x))s+=W[x];let y=r()*s;for(const x in W){if(plan.has(x))continue;y-=W[x];if(y<=0){plan.add(x);break;}}}
      O.plan=plan;}
    const L=O.lvl,S0=O.strip;
    O.B=S0?{perc:S0.perc,ghost:0,fill:0,flam:0,pre:0,dbl:false,open:false,mel:0,strip:true}
      :{perc:ch?(L<0.55?1:2):(L<0.5?1:(L<0.78?2:3)),ghost:Math.max(0.15,Math.min(1,0.15+(L-0.35)/0.55)),fill:0.3+0.9*L,flam:L>0.75?1:(L>0.55?0.55:0.2),pre:L>0.75?1:(L>0.55?0.55:0.2),dbl:L>0.68,open:true,mel:1,strip:false};},
  ornPlan(x){const O=this.orn;return !O||!O.plan||O.plan.has(x);},
  ornB(){return this.orn&&this.orn.B||{perc:3,ghost:1,fill:1,flam:1,pre:1,dbl:true,open:true,mel:1,strip:false};},
});

// chill band percussion: soft off-beat hats, dub rim / half-time backbeat, shakers, soft toms (organic), almost nothing for ambient
Engine.prototype.drumsChill=function(d,t,tsw,s,ev,v,M,dn,ca,cm){const P=d.pat,r=this.rand,p=this.cond.p,st=d.style,kill=cm==="beatless"&&ca>0.6,hv=1-0.5*ca,K=d.kit,ph=2*Math.PI*((this.bar+s/16)/K.hat.lp+K.hat.ph),tm=1+K.hat.ld*Math.sin(ph),fm=1+0.1*Math.sin(ph*0.5+1);
  if(M.h&&!kill){
    if(s%4===2&&r()<(st==="hard"?0.45:0.85)*(1-0.45*ca)){this.kitHatHit(K.hat,t,hv*0.2*P.hatAccent[s]*(0.8+0.3*r()),tm*1.2,fm*0.8,false,this.cur.hat);ev.hat=1;this.hatBar++;}
    else if(s%2===1&&st!=="hard"&&r()<(1-0.8*ca)*P.ghost*0.6*Math.min(1.4,0.3+1.5*p.density)*this.ornB().ghost){this.kitHatHit(K.hat,tsw,hv*0.07*(0.6+0.6*r()),tm*0.6,fm*0.9,false,this.cur.hat);ev.hat=Math.max(ev.hat,0.4);this.hatBar++;}}
  if(M.c&&!kill){
    if(st==="broken"&&s===8){this.clap(t,0.55*hv);this.snare(t,0.22*hv);ev.clap=1;}
    else if((st==="groove"||st==="minimal")&&s===12&&r()<0.85&&K.clap.tim==="rim"){this.clapK(t,0.32*hv,"rim");ev.clap=0.6;}
    else if((st==="groove"||st==="minimal")&&s===12&&r()<0.85){this.hat(t,0.16*hv,0.02,0.01,0.15,1800,this.cur.clap,"bandpass");ev.clap=0.6;}}   // dub rim
  if(!M.p||kill)return;
  if(st!=="hard")this.kitPerc(d,K,t,tsw,s,ev,dn*(st==="minimal"?0.5:0.75),ca,1);   // v21: kit percussion (chill: softer, 1-2 layers)
  if(st==="hard"&&s===0&&this.bar%4===2&&r()<0.5){this.noiseWash(t,2*16*this.s16,0.018,this.cur.perc);}
};


// ---------- Upper layer (上モノ) : per-style palettes ----------
const PHRYG=[0,1,3,5,7,8,10],DORIAN=[0,2,3,5,7,9,10];
const UPSTYLES=["minimal","hard","groove","tribal","broken"];
// per-style routing: dry / ping-pong delay send / reverb send, and an output trim (rough loudness match)
const UPMIX={minimal:{dry:1,dly:1,verb:0.12,lvl:1.4},hard:{dry:1,dly:0.35,verb:0.25,lvl:0.75},
  groove:{dry:1,dly:0.6,verb:0.15,lvl:1.0},tribal:{dry:0.85,dly:0.45,verb:0.7,lvl:0.65},broken:{dry:1,dly:0.8,verb:0.2,lvl:0.75}};
// chill band: more dub delay / reverb on the 上モノ
const UPMIX_BAND={bchill:{groove:{dly:1.4,verb:0.5},minimal:{dly:1.2,verb:0.4},hard:{dly:0.9,verb:1.0},tribal:{dly:0.7,verb:0.8},broken:{dly:1.0,verb:0.5}}};
// per-kick-style master trim in dB (balances overall loudness across styles)
const STYLE_TRIM_DB={minimal:0,hard:-4.5,groove:2.2,tribal:-0.3,broken:2.0};
// the 120-band industrial kick is milder (less saturation) than the 140 hard-techno kick -> smaller trim
const TRIM160_DB={minimal:-7.5,groove:-7.5,tribal:-7.5,broken:-5.2,hard:-5.2};   // v12: クロスブリード +0.8 dB (quieter kick, kLvl 0.8)
const TRIMCH_DB={minimal:1,groove:1,tribal:1,broken:4.5,hard:2.6};
const trimDb=(st,band=S.band)=>band==="bchill"?TRIMCH_DB[st]:band==="b160"?TRIM160_DB[st]:(band==="b120"&&st==="hard"?-2.5:STYLE_TRIM_DB[st]);
const VOWELS=[[800,1150,2900],[450,800,2830],[400,1600,2700],[300,2000,2900],[350,600,2700]];

Object.assign(Patterns.prototype,{
  initUpper(){const r=this.r;
    this.U={
      hard:{stab:new Set([3,11]),acidOn:false,acid:Array.from({length:16},()=>null),fm:0.18},
      groove:{organ:new Set([2,5,7,10,13]),prog:[0,0,5,0],vox:new Set([7,15]),voxP:0.6},
      tribal:{arp:[0,2,3,1,4,2],cycA:3,cycB:5,offB:2,pB:0.5,flute:0.6},
      broken:{arp:[0,2,4,7,5,4,2,1],mask:[1,0,1,1,0,1,1,0],resp:5,bleep:new Set([3,11,14])}};
    this.rollAcid();},
  rollAcid(){const r=this.r,A=this.U.hard.acid;
    for(let s=0;s<16;s++) A[s]=r()<0.55?{deg:r()<0.45?0:Math.floor(r()*PHRYG.length),oct:r()<0.25?1:0,acc:r()<0.3,slide:r()<0.22}:null;},
  mutateUpper(v){const r=this.r,U=this.U;
    const pick=(arr,k)=>{const s=new Set();for(let i=0;i<k;i++)s.add(arr[Math.floor(r()*arr.length)]);return s;};
    if(r()<v*0.6) U.hard.stab=pick([3,6,10,11,14],1+Math.floor(r()*2));
    if(r()<v*0.5) this.rollAcid(); else if(r()<v) {const s=Math.floor(r()*16);U.hard.acid[s]=U.hard.acid[s]?null:{deg:Math.floor(r()*PHRYG.length),oct:0,acc:r()<0.4,slide:r()<0.3};}
    U.hard.fm=Math.min(0.4,Math.max(0.05,U.hard.fm+(r()-0.5)*0.2*v));
    if(r()<v*0.4) U.groove.organ=pick([2,3,5,7,10,11,13,14],3+Math.floor(r()*3));
    if(r()<v*0.4) U.groove.prog=[[0,0,5,0],[0,5,0,7],[0,0,7,5],[0,3,5,0]][Math.floor(r()*4)];
    if(r()<v*0.5) U.groove.vox=pick([3,7,11,14,15],1+Math.floor(r()*2));
    const T=U.tribal;
    if(r()<v*0.6){const i=Math.floor(r()*T.arp.length);T.arp[i]=Math.floor(r()*6);}
    if(r()<v*0.3){T.cycA=r()<0.7?3:4;T.cycB=r()<0.6?5:7;T.offB=Math.floor(r()*T.cycB);}
    T.pB=Math.min(0.8,Math.max(0.2,T.pB+(r()-0.5)*0.3*v));
    const B=U.broken;
    if(r()<v*0.6){const i=Math.floor(r()*8);B.arp[i]=Math.floor(r()*8);}
    if(r()<v*0.5){const i=Math.floor(r()*8);B.mask[i]^=1;}
    if(r()<v*0.3) B.resp=[5,3,7,-2][Math.floor(r()*4)];
    if(r()<v*0.4) B.bleep=pick([3,6,11,13,14,15],2+Math.floor(r()*2));
    if(this.bar%8===0) U.hard.acidOn=r()<0.35+0.4*v;
  }
});

Object.assign(Engine.prototype,{
  initUpper(){const c=this.ctx;
    // shared space: generated stereo reverb (≈2.6 s), returns into the 上モノ bus
    this.upVerb=c.createConvolver();this.upVerb.normalize=true;
    {const sr=c.sampleRate,n=Math.floor(sr*2.6),b=c.createBuffer(2,n,sr),rr=mulberry32(this.seed^0x7a11);
      for(let ch=0;ch<2;ch++){const d=b.getChannelData(ch);let lp=0;for(let i=0;i<n;i++){lp+=0.35*((rr()*2-1)-lp);d[i]=lp*Math.exp(-i/(sr*0.55))*(i<sr*0.012?i/(sr*0.012):1);}}
      this.upVerb.buffer=b;}
    this.verbRet=c.createGain();this.verbRet.gain.value=0.9;this.upVerb.connect(this.verbRet).connect(this.bus.stab);
    this.upDist=c.createWaveShaper();this.upDist.curve=Engine.curve(2048,x=>Math.tanh(4*x)/Math.tanh(4));this.upDist.oversample="2x";
    this.organWave=c.createPeriodicWave(new Float32Array(9),new Float32Array([0,1,0.72,0.5,0.3,0.1,0.14,0,0.05]));   // v19: drawbar-like (8' 4' 2 2/3' 2'), soft top
    this.upG={};this.upEnv={};this.upHpEnv={};
    for(const st of UPSTYLES){const M=UPMIX[st];
      // per-style layer: gain (crossfade) -> highpass (DJ filter sweep) -> dry / delay / reverb
      const g=c.createGain();g.gain.value=0;const ctl=c.createConstantSource();ctl.connect(g.gain);ctl.start();
      // HPF automated directly (no audio-rate input) so coefficients are only recomputed while it moves
      const hp=c.createBiquadFilter();hp.type="highpass";hp.Q.value=0.9;
      this.upEnv[st]=new Env(ctl.offset,st===S.style?M.lvl:0);this.upHpEnv[st]=new Env(hp.frequency,20);this.upG[st]=g;g.connect(hp);
      const dry=c.createGain();dry.gain.value=M.dry;hp.connect(dry).connect(this.bus.stab);
      const ds=c.createGain();ds.gain.value=M.dly;hp.connect(ds).connect(this.send);
      const vs=c.createGain();vs.gain.value=M.verb;hp.connect(vs).connect(this.upVerb);
      this["upCtl_"+st]=ctl;(this.upSend=this.upSend||{})[st]={dry,ds,vs};}
    this.applyUpMix(S.band,0);
    this.padBus=c.createGain();this.padBus.gain.value=1;this.padEQ=c.createBiquadFilter();this.padEQ.type="peaking";this.padEQ.frequency.value=700;this.padEQ.Q.value=0.6;this.padEQ.gain.value=0;
    this.padBus.connect(this.padEQ).connect(this.bus.stab);this.padVoices=[];   // v22: the pad steps aside (dip where the e-piano sits) during jazzy
    this.initChip();this.initJazz();
    // kick room: the kick (post distortion) sends a little of its mids into the same space as the 上モノ (KICK_GLUE.room, 0 = off)
    this.kickRoomHP=c.createBiquadFilter();this.kickRoomHP.type="highpass";this.kickRoomHP.frequency.value=320;this.kickRoomHP.Q.value=0.7;
    this.kickRoom=c.createGain();this.kickRoom.gain.value=0;this.bus.kick.connect(this.kickRoomHP).connect(this.kickRoom).connect(this.upVerb);
    {const pv=c.createGain();pv.gain.value=0.7;this.padEQ.connect(pv).connect(this.upVerb);}
    this.upDistOut=c.createGain();this.upDistOut.gain.value=0.25;this.upDist.connect(this.upDistOut).connect(this.upG.hard);
    this.trimEnv=new Env(this.trim.gain,Math.pow(10,trimDb(S.style)/20));
  },
  applyUpMix(band,t){for(const st of UPSTYLES){const M={...UPMIX[st],...((UPMIX_BAND[band]||{})[st]||{})},S0=this.upSend[st];
      S0.dry.gain.setTargetAtTime(M.dry,t,0.5);S0.ds.gain.setTargetAtTime(M.dly,t,0.5);S0.vs.gain.setTargetAtTime(M.verb,t,0.5);}},
  upCut(){const l=this.lfo();return {l,k:Math.sqrt(this.cutHz()/490)*(0.55+0.9*l)};},
  // 上モノ dispatcher: section (off / sparse / main / intense) × patch variant (classic palette or motif voice)
  upperStep(st,t,s,deck){const A=deck.arr,r=this.rand;
    if(!A.init)return deck.band==="b160"||deck.band==="bchill"?0:this.upperClassic(st,t,s,deck);
    if(A.section==="off")return 0;
    const PL=patchList(deck),pv=A.chillPatch||PL[A.variant]||PL[0];
    if(pv.n==="classic"){if(A.section==="sparse")return this.playMotif(st,t,s,deck,CLASSIC_SPARSE);return this.upperClassic(st,t,s,deck);}   // v19
    if(A.section!=="sparse"&&r()>Math.min(1,0.55+1.2*this.cond.p.density))return 0;
    return this.playMotif(st,t,s,deck,pv);},
  upperClassic(st,t,s,deck){const P=deck.pat,U=P.U,r=this.rand,v=this.effVar(),root=57+offOf(deck.key!=null?deck.key:S.key),out=this.upG[st],s16=this.s16;
    const cs=deck.harm&&deck.harm.upFollow?this.chordOf(deck).semi:0,cr=root+(cs>6?cs-12:cs);
    if(s!==0 && r()>Math.min(1,0.45+1.2*this.cond.p.density)) return 0;  // density thins the 上モノ
    if(st==="minimal"){const set=this.bar%2===0?P.stab:P.stabAlt;
      if(set.has(s)&&r()>0.08*v){this.stab(t,out,cr,this.stabIvs(deck,cs));return 1;}return 0;}
    if(st==="hard"){const H=U.hard;let h=0;
      if(s===0&&this.bar%4===0){this.drone(t,Math.min(4,this.tonalEnd(deck))*16*s16,{midi:root-24,type:"sawtooth",det:9,cut:220,q:3,lvl:0.06,att:1.2,rel:1.2,lfo:0.07,depth:120},out);h=0.3;}
      if(H.stab.has(s)&&r()>0.1*v){this.hardStab(t,root,r()<0.3);h=1;}
      if(H.acidOn){const a=H.acid[s];if(a){this.acid(t,root-12+PHRYG[a.deg]+12*a.oct,a.acc,a.slide);h=Math.max(h,0.7);}}
      if(s%2===1&&r()<H.fm){this.fmHit(t,root+24+[0,1,7][Math.floor(r()*3)],out);h=Math.max(h,0.5);}
      if(s===14&&r()<0.25){this.hat(t,0.05,0.12,0.03,(r()-0.5),2500,out,"bandpass");}
      return h;}
    if(st==="groove"){const G=U.groove,sw=s%2===1?s16*Math.max(0.2,this.cond.p.swing*0.3):0;let h=0;
      const gs=deck.harm?this.chordOf(deck).semi:G.prog[this.bar%4],cr=root+(deck.harm?(gs>6?gs-12:gs):gs);   // v18: organ follows the deck's chord (was its own 4-bar loop)
      if(G.organ.has(s)){this.organVoiced(t+sw,deck,s%4===2?1:0.75);h=1;}
      if(G.vox.has(s)&&r()<G.voxP){this.vox(t+sw,root+12+MINOR_PENT[Math.floor(r()*5)]);h=Math.max(h,0.7);}
      return h;}
    if(st==="tribal"){const T=U.tribal,g=this.step;let h=0;
      const nt=i=>root+(i>=5?12+MINOR_PENT[i-5]:MINOR_PENT[i]);
      if(g%T.cycA===0){const i=Math.floor(g/T.cycA)%T.arp.length;this.marimba(t,nt(T.arp[i]),0.9,(i%2?0.4:-0.4));h=1;}
      if(((g-T.offB)%T.cycB+T.cycB)%T.cycB===0&&r()<T.pB){this.marimba(t,nt(T.arp[(g>>2)%T.arp.length])+12,0.55,0.1,true);h=Math.max(h,0.6);}
      if(s===0&&this.bar%2===0&&r()<T.flute){this.flute(t+(r()<0.5?0:8*s16),root+12+MINOR_PENT[[0,2,3,4][Math.floor(r()*4)]],(4+4*Math.floor(r()*2))*s16);h=Math.max(h,0.5);}
      if(s===0&&this.bar%4===0){this.drone(t,Math.min(4,this.padSpan(deck),this.tonalEnd(deck))*16*s16,{midi:cr-12,type:"triangle",det:6,cut:900,q:0.5,lvl:0.07,att:1.5,rel:1.5,lfo:0.05,depth:300},out);}
      return h;}
    if(st==="broken"){const B=U.broken,call=this.bar%2===0;let h=0;
      const scale=[0,3,5,7,10,12,15,17];
      if((call?s<8:s>=8)&&s%2===0&&B.mask[(s>>1)%8]){const n=root+scale[B.arp[(s>>1)%8]]+(call?0:B.resp);this.pulse(t,n);h=1;}
      if(B.bleep.has(s)&&r()<0.8){this.bleep(t,root+24+[0,7,12][Math.floor(r()*3)]);h=Math.max(h,0.6);}
      if(s===0&&this.bar%4===0){this.drone(t,Math.min(4,this.padSpan(deck),this.tonalEnd(deck))*16*s16,{midi:cr-12,type:"sawtooth",det:18,cut:420,q:2,lvl:0.07,att:0.8,rel:1.0,lfo:0.12,depth:150},out);}
      return h;}
    return 0;},

  // ----- voices -----
  drone(t,dur,o,dest){const c=this.ctx,f=mtof(o.midi),lp=c.createBiquadFilter(),g=c.createGain(),lfo=c.createOscillator(),ld=c.createGain();
    lp.type="lowpass";lp.frequency.value=o.cut;lp.Q.value=o.q;lfo.frequency.value=o.lfo;ld.gain.value=o.depth;lfo.connect(ld).connect(lp.frequency);
    const end=t+dur+o.rel*0.5;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(o.lvl,t+o.att);g.gain.setValueAtTime(o.lvl,t+dur-0.05);g.gain.linearRampToValueAtTime(0,end);
    lp.connect(g).connect(dest);const os=[lfo];
    for(const d of [-o.det,o.det]){const x=c.createOscillator();x.type=o.type;x.frequency.value=f;x.detune.value=d;x.connect(lp);os.push(x);}
    for(const x of os){x.start(t);x.stop(end+0.05);}
    this.free(os[1],lp,g,ld);this.free(os[2]);this.free(lfo);
    if(dest===this.padBus){this.padVoices=this.padVoices.filter(v=>v.end>t);this.padVoices.push({g,end,lvl:o.lvl});}return g;},
  hardStab(t,root,b2){const c=this.ctx,{k}=this.upCut(),lp=c.createBiquadFilter(),g=c.createGain();
    lp.type="lowpass";lp.Q.value=4;const base=Math.min(6000,700*k);
    lp.frequency.setValueAtTime(base*3,t);lp.frequency.setTargetAtTime(base,t,0.04);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.16,t+0.003);g.gain.setTargetAtTime(0,t+0.005,0.07);
    lp.connect(g).connect(this.upDist);const os=[];
    for(const iv of b2?[0,1,7]:[0,7,12]) for(const d of [-14,14]){const o=c.createOscillator();o.type="sawtooth";o.frequency.value=mtof(root-12+iv);o.detune.value=d;o.connect(lp);o.start(t);o.stop(t+0.6);os.push(o);this.free(o);}
    os[0].addEventListener("ended",()=>{lp.disconnect();g.disconnect();});},
  acid(t,midi,acc,slide,dest=this.upDist){const c=this.ctx,{k}=this.upCut(),o=c.createOscillator(),lp=c.createBiquadFilter(),g=c.createGain(),len=this.s16*0.92;
    o.type="sawtooth";const f=mtof(midi);
    if(slide&&this.lastAcid){o.frequency.setValueAtTime(this.lastAcid,t);o.frequency.setTargetAtTime(f,t,0.025);}else o.frequency.setValueAtTime(f,t);
    this.lastAcid=f;
    lp.type="lowpass";lp.Q.value=acc?20:14;const base=Math.min(3000,260*k);
    lp.frequency.setValueAtTime(Math.min(9000,base*(acc?9:5)),t);lp.frequency.setTargetAtTime(base,t,acc?0.07:0.045);
    const pk=acc?0.11:0.075;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(pk,t+0.003);g.gain.setValueAtTime(pk,t+len-0.012);g.gain.linearRampToValueAtTime(0,t+len);
    o.connect(lp).connect(g).connect(dest);o.start(t);o.stop(t+len+0.02);this.free(o,lp,g);},
  fmHit(t,midi,dest){const c=this.ctx,f=mtof(midi),car=c.createOscillator(),mod=c.createOscillator(),mi=c.createGain(),g=c.createGain(),hp=c.createBiquadFilter();
    mod.frequency.value=f*3.73;mi.gain.setValueAtTime(f*6,t);mi.gain.setTargetAtTime(0,t,0.03);car.frequency.value=f;
    mod.connect(mi).connect(car.frequency);hp.type="highpass";hp.frequency.value=900;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.06,t+0.002);g.gain.setTargetAtTime(0,t+0.003,0.045);
    car.connect(hp).connect(g).connect(dest);car.start(t);mod.start(t);car.stop(t+0.45);mod.stop(t+0.45);this.free(car,hp,g,mi);this.free(mod);},
  // v19: M1 / 90s house-techno organ: two detuned drawbar oscillators per note (chorus), key click, percussive decay, band-limited lowpass,
  // articulation per section: stab (short), leslie (medium + rotary tremolo / vibrato), swell (soft attack, slow tremolo)
  organ(t,root,vel,ivs=[0,3,7,10],art="stab"){const c=this.ctx,{k}=this.upCut(),r=this.rand,A=ORGAN_ART[art]||ORGAN_ART.stab,out=this.upG.groove;
    const lp=c.createBiquadFilter(),g=c.createGain();lp.type="lowpass";lp.Q.value=0.5;
    lp.frequency.setValueAtTime(Math.min(7000,A.cut*k*1.7),t);lp.frequency.setTargetAtTime(Math.min(5200,A.cut*k),t+A.a,0.06);
    const pk=0.052*(A.lvl||1)*vel*Math.sqrt(3/ivs.length),end=t+A.len,stopT=end+A.rel*5+0.05;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(pk,t+A.a);g.gain.setTargetAtTime(pk*A.sus,t+A.a,A.dec);g.gain.setTargetAtTime(0,end,A.rel);
    let tg=null,vib=null;
    if(A.trem){tg=c.createGain();tg.gain.value=1-A.td;const l=c.createOscillator(),ld=c.createGain();l.frequency.value=A.trem*(0.94+0.12*r());ld.gain.value=A.td;l.connect(ld).connect(tg.gain);
      vib=c.createGain();vib.gain.value=A.vib||0;l.connect(vib);l.start(t);l.stop(stopT);this.free(l,ld,vib);}
    lp.connect(g);if(tg)g.connect(tg).connect(out);else g.connect(out);
    const os=[];
    for(const iv of ivs){const f=mtof(root+iv);for(const det of [-6,6]){const o=c.createOscillator(),og=c.createGain();o.setPeriodicWave(this.organWave);o.frequency.value=f;o.detune.value=det+(r()-0.5)*3;
      og.gain.value=0.5;if(vib)vib.connect(o.detune);o.connect(og).connect(lp);o.start(t);o.stop(stopT);os.push(o);this.free(o,og);}}
    if(A.click){const n=c.createBufferSource(),bp=c.createBiquadFilter(),cg=c.createGain();n.buffer=this.noise;bp.type="bandpass";bp.frequency.value=2600;bp.Q.value=0.8;
      cg.gain.setValueAtTime(pk*A.click,t);cg.gain.setTargetAtTime(0,t+0.0015,0.0035);n.connect(bp).connect(cg).connect(out);n.start(t,r());n.stop(t+0.04);this.free(n,bp,cg);}
    os[0].addEventListener("ended",()=>{lp.disconnect();g.disconnect();if(tg)tg.disconnect();});},
  // chord voicing with voice leading: chord tones (triad + m7) placed round a slowly drifting centre (inversions), sometimes thinned to 3 notes
  organVoiced(t,deck,vel){const A=deck.arr,r=this.rand,root=57+offOf(deck.key!=null?deck.key:S.key),{semi}=this.chordOf(deck);
    if(A.orgSemi!==semi){A.orgC=Math.max(1,Math.min(9,(A.orgC??(3+Math.floor(r()*4)))+[-2,-1,0,1,2][Math.floor(r()*5)]));A.orgSemi=semi;A.orgThin=r()<0.3;}
    let v=[...new Set(this.voiceNear(this.stabIvs(deck,semi).map(x=>x+semi),A.orgC))];if(A.orgThin&&v.length>3)v.splice(1+Math.floor(r()*(v.length-2)),1);
    this.organ(t,root,vel,v,A.orgArt||"stab");},
  vox(t,midi,dest=this.upG.groove,len=0.13){const c=this.ctx,o=c.createOscillator(),g=c.createGain(),f=mtof(midi),V=VOWELS[Math.floor(this.rand()*VOWELS.length)];
    o.type="sawtooth";o.frequency.setValueAtTime(f*1.03,t);o.frequency.setTargetAtTime(f,t,0.02);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.5,t+0.006);g.gain.setValueAtTime(0.45,t+len);g.gain.setTargetAtTime(0,t+len,0.02);
    g.connect(dest);const fs=[];
    V.forEach((F,i)=>{const bp=c.createBiquadFilter(),fg=c.createGain();bp.type="bandpass";bp.frequency.value=F;bp.Q.value=9;fg.gain.value=[1,0.55,0.3][i];o.connect(bp).connect(fg).connect(g);fs.push(bp,fg);});
    o.start(t);o.stop(t+len+0.2);this.free(o,g,...fs);},
  marimba(t,midi,vel,pan,kal){const c=this.ctx,f=mtof(midi),car=c.createOscillator(),mod=c.createOscillator(),mi=c.createGain(),g=c.createGain(),p=c.createStereoPanner();
    mod.frequency.value=f*(kal?5.04:4);mi.gain.setValueAtTime(f*(kal?1.6:2.4),t);mi.gain.setTargetAtTime(0,t,kal?0.06:0.035);
    car.frequency.value=f;mod.connect(mi).connect(car.frequency);p.pan.value=pan;
    const tau=kal?0.35:0.22;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.13*vel,t+0.002);g.gain.setTargetAtTime(0,t+0.003,tau);
    car.connect(g).connect(p).connect(this.upG.tribal);car.start(t);mod.start(t);car.stop(t+tau*9);mod.stop(t+tau*9);this.free(car,g,p,mi);this.free(mod);},
  flute(t,midi,dur){const c=this.ctx,f=mtof(midi),n=c.createBufferSource(),bp=c.createBiquadFilter(),ng=c.createGain(),o=c.createOscillator(),og=c.createGain(),g=c.createGain(),vib=c.createOscillator(),vd=c.createGain();
    n.buffer=this.noise;n.loop=true;bp.type="bandpass";bp.frequency.value=f;bp.Q.value=28;ng.gain.value=3.2;
    o.type="sine";o.frequency.value=f;og.gain.value=0.35;vib.frequency.value=5.2;vd.gain.value=5;vib.connect(vd).connect(o.detune);
    const end=t+dur+0.35;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.07,t+0.18);g.gain.setValueAtTime(0.06,t+dur);g.gain.linearRampToValueAtTime(0,end);
    n.connect(bp).connect(ng).connect(g);o.connect(og).connect(g);g.connect(this.upG.tribal);
    for(const x of [n,o,vib]){x.start(t,x===n?this.rand():undefined);x.stop(end+0.05);}
    this.free(n,bp,ng,g);this.free(o,og);this.free(vib,vd);},
  pulse(t,midi){const c=this.ctx,{k}=this.upCut(),o=c.createOscillator(),lp=c.createBiquadFilter(),g=c.createGain(),len=this.s16*0.6;
    o.type="square";o.frequency.value=mtof(midi);lp.type="lowpass";lp.Q.value=6;
    const base=Math.min(7000,900*k);lp.frequency.setValueAtTime(base*3,t);lp.frequency.setTargetAtTime(base,t,0.03);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.075,t+0.002);g.gain.setValueAtTime(0.06,t+len);g.gain.linearRampToValueAtTime(0,t+len+0.015);
    o.connect(lp).connect(g).connect(this.upG.broken);o.start(t);o.stop(t+len+0.04);this.free(o,lp,g);},
  bleep(t,midi){const c=this.ctx,f=mtof(midi),o=c.createOscillator(),g=c.createGain();o.type="sine";
    o.frequency.setValueAtTime(f*1.5,t);o.frequency.setTargetAtTime(f,t,0.008);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.08,t+0.002);g.gain.setTargetAtTime(0,t+0.003,0.045);
    o.connect(g).connect(this.upG.broken);o.start(t);o.stop(t+0.45);this.free(o,g);}
});


// ---------- v16: broken-beat flavour (techno bands): 8 or 16 bars of the broken kick on the current four-on-the-floor deck, rare + well spaced ----------
Object.assign(Engine.prototype,{
  flavourBar(t){const C=this.cond,D=this.drop,bar=this.bar,L=this.low;
    if(this.flav&&(bar>=this.flav.until||C.closing||C.mix)){const end=this.flav;this.flav=null;if(bar<end.until)this.flavCool=bar+128;C.logItem("ブレイクビート風のキック：4つ打ちに戻る","おまかせ","done",bar,t);}
    if(this.flav||!C.auto||bar%16!==0||bar<64||L.band==="bchill"||L.style==="broken"||bar<(this.flavCool||0))return;
    if(D.active||C.mix||C.chill||C.pendingBand||C.closing||C.opening||C.events.some(x=>x.bar>=bar&&x.bar<bar+16&&(["mixStart","swap","bandSwitch","chillIn","chillCore"].includes(x.type)||(x.type==="break"&&["breakdown","bridge","halftime"].includes(x.btype)))))return;
    if(this.rand()>0.14)return;
    const len=this.rand()<0.6?8:16;this.flav={from:bar,until:bar+len};this.flavCool=bar+len+128;    // >= 8 phrases between two flavours
    C.logItem(`ブレイクビート風のキック ${len}小節（フレーバー）`,"おまかせ","done",bar,t);}
});

// ---------- v15: chiptune colour layer (occasional spice: pulse/duty leads, NES-style arps, noise ticks, light bit-crush) ----------
/* v20: jazzy flavour (Detroit / deep-techno colour). One occasional segment like the chip spice: Rhodes-style e-piano with
   m9/m11 / 6-9 rootless voicings (voice-led, following the audible chord of the low deck), a lightly swung ride or shaker,
   brush ghosts, and sometimes a walking-ish bass. Replaces the lead (melodic layer budget); kick stays straight 4/4. */
const JAZZ_P={b120:.85,bchill:.8,b140:.22};          // chance per free 16-bar phrase line (after the cooldown)
const JAZZ_COMP=[[0,10],[0,6],[3,10],[0,7,14],[6,14],[2,10],[0,11]];
Object.assign(Engine.prototype,{
  initJazz(){const c=this.ctx;
    this.jazz={on:false,cool:0,start:-1,end:-1,vc:7,mixSeen:-99};this.jzA=0;this.jazzSegs=[];this.jazzLog=[];
    this.jzIn=c.createGain();this.jzIn.gain.value=1;
    this.jzLp=c.createBiquadFilter();this.jzLp.type="lowpass";this.jzLp.frequency.value=900;this.jzLp.Q.value=0.4;
    this.jzHp=c.createBiquadFilter();this.jzHp.type="highpass";this.jzHp.frequency.value=180;this.jzHp.Q.value=0.6;   // v22: no low-mid mud under the pad / bass
    const pan=c.createStereoPanner(),lfo=c.createOscillator(),lg=c.createGain();lfo.frequency.value=4.2;lg.gain.value=0.3;lfo.connect(lg).connect(pan.pan);lfo.start();  // EP auto-pan tremolo
    this.jzFade=c.createGain();this.jzFade.gain.value=0;
    this.jzIn.connect(this.jzHp).connect(this.jzLp).connect(pan).connect(this.jzFade);
    const dry=c.createGain();dry.gain.value=0.85;this.jzFade.connect(dry).connect(this.bus.stab);
    const vs=c.createGain();vs.gain.value=0.17;this.jzFade.connect(vs).connect(this.upVerb);
    const ds=c.createGain();ds.gain.value=0.05;this.jzFade.connect(ds).connect(this.send);   // v22: modest sends (no smear)
    this.jzDrum=c.createGain();this.jzDrum.gain.value=0;this.jzDrum.connect(this.bus.hat);},
  jazzBar(t){const J=this.jazz,C=this.chip,D=this.drop,bar=this.bar,bd=16*this.s16,cd=this.cond;
    const stop=!!(cd.closing||cd.opening||this.closed||(D.active&&["bridge","intro","outro"].includes(D.type)));
    const busy=this.jazzBusy();if(this.decks.length>1||(cd.mix&&cd.mix.state!=="planned"))J.mixSeen=bar;
    const evNear=(b0,b1)=>cd.events.filter(x=>x.bar>=b0&&x.bar<=b1&&x.type!=="peakHit").map(x=>x.bar);   // v22: mixes, swaps, key changes, breaks, kick drops, chill, band moves
    if(J.on){if(stop||bar>=J.end||(D.active&&bar>J.start)){this.jazzOff(t,stop||D.active?0.25:bd*0.3);return;}
      if((busy||evNear(bar+1,bar+3).length)&&J.end>bar+1){J.end=bar+1;this.jazzFadeOut(t,bd);J.fading=true;}   // v22: out >= 2 bars before anything planned
      else if(bar===J.end-1&&!J.fading){this.jazzFadeOut(t,bd);J.fading=true;}
      if((bar-J.start)%2===0)J.comp=JAZZ_COMP[Math.floor(this.rand()*JAZZ_COMP.length)];
      return;}
    const force=this.jazzForceBar!=null&&bar===this.jazzForceBar,P=this.jzPlan;
    if(!force&&!(P&&P.bar===bar))return;
    let len=force&&this.jazzForceLen?this.jazzForceLen:P.len;
    if(!force){if(busy||C.on)return;const nx=evNear(bar,bar+len+2);
      if(nx.length){len=Math.min(...nx)-2-bar;if(len<8)return;len=len>=16?16:8;}}      // the whole segment + 2 bars is clear
    this.jazzOn(t,len);},
  jazzBusy(){const cd=this.cond,D=this.drop;return !!((cd.mix&&cd.mix.state!=="planned")||this.decks.length>1||cd.pendingBand||D.active||this.chillAmt>0.05);},
  // v22: decided BEFORE the conductor's bar hook, so the phrase-end punctuation of a jazzy phrase is not planned at all
  jazzPre(){const J=this.jazz,C=this.chip,bar=this.bar,cd=this.cond;this.jzPlan=null;
    if(J.on||bar%16!==0||bar<32||(this.orn&&this.orn.strip&&this.orn.strip.end>bar+2)||cd.closing||cd.opening||this.closed||this.jazzBusy()||C.on||bar<(C.end>=0?C.end+16:0))return;
    if(bar<J.mixSeen+3||bar<J.cool||cd.p.energy>0.85||this.chillMode==="beatless")return;
    if(this.rand()>(JAZZ_P[this.low.band]||0))return;
    let len=this.rand()<0.5?8:16;const nx=cd.events.filter(x=>x.bar>=bar&&x.bar<=bar+len+2&&x.type!=="peakHit").map(x=>x.bar);
    if(nx.length){len=Math.min(...nx)-2-bar;if(len<8)return;len=len>=16?16:8;}
    this.jzPlan={bar,len};},
  jazzOn(t,len){const J=this.jazz,d=this.low,r=this.rand,bd=16*this.s16,ch=d.band==="bchill";
    Object.assign(J,{on:true,fading:false,start:this.bar,end:this.bar+len,chill:ch,m11:r()<0.4,ride:r()<(ch?0.5:0.7),brush:r()<0.55,walk:r()<(ch?0.45:0.35),
      comp:JAZZ_COMP[Math.floor(r()*JAZZ_COMP.length)],vc:6+Math.floor(r()*3),lvl:ch?0.8:0.9,last:null});
    const g=this.jzFade.gain,f=this.jzLp.frequency,dg=this.jzDrum.gain;
    g.cancelAndHoldAtTime(t);g.setTargetAtTime(J.lvl,t,bd*0.35);f.cancelAndHoldAtTime(t);f.setValueAtTime(900,t);f.exponentialRampToValueAtTime(ch?3000:3800,t+2*bd);
    dg.cancelAndHoldAtTime(t);dg.setTargetAtTime(1,t,bd*0.4);
    for(const v of this.padVoices)if(v.end>t+bd*0.5){v.g.gain.cancelAndHoldAtTime(t);v.g.gain.linearRampToValueAtTime(0,t+bd*0.75);v.end=t+bd*0.75;}   // v22: the triad pad fades, a root-fifth shell takes over
    if(this.padCutHook)this.padCutHook(t+bd*0.75);
    const pe=this.padEQ.gain,pb=this.padBus.gain;pe.cancelAndHoldAtTime(t);pe.setTargetAtTime(-8,t,bd*0.3);pb.cancelAndHoldAtTime(t);pb.setTargetAtTime(0.65,t,bd*0.3);
    this.jazzSegs.push([this.bar,this.bar+len,d.band,J.m11?"m11":"m9",J.ride?"ride":"shaker",J.walk?1:0]);
    this.cond.logItem(`ジャジー ${len}小節（エレピ ${J.m11?"m11":"m9"}・${J.ride?"ライド":"シェイカー"}${J.brush?"・ブラシ":""}${J.walk?"・ウォーキングベース":""}）`,"おまかせ","done",this.bar,t);},
  padRestore(t,tau){const pe=this.padEQ.gain,pb=this.padBus.gain;pe.cancelAndHoldAtTime(t);pe.setTargetAtTime(0,t,tau);pb.cancelAndHoldAtTime(t);pb.setTargetAtTime(1,t,tau);},
  jazzFadeOut(t,dur){this.padRestore(t,dur*0.4);const g=this.jzFade.gain,f=this.jzLp.frequency,dg=this.jzDrum.gain;
    g.cancelAndHoldAtTime(t);g.setTargetAtTime(0,t,dur*0.3);f.cancelAndHoldAtTime(t);f.exponentialRampToValueAtTime(900,t+dur);dg.cancelAndHoldAtTime(t);dg.setTargetAtTime(0,t,dur*0.35);},
  jazzOff(t,tau){const J=this.jazz;if(!J.on)return;J.on=false;this.padRestore(t,Math.max(tau,0.2));
    for(const g of [this.jzFade.gain,this.jzDrum.gain]){g.cancelAndHoldAtTime(t);g.setTargetAtTime(0,t,tau);}
    const s=this.jazzSegs[this.jazzSegs.length-1];if(s)s[1]=this.bar;J.cool=J.start+96+Math.floor(this.rand()*3)*16;},   // >= 6 phrases between starts
  // diatonic jazz voicing of the low deck's chord: [{m (semitones from key root), ext}] -- rootless, b9 / avoid-11 never used
  jazzVoicing(bar){const L=this.low,J=this.jazz,sc=L.scale||MINOR_PENT,N=sc.length,semi=this.chordOf(L,bar).semi,ci=Math.max(0,sc.indexOf(semi));
    const T=i=>{const k=ci+2*i;return sc[k%N]+12*Math.floor(k/N);},t0=T(0),iv=i=>((T(i)-t0)%12+12)%12;
    const q3=iv(1),q5=iv(2),q7=iv(3),q9=iv(4),q11=iv(5);let v;
    if(q3===3&&q5===6){v=[{m:T(1)},{m:T(3)}];if(q11===5)v.push({m:T(5),ext:11});}       // half-diminished: no b5 (tritone over the bass root), no b9
    else if(q3===3){v=[{m:T(1)},{m:T(3)}];if(q9===2)v.push({m:T(4),ext:9});
      if(J.m11&&q11===5)v.push({m:T(5),ext:11});else v.push({m:T(2)});}                  // m9 / m11 rootless
    else if(q7===10){v=[{m:T(1)},{m:T(3)},{m:T(2)}];if(q9===2)v.push({m:T(4),ext:9});}   // dominant 9 (b7 in key)
    else{v=[{m:T(1)},{m:T(2)},{m:t0+9,ext:6}];if(q9===2)v.push({m:T(4),ext:9});}         // major: 6/9 (no maj7 against the bass root)
    v=v.filter(x=>sc.includes(((x.m%12)+12)%12));                                       // in key, always
    const c=12+J.vc;for(const x of v){while(x.m-c>6)x.m-=12;while(c-x.m>5)x.m+=12;}     // smooth voice leading around a slowly drifting centre
    v.sort((a,b)=>a.m-b.m);for(let i=1;i<v.length;i++)if(v[i].m-v[i-1].m<1)v[i].m+=12;
    return {v,semi,lab:q3===3&&q5===6?"m7b5":(q3===3?(v.some(x=>x.ext===11)?"m11":(v.some(x=>x.ext===9)?"m9":"m7")):(q7===10?"9":"6/9"))};},
  // v22: ONE swing for every non-kick 16th-grid part while jazzy (piecewise-linear beat warp: 8th 'and' +0.33, 16ths +0.165),
  // ramped in / out over a bar together with the segment fade
  jazzSwingStep(){const J=this.jazz,tgt=J.on&&!J.fading?1:0;this.jzA=tgt>this.jzA?Math.min(1,this.jzA+1/16):Math.max(0,this.jzA-1/16);},
  swOff(s){return this.jzA>0?this.jzA*this.s16*[0,0.165,0.33,0.165][s%4]:0;},
  jazzStep(t,s,M){const J=this.jazz,r=this.rand,s16=this.s16,bar=this.bar,L=this.low,root=57+keyOff();
    const sw=this.swOff(s);
    if(M.u){const comp=J.comp||[0,10],nb=this.chordOf(L,bar+1).semi!==this.chordOf(L).semi;
      let hit=comp.includes(s)&&!(nb&&s>=12),nextBar=false;   // v22: no anticipations -- e-piano, pad and bass change chord together on the bar
      if(hit&&nextBar){const cur=this.chordPcs(L),N=this.jazzVoicing(bar+1).v;if(N.some(x=>cur.some(y=>{const d=((x.m-y)%12+12)%12;return d===1||d===11||d===6;})))hit=false;}  // anticipate only if it sits over the current chord
      if(hit){const V=this.jazzVoicing(nextBar?bar+1:bar);if(r()<0.12)J.vc=Math.max(4,Math.min(10,J.vc+(r()<0.5?-1:1)));
        const nx=comp.find(x=>x>s),dur=s16*Math.min(nextBar?10:12,(nx!=null?nx-s:16-s+(comp[0]||0))+(r()<0.5?2:0));
        const notes=V.v.map(x=>({m:root+x.m,ext:x.ext||0}));
        this.jzEP(t+sw,notes,dur,0.75+0.25*r());J.last=V.lab;J.pcs=V.v.map(x=>((x.m%12)+12)%12);
        if(this.debug)this.jazzLog.push([t+sw,dur,notes.map(x=>x.m),notes.map(x=>x.ext),bar,s,V.lab]);}}
    if(M.h){if(J.ride){if(s%4===0)this.jzRide(t,s%8===0?0.42:0.34);else if(s%8===6)this.jzRide(t+sw,0.26);}
      else{if(s%2===1)this.hat(t+sw,0.11,0.03,0.012,0.25,6200,this.jzDrum,"bandpass");else this.hat(t+sw,0.07,0.03,0.01,-0.2,6800,this.jzDrum,"bandpass");}}
    if(M.c&&J.brush){if(s%4===3&&r()<0.2)this.hat(t+sw,0.07,0.06,0.03,(r()-0.5)*0.4,2400,this.jzDrum,"bandpass");
      if((s===4||s===12)&&r()<0.5)this.hat(t,0.06,0.15,0.07,0,3000,this.jzDrum,"bandpass");}},
  // walking-ish bass: quarter notes root - 3rd/5th - 5th/octave - diatonic approach to the next root (v14 register)
  jazzWalk(s){const L=this.low,sc=L.scale||MINOR_PENT,N=sc.length,beat=s>>2,r=this.rand;
    const sem=this.chordOf(L).semi,nx=this.chordOf(L,this.bar+1).semi,tn=this.chordTones(L,sem,3);let rel;
    const root=33+keyOff(),dim=((tn[2]-tn[0])%12+12)%12===6,ep=(this.jazz.pcs||[]).concat(this.chordPcs(L)),
      ok=x=>ep.every(y=>{const d=((x-y)%12+12)%12;return d!==1&&d!==11&&d!==6;});      // a passing bass note never rubs against the voicing / chord
    const fifth=dim?sem+12:tn[2];
    if(beat===0)rel=sem;else if(beat===1)rel=r()<0.4&&ok(tn[1])?tn[1]:fifth;else if(beat===2)rel=r()<0.6?fifth:sem+12;
    else if(s===12)rel=r()<0.5?sem:fifth;                                                // on the kick: root / fifth only (no rub against the tuned kick tail)
    else{const i=sc.indexOf(nx),c=i<0?[]:[sc[(i+1)%N]+(i+1>=N?12:0),sc[(i-1+N)%N]-(i===0?12:0)].filter(ok);rel=c.length?c[Math.floor(r()*c.length)]:fifth;}let m=root+(((rel%12)+12)%12);if(m>root+12)m-=12;if(m<28)m+=12;return {midi:m};},
  jzEP(t,notes,dur,vel){const c=this.ctx,n=notes.length,pk=0.36*vel/Math.sqrt(n),rel=0.35;
    notes.forEach((x,i)=>{const tt=t+i*0.006,f=mtof(x.m),car=c.createOscillator(),mod=c.createOscillator(),mg=c.createGain(),tine=c.createOscillator(),tg=c.createGain(),g=c.createGain();
      car.type="sine";mod.type="sine";tine.type="sine";car.frequency.value=f;mod.frequency.value=f;tine.frequency.value=f*7.02;
      mg.gain.setValueAtTime(f*1.6,tt);mg.gain.setTargetAtTime(f*0.25,tt,0.18);                            // bark on attack, mellow body
      tg.gain.setValueAtTime(0.12*pk,tt);tg.gain.setTargetAtTime(0,tt,0.03);                              // tine ping
      g.gain.setValueAtTime(0,tt);g.gain.linearRampToValueAtTime(pk,tt+0.004);g.gain.setTargetAtTime(pk*0.45,tt+0.004,0.35);
      g.gain.setTargetAtTime(0,tt+dur,rel*0.3);
      mod.connect(mg).connect(car.frequency);car.connect(g).connect(this.jzIn);tine.connect(tg).connect(this.jzIn);
      const end=tt+dur+rel*2;for(const o of [car,mod,tine]){o.start(tt);o.stop(end);}this.free(car,mod,mg,tine,tg,g);});},
  jzRide(t,vel){this.hat(t,vel*0.55,0.4,0.16,0.35,8200,this.jzDrum,"bandpass");this.hat(t,vel*0.35,0.04,0.012,0.35,11000,this.jzDrum,"highpass");},
});
const CHIP_P={b120:.5,bchill:.5,b140:.42};       // chance per free 16-bar phrase line (after a cooldown)
const CHIP_DUTY=[0.125,0.25,0.5],CHIP_DUTY_JA={0.125:"12.5%",0.25:"25%",0.5:"50%"};
Object.assign(Engine.prototype,{
  initChip(){const c=this.ctx,bd=()=>16*this.s16;
    this.chip={on:false,cool:0,start:-1,end:-1};this.chipSegs=[];this.chipLog=[];
    this.chipWaves={};for(const d of CHIP_DUTY){const N=40,re=new Float32Array(N),im=new Float32Array(N);for(let n=1;n<N;n++)re[n]=2/(n*Math.PI)*Math.sin(n*Math.PI*d);this.chipWaves[d]=c.createPeriodicWave(re,im);}
    this.chipIn=c.createGain();this.chipIn.gain.value=1;
    const cr=c.createWaveShaper();cr.curve=Engine.curve(4096,x=>Math.round(x*128)/128);   // light 8-bit-style amplitude quantiser, this layer only
    this.chipLp=c.createBiquadFilter();this.chipLp.type="lowpass";this.chipLp.frequency.value=1500;this.chipLp.Q.value=0.5;
    this.chipFade=c.createGain();this.chipFade.gain.value=0;
    this.chipIn.connect(cr).connect(this.chipLp).connect(this.chipFade);
    const dry=c.createGain();dry.gain.value=0.9;this.chipFade.connect(dry).connect(this.bus.stab);       // upper bus (kick pump / ducking)
    const vs=c.createGain();vs.gain.value=0.22;this.chipFade.connect(vs).connect(this.upVerb);            // shared reverb
    const ds=c.createGain();ds.gain.value=0.15;this.chipFade.connect(ds).connect(this.send);},           // shared dub delay
  // bar hook: start / develop / end the layer
  chipBar(t){const C=this.chip,D=this.drop,bar=this.bar,bd=16*this.s16,cd=this.cond;
    const blocked=!!(cd.closing||cd.opening||this.closed||cd.pendingBand||(D.active&&["bridge","intro","outro","breakdown"].includes(D.type)));
    const stop=!!(cd.closing||cd.opening||this.closed||(D.active&&["bridge","intro","outro"].includes(D.type)));   // a running segment only yields to bridge / opening / closing
    if(C.on&&!this.decks.includes(C.deck))C.deck=this.low;   /* v16: the deck it started on left the mix: carry on with the new one (same / neighbouring key) */
    if(C.on){if(stop||bar>=C.end)this.chipOff(t,stop?0.25:bd*0.3);
      else{if(bar===C.end-1)this.chipFadeOut(t,bd);if((bar-C.start)%4===0&&bar>C.start)this.developMotif(C.M,C.deck);
        if(!C.chill&&this.rand()<0.12)C.duty=CHIP_DUTY[Math.floor(this.rand()*3)];}
      return;}
    const force=this.chipForceBar!=null&&bar===this.chipForceBar;
    if(!force&&(bar%16!==0||bar<24||blocked||D.active||cd.mix||bar<C.cool||this.jazz.on||(this.orn&&this.orn.strip)||bar<this.jazz.end+16||(this.jzPlan&&this.jzPlan.bar===bar)||cd.p.energy>0.85))return;
    if(!force&&this.rand()>(CHIP_P[this.low.band]||0.2))return;
    let len=force&&this.chipForceLen?this.chipForceLen:(this.rand()<0.55?8:16);
    if(!force){const nx=cd.events.filter(x=>x.bar>bar&&x.bar<=bar+len&&(x.type==="mixStart"||x.type==="bandSwitch"||(x.type==="break"&&["bridge","breakdown"].includes(x.btype)))).map(x=>x.bar);
      if(nx.length){len=Math.min(...nx)-bar;if(len<8)return;len=len>=16?16:8;}}      // never cut short by a planned mix / bridge / breakdown
    this.chipOn(t,len);},
  chipOn(t,len){const C=this.chip,d=this.low,r=this.rand,bd=16*this.s16,ch=d.band==="bchill";
    Object.assign(C,{on:true,start:this.bar,end:this.bar+len,deck:d,chill:ch,mode:r()<0.5?"arp":"lead",duty:ch?0:CHIP_DUTY[Math.floor(r()*3)],lvl:ch?0.5:0.8,M:this.newMotif(d)});
    const g=this.chipFade.gain,f=this.chipLp.frequency;g.cancelAndHoldAtTime(t);g.setTargetAtTime(C.lvl,t,bd*0.3);
    f.cancelAndHoldAtTime(t);f.setValueAtTime(1500,t);f.exponentialRampToValueAtTime(ch?5000:7000,t+2*bd);
    this.chipSegs.push([this.bar,this.bar+len,d.band,C.mode]);
    this.cond.logItem(`チップチューン・スパイス ${len}小節（${C.mode==="arp"?"アルペジオ":"リード"}・${ch?"三角波":"パルス"+CHIP_DUTY_JA[C.duty]}）`,"おまかせ","done",this.bar,t);},
  chipFadeOut(t,dur){const g=this.chipFade.gain,f=this.chipLp.frequency;g.cancelAndHoldAtTime(t);g.setTargetAtTime(0,t,dur*0.3);f.cancelAndHoldAtTime(t);f.exponentialRampToValueAtTime(1500,t+dur);},
  chipOff(t,tau){const C=this.chip;if(!C.on)return;C.on=false;const g=this.chipFade.gain;g.cancelAndHoldAtTime(t);g.setTargetAtTime(0,t,tau);
    const s=this.chipSegs[this.chipSegs.length-1];if(s)s[1]=this.bar;C.cool=this.bar+32;},
  // step hook: motif lead (v13 machinery) / chord-tone arps / noise-channel ticks
  chipStep(t,s){const C=this.chip,d=this.low,M=C.M,r=this.rand,s16=this.s16;if(!M||!M.bars)return;
    const sc=d.scale,L=sc.length,root=57+offOf(d.key),{semi,ci}=this.chordOf(d),fi=(((this.bar-M.start)%8)+8)%8,letter=M.form[fi],N=letter==="-"?[]:M.bars[letter];
    const toMidi=(deg,oct)=>{const oc=Math.floor(deg/L);let m=root+12+sc[((deg%L)+L)%L]+12*(oc+oct);while(m>root+24)m-=12;while(m<root+2)m+=12;return m;};
    for(const n of N){if(n.s!==s||(C.mode==="arp"&&r()<0.55))continue;
      let midi=toMidi(n.deg+M.tr+ci,n.oct);const dur=s16*(C.chill?2.2:1.3)*(n.len||1)*(0.8+0.4*r());
      {const pcs=this.chordPcs(d);if((s%4===0&&dur>1.2*s16)||(dur>2.5*s16&&this.harsh(midi,root,pcs)))midi=this.snapChord(midi,root,pcs);}
      this.chipNote(t,midi,dur,n.vel*(0.85+0.3*r()),{slide:!C.chill&&r()<0.12?(r()<0.5?-2:2):0,vib:dur>s16*2&&r()<0.5});}
    const arpStep=C.chill?s%8===4:s%4===2;
    if((C.mode==="arp"||letter==="-")&&arpStep&&r()<(C.chill?0.6:0.75)){const sh=semi>6?-12:0,tones=this.chordTones(d,semi,3).map(x=>root+12+x+sh);
      if(r()<0.5)tones.push(tones[0]+12);this.chipArp(t,tones,(C.chill?4:2)*s16,C.chill?s16:s16/2);}
    if(!C.chill){if(s%4===2&&r()<0.6)this.chipNoise(t,0.5,false);if(s===12&&this.bar%2===1&&r()<0.5)this.chipNoise(t,0.7,true);}},
  chipOsc(t,f){const o=this.ctx.createOscillator();if(this.chip.chill)o.type="triangle";else o.setPeriodicWave(this.chipWaves[this.chip.duty]);o.frequency.setValueAtTime(f,t);return o;},
  chipEnv(g,t,pk,dur){g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(pk,t+0.003);g.gain.setTargetAtTime(pk*0.7,t+0.003,Math.max(0.02,dur*0.5));g.gain.setTargetAtTime(0,t+dur,0.008);},
  chipNote(t,midi,dur,vel,o={}){const c=this.ctx,f=mtof(midi),os=this.chipOsc(t,o.slide?f*Math.pow(2,o.slide/12):f),g=c.createGain();
    if(o.slide)os.frequency.exponentialRampToValueAtTime(f,t+0.04);
    if(o.vib){const l=c.createOscillator(),lg=c.createGain();l.frequency.value=6;lg.gain.setValueAtTime(0,t);lg.gain.linearRampToValueAtTime(22,t+dur*0.7);l.connect(lg).connect(os.detune);l.start(t);l.stop(t+dur+0.1);this.free(l,lg);}
    this.chipEnv(g,t,(this.chip.chill?0.055:0.045)*vel,dur);os.connect(g).connect(this.chipIn);os.start(t);os.stop(t+dur+0.08);this.free(os,g);
    if(this.debug)this.chipLog.push([this.bar,this.step%16,"lead",midi,this.chip.deck.key,this.chip.deck.mode]);},
  chipArp(t,midis,dur,rate){const c=this.ctx,os=this.chipOsc(t,mtof(midis[0])),g=c.createGain();
    for(let i=1,k=1;t+i*rate<t+dur-1e-4;i++,k++)os.frequency.setValueAtTime(mtof(midis[k%midis.length]),t+i*rate);
    this.chipEnv(g,t,this.chip.chill?0.04:0.032,dur);os.connect(g).connect(this.chipIn);os.start(t);os.stop(t+dur+0.08);this.free(os,g);
    if(this.debug)for(const m of midis)this.chipLog.push([this.bar,this.step%16,"arp",m,this.chip.deck.key,this.chip.deck.mode]);},
  chipNoise(t,vel,snare){const c=this.ctx,n=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain(),dec=snare?0.07:0.025;
    n.buffer=this.noise;f.type=snare?"bandpass":"highpass";f.frequency.value=snare?2600:6000;f.Q.value=snare?0.9:0.7;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.05*vel,t+0.002);g.gain.setTargetAtTime(0,t+0.003,dec);
    n.connect(f).connect(g).connect(this.chipIn);n.start(t,this.rand()*1.5);n.stop(t+dec*8+0.02);this.free(n,f,g);
    if(this.debug)this.chipLog.push([this.bar,this.step%16,"noise",0]);}
});

// ---------- 上モノ arranger: patch variants × motif development × phrase sections ----------
const UP_SCALE={minimal:[0,3,5,7,10],hard:[0,1,3,5,7,8,10],groove:[0,2,3,5,7,9,10],tribal:[0,3,5,7,10],broken:[0,3,5,7,10]};
const CELLS=[[3],[3,11],[0,3,6],[2,7,10],[0,3,6,10,13],[3,6,11,14],[0,6,12],[2,5,7,10,13,15],[1,4,9,12],[0,3,8,11,14],[7,15],[0,10],[2,6,10,14],[0,3,7,10]];
const PATCHES={
  minimal:[{n:"classic",ja:"ダブ・スタブ"},
    {n:"dubchord",ja:"ダブ・コード（m9）",osc:[["sawtooth",-8,.5],["sawtooth",8,.5]],chord:[0,3,7,10,14],f:{type:"lowpass",cut:900,q:2,env:3,dec:.12},a:{a:.003,d:.25,s:0,r:.08},lvl:.075,gate:.9},
    {n:"bleep",ja:"サイン・ブリープ",osc:[["sine",0,1]],chord:[0],oct:12,a:{a:.002,d:.09,s:0,r:.03},lvl:.15,gate:.5},
    {n:"glass",ja:"グラス・ベル（FM）",fm:{ratio:3.5,index:2.2,dec:.25},osc:[["sine",0,1]],chord:[0],oct:12,a:{a:.002,d:.6,s:0,r:.3},lvl:.1,gate:1},
    {n:"hypno",ja:"ヒプノ・シーケンス",osc:[["sawtooth",0,.6],["square",5,.4]],chord:[0],oct:0,f:{type:"lowpass",cut:500,q:9,env:5,dec:.09},a:{a:.002,d:.18,s:.2,r:.04},lvl:.075,gate:.6}],
  hard:[{n:"classic",ja:"ディストーション・スタブ＋アシッド"},
    {n:"acid",ja:"アシッド・ライン",special:"acid"},
    {n:"siren",ja:"サイレン・リード",osc:[["square",-12,.5],["square",12,.5]],chord:[0],oct:12,f:{type:"bandpass",cut:1800,q:3,env:1.5,dec:.2},a:{a:.01,d:.3,s:.5,r:.1},bend:{from:-7,time:.12},lvl:.09,gate:1.6,dist:true},
    {n:"hoover",ja:"フーバー",osc:[["sawtooth",-25,.4],["sawtooth",25,.4],["sawtooth",0,.3]],chord:[0,7,12],oct:-12,f:{type:"lowpass",cut:1400,q:2,env:2,dec:.25},a:{a:.02,d:.4,s:.4,r:.15},bend:{from:5,time:.15},lvl:.08,gate:2,dist:true},
    {n:"metal",ja:"メタル・パーカッション（FM）",fm:{ratio:5.33,index:6,dec:.06},osc:[["sine",0,1]],chord:[0],oct:24,f:{type:"highpass",cut:900,q:.7,env:1,dec:.05},a:{a:.001,d:.12,s:0,r:.05},lvl:.07,gate:.4}],
  groove:[{n:"classic",ja:"オルガン＋ボイス"},
    {n:"clav",ja:"クラビ",osc:[["square",0,.6],["sawtooth",3,.3]],chord:[0,7],oct:0,f:{type:"bandpass",cut:1500,q:2.5,env:2.5,dec:.04},a:{a:.001,d:.09,s:0,r:.02},lvl:.11,gate:.35},
    {n:"brass",ja:"ブラス・スタブ",osc:[["sawtooth",-6,.5],["sawtooth",6,.5]],chord:[0,3,7],oct:0,f:{type:"lowpass",cut:700,q:1.5,env:4,dec:.08},a:{a:.012,d:.15,s:.3,r:.06},lvl:.065,gate:.7},
    {n:"piano",ja:"ハウス・ピアノ",osc:[["triangle",0,.7],["sine",0,.4]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:3000,q:.7,env:1.5,dec:.2},a:{a:.002,d:.35,s:0,r:.1},lvl:.08,gate:.8},
    {n:"voxchop",ja:"ボイス・チョップ",special:"vox"}],
  tribal:[{n:"classic",ja:"マリンバ＋フルート"},
    {n:"kalimba",ja:"カリンバ",special:"kalimba"},
    {n:"logdrum",ja:"ログドラム",osc:[["sine",0,1]],chord:[0],oct:-12,bend:{from:7,time:.03},a:{a:.001,d:.22,s:0,r:.06},lvl:.2,gate:.6},
    {n:"chant",ja:"チャント",special:"chant"},
    {n:"flute",ja:"バンブー・フルート",special:"flute"}],
  broken:[{n:"classic",ja:"パルス・アルペジオ"},
    {n:"zap",ja:"エレクトロ・ザップ",osc:[["sine",0,1]],chord:[0],oct:12,bend:{from:24,time:.04},a:{a:.001,d:.1,s:0,r:.03},lvl:.13,gate:.4},
    {n:"chords",ja:"スクエア・コード",osc:[["square",-5,.5],["square",5,.5]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:1200,q:3,env:2.5,dec:.06},a:{a:.002,d:.12,s:0,r:.04},lvl:.06,gate:.5},
    {n:"acid",ja:"アシッド",special:"acid"},
    {n:"bleeps",ja:"ブリープ",special:"bleep"}]};
// chill band 上モノ: dub chords, Rhodes-like keys, bells, slow pad swells, organic mallets, lo-fi keys
const PATCHESCH={
  groove:[{n:"dubchord",ja:"ダブ・コード（m9）",osc:[["sawtooth",-8,.5],["sawtooth",8,.5]],chord:[0,3,7,10,14],f:{type:"lowpass",cut:800,q:2,env:3,dec:.12},a:{a:.003,d:.25,s:0,r:.08},lvl:.07,gate:.9},
    {n:"dubstab",ja:"ダブ・スタブ（こもり）",osc:[["sawtooth",-6,.5],["sawtooth",6,.5]],chord:[0,3,7,10],f:{type:"lowpass",cut:600,q:3,env:3,dec:.1},a:{a:.002,d:.2,s:0,r:.06},lvl:.07,gate:.6},
    {n:"chillkeys",ja:"チル・キー（ローズ風）",osc:[["triangle",0,.6],["sine",0,.5]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:1500,q:.7,env:1.4,dec:.3},a:{a:.006,d:.6,s:.15,r:.35},lvl:.07,gate:1.6},
    {n:"softbell",ja:"ソフト・ベル",fm:{ratio:2,index:1.2,dec:.4},osc:[["sine",0,1]],chord:[0,7],oct:12,a:{a:.004,d:.8,s:0,r:.4},lvl:.07,gate:1.2}],
  minimal:[{n:"deepkeys",ja:"ディープ・キー",osc:[["triangle",0,.7],["sine",0,.4]],chord:[0,3,7],oct:0,f:{type:"lowpass",cut:1200,q:.8,env:1.5,dec:.2},a:{a:.004,d:.4,s:0,r:.2},lvl:.075,gate:.9},
    {n:"bleep",ja:"サイン・ブリープ",osc:[["sine",0,1]],chord:[0],oct:12,a:{a:.002,d:.09,s:0,r:.03},lvl:.12,gate:.5},
    {n:"glass",ja:"グラス・ベル（FM）",fm:{ratio:3.5,index:2.2,dec:.25},osc:[["sine",0,1]],chord:[0],oct:12,a:{a:.002,d:.6,s:0,r:.3},lvl:.085,gate:1},
    {n:"dubchord",ja:"ダブ・コード（m9）",osc:[["sawtooth",-8,.5],["sawtooth",8,.5]],chord:[0,3,7,10,14],f:{type:"lowpass",cut:800,q:2,env:3,dec:.12},a:{a:.003,d:.25,s:0,r:.08},lvl:.065,gate:.9}],
  hard:[{n:"padswell",ja:"パッド・スウェル",osc:[["sawtooth",-10,.5],["sawtooth",10,.5]],chord:[0,7,10,14],oct:0,f:{type:"lowpass",cut:900,q:.8,env:1.2,dec:.8},a:{a:.35,d:1.5,s:.6,r:1.2},lvl:.04,gate:6},
    {n:"shimmer",ja:"シマー",osc:[["sine",0,1]],chord:[0,7],oct:24,a:{a:.05,d:1,s:0,r:.6},lvl:.045,gate:3},
    {n:"glass",ja:"グラス・ベル（FM）",fm:{ratio:3.5,index:2.2,dec:.25},osc:[["sine",0,1]],chord:[0],oct:12,a:{a:.002,d:.6,s:0,r:.3},lvl:.08,gate:1},
    {n:"softbell",ja:"ソフト・ベル",fm:{ratio:2,index:1.2,dec:.4},osc:[["sine",0,1]],chord:[0,7],oct:12,a:{a:.004,d:.8,s:0,r:.4},lvl:.065,gate:1.2}],
  tribal:[{n:"kalimba",ja:"カリンバ",special:"kalimba"},{n:"flute",ja:"バンブー・フルート",special:"flute"},
    {n:"logdrum",ja:"ログドラム",osc:[["sine",0,1]],chord:[0],oct:-12,bend:{from:7,time:.03},a:{a:.001,d:.22,s:0,r:.06},lvl:.16,gate:.6},
    {n:"marimbaS",ja:"ウッド・マレット",fm:{ratio:4,index:1.6,dec:.04},osc:[["sine",0,1]],chord:[0],oct:0,a:{a:.001,d:.25,s:0,r:.08},lvl:.1,gate:.5}],
  broken:[{n:"lofikeys",ja:"ローファイ・キー",osc:[["triangle",-9,.6],["sine",7,.5]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:1300,q:.7,env:1.2,dec:.3},a:{a:.008,d:.5,s:.2,r:.3},lvl:.065,gate:1.4},
    {n:"vibes",ja:"ヴィブラフォン（FM）",fm:{ratio:4,index:1,dec:.3},osc:[["sine",0,1]],chord:[0,7],oct:12,a:{a:.002,d:.7,s:0,r:.4},lvl:.07,gate:1},
    {n:"chillkeys",ja:"チル・キー（ローズ風）",osc:[["triangle",0,.6],["sine",0,.5]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:1500,q:.7,env:1.4,dec:.3},a:{a:.006,d:.6,s:.15,r:.35},lvl:.07,gate:1.6},
    {n:"dubstab",ja:"ダブ・スタブ（こもり）",osc:[["sawtooth",-6,.5],["sawtooth",6,.5]],chord:[0,3,7,10],f:{type:"lowpass",cut:600,q:3,env:3,dec:.1},a:{a:.002,d:.2,s:0,r:.06},lvl:.065,gate:.6}]};
const patchList=d=>(d.band==="bchill"?PATCHESCH:PATCHES)[d.style];
const ORGAN_ART={stab:{a:.002,dec:.05,sus:.22,len:.15,rel:.045,cut:3000,click:.8,lvl:.8},          // lvl: matched to the other groove 上モノ (≈ −37 dB RMS solo)
  leslie:{a:.004,dec:.1,sus:.45,len:.26,rel:.07,cut:2600,click:.45,trem:6.2,td:.22,vib:5,lvl:.6},
  swell:{a:.06,dec:.25,sus:.7,len:.42,rel:.14,cut:2100,click:0,trem:4.4,td:.16,vib:3,lvl:.38}};
const CLASSIC_SPARSE={n:"classic",special:"classic"};
const ORGAN_ART_JA={stab:"スタブ",leslie:"ロータリー",swell:"スウェル"};
const SECTION_JA={off:"お休み",sparse:"まばら",main:"メイン",intense:"強め"};
const CHILL_PATCHES=[
  {n:"chillkeys",ja:"チル・キー（ローズ風）",osc:[["triangle",0,.6],["sine",0,.5]],chord:[0,3,7,10],oct:0,f:{type:"lowpass",cut:1500,q:.7,env:1.4,dec:.3},a:{a:.006,d:.6,s:.15,r:.35},lvl:.075,gate:1.6},
  {n:"dubchord",ja:"ダブ・コード（チル）",osc:[["sawtooth",-8,.5],["sawtooth",8,.5]],chord:[0,3,7,10,14],f:{type:"lowpass",cut:700,q:2,env:2.5,dec:.14},a:{a:.004,d:.3,s:0,r:.12},lvl:.07,gate:.9},
  {n:"softbell",ja:"ソフト・ベル",fm:{ratio:2,index:1.2,dec:.4},osc:[["sine",0,1]],chord:[0,7],oct:12,a:{a:.004,d:.8,s:0,r:.4},lvl:.075,gate:1.2}];
const MOTIF_OPS=["移調","ずらし","音を足す","音を抜く","オクターブ","アクセント移動","ゲート／フィルター","音程を一歩","フォーム変化","展開小節"];
const MOTIF_N={minimal:[2,4],hard:[2,4],groove:[3,5],tribal:[3,5],broken:[2,4]};   // v18: one note less at the top (density had risen since v13)
// per-style onset weights for generated rhythm cells (16 steps)
const STEP_W={minimal:[.5,.2,.8,1,.4,.2,1,.6,.4,.2,1,1,.4,.2,.9,.6],hard:[1,.3,.8,.5,1,.3,.8,.5,1,.3,.8,.5,1,.3,.8,.6],
  groove:[.6,.3,.9,1,.4,.5,1,.4,.6,.3,1,.8,.4,1,.6,.5],tribal:[1,.2,.3,1,.2,.3,1,.2,1,.2,.3,1,.2,.3,1,.4],broken:[1,.3,.4,1,.2,.3,1,.2,.4,.3,1,.3,.2,1,.4,.5]};
// 8-bar forms: A = call, B = answer, C = development / cadence bar, - = rest (space)
const FORMS=[["ABABABAC",1],["ABACABAC",1],["AABAAABC",.8],["ABA-ABAC",.7],["ABCBABC-",.6],["A-B-A-C-",.35]];
const pickForm=(r,d)=>{const sp=d.band==="bchill"||d.style==="minimal"?2:1.5,W=FORMS.map(([f,w])=>f.includes("-")?w*sp:w);let x=r()*W.reduce((a,b)=>a+b,0);
  for(let i=0;i<FORMS.length;i++){x-=W[i];if(x<=0)return FORMS[i][0].split("");}return FORMS[0][0].split("");};
const OP_W=[.08,.1,.1,.1,.07,.07,.08,.2,.12,.08];
const pickOp=r=>{let x=r();for(let i=0;i<OP_W.length;i++){x-=OP_W[i];if(x<=0)return i;}return 7;};
const DIATONIC=new Set(["piano","chillkeys","lofikeys","deepkeys","brass","chords","padswell"]);

Object.assign(Engine.prototype,{
  startChill(to,bars,b0){this.chillGlide={from:this.chillAmt,to,b0,bars:Math.max(1,bars)};},
  // warm pad under a chill episode / the chill band: the low deck's current chord (stacked thirds of its mode, 1-3-5-7-9),
  // voiced close to the previous pad (nearest-tone voice leading) + the chord root an octave below
  chillPad(t,amt,bars=8){const L=this.low,root=57+keyOff(),bd=16*this.s16,r=this.rand,{semi}=this.chordOf(L);bars=Math.min(bars,this.tonalEnd(L));
    this.padC=Math.max(0,Math.min(7,(this.padC??3)+Math.round((r()-0.5)*4)));
    let ch=[...new Set(this.voiceNear(this.padSafe(L,this.stabIvs(L,semi).map(x=>x+semi),semi),this.padC))];
    if(this.jazz&&this.jazz.on){const tn=this.chordTones(L,semi,3),dim=((tn[2]-tn[0])%12+12)%12===6;ch=[...new Set(this.voiceNear(dim?[semi]:[semi,tn[2]],this.padC))];}   // v22: open root-fifth shell under the e-piano (it alone carries 3rd / 7th / extensions)   // v18: triad (+ m7), no 9th / maj7 / colour tonesch.push((semi>6?semi-12:semi)-12);
    const lv=0.016*amt*Math.sqrt(5/ch.length);
    for(const iv of ch)this.drone(t,bars*bd,{midi:root-12+iv,type:iv<0?"sawtooth":"triangle",det:8,cut:900+500*r(),q:0.7,lvl:lv,att:Math.min(3,2*bd),rel:2.5,lfo:0.05,depth:300},this.padBus);},
  // bars until the chord changes (or the next 8-bar line), so a pad never holds across a chord change
  padSpan(d,bar=this.bar){const c=this.chordOf(d,bar).semi;let k=1;while(k<8&&(bar+k)%8!==0&&this.chordOf(d,bar+k).semi===c)k++;return k;},
  chordTones(d,semi,n){const sc=d.scale||MINOR_PENT,L=sc.length,ci=Math.max(0,sc.indexOf(semi)),out=[];
    for(let i=0;i<n;i++){const k=ci+2*i;out.push(sc[k%L]+12*Math.floor(k/L));}return out;},
  voiceNear(tones,center){return tones.map(x=>{let m=x;while(m-center>6)m-=12;while(center-m>6)m+=12;return m;}).sort((a,b)=>a-b);},
  // ----- v13 harmony per deck: mode + chord progression (one chord per H.len bars), Camelot-compatible key for the incoming deck -----
  initHarm(d){const r=this.rand,ch=d.band==="bchill";
    d.mode=pickW(r,ch?MODE_W_CH:d.band==="b160"&&d.style!=="broken"&&d.style!=="tribal"?MODE_W160:MODE_W[d.style]);d.scale=MODES[d.mode];
    d.harm={prog:null,len:ch?4:(r()<0.3&&(d.style==="minimal"||d.style==="hard")?8:4),
      bassFollow:!(d.band==="b160"&&d.style==="broken")&&r()<(ch?0.85:d.style==="hard"?0.25:0.6),upFollow:r()<(d.style==="hard"?0.5:0.85)};
    d.harm.prog=this.pickProg(d);},
  pickProg(d){const W=PROG_W[d.band==="bchill"?"chill":d.style],sc=d.scale,ok=PROGS.map((p,i)=>p.every(x=>sc.includes(x))?W[i]:0);
    let x=this.rand()*ok.reduce((a,b)=>a+b,0);if(x<=0)return [0,0,0,0];
    for(let i=0;i<ok.length;i++){x-=ok[i];if(x<=0)return PROGS[i].slice();}return [0,0,0,0];},
  chordOf(d,bar=this.bar){const H=d&&d.harm;if(!H)return {semi:0,ci:0};const semi=H.prog[Math.floor(Math.max(0,bar)/H.len)%H.prog.length];
    return {semi,ci:Math.max(0,d.scale.indexOf(semi))};},
  // ----- v18: consonance helpers. Triad pitch classes (relative to the key root) of a deck's chord; nearest chord tone; chord intervals for stabs
  chordPcs(d,bar=this.bar){if(!d||!d.harm)return [0,3,7];const {semi}=this.chordOf(d,bar);return this.chordTones(d,semi,3).map(x=>((x%12)+12)%12);},
  harsh(midi,root,pcs){const pc=(((midi-root)%12)+12)%12;return !pcs.includes(pc)&&pcs.some(x=>{const d=(x-pc+12)%12;return d===1||d===11||d===6;});},   // a semitone / tritone off a chord tone
  snapChord(midi,root,pcs){if(!pcs||!pcs.length)return midi;for(let k=0;k<=6;k++)for(const m of [midi-k,midi+k])if(pcs.includes((((m-root)%12)+12)%12))return m;return midi;},
  stabIvs(d,semi){if(!d||!d.harm)return [0,3,7,10];const t=this.chordTones(d,semi,4).map(x=>x-semi);return (t[3]-t[0])%12===10?t:t.slice(0,3);},   // triad (+ minor 7th only; a major 7th is a semitone under the root)
  // mode colour tones (phrygian b2, dorian 6) stay out of sustained pad notes unless they are the chord root
  padSafe(d,tones,semi){const col=d&&d.mode==="phrygian"?1:d&&d.mode==="dorian"?9:-1;return tones.filter(x=>(((x%12)+12)%12)!==col||(((x-semi)%12)+12)%12===0);},
  // ----- v18: melodic layer budget in mixes: the outgoing deck's tonal parts (上モノ, pads, drones) play up to the swap, the incoming deck's from the swap on
  melOK(d){const M=this.cond.mix;if(!M||M.state==="planned"||!M.deckA||!M.deckB)return true;return d===M.deckA?M.state==="mixing":d===M.deckB?M.state==="swapped":true;},
  tonalEnd(d,bar=this.bar){const M=this.cond.mix;return M&&M.state==="mixing"&&d===M.deckA?Math.max(1,M.swap-bar):99;},   // bars a sustained note of deck d may still last
  // v14: most swaps keep the key; a change (~30%, band change ~40%) moves to a nearby key whose root stays in F..B:
  // Camelot neighbour (fifth) when in range, else ±2 / ±1 semitones, weighted toward the A-minor home
  nextKey(bandChange){const r=this.rand,k=pcOf(this.low.key);if(r()>(bandChange?0.4:0.3))return k;
    const W={};for(const [mv,w] of [[7,1],[5,1],[2,.8],[-2,.8],[1,.5],[-1,.5]]){const n=pcOf(k+mv);if(KEY_W[n]&&n!==k)W[n]=(W[n]||0)+w*KEY_W[n];}
    return Object.keys(W).length?+pickW(r,W):k;},
  // per phrase: patch variant (often kept so 16 bars stay related), section every 8 bars, motif development every 4 bars
  arrangeUpper(d){const A=d.arr,r=this.rand,P=patchList(d),en=this.cond.p.energy,bar=this.bar;
    if(!A.init){A.init=true;A.variant=d.id===0&&d.style!=="groove"?0:this.pickVariant(d,P,-1);A.orgArt="stab";A.motif=this.newMotif(d);A.section=d.id===0?"sparse":"main";A.lastSec=A.section;return;}
    if(bar%32===0&&d.harm&&r()<(d.band==="bchill"?0.6:0.35))d.harm.prog=this.pickProg(d);          // harmony evolves slowly (only on a 32-bar line, where every progression is on the i chord)
    if(bar%16===0){
      const orgNow=d.style==="groove"&&(P[A.variant]||{}).n==="classic";   // v19: the organ never stays past one 16-bar line
      const pl=this.ornPlan("lead");
      if(((pl&&r()<0.75)||orgNow)&&P.length>1){A.variant=this.pickVariant(d,P,A.variant);const x=r();if(x<0.3)A.motif=this.newMotif(d);else if(x<0.75)A.motif=this.deriveMotif(d,A.motif);}
      else if(pl&&r()<0.5)A.motif=this.deriveMotif(d,A.motif);
      if(pl)A.layer2=r()<0.4?["pad","noise","fx"][Math.floor(r()*3)]:null;
      if(A.layer2&&d.upOn&&this.melOK(d)&&!(this.jazz&&this.jazz.on)&&!this.ornB().strip)this.upperLayer2(d,A.layer2,this.lastT||0);}
    // chill: mellow keys / dub chords take over the 上モノ (only sparse / main sections)
    if(bar%8===0){const want=this.chillAmt>0.25&&!(this.chillGlide&&this.chillGlide.to<this.chillAmt);
      if(want&&!A.chillPatch)A.chillPatch=CHILL_PATCHES[Math.floor(r()*CHILL_PATCHES.length)];else if(!want)A.chillPatch=null;
      if(A.chillPatch){A.section=r()<0.6?"main":"sparse";A.lastSec=A.section;if(r()<0.5)A.motif=this.deriveMotif(d,A.motif);return;}}
    if(bar%16===0&&this.ornPlan("lead")){const w={off:A.lastSec==="off"?0:(.08+(en<.45?.08:0)),sparse:.28,main:.42,intense:.06+Math.max(0,en-.55)*.7};
      let x=r()*Object.values(w).reduce((a,b)=>a+b,0);for(const [k,v] of Object.entries(w)){x-=v;if(x<=0){A.section=k;break;}}A.lastSec=A.section;
      A.orgArt=pickW(r,A.section==="sparse"?{swell:.4,leslie:.4,stab:.2}:A.section==="intense"?{stab:.7,leslie:.3}:{stab:.55,leslie:.45});}
    else if(bar%8===0)this.developMotif(A.motif,d);},     // v23: the motif develops per 8 bars (was 4)
  // ----- v13 motifs: 2-bar question/answer + a development bar, arranged in an 8-bar form; rhythm cells generated per style -----
  pickVariant(d,P,cur){const w=P.map((p,i)=>i===cur?0:(d.style==="groove"&&p.n==="classic"?0.15:1));let x=this.rand()*w.reduce((a,b)=>a+b,0);   // v19: the organ patch is rarer
    for(let i=0;i<w.length;i++){x-=w[i];if(x<=0&&w[i])return i;}return w.findIndex(v=>v>0);},
  genCell(st,n){const r=this.rand;if(r()<0.2){const c=CELLS[Math.floor(r()*CELLS.length)];if(c.length>=Math.min(2,n))return c.slice();}
    const W=(STEP_W[st]||STEP_W.minimal).slice(),out=[];
    for(let k=0;k<n;k++){let x=r()*W.reduce((a,b)=>a+b,0);let i=0;for(;i<15;i++){x-=W[i];if(x<=0)break;}if(!W[i])break;out.push(i);W[i]=0;if(i>0)W[i-1]*=0.5;if(i<15)W[i+1]*=0.5;}
    return out.sort((a,b)=>a-b);},
  // Markov contour over scale degrees: mostly steps, some repeats, few leaps; a question ends off the tonic, an answer resolves
  walk(r,d,L){const x=r();const st=x<0.18?0:x<0.43?1:x<0.68?-1:x<0.78?2:x<0.88?-2:x<0.94?(L===5?2:3):(r()<0.5?-3:4);let n=d+st;if(n>L+3)n-=2*st;if(n<-2)n-=2*st;return n;},
  genLine(cell,L,end,from){const r=this.rand,CT=L===5?[0,1,3]:[0,2,4];let d=from!=null?from:(r()<0.55?0:CT[1+Math.floor(r()*2)]);
    return cell.map((s,i)=>{if(i>0)d=this.walk(r,d,L);
      if(i===cell.length-1&&cell.length>1){if(end==="q"&&d%L===0)d+=r()<0.5?1:-1;if(end==="a")d=r()<0.6?0:(r()<0.5?CT[2]:L);}
      return {s,deg:d,oct:0,vel:i===0||s%4===0?1:0.62+0.3*r(),acc:r()<0.22,len:r()<0.15?2:1};});},
  answerOf(Abar,L){const r=this.rand,N=Abar.map(n=>({...n})),half=N.filter(n=>n.s<8),tail=N.filter(n=>n.s>=8);
    if(tail.length){const re=this.genLine(tail.map(n=>n.s),L,"a",half.length?this.walk(r,half[half.length-1].deg,L):0);tail.forEach((n,i)=>{n.deg=re[i].deg;});}
    else if(N.length){N[N.length-1].deg=0;}
    if(r()<0.4&&N.length>1){const n=N[1+Math.floor(r()*(N.length-1))],ns=n.s+(r()<0.5?1:-1);if(ns>=0&&ns<16&&!N.some(m=>m.s===ns))n.s=ns;}
    return N.sort((a,b)=>a.s-b.s);},
  varyBar(Abar,L){const r=this.rand,x=r();let N=Abar.map(n=>({...n}));
    if(x<0.35){const sh=r()<0.6?1:2;N.forEach(n=>n.deg+=sh);}                                       // sequence: the call a step higher
    else if(x<0.6&&N.length>1)N=N.slice(0,1+Math.floor(r()*Math.min(2,N.length-1)));               // space: only the head of the call
    else{const used=new Set(N.map(n=>n.s)),fr=[9,11,13,14,15].filter(s=>!used.has(s));let d=N.length?N[N.length-1].deg:0;  // fill: run back to the tonic
      for(const s of fr.filter(()=>r()<0.5).slice(0,1)){d=d>0?d-1:d+1;N.push({s,deg:d,oct:0,vel:0.7,acc:false,len:1});}}
    return N.sort((a,b)=>a.s-b.s);},
  newMotif(d){const r=this.rand,st=d.style,L=(d.scale||UP_SCALE[st]).length,NR=d.band==="bchill"?[2,4]:(MOTIF_N[st]||[2,5]);
    const cell=this.genCell(st,NR[0]+Math.floor(r()*(NR[1]-NR[0]+1))),Ab=this.genLine(cell,L,"q");
    return {bars:{A:Ab,B:this.answerOf(Ab,L),C:this.varyBar(Ab,L)},form:pickForm(r,d),start:this.bar,gate:1,fenv:1,tr:0,id:++this.motifSeq,ops:[]};},
  // slow evolution: keep the rhythm and re-walk the pitches, or keep the contour on a new rhythm (never a cold reshuffle)
  deriveMotif(d,M){if(!M||!M.bars)return this.newMotif(d);const r=this.rand,L=(d.scale||UP_SCALE[d.style]).length,A0=M.bars.A;let Ab;
    if(r()<0.5){const re=this.genLine(A0.map(n=>n.s),L,"q",A0.length?A0[0].deg:0);Ab=A0.map((n,i)=>({...n,deg:re[i].deg}));}
    else{const cell=this.genCell(d.style,Math.max(2,A0.length+(r()<0.5?0:(r()<0.5?1:-1))));Ab=cell.map((s,i)=>({...(A0[Math.min(i,A0.length-1)]||{deg:0,oct:0,vel:1,acc:false,len:1}),s}));}
    return {bars:{A:Ab,B:this.answerOf(Ab,L),C:r()<0.5&&M.bars.C?M.bars.C.map(n=>({...n})):this.varyBar(Ab,L)},form:r()<0.5?M.form.slice():pickForm(r,d),
      start:this.bar,gate:M.gate,fenv:M.fenv,tr:M.tr,id:++this.motifSeq,ops:[],from:M.id};},
  developMotif(M,d){if(!M||!M.bars)return;const r=this.rand,L=d&&d.scale?d.scale.length:5,op=pickOp(r),keys=["A","B","C"],bk=keys[Math.floor(r()*3)],N=M.bars[bk];
    switch(op){
      case 0:M.tr=Math.max(-2,Math.min(3,M.tr+[1,-1,2,-1][Math.floor(r()*4)]));break;               // transposition (scale steps)
      case 1:if(N.length){const n=N[Math.floor(r()*N.length)],ns=n.s+(r()<0.5?1:-1);if(ns>=0&&ns<16&&!N.some(m=>m.s===ns))n.s=ns;N.sort((a,b)=>a.s-b.s);}break; // one note displaced
      case 2:if(N.length<5){const used=new Set(N.map(n=>n.s)),fr=[...Array(16).keys()].filter(s=>!used.has(s)),s=fr[Math.floor(r()*fr.length)],nb=N.filter(n=>n.s<s).pop();
        N.push({s,deg:nb?this.walk(r,nb.deg,L):0,oct:0,vel:0.7,acc:false,len:1});N.sort((a,b)=>a.s-b.s);}break;       // note add (neighbour of the previous note)
      case 3:if(N.length>2)N.splice(1+Math.floor(r()*(N.length-1)),1);break;                          // note drop
      case 4:if(N.length){const n=N[Math.floor(r()*N.length)];n.oct=n.oct?0:1;}break;               // octave jump
      case 5:if(N.length){for(const n of N)n.acc=false;N[Math.floor(r()*N.length)].acc=true;}break;  // accent move
      case 6:M.gate=Math.max(0.4,Math.min(2,M.gate*(r()<0.5?0.6:1.6)));M.fenv=Math.max(0.4,Math.min(2.5,M.fenv*(r()<0.5?0.6:1.6)));break;
      case 7:if(N.length){const i=Math.floor(r()*N.length);N[i].deg=this.walk(r,N[i].deg,L);}break;  // one pitch moves (Markov step)
      case 8:{const i=1+Math.floor(r()*7);M.form[i]=["A","B","C","-"][Math.floor(r()*(i%2?4:3))];break;}  // form: another bar answers / rests
      case 9:M.bars.C=this.varyBar(M.bars.A,L);break;}                                              // new development bar
    M.ops.push(op);},
  // ----- v19 sparse (まばら) sections: the motif's own rhythm, thinned by a seeded hash (so bars differ but stay related), call / response gaps
  // in 2-bar pairs, density breathing over 8 / 16 bars, off-beat anticipations and phrase-end pickups
  newSparse(ch){const r=this.rand,k=ch?0.65:1;return {seed:(r()*4294967296)>>>0,b0:this.bar,per:r()<0.5?8:16,lo:k*(0.3+0.15*r()),hi:k*(0.65+0.25*r()),ant:0.12+0.16*r(),call:r()<0.5};},   // chill: thinner
  sparseNotes(A,M,N){const bar=this.bar;if(!A.sp||bar-A.spLast>1)A.sp=this.newSparse(this.low.band==="bchill"||!!A.chillPatch);A.spLast=bar;const sp=A.sp;
    const h=(a,b)=>{let x=(sp.seed^Math.imul(M.id+1,0x9e3779b1)^Math.imul(bar+7,0x85ebca6b)^Math.imul(a*31+b+1,0xc2b2ae35))>>>0;x^=x>>>15;x=Math.imul(x,0x2c1b3c6d)>>>0;x^=x>>>12;x=Math.imul(x,0x297a2d39)>>>0;x^=x>>>15;return (x>>>0)/4294967296;};
    const rel=bar-sp.b0,ph=((rel%sp.per)+sp.per)%sp.per,dens=sp.lo+(sp.hi-sp.lo)*(0.5-0.5*Math.cos(2*Math.PI*ph/sp.per)),resp=((rel&1)===1)!==sp.call,out=[];
    N.forEach((n,i)=>{const front=n.s<8;
      if(resp?(front&&h(i,1)<0.7):(!front&&h(i,2)<0.5))return;           // call keeps the front of the bar, the answer the back
      if(out.length&&h(i,3)>dens)return;                                  // breathing density (the first kept note always plays)
      let es=n.s;if(es>0&&es%4===0&&h(i,4)<sp.ant)es-=1;                  // off-beat anticipation
      out.push({n,s:es,i});});
    if((bar%8===7||ph===sp.per-1)&&h(0,5)<0.65&&!out.some(o=>o.s>=12)){const last=(out.length?out[out.length-1].n:N[N.length-1])||{deg:0,oct:0};
      const s1=h(0,6)<0.5?14:15;out.push({n:{s:s1,deg:(last.deg||0)+(h(0,7)<0.5?1:-1),oct:last.oct||0,vel:0.7,acc:false,len:1},s:s1,i:N.length});}   // pickup into the next phrase
    return out;},
  // classic patches in a sparse section: the style's own voice on the motif's hits
  classicHit(st,t,midi,vel,deck,i){const out=this.upG[st],root=57+offOf(deck.key!=null?deck.key:S.key),{semi}=this.chordOf(deck),cr=root+(semi>6?semi-12:semi);
    if(st==="groove"){this.organVoiced(t,deck,0.8+0.25*Math.min(1,vel));if(i>0&&this.rand()<0.12)this.vox(t+this.s16,midi+12);return;}
    if(st==="minimal"){this.stab(t,out,cr,this.stabIvs(deck,semi));return;}
    if(st==="hard"){this.hardStab(t,cr,false);return;}
    if(st==="tribal"){this.marimba(t,midi+12,0.9*Math.min(1,vel),(i%2?0.35:-0.35));return;}
    this.pulse(t,midi);},
  upperLayer2(d,kind,t){const c=this.ctx,bd=16*this.s16,root=57+keyOff(),out=this.upG[d.style];
    if(kind==="pad"){const rt=57+offOf(d.key!=null?d.key:S.key);let b=0;      // v13: one segment per chord of the deck's progression (root, fifth below, third)
      const bEnd=Math.min(8,this.tonalEnd(d));
      while(b<bEnd){const bar=this.bar+b,{semi}=this.chordOf(d,bar),k=Math.min(bEnd-b,this.padSpan(d,bar)),[c0,c1,c2]=this.chordTones(d,semi,3),sh=semi>6?-12:0,ok=this.padSafe(d,[c0,c1,c2],semi);
        for(const [m,lvl] of [[rt+c0+sh-12,0.03],[rt+c2+sh-12,0.022],[rt+c1+sh,0.018]].filter(([m])=>ok.includes(m-rt-sh+12)||ok.includes(m-rt-sh)))
          this.drone(t+b*bd,k*bd,{midi:m,type:"triangle",det:9,cut:1100,q:0.7,lvl,att:Math.min(3,Math.max(0.3,k*bd*0.25)),rel:2,lfo:0.06,depth:350},out);b+=k;}}
    else if(kind==="noise")this.noiseWash(t,8*bd,0.03,out);
    else if(kind==="fx")this.revCym(t+15*bd+8*this.s16,t+16*bd,out,0.05);},
  noiseWash(t,dur,lvl,dest){const c=this.ctx,n=c.createBufferSource(),bp=c.createBiquadFilter(),g=c.createGain(),lfo=c.createOscillator(),ld=c.createGain();
    n.buffer=this.noise;n.loop=true;bp.type="bandpass";bp.frequency.value=1400;bp.Q.value=0.8;lfo.frequency.value=0.08;ld.gain.value=900;lfo.connect(ld).connect(bp.frequency);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(lvl,t+dur*0.4);g.gain.linearRampToValueAtTime(0,t+dur);
    n.connect(bp).connect(g).connect(dest);n.start(t,this.rand());lfo.start(t);n.stop(t+dur+0.05);lfo.stop(t+dur+0.05);this.free(n,bp,g);this.free(lfo,ld);},
  // generic patch voice
  synth(t,midi,vel,dur,P,dest){const c=this.ctx,{k}=this.upCut(),g=c.createGain(),nodes=[g];let filt=null;
    if(P.f){filt=c.createBiquadFilter();filt.type=P.f.type;filt.Q.value=P.f.q;const base=Math.min(12000,P.f.cut*k);
      filt.frequency.setValueAtTime(Math.min(16000,base*Math.max(1,P.f.env*(P.fenv||1))),t);filt.frequency.setTargetAtTime(base,t,P.f.dec);filt.connect(g);nodes.push(filt);}
    const A=P.a,pk=P.lvl*vel,end=t+Math.max(A.a+0.01,dur);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(pk,t+A.a);g.gain.setTargetAtTime(pk*A.s,t+A.a,A.d/3);g.gain.setTargetAtTime(0,end,A.r/3);
    if(P.sat){const ws=c.createWaveShaper(),sg=c.createGain();ws.curve=this.satCurve;sg.gain.value=0.55;g.connect(ws).connect(sg).connect(dest);nodes.push(ws,sg);}
    else g.connect(P.dist?this.upDist:dest);
    const stopT=end+A.r*3+0.05,os=[];
    for(const iv of P.chord)for(const [type,det,amt] of P.osc){const o=c.createOscillator(),og=c.createGain(),f=mtof(midi+iv+(P.oct||0));o.type=type;
      if(P.bend){o.frequency.setValueAtTime(f*Math.pow(2,P.bend.from/12),t);o.frequency.exponentialRampToValueAtTime(f,t+P.bend.time);}else o.frequency.value=f;
      o.detune.value=det;og.gain.value=amt/Math.sqrt(P.chord.length);
      if(P.fm){const m=c.createOscillator(),mi=c.createGain();m.frequency.value=f*P.fm.ratio;mi.gain.setValueAtTime(f*P.fm.index,t);mi.gain.setTargetAtTime(0,t,P.fm.dec);m.connect(mi).connect(o.frequency);m.start(t);m.stop(stopT);this.free(m,mi);}
      o.connect(og).connect(filt||g);o.start(t);o.stop(stopT);os.push(o);this.free(o,og);}
    os[0].addEventListener("ended",()=>{for(const n of nodes)n.disconnect();});},
  playMotif(st,t,s,deck,pv){const A=deck.arr,M=A.motif,r=this.rand,sc=deck.scale||UP_SCALE[st],root=57+offOf(deck.key!=null?deck.key:S.key),out=this.upG[st],s16=this.s16;
    if(!M||!M.bars)return 0;if(this.chip&&this.chip.on)return 0;
    let h=0;const L=sc.length,fi=(((this.bar-M.start)%8)+8)%8,letter=M.form[fi],N=letter==="-"?[]:M.bars[letter];
    const ci=deck.harm&&deck.harm.upFollow?this.chordOf(deck).ci:0;
    const toMidi=(deg,oct)=>{const oc=Math.floor(deg/L);let m=root+sc[((deg%L)+L)%L]+12*(oc+oct);while(m>root+26)m-=12;while(m<root-10)m+=12;return m;};
    const pcs=this.chordPcs(deck),isCh=DIATONIC.has(pv.n)&&pv.chord&&pv.chord.length>=3;
    const voiced=midi=>{if(!isCh)return pv;   // chord patches (v18): the chord tones of the current chord, voiced round the note
      return {...pv,chord:[...new Set(pv.chord.map(c=>this.snapChord(midi+c,root,pcs)-midi))]};};
    if(pv.special==="offstab"){if(s%4!==2||(A.section==="sparse"&&r()<0.5))return 0;     // hardcore off-beat stab, pitch follows the motif
      const NN=N.length?N:M.bars.A;if(!NN.length)return 0;const n=NN[(s>>2)%NN.length],midi=toMidi(n.deg+M.tr+ci,0);
      this.synth(t,midi,(s===14?1:0.85)*(0.9+0.2*r()),s16*(pv.gate||1)*1.6,{...pv,fenv:M.fenv*(0.85+0.3*r())},out);if(this.debug)this.upLog.push([this.bar,s,st,pv.n,midi,deck.id,M.id]);return 1;}
    const SN=A.section==="sparse"?this.sparseNotes(A,M,N):N.map((n,i)=>({n,s:n.s,i}));   // v19: seed-driven sparse rhythm (was: random 45 % drop)
    for(const sn of SN){const n=sn.n,i=sn.i;if(sn.s!==s)continue;
      let midi=toMidi(n.deg+M.tr+ci,n.oct);const vel=n.vel*(n.acc?1.25:1)*(0.88+0.24*r()),dur=s16*(pv.gate||1)*M.gate*1.6*(n.len||1)*(0.8+0.4*r()),fenv=M.fenv*(0.85+0.3*r());
      {const sp=pv.special,ed=sp==="chant"?2.5*s16:sp==="flute"?(i===0?6*s16:0.25):sp==="kalimba"?0.25:sp==="vox"?0.13:sp==="bleep"?0.1:sp==="acid"?0.92*s16:dur;
        if(isCh||(s%4===0&&ed>1.2*s16)||(ed>2.5*s16&&this.harsh(midi,root,pcs)))midi=this.snapChord(midi,root,pcs);}   // v18: chord tones on strong beats; long weak-step notes only lose harsh tones
      switch(pv.special){
        case "acid":this.acid(t,midi-12,n.acc,r()<0.25,st==="hard"?this.upDist:out);break;
        case "vox":this.vox(t,midi+12,this.upG.groove);break;
        case "chant":this.vox(t,midi,this.upG.tribal,s16*2.5);break;
        case "kalimba":this.marimba(t,midi+12,vel,(i%2?0.35:-0.35),true);break;
        case "flute":if(i===0)this.flute(t,midi+12,s16*6);else this.marimba(t,midi+12,0.5*vel,0.2,true);break;
        case "bleep":this.bleep(t,midi+24);break;
        case "classic":this.classicHit(st,t,midi,vel,deck,i);break;
        default:{const P=voiced(midi);this.synth(t,midi,vel,dur,{...P,fenv},out);
          if(A.section==="intense"&&n.acc&&r()<0.5)this.synth(t+s16/2,midi+12,0.5*vel,dur*0.6,{...P,fenv},out);}}
      if(this.debug)this.upLog.push([this.bar,s,st,pv.n,midi,deck.id,M.id]);h=Math.max(h,n.acc?1:0.75);}
    // ghost notes: a quiet neighbour tone right after a motif note (only melodic voices, never in sparse sections or rest bars)
    if(!h&&N.length&&A.section!=="sparse"&&(!pv.special||pv.special==="kalimba")&&s>0){const p=N.find(n=>n.s===s-1);
      if(p&&!N.some(n=>n.s===s)&&r()<0.05+0.1*this.cond.p.density){const midi=toMidi(p.deg+M.tr+ci+(r()<0.5?1:-1),p.oct);
        if(pv.special==="kalimba")this.marimba(t,midi+12,0.3,0,true);else this.synth(t,midi,0.32,s16*(pv.gate||1)*0.8,{...voiced(midi),fenv:M.fenv*0.7},out);
        if(this.debug)this.upLog.push([this.bar,s,st,pv.n,midi,deck.id,M.id]);h=0.3;}}
    return h;}
});

// ---------- Conductor: intents -> gradual, phrase-aligned musical changes ----------
const PROFILE={
  minimal:{energy:.40,dark:.45,density:.45,swing:.10,tension:.20,space:.55},
  hard:   {energy:.85,dark:.75,density:.70,swing:.05,tension:.35,space:.30},
  groove: {energy:.70,dark:.35,density:.70,swing:.55,tension:.30,space:.35},
  tribal: {energy:.60,dark:.45,density:.60,swing:.30,tension:.30,space:.70},
  broken: {energy:.60,dark:.50,density:.55,swing:.20,tension:.30,space:.50}};
// chill band: atmosphere per style (low energy / density, lots of space)
const PROFILE_BAND={bchill:{minimal:{energy:.28,dark:.5,density:.35,swing:.15,tension:.12,space:.8},groove:{energy:.34,dark:.45,density:.4,swing:.2,tension:.15,space:.9},
  tribal:{energy:.32,dark:.35,density:.45,swing:.3,tension:.12,space:.75},broken:{energy:.3,dark:.4,density:.38,swing:.25,tension:.15,space:.7},hard:{energy:.22,dark:.4,density:.25,swing:.1,tension:.1,space:1}}};
const prof=(st,band=S.band)=>((PROFILE_BAND[band]||{})[st])||PROFILE[st];
const PARAM_JA={energy:"エネルギー",dark:"暗さ",density:"密度",swing:"グルーヴ",tension:"緊張感",space:"空間"};
const clamp01=x=>Math.max(0,Math.min(1,x));
// free-text names for break types (checked in order; first match wins)
const BREAK_WORDS=[["tapestop",/テープ|ピッチダウン|ストップ/],["stutter",/スタッター|ビートリピート|リピート|連打/],["echo",/エコー|ダブアウト|残響だけ/],
  ["halftime",/ハーフタイム|ハーフ|半分のノリ/],["silence",/サイレンス|無音|静寂|一瞬止/],["hpbuild",/ハイパス/],["filter",/フィルター|こもら|こもっ|隣の部屋|ローパス/],
  ["breakdown",/ブレイクダウン|ブレークダウン|長めのブレイク|長いブレイク|大きいブレイク|大きなブレイク|ドラムを?抜/],["bassonly",/ベースだけ|ベースのみ/],
  ["perconly",/パーカッションだけ|パーカスだけ|打楽器だけ|リズムだけ/],["kick",/キック抜|キックを抜|キックだけ抜/]];
const LOG_MAX=20;
const SUGGEST=["もっとハードに","少し暗く","一気に盛り上げて","ブレイク入れて","テープストップ","短いブレイク","トライバルに","落ち着かせて","おまかせ"];

class Conductor{
  constructor(e){this.e=e;this.p={...prof(e.low.style,S.band)};this.closing=null;this.opening=null;this.glide={};this.events=[];this.mix=null;this.queue=[];
    this.auto=false;this.hold=false;this.band=S.band;this.pendingBand=null;this.tempoBias=0;this.tempoRate=0.5;this.tempoGoal=null;this.chill=null;this.lastChillEnd=-999;this.chillCount=0;
    this.r=mulberry32(e.seed^0xc0ffee);this.lastBreak=null;this.lastKick=null;
    this.log=[];this.logVer=0;this.curSrc=null;this.groups={};this.gseq=0;this.curGid=null;
    this.set=null;this.buildSet("warm",e.low.style);
    // opening: 16 bars of pads + muffled percussion (hats from bar 5, 上モノ from bar 9), kick + bass enter on the phrase downbeat
    if(e.opts&&e.opts.opening){this.opening={end:16};const P0=this.p.energy;this.p.energy=Math.max(0.12,P0-0.2);this.p.density=Math.max(0.15,this.p.density-0.2);
      this.addEvent({bar:0,type:"break",len:16,btype:"intro",src:"オープニング",label:"オープニング：パッドとこもったパーカッションから（ハット5小節目・上モノ9小節目・16小節後にキックイン）"});
      this.beginGroup("オープニングの雰囲気","オープニング");this.setParam("energy",P0,16,0);this.setParam("density",prof(e.low.style,S.band).density,16,0);this.endGroup();}}
  // ---- 消化した予定 log: newest first, fixed length ----
  logItem(text,src,status="done",bar=this.bar,t){const e=this.e,T=(t??(e.lastT!=null?e.lastT:e.nextTime))-(e.t0??0);
    this.log.unshift({bar,t:Math.max(0,T),text,src:src||"自動",status});if(this.log.length>LOG_MAX)this.log.length=LOG_MAX;this.logVer++;}
  note(msg){this.logItem(msg,this.curSrc);}
  beginGroup(label,src){this.curGid=++this.gseq;this.groups[this.curGid]={label,src:src||this.curSrc,pending:new Set(),sup:false};return this.curGid;}
  endGroup(){const g=this.groups[this.curGid];if(g&&!g.pending.size)delete this.groups[this.curGid];this.curGid=null;}
  checkGroup(gid,bar,t){const g=this.groups[gid];if(!g||g.pending.size)return;delete this.groups[gid];
    this.logItem(`${g.label||"雰囲気の変化"}：到達${g.sup?"（一部は後の指示で上書き）":""}`,g.src,"done",bar,t);}
  get bar(){return this.e.bar;}
  ja(st,band=this.band){return styleJa(st,band);}
  target(k){return this.glide[k]?this.glide[k].to:this.p[k];}
  finalStyle(){const q=this.queue.filter(x=>x.style);if(q.length)return q[q.length-1].style;if(this.mix)return this.mix.to;return this.e.low.style;}
  nextBoundary(bar,grid,gap){return Math.ceil((bar+gap)/grid)*grid;}
  setParam(k,val,bars,startBar){const old=this.glide[k];
    if(old&&old.gid&&old.gid!==this.curGid){const og=this.groups[old.gid];if(og){og.pending.delete(k);og.sup=true;this.checkGroup(old.gid,this.bar);}}
    this.glide[k]={from:null,to:clamp01(val),b0:startBar,bars:Math.max(1,bars),gid:this.curGid};
    const g=this.groups[this.curGid];if(g)g.pending.add(k);}
  addEvent(ev){if(ev.src===undefined)ev.src=this.curSrc||"自動";this.events.push(ev);this.events.sort((a,b)=>a.bar-b.bar);}

  // ---- tempo: band arc (おまかせ) or band centre, pulled 40% toward the style's preferred tempo, drifting <= tempoRate BPM / phrase ----
  tempoTarget(){const B=BANDS[this.band],cur=this.set&&this.set.list[this.set.idx];
    const base=this.auto&&cur?(B.arc[cur.phase]??B.arc.release):B.center,st=this.mix&&this.mix.state!=="planned"?this.mix.to:this.e.low.style;
    return Math.max(B.min,Math.min(B.max,0.6*base+0.4*STYLE_BAND[this.band][st].bpm+this.tempoBias));}
  // ---- setlist: warm-up -> build -> peak -> release, styles chosen from the band's pools ----
  buildSet(phase0="warm",first=null){const r=this.r,B=BANDS[this.band],list=[];let prev=first;
    for(const ph of PHASES.slice(PHASES.indexOf(phase0))){const n=ph==="release"?1:(r()<0.55?2:1);
      for(let i=0;i<n;i++){let pool=B.pool[ph].filter(s=>s!==prev);
        if(B.noChill){const used=new Set([...(this.usedCh||[]),...list.map(x=>x.style)]),fresh=pool.filter(s=>!used.has(s));if(fresh.length)pool=fresh;}   // chill band: variety — prefer styles not heard yet
        // v16: four-on-the-floor first — the broken-kick style is a rare flavour (never two entries apart), one phrase long in the techno bands
        const recentBroken=list.slice(-2).some(x=>x.style==="broken")||(this.lastBrokenSet!=null&&this.set&&this.set.n-this.lastBrokenSet<1&&!list.length);
        const W=pool.map(s=>s==="broken"?(recentBroken||!B.noChill?0:0.35):1);   /* techno bands: the broken groove comes as a short in-style flavour instead (Engine.flavourBar) */let st;
        const Wt=W.reduce((a,b)=>a+b,0);if(!list.length&&first)st=first;else if(Wt<=0){const alt=B.pool[ph].filter(s=>s!=="broken");st=alt.length?alt[Math.floor(r()*alt.length)]:pool[0];}else{let x=r()*Wt;st=pool.find((s,j)=>W[j]>0&&(x-=W[j])<=0)||pool.find(s=>s!=="broken")||pool[0];}
        list.push({style:st,phase:ph,phrases:st==="broken"&&!B.noChill?1:(ph==="peak"?3:2)+(r()<0.35?1:0)});prev=st;
        // chill episodes (v16: rarer): as a breather between two build entries, and sometimes right after the peak
        if(!B.noChill&&i===0&&n===2&&(ph==="build"?r()<0.2:ph==="peak"?r()<0.15:false))list.push({style:null,phase:"chill",phrases:1});}
      if(!B.noChill&&ph==="peak"&&r()<0.45)list.push({style:null,phase:"chill",phrases:1});}
    if(B.noChill){const u=new Set([...(this.usedCh||[]),...list.map(x=>x.style)]);this.usedCh=u.size>=5?list.slice(-1).map(x=>x.style):[...u];}
    this.set={list,idx:0,phr:0,n:(this.set?this.set.n:0)+1};}
  // ---- kick-drop recipe: length × what is removed × fill × riser × impact (band/energy dependent, never the same twice in a row) ----
  kickRecipe(o={}){const r=this.r,calm=this.band==="bchill",core=this.band==="b160",hi=this.band==="b140"||core,last=this.lastKick;
    const wp=w=>{let x=r()*Object.values(w).reduce((a,b)=>a+b,0);for(const [k,v] of Object.entries(w)){x-=v;if(x<=0)return k;}return Object.keys(w)[0];};
    let R,tries=0;
    do{let len=o.len||+wp(o.short?{"0":3,"1":2}:o.long?{"4":2,"8":1}:calm?{"0":1,"1":3,"2":2.5,"4":1.5}:core?{"0":1,"1":2,"2":3,"4":2.5,"8":.8}:hi?{"0":1,"1":2,"2":3,"4":2,"8":.6}:{"0":2,"1":3,"2":2.5,"4":1,"8":.3});
      const micro=len===0?(r()<0.5?2:4):0;if(micro)len=1;
      let remove=micro?(r()<0.6?"kick":"kickbass"):wp(o.forMix?{kick:2,kickbass:2}:calm?{kick:3,lowcut:3,thin:2,beat1:1}:core?{kick:3,kickbass:2,beat1:1,offbeat:1.5,thin:1,lowcut:.5}:hi?{kick:3,kickbass:3,beat1:1,offbeat:1,thin:1,lowcut:1}:{kick:2,lowcut:3,thin:2,beat1:2,offbeat:1,kickbass:1});
      const fill=micro?wp({gap:2,echo:1.5,none:2,snare16:micro===4?1:0}):wp(calm?{echo:3,revcym:2.5,none:2,gap:1,tom:.7}:core?{coreRoll:len>=2?3.5:1.5,kickroll16:2.5,kickroll8:1.5,snareBuild:len>=2?1:.3,snare16:1,triplet:.5,revcym:1,gap:1,none:.3}:hi?{snare16:2,snareBuild:len>=2?2:.5,kickroll16:2,kickroll8:1.5,triplet:1,tom:1,revcym:2,gap:1,none:.5}:{snare16:1,echo:3,gap:2,revcym:1,tom:1,none:2,triplet:1,kickroll8:.5});
      if(fill==="coreRoll"&&remove!=="kick"&&remove!=="kickbass")remove=r()<0.6?"kick":"kickbass";   // the roll owns every 16th: nothing else may play a kick
      const riser=micro?"none":(len<2?(r()<(core?0.5:0.3)?(core?"pitch":"noise"):"none"):wp(calm?{noise:1.5,none:2.5}:core?{pitch:3,noise:1.5,none:.5}:hi?{noise:2,pitch:2,none:1}:{noise:1,pitch:1,none:2}));
      const impact=wp(calm?{none:2,crash:2,boom:.5}:core?{crash:1,boom:2,crashboom:3,none:.3}:hi?{crash:2,boom:2,crashboom:2,none:.5}:{crash:2,none:2,boom:1});
      const pos=!o.forMix&&!o.len&&!micro&&r()<0.3?"pickup":"end";
      R={len,micro,remove,fill,riser,impact,pos};R.key=[len,micro,remove,fill,riser,impact].join("|");
    }while(++tries<10&&last&&(R.key===last.key||(R.fill===last.fill&&r()<0.75)||(R.remove===last.remove&&r()<0.5)));
    R.name=kdName(R);this.lastKick=R;return R;}
  pickBreak(o={}){const r=this.r,en=this.target("energy"),aff=BREAK_AFFINITY[this.e.low.style]||{};
    let c=BREAK_ORDER.filter(k=>{const B=BREAKS[k];return en>=B.energy[0]-0.05&&en<=B.energy[1]+0.05;});
    if(o.forMix)c=c.filter(k=>["kick","filter","hpbuild","tapestop","stutter","echo","silence","breakdown"].includes(k)&&(k!=="breakdown"||o.long)&&(BREAKS[k].len[0]<=(o.maxLen||2)||BREAKS[k].len[1]===1));
    if(o.short)c=c.filter(k=>BREAKS[k].len[0]<=2&&k!=="breakdown");
    if(o.long)c=c.filter(k=>BREAKS[k].len[1]>=8);
    if(this.band==="bchill")c=c.filter(k=>!["tapestop","stutter","silence","hpbuild"].includes(k)||c.length===1);   // gentle breaks only
    if(c.length>1)c=c.filter(k=>k!==this.lastBreak);
    if(!c.length)c=["kick"];
    const w=c.map(k=>(aff[k]||1)*(0.6+BREAKS[k].tension*(0.4+this.p.tension))*(k==="kick"?1.25:1));let x=r()*w.reduce((a,b)=>a+b,0);
    for(let i=0;i<c.length;i++){x-=w[i];if(x<=0)return c[i];}return c[c.length-1];}
  breakLen(type,o={}){const B=BREAKS[type];if(o.len)return Math.max(B.len[0],Math.min(B.len[1],o.len));
    if(o.short)return B.len[0];if(o.long)return B.len[1]>=8?Math.max(8,Math.min(B.len[1],type==="breakdown"?16:8)):B.len[1];return B.def;}

  onBar(bar,t){
    if(this.opening&&bar>=this.opening.end){this.opening=null;this.openEnded=bar;}
    for(const k of Object.keys(this.glide)){const g=this.glide[k];if(bar<g.b0)continue;if(g.from===null)g.from=this.p[k];
      const f=Math.min(1,(bar-g.b0+1)/g.bars);this.p[k]=g.from+(g.to-g.from)*f;
      if(f>=1){delete this.glide[k];const G=this.groups[g.gid];if(G){G.pending.delete(k);this.checkGroup(g.gid,bar,t);}}}
    const due=this.events.filter(x=>x.bar<=bar);this.events=this.events.filter(x=>x.bar>bar);
    for(const ev of due)this.run(ev,t,bar);
    if(!this.mix&&!this.pendingBand&&!this.chill&&!this.opening&&!this.closing&&this.queue.length){const q=this.queue.shift();this.curSrc=q.src;const ls=[];
      if(q.chill)this.planChill(bar,q.chill,ls);else if(q.band)this.planBand(q.band,bar,ls,q.pref);else this.planMix(q.style,bar,q.opts);this.curSrc=null;}
    if(this.auto&&!this.hold&&!this.closing&&!this.opening&&bar>0&&bar%16===0&&bar!==this.openEnded)this.autopilot(bar);
  }

  // ---- DJ mix within the band: tempo stays (slow drift only), kick timbre morphs, big timbre jumps hide in a kick-less break ----
  planMix(style,bar,o={}){
    const L=o.len||16,m=this.nextBoundary(bar,o.grid||16,o.gap??2),sw=m+L/2,from=this.e.low.style;let dl=o.dropLen??2,bt=o.breakType;
    const dist=kickDist(kickParams(from,this.band),kickParams(style,this.band)),big=dist>0.9;
    if(big&&!bt){dl=Math.max(dl,2);bt="kick";}
    this.mix={from,to:style,m,L,swap:sw,end:m+L,state:"planned",dropLen:dl,big};
    const A=this.ja(from),B=this.ja(style);
    this.addEvent({bar:m,type:"mixStart",label:`ミックス開始：${B}のハット／パーカッションを徐々に投入（上モノは交換から）`});
    this.addEvent({bar:m+L/4,type:"upOut",label:`${A}の上モノをハイパスで抜いていく（交換までに）`});
    // morph starts with the mix and finishes a few bars after the swap: rumble layer first, saturation last
    const kb0=m,kbars=Math.max(6,sw-m+3);
    this.addEvent({bar:kb0,type:"kickMorph",style,bars:kbars,label:`キックの質感を${B}へ${kbars}小節かけてモーフ（${big?"ランブル層を先に足す":"なめらかに"}）`});
    if(dl){bt=bt||this.pickBreak({forMix:true,maxLen:dl,long:dl>=8});const bl=BREAKS[bt].len[1]===1?1:Math.max(BREAKS[bt].len[0],dl);
      let R=null;if(bt==="kick")R=this.kickRecipe({len:bl,forMix:true});
      this.mix.dropLen=bl;this.mix.breakType=bt;this.lastBreak=bt;
      this.addEvent({bar:sw-bl,type:"drop",len:bl,btype:bt,recipe:R,label:`${bt==="kick"?"キック抜き（"+R.name+"）":BREAKS[bt].ja+"（"+bl+"小節）"}→ 交換`});}
    this.addEvent({bar:sw,type:"swap",label:`キック＋ベースを${B}に交換`});
    this.addEvent({bar:m+L,type:"mixEnd",label:`${A}が完全に抜けてミックス完了`});
    return this.mix;}
  requestStyle(style,o,labels){
    if(style===this.finalStyle()){labels.push(`既に${this.ja(style)}${this.mix?"へ移行中":""}です`);return;}
    if(this.mix||this.queue.length||this.pendingBand||this.chill||this.opening){this.queue.push({style,opts:o,src:this.curSrc});labels.push(`現在の移行が終わったら${this.ja(style)}へ`);return;}
    const M=this.planMix(style,this.bar,o);
    labels.push(`${M.m-this.bar}小節後から${M.L}小節かけて${this.ja(style)}へミックス（テンポは${BANDS[this.band].ja}のまま）`);}
  // ---- band change: deliberate DJ move, tempo changes ONLY inside a beatless bridge ----
  requestBand(band,labels,pref=null){
    if(band===(this.pendingBand||this.band)){labels.push(`既に${BANDS[band].ja}セット${this.pendingBand?"へ移行予定":""}です`);return;}
    if(this.mix||this.pendingBand||this.chill||this.opening){this.queue.push({band,pref,src:this.curSrc});labels.push(`現在の移行が終わったら${BANDS[band].ja}セット${pref?"（"+styleJa(pref,band)+"）":""}へ`);return;}
    this.planBand(band,this.bar,labels,pref);}
  // ---- chill episode inside the current band: 8-bar glide down, echo-out, chill core, 8-bar glide back, kick-drop return ----
  requestChill(o,labels){
    if(this.chill){labels.push(this.chill.state==="planned"?"チル展開は既に予定されています":"既にチル展開中です");return;}
    if(this.mix||this.pendingBand||this.queue.length||this.opening){this.queue.push({chill:o,src:this.curSrc});labels.push("現在の移行が終わったらチル展開へ");return;}
    this.planChill(this.bar,o,labels);}
  planChill(bar,o={},labels=[]){const r=this.r;
    const core=o.fast?this.nextBoundary(bar+9,8,0):this.nextBoundary(bar+10,16,0),inB=core-8;
    let mode=o.mode;if(!mode){const W=BANDS[this.band].chillW||(o.auto?{soft4:4,half:1,beatless:1}:{soft4:3,half:1.5,beatless:1});let x=r()*(W.soft4+W.half+W.beatless);mode=(x-=W.soft4)<0?"soft4":(x-W.half<0?"half":"beatless");}
    const L=o.auto&&!BANDS[this.band].noChill?(mode==="beatless"?8:(r()<0.6?8:16)):(mode==="beatless"?16:(o.len||(r()<0.5?16:32))),end=core+L;   // v16: autopilot episodes in the techno bands are short
    // clear planned breaks that would collide with the episode
    this.events=this.events.filter(ev=>{const clash=(ev.type==="break"||ev.type==="drop")&&ev.bar+ev.len>inB&&ev.bar<=end;if(clash)this.logItem(ev.label+"（チル展開のため）",ev.src,"cancel");return !clash;});
    const R0=this.kickRecipe({len:2});const R={...R0,pos:"end",
      riser:R0.riser==="none"?(r()<0.5?"noise":"pitch"):R0.riser,impact:R0.impact==="none"?(this.band==="b140"||this.band==="b160"?"crashboom":"crash"):R0.impact,
      fill:["gap","none"].includes(R0.fill)?(this.band==="b160"?"coreRoll":this.band==="b140"?"snareBuild":"revcym"):R0.fill};
    if(R.fill==="coreRoll"&&R.remove!=="kick"&&R.remove!=="kickbass")R.remove="kick";
    R.key=[R.len,R.micro,R.remove,R.fill,R.riser,R.impact].join("|");R.name=kdName(R);this.lastKick=R;
    const mj=CHILL_MODE_JA[mode];
    this.chill={inB,core,end,L,mode,state:"planned",src:this.curSrc};
    this.addEvent({bar:inB,type:"chillIn",chill:true,label:`チル展開へ：8小節かけてエネルギー・密度を下げ、キックを丸く（${mj}）`});
    this.addEvent({bar:core-1,type:"break",len:1,btype:"echo",noImpact:true,chill:true,label:"エコーアウトでチルに入る"});
    this.addEvent({bar:core,type:"chillCore",chill:true,mode,label:`チル：${mj}・パッド＋ダブ・ディレイ（${L}小節）`});
    this.addEvent({bar:end-8,type:"chillOut",chill:true,label:"チル明けに向けて8小節かけてエネルギーとキックを戻す"});
    this.addEvent({bar:end-2,type:"break",len:2,btype:"kick",recipe:R,chill:true,label:`キック抜き（${R.name}）→ チル明け`});
    this.addEvent({bar:end,type:"chillEnd",chill:true,label:"チル明け：通常のグルーヴに復帰"});
    labels.push(`${inB-bar}小節後からチル展開：${mj}、${L}小節（${end-bar}小節後に${R.name}で復帰、テンポは${BANDS[this.band].ja}のまま）`);
    return this.chill;}
  planBand(band,bar,labels,pref=null){const e=this.e,r=this.r,up=BANDS[band].center>BANDS[this.band].center,len=up?8:6;
    const end=this.nextBoundary(bar,16,len+(up?2:3)),st=end-len,to=BANDS[band].start;
    // drop breaks that would collide with the bridge
    this.events=this.events.filter(ev=>{const clash=(ev.type==="break"||ev.type==="drop")&&ev.bar+ev.len>st-2&&ev.bar<end;if(clash)this.logItem(ev.label+"（セット移行のため）",ev.src,"cancel");return !clash;});
    const pool=BANDS[band].pool[up?"build":"warm"],cur=e.low.style,first=pref||(pool.includes(cur)&&r()<0.5?cur:pool[Math.floor(r()*pool.length)]);
    let how="";
    if(!up){const bt=r()<0.5?"echo":"tapestop";how=BREAKS[bt].ja+"で落として";
      this.addEvent({bar:st-1,type:"break",len:1,btype:bt,noImpact:true,label:`${BREAKS[bt].ja}（セット移行の入口）`});}
    this.addEvent({bar:st,type:"break",len,btype:"bridge",dir:up?"up":"down",toBpm:to,label:`アンビエント・ブリッジ ${len}小節（ビートレス）→ ${end}小節目で${styleJa(first,band)}が始まる`});
    this.addEvent({bar:st+1,type:"bandSwitch",band,style:first,len,up,label:`${BANDS[this.band].ja}→${BANDS[band].ja}：ビートレス区間でテンポ ${e.bpm.toFixed(0)}→${to.toFixed(0)} BPM`});
    this.pendingBand=band;
    labels.push(`${BANDS[band].ja}セットへ：${st-bar}小節後に${how}アンビエント・ブリッジ（${len}小節、キックなし）の間にテンポを${to.toFixed(0)} BPMへ、${end-bar}小節後に${styleJa(first,band)}で再開`);}
  planBreak(bar,len,labels,grid,type,o={}){
    if(this.closing){labels.push("クロージング中のためブレイクは見送ります");return null;}
    type=type||this.pickBreak(o);const B=BREAKS[type];let R=null;
    if(type==="kick"){R=o.recipe||this.kickRecipe({len:len||undefined,short:o.short,long:o.long});len=R.len;if(!grid&&R.pos==="pickup")grid=4;}
    else len=len?this.breakLen(type,{len}):this.breakLen(type,o);
    grid=grid||(len<=1?4:(len<=8?8:16));grid=Math.max(grid,len>8?16:1);
    let end=this.nextBoundary(bar,grid,len+1);
    const busy=e=>this.events.some(x=>(x.type==="break"||x.type==="drop")&&x.bar<e&&x.bar+x.len+1>e-len)||(this.e.drop.active&&this.e.drop.endBar>=e-len);
    for(let i=0;i<6&&busy(end);i++)end+=grid;
    const st=end-len,nm=type==="kick"?`キック抜き（${R.name}）`:`${B.ja} ${len}小節`;
    if(this.pendingBand){labels.push(`セット移行の準備中のため${nm}は見送ります`);return null;}
    if(this.mix&&st<this.mix.swap&&end>this.mix.swap-(this.mix.dropLen||0)){labels.push(`ミックス中のため${B.ja}は交換ポイントの後に回せません（交換ポイントのブレイクに任せます）`);return null;}
    this.addEvent({bar:st,type:"break",len,btype:type,recipe:R,label:`${nm} → ${end}小節目で復帰`});this.lastBreak=type;
    labels.push(`${st-bar}小節後に${nm}：${type==="kick"?"組み合わせはその都度変わります":B.desc}`);return {st,end,type,len};}
  // ---- closing: phrase-aligned outro (16-31 bars): energy down, elements peel away, kick out with echo, tails, fade, stop ----
  startClosing(labels=[]){if(this.closing){labels.push("既にクロージング中です");return this.closing;}
    const e=this.e,bar=this.bar,D=e.drop;this.hold=false;this.opening=null;
    for(const q of this.queue)this.logItem(q.chill?"チル展開（待機中）":q.band?`${BANDS[q.band].ja}セットへの移行（待機中）`:`${this.ja(q.style)}へのミックス（待機中）`,q.src,"cancel");this.queue=[];
    const MIXEV=["mixStart","upOut","drop","swap","mixEnd","kickMorph"],keepMix=this.mix&&this.mix.state!=="planned",bridgeOn=D.active&&D.type==="bridge";
    if(this.mix&&!keepMix){const cm=this.mix;this.mix=null;this.logItem(`${this.ja(cm.from)} → ${this.ja(cm.to)} のミックス計画（クロージングのため）`,(this.events.find(x=>x.type==="mixStart")||{}).src,"cancel");}
    if(this.chill){const H=this.chill;this.chill=null;e.chillGlide=null;if(H.state==="planned")this.logItem(`チル展開の計画（クロージングのため）`,H.src,"cancel");}
    const keep=x=>(keepMix&&MIXEV.includes(x.type))||(bridgeOn&&x.type==="bandSwitch");
    for(const x of this.events)if(!keep(x)&&!(this.mix===null&&MIXEV.includes(x.type)&&!keepMix&&false))this.logItem(x.label+"（クロージングのため）",x.src,"cancel");
    this.events=this.events.filter(keep);
    if(this.pendingBand&&!bridgeOn){this.logItem(`${BANDS[this.pendingBand].ja}セットへの移行（クロージングのため）`,this.curSrc,"cancel");this.pendingBand=null;}
    const src=this.curSrc||"ストップ";
    if(D.active&&D.type==="intro"){       // stopped during the opening: stay beatless (no kick-in), let the opening bed peel away and fade
      const rem=D.endBar-bar,E=rem>=6?D.endBar:D.endBar+16;
      this.closing={c0:bar+1,E,o0:bar,src,fromOpening:true};e.riserBus.gain.setTargetAtTime(0,e.ctx.currentTime,0.4);
      if(E>D.endBar){this.addEvent({bar:D.endBar,type:"introHold",len:E-D.endBar,src,label:"オープニングの雰囲気のまま余韻へ（キックは入れない）"});}
      D.endBar=E;
      this.addEvent({bar:bar+1,type:"closeIn",src,label:`クロージング開始：${E-bar}小節でオープニングの雰囲気のまま静かに終える`});
      this.addEvent({bar:E,type:"closeEnd",src,label:"クロージング完了：余韻をフェードアウトして停止"});
      labels.push(`クロージング：オープニング中のためキックは入れずに${E-bar}小節後に終了（フェードアウトして停止）`);return this.closing;}
    let floor=bar+16;if(keepMix)floor=Math.max(floor,this.mix.end+8);if(D.active&&D.endBar>0)floor=Math.max(floor,D.endBar+8);
    const E=Math.ceil(floor/16)*16,o0=E-8;
    this.closing={c0:bar+1,E,o0,src};
    this.addEvent({bar:bar+1,type:"closeIn",src,label:`クロージング開始：${E-bar}小節かけてエネルギーを下げ、要素を抜いていく`});
    this.addEvent({bar:o0,type:"break",len:8,btype:"outro",src,label:"アウトロ：キックアウト＋エコーの余韻、ハット・パーカッション・上モノを順に抜く"});
    this.addEvent({bar:E,type:"closeEnd",src,label:"クロージング完了：余韻をフェードアウトして停止"});
    labels.push(`クロージング：${E-bar}小節後に終了（${o0-bar}小節後にキックアウト＋エコー、その後フェードアウトして停止）`);return this.closing;}
  planPeak(bar,k,labels){
    const end=this.nextBoundary(bar,16,10),len=end-bar>=14?8:4,st=end-len,build=Math.max(2,end-bar-1);
    this.setParam("energy",0.95,build,bar+1);this.setParam("density",Math.max(this.p.density,0.75),build,bar+1);this.setParam("tension",0.9,Math.max(2,st-bar),bar+1);
    this.addEvent({bar:st,type:"break",len,btype:"breakdown",label:`ピーク前の${BREAKS.breakdown.ja}${len}小節（最後にスネアロール＋ライザー）`});this.lastBreak="breakdown";
    this.addEvent({bar:end,type:"peakHit",label:"ピーク！ 緊張を解放"});
    labels.push(`${st-bar}小節後から${BREAKS.breakdown.ja}${len}小節＋ビルド → ${end-bar}小節後にピーク`);}

  keyTo(d,src,bar,t){const e=this.e,k0=S.key;S.key=d.key;e.key=d.key;
    this.logItem(d.key===k0?`キー：${keyLabel(d.key)}のまま（${MODE_JA[d.mode]}）`:`キー：${keyLabel(k0)} → ${keyLabel(d.key)}（${MODE_JA[d.mode]}・カメロット隣接）`,src||"auto","done",bar,t);}
  run(ev,t,bar){const e=this.e,M=this.mix,bd=16*e.s16;
    switch(ev.type){
      case "mixStart":{const B=e.makeDeck(M.to,false);e.decks.push(B);M.deckA=e.low;M.deckB=B;M.state="mixing";
        B.topEnv.hold(t);B.topEnv.lin(0.8,t+bd*M.L/4);
        const ue=e.upEnv[M.to],he=e.upHpEnv[M.to];ue.hold(t);ue.lin(UPMIX[M.to].lvl,t+bd*M.L/2);
        he.hold(t);he.set(1600,t);he.exp(20,t+bd*M.L/2);   // (v18: its notes only start at the swap, see Engine.melOK)
        // master trim follows the kick morph (whole mix-in .. 3 bars after the swap) instead of jumping at the swap
        e.trimEnv.hold(t);e.trimEnv.lin(Math.pow(10,trimDb(M.to,this.band)/20),t+bd*(M.swap-M.m+3));
        this.beginGroup(`${this.ja(M.to)}の雰囲気へ移行`,ev.src);
        {const PF=prof(M.to,this.band);for(const k of Object.keys(PF))this.setParam(k,this.target(k)+(PF[k]-this.target(k))*0.7,M.L,bar);}
        this.endGroup();break;}
      case "upOut":{if(!M)break;const ue=e.upEnv[M.from],he=e.upHpEnv[M.from];
        {const nb=Math.max(1,M.swap-bar);he.hold(t);he.exp(2600,t+bd*nb);if(M.from!==M.to){ue.hold(t);ue.lin(0,t+bd*nb);}}break;}   // v18: out by the swap
      case "kickMorph":e.startKickMorph(kickParams(ev.style,this.band),ev.bars,bar+1);break;
      case "drop":case "break":if(!e.drop.active){e.dropStart(t,"auto",ev.len,ev.btype||"kick",{recipe:ev.recipe,dir:ev.dir,noImpact:ev.noImpact,toBpm:ev.toBpm});e.drop.meta={src:ev.src};}
        else this.logItem(`${BREAKS[ev.btype||"kick"].ja}（別のブレイク中のためスキップ）`,ev.src,"cancel",bar,t);return;
      case "swap":{if(!M||!M.deckB)break;e.low=M.deckB;M.state="swapped";this.keyTo(M.deckB,ev.src,bar,t);
        if(M.from!==M.to){const ue=e.upEnv[M.to],he=e.upHpEnv[M.to];ue.hold(t);ue.set(UPMIX[M.to].lvl*0.4,t);ue.lin(UPMIX[M.to].lvl,t+bd*4);he.hold(t);he.set(900,t);he.exp(20,t+bd*4);}   // v18: incoming 上モノ enters here
        M.deckA.topEnv.hold(t);M.deckA.topEnv.lin(0,t+bd*M.L/4);M.deckB.topEnv.hold(t);M.deckB.topEnv.lin(1,t+bd*2);
        if(!M.dropLen&&S.crash&&this.p.energy>0.45)e.crash(t);break;}
      case "mixEnd":{if(!M)break;const A=M.deckA;e.decks=e.decks.filter(d=>d!==A);e.disposeDeck(A,t);
        e.upHpEnv[M.from].hold(t);e.upHpEnv[M.from].exp(20,t+0.5);
        this.mix=null;break;}
      case "bandSwitch":{const A=e.low,B=e.makeDeck(ev.style,false,ev.band);
        for(const d of e.decks)e.disposeDeck(d,t);e.decks=[B];e.low=B;this.mix=null;this.keyTo(B,ev.src,bar,t);
        B.topEnv.hold(t);B.topEnv.lin(1,t+bd);
        for(const st of UPSTYLES){const ue=e.upEnv[st];ue.hold(t);ue.lin(st===B.style?UPMIX[st].lvl:0,t+bd);e.upHpEnv[st].hold(t);e.upHpEnv[st].exp(20,t+0.3);}
        e.trimEnv.hold(t);e.trimEnv.lin(Math.pow(10,trimDb(B.style,ev.band)/20),t+bd);
        this.band=ev.band;S.band=ev.band;this.tempoBias=0;this.tempoRate=0.5;this.tempoGoal=null;this.pendingBand=null;
        e.bpmGlide={from:e.bpm,to:BANDS[ev.band].start,b0:bar+1,bars:Math.max(2,ev.len-4)};   // finishes 2 bars before the bridge ends
        e.kMorph=null;e.kp=kickParams(B.style,ev.band);                                        // fresh kick after the beatless bridge
        this.buildSet(ev.up?"build":"warm",B.style);
        this.beginGroup(`${BANDS[ev.band].ja}セットの雰囲気へ`,ev.src);
        {const PF=prof(B.style,ev.band);for(const k of Object.keys(PF))this.setParam(k,PF[k]+(k==="energy"?(ev.up?0.05:-0.08):0),ev.len,bar);}
        e.applyUpMix(ev.band,t);
        this.endGroup();break;}
      case "chillIn":{const C=this.chill;if(!C)break;C.state="in";e.startChill(1,8,bar+1);e.startKickMorph(chillKick(e.low.style,this.band),8,bar+1);
        this.beginGroup("チルの雰囲気へ",ev.src);
        const tg={energy:0.22,density:0.28,tension:0.1,space:Math.max(0.8,this.p.space),swing:this.p.swing+0.08,dark:this.p.dark-0.08};
        for(const k of Object.keys(tg))this.setParam(k,tg[k],8,bar);this.endGroup();break;}
      case "chillCore":if(this.chill){this.chill.state="core";e.chillMode=ev.mode;}break;
      case "chillOut":{const C=this.chill;if(!C)break;C.state="out";e.startChill(0,8,bar+1);e.startKickMorph(kickParams(e.low.style,this.band),8,bar+1);
        const SL=this.set,nx=SL.list[SL.idx+1]||SL.list[SL.idx],ph=nx&&nx.phase!=="chill"?nx.phase:"build",P=prof(e.low.style,this.band);
        this.beginGroup("チル明けの雰囲気へ",ev.src);
        const tg={energy:Math.max(phE(ph,this.band),P.energy*0.8),density:Math.max(0.45,P.density*0.9),tension:0.5,space:P.space,swing:P.swing,dark:P.dark};
        for(const k of Object.keys(tg))this.setParam(k,tg[k],8,bar);this.endGroup();break;}
      case "chillEnd":e.chillMode=null;e.chillAmt=0;e.chillGlide=null;this.chill=null;this.lastChillEnd=bar;this.chillCount++;break;
      case "closeIn":{const C=this.closing;if(!C)break;this.beginGroup("クロージング：エネルギーを下げていく",ev.src);
        const n=C.fromOpening?Math.max(4,C.E-bar):Math.max(4,C.o0-bar);for(const [k,v] of [["energy",0.15],["density",0.2],["tension",0.05],["space",0.95]])this.setParam(k,v,n,bar);this.endGroup();
        {const g=e.fadeG.gain,t1=t+(C.fromOpening?Math.max(2,C.E-bar-2):Math.max(1,C.o0-bar))*16*e.s16;g.cancelScheduledValues(t);g.setValueAtTime(1,t);g.linearRampToValueAtTime(0.6,t1);e.fadeLvl=0.6;}   // overall level eases down (−4.4 dB) as elements peel away
        break;}
      case "introHold":e.introHold(t,ev.len||16);break;
      case "closeEnd":e.closeAt(t);if(this.closing)this.closing.done=true;break;
      case "peakHit":this.beginGroup("ピーク後に緊張感を解放",ev.src);this.setParam("tension",0.25,8,bar);this.endGroup();break;
    }
    this.logItem(ev.done||ev.label,ev.src,"done",bar,t);}

  // ---- おまかせ: follow the setlist arc phrase by phrase ----
  autopilot(bar){this.curSrc="おまかせ";try{this.autopilotStep(bar);}finally{this.curSrc=null;this.curGid=null;}}
  autopilotStep(bar){const r=this.r,SL=this.set;if(this.chill)return;                // a chill episode runs on its own plan
    if(!this.mix&&!this.pendingBand)SL.phr++;   // phrases of an entry are counted after its mix-in
    if(this.mix&&this.mix.state==="swapped"&&!this.pendingBand&&r()<0.5){const ls=[];this.planBreak(bar,null,ls,null,"kick",{});}  // second half of a long mix
    if(this.mix||this.pendingBand||this.queue.length)return;   // the mix carries its own atmosphere glide
    let cur=SL.list[SL.idx];
    if(SL.phr>=cur.phrases){
      const adv=()=>{const S0=this.set;S0.idx++;S0.phr=0;if(S0.idx>=S0.list.length){this.buildSet("build",this.e.low.style);this.note(`セットリスト：次のアークを組み直し（${this.set.list.map(x=>x.phase==="chill"?"チル":this.ja(x.style)).join("→")}）`);}return this.set.list[this.set.idx];};
      let nx=adv();
      // chill entry: never back-to-back with a previous chill (>= 48 bars apart), never right at the start
      while(nx.phase==="chill"&&(bar-this.lastChillEnd<96||bar<64||BANDS[this.band].noChill))nx=adv();   // v16: >= 6 phrases between chill episodes
      // long stretch without a breather: slip one in before the next build / release entry (it shows up in the setlist)
      if(!BANDS[this.band].noChill&&nx.phase!=="chill"&&nx.phase!=="warm"&&bar>=64&&bar-Math.max(0,this.lastChillEnd)>=128){
        this.set.list.splice(this.set.idx,0,{style:null,phase:"chill",phrases:1});nx=this.set.list[this.set.idx];}
      if(nx.phase==="chill"){nx.style=this.e.low.style;const ls=[];this.planChill(bar,{auto:true},ls);
        this.note(`セットリスト：チル展開を挟む（${this.ja(nx.style)}のまま、${CHILL_MODE_JA[this.chill.mode]}、${this.chill.L}小節）`);return;}
      if(nx.style!==this.e.low.style){
        const brk=nx.style==="broken"||cur.style==="broken",toPeak=nx.phase==="peak"&&cur.phase!=="peak"&&!brk,L=toPeak?32:(brk&&this.band!=="bchill"?16:(r()<0.5?16:32));
        const o=toPeak?(this.band==="bchill"?{len:32,gap:1,dropLen:4,breakType:"filter"}:{len:32,gap:1,dropLen:8,breakType:"breakdown"}):{len:L,gap:1,dropLen:this.p.energy>0.55?2:(r()<0.6?1:0)};
        this.planMix(nx.style,bar,o);
        this.note(`セットリスト：${phJa(nx.phase,this.band)}へ → ${this.ja(nx.style)}（${L}小節ミックス${toPeak?(this.band==="bchill"?"＋フィルターブレイク":"＋ブレイクダウン"):""}）`);return;}
      this.note(`セットリスト：${phJa(nx.phase,this.band)}へ（${this.ja(nx.style)}のまま展開）`);cur=nx;}
    // energy follows the arc of the current setlist entry
    this.beginGroup(`アーク：${phJa(cur.phase,this.band)}の雰囲気`);
    const calm=this.band==="bchill",pe=phE(cur.phase,this.band);
    this.setParam("energy",pe+(r()-0.5)*0.08,16,bar);
    this.setParam("tension",(cur.phase==="build"?0.55:(cur.phase==="peak"?0.45:0.25))*(calm?0.5:1),16,bar);
    this.setParam("dark",this.p.dark+(r()-0.5)*0.15,16,bar);this.setParam("density",clamp01(pe+0.05+(r()-0.5)*0.15),16,bar);
    if(calm)this.setParam("space",Math.max(0.75,this.p.space),16,bar);this.endGroup();
    // phrase-end punctuation: mostly kick-drop recipes (each one different), sometimes another break type
    const x=bar-this.lastChillEnd<8?1:r(),ls=[],pk=this.band==="bchill"?0.45:0.42,po=this.band==="bchill"?0.75:0.6;   // v16: techno bands punctuate a little less  // the chill return already had its kick-drop
    const jz=this.e.jzPlan&&this.e.jzPlan.bar===bar;     // v22: a jazzy phrase is about to start -> no phrase-end punctuation inside it
    if(jz){}
    else if(x<pk)this.planBreak(bar,null,ls,null,"kick",{});
    else if(x<po){const bt=this.pickBreak({});if(bt!=="kick")this.planBreak(bar,null,ls,null,bt,{});else this.planBreak(bar,null,ls,null,"kick",{});}}

  // ---- free-text (Japanese) intent parser: rule-based keywords + intensity words ----
  intent(text){if(this.closing)return {ok:true,labels:["クロージング中のため受け付けません（もう一度ストップで即停止）"],planned:false};
    this.curSrc=`「${text}」`;this.beginGroup(null);
    try{const res=this._intent(text);const g=this.groups[this.curGid];
      if(g)g.label=(res.labels.join(" ").match(/[^\s・：（）]+?[↑↓]+/g)||[]).join(" ")||"雰囲気の変化";
      if(res.ok&&res.labels.length&&!res.planned&&!(g&&g.pending.size))this.logItem(res.labels.join(" ・ "),this.curSrc);
      return res;}
    finally{this.endGroup();this.curSrc=null;}}
  _intent(text){
    const tx=String(text).normalize("NFKC").toLowerCase(),bar=this.bar,labels=[];let k=1,fast=false,slow=false,hit=false;
    if(/少し|ちょっと|やや|ちょい|わずか|軽く|気持ち/.test(tx)){k=0.5;slow=true;}
    if(/かなり|すごく|めっちゃ|とても|超|思いっきり|思い切り|がっつり|ガッツリ|最大|全開/.test(tx))k=1.6;
    if(/一気に|今すぐ|すぐ|急に|即|いきなり/.test(tx)){fast=true;k=Math.max(k,1.4);}
    const gb=fast?2:(slow?16:8),start=fast?bar+1:this.nextBoundary(bar,4,1);
    const mixO={len:fast?8:(slow?32:16),grid:fast?8:16,gap:fast?1:2,dropLen:fast?1:(slow?0:2)};
    const arrows=d=>(d>0?"↑":"↓").repeat(Math.abs(d)>0.35?2:1);
    const delta=(key,d)=>{const to=this.target(key)+d*k;this.setParam(key,to,gb,start);labels.push(`${PARAM_JA[key]}${arrows(d*k)}`);hit=true;};
    const style=st=>{this.requestStyle(st,mixO,labels);hit=true;};
    const inChill=()=>(this.pendingBand||this.band)==="bchill";
    let t2=tx.replace(/ハードグル[ーｰ]?[ヴブ]/g,"グルーヴ");
    if(/(おまかせ|お任せ|自動|オート).*(やめ|オフ|解除|止め|終わ)|手動に/.test(t2)){labels.push("おまかせは常にオン");hit=true;t2=t2.replace(/おまかせ|お任せ|自動|オート/g,"");}
    else if(/おまかせ|お任せ|任せ|自動|オート|djして|勝手に/.test(t2)){this.auto=true;this.hold=false;labels.push(`おまかせ オン（${BANDS[this.band].ja}のセットリストに沿って進行）`);hit=true;}
    if(/このまま|キープ|維持|ずっと|固定|変えないで/.test(t2)){this.hold=true;
      for(const [gid,g] of Object.entries(this.groups))if(g.pending.size&&+gid!==this.curGid)this.logItem(`${g.label||"雰囲気の変化"}（途中で固定）`,g.src,"cancel");
      this.groups={};this.glide={};
      for(const q of this.queue)this.logItem(q.chill?"チル展開（待機中）":q.band?`${BANDS[q.band].ja}セットへの移行（待機中）`:`${this.ja(q.style)}へのミックス（待機中）`,q.src,"cancel");this.queue=[];
      let cc=null;if(this.chill&&this.chill.state==="planned"){cc=this.chill;this.chill=null;this.logItem(`チル展開の計画（${CHILL_MODE_JA[cc.mode]}・${cc.L}小節）`,cc.src,"cancel");}
      const MIXEV=["mixStart","upOut","drop","swap","mixEnd","kickMorph"];let cm=null;
      if(this.mix&&this.mix.state==="planned"){cm=this.mix;this.mix=null;}
      const keep=e=>(this.mix&&MIXEV.includes(e.type))||(e.chill&&!!this.chill);   // a started chill episode always completes
      if(cm)this.logItem(`${this.ja(cm.from)} → ${this.ja(cm.to)} のミックス計画（${cm.L}小節${cm.breakType?"・"+BREAKS[cm.breakType].ja:""}）`,(this.events.find(e=>e.type==="mixStart")||{}).src,"cancel");
      if(this.pendingBand){const be=this.events.find(e=>e.type==="bandSwitch");this.logItem(`${BANDS[this.pendingBand].ja}セットへの移行`,be&&be.src,"cancel");this.pendingBand=null;}
      for(const ev of this.events)if(!keep(ev)&&!(cm&&MIXEV.includes(ev.type))&&!(cc&&ev.chill)&&ev.type!=="bandSwitch"&&!(ev.btype==="bridge"))this.logItem(ev.label,ev.src,"cancel");
      this.events=this.events.filter(keep);
      this.logItem("ホールド開始：今の状態をキープ",this.curSrc);
      labels.push("ホールド：今の状態をキープ（進行中のミックス／チル展開のみ完了させる）");return {ok:true,labels,hold:true,planned:true};}
    this.hold=false;
    // chill band: band words and its style names (outside the chill band they switch band and start in that style)
    const BAND_CH=/チル帯|チルセット|チルのセット|ダブテクノ|ダブ・テクノ|アンビエント・?テクノ|ダウンテンポ|ディープ・?ミニマル|ローファイ|lo-?fi|オーガニック/;
    if(BAND_CH.test(t2)){const pref=/ダブ/.test(t2)?"groove":/アンビエント/.test(t2)?"hard":/ダウンテンポ/.test(t2)?"broken":/ディープ/.test(t2)?"minimal":/ローファイ|lo-?fi|オーガニック/.test(t2)?"tribal":null;
      if(!inChill()){this.requestBand("bchill",labels,pref);hit=true;}else if(pref)style(pref);else{this.requestBand("bchill",labels);hit=true;}
      t2=t2.replace(new RegExp("("+BAND_CH.source+")(帯)?(で|に|へ)?(上げて|下げて|落として|移って|変えて|行って|して|戻して)?","g"),"");}
    // v17: the 160 band is gone. "もっと速く" moves one band up (チル帯→120帯→140帯); inside 140帯 it is a tempo nudge, capped at the band top (148 BPM)
    if(/もっと速く/.test(t2)){const cur=this.pendingBand||this.band;
      if(cur==="bchill"||cur==="b120"){this.requestBand(cur==="bchill"?"b120":"b140",labels);hit=true;t2=t2.replace(/もっと速く(して)?/g,"");}}
    const BAND_HI=/140帯|140|ハイテンポ|速めのセット|速いセット|アップテンポ|高速/,BAND_LO=/120帯|125帯|120|ゆったりめ|遅めのセット|ゆっくりめ|ミドルテンポ/;
    if(BAND_HI.test(t2)){this.requestBand("b140",labels);hit=true;t2=t2.replace(new RegExp("("+BAND_HI.source+")(帯)?(で|に|へ)?(上げて|下げて|落として|移って|変えて|行って|して|戻して)?","g"),"");}
    else if(BAND_LO.test(t2)){this.requestBand("b120",labels);hit=true;t2=t2.replace(new RegExp("("+BAND_LO.source+")(帯)?(で|に|へ)?(上げて|下げて|落として|移って|変えて|行って|して|戻して)?","g"),"");}
    // chill episode on demand (checked before breaks / calm words so 休憩 / まったり are not read as a break)
    const CHILL_RE=/チル|休憩|一息|ひと息|まったり|クールダウン|小休止/;
    if(CHILL_RE.test(t2)){const mode=/ビートレス|ビートなし|アンビエント/.test(t2)?"beatless":(/ハーフ/.test(t2)?"half":(/4つ打ち|四つ打ち|キックは?残/.test(t2)?"soft4":null));
      this.requestChill({mode,len:/長め|長い|がっつり|ガッツリ/.test(tx)?32:(/短め|短い|ちょっと|少し/.test(tx)?16:null),fast},labels);hit=true;
      t2=t2.replace(/(ビートレス|ビートなし|アンビエント|ハーフタイム|ハーフ|4つ打ち|四つ打ち)(で|の)?/g,"").replace(/(チル|休憩|一息|ひと息|まったり|クールダウン|小休止)(展開)?(に|へ|で|を)?(して|入れて|挟んで|させて|しよう|したい)?/g,"");}
    const B=BANDS[this.band];
    const tempo=d=>{this.tempoBias=Math.max(-4,Math.min(4,this.tempoBias+d));this.tempoRate=1;const to=this.tempoTarget();
      this.tempoGoal={label:`テンポ ${to.toFixed(1)} BPM`,src:this.curSrc};labels.push(`テンポ${d>0?"↑":"↓"}（${B.ja}の中で ${to.toFixed(1)} BPM へ、1フレーズ1 BPM 以内でゆっくり）`);hit=true;};
    if(/テンポ.*(上|速|早|アップ)|速く|早く/.test(t2)){tempo(2*k);t2=t2.replace(/テンポ.*?(上げ|上|速|早|アップ)/,"");}
    else if(/テンポ.*(下|遅|ダウン)|遅く|ゆっくり/.test(t2)){tempo(-2*k);t2=t2.replace(/テンポ.*?(下げ|下|遅|ダウン)/,"");}
    let brokenHit=false;
    if(/ブレイクビート|変則|エレクトロ|ブロークン|崩して|崩す/.test(t2)){style("broken");brokenHit=true;}
    if(/ハード|激しく|激しい|硬く|インダストリアル|ゴリゴリ|攻撃的|アグレッシブ/.test(t2)){style(inChill()?"groove":"hard");/* chill band: the most driving style is dub techno */delta("energy",0.2);delta("dark",0.15);}
    if(/グルーヴ|グルーブ|ファンキー|ファンク/.test(t2))style("groove");
    if(/グルーヴ|グルーブ|ファンキー|ファンク|ノリ|跳ね|スウィング|スイング|シャッフル|うねり/.test(t2))delta("swing",0.3);
    if(/トライバル|民族|土着|呪術|ジャングル|アフロ|太鼓|パーカッシブ/.test(t2))style("tribal");
    if(/ミニマル|元に戻|最初の|ヒプノ/.test(t2))style("minimal");
    if(/シンプル|すっきり/.test(t2))delta("density",-0.25);
    if(/ピーク|頂点|クライマックス|最高潮|爆発|山場/.test(t2)){this.planPeak(bar,k,labels);labels.unshift("エネルギー↑↑ 緊張感↑↑");hit=true;}
    else{let bt=null;for(const [key,re] of BREAK_WORDS)if(re.test(t2)){bt=key;t2=t2.replace(re,"");break;}
      const isB=/ブレイク|ブレーク|抜いて|抜き|休憩|溜めて/.test(t2),shortB=/短い|短め|一瞬|軽く/.test(tx)||k<1,longB=/長い|長め|大きい|大きな|がっつり|ガッツリ/.test(tx)||k>1.2;
      if(bt){this.planBreak(bar,null,labels,null,bt,{short:shortB,long:longB});hit=true;}
      else if(!brokenHit&&isB){this.planBreak(bar,null,labels,null,null,{short:shortB,long:longB});hit=true;}}
    if(/盛り上げ|盛り上が|上げて|アゲ|あげて|テンション|エネルギー|熱く|アツく|攻めて/.test(t2)){delta("energy",0.25);delta("density",0.12);}
    if(/落ち着|静か|クール|チル|下げて|穏やか|リラックス|抑え|おとなしく|大人しく|まったり|ゆったり/.test(t2)){delta("energy",-0.25);delta("density",-0.15);delta("tension",-0.2);delta("space",0.1);}
    if(/暗く|暗い|ダーク|闇|重く|重い|不穏|怪しく|シリアス/.test(t2))delta("dark",0.3);
    if(/明るく|明るい|ブライト|爽やか|開放|キラキラ|ハッピー|軽やか/.test(t2))delta("dark",-0.3);
    if(/緊張|ビルド|煽|焦ら|じらし/.test(t2))delta("tension",0.3);
    if(/広く|広げ|空間|深く|ダブ|リバーブ|響か|奥行/.test(t2))delta("space",0.3);
    if(/ドライ|タイト|近く|締め/.test(t2))delta("space",-0.3);
    if(/密度|詰め|賑やか|手数|忙し|厚く|派手/.test(t2))delta("density",0.3);
    if(/スカスカ|減らし|間引|少なく|薄く|削/.test(t2))delta("density",-0.3);
    if(!hit)return {ok:false,labels:[],suggest:SUGGEST};
    const speed=fast?"一気に":(slow?"少しずつ":"");
    if(labels.some(l=>/[↑↓]/.test(l)&&!/^テンポ/.test(l))&&!/ピーク/.test(labels.join("")))labels.push(`${speed}${fast?"次の小節から":"次の4小節境界から"}${gb}小節かけて変化`);
    return {ok:true,labels,planned:this.events.some(e=>e.src===this.curSrc)||this.queue.some(q=>q.src===this.curSrc)||!!(this.tempoGoal&&this.tempoGoal.src===this.curSrc)};}
}


// loosely typed exports (the engine itself is an untyped JS port)
/* eslint-disable @typescript-eslint/no-explicit-any */
const S_DEFAULT = JSON.parse(JSON.stringify(S));
/** reset the module-level base settings before building a new engine (keeps runs deterministic) */
function resetS(band) { Object.assign(S, JSON.parse(JSON.stringify(S_DEFAULT))); if (band) S.band = band; S.style = BANDS[S.band].first; }
const _Engine: any = Engine, _Conductor: any = Conductor, _S: any = S, _BANDS: Record<string, any> = BANDS, _BREAKS: Record<string, any> = BREAKS,
  _PHASE_JA: Record<string, string> = PHASE_JA, _PARAM_JA: Record<string, string> = PARAM_JA;
export { _Engine as Engine, _Conductor as Conductor, _S as S, _BANDS as BANDS, _BREAKS as BREAKS, _PHASE_JA as PHASE_JA, _PARAM_JA as PARAM_JA,
  BREAK_ORDER, PARTS, resetS, phJa, styleJa, keyLabel, keyName, MODE_JA };
