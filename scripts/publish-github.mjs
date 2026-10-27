import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
function run(command, args, { quiet = false } = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (r.error) throw new Error(`${command} unavailable. Install GitHub CLI from https://cli.github.com/ then run gh auth login.`);
  if (r.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed. Check authentication and repository state.`);
  return (r.stdout || '').trim();
}
try {
  // Explicit invocation publishes only already-reviewed, committed source.
  run('gh', ['auth', 'status']);
  const owner = run('gh', ['api', 'user', '--jq', '.login'], { quiet: true });
  const repo = `${owner}/gamebridge`;
  if (run('git', ['status', '--porcelain'], { quiet: true })) throw new Error('Commit or stash local changes before publication.');
  const branch = run('git', ['branch', '--show-current'], { quiet: true });
  if (branch !== 'main') throw new Error('Publish from main after review.');
  run('git', ['rev-parse', '--verify', 'HEAD'], { quiet: true });
  const remotes = run('git', ['remote'], { quiet: true }).split('\n');
  if (remotes.includes('origin')) {
    const origin = run('git', ['remote', 'get-url', 'origin'], { quiet: true });
    if (![ `https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git` ].includes(origin)) throw new Error('origin points to another repository; it was not changed.');
  } else {
    const existing = spawnSync('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'], { encoding: 'utf8' });
    if (existing.status === 0) throw new Error(`${repo} already exists. Inspect it and set origin explicitly before running again.`);
    // GitHub checks name availability; creation errors never fall through to a push.
    run('gh', ['repo', 'create', repo, '--public', '--description', 'Offline voxel scene converter for Minecraft, Roblox Studio and Godot', '--source', '.', '--remote', 'origin']);
  }
  const visibility = run('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'], { quiet: true });
  if (visibility !== 'PUBLIC') throw new Error('Target repository is not public; visibility was not changed.');
  const allowed = [`https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git`];
  const pushUrls = run('git', ['remote', 'get-url', '--push', '--all', 'origin'], { quiet: true }).split('\n');
  if (pushUrls.length !== 1 || !allowed.includes(pushUrls[0])) throw new Error('origin push URL differs from the verified GitHub repository. No push was performed.');
  run('git', ['push', '-u', 'origin', 'main']);
  const localHead = run('git', ['rev-parse', 'HEAD'], { quiet: true });
  const remoteHead = run('git', ['ls-remote', 'origin', 'refs/heads/main'], { quiet: true }).split(/\s/)[0];
  if (localHead !== remoteHead) throw new Error('Remote main does not match local HEAD; inspect the remote before claiming synchronization.');
  console.log(`Published https://github.com/${repo}\nEnable Settings → Pages → Source: GitHub Actions, then add Actions repository variable PAGES_ENABLED=true and run the workflow. Future pushes to main run tests and update the site.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
