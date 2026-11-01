// Read JSON on stdin and print the value at a dotted path.
// Arrays and objects are printed as compact JSON, missing values as an empty line,
// so shell code can test with `[[ -n "$(…) " ]]`.
let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    console.log('');
    return;
  }
  for (const part of process.argv[2].split('.')) {
    if (value == null) break;
    value = value[part];
  }
  if (value === undefined || value === null) console.log('');
  else if (typeof value === 'object') console.log(JSON.stringify(value));
  else console.log(String(value));
});
