import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/surface.ts'
s = p.read_text()
old = "{ triggerTurn: true, deliverAs: 'steer' },"
new = "{ triggerTurn: true }, // MUTATION: no deliverAs"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
