import { SlidingWindowRateLimiter } from './security.mjs';

const commandName = /^[a-z][a-z0-9_-]{0,30}$/;
const commandPrefix = command => command.endsWith('_*') ? command.slice(0,-1) : null;
function commandsOverlap(first,second) {
  const a=commandPrefix(first),b=commandPrefix(second);
  if(a&&b)return a.startsWith(b)||b.startsWith(a);
  if(a)return second.length>a.length&&second.startsWith(a);
  if(b)return first.length>b.length&&first.startsWith(b);
  return first===second;
}

export function createWidgetApi({ configuration = '[]', verifyAdmission, getRoom, readJsonBody, json }) {
  const registry = JSON.parse(configuration);
  if (!Array.isArray(registry) || registry.length > 8) throw new Error('NINJITSI_WIDGETS must be an array of at most eight widgets');
  const ids = new Set(), commands = new Set();
  const widgets = registry.map(value => {
    if (!value || typeof value.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.id) || ids.has(value.id) ||
        typeof value.title !== 'string' || !value.title.trim() || value.title.length > 60 ||
        !Array.isArray(value.commands) || !value.commands.length || value.commands.length > 8 ||
        !value.commands.every(command => typeof command === 'string' && commandName.test(command)) ||
        typeof value.token !== 'string' || value.token.length < 32) throw new Error('Invalid widget registration');
    const url = new URL(value.url), serviceUrl = new URL(value.serviceUrl);
    for (const parsed of [url, serviceUrl]) {
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('Widget URLs must be HTTP(S) without credentials, queries or fragments');
    }
    const commandActions=value.commandActions??{};
    if(!commandActions||typeof commandActions!=='object'||Array.isArray(commandActions)||Object.keys(commandActions).length>16||
      Object.entries(commandActions).some(([command,action])=>!commandName.test(commandPrefix(command)??command)||typeof action!=='string'||!/^[-\w]{1,40}$/.test(action)))throw new Error('Invalid widget command actions');
    for(const command of [...value.commands,...Object.keys(commandActions)]){
      if([...commands].some(existing=>commandsOverlap(existing,command)))throw new Error('Overlapping widget commands');
      commands.add(command);
    }
    ids.add(value.id);
    return { ...value,commandActions, url:url.href, serviceUrl:serviceUrl.href.replace(/\/$/, '') };
  });
  const limiter = new SlidingWindowRateLimiter({ limit:1200, windowMs:60_000 });
  const mutations = new SlidingWindowRateLimiter({ limit:20, windowMs:60_000 });
  async function call(widget, room, action, body, after) {
    const url = `${widget.serviceUrl}/v1/rooms/${room}/${action}${after === undefined ? '' : `?after=${after}`}`;
    const response = await fetch(url, {method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{Authorization:`Bearer ${widget.token}`,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    let text='',length=0;const decoder=new TextDecoder();
    for await (const chunk of response.body) {
      length+=chunk.byteLength;
      if(length>512_000)throw new Error('Widget response too large');
      text+=decoder.decode(chunk,{stream:true});
    }
    text+=decoder.decode();
    const result=JSON.parse(text);
    return {status:response.status,result};
  }
  async function handle(request,response,url) {
    const route=url.pathname.match(/^\/api\/v1\/rooms\/([a-z0-9-]{1,80})\/widgets(?:\/([a-z0-9-]{1,40})\/(activate|actions))?$/);
    if(!route)return false;
    const [,code,id,action]=route;
    const token=request.headers.authorization?.match(/^Bearer (\S{1,2048})$/)?.[1]??'';
    const actor=verifyAdmission(token,code);
    if(!actor){json(response,401,{error:'Invalid or expired widget admission'});return true;}
    const record=getRoom(code);
    if(!record||Date.parse(record.expiresAt)<=Date.now()){json(response,404,{error:'Room not found'});return true;}
    if(!limiter.check(actor.id).allowed){response.setHeader('Retry-After','60');json(response,429,{error:'Too many widget requests'});return true;}
    if(!id && request.method==='GET'){
      let versions={};try{versions=JSON.parse(url.searchParams.get('versions')??'{}');}catch{/* start fresh */}
      if(!versions||typeof versions!=='object'||Array.isArray(versions))versions={};
      const result=await Promise.all(widgets.map(async widget=>{
        const publicWidget={id:widget.id,title:widget.title,url:widget.url,commands:widget.commands,commandActions:widget.commandActions};
        try{
          const after=Number.isSafeInteger(versions[widget.id])&&versions[widget.id]>=0?versions[widget.id]:0;
          const fetched=await call(widget,code,'state',undefined,after);
          if(fetched.status!==200)throw new Error('Widget unavailable');
          const data=fetched.result;
          return {...publicWidget,active:data.active===true,version:data.version,activation:data.activation,
            state:data.state??null,serverNow:data.serverNow,pollAfterMs:Number.isFinite(data.pollAfterMs)?Math.max(100,Math.min(1000,data.pollAfterMs)):1000,messages:Array.isArray(data.messages)?data.messages.slice(-30):[]};
        }catch{return {...publicWidget,unavailable:true};}
      }));
      json(response,200,{widgets:result});return true;
    }
    const widget=widgets.find(widget=>widget.id===id);
    if(!widget||request.method!=='POST'){json(response,404,{error:'Widget endpoint not found'});return true;}
    if(!mutations.check(actor.id).allowed){response.setHeader('Retry-After','60');json(response,429,{error:'Too many widget actions'});return true;}
    let body;
    try{body=await readJsonBody(request);}catch{json(response,400,{error:'Invalid JSON'});return true;}
    if(!body||typeof body.requestId!=='string'||!/^[-\w]{1,100}$/.test(body.requestId)){
      json(response,400,{error:'A valid requestId is required'});return true;
    }
    if(action==='actions'&&(typeof body.action!=='string'||!/^[-\w]{1,40}$/.test(body.action)||
        !body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))){json(response,400,{error:'Invalid widget action'});return true;}
    // The client cannot supply its own actor, upstream URL, or service key.
    const image=body.presentation?.avatarUrl;
    const avatar=typeof image==='string'&&image.length<=12000&&/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(image)?image:'';
    const payload={...(action==='actions'?body.payload:{}),requestId:body.requestId,actor:{id:actor.id,name:actor.name||'Participant',avatarUrl:avatar}};
    try{
      const fetched=await call(widget,code,action==='activate'?'activate':`actions/${body.action}`,payload);
      if(fetched.status>=400){json(response,[400,409,429].includes(fetched.status)?fetched.status:502,{error:typeof fetched.result.error==='string'?fetched.result.error.slice(0,180):'Widget unavailable'});return true;}
      json(response,fetched.status,fetched.result);
    }catch{json(response,502,{error:'Widget service unavailable'});}
    return true;
  }
  return {handle,enabled:widgets.length>0,frameOrigins:[...new Set(widgets.map(widget=>new URL(widget.url).origin))]};
}
