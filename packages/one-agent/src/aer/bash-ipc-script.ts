/**
 * Script generators for Bash AER IPC client commands.
 *
 * Keeping the generated CJS templates in one place makes Bash AER
 * runtime logic easier to maintain and review.
 */

function getReasonScriptBody() {
  return `
  let prompts = [], structure = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt') { prompts.push(args[++i] === '-' ? stdin : args[i]); }
    else if (args[i] === '--structure') { structure = args[++i]; }
  }
  const body = { prompt: prompts.join('\\n'), example: structure ? JSON.parse(structure) : '' };
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

function buildScript(dataDir: string, type: "reason" | "act") {
  const isReason = type === "reason";
  const needsStdinExpr = isReason
    ? "args.some((a, i) => a === '--prompt' && args[i + 1] === '-')"
    : `(() => {
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
})()`;

  const parseBody = isReason ? getReasonScriptBody() : getActScriptBody();
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

export function makeScript(dataDir: string, type: "reason" | "act") {
  return buildScript(dataDir, type);
}
