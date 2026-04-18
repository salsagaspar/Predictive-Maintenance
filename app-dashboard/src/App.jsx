import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, ScatterChart, Scatter
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg0:"#020810", bg1:"#060e1a", bg2:"#0a1525", bg3:"#0f1d31",
  border:"#142035", borderHi:"#1e3355",
  blue:"#0a84ff", cyan:"#00cfff", amber:"#ff9f0a", red:"#ff453a",
  green:"#30d158", purple:"#bf5af2", pink:"#ff375f",
  t0:"#e8f4ff", t1:"#8fa3b8", t2:"#4a6a8a", t3:"#1e3050",
};

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const rnd = (a,b)=>Math.random()*(b-a)+a;
const smooth = (prev,next,alpha=0.3)=>prev*alpha+next*(1-alpha);

const MACHINES = [
  {id:"CPR-001",name:"Centrifugal Compressor A",type:"API 617 — 6-Stage",plant:"Plant 1 · Bay 3",rpm_nom:2850,bearings:["DE Bearing","NDE Bearing"],fault_freq:{bpfo:87.3,bpfi:113.2,bsf:67.1,ftf:11.2}},
  {id:"PMP-002",name:"Boiler Feed Pump B",type:"BB5 Multistage",plant:"Plant 1 · Bay 7",rpm_nom:2950,bearings:["Thrust Bearing","Journal Bearing"],fault_freq:{bpfo:94.1,bpfi:121.6,bsf:72.4,ftf:12.8}},
  {id:"TRB-003",name:"Steam Turbine Gen C",type:"Impulse — 12MW",plant:"Plant 2 · Hall 1",rpm_nom:3000,bearings:["HP Bearing","LP Bearing"],fault_freq:{bpfo:99.5,bpfi:128.4,bsf:76.8,ftf:13.5}},
];

function makeSensors(nom){
  return {temp:rnd(68,76),vib:rnd(2.5,3.8),pressure:rnd(78,88),
          rpm:nom+rnd(-80,80),current:rnd(48,54),oil_temp:rnd(52,60)};
}

function stepSensors(s,fault,faultIntensity){
  const fi=fault?faultIntensity:0;
  return {
    temp:    clamp(s.temp    +rnd(-0.8,0.8)+fi*0.4,  40,115),
    vib:     clamp(s.vib     +rnd(-0.2,0.2)+fi*0.18, 0.5,14),
    pressure:clamp(s.pressure+rnd(-1.2,1.2)+fi*0.6,  50,130),
    rpm:     clamp(s.rpm     +rnd(-35,35)  +fi*8,    1800,4200),
    current: clamp(s.current +rnd(-0.4,0.4)+fi*0.3,  20,90),
    oil_temp:clamp(s.oil_temp+rnd(-0.5,0.5)+fi*0.25, 35,95),
  };
}

function computeHealth(s){
  const scores=[
    1-clamp((s.temp-60)/55,0,1),
    1-clamp((s.vib-2)/12,0,1),
    1-clamp((s.pressure-70)/60,0,1),
    1-clamp(Math.abs(s.rpm-2850)/1400,0,1),
    1-clamp((s.current-45)/45,0,1),
    1-clamp((s.oil_temp-45)/50,0,1),
  ];
  return Math.round((scores.reduce((a,b)=>a+b,0)/6)*100);
}

function computeRUL(health){
  return Math.max(0,Math.round(Math.log(Math.max(health,5)/5)/0.038));
}

function anomalyScores(s){
  const base=(1-computeHealth(s)/100);
  return {
    lstm:    clamp(base+rnd(-0.06,0.06),0,1),
    iforest: clamp(base*0.9+rnd(-0.08,0.08),0,1),
    ocsvm:   clamp(base*1.1+rnd(-0.07,0.07),0,1),
  };
}

function generateFFT(vib,fault,faultFreqs){
  const pts=[];
  for(let f=5;f<=500;f+=2){
    let amp=Math.exp(-f/120)*0.15+rnd(0,0.02);
    amp+=0.4*Math.exp(-((f-50)**2)/200);   // 1x
    amp+=0.15*Math.exp(-((f-100)**2)/200); // 2x
    amp+=0.08*Math.exp(-((f-150)**2)/200); // 3x
    if(fault){
      const fi=fault?0.6:0;
      amp+=fi*vib/5*Math.exp(-((f-faultFreqs.bpfo)**2)/30);
      amp+=fi*vib/7*Math.exp(-((f-faultFreqs.bpfi)**2)/30);
      amp+=fi*vib/9*Math.exp(-((f-faultFreqs.bsf)**2)/30);
    }
    pts.push({f,amp:parseFloat((amp*(vib/3.5)).toFixed(4))});
  }
  return pts;
}

function shapValues(s,health){
  const total=(1-health/100);
  const raw={
    Temperature: clamp((s.temp-60)/55,0,1),
    Vibration:   clamp((s.vib-2)/12,0,1),
    Pressure:    clamp((s.pressure-70)/60,0,1),
    RPM:         clamp(Math.abs(s.rpm-2850)/1400,0,1),
    Current:     clamp((s.current-45)/45,0,1),
    Oil_Temp:    clamp((s.oil_temp-45)/50,0,1),
  };
  const sum=Object.values(raw).reduce((a,b)=>a+b,0)||1;
  return Object.entries(raw).map(([k,v])=>({
    feature:k, value:parseFloat(((v/sum)*total).toFixed(4)),
    raw:parseFloat(raw[k].toFixed(3))
  })).sort((a,b)=>b.value-a.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
const Mono = ({children,style={}})=>(
  <span style={{fontFamily:"'JetBrains Mono',monospace",...style}}>{children}</span>
);

function KPICard({label,value,unit,sub,color=C.cyan,icon,trend}){
  return(
    <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,
      padding:"14px 16px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:2,
        background:`linear-gradient(90deg,transparent,${color},transparent)`,opacity:0.6}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>{label}</div>
        <span style={{fontSize:16,opacity:0.4}}>{icon}</span>
      </div>
      <div style={{display:"flex",alignItems:"baseline",gap:4}}>
        <Mono style={{fontSize:26,fontWeight:700,color,lineHeight:1}}>{value}</Mono>
        <Mono style={{fontSize:11,color:C.t2}}>{unit}</Mono>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:6}}>
        <span style={{fontSize:9,color:C.t2}}>{sub}</span>
        {trend&&<span style={{fontSize:9,color:trend>0?C.red:C.green}}>
          {trend>0?"▲":"▼"} {Math.abs(trend).toFixed(1)}%
        </span>}
      </div>
    </div>
  );
}

function MiniGauge({label,value,unit,pct,color}){
  const r=22,cx=28,cy=28,circ=2*Math.PI*r;
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
      <svg width="56" height="56">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.bg3} strokeWidth="5"/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${circ*pct} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{transition:"stroke-dasharray 0.5s ease"}}/>
        <text x={cx} y={cy+4} textAnchor="middle" fill={color} fontSize="9"
          fontFamily="'JetBrains Mono',monospace" fontWeight="700">
          {typeof value==="number"?value.toFixed(1):value}
        </text>
      </svg>
      <Mono style={{fontSize:8,color:C.t2,letterSpacing:1}}>{label}</Mono>
      <Mono style={{fontSize:8,color:C.t3}}>{unit}</Mono>
    </div>
  );
}

function StatusDot({active,color=C.green}){
  return(
    <span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",
      background:active?color:C.t3,
      boxShadow:active?`0 0 6px ${color}`:"none",
      animation:active?"pulse 1.5s ease-in-out infinite":"none"}}/>
  );
}

const CTooltip=({active,payload,label})=>{
  if(!active||!payload?.length)return null;
  return(
    <div style={{background:"#030912ee",border:`1px solid ${C.border}`,
      borderRadius:4,padding:"6px 10px",fontFamily:"'JetBrains Mono',monospace"}}>
      {label!==undefined&&<div style={{fontSize:9,color:C.t2,marginBottom:4}}>{label}</div>}
      {payload.map((p,i)=>(
        <div key={i} style={{fontSize:10,color:p.color||C.t1}}>
          {p.name}: {typeof p.value==="number"?p.value.toFixed(3):p.value}
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DIGITAL TWIN SVG
// ─────────────────────────────────────────────────────────────────────────────
function DigitalTwin({sensors,health,fault,faultIntensity}){
  const compHealth=useMemo(()=>{
    const fi=fault?faultIntensity:0;
    return{
      motor:    clamp(100-fi*8-clamp((sensors.current-45)/45,0,1)*30,20,100),
      coupling: clamp(100-fi*12-clamp((sensors.vib-2)/12,0,1)*40,20,100),
      bear1:    clamp(100-fi*20-clamp((sensors.vib-2)/12,0,1)*50,20,100),
      impeller: clamp(100-fi*10-clamp((sensors.pressure-70)/60,0,1)*30,20,100),
      bear2:    clamp(100-fi*15-clamp((sensors.vib-2)/12,0,1)*45,20,100),
      seal:     clamp(100-fi*5 -clamp((sensors.oil_temp-45)/50,0,1)*20,20,100),
    };
  },[sensors,fault,faultIntensity]);

  const hColor=(h)=>h>75?C.green:h>45?C.amber:C.red;
  const hGlow=(h,base=6)=>h>75?`0 0 ${base}px ${C.green}44`:h>45?`0 0 ${base}px ${C.amber}44`:`0 0 ${base}px ${C.red}66`;
  const rpm=sensors.rpm;
  const [rotAngle,setRotAngle]=useState(0);
  useEffect(()=>{
    const id=setInterval(()=>setRotAngle(a=>(a+rpm/600)%360),50);
    return()=>clearInterval(id);
  },[rpm]);

  const parts=[
    {id:"motor",   label:"Motor",    x:30, y:70, w:70, h:80, rx:4, comp:"motor"},
    {id:"coupling",label:"Coupling", x:105,y:88, w:20, h:44, rx:2, comp:"coupling"},
    {id:"bear1",   label:"DE Brng",  x:128,y:82, w:18, h:56, rx:3, comp:"bear1"},
    {id:"impeller",label:"Impeller", x:148,y:62, w:80, h:96, rx:6, comp:"impeller"},
    {id:"bear2",   label:"NDE Brng", x:232,y:82, w:18, h:56, rx:3, comp:"bear2"},
    {id:"seal",    label:"Mech Seal",x:253,y:90, w:22, h:40, rx:2, comp:"seal"},
  ];

  return(
    <div style={{position:"relative"}}>
      <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>DIGITAL TWIN — LIVE COMPONENT HEALTH</div>
      <svg viewBox="0 0 310 220" style={{width:"100%",maxWidth:420,display:"block"}}>
        <defs>
          <filter id="glow"><feGaussianBlur stdDeviation="2.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <radialGradient id="shaftGrad" cx="50%" cy="50%"><stop offset="0%" stopColor="#1e3355"/>
            <stop offset="100%" stopColor="#0a1828"/></radialGradient>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke={C.border} strokeWidth="0.5"/>
          </pattern>
        </defs>

        {/* Background grid */}
        <rect width="310" height="220" fill={C.bg2} rx="8"/>
        <rect width="310" height="220" fill="url(#grid)" rx="8" opacity="0.4"/>

        {/* Pipe / shaft */}
        <rect x="100" y="106" width="165" height="8" fill="url(#shaftGrad)" rx="2"/>
        <rect x="100" y="106" width="165" height="8" fill="none" stroke={C.blue} strokeWidth="0.5" rx="2" opacity="0.5"/>

        {/* Coolant lines */}
        <path d="M 148 62 Q 120 45 100 50 Q 80 55 30 55" fill="none" stroke={C.cyan} strokeWidth="1" strokeDasharray="4 3" opacity="0.4"/>
        <path d="M 228 158 Q 250 175 280 175" fill="none" stroke={C.cyan} strokeWidth="1" strokeDasharray="4 3" opacity="0.4"/>

        {/* Components */}
        {parts.map(p=>{
          const h=compHealth[p.comp];
          const col=hColor(h);
          return(
            <g key={p.id} filter="url(#glow)">
              <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx}
                fill={`${col}08`} stroke={col} strokeWidth="1.2" opacity="0.9"/>
              <text x={p.x+p.w/2} y={p.y+p.h/2-6} textAnchor="middle"
                fill={col} fontSize="7.5" fontFamily="'JetBrains Mono',monospace" fontWeight="700">
                {p.label}
              </text>
              <text x={p.x+p.w/2} y={p.y+p.h/2+7} textAnchor="middle"
                fill={col} fontSize="8.5" fontFamily="'JetBrains Mono',monospace">
                {Math.round(h)}%
              </text>
              {/* health bar */}
              <rect x={p.x+4} y={p.y+p.h-10} width={p.w-8} height={3} rx="1" fill={C.bg0}/>
              <rect x={p.x+4} y={p.y+p.h-10} width={(p.w-8)*h/100} height={3} rx="1" fill={col}
                style={{transition:"width 0.5s ease"}}/>
            </g>
          );
        })}

        {/* Rotating impeller blades */}
        <g transform={`translate(188,110) rotate(${rotAngle})`}>
          {[0,45,90,135,180,225,270,315].map(a=>(
            <line key={a}
              x1={0} y1={0}
              x2={Math.cos(a*Math.PI/180)*28} y2={Math.sin(a*Math.PI/180)*28}
              stroke={C.blue} strokeWidth="1.5" opacity="0.5"/>
          ))}
          <circle cx="0" cy="0" r="5" fill={C.bg2} stroke={C.blue} strokeWidth="1.5"/>
        </g>

        {/* RPM display */}
        <text x="188" y="175" textAnchor="middle" fill={C.t2} fontSize="8"
          fontFamily="'JetBrains Mono',monospace">{Math.round(rpm)} RPM</text>

        {/* Fault lightning bolt */}
        {fault&&faultIntensity>1&&(
          <text x="275" y="40" textAnchor="middle" fill={C.red} fontSize="18"
            style={{animation:"pulse 0.7s ease-in-out infinite"}}>⚡</text>
        )}

        {/* Overall health */}
        <g>
          <rect x="5" y="5" width="60" height="28" rx="4" fill={C.bg3} stroke={C.border}/>
          <text x="35" y="15" textAnchor="middle" fill={C.t2} fontSize="7"
            fontFamily="'JetBrains Mono',monospace">HEALTH</text>
          <text x="35" y="27" textAnchor="middle" fill={hColor(health)} fontSize="10"
            fontFamily="'JetBrains Mono',monospace" fontWeight="700">{health}%</text>
        </g>
        <g>
          <rect x="5" y="37" width="60" height="28" rx="4" fill={C.bg3} stroke={C.border}/>
          <text x="35" y="47" textAnchor="middle" fill={C.t2} fontSize="7"
            fontFamily="'JetBrains Mono',monospace">RUL</text>
          <text x="35" y="59" textAnchor="middle" fill={C.amber} fontSize="10"
            fontFamily="'JetBrains Mono',monospace" fontWeight="700">{computeRUL(health)}d</text>
        </g>
      </svg>

      {/* Component health legend */}
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
        {Object.entries(compHealth).map(([k,h])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:4,
            background:C.bg3,borderRadius:3,padding:"3px 7px",
            border:`1px solid ${hColor(h)}22`}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:hColor(h),
              boxShadow:`0 0 4px ${hColor(h)}`}}/>
            <Mono style={{fontSize:8,color:C.t1}}>{k.replace("bear","bearing ").replace("1"," DE").replace("2"," NDE")}</Mono>
            <Mono style={{fontSize:8,color:hColor(h)}}>{Math.round(h)}%</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FFT SPECTRUM
// ─────────────────────────────────────────────────────────────────────────────
function FFTSpectrum({fftData,faultFreqs,fault}){
  return(
    <div>
      <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:6}}>
        FFT VIBRATION SPECTRUM — FREQUENCY DOMAIN ANALYSIS
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:8}}>
        {[
          {label:"BPFO",freq:faultFreqs.bpfo,color:C.red},
          {label:"BPFI",freq:faultFreqs.bpfi,color:C.amber},
          {label:"BSF", freq:faultFreqs.bsf, color:C.purple},
          {label:"FTF", freq:faultFreqs.ftf, color:C.pink},
        ].map(f=>(
          <div key={f.label} style={{display:"flex",alignItems:"center",gap:4}}>
            <div style={{width:12,height:2,background:f.color,borderRadius:1}}/>
            <Mono style={{fontSize:8,color:C.t2}}>{f.label} {f.freq}Hz</Mono>
            {fault&&<Mono style={{fontSize:8,color:f.color}}>⚡</Mono>}
          </div>
        ))}
        <Mono style={{fontSize:8,color:C.t2,marginLeft:"auto"}}>
          1× {faultFreqs.bpfo&&"RUNNING SPEED HARMONICS"}
        </Mono>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <AreaChart data={fftData} margin={{top:4,right:4,bottom:0,left:-15}}>
          <defs>
            <linearGradient id="fftFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={C.blue} stopOpacity={0.4}/>
              <stop offset="95%" stopColor={C.blue} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
          <XAxis dataKey="f" tick={{fill:C.t3,fontSize:8}} label={{value:"Hz",position:"insideRight",fill:C.t3,fontSize:8}}/>
          <YAxis tick={{fill:C.t3,fontSize:8}} label={{value:"g",angle:-90,position:"insideLeft",fill:C.t3,fontSize:8}}/>
          <Tooltip content={<CTooltip/>}/>
          {[50,100,150].map(f=>(
            <ReferenceLine key={f} x={f} stroke={C.cyan} strokeDasharray="2 4" strokeWidth={0.8}
              label={{value:`${f}Hz`,fill:C.cyan,fontSize:7,position:"top"}}/>
          ))}
          {fault&&[faultFreqs.bpfo,faultFreqs.bpfi,faultFreqs.bsf].map((f,i)=>{
            const cols=[C.red,C.amber,C.purple];
            return(
              <ReferenceLine key={i} x={Math.round(f/2)*2} stroke={cols[i]}
                strokeDasharray="3 3" strokeWidth={1}/>
            );
          })}
          <Area type="monotone" dataKey="amp" stroke={C.blue} strokeWidth={1.2}
            fill="url(#fftFill)" dot={false} name="Amplitude(g)" isAnimationActive={false}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENSEMBLE ANOMALY PANEL
// ─────────────────────────────────────────────────────────────────────────────
function EnsemblePanel({scores,history}){
  const ensembleScore=(scores.lstm+scores.iforest+scores.ocsvm)/3;
  const anomaly=ensembleScore>0.55;
  const modelColor=(s)=>s>0.7?C.red:s>0.5?C.amber:C.green;
  const models=[
    {name:"LSTM Autoencoder",   score:scores.lstm,   threshold:0.55,detail:"Reconstruction Error: MSE"},
    {name:"Isolation Forest",   score:scores.iforest,threshold:0.50,detail:"Anomaly Score: IF Depth"},
    {name:"One-Class SVM",      score:scores.ocsvm,  threshold:0.60,detail:"Decision Function: RBF"},
  ];
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:9,color:C.t2,letterSpacing:2}}>ENSEMBLE ANOMALY DETECTION</div>
        <div style={{display:"flex",alignItems:"center",gap:6,
          background:anomaly?`${C.red}15`:`${C.green}10`,
          border:`1px solid ${anomaly?C.red:C.green}33`,
          borderRadius:4,padding:"3px 8px"}}>
          <StatusDot active={anomaly} color={anomaly?C.red:C.green}/>
          <Mono style={{fontSize:9,color:anomaly?C.red:C.green}}>
            {anomaly?"ANOMALY":"NOMINAL"} · {(ensembleScore*100).toFixed(1)}%
          </Mono>
        </div>
      </div>
      {models.map(m=>(
        <div key={m.name} style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <Mono style={{fontSize:9,color:C.t1}}>{m.name}</Mono>
            <Mono style={{fontSize:9,color:modelColor(m.score)}}>{(m.score*100).toFixed(1)}%</Mono>
          </div>
          <div style={{height:6,background:C.bg3,borderRadius:3,overflow:"hidden",position:"relative"}}>
            <div style={{position:"absolute",left:`${m.threshold*100}%`,top:0,bottom:0,
              width:1,background:C.amber,zIndex:2}}/>
            <div style={{height:"100%",width:`${m.score*100}%`,
              background:`linear-gradient(90deg,${C.green},${modelColor(m.score)})`,
              borderRadius:3,transition:"width 0.5s ease"}}/>
          </div>
          <Mono style={{fontSize:7,color:C.t3,marginTop:2}}>{m.detail} · threshold={m.threshold}</Mono>
        </div>
      ))}
      <div style={{marginTop:8}}>
        <div style={{fontSize:9,color:C.t3,letterSpacing:2,marginBottom:6}}>SCORE HISTORY (60s)</div>
        <ResponsiveContainer width="100%" height={60}>
          <LineChart data={history.slice(-60)} margin={{top:2,right:4,bottom:0,left:-25}}>
            <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
            <YAxis domain={[0,1]} tick={{fill:C.t3,fontSize:7}}/>
            <Tooltip content={<CTooltip/>}/>
            <ReferenceLine y={0.55} stroke={C.amber} strokeDasharray="3 3" strokeWidth={0.8}/>
            <Line type="monotone" dataKey="anom_lstm"   stroke={C.blue}   strokeWidth={1.2} dot={false} name="LSTM"  isAnimationActive={false}/>
            <Line type="monotone" dataKey="anom_if"     stroke={C.purple} strokeWidth={1.2} dot={false} name="IForest" isAnimationActive={false}/>
            <Line type="monotone" dataKey="anom_svm"    stroke={C.pink}   strokeWidth={1.2} dot={false} name="OC-SVM" isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAP PANEL
// ─────────────────────────────────────────────────────────────────────────────
function SHAPPanel({shap}){
  const maxV=Math.max(...shap.map(s=>s.value),0.01);
  const featureColor=(f,v)=>{
    const palette={Temperature:C.red,Vibration:C.amber,Pressure:C.blue,RPM:C.cyan,Current:C.purple,Oil_Temp:C.pink};
    return palette[f]||C.blue;
  };
  return(
    <div>
      <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>
        SHAP — FEATURE IMPORTANCE (ANOMALY EXPLANATION)
      </div>
      <div style={{fontSize:8,color:C.t3,marginBottom:10}}>
        ← Lower impact &nbsp;&nbsp;&nbsp; Contribution to anomaly score &nbsp;&nbsp;&nbsp; Higher impact →
      </div>
      {shap.map((s,i)=>{
        const col=featureColor(s.feature,s.value);
        const pct=(s.value/maxV)*100;
        return(
          <div key={s.feature} style={{marginBottom:7}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <Mono style={{fontSize:9,color:C.t1,width:90}}>{s.feature}</Mono>
              <div style={{flex:1,display:"flex",alignItems:"center",gap:6}}>
                <div style={{flex:1,height:5,background:C.bg3,borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:2,
                    transition:"width 0.4s ease"}}/>
                </div>
                <Mono style={{fontSize:8,color:col,width:44,textAlign:"right"}}>{s.value.toFixed(4)}</Mono>
              </div>
            </div>
            <Mono style={{fontSize:7,color:C.t3,paddingLeft:90}}>
              raw={s.raw.toFixed(3)} · rank #{i+1}
            </Mono>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function DriftPanel({history}){
  const driftData=history.slice(-40).map((d,i)=>({
    t:i,
    ks_temp:  parseFloat((Math.abs(Math.sin(i*0.15))*0.3+rnd(0,0.1)+(d.anom_lstm||0)*0.3).toFixed(3)),
    ks_vib:   parseFloat((Math.abs(Math.cos(i*0.12))*0.25+rnd(0,0.08)+(d.anom_if||0)*0.4).toFixed(3)),
    ks_press: parseFloat((Math.abs(Math.sin(i*0.18))*0.2+rnd(0,0.06)+(d.anom_svm||0)*0.25).toFixed(3)),
  }));
  return(
    <div>
      <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:4}}>
        CONCEPT DRIFT — KS-TEST P-VALUE (α=0.05)
      </div>
      <div style={{fontSize:8,color:C.t3,marginBottom:8}}>
        Low p-value → distribution shift detected → retraining recommended
      </div>
      <ResponsiveContainer width="100%" height={100}>
        <LineChart data={driftData} margin={{top:4,right:4,bottom:0,left:-15}}>
          <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
          <XAxis dataKey="t" hide/>
          <YAxis domain={[0,0.8]} tick={{fill:C.t3,fontSize:7}}/>
          <Tooltip content={<CTooltip/>}/>
          <ReferenceLine y={0.05} stroke={C.red} strokeDasharray="3 3"
            label={{value:"α=0.05",fill:C.red,fontSize:7,position:"right"}}/>
          <Line type="monotone" dataKey="ks_temp"  stroke={C.red}    strokeWidth={1.2} dot={false} name="KS_Temp" isAnimationActive={false}/>
          <Line type="monotone" dataKey="ks_vib"   stroke={C.amber}  strokeWidth={1.2} dot={false} name="KS_Vib" isAnimationActive={false}/>
          <Line type="monotone" dataKey="ks_press" stroke={C.blue}   strokeWidth={1.2} dot={false} name="KS_Press" isAnimationActive={false}/>
        </LineChart>
      </ResponsiveContainer>
      <div style={{display:"flex",gap:8,marginTop:6}}>
        {[["KS Temp",C.red],["KS Vib",C.amber],["KS Press",C.blue]].map(([l,c])=>(
          <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
            <div style={{width:10,height:2,background:c,borderRadius:1}}/>
            <Mono style={{fontSize:7,color:C.t2}}>{l}</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE OPS
// ─────────────────────────────────────────────────────────────────────────────
function MaintenanceOps({health,rul,fault,sensors}){
  const urgency=health<40?"CRITICAL":health<65?"HIGH":health<80?"MEDIUM":"LOW";
  const urgencyCol={CRITICAL:C.red,HIGH:C.amber,MEDIUM:C.cyan,LOW:C.green}[urgency];
  const costData=[
    {name:"Preventive",cost:12000,color:C.green},
    {name:"Corrective",cost:48000,color:C.amber},
    {name:"Breakdown", cost:185000,color:C.red},
  ];
  const workOrders=[
    {id:"WO-4821",action:"Bearing Lubrication",priority:"P1",due:"2 days",component:"DE Bearing",est:"2h"},
    {id:"WO-4822",action:"Vibration Analysis",priority:"P1",due:"Today",component:"Shaft",est:"4h"},
    {id:"WO-4823",action:"Seal Inspection",priority:"P2",due:"5 days",component:"Mech. Seal",est:"3h"},
    {id:"WO-4824",action:"Oil Analysis",priority:"P2",due:"7 days",component:"Lube System",est:"1h"},
    {id:"WO-4825",action:"Alignment Check",priority:"P3",due:"14 days",component:"Coupling",est:"6h"},
  ].filter((_,i)=>i<(fault?5:2));

  const history=[
    {date:"2026-03-15",action:"Bearing replacement DE",type:"Corrective",cost:18500,tech:"Ahmad R."},
    {date:"2026-02-01",action:"Full inspection + lube",type:"Preventive",cost:3200,tech:"Budi S."},
    {date:"2026-01-08",action:"Seal replacement",type:"Corrective",cost:9800,tech:"Citra D."},
    {date:"2025-12-01",action:"Scheduled PM — Q4",type:"Preventive",cost:4100,tech:"Ahmad R."},
  ];

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Work Orders */}
      <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:9,color:C.t2,letterSpacing:2}}>GENERATED WORK ORDERS</div>
          <div style={{display:"flex",gap:6,alignItems:"center",
            background:`${urgencyCol}15`,border:`1px solid ${urgencyCol}33`,
            borderRadius:4,padding:"3px 8px"}}>
            <StatusDot active color={urgencyCol}/>
            <Mono style={{fontSize:9,color:urgencyCol}}>URGENCY: {urgency}</Mono>
          </div>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${C.border}`}}>
                {["WO ID","Action","Component","Priority","Due","Est."].map(h=>(
                  <th key={h} style={{padding:"6px 8px",color:C.t3,textAlign:"left",letterSpacing:1}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workOrders.map(wo=>{
                const pc=wo.priority==="P1"?C.red:wo.priority==="P2"?C.amber:C.t1;
                return(
                  <tr key={wo.id} style={{borderBottom:`1px solid ${C.bg3}`}}>
                    <td style={{padding:"7px 8px",color:C.blue}}>{wo.id}</td>
                    <td style={{padding:"7px 8px",color:C.t1}}>{wo.action}</td>
                    <td style={{padding:"7px 8px",color:C.t2}}>{wo.component}</td>
                    <td style={{padding:"7px 8px"}}><span style={{color:pc,background:`${pc}15`,
                      padding:"2px 6px",borderRadius:2}}>{wo.priority}</span></td>
                    <td style={{padding:"7px 8px",color:C.t1}}>{wo.due}</td>
                    <td style={{padding:"7px 8px",color:C.t2}}>{wo.est}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Cost comparison */}
        <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
          <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>COST IMPACT ANALYSIS (IDR '000)</div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={costData} margin={{top:4,right:4,bottom:0,left:-15}}>
              <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
              <XAxis dataKey="name" tick={{fill:C.t2,fontSize:8}}/>
              <YAxis tick={{fill:C.t3,fontSize:8}}/>
              <Tooltip content={<CTooltip/>}/>
              <Bar dataKey="cost" name="Cost (K)" radius={[3,3,0,0]} isAnimationActive={false}>
                {costData.map((d,i)=><Cell key={i} fill={d.color}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{marginTop:8,padding:8,background:C.bg3,borderRadius:4}}>
            <Mono style={{fontSize:8,color:C.green}}>💡 Preventive saves up to </Mono>
            <Mono style={{fontSize:8,color:C.green}}>IDR {((185000-12000)/1000).toFixed(0)}M vs breakdown</Mono>
          </div>
        </div>

        {/* Maintenance history */}
        <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
          <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>MAINTENANCE HISTORY</div>
          {history.map((h,i)=>(
            <div key={i} style={{display:"flex",gap:8,paddingBottom:8,marginBottom:8,
              borderBottom:i<history.length-1?`1px solid ${C.bg3}`:"none"}}>
              <div style={{width:3,background:h.type==="Corrective"?C.amber:C.green,
                borderRadius:2,flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between"}}>
                  <Mono style={{fontSize:8,color:C.t1}}>{h.action}</Mono>
                  <Mono style={{fontSize:8,color:h.type==="Corrective"?C.amber:C.green}}>{h.type}</Mono>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
                  <Mono style={{fontSize:7,color:C.t3}}>{h.date} · {h.tech}</Mono>
                  <Mono style={{fontSize:7,color:C.t2}}>Rp {(h.cost/1000).toFixed(1)}jt</Mono>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Root Cause */}
      <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
        <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>ROOT CAUSE ANALYSIS — FAULT TREE PROBABILITY</div>
        {[
          {cause:"Bearing Outer Race Defect",prob:fault?0.72:0.12,sensor:"Vibration @ BPFO"},
          {cause:"Lubrication Degradation",  prob:fault?0.61:0.18,sensor:"Oil Temp + Vibration"},
          {cause:"Misalignment",             prob:fault?0.38:0.08,sensor:"1× 2× Harmonics"},
          {cause:"Rotor Imbalance",          prob:fault?0.29:0.05,sensor:"1× Running Speed"},
          {cause:"Seal Wear",                prob:fault?0.22:0.04,sensor:"Pressure Drop"},
        ].map(r=>(
          <div key={r.cause} style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <Mono style={{fontSize:9,color:r.prob>0.5?C.red:r.prob>0.3?C.amber:C.t1}}>{r.cause}</Mono>
              <Mono style={{fontSize:9,color:r.prob>0.5?C.red:r.prob>0.3?C.amber:C.t1}}>
                {(r.prob*100).toFixed(0)}%
              </Mono>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <div style={{flex:1,height:4,background:C.bg3,borderRadius:2}}>
                <div style={{height:"100%",width:`${r.prob*100}%`,borderRadius:2,
                  background:r.prob>0.5?C.red:r.prob>0.3?C.amber:C.green,
                  transition:"width 0.5s ease"}}/>
              </div>
              <Mono style={{fontSize:7,color:C.t3,width:160}}>{r.sensor}</Mono>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RADAR / MODEL METRICS
// ─────────────────────────────────────────────────────────────────────────────
function ModelMetrics({health,fault}){
  const metrics=[
    {metric:"ROC-AUC", A:0.97,B:0.94,C:0.91},
    {metric:"F1",      A:0.93,B:0.89,C:0.87},
    {metric:"Precision",A:0.95,B:0.91,C:0.88},
    {metric:"Recall",  A:0.91,B:0.87,C:0.86},
    {metric:"Specificity",A:0.96,B:0.93,C:0.90},
    {metric:"MCC",     A:0.92,B:0.88,C:0.85},
  ];
  const confusionData=fault?
    [{name:"TP",value:47,fill:C.green},{name:"FP",value:3,fill:C.amber},{name:"FN",value:5,fill:C.red},{name:"TN",value:145,fill:C.blue}]:
    [{name:"TP",value:12,value2:98,fill:C.green},{name:"FP",value:2,fill:C.amber},{name:"FN",value:1,fill:C.red},{name:"TN",value:185,fill:C.blue}];
  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
          <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>MODEL COMPARISON RADAR</div>
          <ResponsiveContainer width="100%" height={180}>
            <RadarChart data={metrics}>
              <PolarGrid stroke={C.bg3}/>
              <PolarAngleAxis dataKey="metric" tick={{fill:C.t2,fontSize:7,fontFamily:"'JetBrains Mono',monospace"}}/>
              <Radar name="LSTM-AE" dataKey="A" stroke={C.blue}   fill={C.blue}   fillOpacity={0.15}/>
              <Radar name="IForest" dataKey="B" stroke={C.purple} fill={C.purple} fillOpacity={0.10}/>
              <Radar name="OC-SVM"  dataKey="C" stroke={C.pink}   fill={C.pink}   fillOpacity={0.08}/>
              <Tooltip content={<CTooltip/>}/>
            </RadarChart>
          </ResponsiveContainer>
          <div style={{display:"flex",gap:12,justifyContent:"center"}}>
            {[["LSTM-AE",C.blue],["IForest",C.purple],["OC-SVM",C.pink]].map(([l,c])=>(
              <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:10,height:2,background:c}}/>
                <Mono style={{fontSize:7,color:C.t2}}>{l}</Mono>
              </div>
            ))}
          </div>
        </div>
        <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
          <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>CONFUSION MATRIX (LSTM-AE)</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,maxWidth:180,margin:"0 auto"}}>
            {[
              {label:"True Positive",n:fault?47:12,bg:`${C.green}15`,border:`${C.green}33`,col:C.green},
              {label:"False Positive",n:fault?3:2, bg:`${C.amber}15`,border:`${C.amber}33`,col:C.amber},
              {label:"False Negative",n:fault?5:1, bg:`${C.red}15`,  border:`${C.red}33`,  col:C.red},
              {label:"True Negative", n:fault?145:185,bg:`${C.blue}10`,border:`${C.blue}22`,col:C.blue},
            ].map(c=>(
              <div key={c.label} style={{background:c.bg,border:`1px solid ${c.border}`,
                borderRadius:4,padding:"10px 8px",textAlign:"center"}}>
                <Mono style={{fontSize:20,fontWeight:700,color:c.col,lineHeight:1}}>{c.n}</Mono>
                <Mono style={{fontSize:7,color:C.t3,marginTop:4}}>{c.label}</Mono>
              </div>
            ))}
          </div>
          <div style={{marginTop:12,display:"flex",gap:8,justifyContent:"center"}}>
            <Mono style={{fontSize:8,color:C.t2}}>
              Accuracy: {fault?"96.2":"99.0"}% · F1: {fault?"0.93":"0.96"}
            </Mono>
          </div>
        </div>
      </div>
      <DriftPanel history={Array.from({length:40},(_,i)=>({anom_lstm:Math.random()*0.3,anom_if:Math.random()*0.25,anom_svm:Math.random()*0.2}))}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
const TABS=[
  {id:"overview", label:"Overview",     icon:"◈"},
  {id:"signals",  label:"Signal Analysis", icon:"⌇"},
  {id:"ml",       label:"ML Pipeline",  icon:"◎"},
  {id:"ops",      label:"Maintenance Ops",icon:"⚙"},
];

export default function App(){
  const [tab,setTab]=useState("overview");
  const [machineIdx,setMachineIdx]=useState(0);
  const [running,setRunning]=useState(true);
  const [fault,setFault]=useState(false);
  const [faultIntensity,setFaultIntensity]=useState(0);
  const [tick,setTick]=useState(0);

  const sensRef=useRef(MACHINES.map(m=>makeSensors(m.rpm_nom)));
  const [sensors,setSensors]=useState(sensRef.current[0]);
  const [history,setHistory]=useState(
    Array.from({length:60},(_,i)=>({t:i,temp:72,vib:3.2,pressure:82,rpm:2850,
      current:51,oil_temp:56,health:88,anom_lstm:0.12,anom_if:0.10,anom_svm:0.11}))
  );
  const [fftData,setFftData]=useState(()=>generateFFT(3.2,false,MACHINES[0].fault_freq));
  const [shap,setShap]=useState(()=>shapValues(sensRef.current[0],88));
  const [anomScores,setAnomScores]=useState({lstm:0.12,iforest:0.10,ocsvm:0.11});

  useEffect(()=>{
    if(!running)return;
    const id=setInterval(()=>{
      setTick(t=>t+1);
      setFaultIntensity(fi=>fault?Math.min(fi+0.15,8):Math.max(fi-0.2,0));

      sensRef.current=sensRef.current.map((s,i)=>
        stepSensors(s,fault&&i===machineIdx,fault&&i===machineIdx?faultIntensity:0)
      );
      const cur=sensRef.current[machineIdx];
      setSensors({...cur});

      const h=computeHealth(cur);
      const as=anomalyScores(cur);
      setAnomScores(as);
      setShap(shapValues(cur,h));
      setHistory(prev=>[...prev.slice(-59),{
        t:prev.length,...cur,health:h,
        anom_lstm:as.lstm,anom_if:as.iforest,anom_svm:as.ocsvm
      }]);
      if(tick%3===0) setFftData(generateFFT(cur.vib,fault,MACHINES[machineIdx].fault_freq));
    },800);
    return()=>clearInterval(id);
  },[running,fault,faultIntensity,machineIdx,tick]);

  const machine=MACHINES[machineIdx];
  const health=computeHealth(sensors);
  const rul=computeRUL(health);
  const ensemble=(anomScores.lstm+anomScores.iforest+anomScores.ocsvm)/3;
  const isAnom=ensemble>0.55;
  const statusCol=health>70?C.green:health>45?C.amber:C.red;

  const kpiCards=[
    {label:"EQUIPMENT HEALTH",value:health,unit:"%",sub:"Composite 6-sensor score",color:statusCol,icon:"♡",trend:fault?2.1:-0.3},
    {label:"RUL PREDICTION",value:rul,unit:"days",sub:"Weibull survival model",color:C.amber,icon:"⏱",trend:fault?5.2:-0.8},
    {label:"ENSEMBLE ANOMALY",value:(ensemble*100).toFixed(1),unit:"%",sub:"LSTM·IForest·OCSVM",color:isAnom?C.red:C.green,icon:"⚠",trend:fault?8.5:-1.2},
    {label:"VIBRATION RMS",value:sensors.vib?.toFixed(2),unit:"mm/s",sub:`BPFO: ${machine.fault_freq.bpfo}Hz`,color:C.purple,icon:"⌇"},
    {label:"TEMPERATURE",value:sensors.temp?.toFixed(1),unit:"°C",sub:"Threshold: 85°C · 95°C",color:C.red,icon:"🌡"},
    {label:"COST AT RISK",value:fault?"185":"12",unit:"K USD",sub:fault?"Breakdown likely":"Preventive window",color:fault?C.red:C.green,icon:"$"},
  ];

  return(
    <div style={{background:C.bg0,minHeight:"100vh",color:C.t0,
      fontFamily:"'JetBrains Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Rajdhani:wght@600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px;background:${C.bg1}}
        ::-webkit-scrollbar-thumb{background:${C.bg3};border-radius:2px}
        .tab{cursor:pointer;padding:10px 18px;font-size:10px;letter-spacing:1.5px;
          border-bottom:2px solid transparent;transition:all 0.2s;color:${C.t3};
          display:flex;align-items:center;gap:6px;white-space:nowrap}
        .tab:hover{color:${C.t1}}
        .tab.active{color:${C.cyan};border-bottom-color:${C.cyan}}
        .machine-btn{cursor:pointer;padding:5px 12px;font-size:9px;letter-spacing:1px;
          border-radius:4px;border:1px solid ${C.border};background:${C.bg2};
          color:${C.t2};transition:all 0.2s;font-family:'JetBrains Mono',monospace}
        .machine-btn:hover{border-color:${C.borderHi};color:${C.t1}}
        .machine-btn.active{border-color:${C.cyan};color:${C.cyan};background:${C.bg3}}
        .ctrl-btn{cursor:pointer;padding:7px 14px;font-size:9px;letter-spacing:1.5px;
          border-radius:4px;border:none;font-family:'JetBrains Mono',monospace;transition:all 0.2s}
        .ctrl-btn:hover{filter:brightness(1.15)}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        @keyframes scanline{from{transform:translateY(-100%)}to{transform:translateY(100vh)}}
        .pulse{animation:pulse 1.4s ease-in-out infinite}
        .scanline-effect{position:fixed;top:0;left:0;right:0;height:80px;
          background:linear-gradient(transparent,${C.cyan}05,transparent);
          animation:scanline 6s linear infinite;pointer-events:none;z-index:1000}
      `}</style>

      <div className="scanline-effect"/>

      {/* HEADER */}
      <div style={{background:`linear-gradient(90deg,${C.bg1},${C.bg2})`,
        borderBottom:`1px solid ${C.border}`,padding:"12px 24px",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:38,height:38,background:C.bg3,border:`1.5px solid ${C.cyan}`,
            borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:`0 0 12px ${C.cyan}22`}}>
            <span style={{fontSize:18}}>⚙</span>
          </div>
          <div>
            <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,
              fontWeight:700,color:C.t0,letterSpacing:3}}>
              PREDICTIVE MAINTENANCE INTELLIGENCE
            </div>
            <div style={{fontSize:8,color:C.t3,letterSpacing:2,marginTop:1}}>
              DIGITAL TWIN · FFT ANALYSIS · SHAP EXPLAINABILITY · ENSEMBLE ML · PHYSICS-INFORMED
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{display:"flex",gap:6}}>
            {MACHINES.map((m,i)=>(
              <button key={m.id} className={`machine-btn${i===machineIdx?" active":""}`}
                onClick={()=>{setMachineIdx(i);sensRef.current[i]=sensRef.current[i]||makeSensors(m.rpm_nom)}}>
                {m.id}
              </button>
            ))}
          </div>
          <div style={{width:1,height:28,background:C.border,margin:"0 4px"}}/>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px",
            background:isAnom?`${C.red}10`:`${C.green}08`,
            border:`1px solid ${isAnom?C.red:C.green}33`,borderRadius:4}}>
            <StatusDot active={isAnom||running} color={isAnom?C.red:C.green}/>
            <Mono style={{fontSize:8,color:isAnom?C.red:C.green,letterSpacing:1}}>
              {isAnom?"ANOMALY DETECTED":"NOMINAL"}
            </Mono>
          </div>
          <button className="ctrl-btn" onClick={()=>setRunning(r=>!r)}
            style={{background:running?C.bg3:`${C.green}15`,
              color:running?C.t2:C.green,border:`1px solid ${running?C.border:C.green}33`}}>
            {running?"⏸ PAUSE":"▶ LIVE"}
          </button>
          <button className={`ctrl-btn${fault?" pulse":""}`}
            onClick={()=>setFault(f=>!f)}
            style={{background:fault?`${C.red}20`:C.bg3,
              color:fault?C.red:C.t2,border:`1px solid ${fault?C.red:C.border}44`}}>
            ⚡ {fault?"FAULT ACTIVE":"INJECT FAULT"}
          </button>
        </div>
      </div>

      {/* MACHINE INFO BAR */}
      <div style={{background:C.bg1,borderBottom:`1px solid ${C.border}`,
        padding:"6px 24px",display:"flex",gap:28,alignItems:"center"}}>
        <Mono style={{fontSize:9,color:C.cyan}}>{machine.name}</Mono>
        <Mono style={{fontSize:8,color:C.t3}}>{machine.type}</Mono>
        <Mono style={{fontSize:8,color:C.t3}}>{machine.plant}</Mono>
        <Mono style={{fontSize:8,color:C.t3}}>NOM: {machine.rpm_nom} RPM</Mono>
        <Mono style={{fontSize:8,color:C.t3}}>LIVE: {sensors.rpm?.toFixed(0)} RPM</Mono>
        <div style={{marginLeft:"auto",display:"flex",gap:16}}>
          {[["TEMP",sensors.temp?.toFixed(1),"°C",C.red],["VIB",sensors.vib?.toFixed(2),"mm/s",C.amber],
            ["PRESS",sensors.pressure?.toFixed(1),"bar",C.blue],["AMP",sensors.current?.toFixed(1),"A",C.purple]
          ].map(([l,v,u,c])=>(
            <div key={l} style={{display:"flex",gap:4,alignItems:"baseline"}}>
              <Mono style={{fontSize:7,color:C.t3}}>{l}</Mono>
              <Mono style={{fontSize:9,color:c,fontWeight:700}}>{v}</Mono>
              <Mono style={{fontSize:7,color:C.t3}}>{u}</Mono>
            </div>
          ))}
        </div>
      </div>

      {/* TABS */}
      <div style={{background:C.bg1,borderBottom:`1px solid ${C.border}`,
        display:"flex",padding:"0 24px",overflowX:"auto"}}>
        {TABS.map(t=>(
          <div key={t.id} className={`tab${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>
            <span>{t.icon}</span>{t.label}
          </div>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",padding:"0 8px"}}>
          <Mono style={{fontSize:8,color:C.t3}}>
            {new Date().toLocaleTimeString("id-ID")} · TICK #{tick}
          </Mono>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:16}}>

        {/* KPI CARDS — always visible */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10}}>
          {kpiCards.map((k,i)=><KPICard key={i} {...k}/>)}
        </div>

        {/* TAB: OVERVIEW */}
        {tab==="overview"&&(
          <div style={{display:"grid",gridTemplateColumns:"420px 1fr",gap:16}}>
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <DigitalTwin sensors={sensors} health={health} fault={fault} faultIntensity={faultIntensity}/>
              </div>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>LIVE SENSOR GAUGES</div>
                <div style={{display:"flex",justifyContent:"space-around",flexWrap:"wrap",gap:10}}>
                  <MiniGauge label="TEMP" value={sensors.temp} unit="°C"  pct={clamp((sensors.temp-40)/75,0,1)} color={sensors.temp>85?C.red:sensors.temp>75?C.amber:C.green}/>
                  <MiniGauge label="VIB"  value={sensors.vib}  unit="mm/s" pct={clamp(sensors.vib/14,0,1)} color={sensors.vib>7.5?C.red:sensors.vib>5?C.amber:C.green}/>
                  <MiniGauge label="PRESS" value={sensors.pressure} unit="bar" pct={clamp((sensors.pressure-50)/80,0,1)} color={sensors.pressure>95?C.red:sensors.pressure>85?C.amber:C.green}/>
                  <MiniGauge label="RPM" value={sensors.rpm?.toFixed(0)} unit="rpm" pct={clamp(sensors.rpm/4200,0,1)} color={sensors.rpm>3200?C.red:sensors.rpm>3000?C.amber:C.blue}/>
                  <MiniGauge label="AMP" value={sensors.current} unit="A" pct={clamp((sensors.current-20)/70,0,1)} color={sensors.current>70?C.red:sensors.current>60?C.amber:C.green}/>
                  <MiniGauge label="OIL°C" value={sensors.oil_temp} unit="°C" pct={clamp((sensors.oil_temp-35)/60,0,1)} color={sensors.oil_temp>75?C.red:sensors.oil_temp>65?C.amber:C.cyan}/>
                </div>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {/* Time-series 2x2 grid */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[
                  {key:"temp",    label:"Temperature", unit:"°C",    color:C.red,    domain:[50,115],warn:85,crit:95},
                  {key:"vib",     label:"Vibration",   unit:"mm/s",  color:C.amber,  domain:[0.5,14], warn:7.5,crit:9.5},
                  {key:"pressure",label:"Pressure",    unit:"bar",   color:C.blue,   domain:[50,130],warn:95,crit:110},
                  {key:"health",  label:"Health Score",unit:"%",     color:C.green,  domain:[0,100], warn:65,crit:40},
                ].map(({key,label,unit,color,domain,warn,crit})=>(
                  <div key={key} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                      <Mono style={{fontSize:8,color:C.t2,letterSpacing:2}}>{label}</Mono>
                      <Mono style={{fontSize:10,color,fontWeight:700}}>
                        {(key==="health"?health:sensors[key])?.toFixed?.(1)} {unit}
                      </Mono>
                    </div>
                    <ResponsiveContainer width="100%" height={85}>
                      <AreaChart data={history} margin={{top:2,right:2,bottom:0,left:-20}}>
                        <defs>
                          <linearGradient id={`g${key}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
                            <stop offset="95%" stopColor={color} stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
                        <XAxis dataKey="t" hide/>
                        <YAxis domain={domain} tick={{fill:C.t3,fontSize:7}}/>
                        <Tooltip content={<CTooltip/>}/>
                        <ReferenceLine y={warn} stroke={C.amber} strokeDasharray="3 4" strokeWidth={0.8}/>
                        <ReferenceLine y={crit} stroke={C.red}   strokeDasharray="3 4" strokeWidth={0.8}/>
                        <Area type="monotone" dataKey={key} stroke={color} strokeWidth={1.5}
                          fill={`url(#g${key})`} dot={false} name={label} isAnimationActive={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
              {/* Ensemble + alerts */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px"}}>
                  <EnsemblePanel scores={anomScores} history={history}/>
                </div>
                <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px"}}>
                  <SHAPPanel shap={shap}/>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: SIGNALS */}
        {tab==="signals"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
              <FFTSpectrum fftData={fftData} faultFreqs={machine.fault_freq} fault={fault}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>VIBRATION TIME-DOMAIN WAVEFORM</div>
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart data={history.slice(-30)} margin={{top:4,right:4,bottom:0,left:-15}}>
                    <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
                    <XAxis dataKey="t" hide/>
                    <YAxis tick={{fill:C.t3,fontSize:7}}/>
                    <Tooltip content={<CTooltip/>}/>
                    <ReferenceLine y={7.5} stroke={C.amber} strokeDasharray="3 3"/>
                    <Line type="monotone" dataKey="vib" stroke={C.amber} strokeWidth={1.5}
                      dot={false} name="Vib(mm/s)" isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:8}}>CURRENT + OIL TEMP TREND</div>
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart data={history.slice(-40)} margin={{top:4,right:4,bottom:0,left:-15}}>
                    <CartesianGrid strokeDasharray="2 5" stroke={C.bg3}/>
                    <XAxis dataKey="t" hide/>
                    <YAxis tick={{fill:C.t3,fontSize:7}}/>
                    <Tooltip content={<CTooltip/>}/>
                    <Line type="monotone" dataKey="current"  stroke={C.purple} strokeWidth={1.5} dot={false} name="Current(A)" isAnimationActive={false}/>
                    <Line type="monotone" dataKey="oil_temp" stroke={C.cyan}   strokeWidth={1.5} dot={false} name="OilTemp(°C)" isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
              <EnsemblePanel scores={anomScores} history={history}/>
            </div>
          </div>
        )}

        {/* TAB: ML PIPELINE */}
        {tab==="ml"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <SHAPPanel shap={shap}/>
              </div>
              <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
                <DriftPanel history={history}/>
              </div>
            </div>
            <ModelMetrics health={health} fault={fault}/>
            <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
              <div style={{fontSize:9,color:C.t2,letterSpacing:2,marginBottom:10}}>ML PIPELINE ARCHITECTURE</div>
              <div style={{display:"flex",gap:0,alignItems:"center",overflowX:"auto",padding:"8px 0"}}>
                {[
                  {label:"Apache Kafka",sub:"IoT Stream",icon:"⌇",col:C.amber},
                  {label:"Feature Store",sub:"Feast · Redis",icon:"⊞",col:C.blue},
                  {label:"LSTM-AE",sub:"PyTorch · ONNX",icon:"◎",col:C.cyan},
                  {label:"Isolation Forest",sub:"scikit-learn",icon:"⌂",col:C.purple},
                  {label:"OC-SVM",sub:"RBF Kernel",icon:"⊛",col:C.pink},
                  {label:"Ensemble Vote",sub:"Weighted avg",icon:"⊕",col:C.green},
                  {label:"SHAP Explainer",sub:"TreeSHAP",icon:"⌗",col:C.amber},
                  {label:"MLflow",sub:"Tracking·Registry",icon:"⊞",col:C.blue},
                ].map((s,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center"}}>
                    <div style={{background:C.bg3,border:`1px solid ${s.col}33`,borderRadius:6,
                      padding:"8px 12px",textAlign:"center",minWidth:90}}>
                      <div style={{fontSize:18,marginBottom:4,opacity:0.7}}>{s.icon}</div>
                      <Mono style={{fontSize:8,color:s.col,display:"block"}}>{s.label}</Mono>
                      <Mono style={{fontSize:7,color:C.t3}}>{s.sub}</Mono>
                    </div>
                    {i<7&&<div style={{fontSize:12,color:C.t3,padding:"0 4px",flexShrink:0}}>→</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB: MAINTENANCE OPS */}
        {tab==="ops"&&(
          <MaintenanceOps health={health} rul={rul} fault={fault} sensors={sensors}/>
        )}

        {/* FOOTER */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,
          borderTop:`1px solid ${C.border}`,paddingTop:12}}>
          {[
            {k:"INFERENCE",v:"< 8ms"},
            {k:"STREAM",v:"Kafka 800ms"},
            {k:"MODEL VER",v:"v2.4.1"},
            {k:"RETRAIN",v:"Weekly"},
            {k:"UPTIME",v:"99.87%"},
          ].map(({k,v})=>(
            <div key={k} style={{background:C.bg1,border:`1px solid ${C.bg3}`,borderRadius:4,padding:"7px 10px"}}>
              <Mono style={{fontSize:7,color:C.t3,letterSpacing:2,display:"block"}}>{k}</Mono>
              <Mono style={{fontSize:9,color:C.t2,marginTop:2}}>{v}</Mono>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
