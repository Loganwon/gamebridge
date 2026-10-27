import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, parseSceneFile, createDemoScene, transformScene, convertScene } from '../src/core.js';

const usage = `GameBridge 0.1\n\nnode scripts/convert.mjs [input.schem|input.vox|input.json|--demo] --target minecraft|roblox|godot|json --out FILE\n  --rotation 0|90|180|270  --mirror-x  --scale 1|2|3|4\n  --datapack DIRECTORY   Create a Minecraft Java 1.21 datapack instead of --out\n\nFiles are never overwritten. Use a new output path for each conversion.\n`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) { console.log(usage); process.exit(0); }
  const options = { rotation: 0, mirrorX: false, scale: 1 };
  let input, target = 'minecraft', out, datapack, demo = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`); return args[++i]; };
    if (arg === '--demo') demo = true;
    else if (arg === '--mirror-x') options.mirrorX = true;
    else if (arg === '--rotation') options.rotation = Number(value());
    else if (arg === '--scale') options.scale = Number(value());
    else if (arg === '--target') target = value();
    else if (arg === '--out') out = value();
    else if (arg === '--datapack') datapack = value();
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!input) input = arg;
    else throw new Error('Only one input file is allowed.');
  }
  if (Boolean(input) === demo) throw new Error('Choose one input file OR --demo.');
  if (Boolean(out) === Boolean(datapack)) throw new Error('Choose --out FILE OR --datapack DIRECTORY.');
  if (datapack && target !== 'minecraft') throw new Error('--datapack requires --target minecraft.');
  if (input && (await stat(input)).size > LIMITS.fileBytes) throw new Error('Input exceeds 8 MiB.');
  const source = demo ? createDemoScene() : await parseSceneFile(path.basename(input), new Uint8Array(await readFile(input)));
  const scene = transformScene(source, options);
  const result = convertScene(scene, target);
  if (datapack) {
    // Exclusive directory creation prevents accidentally replacing an existing pack.
    await mkdir(datapack);
    const functions = path.join(datapack, 'data/gamebridge/function');
    await mkdir(functions, { recursive: true });
    await writeFile(path.join(datapack, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 48, description: 'GameBridge building · Minecraft Java 1.21' } }, null, 2) + '\n', { flag: 'wx' });
    await writeFile(path.join(functions, 'build.mcfunction'), result.text, { flag: 'wx' });
    console.log(`Created ${datapack}\nIn Java 1.21: /reload then /function gamebridge:build\nRun in a new test world; setblock replaces blocks within the building footprint.`);
  } else {
    await writeFile(out, result.text, { flag: 'wx' });
    console.log(`Created ${out}`);
  }
  console.log(JSON.stringify(result.report, null, 2));
} catch (error) { console.error(`GameBridge: ${error.message}`); process.exitCode = 1; }
