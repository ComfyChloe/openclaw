import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

// Consumer wire fixture only. It is not a Gateway, provider or auth-policy proof.
const out=process.env.EVIDENCE+'/public', nonce=randomUUID();
let mode='initial', sequence=0;
const deviceIds=new Set();
const record=(event,data)=>fs.appendFileSync(out+'/wire.jsonl',JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');
const row=(id,name)=>({id,provider:'ollama',name:name+' '+nonce,available:true});
const rows={initial:[row('fixture-initial','Initial choice')],failed:[row('fixture-compatible','Compatible choice')]};
const methods=['models.list','models.authStatus','agents.list','sessions.list','sessions.subscribe','chat.history','health','status','node.list','device.pair.list'];
const server=Bun.serve({
  hostname:'127.0.0.1',port:18789,
  fetch(request,server){
    const url=new URL(request.url);
    if(url.pathname==='/control'&&request.method==='POST')return request.json().then(input=>{
      if(!['initial','failed'].includes(input.mode))return new Response('unknown fixture mode',{status:400});
      mode=input.mode;record('fixture-control',{mode});return Response.json({mode,nonce});
    });
    if(url.pathname==='/state')return Response.json({mode,nonce,rows});
    if(url.pathname==='/'&&server.upgrade(request,{data:{connection:++sequence,connected:false}}))return;
    return new Response('unsupported fixture surface',{status:404});
  },
  websocket:{
    open(ws){const challenge={type:'event',event:'connect.challenge',payload:{nonce:randomUUID(),ts:Date.now()}};record('challenge',{connection:ws.data.connection,frame:challenge});ws.send(JSON.stringify(challenge));},
    message(ws,message){
      const frame=JSON.parse(String(message));
      if(frame.type!=='req'||typeof frame.id!=='string')throw Error('Unexpected wire frame');
      // Only connection credentials and device proof are omitted from the public log.
      record('request',{connection:ws.data.connection,frame:frame.method==='connect'?{type:frame.type,id:frame.id,method:frame.method,params:{role:frame.params.role,minProtocol:frame.params.minProtocol,maxProtocol:frame.params.maxProtocol}}:frame});
      let payload,error;
      if(frame.method==='connect'){
        if(frame.params?.auth?.token!=='fixture-android-catalog')error={code:'INVALID_REQUEST',message:'Expected the isolated fixture token'};
        else {
          ws.data.connected=true;
          if(typeof frame.params.device?.id!=='string')throw Error('Expected generated fixture device identity');
          deviceIds.add(frame.params.device.id);
          payload={type:'hello-ok',protocol:4,server:{version:'wire-fixture',connId:String(ws.data.connection),host:'Catalog fixture'},features:{methods,events:[]},auth:{role:frame.params.role,scopes:frame.params.scopes??[]},snapshot:{sessionDefaults:{mainSessionKey:'agent:main:main',mainKey:'main'}},policy:{tickIntervalMs:30000,maxPayload:1048576,maxBufferedBytes:1048576}};
        }
      }else if(!ws.data.connected)error={code:'INVALID_REQUEST',message:'Connect is required'};
      else switch(frame.method){
        case 'models.list': payload={models:rows[mode],...(mode==='failed'?{refreshFailed:true}:{})};break;
        case 'models.authStatus': payload={providers:[{provider:'ollama',displayName:'Fixture provider',status:mode==='failed'?'configured':'unknown',profiles:[]}]};break;
        case 'agents.list': payload={defaultId:'main',mainKey:'main',scope:'per-sender',agents:[{id:'main',name:'Main'}]};break;
        case 'sessions.list': payload={ts:Date.now(),count:0,sessions:[]};break;
        case 'sessions.subscribe': payload={ok:true};break;
        case 'node.list': payload={nodes:[...deviceIds].map(nodeId=>({nodeId,displayName:'Isolated phone',paired:true,connected:true,approvalState:'approved',caps:[],commands:[]}))};break;
        case 'device.pair.list': payload={pending:[],paired:[]};break;
        case 'chat.history': payload={sessionKey:'agent:main:main',messages:[]};break;
        case 'health': payload={ok:true,channels:{}};break;
        case 'status': payload={};break;
        default: error={code:'INVALID_REQUEST',message:'Not implemented by the isolated catalog consumer fixture'};
      }
      const response={type:'res',id:frame.id,ok:!error,...(error?{error}:{payload})};
      record('response',{connection:ws.data.connection,mode,frame:response});ws.send(JSON.stringify(response));
    },
    close(ws,code,reason){record('close',{connection:ws.data.connection,code,reason});}
  }
});
record('ready',{nonce,port:server.port,kind:'consumer-wire-fixture'});
