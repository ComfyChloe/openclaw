import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const out=process.env.EVIDENCE+'/public';
let sequence=0;
const adb=(...args)=>execFileSync('adb',['-s','emulator-5554',...args],{timeout:15000});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const record=(event,data)=>fs.appendFileSync(out+'/actions.jsonl',JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');
function capture(label){
  const name=String(++sequence).padStart(3,'0')+'-'+label;
  adb('shell','uiautomator','dump','/sdcard/catalog-window.xml');
  const xml=adb('exec-out','cat','/sdcard/catalog-window.xml').toString();
  fs.writeFileSync(out+'/'+name+'.xml',xml,{flag:'wx'});
  fs.writeFileSync(out+'/'+name+'.png',adb('exec-out','screencap','-p'),{flag:'wx'});
  record('capture',{name});return xml;
}
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
const nodes=xml=>[...xml.matchAll(/<node\s+([^>]+)>?/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])])));
function point(node){
  const match=node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);if(!match)throw Error('Missing visible bounds');
  const [x1,y1,x2,y2]=match.slice(1).map(Number);if(x2<=x1||y2<=y1)throw Error('Empty visible bounds');
  return [String(Math.floor((x1+x2)/2)),String(Math.floor((y1+y2)/2))];
}
async function expect(label){
  const end=Date.now()+30000;
  while(Date.now()<end){
    adb('shell','uiautomator','dump','/sdcard/catalog-window.xml');
    const xml=adb('exec-out','cat','/sdcard/catalog-window.xml').toString();
    if(nodes(xml).some(n=>n.text===label||n['content-desc']===label))return capture('observed');
    await wait(500);
  }
  capture('missing-surface');throw Error('Expected app control not observed: '+label);
}
async function tap(label,xml){
  xml??=await expect(label);
  const matches=nodes(xml).filter(n=>(n.text===label||n['content-desc']===label)&&n.enabled==='true');
  const unique=new Map(matches.map(n=>[n.bounds,n]));if(unique.size!==1)throw Error('Ambiguous or disabled control: '+label);
  const xy=point([...unique.values()][0]);record('tap',{label,xy});adb('shell','input','tap',...xy);await wait(300);
}
function typeField(index,text){
  const xml=capture('before-field'),fields=nodes(xml).filter(n=>n.class==='android.widget.EditText');
  if(!fields[index])throw Error('Expected manual setup field absent');
  const xy=point(fields[index]);record('type-fixture-field',{index,value:index===2?'[synthetic fixture token]':text,xy});
  adb('shell','input','tap',...xy);adb('shell','input','text',text);adb('shell','input','keyevent','KEYCODE_BACK');
}
try{
  await tap('Continue',await expect('Welcome to OpenClaw'));
  await tap('Set up manually');
  await expect('Manual setup');typeField(0,'ws://127.0.0.1');typeField(2,'fixture-android-catalog');
  await tap('Test connection');
  await tap('Continue',await expect('Gateway paired'));
  await tap('Continue',await expect('Only enable access you are comfortable letting OpenClaw use while this phone is connected. You can change these later in Android Settings.'));
  await tap('Show Sidebar');await tap('Settings');
  await tap('Providers & Models');
  await expect('Refresh');capture('initial-catalog');
  const response=await fetch('http://127.0.0.1:18789/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'failed'})});
  if(!response.ok)throw Error('Fixture control refused');record('fixture-control',await response.json());
  await tap('Refresh');await expect('Refresh');
  capture('after-failed-refresh');
  // Capture below the fold without asserting a producer-selected success verdict.
  record('swipe',{from:[540,1500],to:[540,500]});adb('shell','input','swipe','540','1500','540','500','400');
  await wait(500);capture('after-failed-refresh-lower');
  record('sequence-complete',{semanticVerdict:'not assigned; inspect complete UI and wire observations'});
}catch(error){record('sequence-stopped',{error:String(error)});capture('stop');process.exitCode=1;}
