// Print the id of the tree node with a given name (or nothing).
//   node tree-find.mjs <name>     reads `GET /v1/tree` JSON on stdin
let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log('');
    return;
  }
  const nodes = parsed?.nodes ?? [];
  const node = nodes.find((item) => item.name === process.argv[2]);
  console.log(node ? node.id : '');
});
