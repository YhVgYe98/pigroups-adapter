import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = "  if (parent !== null && typeof node.parent_id === 'string' && node.parent_id === parent) return 'sibling';"
new = "  // MUTATION: siblings are reported as peers"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
