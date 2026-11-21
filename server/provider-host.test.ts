import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LegacyScriptAdapter, ProviderHost, type ProviderLaunch } from "./provider-host.ts";
import { ensureRadarHome, collectorsDir, providersDir, providerSdkPath, providersConfigPath, providersSpecPath } from "./store.ts";
import { COLLECTOR_SPEC_MD, RADAR_PROVIDER_SDK_PY } from "./collector-seeds.ts";

const params = { now: new Date(0).toISOString(), timezone: "UTC", rules: {} };
const script = `
const {createInterface} = require('node:readline');
const {appendFileSync} = require('node:fs');
let initialized = false;
const send = obj => console.log(JSON.stringify({jsonrpc:'2.0',...obj}));
const item = id => ({id,title:id,stateHash:'1'});
createInterface({input:process.stdin}).on('line', line => {
  const {id,method,params} = JSON.parse(line);
  if (process.env.LOG) appendFileSync(process.env.LOG, process.pid+' '+method+'\\n');
  if (method==='provider/initialize') {
    initialized=true;
    send({id,result:{id:'sample',displayName:params.config.label,capabilities:{health:true,wait:true,push:true}}});
  } else if (!initialized) process.exit(2);
  else if (method==='provider/checkHealth') setTimeout(()=>send({id,result:{ok:true,identity:'sample'}}),20);
  else if (method==='provider/checkWait') send({id,result:{status:params.predicate.type==='done'?'ready':'pending'}});
  else if (method==='provider/sync') {
    if (process.env.FAIL==='hang') return;
    if (process.env.FAIL==='stderr') {console.error('missing configuration'); process.exit(2);}
    if (process.env.FAIL==='invalid') {console.log('not json'); return;}
    if (process.env.FAIL==='rpc') {send({id,error:{code:-32000,message:'sync unavailable'}}); return;}
    send({id,result:params.cursor ? {isFullSnapshot:false,removedIds:['a'],items:[item('b')]} : {items:[item('a'),item('keep')],nextCursor:'first'}});
    if (process.env.PUSH) setTimeout(()=>send({method:'notifications/changed',params:{removedIds:['a'],upserts:[item('push')]}}),20);
  }
});`;
function launch(env: NodeJS.ProcessEnv = {}): ProviderLaunch {
  return { key: 'sample.mjs', signature: 'v1', command: process.execPath, args: ['-e', script], env,
    config: {label:'Sample'}, globalConfig:{}, lifecycle:'oneshot' };
}

test('oneshot initializes on the same child as each operation and caches only matching manifests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-host-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = join(dir, 'log');
  const l = launch({LOG:file});
  const host = new ProviderHost();
  t.after(() => host.stop());
  await host.manifest(l);
  await host.manifest(l);
  assert.equal((await readFile(file,'utf8')).trim().split('\n').length, 1);
  assert.equal((await host.manifest({...l, signature:'v2',config:{label:'Changed'}})).displayName,'Changed');
  assert.deepEqual((await host.sync(l,params)).items.map(i=>i.id),['a','keep']);
  assert.deepEqual((await host.sync(l,params)).items.map(i=>i.id),['keep','b']);
  assert.equal((await host.health(l)).identity,'sample');
  assert.equal((await host.wait(l,{type:'done',params:{}})).status,'ready');
  const entries = (await readFile(file,'utf8')).trim().split('\n').map(s=>s.split(' '));
  assert.equal(new Set(entries.map(e=>e[0])).size,6);
  for (let i=0;i<entries.length;i++) if (entries[i]![1]!=='provider/initialize') assert.deepEqual(entries[i-1],[entries[i]![0],'provider/initialize']);
});

test('daemon multiplexes reversed responses and consumes push upserts and removals', {timeout:5000}, async t => {
  const host = new ProviderHost();
  t.after(() => host.stop());
  const l = launch({PUSH:'1'}); l.lifecycle='daemon';
  const changed = new Promise<void>(resolve=>host.setChangeListener(resolve));
  const [h,w] = await Promise.all([host.health(l),host.wait(l,{type:'wait',params:{}})]);
  assert.equal(h.ok,true); assert.equal(w.status,'pending');
  assert.equal((await host.sync(l,params)).items.length,2);
  await changed;
  assert.deepEqual((await host.sync(l,params)).items.map(i=>i.id),['keep','push']);
  host.retainDaemons([]);
});

test('daemon reconnects after child exit and stops retrying when disabled', {timeout:8000}, async t=>{
  const dir = await mkdtemp(join(tmpdir(),'radar-reconnect-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file = join(dir,'log');
  const host = new ProviderHost(); t.after(()=>host.stop());
  const l = launch({LOG:file}); l.lifecycle='daemon';
  await host.manifest(l);
  const pid = Number((await readFile(file,'utf8')).split(' ')[0]);
  const connected = new Promise<void>(resolve=>host.setChangeListener(resolve));
  process.kill(pid);
  const keepAlive = setInterval(()=>{},25);
  t.after(()=>clearInterval(keepAlive));
  try { await connected; } finally { clearInterval(keepAlive); }
  assert.equal((await host.health(l)).ok,true);
  const ids = (await readFile(file,'utf8')).trim().split('\n').map(s=>s.split(' ')[0]);
  assert.equal(new Set(ids).size,2);
  host.stop();
});

for (const [failure,expected] of [['invalid',/Invalid provider message/],['stderr',/missing configuration/],['rpc',/sync unavailable/],['hang',/timed out/]] as const) {
  test(`provider reports ${failure} failure`,async()=>{
    const host = new ProviderHost(1500);
    try {await assert.rejects(host.sync(launch({FAIL:failure}),params),expected);} finally {host.stop();}
  });
}

test('installed Python SDK speaks initialize, sync, health and wait through ProviderHost', { timeout: 10000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'radar-python-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prev = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = prev; });
  await ensureRadarHome();
  assert.equal(await readFile(providerSdkPath(), 'utf8'), RADAR_PROVIDER_SDK_PY);
  assert.equal(await readFile(providersSpecPath(), 'utf8'), COLLECTOR_SPEC_MD);
  const cfg = JSON.parse(await readFile(providersConfigPath(), 'utf8'));
  assert.equal(cfg.providers.gitlab.enabled, false);
  const path = join(providersDir(), 'fixture.py');
  await writeFile(path, `from radar_provider import RadarProvider
provider = RadarProvider("fixture", "Python fixture")
@provider.sync
def sync(params):
    return {"items": [{"id": "stable", "title": params["config"]["label"], "stateHash": "h1"}], "nextCursor": "checked"}
@provider.health
def health(params):
    return {"ok": True, "identity": params["globalConfig"]["defaultRepoPath"]}
@provider.wait
def wait(predicate, params):
    return {"status": "ready" if predicate["params"]["cursor"] == "checked" else "pending"}
raise SystemExit(provider.run())
`);
  const host = new ProviderHost();
  t.after(() => host.stop());
  const provider: ProviderLaunch = { key: 'fixture.py', signature: 'v1', command: 'python3', args: [path],
    env: process.env, config: { label: 'configured' }, globalConfig: { defaultRepoPath: home }, lifecycle: 'oneshot' };
  const manifest = await host.manifest(provider);
  assert.equal(manifest.id, 'fixture');
  assert.equal(manifest.capabilities.wait, true);
  const result = await host.sync(provider, params);
  assert.equal(result.items[0]?.id, 'stable');
  assert.equal(result.items[0]?.title, 'configured');
  assert.equal((await host.health(provider)).identity, home);
  assert.equal((await host.wait(provider, { type: 'cursor', params: { cursor: result.nextCursor } })).status, 'ready');

  // Upgrading a customized installation still installs the SDK, but never shadows old scripts.
  process.env.PASEO_HOME = join(home, 'legacy');
  await mkdir(collectorsDir(), { recursive: true });
  const legacyPath = join(collectorsDir(), 'gitlab.py');
  await writeFile(legacyPath, '# local script');
  await ensureRadarHome();
  assert.equal(await readFile(providerSdkPath(), 'utf8'), RADAR_PROVIDER_SDK_PY);
  assert.equal(await readFile(legacyPath, 'utf8'), '# local script');
  await assert.rejects(readFile(join(providersDir(), 'gitlab.py')), { code: 'ENOENT' });
});

test('legacy JSON adapter preserves prompts, ids, workspace hints and terminal promotion', async()=>{
  const legacy = {items:[{id:'stable',title:'Review',source:'test',stateHash:'old',prepPrompt:'Prepare',repoPath:'~/repo',mrUrls:['https://github.com/example/repo/pull/123/'],onlyIfMergedMrs:true}],signals:{mergedUrls:['https://github.com/example/repo/pull/123'],entityLinks:{'ref:1':[{url:'https://example.org/1'}]}},errors:['warning']};
  const l = launch(); l.args=['-e',`process.stdin.resume(); process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(legacy))}))`];
  const result = await LegacyScriptAdapter.sync(l,{});
  assert.equal(result.items[0]?.id,'stable');
  assert.equal(result.items[0]?.prepPrompt,'Prepare');
  assert.equal(result.items[0]?.workspaceHint.repoPath,'~/repo');
  assert.deepEqual(result.items[0]?.promoteToClosingWhen?.allEntitiesTerminal,['gh:example/repo#123']);
  assert.equal(result.entitySignals[0]?.entityKey,'gh:example/repo#123');
  assert.equal(result.items[0]?.promoteToClosingWhen?.dropIfUnmet,true);
  assert.deepEqual(result.warnings,['warning']);
});
