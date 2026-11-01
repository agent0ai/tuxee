import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {request} from 'playwright';
const container=process.env.TUXEE_TEST_CONTAINER,base=process.env.TUXEE_TEST_URL;
assert.ok(container&&base,'requires disposable Docker container and forwarded URL');
const docker=(...args)=>{const r=spawnSync('docker',['exec','-i',container,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const user='tuxee-poc-footprint';
if(spawnSync('docker',['exec',container,'id',user],{stdio:'ignore'}).status)docker('useradd','-m','-s','/bin/bash','-c','Tuxee prototype test',user);
assert.equal(docker('getent','passwd',user).split(':')[4],'Tuxee prototype test');
const password=randomBytes(24).toString('base64url');
assert.equal(spawnSync('docker',['exec','-i',container,'chpasswd'],{input:`${user}:${password}\n`}).status,0);
const context=await request.newContext();let csrf;const sessions=[];
const api=(path,method='GET',data)=>context.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-Client':'web','X-Tuxee-CSRF':csrf||''}});
try{
 assert.equal((await api('/login','POST',{username:user,password})).status(),200);
 csrf=(await(await api('/me')).json()).csrf;
 const results=[];
 for(let i=0;i<32;i++){
  const r=await api('/terminals','POST',{name:'Footprint',columns:80,rows:24});assert.equal(r.status(),201,await r.text());sessions.push(await r.json());
  if(i!==0&&i!==31)continue;
  const raw=docker('runuser','-u',user,'--','python3','-c',`
import json,os,re
pids=json.loads(${JSON.stringify(JSON.stringify(sessions.map(s=>s.pid)))})
result=[]
for pid in pids:
 guardian=int(open('/proc/%d/stat'%pid).read().rsplit(') ',1)[1].split()[1])
 fields={k:int(v) for k,v in re.findall(r'^(\\w+):\\s+(\\d+) kB',open('/proc/%d/smaps_rollup'%guardian).read(),re.M)}
 snapshots=[]
 for fd in os.listdir('/proc/%d/fd'%guardian):
  path='/proc/%d/fd/%s'%(guardian,fd)
  try:
   if os.readlink(path).startswith('/memfd:tuxee-checkpoint'): snapshots.append(os.stat(path).st_size)
  except OSError: pass
 result.append(dict(pid=guardian,pssKiB=fields.get('Pss'),anonymousPssKiB=fields.get('Pss_Anon'),filePssKiB=fields.get('Pss_File'),sharedPssKiB=fields.get('Pss_Shmem'),privateKiB=fields.get('Private_Clean',0)+fields.get('Private_Dirty',0),checkpointBytes=sum(snapshots),journalReservedBytes=4*1024*1024))
print(json.dumps(result))
`);
  results.push({count:sessions.length,guardians:JSON.parse(raw)});
 }
 await writeFile('test-results/terminal-keeper/footprint.json',JSON.stringify(results,null,2));
 for(const r of results)console.log(JSON.stringify({count:r.count,totals:Object.fromEntries(['pssKiB','anonymousPssKiB','filePssKiB','sharedPssKiB','privateKiB','checkpointBytes','journalReservedBytes'].map(k=>[k,r.guardians.reduce((sum,g)=>sum+(g[k]||0),0)]))}));
}finally{
 for(const s of sessions)assert.equal((await api('/terminals/'+s.id,'DELETE')).status(),200);
 await context.dispose();
}
