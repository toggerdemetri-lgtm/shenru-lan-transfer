import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

test('real managed tray UI dispatches both menu actions and cleans up repeated lifetimes',{skip:process.platform!=='win32'},async t=>{
 const root=resolve(import.meta.dirname,'..'),work=await mkdtemp(join(tmpdir(),'shenru-tray-menu-'));
 t.after(()=>rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const source=join(work,'Probe.cs'),exe=join(work,'Probe.exe');
 await writeFile(source,`using System;using System.Reflection;using System.Threading;using System.Windows.Forms;
internal class Probe {
 static int Main() { try {
  for(int cycle=0;cycle<3;cycle++) {
   int opened=0,stopped=0;
   var mode=cycle%2==0?"host":"join";
   using(var tray=new TrayHost(delegate{opened++;},delegate{stopped++;},mode)) {
    var context=typeof(TrayHost).GetField("context",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(tray);
    var dispatcher=(Control)context.GetType().GetField("Dispatcher",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
    dispatcher.Invoke(new MethodInvoker(delegate {
     var menu=(ContextMenuStrip)context.GetType().GetField("menu",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
     var icon=(NotifyIcon)context.GetType().GetField("tray",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
     if(!icon.Visible||icon.Icon==null||menu.Items[0].Text!="打开深入·局域网互传"||menu.Items[2].Text!="退出深入·局域网互传")throw new Exception("tray is not initialized");
     if(icon.Text!=(mode=="host"?"深入·局域网互传 · 本机提供服务":"深入·局域网互传 · 已加入空间"))throw new Exception("tray tooltip has the wrong product name or mode");
     ((ToolStripMenuItem)menu.Items[0]).PerformClick();((ToolStripMenuItem)menu.Items[2]).PerformClick();
    }));
    if(opened!=1||stopped!=1||tray.Failure!=null)throw new Exception("menu callback failed");
   }
  }
  Console.WriteLine("TRAY_MENU_OK");return 0;
 }catch(Exception error){Console.Error.WriteLine(error);return 1;} }
}`,'utf8');
 execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',['/nologo','/target:exe','/utf8output','/codepage:65001','/r:System.Windows.Forms.dll','/r:System.Drawing.dll',`/resource:${join(root,'public/brand/app.ico')},shenru.icon`,`/out:${exe}`,source,join(root,'launcher/TrayHost.cs')],{windowsHide:true});
 const result=execFileSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});
 assert.match(result,/TRAY_MENU_OK/);
});
