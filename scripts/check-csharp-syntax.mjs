// Real Roslyn syntax checking only. This does not compile or execute a Mod,
// resolve SMAPI/game APIs, read .env, or contact a model provider.
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { inspectBuildEnvironment, runCompilerProcess } from '../src/build/runner.mjs';

const MAX_SOURCE_BYTES = 64 * 1024;
const PARSER_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <AssemblyName>GameBridge.SyntaxProbe</AssemblyName>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <UseSharedCompilation>false</UseSharedCompilation>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath><Private>true</Private></Reference>
    <Reference Include="Microsoft.CodeAnalysis.CSharp"><HintPath>$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll</HintPath><Private>true</Private></Reference>
  </ItemGroup>
</Project>
`;
const PARSER_SOURCE = `using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

if (args.Length != 1 || new FileInfo(args[0]).Length > 65536)
    return 2;

// The input is plain text. No assembly, source generator, user project or Mod is run.
string source = File.ReadAllText(args[0]);
var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest), path: "ModEntry.cs");
var all = tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error || d.Severity == DiagnosticSeverity.Warning).ToArray();
var diagnostics = all.Take(50).Select(d => {
    var position = d.Location.GetLineSpan().StartLinePosition;
    string message = d.GetMessage(CultureInfo.InvariantCulture);
    return new { code = d.Id, severity = d.Severity.ToString().ToLowerInvariant(), message = message.Length > 2000 ? message.Substring(0, 2000) : message,
        file = "ModEntry.cs", line = position.Line + 1, column = position.Character + 1 };
}).ToArray();
bool passed = !all.Any(d => d.Severity == DiagnosticSeverity.Error);
Console.WriteLine(JsonSerializer.Serialize(new {
    scope = "syntax-only", syntaxPassed = passed, diagnostics, diagnosticsTruncated = all.Length > 50,
    build = "not_run", game = "not_run",
    limitation = "Roslyn syntax parsing only; no type binding, SMAPI/game API resolution, Mod compilation or game execution."
}));
return passed ? 0 : 1;
`;
function failure(code, message) {
  const error = new Error(message); error.code = code; return error;
}

/** Compile the trusted parser, then parse source as data. No model credentials are used. */
export async function checkCSharpSyntax(source, { dotnetPath, signal } = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES || source.includes('\0')) throw failure('INVALID_SOURCE', 'C# input must be UTF-8 text no larger than 64 KiB.');
  const environment = await inspectBuildEnvironment({ dotnetPath, gamePath: '', signal });
  if (!environment.dotnet.available || Number(environment.dotnet.version.split('.')[0]) < 10) throw failure('SDK_REQUIRED', 'Syntax verification needs a real .NET SDK 10 or later.');
  if (signal?.aborted) throw failure('CANCELLED', 'Syntax verification was cancelled.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-syntax-'));
  try {
    await writeFile(path.join(dir, 'GameBridge.SyntaxProbe.csproj'), PARSER_PROJECT);
    await writeFile(path.join(dir, 'Program.cs'), PARSER_SOURCE);
    // This filename is deliberately not .cs, so the Mod text is not a compile item.
    await writeFile(path.join(dir, 'source-input.txt'), source);
    await writeFile(path.join(dir, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
    const args = ['build', 'GameBridge.SyntaxProbe.csproj', '--configuration', 'Release', '--nologo', '--verbosity', 'quiet', '--disable-build-servers', '--configfile', path.join(dir, 'NuGet.Config'),
      '-p:NuGetAudit=false', '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:UseSharedCompilation=false'];
    const build = await runCompilerProcess(environment.dotnet.path, args, { cwd: dir, signal, timeoutMs: 60000 });
    if (build.cancelled) throw failure('CANCELLED', 'Syntax verification was cancelled.');
    if (build.exitCode !== 0 || build.timedOut || build.overflow) throw failure('PARSER_BUILD_FAILED', 'The trusted Roslyn syntax parser could not be compiled.');
    const helper = path.join(dir, 'bin', 'Release', 'net10.0', 'GameBridge.SyntaxProbe.dll');
    const parsed = await runCompilerProcess(environment.dotnet.path, [helper, path.join(dir, 'source-input.txt')], { cwd: dir, signal, timeoutMs: 15000 });
    if (parsed.cancelled) throw failure('CANCELLED', 'Syntax verification was cancelled.');
    if (![0, 1].includes(parsed.exitCode) || parsed.timedOut || parsed.overflow) throw failure('PARSER_FAILED', 'The trusted syntax parser did not complete.');
    let report;
    try { report = JSON.parse(parsed.output); } catch { throw failure('PARSER_RESPONSE_INVALID', 'The syntax parser returned invalid JSON.'); }
    if (report.scope !== 'syntax-only' || typeof report.syntaxPassed !== 'boolean' || !Array.isArray(report.diagnostics) || report.build !== 'not_run' || report.game !== 'not_run') throw failure('PARSER_RESPONSE_INVALID', 'The syntax parser returned an invalid status.');
    return { ...report, sdkVersion: environment.dotnet.version, provenance: 'local-sdk-roslyn' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || path.extname(process.argv[2]).toLowerCase() !== '.cs') throw failure('USAGE', 'Usage: node scripts/check-csharp-syntax.mjs /absolute/path/ModEntry.cs');
    const file = path.resolve(process.argv[2]);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) throw failure('INVALID_SOURCE', 'Input must be a regular .cs file no larger than 64 KiB.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
    const report = await checkCSharpSyntax(source);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.syntaxPassed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ scope: 'syntax-only', syntaxPassed: false, toolError: { code: error.code || 'SYNTAX_CHECK_FAILED', message: error.code ? error.message : 'Could not read or verify the C# source.' }, build: 'not_run', game: 'not_run' }, null, 2));
    process.exitCode = 2;
  }
}
