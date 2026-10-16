(() => {
  // ─── 幂等防重与历史资源清理 ───
  if (window.__bctl_message_listener__) {
    try {
      chrome.runtime.onMessage.removeListener(window.__bctl_message_listener__);
    } catch (_) {}
  }
  const oldOverlay = document.getElementById("bctl-agent-overlay-root");
  if (oldOverlay) {
    oldOverlay.remove();
  }

  // --- ChatGPT 官方原生弹簧物理鼠标、Tab 栏光标 Favicon 与后台控制视觉层 ---
  let overlayRoot = null;
  let indicatorPill = null;
  let cursorInstance = null;

  let cursorX = (typeof window.__bctl_cursor_x__ === "number") ? window.__bctl_cursor_x__ : window.innerWidth / 2;
  let cursorY = (typeof window.__bctl_cursor_y__ === "number") ? window.__bctl_cursor_y__ : window.innerHeight / 2;
  let isControlling = false;

  let cursorSeq = 0;
  const cursorArrivalResolvers = new Map();

  // 10 分钟闲置超时兜底（大模型忘记执行 unbind 或意外断开时自动恢复）
  const CONTROL_TIMEOUT_MS = 10 * 60 * 1000;
  let controlTimeoutTimer = null;

  // 1. ChatGPT 官方原版标签页图标光标（在 Chrome 原生 Tab 栏渲染鼠标箭头）
  const CHATGPT_CURSOR_PATH = "M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z";

  // 设置并记录原始 Favicon（借鉴 ChatGPT 官方 TAB_FAVICON_BADGE 机制）
  function applyTabFaviconArrow() {
    try {
      const iconLinks = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'));
      let originalHref = "";
      if (iconLinks.length > 0) {
        originalHref = iconLinks[0].dataset.bctlOriginalHref !== undefined
          ? iconLinks[0].dataset.bctlOriginalHref
          : (iconLinks[0].getAttribute("href") || "");
      }

      const svgIcon = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        ${originalHref ? `<image href="${originalHref}" width="24" height="24" opacity="0.35" x="0" y="8" />` : ''}
        <path d="${CHATGPT_CURSOR_PATH}" fill="#22c55e" stroke="white" stroke-width="1.8" stroke-linejoin="round" transform="translate(1, 1) scale(1.9)" />
      </svg>`;

      const badgedDataUrl = `data:image/svg+xml,${encodeURIComponent(svgIcon.trim())}`;

      if (iconLinks.length > 0) {
        iconLinks.forEach(l => {
          if (l.dataset.bctlOriginalHref === undefined) {
            l.dataset.bctlOriginalHref = l.getAttribute("href") || "";
          }
          l.dataset.bctlFavicon = "true";
          l.href = badgedDataUrl;
          l.type = "image/svg+xml";
        });
      } else {
        const link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        link.href = badgedDataUrl;
        link.dataset.bctlFavicon = "true";
        link.dataset.bctlCreated = "true";
        (document.head || document.documentElement).appendChild(link);
      }
    } catch (e) {
      console.error("[bctl] 设置标签栏光标图标失败:", e);
    }
  }

  // 还原原生 Favicon（借鉴 ChatGPT 官方 Rt() / Pe() 机制）
  function restoreTabFavicon() {
    try {
      const badgedLinks = Array.from(document.querySelectorAll('link[data-bctl-favicon="true"]'));
      badgedLinks.forEach(l => {
        if (l.dataset.bctlCreated === "true") {
          l.remove();
        } else {
          const orig = l.dataset.bctlOriginalHref;
          if (orig) {
            l.href = orig;
          } else {
            l.removeAttribute("href");
          }
          delete l.dataset.bctlOriginalHref;
          delete l.dataset.bctlFavicon;
          delete l.dataset.bctlCreated;
        }
      });
    } catch (e) {
      console.error("[bctl] 还原标签栏图标失败:", e);
    }
  }

  // ─── 2. ChatGPT 官方原生弹簧阻尼物理与贝塞尔曲线规划引擎 ───
  var jn=-44,et=.9,tt=2.2,nt=.12,ot=.7,ge={arcFlow:.5783555327868779,arcSize:.2765523188064277,boundsMargin:20,candidateCount:20,clickAngleDegrees:-44,endpointHandle:.15,startHandle:.41960295031576633};function rt({bounds:e,end:t,start:n}){return lt(st({bounds:e,config:ge,end:t,start:n}),e,ge)}function pe(e,t){const n=p(t,0,1),o=n===1?e.segments.length-1:n*e.segments.length,r=Math.floor(o),i=e.segments[r];if(i==null)throw new Error("Cursor motion path has no segment for progress");const c=e.segments[r-1],a=r===0?e.start:c?.end;if(a==null)throw new Error("Cursor motion path segment is missing its start point");const s=n===1?1:o-r;return{point:gt(a,i,s),tangent:pt(a,i,s)}}function me(e){if(E({x:0,y:0},e)<.001)return Ee(-44);const t=k(e);return Ee(Math.atan2(t.y,t.x)*(180/Math.PI)+90)}function E(e,t){const n=t.x-e.x,o=t.y-e.y;return Math.sqrt(n*n+o*o)}function it(e){return{dampingFraction:et,response:dt(e)}}function p(e,t,n){return Math.max(t,Math.min(n,e))}function st({bounds:e,config:t,end:n,start:o}){const r=ye(t.clickAngleDegrees),i=E(o,n),c={x:n.x-o.x,y:n.y-o.y},a=k(c),s=Math.max(48,Math.min(640,i*t.startHandle,i*.9)),l=Math.max(48,Math.min(640,i*t.endpointHandle,i*.9)),u={x:-r.x,y:-r.y},d=V(e,o,r,s),m=V(e,n,u,l),f={x:-a.y,y:a.x},h=f.x*r.x+f.y*r.y>=0?1:-1,S={x:f.x*h,y:f.y*h},y=mt(o,n),C=V(e,o,r,s*.65),g=V(e,n,u,l*.65),x=k(c),P=Math.max(50,Math.min(520,i*t.arcSize)),A=Math.max(38,Math.min(440,i*t.arcFlow)),L=[.55,.8,1.05],ne=[.65,1,1.35],oe=[he(o,n,d,m),he(o,n,C,g)];for(const re of L)for(const de of ne)at({arcDistanceBase:P,arcDistanceScale:re,arcHandleDistanceBase:A,arcHandleScale:de,arcTangent:x,candidates:oe,end:n,endControl:m,midpoint:y,naturalArcNormal:S,start:o,startControl:d,startControlDistance:s,clickTangent:r});return oe.slice(0,t.candidateCount)}function at({arcDistanceBase:e,arcDistanceScale:t,arcHandleDistanceBase:n,arcHandleScale:o,arcTangent:r,candidates:i,clickTangent:c,end:a,endControl:s,midpoint:l,naturalArcNormal:u,start:d,startControl:m,startControlDistance:f}){fe({arcDistanceBase:e,arcDistanceScale:t,arcHandleDistanceBase:n,arcHandleScale:o,arcNormal:u,arcTangent:r,candidates:i,clickTangent:c,end:a,endControl:s,midpoint:l,start:d,startControl:m,startControlDistance:f}),fe({arcDistanceBase:e,arcDistanceScale:t,arcHandleDistanceBase:n,arcHandleScale:o,arcNormal:{x:-u.x,y:-u.y},arcTangent:r,candidates:i,clickTangent:c,end:a,endControl:s,midpoint:l,start:d,startControl:m,startControlDistance:f})}function fe({arcDistanceBase:e,arcDistanceScale:t,arcHandleDistanceBase:n,arcHandleScale:o,arcNormal:r,arcTangent:i,candidates:c,clickTangent:a,end:s,endControl:l,midpoint:u,start:d,startControl:m,startControlDistance:f}){const h=e*t,S=n*o,y={x:u.x+r.x*h+a.x*f*.16,y:u.y+r.y*h+a.y*f*.16},C={x:y.x-i.x*S,y:y.y-i.y*S},g={x:y.x+i.x*S,y:y.y+i.y*S};c.push(ct({arc:y,arcIn:C,arcOut:g,end:s,endControl:l,start:d,startControl:m}))}function he(e,t,n,o){return{arc:null,arcIn:null,arcOut:null,end:t,endControl:o,segments:[{control1:n,control2:o,end:t}],start:e,startControl:n}}function ct({arc:e,arcIn:t,arcOut:n,end:o,endControl:r,start:i,startControl:c}){return{arc:e,arcIn:t,arcOut:n,end:o,endControl:r,segments:[{control1:c,control2:t,end:e},{control1:n,control2:r,end:o}],start:i,startControl:c}}function lt(e,t,n){const o=e[0];if(o==null)throw new Error("Cursor motion requires at least one candidate");let r=o,i=Number.POSITIVE_INFINITY,c=o,a=Number.POSITIVE_INFINITY;for(const s of e){const l=ve(s,t,n),u=ut(s,l);u<a&&(c=s,a=u),l.staysInBounds&&u<i&&(r=s,i=u)}return i===Number.POSITIVE_INFINITY?c:r}function ve(e,t,n){let o=0,r=0,i=0,c=0,a=null,s=t==null||n==null?!0:xe(e.start,t,n.boundsMargin),l=e.start,u=e.start;for(const d of e.segments){for(let m=1;m<=24;m+=1){const f=m/24,h=Ce(l,d.control1,d.control2,d.end,f);o+=E(u,h),t!=null&&n!=null&&(s=s&&xe(h,t,n.boundsMargin));const S={x:h.x-u.x,y:h.y-u.y};if(E({x:0,y:0},S)>.01){const y=Math.atan2(S.y,S.x);if(a!=null){const C=ft(a,y);r+=C*C,i=Math.max(i,Math.abs(C)),c+=Math.abs(C)}a=y}u=h}l=d.end}return{angleChangeEnergy:r,length:o,maxAngleChange:i,staysInBounds:s,totalTurn:c}}function ut(e,t){const n=Math.max(1,E(e.start,e.end)),o=Math.max(0,t.length/n-1),r=e.arc==null?0:45,i=Se(e);return t.length+o*320+t.angleChangeEnergy*140+t.maxAngleChange*180+t.totalTurn*18+i*90+r}function Se(e){const t=ye(-44),n=k({x:e.end.x-e.start.x,y:e.end.y-e.start.y});return p((-(n.x*t.x+n.y*t.y)-.08)/.92,0,1)}function dt(e){const t=ve(e),n=Math.max(1,E(e.start,e.end)),o=Math.max(0,t.length/n-1),r=p((t.length-180)/760,0,1),i=p(o/.55,0,1),c=p(t.totalTurn/(Math.PI*1.4),0,1),a=p(t.angleChangeEnergy/1.25,0,1),s=p(i*.42+c*.38+a*.2,0,1),l=Se(e),u=e.arc==null?0:.04,d=l*.28,m=e.arc==null?1:.9;return p((.42+r*.22+s*.12+d+u)*ot*m,nt,tt)}function V(e,t,n,o){let r=o;return n.x<0&&(r=Math.min(r,t.x/-n.x)),n.x>0&&(r=Math.min(r,(e.width-t.x)/n.x)),n.y<0&&(r=Math.min(r,t.y/-n.y)),n.y>0&&(r=Math.min(r,(e.height-t.y)/n.y)),{x:t.x+n.x*Math.max(0,r),y:t.y+n.y*Math.max(0,r)}}function ye(e){const t=e*(Math.PI/180);return{x:Math.sin(t),y:-Math.cos(t)}}function gt(e,t,n){return Ce(e,t.control1,t.control2,t.end,n)}function Ce(e,t,n,o,r){const i=1-r,c=i*i*i,a=3*i*i*r,s=3*i*r*r,l=r*r*r;return{x:e.x*c+t.x*a+n.x*s+o.x*l,y:e.y*c+t.y*a+n.y*s+o.y*l}}function pt(e,t,n){const o=1-n;return{x:3*o*o*(t.control1.x-e.x)+6*o*n*(t.control2.x-t.control1.x)+3*n*n*(t.end.x-t.control2.x),y:3*o*o*(t.control1.y-e.y)+6*o*n*(t.control2.y-t.control1.y)+3*n*n*(t.end.y-t.control2.y)}}function mt(e,t){return{x:(e.x+t.x)/2,y:(e.y+t.y)/2}}function k(e){const t=Math.sqrt(e.x*e.x+e.y*e.y);return t<.001?{x:1,y:0}:{x:e.x/t,y:e.y/t}}function xe(e,t,n){return e.x>=n&&e.x<=t.width-n&&e.y>=n&&e.y<=t.height-n}function ft(e,t){let n=t-e;for(;n>Math.PI;)n-=Math.PI*2;for(;n<-Math.PI;)n+=Math.PI*2;return n}function Ee(e){const t=e%360;return t<0?t+360:t}
var se=24,X=se/2,Pt=23,Lt=24,Bt=12,Ut=-2.5,Ft=44,ae="--browser-agent-cursor-glow-color",Gt=`drop-shadow(0 0 6px color-mix(in srgb, var(${ae}) 90%, transparent)) drop-shadow(0 0 15px color-mix(in srgb, var(${ae}) 48%, transparent))`,Ht=5,Vt=.4,kt=0,$t=1.41,Yt=.66,Wt=12.5,qt=.58,Xt=.55,K=1/60,Kt=.85,Le=12,jt=196,zt=70,Zt=.15,Be=0,j=1/240,Jt=1,Ue=.001*60,Qt={dampingFraction:.85,response:.2},en={dampingFraction:.86,response:.42},tn={dampingFraction:.94,response:.19},z={dampingFraction:.9,response:.19},Fe={dampingFraction:.9,response:.12},nn={dampingFraction:.82,response:.055},on={dampingFraction:.86,response:.12};function rn(e,{assetUrl:t,dataTestId:n="browser-agent-cursor",glowColor:o,onArrived:r}){const i=sn(e,t,n,o);let c=null,a=U(),s=null,l=null,u=null,d=null,m=null,f=null,h=!1,S=!1;const y=()=>{u==null||l==null||m===l||(m=l,r?.(u))},C=()=>{c!=null||s==null||S||(c=Mn(g=>{c=null;const x=s;if(x==null)return;const P=h?K:Math.max(K,(g-a)/1e3);h=!1,a=g;const A=pn(x,P,g);Z(i,x),A&&y(),vn(x)&&C()}))};return{destroy:()=>{S=!0,c!=null&&(bn(c),c=null),i.layer.remove()},setState:g=>{const x=g.turnKey??"",P=g.cursor!=null,A=Cn({cursorX:g.cursor?.x,cursorY:g.cursor?.y,viewportHeight:g.viewportSize.height,viewportWidth:g.viewportSize.width}),L=g.isVisible!==!1&&g.cursor?.visible!==!1,ne=g.cursor?.animateMovement!==!1,oe=L&&!P;if(u=g.cursor?.moveSequence??null,l=u==null?null:`${x}:${u}`,s==null&&(s=an(A,L)),s.visibilitySpring.target=L?1:0,oe&&d!==x&&(d=x,v(s.visibilitySpring,1),s.thinkStartedAt=U()),!P){ke(s,A),Z(i,s),C();return}const re=g.cursor?.moveSequence!=null&&L&&s.visibilitySpring.value<=.001&&f!==x;s.thinkStartedAt=null;const de=E(s.point,A);if(!ne||re||de<.5){re&&(f=x,v(s.visibilitySpring,1)),ke(s,A),ne||(s.stretchSpring.force=0,s.stretchSpring.value=1,s.stretchSpring.velocity=0),Z(i,s),y(),C();return}cn(s,A,g.viewportSize),h=!0,Z(i,s),C()}}}function sn(e,t,n,o){const r=document.createElement("div");r.setAttribute("aria-hidden","true"),r.style.inset="0",r.style.overflow="hidden",r.style.pointerEvents="none",r.style.position="absolute",r.style.zIndex="20";const i=document.createElement("div");i.dataset.testid=n,i.style.height=`${se}px`,i.style.left="0",i.style.position="absolute",i.style.top="0",i.style.transformOrigin=`${X}px ${X}px`,i.style.willChange="transform",i.style.width=`${se}px`;const c=document.createElement("div");c.style.transform=`translate3d(${Bt}px, ${Ut}px, 0)`;const a=document.createElement("img");return a.alt="",a.dataset.browserAgentCursorAsset="",a.dataset.testid=`${n}-asset`,a.draggable=!1,a.height=Lt,a.src=t,a.style.display="block",a.style.setProperty(ae,o),a.style.filter=Gt,a.style.transform=`rotate(${Ft}deg) scale(1)`,a.style.transformOrigin="0 0",a.width=Pt,c.appendChild(a),i.appendChild(c),r.appendChild(i),e.appendChild(r),{cursor:i,layer:r}}function an(e,t){const n=t?1:0,o=w(-44);return{motion:null,point:e,positionXSpring:R(e.x,e.x,z),positionYSpring:R(e.y,e.y,z),rotation:o,rotationSpring:R(o,o,Fe),scootAxisRotation:0,scootAxisSpring:R(0,0,Fe),scootRotationSpring:R(0,0,nn),scootStretchSpring:R(1,1,on),stretchSpring:R(1,1,Qt),thinkStartedAt:null,visibilitySpring:R(n,n,en)}}function cn(e,t,n){e.thinkStartedAt=null;const o={x:e.point.x,y:e.point.y};if(E(o,t)<=jt){ln(e,o,t);return}const r=rt({bounds:n,end:t,start:o}),i=it(r);Ge(e,In(i.response),i.dampingFraction),e.motion={mode:"bezier",path:r,progressSpring:R(0,1,i)}}function ln(e,t,n){const o=un(t,n);Ge(e,z.response,z.dampingFraction),e.positionXSpring.target=n.x,e.positionYSpring.target=n.y,N(e.rotationSpring,w(-44)),N(e.scootAxisSpring,o.axisRotation),e.motion={axisRotation:o.axisRotation,end:n,mode:"scoot",progressSpring:R(0,1,tn),rotationTarget:o.rotationTarget,start:t}}function un(e,t){const n=_n({x:t.x-e.x,y:t.y-e.y});return{axisRotation:dn(n),rotationTarget:gn(n)}}function dn(e){return E({x:0,y:0},e)<.001?0:Math.atan2(e.y,e.x)*(180/Math.PI)}function gn(e){return p(e.x*.75+-e.y*.62,-1,1)*zt}function pn(e,t,n){const o=mn(e,t,n);return I(e.visibilitySpring,t),I(e.stretchSpring,t),I(e.scootStretchSpring,t),I(e.scootRotationSpring,t),o}function mn(e,t,n){if(e.motion==null)return e.stretchSpring.target=1,e.scootStretchSpring.target=1,e.scootRotationSpring.target=0,!1;const o=Math.max(0,t);return e.thinkStartedAt=null,e.motion.mode==="scoot"?hn(e,o,n):fn(e,o,n)}function fn(e,t,n){const o=e.motion;if(o?.mode!=="bezier")return!1;e.scootStretchSpring.target=1,e.scootRotationSpring.target=0,I(o.progressSpring,t);const r=p(o.progressSpring.value,0,1),i=pe(o.path,r),c=me(i.tangent);e.positionXSpring.target=i.point.x,e.positionYSpring.target=i.point.y,N(e.rotationSpring,c),N(e.scootAxisSpring,0);const a=He(e,t);if(e.stretchSpring.target=En(a.speed),r>=.999&&Math.abs(o.progressSpring.velocity)<.01&&Ve(e,i.point)){const s=pe(o.path,1),l=me(s.tangent);return ce(e,s.point),v(e.rotationSpring,l),e.rotation=l,v(e.scootAxisSpring,0),e.scootAxisRotation=0,v(e.stretchSpring,1),e.motion=null,e.thinkStartedAt=n,!0}return!1}function hn(e,t,n){const o=e.motion;if(o?.mode!=="scoot")return!1;I(o.progressSpring,t),e.positionXSpring.target=o.end.x,e.positionYSpring.target=o.end.y,N(e.scootAxisSpring,o.axisRotation),N(e.rotationSpring,w(-44));const r=On(He(e,t).point,o.start,o.end),i=Math.sin(Math.min(1,r)*Math.PI);return e.stretchSpring.target=1,e.scootStretchSpring.target=Rn(r),e.scootRotationSpring.target=o.rotationTarget*i,r>=.999&&Math.abs(o.progressSpring.velocity)<.01&&Ve(e,o.end)?(ce(e,o.end),v(e.rotationSpring,w(-44)),e.rotation=e.rotationSpring.value,$e(e),v(e.stretchSpring,1),e.motion=null,e.thinkStartedAt=n,!0):!1}function vn(e){return e.motion!=null||e.thinkStartedAt!=null||!M(e.positionXSpring)||!M(e.positionYSpring)||!M(e.rotationSpring)||!M(e.scootAxisSpring)||!M(e.scootRotationSpring)||!M(e.scootStretchSpring)||!M(e.stretchSpring)||!M(e.visibilitySpring)}function M(e){return e.value===e.target&&We(e)}function Z(e,t){const n=xn(t,U());Sn(e.cursor,{point:t.point,rotation:n,scootAxisRotation:t.scootAxisRotation,scootRotation:t.scootRotationSpring.value,scootStretch:t.scootStretchSpring.value,stretch:t.stretchSpring.value,visibility:t.visibilitySpring.value})}function Sn(e,t){const n=yn(t);e.style.transform=n.transform,e.style.opacity=`${n.opacity}`,e.style.filter=n.filter}function yn({point:e,rotation:t,scootAxisRotation:n,scootRotation:o,scootStretch:r,stretch:i,visibility:c}){const a=p(c,0,1),s=J(Vt,1,a),l=J(Ht,0,a),u=p(r,Be,1),d=[`translate3d(${O(e.x-X)}px, ${O(e.y-X)}px, 0)`];return(Math.abs(Ye(0,n))>.001||Math.abs(u-1)>.001)&&d.push(`rotate(${O(n)}deg)`,`scale(1, ${O(u)})`,`rotate(${O(-n)}deg)`),d.push(`rotate(${O(w(t+o))}deg)`,`scale(${O(i*s)}, ${O(s)})`),{filter:`blur(${O(l)}px)`,opacity:O(a),transform:d.join(" ")}}function Cn({cursorX:e,cursorY:t,viewportHeight:n,viewportWidth:o}){return{x:p(e??Math.round(o*qt),0,o),y:p(t??Math.round(n*Xt),0,n)}}function xn(e,t){if(e.thinkStartedAt==null)return e.rotation;const n=(t-e.thinkStartedAt)/1e3-kt;if(n<0)return e.rotation;const o=Math.min(1,n/$t),r=Math.sin(o*Math.PI),i=Math.sin(n/Yt*Math.PI*2)*r;return o>=1?(e.thinkStartedAt=null,e.rotation):e.rotation+i*Wt}function En(e){return p(1-e/5500,.65,1)}function Rn(e){return J(1,J(1,Be,Math.sin(p(e,0,1)*Math.PI)),Zt)}function In(e){return p(e*.18,.035,.12)}function Ge(e,t,n){e.positionXSpring.response=t,e.positionYSpring.response=t,e.positionXSpring.dampingFraction=n,e.positionYSpring.dampingFraction=n}function He(e,t){const n=e.point;I(e.positionXSpring,t),I(e.positionYSpring,t),I(e.rotationSpring,t),I(e.scootAxisSpring,t);const o={x:e.positionXSpring.value,y:e.positionYSpring.value},r=E(n,o)/Math.max(t,1/240);return e.point=o,e.rotation=e.rotationSpring.value,e.scootAxisRotation=e.scootAxisSpring.value,{point:o,speed:r}}function Ve(e,t){return E(e.point,t)<=Kt&&Math.abs(e.positionXSpring.velocity)<=Le&&Math.abs(e.positionYSpring.velocity)<=Le}function ce(e,t){e.point=t,v(e.positionXSpring,t.x),v(e.positionYSpring,t.y)}function ke(e,t){e.motion=null,ce(e,t),v(e.rotationSpring,w(-44)),e.rotation=e.rotationSpring.value,$e(e),v(e.stretchSpring,1)}function $e(e){v(e.scootAxisSpring,0),v(e.scootRotationSpring,0),v(e.scootStretchSpring,1),e.scootAxisRotation=0}function On(e,t,n){const o={x:n.x-t.x,y:n.y-t.y},r=o.x*o.x+o.y*o.y;return r<.001?1:p(((e.x-t.x)*o.x+(e.y-t.y)*o.y)/r,0,1)}function N(e,t){e.target=e.value+Ye(e.value,t)}function Ye(e,t){let n=t-e;for(;n>180;)n-=360;for(;n<-180;)n+=360;return n}function _n(e){const t=Math.sqrt(e.x*e.x+e.y*e.y);return t<.001?{x:1,y:0}:{x:e.x/t,y:e.y/t}}function R(e,t,n){return{dampingFraction:n.dampingFraction,force:0,response:n.response,simulationTime:0,scriptTime:0,target:t,value:e,velocity:0}}function v(e,t){e.force=0,e.simulationTime=0,e.scriptTime=0,e.target=t,e.value=t,e.velocity=0}function I(e,t){const n=Math.max(.001,e.response),o=1/(2*j**2),r=Math.min((Math.PI*2)**2/n**2,o),i=Math.sqrt(r)*2*e.dampingFraction;for(e.scriptTime+=Math.max(0,t),e.scriptTime-e.simulationTime>Jt&&(e.simulationTime=e.scriptTime-K);e.simulationTime<e.scriptTime;)An(e,r,i),e.simulationTime+=j;We(e)&&(e.value=e.target)}function An(e,t,n){const o=j/2,r=e.velocity+e.force*o;e.value+=r*j,e.force=r*-n+(e.target-e.value)*t,e.velocity=r+e.force*o}function We(e){if(Math.max(e.velocity*e.velocity,e.force*e.force)>Ue*Ue)return!1;const t=e.target*.01,n=e.target-e.value;return t===0||n*n<=t*t}function J(e,t,n){return e+(t-e)*n}function w(e){const t=e%360;return t<0?t+360:t}function O(e){return Math.round(e*1e3)/1e3}function U(){return typeof performance>"u"?Date.now():performance.now()}function Mn(e){return typeof window<"u"&&window.requestAnimationFrame!=null?window.requestAnimationFrame(e):typeof window<"u"?window.setTimeout(()=>e(U()),K*1e3):(e(U()),0)}function bn(e){if(typeof window<"u"&&window.cancelAnimationFrame!=null){window.cancelAnimationFrame(e);return}typeof window<"u"&&window.clearTimeout(e)}var Tn=window.top===window.self,Nn="#339cff";

  const createChatGptCursor = rn;

  // ─── 3. 初始化页面内 Overlay 与光标 ───
  let statusResetTimer = null;

  // 动态更新顶部悬浮胶囊中大模型的实时动作与操作状态
  function setAgentStatus(text, autoResetDelay = 0) {
    ensureOverlay();
    showControlState();
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
    const statusEl = document.getElementById("bctl-status-text");
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.title = text;
    }
    if (autoResetDelay > 0) {
      statusResetTimer = setTimeout(() => {
        if (statusEl && isControlling) {
          statusEl.textContent = "AI Agent 正在控制此标签页";
          statusEl.removeAttribute("title");
        }
      }, autoResetDelay);
    }
  }

  // ─── 3. 初始化页面内 Overlay 与光标 ───
  function ensureOverlay() {
    if (overlayRoot && document.documentElement.contains(overlayRoot)) return;

    overlayRoot = document.createElement("div");
    overlayRoot.id = "bctl-agent-overlay-root";
    overlayRoot.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483646;
      pointer-events: none; overflow: hidden;
    `;

    // 顶部居中 AI 控制状态胶囊指示器（支持实时打印大模型动作）
    indicatorPill = document.createElement("div");
    indicatorPill.id = "bctl-indicator-pill";
    indicatorPill.innerHTML = `
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:8px;box-shadow:0 0 8px #22c55e;animation:bctlPulse 1.8s infinite;flex-shrink:0;"></span>
      <span id="bctl-status-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:380px;display:inline-block;vertical-align:middle;">AI Agent 正在控制此标签页</span>
    `;
    indicatorPill.style.cssText = `
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.90); backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 9999px;
      color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px; font-weight: 500; padding: 6px 16px;
      display: flex; align-items: center; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      opacity: 0; transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 2147483647; pointer-events: none;
    `;

    overlayRoot.appendChild(indicatorPill);
    document.documentElement.appendChild(overlayRoot);

    // 挂载 ChatGPT 官方原生光标
    cursorArrivalResolvers.clear();
    cursorInstance = createChatGptCursor(overlayRoot, {
      assetUrl: chrome.runtime.getURL("images/cursor-chat.png"),
      glowColor: "#22c55e",
      onArrived: (seq) => {
        const resolver = cursorArrivalResolvers.get(seq);
        if (resolver) {
          cursorArrivalResolvers.delete(seq);
          resolver();
        }
      }
    });

    if (!document.getElementById("bctl-style-rules")) {
      const style = document.createElement("style");
      style.id = "bctl-style-rules";
      style.textContent = `
        @keyframes bctlPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.65; }
        }
        @keyframes bctlRipple {
          0% { transform: scale(0.3); opacity: 1; }
          100% { transform: scale(2.6); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  // 隐藏控制状态：平滑淡出胶囊与光标，精准恢复原生 Tab 图标（严格对齐 ChatGPT 官方规范）
  function hideControlState() {
    if (controlTimeoutTimer) {
      clearTimeout(controlTimeoutTimer);
      controlTimeoutTimer = null;
    }
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
    isControlling = false;
    if (indicatorPill) {
      indicatorPill.style.opacity = "0";
      const statusEl = document.getElementById("bctl-status-text");
      if (statusEl) {
        statusEl.textContent = "AI Agent 正在控制此标签页";
        statusEl.removeAttribute("title");
      }
    }
    if (cursorInstance) {
      cursorInstance.setState({
        cursor: { x: cursorX, y: cursorY, visible: false, animateMovement: false },
        isVisible: false,
        viewportSize: { width: window.innerWidth, height: window.innerHeight }
      });
    }
    restoreTabFavicon();
  }

  // 激活控制状态：同时在页面内和原生 Tab 栏亮起光标指示，并挂载 10 分钟闲置兜底保护
  function showControlState() {
    ensureOverlay();
    applyTabFaviconArrow();

    // 10 分钟闲置兜底保护：大模型若超过 10 分钟未继续操作（断流或忘记 unbind），自动安全恢复原生状态
    if (controlTimeoutTimer) {
      clearTimeout(controlTimeoutTimer);
    }
    controlTimeoutTimer = setTimeout(() => {
      hideControlState();
    }, CONTROL_TIMEOUT_MS);

    if (indicatorPill) indicatorPill.style.opacity = "1";

    // 关键优化：如果当前已处于控制态，保持现有光标位置不变，严禁重置至屏幕正中央！
    if (isControlling) {
      return;
    }

    isControlling = true;

    if (cursorInstance) {
      cursorInstance.setState({
        cursor: { x: cursorX, y: cursorY, visible: true, animateMovement: false },
        isVisible: true,
        viewportSize: { width: window.innerWidth, height: window.innerHeight }
      });
    }
  }

  // 借鉴 ChatGPT 人类接管监听：如果人类主动在页面上发生交互（isTrusted 原生鼠标按下），立即解除控制态
  window.addEventListener("mousedown", (e) => {
    if (e.isTrusted && isControlling) {
      hideControlState();
    }
  }, { capture: true, passive: true });

  window.addEventListener("resize", () => {
    if (cursorInstance && isControlling) {
      cursorInstance.setState({
        cursor: { x: cursorX, y: cursorY, visible: true, animateMovement: false },
        isVisible: true,
        viewportSize: { width: window.innerWidth, height: window.innerHeight }
      });
    }
  }, { passive: true });

  // ─── 4. ChatGPT 官方同款平滑移动驱动 (Spring Physics Move) ───
  function springMoveTo(toX, toY) {
    showControlState();

    toX = Math.round(Math.max(10, Math.min(window.innerWidth - 10, toX)));
    toY = Math.round(Math.max(10, Math.min(window.innerHeight - 10, toY)));

    // 关键防死锁：若当前标签页处于后台（document.hidden 为 true），Chrome 会挂起 requestAnimationFrame！
    // 此时跳过视觉插帧动画直接完成，彻底解决后台多标签并发时 25 秒超时的致命 Bug！
    if (document.hidden) {
      cursorX = toX;
      cursorY = toY;
      window.__bctl_cursor_x__ = cursorX;
      window.__bctl_cursor_y__ = cursorY;
      if (cursorInstance) {
        cursorInstance.setState({
          cursor: { x: toX, y: toY, visible: true, animateMovement: false },
          isVisible: true,
          viewportSize: { width: window.innerWidth, height: window.innerHeight }
        });
      }
      return Promise.resolve();
    }

    cursorX = toX;
    cursorY = toY;
    window.__bctl_cursor_x__ = cursorX;
    window.__bctl_cursor_y__ = cursorY;

    const seq = ++cursorSeq;

    return new Promise((resolve) => {
      cursorArrivalResolvers.set(seq, resolve);

      if (cursorInstance) {
        cursorInstance.setState({
          cursor: { x: toX, y: toY, visible: true, animateMovement: true, moveSequence: seq },
          isVisible: true,
          viewportSize: { width: window.innerWidth, height: window.innerHeight }
        });
      } else {
        resolve();
      }

      // 安全兜底计时器：若因视口遮挡或极端微小位移未触发 onArrived，1.5 秒后安全放行
      setTimeout(() => {
        if (cursorArrivalResolvers.has(seq)) {
          cursorArrivalResolvers.delete(seq);
          resolve();
        }
      }, 1500);
    });
  }

  function playRipple(x, y) {
    if (document.hidden) return;
    const ripple = document.createElement("div");
    ripple.style.cssText = `
      position: fixed; left: ${x - 18}px; top: ${y - 18}px; width: 36px; height: 36px;
      border-radius: 50%; border: 2.5px solid #22c55e; background: rgba(34, 197, 94, 0.28);
      z-index: 2147483646; pointer-events: none; animation: bctlRipple 0.42s cubic-bezier(0, 0, 0.2, 1) forwards;
    `;
    document.documentElement.appendChild(ripple);
    setTimeout(() => ripple.remove(), 450);

    const asset = document.querySelector("[data-browser-agent-cursor-asset]");
    if (asset) {
      asset.style.transform = "rotate(44deg) scale(0.82)";
      setTimeout(() => {
        if (asset) asset.style.transform = "rotate(44deg) scale(1)";
      }, 100);
    }
  }

  // ─── 5. React / Vue 受控输入框原生穿透 ───
  async function humanType(el, text) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) nativeSetter.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    let current = "";
    for (const ch of text) {
      current += ch;
      if (nativeSetter) nativeSetter.call(el, current);
      else el.value = current;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      if (!document.hidden) {
        await new Promise((r) => setTimeout(r, 22));
      }
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function moveToElement(el) {
    let rect = el.getBoundingClientRect();
    if (rect.top < 20 || rect.bottom > window.innerHeight - 20 || rect.left < 10 || rect.right > window.innerWidth - 10) {
      el.scrollIntoView({ behavior: document.hidden ? "instant" : "smooth", block: "center", inline: "nearest" });
      await new Promise((r) => setTimeout(r, document.hidden ? 50 : 350));
      rect = el.getBoundingClientRect();
    }
    const targetX = Math.round(rect.left + Math.min(Math.max(rect.width / 2, 4), 80));
    const targetY = Math.round(rect.top + rect.height / 2);
    await springMoveTo(targetX, targetY);
    return { targetX, targetY };
  }

  // --- 视口与数据感知工具函数 ---
  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function canElementScroll(el, dy) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.scrollHeight <= el.clientHeight + 2 || el.clientWidth < 40) return false;
    if (dy > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return false;
    if (dy < 0 && el.scrollTop <= 1) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    return ["auto", "scroll", "overlay"].includes(style.overflowY);
  }

  function getDeepElementsFromPoint(x, y, doc = document) {
    const elements = doc.elementsFromPoint(x, y) || [];
    const result = [];
    for (const el of elements) {
      result.push(el);
      if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === "function") {
        result.push(...getDeepElementsFromPoint(x, y, el.shadowRoot));
      } else if (el.tagName === "IFRAME") {
        try {
          const iDoc = el.contentDocument;
          if (iDoc) {
            const rect = el.getBoundingClientRect();
            const subX = x - rect.left;
            const subY = y - rect.top;
            if (subX >= 0 && subX <= rect.width && subY >= 0 && subY <= rect.height) {
              result.push(...getDeepElementsFromPoint(subX, subY, iDoc));
            }
          }
        } catch (e) {}
      }
    }
    return result;
  }

  function collectScrollContainers() {
    const list = [];
    const visited = new Set();

    function scanDoc(doc, frameInfo, depth) {
      if (!doc) return;
      const win = doc.defaultView || window;
      const root = doc.scrollingElement || doc.documentElement;
      if (!root) return;

      const isRootScrollable = (root.scrollHeight > win.innerHeight + 2) || (root.scrollWidth > win.innerWidth + 2);
      const isTopFrame = !frameInfo;
      const defaultRole = isTopFrame ? "outer" : "modal";

      list.push({
        el: root,
        doc: doc,
        win: win,
        frameInfo: frameInfo,
        depth: depth,
        role: defaultRole,
        tag: root.tagName.toLowerCase(),
        id: root.id || "",
        className: typeof root.className === "string" ? root.className.trim() : "",
        scrollHeight: root.scrollHeight,
        clientHeight: win.innerHeight,
        scrollTop: Math.round(root.scrollTop),
        isRoot: true,
        canScroll: isRootScrollable
      });
      visited.add(root);

      const all = doc.querySelectorAll("div, main, section, article, ul, tbody, form, textarea, pre, .panel-body, .ant-table-body, .ant-modal-wrap, .ant-modal-body, .modal, .modal-body, .CodeMirror-scroll, .table-responsive");
      for (const el of all) {
        if (visited.has(el)) continue;
        const style = win.getComputedStyle(el);
        const hasOverflowY = ["auto", "scroll", "overlay"].includes(style.overflowY);
        const canScrollY = hasOverflowY && el.scrollHeight > el.clientHeight + 2 && el.clientHeight >= 30;

        if (canScrollY) {
          visited.add(el);
          const isModalLike = el.closest?.(".layui-layer, .modal, .ant-modal, .el-dialog, [role=dialog], .drawer, .ant-drawer") ||
                              el.matches?.(".layui-layer, .modal, .ant-modal, .el-dialog, [role=dialog], .ant-modal-wrap, .ant-modal-body, .modal-body") ||
                              frameInfo !== null;
          const isTable = el.closest?.("table, .ant-table, .el-table, .table-responsive") || el.matches?.("tbody, .ant-table-body, .el-table__body-wrapper, .table-responsive");
          const isEditor = el.closest?.(".CodeMirror, .monaco-editor") || el.matches?.(".CodeMirror-scroll, pre, textarea");

          let role = "inner";
          if (isEditor) role = "editor";
          else if (isTable) role = "table";
          else if (isModalLike) role = "modal";

          const rect = el.getBoundingClientRect();
          list.push({
            el: el,
            doc: doc,
            win: win,
            frameInfo: frameInfo,
            depth: depth + (isModalLike ? 2 : 1),
            role: role,
            tag: el.tagName.toLowerCase(),
            id: el.id || "",
            className: typeof el.className === "string" ? el.className.trim() : "",
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollTop: Math.round(el.scrollTop),
            rect: rect,
            isRoot: false,
            canScroll: true
          });
        }
      }

      const iframes = doc.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument;
          if (iDoc) {
            const iRect = iframe.getBoundingClientRect();
            if (iRect.width > 20 && iRect.height > 20) {
              scanDoc(iDoc, {
                id: iframe.id || "",
                className: typeof iframe.className === "string" ? iframe.className : ""
              }, depth + 1);
            }
          }
        } catch (e) {}
      }
    }

    scanDoc(document, null, 0);
    return list;
  }

  function findScrollTarget(act, dy) {
    const containers = collectScrollContainers();
    window._bctlScrollContainers = containers;

    // 1. 显式指定目标：通过 target 别名或 S0, S1 索引
    if (act.target !== undefined && act.target !== null && act.target !== "") {
      const rawTarget = String(act.target).toLowerCase().trim();
      const numMatch = rawTarget.match(/^s?(\d+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10);
        const visibleScrollers = containers.filter(c => {
          const max = Math.max(0, c.scrollHeight - c.clientHeight);
          return max > 0;
        });
        if (visibleScrollers[idx]) return visibleScrollers[idx];
        if (containers[idx]) return containers[idx];
      }

      if (["modal", "dialog", "popup", "layer"].includes(rawTarget)) {
        const modalCandidates = containers.filter(c => c.role === "modal" && c.canScroll);
        if (modalCandidates.length > 0) {
          modalCandidates.sort((a, b) => b.depth - a.depth);
          return modalCandidates[0];
        }
      }

      if (["inner", "table", "editor"].includes(rawTarget)) {
        const innerCandidates = containers.filter(c => ["inner", "table", "editor"].includes(c.role) && c.canScroll);
        if (innerCandidates.length > 0) {
          innerCandidates.sort((a, b) => b.depth - a.depth);
          return innerCandidates[0];
        }
      }

      if (["outer", "page", "root", "window"].includes(rawTarget)) {
        const outer = containers.find(c => c.role === "outer");
        if (outer) return outer;
      }
    }

    // 2. 显式 CSS 选择器查找
    if (act.selector) {
      try {
        let el = document.querySelector(act.selector);
        if (!el) {
          for (const c of containers) {
            if (c.doc && c.doc !== document) {
              el = c.doc.querySelector(act.selector);
              if (el) break;
            }
          }
        }
        if (el) {
          const match = containers.find(c => c.el === el);
          if (match) return match;
          return { el, doc: el.ownerDocument, win: el.ownerDocument?.defaultView || window, role: "custom" };
        }
      } catch (e) {}
    }

    // 3. 关联元素 ID (从 look 中感知的数字编号)
    if (act.id !== undefined && window._bctlElements && window._bctlElements[act.id]) {
      let cur = window._bctlElements[act.id];
      while (cur && cur !== document.documentElement && cur !== document.body) {
        const match = containers.find(c => c.el === cur);
        if (match) return match;
        cur = cur.parentElement;
      }
    }

    // 4. 坐标命中（支持深度穿透同源 iframe）
    if (typeof act.x === "number" && typeof act.y === "number") {
      const hitElements = getDeepElementsFromPoint(act.x, act.y);
      for (const cur of hitElements) {
        let p = cur;
        while (p && p !== document.body && p !== document.documentElement) {
          const match = containers.find(c => c.el === p);
          if (match && match.canScroll) return match;
          p = p.parentElement || (p.getRootNode && p.getRootNode().host);
        }
      }
    }

    // 5. 智能防抢占首选：若页面上有处于打开状态的可见弹窗，优先滚动弹窗！
    const activeModal = containers.filter(c => c.role === "modal" && c.canScroll);
    if (activeModal.length > 0) {
      activeModal.sort((a, b) => b.depth - a.depth);
      return activeModal[0];
    }

    // 6. 屏幕中心点拾取
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);
    const centerHits = getDeepElementsFromPoint(cx, cy);
    for (const cur of centerHits) {
      let p = cur;
      while (p && p !== document.body && p !== document.documentElement) {
        const match = containers.find(c => c.el === p);
        if (match && match.canScroll) return match;
        p = p.parentElement || (p.getRootNode && p.getRootNode().host);
      }
    }

    // 兜底外层根滚动条
    return containers.find(c => c.role === "outer") || containers[0];
  }

  function extractVisibleDashboardData() {
    const lines = [];

    // A. 抓取当前视口可见的表格行 (兼容 AntD Table / 原生 Table / 常见前端虚拟表格)
    const rows = document.querySelectorAll("tr, .ant-table-row, [role='row']");
    for (const row of rows) {
      if (!isInViewport(row)) continue;
      const cells = Array.from(row.querySelectorAll("th, td, .ant-table-cell, [role='cell'], [role='columnheader']"))
        .map(c => (c.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        lines.push(`[表格行] ${cells.join(" | ")}`);
      }
      if (lines.length >= 35) break;
    }

    // B. 抓取大盘面板标题与统计卡片数值 (兼容 Nightingale / AntD Statistic / 常见图表卡片)
    const panels = document.querySelectorAll(
      ".n9e-dashboard-panel-header, .n9e-dashboard-panel-title, .ant-statistic, .ant-card-head-title, .panel-title, .chart-title"
    );
    for (const panel of panels) {
      if (!isInViewport(panel)) continue;
      const text = (panel.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length < 120) {
        lines.push(`[面板指标] ${text}`);
      }
      if (lines.length >= 50) break;
    }

    // C. 抓取代码/Token/敏感凭据展示块
    const tokens = document.querySelectorAll("code, clipboard-copy, .token, [data-copy-text], #new-oauth-token");
    for (const t of tokens) {
      if (!isInViewport(t)) continue;
      const val = t.getAttribute("value") || t.getAttribute("data-copy-text") || t.innerText;
      if (val && val.trim().length >= 8) {
        lines.push(`[凭据/Token] ${val.trim()}`);
      }
    }

    return lines.length > 0
      ? "\n--- 当前视口可见数据摘要 ---\n" + lines.join("\n")
      : "";
  }

  function getElementDesc(el) {
    if (!el) return "";
    const raw = el.innerText || el.placeholder || el.value || el.getAttribute("aria-label") || el.title || el.getAttribute("name") || "";
    const clean = raw.replace(/\s+/g, " ").trim();
    if (clean) {
      return clean.length > 16 ? clean.slice(0, 16) + "..." : clean;
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : "元素";
    const type = el.getAttribute && el.getAttribute("type") ? `:${el.getAttribute("type")}` : "";
    return `<${tag}${type}>`;
  }

  // 扫描页面并感知可交互元素（静默感知，不再在页面上渲染打扰视觉的数字角标）
  function scanElements() {
    document.querySelectorAll(".bctl-badge-overlay").forEach(b => b.remove());
    const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]';
    const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && isInViewport(el);
    });

    window._bctlElements = elements;
    const lines = [`当前页面: ${document.title} (${location.href})`];

    elements.slice(0, 100).forEach((el, i) => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") ? `:${el.getAttribute("type")}` : "";
      const label = (el.innerText || el.placeholder || el.value || el.getAttribute("aria-label") || el.title || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      lines.push(`[${i}] <${tag}${type}> ${label}`);
    });

    const dataSummary = extractVisibleDashboardData();
    if (dataSummary) lines.push(dataSummary);

    // 感知页面多级滚动容器（内外滚动条、弹窗、表格、代码块）
    const containers = collectScrollContainers();
    window._bctlScrollContainers = containers;
    const scrollableOnes = containers.filter(c => {
      const max = Math.max(0, c.scrollHeight - c.clientHeight);
      return max > 0;
    });
    if (scrollableOnes.length > 0) {
      lines.push("\n--- 可滚动容器 (Scroll Containers) ---");
      scrollableOnes.forEach((sc, i) => {
        const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
        const pct = max > 0 ? Math.min(100, Math.round((sc.scrollTop / max) * 100)) : 0;
        const tag = sc.tag;
        const cls = sc.className ? "." + sc.className.split(/\s+/)[0] : "";
        const frameDesc = sc.frameInfo ? ` [frame: ${sc.frameInfo.id || "iframe"}]` : "";
        const activeMark = (sc.role === "modal" && sc.canScroll) ? " [当前顶层激活]" : "";
        lines.push(`[S${i}] <${tag}${cls}:${sc.role}>${frameDesc} (位置: ${sc.scrollTop}/${max}px, ${pct}%)${activeMark}`);
      });
    }

    return lines.join("\n");
  }

  // ─── 6. 监听来自 Background 的请求 ───
  const messageListener = (req, sender, sendResponse) => {
    // 关键防死锁：优先同步响应 ping 请求！
    if (req.action === "ping") {
      sendResponse({ ok: true, pong: true });
      return false;
    }

    // 主动解除或隐藏控制态
    if (req.action === "hide_control_state" || req.action === "release") {
      hideControlState();
      sendResponse({ ok: true });
      return false;
    }

    (async () => {
      try {
        if (req.action === "show_control_state") {
          showControlState();
          if (req.payload?.text) {
            setAgentStatus(req.payload.text, req.payload.autoResetDelay || 0);
          }
          sendResponse({ ok: true });
        } else if (req.action === "set_status") {
          setAgentStatus(req.payload?.text || "AI Agent 正在控制此标签页", req.payload?.autoResetDelay || 0);
          sendResponse({ ok: true });
        } else if (req.action === "look") {
          setAgentStatus("正在感知页面元素...");
          const res = scanElements();
          const count = window._bctlElements ? window._bctlElements.length : 0;
          setAgentStatus(`已感知 ${count} 个页面元素`, 2500);
          sendResponse(res);
        } else if (req.action === "act") {
          showControlState();
          const actions = req.payload.actions || [];
          const logs = [];

          for (const act of actions) {
            const { type, id, text, key, direction, x, y } = act;
            const targetEl = (id !== undefined && window._bctlElements) ? window._bctlElements[id] : null;
            const elDesc = getElementDesc(targetEl);

            if (act.desc || act.status) {
              setAgentStatus(act.desc || act.status);
            }

            if (type === "click") {
              let targetX, targetY;
              if (typeof x === "number" && typeof y === "number") {
                targetX = x;
                targetY = y;
                if (!act.desc && !act.status) setAgentStatus(`正在点击 (${targetX}, ${targetY})`);
                await springMoveTo(targetX, targetY);
              } else {
                if (!targetEl) { logs.push(`未找到元素 [${id}]`); continue; }
                if (!act.desc && !act.status) setAgentStatus(elDesc ? `正在点击 "${elDesc}"` : `正在点击元素 [${id}]`);
                const pos = await moveToElement(targetEl);
                targetX = pos.targetX;
                targetY = pos.targetY;
                targetEl.focus();
              }
              playRipple(targetX, targetY);
              const clickTarget = document.elementFromPoint(targetX, targetY) || (id !== undefined ? window._bctlElements?.[id] : null);
              if (clickTarget) {
                clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: targetX, clientY: targetY }));
                clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: targetX, clientY: targetY }));
                clickTarget.click?.();
              }
              logs.push(`点击 ${id !== undefined ? `[${id}]` : `(${targetX}, ${targetY})`}`);
            } else if (type === "move") {
              let targetX, targetY;
              if (typeof x === "number" && typeof y === "number") {
                targetX = x;
                targetY = y;
                if (!act.desc && !act.status) setAgentStatus(`正在移向 (${targetX}, ${targetY})`);
                await springMoveTo(targetX, targetY);
              } else {
                if (!targetEl) { logs.push(`未找到元素 [${id}]`); continue; }
                if (!act.desc && !act.status) setAgentStatus(elDesc ? `正在移向 "${elDesc}"` : `正在移向元素 [${id}]`);
                const pos = await moveToElement(targetEl);
                targetX = pos.targetX;
                targetY = pos.targetY;
              }
              logs.push(`光标移至 ${id !== undefined ? `[${id}]` : `(${targetX}, ${targetY})`}`);
            } else if (type === "type") {
              if (!targetEl) { logs.push(`未找到输入框 [${id}]`); continue; }
              const displayTxt = (text || "").length > 14 ? (text || "").slice(0, 14) + "..." : (text || "");
              if (!act.desc && !act.status) setAgentStatus(elDesc ? `正在向 "${elDesc}" 输入: ${displayTxt}` : `正在输入: ${displayTxt}`);
              const { targetX, targetY } = await moveToElement(targetEl);
              playRipple(targetX, targetY);
              await humanType(targetEl, text || "");
              logs.push(`在 [${id}] 输入 "${text}"`);
            } else if (type === "press") {
              const k = key || "Enter";
              if (!act.desc && !act.status) setAgentStatus(`正在按键: ${k}`);
              const active = document.activeElement || document.body;
              active.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true }));
              active.dispatchEvent(new KeyboardEvent("keyup", { key: k, code: k, bubbles: true }));
              if (k === "Enter" && active.form) active.form.requestSubmit?.();
              logs.push(`按键 ${k}`);
            } else if (type === "scroll") {
              let dy = 500;
              if (typeof act.deltaY === "number" && !Number.isNaN(act.deltaY)) {
                dy = act.deltaY;
              } else if (direction === "up" || act.direction === "up") {
                dy = -500;
              } else if (direction === "down" || act.direction === "down") {
                dy = 500;
              }

              const dirLabel = dy >= 0 ? "向下" : "向上";
              if (!act.desc && !act.status) setAgentStatus(`正在${dirLabel}滚动页面...`);

              const targetInfo = findScrollTarget(act, dy);
              const target = targetInfo.el;
              const beforeTop = target.scrollTop;

              // 1. 强制使用 instant 同步滚动，消除 smooth 动画导致的后续 look 读取竞态
              target.scrollBy({ top: dy, behavior: "instant" });
              const actualMoved = Math.round(target.scrollTop - beforeTop);

              // 2. 若原生 scrollTop 未发生改变（如纯虚拟列表 rc-virtual-list 或已触底），补发可取消的 WheelEvent
              if (Math.abs(actualMoved) < 1) {
                const doc = targetInfo.doc || target.ownerDocument || document;
                const win = targetInfo.win || doc.defaultView || window;
                const px = typeof act.x === "number" ? act.x : Math.round(win.innerWidth / 2);
                const py = typeof act.y === "number" ? act.y : Math.round(win.innerHeight / 2);
                const wheelTarget = doc.elementFromPoint(px, py) || target;
                wheelTarget.dispatchEvent(
                  new win.WheelEvent("wheel", {
                    deltaY: dy,
                    clientX: px,
                    clientY: py,
                    deltaMode: 0,
                    bubbles: true,
                    cancelable: true
                  })
                );
              } else {
                target.dispatchEvent(new Event("scroll", { bubbles: true }));
              }

              // 3. 等待 120ms 让 React / AntD Table / ECharts 完成虚拟 DOM 渲染
              await new Promise(resolve => setTimeout(resolve, 120));

              // 4. 生成面向大模型防死循环的闭环状态回显
              const maxScroll = Math.max(0, target.scrollHeight - (target.clientHeight || targetInfo.clientHeight || 0));
              const currentTop = Math.round(target.scrollTop);
              const roleDesc = targetInfo.role ? `[${targetInfo.role}]` : "";
              const frameDesc = targetInfo.frameInfo ? ` (frame: ${targetInfo.frameInfo.id || "iframe"})` : "";
              const tagDesc = `${target.tagName.toLowerCase()}${target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\s+/)[0] : ""}`;

              if (Math.abs(actualMoved) >= 1) {
                const progress = maxScroll > 0 ? Math.min(100, Math.round((currentTop / maxScroll) * 100)) : 100;
                logs.push(
                  `[Scroll 成功] ${roleDesc} 容器(${tagDesc}${frameDesc}) ${dirLabel}实际滚动 ${Math.abs(actualMoved)}px | 当前位置: ${currentTop}/${maxScroll}px (${progress}%)`
                );
              } else {
                logs.push(
                  `[Scroll 边界提示] ${roleDesc} 容器(${tagDesc}${frameDesc})未发生物理位移(当前位置: ${currentTop}/${maxScroll}px)，已到达${dy >= 0 ? "底部" : "顶部"}或该区域为固定视图。`
                );
              }
            } else if (type === "wait") {
              if (!act.desc && !act.status) setAgentStatus("正在等待页面响应...");
              await new Promise(r => setTimeout(r, 1000));
            }
            await new Promise(r => setTimeout(r, 250));
          }

          setAgentStatus("操作执行完成", 2500);
          await new Promise(r => setTimeout(r, 300));
          if (controlTimeoutTimer) clearTimeout(controlTimeoutTimer);
          controlTimeoutTimer = setTimeout(() => hideControlState(), CONTROL_TIMEOUT_MS);
          sendResponse(`执行结果: ${logs.join(" -> ")}\n\n${scanElements()}`);
        }
      } catch (err) {
        sendResponse(`执行出错: ${err.message}`);
      }
    })();
    return true;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  window.__bctl_message_listener__ = messageListener;
})();
