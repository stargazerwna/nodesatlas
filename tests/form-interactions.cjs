// Run with Electron, with ELECTRON_RUN_AS_NODE unset.
// Uses a hidden window and mocked API responses; no saved devices are modified.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:true}});
 const run = s => win.webContents.executeJavaScript(s);
 try {
  await win.loadURL('about:blank');
  const source = fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  const css = fs.readFileSync(path.join(__dirname,'../src/style.css'),'utf8');
  await run(`document.body.innerHTML='<div id="app"></div>'; const style=document.createElement('style'); style.textContent=${JSON.stringify(css)}; document.head.append(style); window.fetch=async()=>{throw Error('offline fixture')}; const licenseText='test'; const appVersion='1.2.1'; const checkForRelease=async()=>null; ${source}`);
  await new Promise(r=>setTimeout(r,100));
  async function click(selector, padding = false) {
   const p=await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+(${padding} ? 4 : r.width/2)),y:Math.round(r.y+r.height/2)}})()`);
   win.webContents.sendInputEvent({type:'mouseMove',...p});
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});
   win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});
   await new Promise(r=>setTimeout(r,100));
  }
  async function check(label, expression) {
   if (!await run(expression)) throw Error(label);
   console.log('PASS',label);
  }
  await run(`window.fetch=async(url,init)=>({ok:true,json:async()=>url==='/api/nodes'?nodes.map(n=>({...n})):url==='/api/links'?[]:{...nodes[0],...JSON.parse(init?.body||'{}')}}); void 0`);
  await click('.map-node');
  await click('#device-form input[name="name"]');
  await win.webContents.insertText('Edited');
  await run(`window.originalField=document.querySelector('#device-form input[name="name"]'); window.originalValue=originalField.value;`);
  await run('refreshMetrics({force:true})');
  await new Promise(r=>setTimeout(r,2200));
  await check('Device field keeps focus and edits through forced and periodic refresh', `document.activeElement===originalField && originalField.isConnected && originalField.value===originalValue && originalValue.includes('Edited')`);
  await run(`document.querySelector('#device-form').requestSubmit()`);
  await new Promise(r=>setTimeout(r,100));
  await check('Device edits save', `document.querySelector('.settings-feedback').textContent==='Settings saved.' && nodes[0].name===originalValue`);
  await run(`window.pending=[]; window.fetch=async(url)=>url.endsWith('/interfaces')?new Promise(resolve=>pending.push(resolve)):({ok:true,json:async()=>url==='/api/nodes'?nodes:[]}); void 0`);
  await click('#connect-mode');
  await run(`window.linkForm=document.querySelector('#link-form'); linkForm.elements.interfaceIp.value='192.0.2.1'; pending.shift()({ok:true,json:async()=>[{index:2,name:'ether2'},{index:7,name:'ether7'}]})`);
  await new Promise(r=>setTimeout(r,2300));
  await check('Interface list and entered IP survive loading and polling', `linkForm.isConnected && linkForm.elements.interfaceIndex.tagName==='SELECT' && linkForm.elements.interfaceIndex.options.length===2 && linkForm.elements.interfaceIp.value==='192.0.2.1'`);
  await run(`linkForm.elements.interfaceIndex.value='7'; linkForm.elements.sourceId.value=nodes[1].id; loadInterfaces(nodes[1].id); linkForm.elements.sourceId.value=nodes[2].id; loadInterfaces(nodes[2].id); pending[1]({ok:true,json:async()=>[{index:9,name:'current interface'}]})`);
  await new Promise(r=>setTimeout(r,100));
  await run(`pending[0]({ok:true,json:async()=>[]})`);
  await new Promise(r=>setTimeout(r,100));
  await check('Late empty response cannot replace current interface list with index 1', `linkForm.elements.interfaceIndex.tagName==='SELECT' && linkForm.elements.interfaceIndex.value==='9'`);
  await click('#cancel-link');
  await run(`refreshMetrics()`);
  await check('Polling resumes after cancelling link', `!document.querySelector('#link-form') && !isEditingLocked()`);
  await run(`links=[{id:'test-link',sourceId:nodes[0].id,targetId:nodes[1].id,interfaceIndex:7,rx:12000000,tx:3000000}]; render();`);
  await click('.link-badge rect', true);
  await check('Clicking rectangle padding opens link settings without starting selection', `selectedLinkId==='test-link' && !!document.querySelector('#edit-link-form') && selecting===null`);
  await run(`pending.at(-1)({ok:true,json:async()=>[{index:2,name:'ether2'},{index:7,name:'ether7'}]})`);
  await new Promise(r=>setTimeout(r,100));
  await check('Link editor loads interfaces and retains saved interface', `document.querySelector('#edit-link-form').elements.interfaceIndex.value==='7'`);
  await click('#cancel-link');
  await run(`document.querySelector('.link-badge').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await check('Link badge supports keyboard activation', `!!document.querySelector('#edit-link-form')`);
  await click('#cancel-link');
  await run(`window.windRequests=[]; window.fetch=async(url,init)=>{if(url==='/api/integrations/wind/import'){windRequests.push(JSON.parse(init.body));return {ok:true,json:async()=>({imported:1,newNodes:[{id:'wind-test',name:'Wind test',type:'router',x:40,y:40,status:'offline'}],newLinks:[]})}}return {ok:true,json:async()=>url==='/api/nodes'?nodes:links}}; void 0`);
  await click('#workspace-menu-toggle');
  await click('#import-wind');
  await check('Wind menu opens a focused domain form in Electron', `document.activeElement===document.querySelector('#wind-import-form input')`);
  await run(`window.windField=document.querySelector('#wind-import-form input'); windField.value='  example.org/wind  '; windField.dispatchEvent(new Event('input',{bubbles:true})); refreshMetrics({force:true})`);
  await new Promise(r=>setTimeout(r,1200));
  await check('Wind domain survives polling', `windField.isConnected && windField.value==='  example.org/wind  '`);
  await click('#cancel-wind-import');
  await check('Cancel makes no import request', `windRequests.length===0 && !document.querySelector('#wind-import-form')`);
  await click('#workspace-menu-toggle');
  await click('#import-wind');
  await click('#wind-import-form button[type="submit"]');
  await check('Wind import submits trimmed domain and shows success', `windRequests.length===1 && windRequests[0].domain==='example.org/wind' && nodes.some(n=>n.id==='wind-test') && workspaceFeedback.includes('Imported 1 Wind node')`);
  await run(`window.fetch=async()=>({ok:false,json:async()=>({error:'Wind server unavailable'})}); void 0`);
  await click('#workspace-menu-toggle');
  await click('#import-wind');
  await click('#wind-import-form button[type="submit"]');
  await check('Wind import displays API errors', `workspaceFeedback==='Wind server unavailable'`);
 } catch(e){console.error(e);app.exit(1);return;}
 app.quit();
});
