import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { runBuildProcess } from '../build/process.mjs';

const execFileAsync = promisify(execFile), MAX_OUTPUT = 256 * 1024;
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SDL_MAC_BACKGROUND_APP', 'SDL_RENDER_DRIVER', 'SDL_FRAMEBUFFER_ACCELERATION'];
function fail(code) { throw Object.assign(new Error('The trusted GUI invocation could not be admitted.'), { code }); }
function object(value, keys, required = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !Object.hasOwn(item, 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_GUI_HOST_INVOCATION');
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_GUI_HOST_PATH');
  return path.resolve(value);
}
function inside(root, child) { return child === root || child.startsWith(root + path.sep); }
function aborted(signal) { if (signal?.aborted) fail('HOST_PROBE_CANCELLED'); }
export function validateGuiHostInvocation(raw) {
  const fields = ['policyFile', 'policyRoot', 'executable', 'args', 'cwd', 'env', 'signal', 'timeoutMs', 'verifyBinding', 'bundleIdentifier', 'launchAppPath', 'actualEnv', 'policySha256'];
  object(raw, fields, ['policyFile', 'policyRoot', 'executable', 'args', 'cwd', 'env']);
  const selected = Object.fromEntries(['policyFile', 'policyRoot', 'executable', 'cwd'].map(key => [key, absolute(raw[key])]));
  if (selected.policyRoot === '/' || selected.cwd === '/' || !inside(selected.policyRoot, selected.policyFile) || inside(selected.cwd, selected.policyRoot) || inside(selected.policyRoot, selected.cwd)) fail('INVALID_GUI_HOST_PATH');
  if (!Array.isArray(raw.args) || Object.getPrototypeOf(raw.args) !== Array.prototype || raw.args.length > 32 ||
      Reflect.ownKeys(raw.args).length !== raw.args.length + 1 || Object.values(Object.getOwnPropertyDescriptors(raw.args)).some(item => !Object.hasOwn(item, 'value')) ||
      Array.from({ length: raw.args.length }, (_, index) => !Object.hasOwn(raw.args, index)).some(Boolean) ||
      raw.args.some(item => typeof item !== 'string' || item.length > 4096 || /[\x00-\x1f\x7f]/.test(item)) ||
      raw.args.reduce((total, item) => total + Buffer.byteLength(item), 0) > 16384) fail('INVALID_GUI_HOST_INVOCATION');
  object(raw.env, ENV_KEYS, ['PATH']);
  if (raw.env.PATH !== '/usr/bin:/bin' || Object.values(raw.env).some(value => typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) fail('INVALID_GUI_HOST_ENVIRONMENT');
  if (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) fail('INVALID_GUI_HOST_INVOCATION');
  if (raw.verifyBinding !== undefined && typeof raw.verifyBinding !== 'function') fail('INVALID_GUI_HOST_INVOCATION');
  const actualEnv = raw.actualEnv === undefined ? undefined : absolute(raw.actualEnv);
  if (raw.policySha256 !== undefined && (typeof raw.policySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.policySha256))) fail('INVALID_GUI_HOST_POLICY');
  if (raw.bundleIdentifier !== undefined && (typeof raw.bundleIdentifier !== 'string' || raw.bundleIdentifier.length > 200 ||
      !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(raw.bundleIdentifier))) fail('INVALID_GUI_HOST_BUNDLE_IDENTIFIER');
  let launchAppPath;
  if (raw.launchAppPath !== undefined) {
    launchAppPath = absolute(raw.launchAppPath);
    if (!launchAppPath.endsWith('.app') || !raw.bundleIdentifier || inside(selected.cwd, launchAppPath) || inside(launchAppPath, selected.cwd) ||
        !inside(launchAppPath, selected.executable)) fail('INVALID_GUI_HOST_PATH');
  }
  const timeoutMs = raw.timeoutMs ?? 90000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 180000) fail('INVALID_GUI_HOST_INVOCATION');
  aborted(raw.signal);
  return { ...selected, args: [...raw.args], env: { ...raw.env }, signal: raw.signal, timeoutMs, verifyBinding: raw.verifyBinding, bundleIdentifier: raw.bundleIdentifier, launchAppPath, actualEnv, policySha256: raw.policySha256 };
}
// Octal byte quoting makes even Unicode paths inert C string data.
const cString = value => '"' + [...Buffer.from(value, 'utf8')].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('') + '"';
export function makeGuiHostEntryScript(raw) {
  const executable = absolute(raw);
  if (!/\.app\/Contents\/MacOS\/GameBridgeHostInvocation$/.test(executable)) fail('INVALID_GUI_HOST_PATH');
  const quoted = "'" + executable.replaceAll("'", "'\"'\"'") + "'";
  return '#!/bin/sh\nexec ' + quoted + '\n';
}
function sourceFor(config) {
  const argv = [config.executable, ...config.args];
  return `#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <libproc.h>
#include <arpa/inet.h>
#include <sandbox.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static const char *permit=${cString(config.permit)}, *ack=${cString(config.ack)}, *handshake=${cString(config.handshake)};
static const char *nonce=${cString(config.nonce)}, *output=${cString(config.output)}, *work=${cString(config.cwd)};
static const char *launch_status=${cString(config.launchStatus)};
static const char *sandbox_policy=${cString(config.policyText)}, *policy_file=${cString(config.policyFile)};
static const char *positive_file=${cString(config.positive)}, *credential_file=${cString(config.credentialCanary)}, *outside_file=${cString(config.deniedOutside)};
static const char *protected_env=${config.actualEnv ? cString(config.actualEnv) : 'NULL'}, *native_executable=${cString(config.executable)};
static const pid_t owner=${process.pid};
static int identity(pid_t pid, struct proc_bsdinfo *info) { return proc_pidinfo(pid,PROC_PIDTBSDINFO,0,info,sizeof(*info)) == sizeof(*info); }
static int token(const char *name) {
  int fd=open(name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK); if(fd<0) return 0;
  struct stat s; char bytes[64]={0};
  int ok=fstat(fd,&s)==0 && S_ISREG(s.st_mode) && s.st_nlink==1 && s.st_size==(off_t)strlen(nonce) && read(fd,bytes,sizeof(bytes)-1)==(ssize_t)strlen(nonce) && strcmp(bytes,nonce)==0;
  close(fd); return ok;
}
static void stage(const char *name,int saved_errno) {
  /* A cancelled/late launcher cannot create new diagnostic records. */
  if(!token(permit))return;
  int fd=open(launch_status,O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW|O_CLOEXEC,0600); if(fd<0)return;
  struct stat s; char line[256];
  if(fstat(fd,&s)==0 && S_ISREG(s.st_mode) && s.st_nlink==1 && s.st_size<8192) {
    int n=snprintf(line,sizeof(line),"{\\"stage\\":\\"%s\\",\\"errno\\":%d,\\"pid\\":%d}\\n",name,saved_errno,getpid());
    if(n>0 && n<(int)sizeof(line)) { (void)write(fd,line,n); (void)fsync(fd); }
  }
  close(fd);
}
static int failed(const char *name,int code) { int saved=errno; stage(name,saved); return code; }
static int denied_open(const char *file,int flags) {
  errno=0; int fd=open(file,flags,0600); if(fd>=0){close(fd);return 0;} return errno==EPERM||errno==EACCES;
}
static int denied_connect(const char *host) {
  errno=0; int fd=socket(AF_INET,SOCK_STREAM,0); if(fd<0)return errno==EPERM||errno==EACCES;
  int old=fcntl(fd,F_GETFL,0); if(old<0||fcntl(fd,F_SETFL,old|O_NONBLOCK)<0){close(fd);return 0;}
  struct sockaddr_in address;memset(&address,0,sizeof(address));address.sin_len=sizeof(address);address.sin_family=AF_INET;address.sin_port=htons(9);
  if(inet_pton(AF_INET,host,&address.sin_addr)!=1){close(fd);return 0;}
  errno=0;int code=connect(fd,(struct sockaddr*)&address,sizeof(address));int saved=errno;close(fd);
  return code<0&&(saved==EPERM||saved==EACCES);
}
static int boundary_failed(const char *step,int code) {
  dprintf(2,"[GUI_BOUNDARY] {\\"status\\":\\"failed\\",\\"step\\":\\"%s\\"}\\n",step);return code;
}
static int boundary_controls(void) {
  int fd=open(positive_file,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,0600);char bytes[7]={0};
  if(fd<0)return boundary_failed("positive-open",141);
  if(write(fd,"bounded",7)!=7||lseek(fd,0,SEEK_SET)<0||read(fd,bytes,7)!=7||memcmp(bytes,"bounded",7)!=0){close(fd);return boundary_failed("positive-read-write",142);}close(fd);
  fd=open(native_executable,O_RDONLY|O_NOFOLLOW);if(fd<0)return boundary_failed("application-open",143);
  int application_read=read(fd,bytes,1)==1;close(fd);if(!application_read)return boundary_failed("application-read",144);
  if(!denied_open(credential_file,O_RDONLY|O_NOFOLLOW))return boundary_failed("credential-read",145);
  if(!denied_open(policy_file,O_RDONLY|O_NOFOLLOW))return boundary_failed("policy-read",146);
  if(!denied_open(outside_file,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW))return boundary_failed("outside-write",147);
  if(protected_env&&!denied_open(protected_env,O_RDONLY|O_NOFOLLOW))return boundary_failed("actual-env-open",148);
  if(!denied_connect("127.0.0.1"))return boundary_failed("local-network",149);
  if(!denied_connect("203.0.113.1"))return boundary_failed("external-network",150);
  dprintf(1,"[GUI_BOUNDARY] {\\"status\\":\\"passed\\",\\"positiveReadWrite\\":true,\\"applicationRead\\":true,\\"credentialRead\\":\\"denied\\",\\"policyRead\\":\\"denied\\",\\"outsideWrite\\":\\"denied\\",\\"actualEnvOpen\\":\\"%s\\",\\"localNetwork\\":\\"denied\\",\\"externalNetwork\\":\\"denied\\"}\\n",protected_env?"denied":"not_configured");return 0;
}
int main(int argc,char **av) {
  struct proc_bsdinfo info;
  if(argc==3 && strcmp(av[1],"--inspect-pid")==0) {
    char *end=0; long pid=strtol(av[2],&end,10);
    if(!end||*end||pid<1||pid>2147483647) return 3;
    errno=0;
    int inspected=proc_pidinfo((pid_t)pid,PROC_PIDTBSDINFO,0,&info,sizeof(info)); int saved=errno;
    if(inspected!=(int)sizeof(info)) {
      /* Only the explicit kernel ESRCH result means this PID is absent.
         Permission errors, short results and inspector failures prove no exit. */
      printf("{\\"status\\":\\"%s\\",\\"pid\\":%ld,\\"errno\\":%d,\\"bytes\\":%d}\\n",inspected==0&&saved==ESRCH?"missing":"inspection-error",pid,saved,inspected);
      return 0;
    }
    printf("{\\"pid\\":%u,\\"pgid\\":%u,\\"seconds\\":%llu,\\"micros\\":%llu}\\n",info.pbi_pid,info.pbi_pgid,(unsigned long long)info.pbi_start_tvsec,(unsigned long long)info.pbi_start_tvusec); return 0;
  }
  if(!token(permit)||kill(owner,0)<0) return 120;
  stage("wrapper-start",0);
  if(setsid()<0 && getpgrp()!=getpid()) return failed("setsid-failed",121);
  stage("process-group-ready",0);
  if(!identity(getpid(),&info)||info.pbi_pgid!=info.pbi_pid) return failed("process-identity-failed",122);
  int fd=open(handshake,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600); if(fd<0) return failed("handshake-open-failed",123);
  char record[320]; int n=snprintf(record,sizeof(record),"{\\"nonce\\":\\"%s\\",\\"pid\\":%u,\\"pgid\\":%u,\\"seconds\\":%llu,\\"micros\\":%llu}\\n",nonce,info.pbi_pid,info.pbi_pgid,(unsigned long long)info.pbi_start_tvsec,(unsigned long long)info.pbi_start_tvusec);
  if(n<0||n>=(int)sizeof(record)||write(fd,record,n)!=n){close(fd);return failed("handshake-write-failed",124);} fsync(fd); close(fd);
  stage("waiting-for-ack",0);
  struct timespec pause={0,20000000}; int accepted=0;
  for(int i=0;i<9000;i++) { if(!token(permit)||kill(owner,0)<0) return failed("permit-or-owner-lost",125); if(token(ack)){accepted=1;break;} nanosleep(&pause,0); }
  if(!accepted||!token(permit)||kill(owner,0)<0) return failed("ack-not-accepted",126);
  stage("ack-accepted",0);
  fd=open(output,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); if(fd<0)return failed("output-open-failed",127);
  /* LaunchServices may leave fd 0/1/2 closed. Keep the output outside that
     range before replacing stdin; otherwise dup2(nullfd,0) can destroy it. */
  if(fd<3) { int above=fcntl(fd,F_DUPFD_CLOEXEC,3); if(above<0){close(fd);return failed("output-fd-duplicate-failed",133);} close(fd);fd=above; }
  stage("output-opened",0);
  struct rlimit size={${MAX_OUTPUT},${MAX_OUTPUT}}; if(setrlimit(RLIMIT_FSIZE,&size)<0){close(fd);return failed("output-limit-failed",128);}
  int nullfd=open("/dev/null",O_RDONLY|O_CLOEXEC); if(nullfd<0)return failed("stdin-open-failed",129);
  if(dup2(nullfd,0)<0)return failed("stdin-redirect-failed",129);
  if(fcntl(0,F_SETFD,0)<0)return failed("stdin-exec-flag-failed",129);
  if(dup2(fd,1)<0)return failed("stdout-redirect-failed",129);
  if(dup2(fd,2)<0)return failed("stderr-redirect-failed",129);
  if(nullfd>2)close(nullfd); close(fd); stage("stdio-ready",0);
  if(chdir(work)<0)return failed("chdir-failed",130);
  stage("working-directory-ready",0);
  if(!token(permit)||kill(owner,0)<0)return failed("pre-exec-permit-or-owner-lost",131);
  char *const args[]={${argv.map(cString).join(',')},NULL};
  char *const environment[]={${Object.entries(config.env).map(([key, value]) => cString(key + '=' + value)).join(',')},NULL};
  stage("sandbox-init",0); char *sandbox_error=NULL;
  if(sandbox_init(sandbox_policy,0,&sandbox_error)!=0){if(sandbox_error)sandbox_free_error(sandbox_error);return boundary_failed("sandbox-init",140);}
  if(sandbox_error)sandbox_free_error(sandbox_error);
  int boundary=boundary_controls();if(boundary)return boundary;
  /* No external sandbox executable: retain the bundle's LS process identity. */
  execve(native_executable,args,environment); return boundary_failed("native-exec",132);
}
`;
}
async function boundedRead(file, maxBytes) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) fail('HOST_GUI_OUTPUT_LIMIT');
    const data = Buffer.alloc(info.size); let at = 0;
    while (at < data.length) { const next = await fd.read(data, at, data.length - at, at); if (!next.bytesRead) break; at += next.bytesRead; }
    return data.subarray(0, at);
  } finally { await fd.close(); }
}
const identityKeys = ['pid', 'pgid', 'seconds', 'micros'];
function acceptedIdentity(value) { return value && identityKeys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) && value.pid > 1 && value.pid === value.pgid && value.pid <= 2147483647; }
const sameIdentity = (left, right) => identityKeys.every(key => left[key] === right[key]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Parse only this fixed inspector protocol. An unavailable/invalid observation
 * is deliberately distinct from an explicitly absent process. No raw program,
 * error text or model-controlled declaration can supply exit evidence. */
export function classifyGuiProcessInspection(stdout, pid) {
  const failed = { status: 'inspection-error' };
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647 || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) return failed;
  let value;
  try { value = JSON.parse(stdout); } catch { return failed; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return failed;
  const keys = Reflect.ownKeys(value);
  if (keys.length === identityKeys.length && identityKeys.every(key => Object.hasOwn(value, key)) && value.pid === pid && acceptedIdentity(value)) {
    return { status: 'observed', identity: Object.fromEntries(identityKeys.map(key => [key, value[key]])) };
  }
  const missingKeys = ['status', 'pid', 'errno', 'bytes'];
  // Darwin ESRCH is 3. Both errno and zero returned bytes are required; zero
  // bytes alone also occurs on access denial and must fail closed.
  if (keys.length === missingKeys.length && missingKeys.every(key => Object.hasOwn(value, key)) && value.status === 'missing' &&
      value.pid === pid && value.errno === 3 && value.bytes === 0) return { status: 'missing', pid };
  return failed;
}

/** Prepare only. A trusted desktop controller must launch appPath through
 * LaunchServices. The same PID applies the pinned sandbox policy, verifies
 * native boundary controls, then directly execs the fixed game program. This is
 * not a command/model-source API, nor an exit-status or same-user proof. */
export async function createGuiHostInvocation(raw) {
  const selected = validateGuiHostInvocation(raw);
  if (process.platform !== 'darwin') fail('GUI_HOST_LAUNCH_UNAVAILABLE');
  const policyRoot = await realpath(selected.policyRoot), cwd = await realpath(selected.cwd), policyFile = await realpath(selected.policyFile);
  if (!inside(policyRoot, policyFile) || inside(cwd, policyRoot) || inside(policyRoot, cwd)) fail('INVALID_GUI_HOST_PATH');
  for (const directory of [policyRoot, cwd]) {
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) fail('INVALID_GUI_HOST_PATH');
  }
  const policy = await lstat(selected.policyFile);
  if (!policy.isFile() || policy.isSymbolicLink() || policy.nlink !== 1 || policy.mode & 0o077 || policy.size > 65536) fail('INVALID_GUI_HOST_PATH');
  const policyBytes = await boundedRead(policyFile, 65536), policyText = new TextDecoder('utf-8', { fatal: true }).decode(policyBytes);
  if (!policyText || policyText.includes('\0')) fail('INVALID_GUI_HOST_POLICY');
  const policySha256 = createHash('sha256').update(policyBytes).digest('hex');
  if (selected.policySha256 && selected.policySha256 !== policySha256) fail('GUI_HOST_POLICY_CHANGED');
  const actualEnv = selected.actualEnv ? await realpath(selected.actualEnv).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }) : undefined;
  aborted(selected.signal);
  const nonce = randomUUID(), appPath = selected.launchAppPath ? await realpath(selected.launchAppPath) : path.join(policyRoot, 'GameBridgeHost-' + nonce + '.app');
  if (selected.launchAppPath) {
    const info = await lstat(selected.launchAppPath);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || inside(cwd, appPath) || inside(appPath, cwd) ||
        !inside(appPath, await realpath(selected.executable))) fail('INVALID_GUI_HOST_PATH');
  }
  const stateRoot = path.join(policyRoot, 'gui-state-' + nonce);
  await mkdir(stateRoot, { mode: 0o700 });
  const permit = path.join(stateRoot, 'permit'), ack = path.join(stateRoot, 'ack'), handshake = path.join(stateRoot, 'handshake.json'), launchStatus = path.join(stateRoot, 'launch-status.jsonl');
  const credentialCanary = path.join(stateRoot, 'credential-canary'), deniedOutside = path.join(stateRoot, 'denied-outside-write'), positive = path.join(cwd, '.gui-boundary-' + nonce);
  await writeFile(credentialCanary, 'SYNTHETIC-GUI-BOUNDARY-CANARY', { flag: 'wx', mode: 0o600 });
  const output = path.join(cwd, '.gui-host-' + nonce + '.output');
  const executable = path.join(appPath, 'Contents/MacOS/GameBridgeHostInvocation'), source = path.join(stateRoot, 'wrapper.c');
  const config = { ...selected, actualEnv, policyFile, policyText, policyRoot, cwd, nonce, permit, ack, handshake, output, launchStatus, credentialCanary, deniedOutside, positive };
  const sourceText = sourceFor(config), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (selected.launchAppPath) {
    const binDirectory = await lstat(path.dirname(executable));
    if (!binDirectory.isDirectory() || binDirectory.isSymbolicLink() || await realpath(path.dirname(executable)) !== path.dirname(executable)) fail('INVALID_GUI_HOST_PATH');
    const exists = await lstat(executable).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) fail('GUI_HOST_WRAPPER_ALREADY_EXISTS');
  } else await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  await writeFile(source, sourceText, { flag: 'wx', mode: 0o600 });
  const identifier = selected.bundleIdentifier ?? ('dev.gamebridge.hostinvocation.' + nonce.replaceAll('-', ''));
  let plist, entryScript;
  if (selected.launchAppPath) {
    plist = (await boundedRead(path.join(appPath, 'Contents/Info.plist'), 65536)).toString('utf8');
    for (const [key, value] of [['CFBundleIdentifier', identifier]]) {
      const matches = [...plist.matchAll(new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>', 'g'))];
      if (matches.length !== 1 || matches[0][1] !== value) fail('GUI_HOST_BUNDLE_METADATA_MISMATCH');
    }
    const entries = [...plist.matchAll(/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/g)];
    if (entries.length !== 1 || !['GameBridgeHostInvocation', 'GameBridgeHostEntry'].includes(entries[0][1])) fail('GUI_HOST_BUNDLE_METADATA_MISMATCH');
    if (entries[0][1] === 'GameBridgeHostEntry') entryScript = makeGuiHostEntryScript(executable);
  } else {
    plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>GameBridgeHostInvocation</string><key>CFBundleName</key><string>GameBridge Host Invocation</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>\n`;
    await writeFile(path.join(appPath, 'Contents/Info.plist'), plist, { flag: 'wx', mode: 0o600 });
  }
  const compiledExecutable = path.join(stateRoot, 'compiled-launcher');
  const compile = await runBuildProcess('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', source, '-lsandbox', '-o', compiledExecutable], { cwd: stateRoot, signal: selected.signal, timeoutMs: 30000, maxOutputBytes: 16384 });
  await writeFile(path.join(stateRoot, 'compiler-output.txt'), compile.output, { flag: 'wx', mode: 0o600 });
  aborted(selected.signal);
  const diagnosticInputs = [
    { path: 'launcher.c', content: Buffer.from(sourceText), mediaType: 'text/plain' },
    { path: 'launcher-build.txt', content: Buffer.from(compile.output), mediaType: 'text/plain' },
    { path: 'launcher-info.plist', content: Buffer.from(plist), mediaType: 'text/plain' },
    { path: 'launcher-policy.sb', content: Buffer.from(policyBytes), mediaType: 'text/plain' },
  ];
  if (compile.exitCode !== 0) throw Object.assign(new Error('The trusted GUI launcher did not compile.'), { code: 'GUI_HOST_WRAPPER_COMPILE_FAILED', guiDiagnosticFiles: diagnosticInputs });
  await copyFile(compiledExecutable, executable, constants.COPYFILE_EXCL);
  await chmod(executable, 0o700);
  const entryScriptPath = path.join(appPath, 'Contents/MacOS/GameBridgeHostEntry');
  if (entryScript) await writeFile(entryScriptPath, entryScript, { flag: 'wx', mode: 0o700 });
  const executableSha256 = hash(await boundedRead(executable, 1024 * 1024));
  await selected.verifyBinding?.(); aborted(selected.signal);
  await writeFile(permit, nonce, { flag: 'wx', mode: 0o600 });
  const started = Date.now(), result = { exitCode: null, output: '', cancelled: false, timedOut: false, overflow: false, spawnError: false,
    termSignal: null, exitObserved: false, launchObserved: false, bindingFailed: false, termReason: null, nativeBoundary: { status: 'not_observed' } };
  let stopped = false, settled = false, lease, handshakeSha256, cancelPromise, outputPresent = false;
  async function removeTokens() { await Promise.allSettled([unlink(permit), unlink(ack)]); }
  function killGroup() { if (lease) { try { process.kill(-lease.pid, 'SIGKILL'); } catch { /* Process group is already gone. */ } } }
  async function cancel() {
    if (settled) return cancelPromise;
    stopped = true; result.cancelled = true; result.termReason = 'cancelled'; killGroup();
    cancelPromise = removeTokens(); return cancelPromise;
  }
  const onAbort = () => { void cancel(); };
  selected.signal?.addEventListener('abort', onAbort, { once: true }); if (selected.signal?.aborted) void cancel();
  async function query(pid) {
    try {
      const inspected = await execFileAsync(executable, ['--inspect-pid', String(pid)], { cwd: stateRoot, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 2000, maxBuffer: 4096 });
      if (inspected.stderr) return { status: 'inspection-error' };
      return classifyGuiProcessInspection(inspected.stdout, pid);
    } catch { return { status: 'inspection-error' }; }
  }
  const completion = (async () => {
    try {
      while (!stopped) {
        if (Date.now() - started > selected.timeoutMs) { stopped = true; result.timedOut = true; result.termReason = lease ? 'timeout-after-launch' : 'timeout-before-launch'; killGroup(); await removeTokens(); break; }
        if (!lease) {
          let record, handshakeBytes;
          try { handshakeBytes = await boundedRead(handshake, 2048); record = JSON.parse(handshakeBytes.toString('utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { stopped = true; result.termReason = 'invalid-handshake'; await removeTokens(); break; } }
          if (record) {
            if (record.nonce !== nonce || !acceptedIdentity(record)) { stopped = true; result.termReason = 'invalid-handshake'; await removeTokens(); break; }
            const observed = await query(record.pid);
            if (observed.status === 'inspection-error') { stopped = true; result.bindingFailed = true; result.termReason = 'handshake-inspection-failed'; await removeTokens(); break; }
            if (observed.status !== 'observed' || !sameIdentity(record, observed.identity)) { stopped = true; result.termReason = 'handshake-identity-mismatch'; await removeTokens(); break; }
            lease = { ...observed.identity }; handshakeSha256 = hash(handshakeBytes); result.launchObserved = true;
            if (stopped || selected.signal?.aborted) { killGroup(); break; }
            await selected.verifyBinding?.();
            if (stopped || selected.signal?.aborted) { killGroup(); break; }
            await writeFile(ack, nonce, { flag: 'wx', mode: 0o600 });
            if (stopped || selected.signal?.aborted) { killGroup(); await removeTokens(); break; }
          }
        }
        try {
          const bytes = await boundedRead(output, MAX_OUTPUT); outputPresent = true; result.output = bytes.toString('utf8');
          if (bytes.length >= MAX_OUTPUT) { stopped = true; result.overflow = true; result.termReason = 'output-limit'; killGroup(); await removeTokens(); break; }
        } catch (error) { if (error.code !== 'ENOENT') { stopped = true; result.overflow = true; result.termReason = 'invalid-output'; killGroup(); await removeTokens(); break; } }
        if (lease) {
          const current = await query(lease.pid);
          if (current.status === 'inspection-error') {
            // Losing the inspector is a failed observation, never a successful
            // exit. Retire the still-bound process group and revoke late starts.
            stopped = true; result.bindingFailed = true; result.termReason = 'process-inspection-failed';
            killGroup(); await removeTokens(); break;
          }
          if (current.status === 'missing' || !sameIdentity(current.identity, lease)) {
            result.exitObserved = true; result.termReason = outputPresent ? 'process-exit-status-unavailable' : 'wrapper-exit-before-output'; stopped = true; await removeTokens();
            await selected.verifyBinding?.(); break;
          }
        }
        await sleep(80);
      }
    } catch (error) {
      stopped = true; result.bindingFailed = true; result.termReason = 'binding-or-admission-failed';
      result.bindingErrorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'HOST_GUI_BINDING_FAILED';
      killGroup(); await removeTokens();
    } finally {
      await cancelPromise; await removeTokens();
      // Capture final bytes only for an uncancelled run; cancelled work never
      // consumes a late result as new evidence.
      if (!result.cancelled) try { const bytes = await boundedRead(output, MAX_OUTPUT); if (!result.cancelled) { result.output = bytes.toString('utf8'); if (bytes.length >= MAX_OUTPUT) result.overflow = true; } } catch { /* Output may never have opened. */ }
      if (!result.cancelled) {
        const lines = result.output.split('\n').filter(line => line.startsWith('[GUI_BOUNDARY] '));
        if (lines.length === 1) try {
          const boundary = JSON.parse(lines[0].slice('[GUI_BOUNDARY] '.length));
          const fields = ['status', 'positiveReadWrite', 'applicationRead', 'credentialRead', 'policyRead', 'outsideWrite', 'actualEnvOpen', 'localNetwork', 'externalNetwork'];
          if (boundary.status === 'passed' && Reflect.ownKeys(boundary).length === fields.length && fields.every(key => Object.hasOwn(boundary, key)) &&
              boundary.positiveReadWrite === true && boundary.applicationRead === true &&
              ['credentialRead', 'policyRead', 'outsideWrite', 'localNetwork', 'externalNetwork'].every(key => boundary[key] === 'denied') &&
              boundary.actualEnvOpen === (actualEnv ? 'denied' : 'not_configured')) result.nativeBoundary = boundary;
          else if (boundary.status === 'failed' && Reflect.ownKeys(boundary).length === 2 && typeof boundary.step === 'string' && /^[a-z-]{1,64}$/.test(boundary.step)) result.nativeBoundary = { status: 'failed', step: boundary.step };
        } catch { /* Invalid/duplicate native evidence never becomes passed. */ }
      }
      settled = true; selected.signal?.removeEventListener('abort', onAbort);
    }
    return result;
  })();
  async function captureDiagnostics() {
    const fixed = [
      { path: 'launcher.c', file: source, max: 1024 * 1024, expected: hash(sourceText), mediaType: 'text/plain' },
      { path: 'launcher-build.txt', file: path.join(stateRoot, 'compiler-output.txt'), max: 16384, expected: hash(compile.output), mediaType: 'text/plain' },
      { path: 'launcher-info.plist', file: path.join(appPath, 'Contents/Info.plist'), max: 65536, expected: hash(plist), mediaType: 'text/plain' },
      { path: 'launcher', file: executable, max: 1024 * 1024, expected: executableSha256, mediaType: 'application/octet-stream' },
      { path: 'launcher-policy.sb', file: policyFile, max: 65536, expected: policySha256, mediaType: 'text/plain' },
    ];
    if (handshakeSha256) fixed.push({ path: 'launcher-handshake.json', file: handshake, max: 2048, expected: handshakeSha256, mediaType: 'application/json' });
    if (entryScript) fixed.push({ path: 'launcher-entry.sh', file: entryScriptPath, max: 32768, expected: hash(entryScript), mediaType: 'text/plain' });
    const files = [];
    for (const item of fixed) {
      const content = await boundedRead(item.file, item.max);
      if (hash(content) !== item.expected) fail('GUI_HOST_DIAGNOSTIC_CHANGED');
      files.push({ path: item.path, content, mediaType: item.mediaType });
    }
    try {
      const content = await boundedRead(launchStatus, 8192);
      const records = content.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (records.length > 32 || records.some(item => !item || typeof item !== 'object' || Reflect.ownKeys(item).some(key => !['stage', 'errno', 'pid'].includes(key)) ||
          !/^[a-z-]{1,64}$/.test(item.stage) || !Number.isSafeInteger(item.errno) || !Number.isSafeInteger(item.pid) || (lease && item.pid !== lease.pid))) fail('GUI_HOST_DIAGNOSTIC_CHANGED');
      files.push({ path: 'launcher-status.jsonl', content, mediaType: 'application/x-ndjson' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return files;
  }
  return { appPath, completion, wait: () => completion, cancel, captureDiagnostics,
    close: async () => { if (!settled) await cancel(); await completion; },
    provenance: { scope: 'trusted-local-gui-sandbox-invocation', bundleIdentifier: identifier, wrapperSha256: executableSha256,
      sourceSha256: hash(sourceText), infoPlistSha256: hash(plist), samePidExec: true, sameBundleExec: Boolean(selected.launchAppPath), exitStatusAvailable: false,
      entryKind: entryScript ? 'fixed-posix-shell' : 'native', ...(entryScript ? { entryScriptSha256: hash(entryScript) } : {}),
      sandboxMode: 'in-process-sandbox-init', policySha256, nativeBoundaryControlsRequired: true, actualEnvBoundaryConfigured: Boolean(actualEnv),
      arbitraryModelSourceAllowed: false, realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false } };
}
