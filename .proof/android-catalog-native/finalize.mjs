import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {writeControl} from './phase-owner.mjs';

export async function* evidenceFiles(root,relative='',includeFooter=false){
  const directory=await fs.promises.opendir(root+'/'+relative);
  for await(const entry of directory){
    const name=relative?relative+'/'+entry.name:entry.name;
    if(!includeFooter&&(name==='finalize'||['files.jsonl','fit.json','identity.json'].includes(name)))continue;
    if(entry.isDirectory())yield* evidenceFiles(root,name,includeFooter);
    else{
      if(!entry.isFile())throw Error('Unexpected non-regular evidence entry: '+name);
      const stat=await fs.promises.stat(root+'/'+name);yield {path:name,bytes:stat.size,ino:stat.ino,mtimeMs:stat.mtimeMs};
    }
  }
}
export async function finalizeEvidence(root,{limitBytes=32*1024**2,footerReserveBytes=1024**2}={}){
  let bytes=0,count=0,manifestBytes=0;
  for await(const file of evidenceFiles(root)){
    bytes+=file.bytes;count++;
    manifestBytes+=Buffer.byteLength(JSON.stringify({path:file.path,bytes:file.bytes,sha256:'0'.repeat(64)})+'\n');
  }
  const fits=bytes+manifestBytes+footerReserveBytes<=limitBytes;
  if(fits){
    const manifest=await fs.promises.open(root+'/files.jsonl','wx',0o600);
    try{for await(const file of evidenceFiles(root)){
      const hash=createHash('sha256');
      for await(const chunk of fs.createReadStream(root+'/'+file.path,{highWaterMark:65536}))hash.update(chunk);
      const after=await fs.promises.stat(root+'/'+file.path);
      if(after.ino!==file.ino||after.size!==file.bytes||after.mtimeMs!==file.mtimeMs)throw Error('Evidence changed after stop: '+file.path);
      const line=JSON.stringify({path:file.path,bytes:file.bytes,sha256:hash.digest('hex')})+'\n';
      await manifest.writeFile(line);
    }}finally{await manifest.close();}
  }
  const fit={at:new Date().toISOString(),fits,originalBytes:bytes,manifestBytes,fileCount:count,limitBytes,footerReserveBytes,
    copiedBytes:0,hashing:fits?'streamed in 64 KiB chunks':'not started: size refusal before additional evidence writes',
    evidence:'Original files remain in the single evidence tree; nothing was truncated or replaced.'};
  writeControl(root+'/fit.json',fit);return fit;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await finalizeEvidence(process.env.EVIDENCE);process.exitCode=result.fits?0:1;
}
