const crypto=require('crypto');
module.exports=function(io){
 const ns=io.of('/bingo'), rooms=new Map();
 const rnd=(a,b)=>crypto.randomInt(a,b+1), token=()=>crypto.randomBytes(24).toString('hex');
 const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){let j=rnd(0,i);[a[i],a[j]]=[a[j],a[i]]}return a};
 const gcd=(a,b)=>b?gcd(b,a%b):Math.abs(a);
 const frac=(a,b)=>{let g=gcd(a,b);return b/g===1?String(a/g):a/g+'/'+b/g};
 const s=x=>x<0?'('+x+')':String(x);
 const generators={
 enteros:l=>{let a=rnd(-15*l,15*l),b=rnd(-15*l,15*l),p=rnd(0,1);return [s(a)+(p?' + ':' − ')+s(b),p?a+b:a-b]},
 combinadas:l=>{let a=rnd(-10*l,10*l),b=rnd(-8*l,8*l),c=rnd(2,5+l);return l===1?[s(a)+' + '+s(b)+' × '+c,a+b*c]:['('+s(a)+' − '+s(b)+') × '+c,(a-b)*c]},
 fracciones:l=>{let a=rnd(1,5*l),b=rnd(2,5+l),c=rnd(1,5*l),d=l===1?b:rnd(2,5+l);return [a+'/'+b+' + '+c+'/'+d,frac(a*d+c*b,b*d)]},
 productos:l=>{let a=rnd(1,10*l),b=rnd(2,9),p=rnd(0,1);return p?[a+' × '+b,a*b]:[a*b+' ÷ '+b,a]},
 potencias:l=>{let a=rnd(1,12*l),b=rnd(2,3);return [a+(b===2?'²':'³'),a**b]},
 ecuaciones:l=>{let a=rnd(2,8),x=rnd(-20*l,20*l),b=rnd(-10,10);return [a+'x '+(b<0?'− ':'+ ')+Math.abs(b)+' = '+(a*x+b),x]}
 };
 function pool(topics,l,n){let m=new Map();for(let i=0;i<12000&&m.size<Math.max(36,n*n+12);i++){let [q,a]=generators[topics[rnd(0,topics.length-1)]](l);a=String(a);if(!m.has(a))m.set(a,{q,a})}if(m.size<n*n)throw Error('No hay suficientes resultados');return shuffle([...m.values()])}
 function card(r){return shuffle(r.pool).slice(0,r.n*r.n).map(x=>x.a)}
 function send(r){r.touched=Date.now();let base={code:r.code,round:r.round,n:r.n,count:r.drawn.length,total:r.pool.length,operation:r.drawn.at(-1)?.q||'',players:r.players.size,topics:r.topics};for(let [id,p] of r.players){if(p.sid)ns.to(p.sid).emit('state',{...base,role:'player',card:p.card,marked:[...p.marked],id:p.id})}if(r.sid)ns.to(r.sid).emit('state',{...base,role:'host',history:r.drawn,claims:r.claims,roster:[...r.players.values()].map(p=>({id:p.id,name:p.name,connected:!!p.sid}))})}
 function settings(d){let topics=Array.isArray(d.topics)?[...new Set(d.topics.filter(x=>Object.hasOwn(generators,x)))]:[];if(!topics.length)throw Error('Elige una temática');let l=[1,2,3].includes(d.level)?d.level:2,n=[3,4,5].includes(d.n)?d.n:3;return {topics,l,n,pool:pool(topics,l,n)}}
 ns.on('connection',socket=>{
 function bind(r,key,host){socket.data={code:r.code,key,host};if(host)r.sid=socket.id;else r.players.get(key).sid=socket.id}
 function auth(){let r=rooms.get(socket.data.code);if(!r)throw Error('Sala no disponible');if(socket.data.host?r.sid!==socket.id:r.players.get(socket.data.key)?.sid!==socket.id)throw Error('Sesión reemplazada');return r}
 function on(name,fn){socket.on(name,(d,cb)=>{if(typeof cb!=='function')return;try{cb({ok:true,...fn(d&&typeof d==='object'?d:{})})}catch(e){cb({ok:false,error:e.message})}})}
 on('create',d=>{if(rooms.size>=100)throw Error('Servidor ocupado');let code;do{code=String(rnd(100000,999999))}while(rooms.has(code));let key=token(),r={...settings(d),code,key,players:new Map(),drawn:[],claims:[],round:1,seq:0};rooms.set(code,r);bind(r,key,true);send(r);return {code,key}})
 on('join',d=>{let r=rooms.get(String(d.code));if(!r)throw Error('Código incorrecto');if(r.drawn.length)throw Error('Espera a la siguiente ronda');if(r.players.size>=60)throw Error('Sala completa');let name=String(d.name||'').trim().slice(0,25);if(!name)throw Error('Introduce un alias');let key=token();r.players.set(key,{name,id:++r.seq,card:card(r),marked:new Set()});bind(r,key,false);send(r);return {code:r.code,key}})
 on('resume',d=>{let r=rooms.get(String(d.code));if(!r||!(r.key===d.key||r.players.has(d.key)))throw Error('Sesión caducada');bind(r,d.key,r.key===d.key);send(r);return {code:r.code,key:d.key}})
 on('draw',()=>{let r=auth();if(!socket.data.host)throw Error('Solo el profesor');if(r.drawn.length>=r.pool.length)throw Error('No quedan bolas');r.drawn.push(r.pool[r.drawn.length]);send(r);return {}})
 on('reset',d=>{let r=auth();if(!socket.data.host)throw Error('Solo el profesor');Object.assign(r,settings(d));r.round++;r.drawn=[];r.claims=[];for(let p of r.players.values()){p.card=card(r);p.marked.clear()}send(r);return {}})
 on('mark',d=>{let r=auth();if(socket.data.host)throw Error('No tienes cartón');let p=r.players.get(socket.data.key);if(d.round!==r.round||!Number.isInteger(d.i)||d.i<0||d.i>=p.card.length)throw Error('Casilla inválida');p.marked.has(d.i)?p.marked.delete(d.i):p.marked.add(d.i);send(r);return {}})
 on('claim',d=>{let r=auth();if(socket.data.host||!['linea','bingo'].includes(d.type)||d.round!==r.round)throw Error('Solicitud inválida');let p=r.players.get(socket.data.key),seen=new Set(r.drawn.map(x=>x.a)),valid=p.card.map((a,i)=>p.marked.has(i)&&seen.has(a)),ok=d.type==='bingo'?valid.every(Boolean):Array.from({length:r.n},(_,i)=>valid.slice(i*r.n,(i+1)*r.n).every(Boolean)).some(Boolean);if(r.claims.length>=150)r.claims.shift();r.claims.push({name:p.name,id:p.id,type:d.type,ok,card:[...p.card],marked:[...p.marked],valid});send(r);return {valid:ok}})
 socket.on('disconnect',()=>{let r=rooms.get(socket.data.code);if(!r)return;if(r.sid===socket.id)r.sid=null;let p=r.players.get(socket.data.key);if(p?.sid===socket.id)p.sid=null;send(r)})
 });
 setInterval(()=>{for(let [k,r] of rooms)if(Date.now()-r.touched>6*3600000)rooms.delete(k)},60000).unref();
};