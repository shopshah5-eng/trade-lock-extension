const fs = require('fs');
const path = require('path');

function checkFile(relPath) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (!fs.existsSync(fullPath)) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  const idRegex = /\bid=["']([^"']+)["']/g;
  let match;
  const counts = {};
  const positions = {};
  let lineNum = 1;
  let lastIndex = 0;

  // Track lines
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    let m;
    const re = /\bid=["']([^"']+)["']/g;
    while ((m = re.exec(line)) !== null) {
      const id = m[1];
      counts[id] = (counts[id] || 0) + 1;
      if (!positions[id]) positions[id] = [];
      positions[id].push(idx + 1);
    }
  });

  const dupes = Object.entries(counts).filter(([id, count]) => count > 1);
  console.log(`=== ${relPath} (Found ${dupes.length} duplicate IDs) ===`);
  dupes.forEach(([id, count]) => {
    console.log(`  - #${id}: ${count} occurrences at lines ${positions[id].join(', ')}`);
  });
}

checkFile('options/options.html');
checkFile('popup/popup.html');
checkFile('content/lock.html');
