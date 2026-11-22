import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWidgetApi } from '../server/widget-api.mjs';
import { createBotApi } from '../server/bot-api.mjs';

test('widget admission is isolated from bots/chat and never leaks provider credentials',async t=>{
  let forwarded;
  const provider=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-provider-token-with-at-least-32-characters');
    let raw='';for await(const chunk of req)raw+=chunk;
    forwarded=raw?JSON.parse(raw):undefined;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.method==='GET'?{active:true,version:1,activation:'a',serverNow:Date.now(),pollAfterMs:100,state:{application:'data'},messages:[]}:{accepted:forwarded}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const url=`http://127.0.0.1:${provider.address().port}`;
  const room={code:'test-room',expiresAt:new Date(Date.now()+60_000).toISOString()};
  const json=(res,status,body)=>Object.assign(res,{status,body});
  const core={getRoom:code=>code===room.code?room:undefined,json,readJsonBody:async req=>req.body};
  const bot=createBotApi({...core});
  const commandActions={test_help:'help',test_exit:'exit',test_set:'list','test_set_*':'set'};
  const widget=createWidgetApi({...core,configuration:JSON.stringify([{id:'test-widget',title:'Test widget',commands:['test'],commandActions,url:`${url}/widget`,serviceUrl:url,token:'test-provider-token-with-at-least-32-characters'}]),verifyAdmission:bot.verifyWidgetAdmission});
  const capability=bot.issueWidgetAdmission(room,'Alice');
  const call=async(path,body,token=capability)=>{
    const response={setHeader(){}};
    await widget.handle({method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`},body},response,new URL(`http://localhost/api/v1/rooms/${path}`));
    return response;
  };
  const list=await call('test-room/widgets');assert.equal(list.status,200);assert.equal(list.body.widgets[0].active,true);
  assert.equal(list.body.widgets[0].pollAfterMs,100);
  assert.deepEqual(list.body.widgets[0].commandActions,commandActions);
  assert(!JSON.stringify(list.body).includes('test-provider-token'));assert(!('serviceUrl'in list.body.widgets[0]));
  assert.equal((await call('other-room/widgets')).status,401);
  assert.equal((await call('test-room/widgets',undefined,'wrong')).status,401);
  const action=await call('test-room/widgets/test-widget/actions',{requestId:'one',action:'anything',payload:{actor:{id:'evil',name:'Evil'},requestId:'override',value:12}});
  assert.equal(action.status,200);assert.equal(forwarded.actor.name,'Alice');assert.equal(forwarded.requestId,'one');assert.equal(forwarded.value,12);
  const avatar='data:image/png;base64,aGVsbG8=';
  await call('test-room/widgets/test-widget/actions',{requestId:'avatar',action:'roll',payload:{actor:{name:'Evil'}},presentation:{avatarUrl:avatar}});
  assert.equal(forwarded.actor.avatarUrl,avatar);assert.equal(forwarded.actor.name,'Alice');
  await call('test-room/widgets/test-widget/actions',{requestId:'url-avatar',action:'roll',payload:{},presentation:{avatarUrl:'https://external.example/avatar.png'}});
  assert.equal(forwarded.actor.avatarUrl,'');
  const invalid=await call('test-room/widgets/test-widget/actions',{requestId:'two',action:'../../escape',payload:{}});assert.equal(invalid.status,400);
  const response={setHeader(){}};
  await bot.handle({method:'GET',headers:{authorization:`Bearer ${capability}`}},response,new URL('http://localhost/api/v1/rooms/test-room/events'));
  assert.equal(response.status,401);
});

test('unsafe widget provider registration fails closed',()=>{
  const base={id:'test',title:'Test',commands:['test'],url:'https://widget.example/widget',serviceUrl:'http://127.0.0.1:3210',token:'test-token-with-at-least-32-characters'};
  for(const bad of [{...base,serviceUrl:'file:///secret'},{...base,url:'https://user:password@widget.example/widget'},
    {...base,commands:['../escape']},{...base,token:'short'}])assert.throws(()=>createWidgetApi({configuration:JSON.stringify([bad])}));
  assert.throws(()=>createWidgetApi({configuration:JSON.stringify([base,base])}));
  assert.throws(()=>createWidgetApi({configuration:JSON.stringify([{...base,commandActions:{'test_*':'set',test_help:'help'}}])}));
  assert.throws(()=>createWidgetApi({configuration:JSON.stringify([{...base,commandActions:{'test*':'set'}}])}));
  assert.throws(()=>createWidgetApi({configuration:JSON.stringify([{...base,commandActions:{'test_*':'set'}},{...base,id:'other',commands:['other'],commandActions:{'test_option_*':'set'}}])}));
});
