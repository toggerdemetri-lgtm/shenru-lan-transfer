/* Native AppKit menu bar UI. No Apple Events, System Events or UI scripting. */
ObjC.import('AppKit');
ObjC.import('Foundation');

var application, task, inputPipe, statusItem, timer, delegate;
var resources, sessionDir, statusPath, logPath;
var ready = false, duplicate = false, quitting = false, allowTermination = false;
var quitAt = 0, sentTerm = false, sentKill = false, lastOpen = -1, failed = false;

function readJSON(path) {
  var value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!value) return null;
  try { return JSON.parse(ObjC.unwrap(value)); } catch (_) { return null; }
}
function alertError(message) {
  if (failed) return;
  failed = true;
  var alert = $.NSAlert.alloc.init;
  alert.messageText = $('深入·局域网互传无法继续运行');
  alert.informativeText = $(message + '\n\n诊断日志：' + logPath);
  alert.addButtonWithTitle($('好'));
  application.activateIgnoringOtherApps(true);
  alert.runModal;
}
function openSpace() {
  var state = readJSON(statusPath);
  if (!state || state.state !== 'ready') return;
  // Open the space immediately, matching the Windows tray. Restrict direct
  // browser navigation to verified local/private IPv4 HTTP endpoints; retain
  // the generated HTML as the fallback for unusual LAN address ranges.
  var match = /^http:\/\/(\d+)\.(\d+)\.(\d+)\.(\d+):(\d+)\/$/.exec(state.url || '');
  var direct = false;
  if (match) {
    var ip = match.slice(1, 5).map(Number), port = Number(match[5]);
    direct = ip.every(function (part) { return part >= 0 && part <= 255; }) && port > 0 && port <= 65535 &&
      (ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31));
  }
  var target = direct ? state.url : state.entryURL;
  if (target) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString($(target)));
}
function beginQuit() {
  if (quitting) return;
  quitting = true;
  quitAt = Date.now();
  try { inputPipe.fileHandleForWriting.closeFile; } catch (_) {}
}
function finishQuit() {
  if (timer) timer.invalidate;
  if (statusItem) $.NSStatusBar.systemStatusBar.removeStatusItem(statusItem);
  allowTermination = true;
  application.terminate(null);
}
function buildMenu() {
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  var image = $.NSImage.alloc.initWithContentsOfFile($(resources + '/menu-icon.png'));
  if (image) { image.size = $.NSMakeSize(19, 19); image.template = true; statusItem.button.image = image; }
  else { statusItem.button.title = $('深入·局域网互传'); }
  statusItem.button.toolTip = $('深入·局域网互传');
  var menu = $.NSMenu.alloc.init;
  var open = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($('打开深入·局域网互传'), $('openSpace:'), $(''));
  open.target = delegate; menu.addItem(open);
  menu.addItem($.NSMenuItem.separatorItem);
  var quit = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($('退出深入·局域网互传'), $('quitShenru:'), $('q'));
  quit.target = delegate; menu.addItem(quit);
  statusItem.menu = menu;
}
function poll() {
  var state = readJSON(statusPath);
  if (state && state.role === 'duplicate') { duplicate = true; beginQuit(); }
  if (state && state.state === 'error' && !quitting) { alertError(state.error); beginQuit(); }
  if (!quitting && state && state.state === 'ready' && state.role === 'primary') {
    if (!ready) { ready = true; buildMenu(); }
    if (state.openRequest !== lastOpen) { lastOpen = state.openRequest; openSpace(); }
  }
  if (!task.running) {
    if (!quitting && !duplicate) alertError('本机后台服务已停止。请重新打开深入·局域网互传。');
    finishQuit(); return;
  }
  if (quitting && Date.now() - quitAt > 6000 && !sentTerm) { sentTerm = true; task.terminate; }
  if (quitting && Date.now() - quitAt > 8000 && !sentKill) {
    sentKill = true;
    var killer = $.NSTask.alloc.init;
    killer.launchPath = $('/bin/kill'); killer.arguments = $(['-KILL', String(task.processIdentifier)]); killer.launch;
  }
}
ObjC.registerSubclass({
  name: 'ShenruMenuDelegate',
  superclass: 'NSObject',
  protocols: ['NSApplicationDelegate'],
  methods: {
    'openSpace:': { types: ['void', ['id']], implementation: function () { openSpace(); } },
    'quitShenru:': { types: ['void', ['id']], implementation: function () { beginQuit(); } },
    'tick:': { types: ['void', ['id']], implementation: function () { poll(); } },
    'applicationShouldTerminate:': { types: ['unsigned long', ['id']], implementation: function () { if (allowTermination) return $.NSTerminateNow; beginQuit(); return $.NSTerminateCancel; } },
    'applicationShouldHandleReopen:hasVisibleWindows:': { types: ['bool', ['id', 'bool']], implementation: function () { openSpace(); return false; } }
  }
});

function run(argv) {
  resources = argv[0];
  var appPath = argv[1];
  sessionDir = ObjC.unwrap($.NSTemporaryDirectory()) + 'shenru-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
  statusPath = sessionDir + '/status.json'; logPath = sessionDir + '/server.log';
  var manager = $.NSFileManager.defaultManager;
  manager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(sessionDir), true, $({ NSFilePosixPermissions: 448 }), null);
  var settings = { sessionDir: sessionDir, appPath: appPath, entryPath: appPath.substring(0, appPath.lastIndexOf('/')) + '/深入·局域网互传.html' };
  $(JSON.stringify(settings)).writeToFileAtomicallyEncodingError($(sessionDir + '/settings.json'), true, $.NSUTF8StringEncoding, null);
  manager.createFileAtPathContentsAttributes($(logPath), $.NSData.data, null);
  var logHandle = $.NSFileHandle.fileHandleForWritingAtPath($(logPath));
  application = $.NSApplication.sharedApplication;
  application.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  delegate = $.ShenruMenuDelegate.alloc.init;
  application.delegate = delegate;
  inputPipe = $.NSPipe.pipe;
  task = $.NSTask.alloc.init;
  task.launchPath = $(resources + '/runtime/node');
  task.arguments = $([resources + '/app/desktop-macos.mjs', sessionDir + '/settings.json']);
  task.currentDirectoryPath = $(resources + '/app');
  task.standardInput = inputPipe; task.standardOutput = logHandle; task.standardError = logHandle;
  try { task.launch; }
  catch (error) { alertError(String(error)); allowTermination = true; return; }
  // The write end remains owned by this process. A crash/force quit closes it,
  // which the Node lifecycle interprets exactly like the menu's Exit action.
  timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.2, delegate, $('tick:'), null, true);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
  application.run;
}
