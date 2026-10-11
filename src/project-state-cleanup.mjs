import fs from 'node:fs/promises';
import path from 'node:path';
import { queueDiagnosticFile } from './common.mjs';

// Match complete values (also inside nested JSON delivery keys), never name substrings.
export function belongsToProject(value, identities) {
  // A Git worktree may share its parent's project_id. Its workspace and
  // session IDs, not project_id in isolation, establish the deletion owner.
  const tokens=new Set(identities.flatMap(p=>[p.workspace,...(p.sessionIds??[])]).filter(Boolean));
  const matches=value=>{
    if(typeof value==='string') {
      if(tokens.has(value))return true;
      try {const parsed=JSON.parse(value);return typeof parsed!=='string'&&matches(parsed);}catch{return false;}
    }
    if(Array.isArray(value))return value.some(matches);
    if(value&&typeof value==='object') {
      const owner=identities.find(p=>p.workspace===value.workspace);
      if(owner&&value.projectId&&owner.projectId&&value.projectId!==owner.projectId)
        return false; // replacement at the same path is not the deleted project.
      return Object.entries(value).some(([k,v])=>matches(k)||matches(v));
    }
    return false;
  };
  return !!matches(value);
}

export function removeProjectSettings(settings, identities) {
  const result=structuredClone(settings);
  for(const field of ['projectAutoPlan','parallelExecutionBook'])if(result[field])
    result[field]=Object.fromEntries(Object.entries(result[field]).filter(([key,value])=>{
      const workspace=field==='projectAutoPlan'?key:value?.workspace;
      const owner=identities.find(p=>p.workspace===workspace);
      if(owner&&value?.projectId&&owner.projectId&&value.projectId!==owner.projectId)return true;
      return !belongsToProject([key,value],identities);
    }));
  for(const field of ['reviewCheckpoint','automationCheckpoint'])if(result[field])
    for(const [key,value] of Object.entries(result[field]))if(Array.isArray(value))
      result[field][key]=value.filter(entry=>!belongsToProject(entry,identities));
  return result;
}

export function pruneOrphanProjectSettings(settings, projects) {
  const live=new Map(projects.map(p=>[p.workspace,p]));
  const missing=[...new Set([...Object.keys(settings.projectAutoPlan??{}),...Object.values(settings.parallelExecutionBook??{}).map(v=>v.workspace)].filter(w=>w&&!live.has(w)))];
  const result=removeProjectSettings(settings,missing.map(workspace=>({workspace})));
  for(const [workspace,value] of Object.entries(result.projectAutoPlan??{}))
    if(value.projectId&&value.projectId!==live.get(workspace)?.projectId)delete result.projectAutoPlan[workspace];
  for(const [key,value] of Object.entries(result.parallelExecutionBook??{}))
    if(value.projectId&&value.projectId!==live.get(value.workspace)?.projectId)delete result.parallelExecutionBook[key];
  const owner=value=>{
    if(typeof value==='string'){try{return owner(JSON.parse(value));}catch{return null;}}
    if(Array.isArray(value))return typeof value[0]==='string'&&(/^[A-Za-z]:[\\/]/.test(value[0])||value[0].startsWith('/'))?value:owner(value[0]);
    return null;
  };
  for(const field of ['reviewCheckpoint','automationCheckpoint'])if(result[field])
    for(const [key,list] of Object.entries(result[field]))if(Array.isArray(list))result[field][key]=list.filter(item=>{
      const address=owner(item.key);if(!address)return true;
      return live.get(address[0])?.sessions.some(s=>s.sessionId===address[1]);
    });
  return result;
}

const read=async file=>fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const write=async(file,text)=>{
  const temporary=file+'.project-cleanup.tmp';
  await fs.writeFile(temporary,text,{mode:0o600});await fs.rename(temporary,file);
};

// Only application-owned state; browser profiles, cookies and cloud chats are untouched.
export async function purgeProjectStateFiles(dataDir,identities) {
  const files=await fs.readdir(dataDir);
  for(const name of files.filter(n=>/^settings\.json(?:\.v\d+-backup)?$/.test(n))) {
    const file=path.join(dataDir,name),raw=await read(file);
    const old=JSON.parse(raw),next=removeProjectSettings(old,identities);
    if(JSON.stringify(old)!==JSON.stringify(next))await write(file,JSON.stringify(next,null,2)+'\n');
  }
  // Interrupted atomic settings writes are not a backup and must not restore deleted data.
  for(const name of files.filter(n=>/^settings\.json\.(?:tmp(?:-[\w-]+)?|project-cleanup\.tmp)$/.test(n)))
    await fs.rm(path.join(dataDir,name),{force:true});
  const diagnostics=path.join(dataDir,'diagnostics');
  const names=(await fs.readdir(diagnostics).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/\.jsonl(?:\.\d+)?$/.test(n));
  for(const base of new Set(names.map(n=>n.replace(/(\.jsonl)\.\d+$/,'$1'))))await queueDiagnosticFile(path.join(diagnostics,base),async()=>{
    const rows=[];
    for(const name of names.filter(n=>n===base||n.startsWith(base+'.'))) {
      const file=path.join(diagnostics,name),raw=await read(file);
      rows.push({file,lines:(raw??'').split('\n').filter(Boolean).map(line=>({line,value:JSON.parse(line)}))});
    }
    const diagnosticIds=new Set(rows.flatMap(r=>r.lines.filter(l=>belongsToProject(l.value,identities)).map(l=>l.value.diagnosticSession)).filter(Boolean));
    for(const {file,lines} of rows) {
      const kept=lines.filter(l=>!belongsToProject(l.value,identities)&&!diagnosticIds.has(l.value.diagnosticSession));
      if(lines.length!==kept.length)await write(file,kept.length?kept.map(l=>l.line).join('\n')+'\n':'');
    }
  });
}

// Share the settings writer tail so purge cannot remove an active atomic write.
export function queueProjectStatePurge(previous, dataDir, identities) {
  return previous.catch(()=>{}).then(()=>purgeProjectStateFiles(dataDir,identities));
}
