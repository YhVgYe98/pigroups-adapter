import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = "    const needle = (query ?? '').trim().toLowerCase();"
new = "    const needle = (query ?? '').trim(); // MUTATION: case-sensitive"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
