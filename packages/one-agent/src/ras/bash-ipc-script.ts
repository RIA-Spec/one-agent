/**
 * Script generators for Bash RAS IPC client commands.
 *
 * Keeping the generated CJS templates in one place makes Bash RAS
 * runtime logic easier to maintain and review.
 */

function getReasonScriptBody() {
  return `
  let prompts = [], positionals = [], structure = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prompt') {
      const value = args[++i];
      if (value == null) { console.error('--prompt requires a value'); process.exit(1); }
      prompts.push(value === '-' ? stdin : value);
    }
    else if (arg.startsWith('--prompt=')) { prompts.push(arg.slice('--prompt='.length) === '-' ? stdin : arg.slice('--prompt='.length)); }
    else if (arg === '--structure') {
      const value = args[++i];
      if (value == null) { console.error('--structure requires a value'); process.exit(1); }
      structure = value;
    }
    else if (arg.startsWith('--structure=')) { structure = arg.slice('--structure='.length); }
    else if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); }
    else { console.error('Unknown argument: ' + arg); process.exit(1); }
  }
  if (positionals.length > 2) { console.error('Too many positional arguments'); process.exit(1); }
  const promptArg = positionals[0] || '';
  const structureRaw = structure || positionals[1] || '';
  if (promptArg) prompts.push(promptArg === '-' ? stdin : promptArg);
  if (!structureRaw) { console.error('--structure is required'); process.exit(1); }
  if (prompts.length === 0) { console.error('prompt is required'); process.exit(1); }
  const body = { prompt: prompts.join('\\n'), example: JSON.parse(structureRaw) };
  `;
}

function getActScriptBody() {
  return `
  let toolName = '', argsText = '', needsJsonStdin = false, showManual = false, showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name') { toolName = args[++i] || ''; }
    else if (arg === '--args') {
      const v = args[++i];
      if (v === '-') needsJsonStdin = true;
      else argsText = v || '';
    }
    else if (arg === '--manual') {
      showManual = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { toolName = next; i++; }
    }
    else if (arg === '--help' || arg === '-h') { showHelp = true; }
    else if (!arg.startsWith('-')) {
      if (!toolName && !showManual) toolName = arg;
      else if (!argsText && !needsJsonStdin && !showManual) {
        if (arg === '-') needsJsonStdin = true;
        else argsText = arg;
      }
      else {
        console.error('Unknown argument: ' + arg); process.exit(1);
      }
    }
    else {
      console.error('Unknown argument: ' + arg); process.exit(1);
    }
  }
  let body;
  if (showHelp) body = { toolName: '__help__', toolArgs: {} };
  else if (showManual) body = { toolName: '__manual__', toolArgs: toolName ? { name: toolName } : {} };
  else {
    if (!toolName || (!argsText && !needsJsonStdin)) { console.error('tool name and JSON args required'); process.exit(1); }
    const raw = needsJsonStdin ? stdin : argsText;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { console.error('Invalid JSON args: ' + error.message); process.exit(1); }
    body = { toolName, toolArgs: parsed };
  }
  `;
}

function getAgentScriptBody() {
  return `
  let prompts = [], positionals = [], configRaw = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prompt') {
      const value = args[++i];
      if (value == null) { console.error('--prompt requires a value'); process.exit(1); }
      prompts.push(value === '-' ? stdin : value);
    }
    else if (arg.startsWith('--prompt=')) { prompts.push(arg.slice('--prompt='.length) === '-' ? stdin : arg.slice('--prompt='.length)); }
    else if (arg === '--config') {
      const value = args[++i];
      if (value == null) { console.error('--config requires a value'); process.exit(1); }
      configRaw = value;
    }
    else if (arg.startsWith('--config=')) { configRaw = arg.slice('--config='.length); }
    else if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); }
    else { console.error('Unknown argument: ' + arg); process.exit(1); }
  }
  if (positionals.length > 2) { console.error('Too many positional arguments'); process.exit(1); }
  const promptArg = positionals[0] || '';
  if (promptArg) prompts.push(promptArg === '-' ? stdin : promptArg);
  if (positionals[1] && !configRaw) configRaw = positionals[1];
  if (prompts.length === 0) { console.error('prompt is required'); process.exit(1); }
  let parsedConfig = {};
  if (configRaw) {
    try { parsedConfig = JSON.parse(configRaw); }
    catch (error) { console.error('Invalid config JSON: ' + error.message); process.exit(1); }
  }
  const body = { prompt: prompts.join('\\n'), config: parsedConfig };
  `;
}

function buildScript(dataDir: string, type: "reason" | "act" | "agent") {
  const mode = type;
  const isReason = mode === "reason";
  const isAct = mode === "act";
  const needsStdinExpr = isReason
    ? `(() => {
  let positionalIndex = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prompt') {
      if (args[i + 1] === '-') return true;
      i++;
      continue;
    }
    if (arg.startsWith('--prompt=')) {
      if (arg.slice('--prompt='.length) === '-') return true;
      continue;
    }
    if (arg === '--structure') {
      i++;
      continue;
    }
    if (arg.startsWith('--structure=')) continue;
    if (!arg.startsWith('-') || arg === '-') {
      if (positionalIndex === 0 && arg === '-') return true;
      positionalIndex++;
    }
  }
  return false;
})()`
    : isAct
      ? `(() => {
  let toolName = '', needsJsonStdin = false, showManual = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--args' && args[i + 1] === '-') { needsJsonStdin = true; i++; }
    else if (arg === '--manual') {
      showManual = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { toolName = next; i++; }
    }
    else if (arg === '--name') { toolName = args[++i] || ''; }
    else if (!arg.startsWith('-')) {
      if (!toolName && !showManual) toolName = arg;
      else if (arg === '-' && !showManual) needsJsonStdin = true;
    }
  }
  return needsJsonStdin;
})()`
      : `(() => {
  let positionalIndex = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prompt') {
      if (args[i + 1] === '-') return true;
      i++;
      continue;
    }
    if (arg.startsWith('--prompt=')) {
      if (arg.slice('--prompt='.length) === '-') return true;
      continue;
    }
    if (arg === '--config') {
      i++;
      continue;
    }
    if (arg.startsWith('--config=')) continue;
    if (!arg.startsWith('-') || arg === '-') {
      if (positionalIndex === 0 && arg === '-') return true;
      positionalIndex++;
    }
  }
  return false;
})()`;

  const parseBody = isReason ? getReasonScriptBody() : isAct ? getActScriptBody() : getAgentScriptBody();
  const responseOutput = isReason
    ? "    process.stdout.write(raw);"
    : `    const payload = JSON.parse(raw);
    if (payload.text) process.stdout.write(payload.text);
    if (payload.isError) {
      try { fs.unlinkSync(req); } catch {}
      try { fs.unlinkSync(resp); } catch {}
      process.exit(1);
    }`;

  return `const fs = require('fs');
const { randomBytes } = require('crypto');
const args = process.argv.slice(2);
const needsStdin = ${needsStdinExpr};

function run(stdin) {
${parseBody}
  const id = randomBytes(8).toString('hex');
  const req = '${dataDir}/one-${type}-req-' + id + '.txt';
  const resp = '${dataDir}/one-${type}-resp-' + id + '.txt';
  fs.writeFileSync(req, JSON.stringify(body));
  for (let i = 0; i < 1200 && !fs.existsSync(resp); i++) { const e = Date.now() + 50; while (Date.now() < e); }
  if (fs.existsSync(resp)) {
    const raw = fs.readFileSync(resp, 'utf-8');
${responseOutput}
    try { fs.unlinkSync(req); } catch {} try { fs.unlinkSync(resp); } catch {}
  } else {
    console.error('Timeout'); try { fs.unlinkSync(req); } catch {} process.exit(1);
  }
}

if (needsStdin) {
  const c = []; process.stdin.on('data', d => c.push(d));
  process.stdin.on('end', () => run(Buffer.concat(c).toString()));
} else { run(''); }
`;
}

export function makeScript(dataDir: string, type: "reason" | "act" | "agent") {
  return buildScript(dataDir, type);
}
