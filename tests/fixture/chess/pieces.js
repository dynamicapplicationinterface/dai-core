/** Original SVG pieces. Geometry is static; no text or database value becomes markup. */
const NS='http://www.w3.org/2000/svg';
function node(tag,attributes){const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attributes))n.setAttribute(k,String(v));return n;}
const bodies={
 p:'M24 34Q20 42 19 48H45Q44 42 40 34Q47 28 43 20Q39 12 32 12Q25 12 21 20Q17 28 24 34Z',
 r:'M18 14H25V21H29V14H35V21H39V14H46V29L41 33L43 48H21L23 33L18 29Z',
 n:'M21 47Q23 36 35 30L25 33L17 28L23 19L28 17L29 8L36 13L42 11Q52 26 44 47Z',
 b:'M22 46L26 34Q15 29 23 18L32 8L41 18Q49 29 38 34L42 46Z',
 q:'M20 43L15 21L26 28L32 14L38 28L49 21L44 43Z',
 k:'M21 46L23 36Q16 33 18 26Q20 20 27 23L28 19H36L37 23Q44 20 46 26Q48 33 41 36L43 46Z'
};
export function pieceSVG(type,color){
 const svg=node('svg',{viewBox:'0 0 64 64',class:'piece '+(color==='w'?'piece-white':'piece-black'),'aria-hidden':'true',focusable:'false'});
 const fill=color==='w'?'#fff6e9':'#20172d',edge=color==='w'?'#4b325e':'#cab3e0',ink=color==='w'?'#432653':'#fff0e0';
 const group=node('g',{fill,stroke:edge,'stroke-width':2.2,'stroke-linejoin':'round','stroke-linecap':'round'});
 group.append(node('path',{d:bodies[type]||bodies.p}));
 if(type==='k'){group.append(node('path',{d:'M32 7V20M26 12H38',fill:'none','stroke-width':5}));}
 if(type==='q')for(const [cx,cy]of [[15,18],[32,11],[49,18]])group.append(node('circle',{cx,cy,r:3.7}));
 if(type==='b')group.append(node('path',{d:'M34 16L28 25',fill:'none',stroke:edge,'stroke-width':3}));
 group.append(node('path',{d:'M20 47Q32 44 44 47L47 53Q47 56 44 56H20Q17 56 17 53Z'}));
 svg.append(group);
 const face=node('g',{fill:ink,stroke:'none'});
 if(type==='n'){face.append(node('circle',{cx:37,cy:22,r:2.1}));face.append(node('path',{d:'M21 26L25 27',fill:'none',stroke:ink,'stroke-width':1.8,'stroke-linecap':'round'}));}
 else if(type==='p')for(const cx of [28,36])face.append(node('circle',{cx,cy:25,r:1.7}));
 else if(type==='r')for(const cx of [28,36])face.append(node('rect',{x:cx-1.3,y:32,width:2.6,height:4,rx:1.3}));
 else if(type==='q'||type==='k')for(const cx of [28,36])face.append(node('circle',{cx,cy:type==='q'?35:31,r:1.5}));
 svg.append(face);return svg;
}
const icons={
 lock:'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
 unlock:'M6 11h12v10H6z M8 11V7a4 4 0 0 1 7.7-1.5',
 share:'M12 16V3 M7 8l5-5 5 5 M5 13v7h14v-7',
 replay:'M4 9a8 8 0 1 1 0 7 M4 3v6h6',
 plus:'M12 5v14 M5 12h14',
 settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
 board:'M4 4h16v16H4z M4 12h16 M12 4v16',
 games:'M7 3H3v18h14v-4 M7 3h14v14H7z M10 7h8 M10 11h8',
 arrow:'M5 12h14 M14 7l5 5-5 5',
 back:'M19 12H5 M10 7l-5 5 5 5',
 check:'M5 12l4 4L19 6',
 close:'M6 6l12 12 M18 6L6 18',
 flag:'M5 21V3 M5 4c5-4 8 4 14 0v10c-6 4-9-4-14 0',
 moon:'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10',
 sun:'M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 monitor:'M3 4h18v13H3z M8 21h8 M12 17v4',
 chevron:'M9 5l7 7-7 7'
};
export function icon(name){const s=node('svg',{viewBox:'0 0 24 24',class:'icon',fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'});s.append(node('path',{d:icons[name]||icons.board}));return s;}
